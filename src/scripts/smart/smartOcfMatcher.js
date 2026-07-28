// smartOcfMatcher.js — PostFlowX OCF Conform Engine
//
// Implements DaVinci Resolve-style conform & relink logic.
//
//   Priority cascade (highest → lowest confidence):
//   0. UMID / File hash (perfect — if metadata available)
//   0b.Camera name exact (roll+clip) + TC-In exact           → 98 → SAFE
//   1. Reel name exact + TC-In exact (±1 frame)              → 95 → SAFE
//   2. Filename exact (normalised) + TC-In exact             → 90 → SAFE
//   3. Reel exact + TC range overlap                         → 85 → SAFE
//   4. Camera roll prefix + TC-In exact                      → 82 → SAFE
//   5. ALE tape name exact + TC-In (±2 frames)               → 78 → SAFE
//   5b.Subfolder name matches reel/roll                       → +12 bonus
//   6. Normalised name + TC-In (±2 frames)                   → 65 → REVIEW
//   7. TC range overlap + duration match                     → 55 → REVIEW
//   8. Token similarity + TC proximity                       → 45 → NOT_RECOMMENDED
//   9. TC only (no reel)                                     → 30 → NOT_RECOMMENDED
//
//   Smart additions:
//   · Structured camera name parse (camera/roll/clip/date/suffix)
//   · Lab suffix stripping (_h1, _LF, _raw, _graded, _proxy …)
//   · Handle-tolerant TC: event srcIn±handles falls in OCF roll range
//   · ALE tape name + scene/take lookup via opts.aleMap
//   · Subfolder/path contribution: /OCF/A001/file.mxf → parent 'A001' boosts
//   · Token-intersection string similarity (replaces prefix-only)
//   · TC-range-aware deduplication (same OCF + overlapping TC = conflict;
//     same OCF + different TC = normal multi-take, NOT a duplicate)
//
//   Sources:
//   - DaVinci Resolve 18 Conforming & Managing Projects (Blackmagic Design manual ch.7)
//   - SMPTE RP 7 (timecode) + RP 214 (MXF UMID)
//   - ARRI camera naming convention (A###C###_YYMMDD_XXXX)
//   - RED camera naming convention (A###_####_C###.R3D)

import { readSpeedPercent } from '../modules/pullRange.js';

export const MATCH_STATUS = {
  SAFE:             'SAFE',
  REVIEW_NEEDED:    'REVIEW_NEEDED',
  NOT_RECOMMENDED:  'NOT_RECOMMENDED',
  MISSING:          'MISSING',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Lab/editorial derivative suffixes stripped before comparing
const _LAB_SUFFIXES =
  /[_\-](proxy|ref|graded|editorial|offline|dnx|prores|hevc|h264|avc|h265|mp4|braw|r3d|mxf|ari|raw|dng|dpx|tiff?|v\d{1,3}|qt|dnxhd|dnxhr|h1|h2|lf|4k|2k|hdr|sdr|flat|log)$/i;

// Remove extension, lab suffixes, normalise separators, lowercase
function _normName(s) {
  if (!s) return '';
  let v = String(s).replace(/\.[^.]+$/, '');
  // Strip repeated lab suffixes (e.g. _h1_proxy → strip _proxy then _h1)
  for (let i = 0; i < 4; i++) {
    const n = v.replace(_LAB_SUFFIXES, '');
    if (n === v) break;
    v = n;
  }
  return v.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

// ── Structured camera name parser ─────────────────────────────────────────────
// Parses camera naming conventions into components for precise matching.
//
//  ARRI:  A001C002_250617_H1C001  → {camera:'A', roll:'001', clip:'C002', date:'250617'}
//  ARRI LF: A001L002_25030194    → {camera:'A', roll:'001', clip:'L002', date:'25030194'}
//  RED:   A001_0004_C003.R3D     → {camera:'A', roll:'001_0004', clip:'C003'}
//  Sony:  A001C001_230101AB      → {camera:'A', roll:'001', clip:'C001', date:'230101'}
function _parseCamName(s) {
  if (!s) return null;
  const stem = String(s).replace(/\.[^.]+$/, '').split('/').pop();

  // ARRI / Sony / generic: [CamLetter][Roll][ClipLetter][ClipNum][_...rest]
  let m = stem.match(/^([A-Za-z])(\d{3,4})([A-Za-z])(\d{3,})/);
  if (m) {
    const rest = stem.slice(m[0].length).replace(/^[_-]/, '');
    const datePart = rest.match(/^(\d{6,8})/)?.[1] || '';
    return { camera: m[1].toUpperCase(), roll: m[2], clipLetter: m[3].toUpperCase(), clip: m[3].toUpperCase() + m[4], date: datePart, raw: stem };
  }

  // RED: A001_C003 or A001_0001_C003
  m = stem.match(/^([A-Za-z])(\d{3,4})[_-](?:\d{4}[_-])?C(\d{3,})/i);
  if (m) {
    return { camera: m[1].toUpperCase(), roll: m[2], clipLetter: 'C', clip: 'C' + m[3], date: '', raw: stem };
  }

  return null;
}

// Camera name exact match: same camera+roll+clip (regardless of date/suffix)
function _camNameMatch(a, b) {
  const pa = _parseCamName(a), pb = _parseCamName(b);
  if (!pa || !pb) return false;
  return pa.camera === pb.camera && pa.roll === pb.roll && pa.clip === pb.clip;
}

// Camera roll match: same camera+roll (clip may differ — same roll, different take)
function _rollMatch(a, b) {
  const pa = _parseCamName(a), pb = _parseCamName(b);
  if (!pa || !pb) return false;
  return pa.camera === pb.camera && pa.roll === pb.roll;
}

// Extract camera roll prefix: "A001" from "A001C002_..."
function _rollPrefix(s) {
  if (!s) return '';
  const m = String(s).match(/^([A-Z][0-9]{3})/i);
  return m ? m[1].toUpperCase() : '';
}

// Normalise TC string
function _normTc(tc) {
  if (!tc) return '';
  return String(tc).replace(/[;,]/g, ':').trim();
}

// TC → absolute frame count
function _tcToFrames(tc, fps = 24) {
  const norm = _normTc(tc);
  if (!norm) return NaN;
  const parts = norm.split(':');
  if (parts.length < 4) return NaN;
  const [h, m, s, f] = parts.map(Number);
  if ([h, m, s, f].some(v => !Number.isFinite(v))) return NaN;
  return ((h * 3600 + m * 60 + s) * Math.round(fps)) + f;
}

// Frames → TC string (HH:MM:SS:FF)
function _framesToTc(frames, fps = 24) {
  if (!Number.isFinite(frames) || frames < 0) return '00:00:00:00';
  const fpsR = Math.round(fps);
  const f  = frames % fpsR;
  const s  = Math.floor(frames / fpsR) % 60;
  const m  = Math.floor(frames / (fpsR * 60)) % 60;
  const h  = Math.floor(frames / (fpsR * 3600));
  const p = (n, d = 2) => String(n).padStart(d, '0');
  return `${p(h)}:${p(m)}:${p(s)}:${p(f)}`;
}

// Absolute frame delta (Infinity if either TC invalid)
function _frameDelta(tcA, tcB, fps) {
  const a = _tcToFrames(tcA, fps), b = _tcToFrames(tcB, fps);
  return (Number.isFinite(a) && Number.isFinite(b)) ? Math.abs(a - b) : Infinity;
}

// TC range check — event srcIn (±tolerance) within [ocfTcIn, ocfTcOut]
// Also accepts handle-expanded range: event srcIn±handleFrames overlaps roll
function _tcInRange(eventSrcIn, ocfTcIn, ocfTcOut, fps, toleranceFrames = 2) {
  const evF    = _tcToFrames(eventSrcIn, fps);
  const startF = _tcToFrames(ocfTcIn, fps);
  const endF   = _tcToFrames(ocfTcOut, fps);
  if (!Number.isFinite(evF) || !Number.isFinite(startF)) return false;
  if (!Number.isFinite(endF)) return evF >= startF - toleranceFrames;
  return evF >= startF - toleranceFrames && evF <= endF + toleranceFrames;
}

// Handle-tolerant range: srcIn OR srcIn±handles falls within OCF roll
function _tcInRangeWithHandles(eventSrcIn, eventSrcOut, ocfTcIn, ocfTcOut, fps, handles = 16) {
  if (_tcInRange(eventSrcIn,  ocfTcIn, ocfTcOut, fps, handles)) return true;
  if (_tcInRange(eventSrcOut, ocfTcIn, ocfTcOut, fps, handles)) return true;
  // Overlap: event srcIn–srcOut overlaps ocfTcIn–ocfTcOut
  const evIn  = _tcToFrames(eventSrcIn,  fps);
  const evOut = _tcToFrames(eventSrcOut, fps);
  const ofIn  = _tcToFrames(ocfTcIn,     fps);
  const ofOut = _tcToFrames(ocfTcOut,    fps);
  if (!Number.isFinite(evIn) || !Number.isFinite(ofIn)) return false;
  const rangeEnd = Number.isFinite(ofOut) ? ofOut : ofIn + 864000; // open-ended: 10h max
  return evIn <= rangeEnd && evOut >= ofIn;
}

// Token-intersection string similarity [0,1] — better than prefix for reels like "A001L002_25030194"
function _tokenSim(a, b) {
  if (!a || !b) return 0;
  const tok = s => s.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean);
  const ta = tok(a), tb = tok(b);
  if (!ta.length || !tb.length) return 0;
  if (ta.join(' ') === tb.join(' ')) return 1;
  const setB = new Set(tb);
  const common = ta.filter(t => setB.has(t)).length;
  return common / Math.max(ta.length, tb.length);
}

// Extract parent folder name from a file path: '/OCF/A001/file.mxf' → 'A001'
function _parentFolder(path) {
  if (!path) return '';
  const parts = String(path).replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

// Normalised lower-case basename of a path or file:// URL, e.g.
// 'file:///Vol/OCF/A001L008_250301E6.mxf' → 'a001l008_250301e6.mxf'.
function _baseName(s) {
  if (!s) return '';
  let p = String(s).replace(/^file:\/\//i, '');
  try { p = decodeURIComponent(p); } catch {}
  return p.replace(/\\/g, '/').split('/').pop().trim().toLowerCase();
}
// Same basename, extension removed — tolerates clipName vs filename.ext mismatches.
function _baseNameNoExt(s) {
  return _baseName(s).replace(/\.[a-z0-9]{2,5}$/i, '');
}

// Do two TC ranges overlap?  (returns true if they share any frames)
function _tcRangesOverlap(aIn, aOut, bIn, bOut, fps) {
  const ai = _tcToFrames(aIn,  fps), ao = _tcToFrames(aOut || aIn, fps) + 1;
  const bi = _tcToFrames(bIn,  fps), bo = _tcToFrames(bOut || bIn, fps) + 1;
  if (!Number.isFinite(ai) || !Number.isFinite(bi)) return false;
  return ai < bo && bi < ao;
}

// Legacy prefix similarity (kept for backwards compat with pass 9)
function _strSim(a, b) {
  if (!a || !b) return 0;
  const la = _normName(a), lb = _normName(b);
  if (!la || !lb) return 0;
  if (la === lb) return 1;
  const tokenScore = _tokenSim(la, lb);
  // Also try structured camera name similarity
  if (_rollMatch(a, b)) return Math.max(tokenScore, 0.75);
  // Prefix component
  let i = 0;
  while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
  const prefixScore = i / Math.max(la.length, lb.length);
  return Math.max(tokenScore, prefixScore);
}

// ── Core matcher ──────────────────────────────────────────────────────────────
//
// ocfFile: { name, path, reel?, tcIn?, tcOut?, fps?, frameCount?, umid? }
// event:   { reel, srcIn, srcOut?, fps?, durationFrames?, clipName, srcFile, name, umid? }
// opts:    { tcTolerance=2, handleFrames=16, aleMap?, visualSimilarity? }
//   aleMap: Map<statusKey, {Tape, Start, ...}>  — from _pmAleMap in prep_mark.js

export function matchOcfToEvent(ocfFile, event, opts = {}) {
  const tcTol     = Number.isFinite(opts.tcTolerance) ? opts.tcTolerance : 2;
  const handles   = Number.isFinite(opts.handleFrames) ? opts.handleFrames : 16;
  const reasons   = [];
  const warnings  = [];
  let   score     = 0;

  const fps      = Number(event.fps || ocfFile.fps || 24);
  const evReel   = String(event.reel   || event.clipName || event.name || '').trim();
  const ocfReel  = String(ocfFile.reel || '').trim();
  const evFile   = String(event.srcFile || event.clipName || event.name || '').trim();
  const ocfFileName = String(ocfFile.name || ocfFile.path?.split('/').pop() || '').trim();
  // Use companion's short reel (e.g. "A001L002" from MXF tag) as an additional identity
  const ocfReelShort = String(ocfFile.reelShort || '').trim();
  // Use companion's structured fields if available (set by _probe_ocf_file)
  const ocfRollId = String(ocfFile.rollId || '').trim();  // e.g. "A001"

  const evNorm   = _normName(evFile  || evReel);
  const ocfNorm  = _normName(ocfFileName || ocfReel);
  const evPfx    = _rollPrefix(evReel  || evFile);
  const ocfPfx   = _rollPrefix(ocfReel || ocfFileName);

  // ── TC known? ──────────────────────────────────────────────────────────────
  // If companion couldn't read TC (ffprobe returned "00:00:00:00"), skip all
  // TC comparisons — we must not penalise a correct match for missing metadata.
  const ocfTcKnown = !!(ocfFile.tcKnown !== false &&
                        ocfFile.tcIn && ocfFile.tcIn !== '00:00:00:00');

  // ── Retime TC compensation (DaVinci-style) ──────────────────────────────────
  // For retimed events (slow-mo, overcrank), the EDL srcIn/srcOut represent the
  // real source TC range — BUT the timeline duration differs from source duration.
  // Speed correction: map the timeline segment back to the native source window.
  //   speed < 100% (slow-mo): source covers MORE frames than srcOut-srcIn suggests
  //   speed > 100% (undercrank): source covers FEWER frames
  // We keep srcIn as the anchor (always correct) and compute an adjusted srcOut.
  let effectiveSrcIn  = event.srcIn;
  let effectiveSrcOut = event.srcOut;
  // Read speed from whichever field the parser populated. The EDL parser sets
  // speed/speedFactor (NOT speedPercent), so the old `event.speedPercent` check
  // never fired for EDL imports → retimed shots failed to match their OCF.
  const speedPct = readSpeedPercent(event);
  const isDynamic = Array.isArray(event.speedKeys) && event.speedKeys.length > 1;
  if (!isDynamic && Number.isFinite(speedPct) && Math.abs(speedPct - 100) > 0.5 && speedPct > 0) {
    const srcInF  = _tcToFrames(event.srcIn,  fps);
    const srcOutF = _tcToFrames(event.srcOut || event.srcIn, fps);
    if (Number.isFinite(srcInF) && Number.isFinite(srcOutF)) {
      const timelineDurF = srcOutF - srcInF;
      const nativeDurF   = Math.round(timelineDurF * (100 / speedPct));
      effectiveSrcOut = _framesToTc(srcInF + nativeDurF, fps);
    }
  }

  const tcInDelta  = ocfTcKnown ? _frameDelta(ocfFile.tcIn, effectiveSrcIn, fps) : Infinity;
  const inRange    = ocfTcKnown && _tcInRange(effectiveSrcIn, ocfFile.tcIn, ocfFile.tcOut, fps, tcTol);
  const inRangeHdl = ocfTcKnown && _tcInRangeWithHandles(effectiveSrcIn, effectiveSrcOut || effectiveSrcIn, ocfFile.tcIn, ocfFile.tcOut, fps, handles);

  // ── Pass -1: Definitive source-file identity (path / exact filename) ────────
  // The strongest possible signal: the timeline or EDL references this exact OCF
  // file. FCPXML/Resolve carries the source <pathurl> (event._pathUrl) and the
  // original file name (event._fileNameOriginal); a conformed clip name often IS
  // the camera filename. When the basenames are identical this is a direct link —
  // no fuzzy scoring needed, and it works even when OCF timecode is unreadable
  // (e.g. Sony X-OCN RAW whose video descriptor FFmpeg can't resolve).
  const _evBase  = _baseName(event._pathUrl || event._fileNameOriginal || evFile || event.clipName);
  const _ocfBase = _baseName(ocfFile.path || ocfFileName);
  const _fileNameHit = !!(_evBase && _ocfBase &&
    (_evBase === _ocfBase || _baseNameNoExt(_evBase) === _baseNameNoExt(_ocfBase)));
  if (_fileNameHit) {
    const tcNote = ocfTcKnown
      ? (inRange ? ' + TC in range' : (tcInDelta <= tcTol ? ' + TC match' : ''))
      : '';
    const warn = (ocfTcKnown && !inRange && Number.isFinite(tcInDelta) && tcInDelta > tcTol && tcInDelta <= 10)
      ? ['Filename matches but srcIn is outside the file TC range — verify handles']
      : [];
    return { status: MATCH_STATUS.SAFE, confidence: warn.length ? 92 : 100,
             matchedPath: ocfFile.path || ocfFile.name,
             reasons: ['Source file name match' + tcNote], warnings: warn };
  }

  // ── Pass 0: UMID ────────────────────────────────────────────────────────────
  if (ocfFile.umid && event.umid && ocfFile.umid === event.umid) {
    return { status: MATCH_STATUS.SAFE, confidence: 100, matchedPath: ocfFile.path || ocfFile.name,
             reasons: ['UMID exact match'], warnings: [] };
  }

  // ── Pass 0b: Structured camera name (roll+clip exact) ──────────────────────
  // Match against filename, reel tag, AND short reel (MXF embedded tag).
  const camNameHit = _camNameMatch(evFile || evReel, ocfFileName || ocfReel)
                  || (ocfReelShort && _camNameMatch(evFile || evReel, ocfReelShort));
  if (camNameHit) {
    const tcBonus = Number.isFinite(tcInDelta) && tcInDelta <= 1 ? 18 : 0;
    score += 55 + tcBonus;
    reasons.push('Camera name exact (roll+clip)' + (tcBonus ? ' + TC-In exact' : ''));
  }

  // ── Pass 1: Reel exact + TC-In exact ───────────────────────────────────────
  const reelExact = ocfReel && evReel && ocfReel.toLowerCase() === evReel.toLowerCase();
  const tcExact   = Number.isFinite(tcInDelta) && tcInDelta <= 1;

  if (reelExact && tcExact && !camNameHit) {
    score += 60; reasons.push('Reel exact + TC-In exact');
  } else if (reelExact && !camNameHit) {
    score += 35; reasons.push('Reel name exact');
  }

  // ── Pass 2: Filename exact (normalised, no ext, no lab suffix) ─────────────
  const nameExact = ocfNorm && evNorm && ocfNorm === evNorm;
  if (nameExact && !camNameHit && !reelExact) {
    score += 30; reasons.push('Filename exact (normalised)');
  }

  // ── Pass 3: TC-In match ─────────────────────────────────────────────────────
  if (tcExact && !reasons.some(r => r.includes('TC-In exact'))) {
    score += 20; reasons.push('TC-In exact (≤1 frame)');
  } else if (Number.isFinite(tcInDelta)) {
    if (tcInDelta <= tcTol)  { score += 15; reasons.push(`TC-In within ${tcTol}f`); }
    else if (tcInDelta <= 10){ score += 6;  warnings.push(`TC-In offset ${tcInDelta}f — check handles`); }
    else                     {              warnings.push(`TC-In offset ${tcInDelta}f — likely wrong clip`); }
  }

  // ── TC unknown handling ──────────────────────────────────────────────────────
  if (!ocfTcKnown) {
    warnings.push('TC metadata unavailable from OCF — matching by name/reel only');
    // Camera name exact + no TC: give a small compensating bonus since the
    // roll+clip ID is already highly specific and TC would likely confirm it.
    if (camNameHit) { score += 6; reasons.push('TC-unknown compensated (camera name specific)'); }
  }

  // ── Pass 3b: Record date cross-check ───────────────────────────────────────
  // When both event reel and OCF filename/reel contain the same 6-digit date
  // (YYMMDD), that's a strong independent confirmation of the same shoot day.
  const evDate  = String(evReel || evFile).match(/_(\d{6})(?:\d{2})?/)?.[1] || '';
  const ocfDate = (ocfFile.recordDate)
    || String(ocfFileName || ocfReel).match(/_(\d{6})(?:\d{2})?/)?.[1] || '';
  if (evDate && ocfDate && evDate === ocfDate) {
    score += 6; reasons.push(`Record date match (${evDate})`);
  }

  // ── Pass 4: TC range overlap ────────────────────────────────────────────────
  if (!tcExact && inRange) {
    score += 12; reasons.push('srcIn within OCF roll range');
  } else if (!tcExact && !inRange && inRangeHdl) {
    // Handle-tolerant: srcIn±handles overlaps OCF roll — common for extended takes
    score += 8; reasons.push(`Handle-tolerant range overlap (±${handles}f)`);
  }

  // ── Pass 5: Camera roll prefix ──────────────────────────────────────────────
  if (evPfx && ocfPfx && evPfx === ocfPfx && !reelExact && !camNameHit) {
    score += 12; reasons.push(`Roll prefix match (${evPfx})`);
  }

  // ── Pass 6: ALE tape name lookup ────────────────────────────────────────────
  // If caller passes opts.aleMap (from _pmAleMap), the ALE Tape field is used
  // as an additional reel identity — critical when EDL reel was truncated.
  if (opts.aleMap) {
    const statusKey = `${event.reel || ''}|${event.srcIn || ''}`;
    const aleMeta   = opts.aleMap.get(statusKey);
    if (aleMeta) {
      const aleTape = String(aleMeta.Tape || aleMeta.tape || '').trim();
      if (aleTape) {
        const aleReelMatch = ocfReel && aleTape.toLowerCase() === ocfReel.toLowerCase();
        const aleNameMatch = _camNameMatch(aleTape, ocfFileName || ocfReel);
        if (aleNameMatch) {
          score += 20; reasons.push(`ALE camera name match (${aleTape})`);
        } else if (aleReelMatch) {
          score += 18; reasons.push(`ALE tape name match (${aleTape})`);
        } else if (_rollPrefix(aleTape) === ocfPfx && ocfPfx) {
          score += 8;  reasons.push(`ALE roll prefix match (${_rollPrefix(aleTape)})`);
        }
        // ALE start TC match
        const aleStart = aleMeta.Start || aleMeta.start || '';
        if (aleStart && _frameDelta(aleStart, ocfFile.tcIn, fps) <= 2) {
          score += 10; reasons.push('ALE start TC matches OCF tcIn');
        }
      }
    }
  }

  // ── Pass 6b: Subfolder/path contribution ────────────────────────────────────
  // Productions organise OCF in per-roll subdirectories: /OCF/A001/file.mxf
  // Parent folder is an INDEPENDENT confirmation — always score it, even when
  // camera name already matched (it's a different data source).
  if (ocfFile.path) {
    const folder = _parentFolder(ocfFile.path);
    if (folder && folder.length >= 2) {
      const folderPfx  = _rollPrefix(folder);
      const folderCam  = _parseCamName(folder);
      const folderNorm = _normName(folder);
      const evNorm4    = evNorm.slice(0, 4);
      if (_camNameMatch(folder, evFile || evReel)) {
        // Subfolder itself is a full camera name match
        score += 12; reasons.push(`Subfolder name match (${folder})`);
      } else if (folderPfx && folderPfx === evPfx) {
        // Roll prefix match: A001 subfolder for A001xxx event
        score += 10; reasons.push(`Subfolder roll match (${folder})`);
      } else if (folderNorm && evNorm4 && (folderNorm.startsWith(evNorm4) || evNorm.startsWith(folderNorm))) {
        score += 5;  reasons.push(`Subfolder prefix (${folder})`);
      }
    }
  }

  // ── Pass 7: TC-Out match ────────────────────────────────────────────────────
  // Use the retime-compensated out point (see Pass -1's effectiveSrcOut above) —
  // for a retimed event, the raw event.srcOut is the timeline-duration-derived
  // out point, not the true native-source out point the OCF file's tcOut covers.
  const tcOutDelta = _frameDelta(ocfFile.tcOut, effectiveSrcOut || event.srcOut, fps);
  if (Number.isFinite(tcOutDelta) && tcOutDelta <= 2) {
    score += 8; reasons.push('TC-Out matches');
  }

  // ── Pass 8: FPS match ───────────────────────────────────────────────────────
  const fpsDelta = ocfFile.fps && event.fps ? Math.abs(Number(ocfFile.fps) - Number(event.fps)) : null;
  if (fpsDelta !== null) {
    if (fpsDelta < 0.1) { score += 5; reasons.push('FPS match'); }
    else if (fpsDelta > 1) { score -= 10; warnings.push(`FPS mismatch: OCF ${ocfFile.fps} vs event ${event.fps}`); }
  }

  // ── Pass 9: Duration match ──────────────────────────────────────────────────
  const evDur  = Number(event.durationFrames || 0);
  const ocfDur = Number(ocfFile.frameCount   || 0);
  if (evDur > 0 && ocfDur > 0) {
    const dd = Math.abs(evDur - ocfDur);
    if (dd === 0)                                   { score += 5; reasons.push('Duration exact'); }
    else if (dd <= 2)                               { score += 3; reasons.push('Duration ±2f'); }
    else if (dd > Math.max(evDur, ocfDur) * 0.1)   { warnings.push('Duration mismatch >10%'); }
  }

  // ── Pass 10: Token + fuzzy name similarity ──────────────────────────────────
  if (!nameExact && !camNameHit && ocfNorm && evNorm) {
    const sim = _strSim(ocfNorm, evNorm);  // now uses token intersection
    if (sim >= 0.85)      { score += 14; reasons.push(`Name fuzzy match (${Math.round(sim*100)}%)`); }
    else if (sim >= 0.65) { score +=  7; warnings.push(`Name partial match (${Math.round(sim*100)}%)`); }
    if (ocfNorm.includes(evNorm) || evNorm.includes(ocfNorm)) {
      if (!nameExact) { score += 8; reasons.push('Name substring match'); }
    } else if (!reelExact && !nameExact) {
      score -= 5;  // no substring overlap — penalty
    }
  }

  // ── Pass OCR: burn-in filename read from reference video ────────────────────
  // Caller pre-computes OCR text from the reference video frame at event TC and
  // passes it via opts.ocrHint (string). A filename read from burn-in is a very
  // strong signal — treated as a name-exact match bonus.
  if (opts.ocrHint) {
    const ocrNorm = _normName(String(opts.ocrHint));
    if (ocrNorm && ocfNorm) {
      const exact  = ocrNorm === ocfNorm;
      const prefix = ocfNorm.startsWith(ocrNorm) || ocrNorm.startsWith(ocfNorm);
      if (exact)       { score += 50; reasons.push(`OCR burn-in exact: "${opts.ocrHint}"`); }
      else if (prefix) { score += 30; reasons.push(`OCR burn-in prefix: "${opts.ocrHint}"`); }
    }
  }

  // ── Pass 11: Visual similarity (caller-supplied) ────────────────────────────
  if (Number.isFinite(opts.visualSimilarity)) {
    const vs = Number(opts.visualSimilarity);
    if (vs >= 90)      { score += 10; reasons.push(`Visual match ${vs}%`); }
    else if (vs >= 70) { score +=  5; warnings.push(`Visual similarity ${vs}%`); }
  }

  // ── Speed/retime note ──────────────────────────────────────────────────────
  // Constant retime: TC compensation was applied above — no penalty needed.
  // Dynamic retime (speed keys): TC range is unpredictable; add warning only.
  if (Number.isFinite(speedPct) && Math.abs(speedPct - 100) > 0.5) {
    if (isDynamic) {
      warnings.push(`Dynamic retime — verify TC alignment manually`);
      score -= 5;
    } else {
      reasons.push(`Retime ${speedPct}% — TC compensated`);
    }
  }

  // Clip-name-exact (roll+clip ID, e.g. A001L008) corroborated by timecode — either
  // an exact TC-In or the source-in falling inside the OCF file's TC range — is a
  // definitive match for real EDL/ALE conforms that carry no source path. Promote
  // it to SAFE so these don't pile up in "review".
  if (camNameHit && (tcExact || inRange)) score = Math.max(score, 85);

  // ── Score → status ──────────────────────────────────────────────────────────
  score = Math.max(0, Math.min(100, score));
  let status;
  if      (score >= 80) { status = MATCH_STATUS.SAFE; }
  else if (score >= 55) { status = MATCH_STATUS.REVIEW_NEEDED; if (!warnings.length) warnings.push('Partial match — verify before export'); }
  else if (score >= 28) { status = MATCH_STATUS.NOT_RECOMMENDED; warnings.push('Low confidence — manual verification required'); }
  else                  { status = MATCH_STATUS.MISSING; reasons.length = 0; warnings.push('No matching OCF found'); }

  return {
    status,
    confidence:  Math.round(score),
    matchedPath: score >= 40 ? (ocfFile.path || ocfFile.name) : null,
    reasons,
    warnings,
    _debug: { camNameHit, reelExact, nameExact, tcInDelta, inRange, inRangeHdl, evPfx, ocfPfx, score },
  };
}

// ── Batch match with roll grouping + TC-range-aware deduplication ────────────
//
// opts: { aleMap?, handleFrames=16, tcTolerance=2, deduplicate=true }
//
// Deduplication behaviour (CORRECT):
//   Multiple events → same OCF at DIFFERENT TC positions = NORMAL (multi-take)
//   Multiple events → same OCF at OVERLAPPING TC positions = CONFLICT (flag it)
//   One event       → multiple OCF candidates → keep highest confidence
export function matchAllEvents(events, ocfFiles, opts = {}) {
  const dedup = opts.deduplicate !== false;  // default true

  if (!ocfFiles.length) {
    return events.map(event => ({
      event,
      match: { status: MATCH_STATUS.MISSING, confidence: 0, matchedPath: null,
               reasons: [], warnings: ['No OCF files loaded'] },
    }));
  }

  // ── ALE augmentation of OCF metadata ───────────────────────────────────────
  // If companion returned tcKnown=false for some files but ALE has matching tape
  // entries with Start TC, inject those TCs into the OCF objects before scoring.
  // This lets TC matching work even when ffprobe can't read camera-native TC.
  let augmentedOcfFiles = ocfFiles;
  if (opts.aleMap && opts.aleMap.size > 0) {
    // Build reverse ALE index: normalisedTapeName → ALE record
    const aleTapeIndex = new Map();
    for (const [, record] of opts.aleMap) {
      const tape = String(record.Tape || record.tape || '').trim();
      if (tape) aleTapeIndex.set(_normName(tape), record);
    }
    augmentedOcfFiles = ocfFiles.map(ocf => {
      if (ocf.tcKnown !== false) return ocf; // already has TC
      const ocfNormKey = _normName(ocf.reel || ocf.name || '');
      const aleMatch   = aleTapeIndex.get(ocfNormKey) || null;
      if (!aleMatch) return ocf;
      const aleStart = String(aleMatch.Start || aleMatch.start || '').trim();
      const aleEnd   = String(aleMatch.End   || aleMatch.end   || '').trim();
      if (!aleStart || !aleStart.includes(':')) return ocf;
      return {
        ...ocf,
        tcIn:    aleStart,
        tcOut:   aleEnd || ocf.tcOut,
        tcKnown: true,
        _aleTC:  true,
      };
    });
  }
  const resolvedOcfFiles = augmentedOcfFiles;

  // ── Build multi-key roll index ──────────────────────────────────────────────
  // Keys: roll prefix (A001), full reel, camera+roll composite, rollId field
  const rollIndex = new Map();
  const _addToIndex = (key, ocf) => {
    const k = key.toLowerCase();
    if (!rollIndex.has(k)) rollIndex.set(k, []);
    rollIndex.get(k).push(ocf);
  };
  for (const ocf of resolvedOcfFiles) {
    const reel = String(ocf.reel || '').trim();
    const name = String(ocf.name || ocf.path?.split('/').pop() || '');
    const pfx  = _rollPrefix(reel || name);
    if (pfx)           _addToIndex(pfx, ocf);
    if (reel)          _addToIndex(reel, ocf);
    if (ocf.rollId)    _addToIndex(ocf.rollId, ocf);  // structured field from companion
    const cam = _parseCamName(name || reel);
    if (cam)           _addToIndex(cam.camera + cam.roll, ocf);
  }

  // ── TC-hour index for large folders (>50 files) ────────────────────────────
  // Group OCF files by EVERY TC hour they span (not just the start hour), so a
  // long/continuous roll (e.g. 10:00→13:00) is found by an event at any hour
  // inside it. Indexing only the start hour silently dropped valid matches on
  // multi-hour rolls.
  // This pre-filter reduces O(events × files) to O(events × files_in_hour).
  let hourIndex = null;
  if (resolvedOcfFiles.length > 50) {
    hourIndex = new Map();
    const _hourOf = (tc) => {
      const h = parseInt(String(tc || '0').split(/[:;]/)[0], 10);
      return Number.isFinite(h) ? ((h % 24) + 24) % 24 : 0;
    };
    for (const ocf of resolvedOcfFiles) {
      // Index files whose TC will be treated as known during scoring (mirror the
      // predicate in matchOcfToEvent: known unless explicitly false + real tcIn).
      // Using `!ocf.tcKnown` here wrongly dropped files with a valid tcIn but an
      // undefined tcKnown flag, so their correct OCF was never scored.
      if (ocf.tcKnown === false || !ocf.tcIn || ocf.tcIn === '00:00:00:00') continue;
      const hIn  = _hourOf(ocf.tcIn);
      const hOut = _hourOf(ocf.tcOut || ocf.tcIn);
      // Walk hIn → hOut inclusive, wrapping past midnight (≤24 steps).
      let h = hIn;
      for (let guard = 0; guard < 25; guard++) {
        if (!hourIndex.has(h)) hourIndex.set(h, []);
        hourIndex.get(h).push(ocf);
        if (h === hOut) break;
        h = (h + 1) % 24;
      }
    }
  }

  // Reel-alias map: editorial reel name → camera reel (e.g. "REEL_A" → "A001").
  // Lets renamed reels match their camera originals.
  const _reelAliasMap = opts.reelAliases
    ? (opts.reelAliases instanceof Map ? opts.reelAliases : new Map(Object.entries(opts.reelAliases)))
    : null;
  const _resolveAlias = (reel) => {
    if (!_reelAliasMap || !reel) return null;
    return _reelAliasMap.get(reel) || _reelAliasMap.get(_normName(reel)) || null;
  };

  // Score all events against narrowed candidates
  const allScored = events.map((event, eventIdx) => {
    const evReel = String(event.reel || event.clipName || '').trim();
    const evFile = String(event.srcFile || '').trim();
    const evPfx  = _rollPrefix(evReel || evFile);
    const cam    = _parseCamName(evReel || evFile);

    // Resolve a reel alias; score against the camera reel but keep the original
    // event for display.
    const aliasReel  = _resolveAlias(evReel);
    const scoreEvent = aliasReel ? { ...event, reel: aliasReel } : event;

    // Build preferred candidate set via roll index
    const prefSet = new Set();
    const tryKey = (k) => { const arr = rollIndex.get(k?.toLowerCase() || ''); if (arr) arr.forEach(o => prefSet.add(o)); };
    if (evPfx)  tryKey(evPfx);
    if (evReel) tryKey(evReel);
    if (cam)    tryKey(cam.camera + cam.roll);
    if (aliasReel) {
      tryKey(aliasReel);
      tryKey(_rollPrefix(aliasReel));
      const camA = _parseCamName(aliasReel);
      if (camA) tryKey(camA.camera + camA.roll);
    }

    // ALE tape name for broader roll scoping
    if (opts.aleMap) {
      const aleMeta = opts.aleMap.get(`${event.reel || ''}|${event.srcIn || ''}`);
      const aleTape = String(aleMeta?.Tape || aleMeta?.tape || '').trim();
      if (aleTape) { tryKey(_rollPrefix(aleTape)); tryKey(aleTape); }
    }

    // TC-hour filter (large folders): intersect preferred with same-hour OCF files
    if (hourIndex) {
      const evHour = parseInt(String(event.srcIn || '0').split(':')[0], 10) || 0;
      // Index keys are wrapped mod 24, so wrap the ±1h adjacency lookups too —
      // otherwise the tolerance was lost at the midnight boundary (hour 0 → -1,
      // hour 23 → 24 both missed).
      const hourCands = new Set([
        ...(hourIndex.get(((evHour % 24) + 24) % 24)       || []),
        ...(hourIndex.get(((evHour - 1) % 24 + 24) % 24)   || []),
        ...(hourIndex.get(((evHour + 1) % 24) % 24)        || []),
      ]);
      if (hourCands.size > 0 && prefSet.size > 0) {
        // Keep files that are in BOTH preferred AND correct hour
        for (const o of prefSet) { if (!hourCands.has(o)) prefSet.delete(o); }
        // If filter emptied set, revert to preferred without hour filter
        if (prefSet.size === 0) for (const o of hourCands) prefSet.add(o);
      }
    }

    const preferred = prefSet.size > 0 ? [...prefSet] : resolvedOcfFiles;
    let best = null;

    const _eventOpts = opts.ocrHints instanceof Map
      ? { ...opts, ocrHint: opts.ocrHints.get(eventIdx) || '' }
      : opts;

    const _score = (candidates) => {
      for (const ocf of candidates) {
        const m = matchOcfToEvent(ocf, scoreEvent, _eventOpts);
        if (!best || m.confidence > best.match.confidence) best = { event, match: m, ocf };
      }
    };

    _score(preferred);

    // Note when a reel alias produced the match so it's visible to the user.
    if (aliasReel && best?.match?.matchedPath && best.match.reasons) {
      best.match.reasons = [...best.match.reasons, `Reel alias "${evReel}" → "${aliasReel}"`];
    }

    // Widen to all files if best confidence < 50 (roll prefix may have been wrong)
    if (preferred.length < resolvedOcfFiles.length && (best?.match.confidence ?? 0) < 50) {
      _score(resolvedOcfFiles);
    }

    // Filename-exact fallback: if scorer found no matchedPath (score < 40) but
    // an OCF file has the exact same basename as event.srcFile or event.reel,
    // force-link it at REVIEW_NEEDED confidence.  Covers cases where the EDL
    // reel name doesn't match the companion's probed reel field (codec metadata
    // gap) but the filenames are identical.
    if (!best?.match?.matchedPath) {
      const evFile  = String(event.srcFile || event.clipName || event.name || '').trim().toLowerCase();
      const evReel2 = String(event.reel || '').trim().toLowerCase();
      const hit = resolvedOcfFiles.find(f => {
        const n = String(f.name || (f.path || '').split('/').pop() || '').trim().toLowerCase();
        return n && (n === evFile || n === evReel2 || n === evReel2 + '.mxf' || n === evReel2 + '.mov' || n === evReel2 + '.ari');
      });
      if (hit) {
        best = {
          event,
          match: {
            status:      MATCH_STATUS.REVIEW_NEEDED,
            confidence:  50,
            matchedPath: hit.path || hit.name,
            reasons:     ['Filename exact match'],
            warnings:    ['Force-linked by filename — verify TC alignment'],
          },
          ocf: hit,
        };
      }
    }

    return best ?? {
      event,
      match: { status: MATCH_STATUS.MISSING, confidence: 0, matchedPath: null,
               reasons: [], warnings: ['No match found'] },
    };
  });

  if (!dedup) return allScored;

  // ── Cross-reel conflict detection ────────────────────────────────────────────
  // Multiple events → same OCF = NORMAL (multi-take from one roll).
  // Flag ONLY when two events from DIFFERENT REELS both scored high confidence
  // against the same OCF file — this indicates one assignment is wrong.
  const byPath = new Map();
  for (const r of allScored) {
    const path = r.match?.matchedPath;
    if (!path || r.match.confidence < 60) continue;
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path).push(r);
  }

  const conflictSet = new Set();
  for (const [, group] of byPath) {
    if (group.length < 2) continue;
    // Check if any two events in the group have DIFFERENT reels
    const reels = group.map(r => _normName(r.event?.reel || r.event?.srcFile || ''));
    const uniqueReels = new Set(reels);
    if (uniqueReels.size <= 1) continue; // all same reel — normal multi-take, no flag

    // Different reels sharing an OCF → one is likely wrong
    // Keep highest-confidence match for each reel; flag lower ones
    const byReel = new Map();
    for (const r of group) {
      const reel = reels[group.indexOf(r)];
      const cur = byReel.get(reel);
      if (!cur || r.match.confidence > cur.match.confidence) byReel.set(reel, r);
    }
    // The lower-confidence cross-reel assignments are conflicts
    for (const r of group) {
      const reel = reels[group.indexOf(r)];
      if (byReel.get(reel) !== r) conflictSet.add(r);
    }
  }

  // ── Overlapping-pull detection (same OCF, same reel) ─────────────────────────
  // Two events pulling OVERLAPPING source-TC ranges from the same OCF use the
  // same camera frames twice — a likely duplicate or mis-cut. Multi-takes at
  // DIFFERENT (non-overlapping) ranges are normal and not flagged.
  // Group by matched OCF for ALL linked events (matchedPath present, score ≥40),
  // not just the ≥60 used for cross-reel — an overlapping dup can be a weaker match.
  const byPathAll = new Map();
  for (const r of allScored) {
    const path = r.match?.matchedPath;
    if (!path) continue;
    if (!byPathAll.has(path)) byPathAll.set(path, []);
    byPathAll.get(path).push(r);
  }

  const overlapSet = new Set();
  for (const [, group] of byPathAll) {
    if (group.length < 2) continue;
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        const ea = group[a].event, eb = group[b].event;
        const fa = Number(ea.fps) || 24, fb = Number(eb.fps) || 24;
        const aIn = _tcToFrames(ea.srcIn || '', fa), aOut = _tcToFrames(ea.srcOut || ea.srcIn || '', fa);
        const bIn = _tcToFrames(eb.srcIn || '', fb), bOut = _tcToFrames(eb.srcOut || eb.srcIn || '', fb);
        if (!Number.isFinite(aIn) || !Number.isFinite(bIn)) continue;
        // Exclusive intersection — frame-adjacent cuts (one's srcOut == the
        // next's srcIn) are normal consecutive pulls, NOT an overlap conflict.
        if (aIn < bOut && bIn < aOut) { overlapSet.add(group[a]); overlapSet.add(group[b]); }
      }
    }
  }

  return allScored.map(r => {
    if (!conflictSet.has(r) && !overlapSet.has(r)) return r;
    const warnings = [...(r.match.warnings || [])];
    const patch = { ...r.match, status: MATCH_STATUS.REVIEW_NEEDED };
    if (conflictSet.has(r)) {
      warnings.push('Cross-reel conflict: different reel matched same OCF — verify assignment');
      patch._tcConflict = true;
    }
    if (overlapSet.has(r)) {
      warnings.push('Overlapping pull: another shot pulls overlapping frames from this camera file — verify');
      patch._overlapConflict = true;
    }
    patch.warnings = warnings;
    return { ...r, match: patch };
  });
}

// ── Reel-alias auto-suggest ───────────────────────────────────────────────────
// For events that don't match any OCF by reel, find the OCF that matches best by
// NON-reel signals (timecode / filename / camera-name). If one matches strongly,
// the editorial reel was probably renamed — propose aliasing it to that camera
// roll. Returns [{ editorialReel, cameraReel, bestConf, count }] sorted by conf.
export function suggestReelAliases(events, ocfFiles, opts = {}) {
  if (!Array.isArray(events) || !Array.isArray(ocfFiles) || !ocfFiles.length) return [];
  const threshold = Number.isFinite(opts.suggestThreshold) ? opts.suggestThreshold : 55;
  const aliasMap = opts.reelAliases
    ? (opts.reelAliases instanceof Map ? opts.reelAliases : new Map(Object.entries(opts.reelAliases)))
    : null;

  // Reels/roll-prefixes that already exist among the OCF files (no alias needed).
  const ocfReelKeys = new Set();
  for (const o of ocfFiles) {
    const reel = String(o.reel || '').trim();
    const name = String(o.name || (o.path || '').split('/').pop() || '');
    if (reel) ocfReelKeys.add(_normName(reel));
    const pfx = _rollPrefix(reel || name);
    if (pfx) ocfReelKeys.add(_normName(pfx));
  }

  const out = new Map();
  for (const event of events) {
    const evReel = String(event.reel || '').trim();
    if (!evReel) continue;
    if (aliasMap && (aliasMap.get(evReel) || aliasMap.get(_normName(evReel)))) continue; // already aliased
    const evKey = _normName(evReel);
    const evPfx = _normName(_rollPrefix(evReel) || '');
    if (ocfReelKeys.has(evKey) || (evPfx && ocfReelKeys.has(evPfx))) continue; // reel already resolves

    // Best match ignoring reel (blank it so only TC/filename/camera-name score).
    const blanked = { ...event, reel: '' };
    let best = null;
    for (const ocf of ocfFiles) {
      const m = matchOcfToEvent(ocf, blanked, opts);
      if (!best || m.confidence > best.conf) best = { conf: m.confidence, ocf };
    }
    if (!best || best.conf < threshold) continue;

    const cam = String(_rollPrefix(best.ocf.reel || best.ocf.name || '') || best.ocf.reel || '').trim();
    if (!cam || _normName(cam) === evKey) continue;

    const key = `${evReel} ${cam}`;
    const cur = out.get(key) || { editorialReel: evReel, cameraReel: cam, bestConf: 0, count: 0 };
    cur.bestConf = Math.max(cur.bestConf, best.conf);
    cur.count++;
    out.set(key, cur);
  }
  return [...out.values()].sort((a, b) => b.bestConf - a.bestConf);
}

// ── Unmatched OCF detection ───────────────────────────────────────────────────
// Returns OCF files that no event claimed (useful to surface extra footage).
export function findUnmatchedOcf(matchResults, ocfFiles) {
  const claimedPaths = new Set(
    matchResults.map(r => r.match?.matchedPath).filter(Boolean)
  );
  return ocfFiles.filter(ocf => !claimedPaths.has(ocf.path || ocf.name));
}

export function matchSummary(results) {
  const counts = { SAFE: 0, REVIEW_NEEDED: 0, NOT_RECOMMENDED: 0, MISSING: 0 };
  for (const r of results) counts[r.match?.status || 'MISSING']++;
  return counts;
}

// ── Relink helper — Resolve "find and replace" path logic ────────────────────
// Given new OCF root and a set of match results, returns updated results with
// corrected paths.  Mirrors Resolve's "Relink Selected Clips" function.
export function relinkOcfPaths(matchResults, newOcfRoot, opts = {}) {
  return matchResults.map(r => {
    if (!r.match?.matchedPath) return r;
    const oldPath = r.match.matchedPath;
    const fileName = oldPath.split('/').pop();
    const newPath  = `${newOcfRoot.replace(/\/$/, '')}/${fileName}`;
    return {
      ...r,
      match: {
        ...r.match,
        matchedPath: newPath,
        reasons:     [...(r.match.reasons || []), `Relinked: ${oldPath.split('/').slice(-3).join('/')} → …/${fileName}`],
      },
    };
  });
}
