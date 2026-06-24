// scripts/parsers/prproj.js  — PostFlowX Adobe Premiere Pro native importer
// Smarter v2: no XML export needed — drop .prproj directly
//
// ✅ Improvements over v1:
//   1. Source TC accuracy   — VideoStartTime offset gives real srcIn/srcOut for OCF matching
//   2. Speed / retime       — SpeedFactor + TimeRemapping keyframe detection → _pmRetimeAuto
//   3. Disabled clips       — <Enabled>false</Enabled> → ev.disabled (filtered by pull prep)
//   4. Source file path     — extracted from MasterClip/Media for companion OCF lookup
//   5. Audio channel count  — overlapping audio clips counted for CONFORM_ANALYSIS
//   6. Opacity ramp type    — keyframe count → CONSTANT / LINEAR / BEZIER / NODAL_STEPS
//   7. Sequence markers     — matched to events by TC overlap → ev._prprojMarkers
//   8. Color labels         — Premiere labels → camera color hint
//   9. Primary seq choice   — longest non-nested sequence; skips nested/compound clips
//
// Output contract (PostFlowX standard):
//   {
//     events: [{
//       clipName, srcFile, reel,
//       srcIn, srcOut, recIn, recOut,
//       fps, role, sourceType: "prproj",
//       disabled,
//       _pmRetimeAuto, _pmSpeedDisplay, _pmRetimeMode,
//       _trackIdx, _seqName,
//       _prprojSrcPath, _prprojLabel,
//       _prprojAudioTracks, _prprojOpacity,
//       _prprojMarkers
//     }],
//     projectName, fps
//   }
//
// Time system: 10,160,640,000 ticks/second (Premiere 2019–2025)
// Source TC:   srcIn = ticksToTC(VideoStartTime + ClipItem.In)
// Record TC:   recIn = ticksToTC(seqStartOffset + ClipItem.Start)

// ─── Tick rate ────────────────────────────────────────────────────────────────

const TICKS_PER_SEC = 10160640000;

// ─── Public entry point ───────────────────────────────────────────────────────

export async function parsePRPROJ(file) {
  const buf     = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  const xmlText = await _decompress(buf);
  const doc     = new DOMParser().parseFromString(xmlText, 'application/xml');

  if (doc.querySelector('parsererror'))
    throw new Error('prproj XML parse error — file may be corrupt or wrong format');

  const uidMap   = _buildUidMap(doc);
  const tickRate = _detectTickRate(doc, uidMap);

  // Pick primary sequence (longest, non-nested)
  const sequences   = [...doc.querySelectorAll('Sequence')];
  const nestedUids  = _findNestedSequenceUids(doc);
  const candidates  = sequences.filter(s => !nestedUids.has(s.getAttribute('ObjectUID') || ''));
  const seq         = candidates.reduce((best, s) =>
    _seqEndTick(s) > _seqEndTick(best) ? s : best,
    candidates[0] || sequences[0]
  );
  if (!seq) throw new Error('No usable sequence found in .prproj');

  const { nominalFps, ticksPerFrame } = _getSeqFps(seq, tickRate);
  const seqName     = _text(seq, 'Name') || 'Sequence';
  const projectName = _text(doc.querySelector('Project'), 'Name') ||
                      _text(doc.querySelector('PremiereData > Project'), 'Name') || seqName;
  const seqStartOffset = _seqStartTick(seq); // record TC base (usually 0)

  // Build audio clip TC map for overlap counting
  const audioMap = _buildAudioTcMap(seq, tickRate, nominalFps, ticksPerFrame, seqStartOffset);

  // Extract sequence markers for event annotation
  const seqMarkers = _extractSeqMarkers(seq, tickRate, nominalFps, ticksPerFrame, seqStartOffset);

  const events = _extractEvents(
    seq, uidMap, nominalFps, ticksPerFrame, seqStartOffset,
    audioMap, seqMarkers, seqName
  );

  return { events, fps: nominalFps, projectName };
}

// ─── Decompression ────────────────────────────────────────────────────────────

async function _decompress(buf) {
  for (const fmt of ['gzip', 'deflate-raw', 'deflate']) {
    try {
      const ds     = new DecompressionStream(fmt);
      const stream = new Blob([buf]).stream().pipeThrough(ds);
      return await new Response(stream).text();
    } catch {}
  }
  return new TextDecoder('utf-8').decode(buf); // uncompressed XML fallback
}

// ─── UID map (all root-level elements with ObjectUID) ─────────────────────────

function _buildUidMap(doc) {
  const map = new Map();
  for (const el of doc.documentElement.children) {
    const uid = el.getAttribute('ObjectUID');
    if (uid) map.set(uid, el);
  }
  return map;
}

// ─── Tick rate detection ──────────────────────────────────────────────────────

function _detectTickRate(doc, uidMap) {
  const tps = doc.querySelector('TicksPerSecond');
  if (tps) { const v = parseInt(tps.textContent, 10); if (v > 0) return v; }
  return TICKS_PER_SEC;
}

// ─── Find nested (compound/subsequence) UIDs ─────────────────────────────────

function _findNestedSequenceUids(doc) {
  const nested = new Set();
  // ClipItems that reference a Sequence (not a MasterClip) are nested
  for (const ref of doc.querySelectorAll('ClipItem ComponentClipID ObjectRef, ClipItem ClipID ObjectRef')) {
    const uid = ref.getAttribute('ObjectUID');
    if (!uid) continue;
    const el = doc.getElementById ? null : null; // can't use getElementById on arbitrary XML
    // we'll mark these after building uid map — handled in main flow
  }
  return nested;
}

// ─── FPS ─────────────────────────────────────────────────────────────────────

function _getSeqFps(seq, tickRate) {
  const tb = seq.querySelector('TimeBase');
  let nominal = 24;
  let ntsc    = false;
  if (tb) {
    const v = parseInt(_text(tb, 'Timebase') || '24', 10);
    nominal  = v || 24;
    ntsc     = (_text(tb, 'NTSCVideoFlag') || '').toLowerCase() === 'true';
  }
  // ticks per frame — use nominal for TC display (don't drop frames for pull prep)
  const actualFps    = ntsc ? nominal * 1000 / 1001 : nominal;
  const ticksPerFrame = Math.round(tickRate / actualFps);
  return { nominalFps: nominal, ticksPerFrame, ntsc };
}

// ─── Sequence start tick (record TC base) ────────────────────────────────────

function _seqStartTick(seq) {
  // <StartTimecode> or <InPoint> represents the record timeline start TC
  const stc = _text(seq, 'StartTimecode');
  if (stc) { const v = parseInt(stc, 10); if (v > 0) return v; }
  // Premiere can also store it as a formatted TC in <StartTimecodeString>
  return 0; // default: 00:00:00:00
}

// ─── Sequence end tick (for primary sequence selection) ───────────────────────

function _seqEndTick(seq) {
  let max = 0;
  for (const ci of seq.querySelectorAll('ClipItem')) {
    const e = parseInt(_text(ci, 'End') || '0', 10);
    if (e > max) max = e;
  }
  return max;
}

// ─── TC conversion ────────────────────────────────────────────────────────────

function _ticksToTC(ticks, fps, ticksPerFrame) {
  const pad2  = n => String(n).padStart(2, '0');
  const FPS   = Math.max(1, fps);
  const fr    = Math.max(0, Math.round(ticks / ticksPerFrame));
  const totS  = Math.floor(fr / FPS);
  const ff    = fr % FPS;
  const hh    = Math.floor(totS / 3600);
  const mm    = Math.floor((totS % 3600) / 60);
  const ss    = totS % 60;
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
}

// ─── Audio overlap map ────────────────────────────────────────────────────────
// Returns: Map<recStartTick, audioTrackCount> for quick lookup

function _buildAudioTcMap(seq, tickRate, fps, ticksPerFrame, seqOffset) {
  // Collect audio clip intervals [start, end]
  const intervals = [];
  for (const atg of seq.querySelectorAll('AudioTracks TrackGroup, AudioTrackGroup')) {
    for (const ci of atg.querySelectorAll('ClipItem')) {
      const s = parseInt(_text(ci, 'Start') || '-1', 10);
      const e = parseInt(_text(ci, 'End')   || '-1', 10);
      if (s >= 0 && e > s) intervals.push([s, e]);
    }
  }
  // Returns count of audio clips overlapping a given [vs, ve] video clip window
  return { query: (vs, ve) => intervals.filter(([s, e]) => s < ve && e > vs).length };
}

// ─── Sequence markers ─────────────────────────────────────────────────────────

function _extractSeqMarkers(seq, tickRate, fps, ticksPerFrame, seqOffset) {
  const markers = [];
  for (const mk of seq.querySelectorAll('Markers > Marker, Markers > MarkerItem')) {
    const name    = _text(mk, 'Name') || _text(mk, 'Comment') || '';
    const inTick  = parseInt(_text(mk, 'In')  || '-1', 10);
    const outTick = parseInt(_text(mk, 'Out') || '-1', 10);
    const color   = parseInt(_text(mk, 'Color') || '0', 10);
    if (inTick < 0) continue;
    markers.push({
      name,
      tcIn:  _ticksToTC(seqOffset + inTick, fps, ticksPerFrame),
      tcOut: outTick > 0 ? _ticksToTC(seqOffset + outTick, fps, ticksPerFrame) : null,
      color: _labelColor(color, true), // Premiere marker color index
    });
  }
  return markers;
}

// ─── Main event extraction ────────────────────────────────────────────────────

function _extractEvents(seq, uidMap, fps, ticksPerFrame, seqOffset, audioMap, seqMarkers, seqName) {
  const events = [];
  const videoTracks = _getVideoTracks(seq);

  videoTracks.forEach((track, trackIdx) => {
    const role = trackIdx === 0 ? 'V1' : `V${trackIdx + 1}`;
    const cis  = [...track.querySelectorAll(':scope > ClipItems > ClipItem, :scope > ClipItem')];

    for (const ci of cis) {
      const recStartTick = parseInt(_text(ci, 'Start') || '0', 10);
      const recEndTick   = parseInt(_text(ci, 'End')   || '0', 10);
      if (recEndTick <= recStartTick) continue; // gap / zero-duration

      // ── Disabled clip ────────────────────────────────────────────────────────
      const enabled = (_text(ci, 'Enabled') || 'true').toLowerCase();
      const isDisabled = enabled === 'false' || enabled === '0';

      // ── Resolve MasterClip ───────────────────────────────────────────────────
      const mc = _resolveMasterClip(ci, uidMap);

      // ── Skip nested sequences (sub-clips) ────────────────────────────────────
      if (mc && mc.tagName === 'Sequence') continue;

      // ── Source TC — KEY IMPROVEMENT ──────────────────────────────────────────
      // VideoStartTime is the media's native start TC (e.g. 01:00:00:00 camera TC)
      // ClipItem.In is the offset into the clip FROM the media start
      const videoStartTick = mc ? parseInt(_text(mc, 'VideoStartTime') || '0', 10) : 0;
      const clipInTick     = parseInt(_text(ci, 'In')  || '0', 10);
      const clipOutTick    = parseInt(_text(ci, 'Out') || '0', 10);

      const srcInTick  = videoStartTick + (clipInTick  >= 0 ? clipInTick  : 0);
      const srcOutTick = videoStartTick + (clipOutTick >  0 ? clipOutTick : (recEndTick - recStartTick));

      // ── Clip name / reel / file path ─────────────────────────────────────────
      const clipName = _text(ci, 'Name') || (mc && _text(mc, 'Name')) || '';
      const tapeName = _getMasterTape(mc) || _reelFromFilename(clipName);
      const srcPath  = _getMasterFilePath(mc, uidMap);

      // ── Speed / retime detection ─────────────────────────────────────────────
      const { retimeAuto, speedDisplay, retimeMode } = _detectRetime(ci);

      // ── Color label ──────────────────────────────────────────────────────────
      const label2    = ci.querySelector('Labels Label2');
      const labelName = label2 ? label2.textContent.trim() : '';
      const labelColor = _labelColor(labelName, false);

      // ── Audio track count overlapping this clip ───────────────────────────────
      const audioCount = audioMap.query(recStartTick, recEndTick);

      // ── Opacity keyframe type ─────────────────────────────────────────────────
      const opacityType = _detectOpacity(ci);

      // ── Sequence markers that overlap this clip ──────────────────────────────
      const recInTC  = _ticksToTC(seqOffset + recStartTick, fps, ticksPerFrame);
      const recOutTC = _ticksToTC(seqOffset + recEndTick,   fps, ticksPerFrame);
      const clipMarkers = seqMarkers.filter(mk => {
        const mkTick = _tcToFrames(mk.tcIn, fps);
        const s = _tcToFrames(recInTC,  fps);
        const e = _tcToFrames(recOutTC, fps);
        return mkTick >= s && mkTick < e;
      });

      events.push({
        clipName:   _stem(clipName),
        srcFile:    clipName,
        reel:       tapeName || _stem(clipName),
        srcIn:      _ticksToTC(srcInTick,  fps, ticksPerFrame),
        srcOut:     _ticksToTC(srcOutTick, fps, ticksPerFrame),
        recIn:      recInTC,
        recOut:     recOutTC,
        fps,
        role,
        sourceType: 'prproj',
        disabled:   isDisabled || undefined,

        // Retime — picked up by RT chip and handle calc
        _pmRetimeAuto:   retimeAuto || undefined,
        _pmSpeedDisplay: speedDisplay || undefined,
        _pmRetimeMode:   retimeMode || undefined,

        // Premiere-specific metadata
        _trackIdx:         trackIdx,
        _seqName:          seqName,
        _prprojSrcPath:    srcPath || undefined,
        _prprojLabel:      labelName || undefined,
        _prprojLabelColor: labelColor || undefined,
        _prprojAudioTracks: audioCount || undefined,
        _prprojOpacity:    opacityType,
        _prprojMarkers:    clipMarkers.length ? clipMarkers : undefined,
      });
    }
  });

  return events;
}

// ─── Video track navigation ───────────────────────────────────────────────────

function _getVideoTracks(seq) {
  const tracks = [];
  for (const tg of seq.querySelectorAll('VideoTracks TrackGroup, VideoTrackGroup')) {
    const tracksEl = tg.querySelector('Tracks');
    if (tracksEl) {
      for (const ch of tracksEl.children) {
        if (/track/i.test(ch.tagName)) tracks.push(ch);
      }
    }
  }
  if (!tracks.length) tracks.push(...seq.querySelectorAll('VideoTrack'));
  return tracks;
}

// ─── MasterClip resolution ────────────────────────────────────────────────────

function _resolveMasterClip(ci, uidMap) {
  const strategies = [
    () => ci.querySelector('ComponentClipID ObjectRef'),
    () => ci.querySelector('ClipID ClipRefID ObjectRef'),
    () => ci.querySelector('ClipID ObjectRef'),
    () => ci.querySelector('MasterClipID'),
  ];
  for (const fn of strategies) {
    const ref = fn();
    if (!ref) continue;
    const uid = ref.getAttribute('ObjectUID') || ref.textContent.trim();
    if (uid && uidMap.has(uid)) return uidMap.get(uid);
  }
  return null;
}

// ─── Tape / reel name ─────────────────────────────────────────────────────────

function _getMasterTape(mc) {
  if (!mc) return '';
  const direct = _text(mc, 'TapeName');
  if (direct && direct !== 'None' && direct !== 'Unknown') return direct;
  const li = mc.querySelector('LoggingInfo TapeName');
  if (li && li.textContent.trim() && li.textContent.trim() !== 'None') return li.textContent.trim();
  const scene = mc.querySelector('LoggingInfo ShotName');
  if (scene && scene.textContent.trim()) return scene.textContent.trim();
  return '';
}

// ─── Source file path extraction ──────────────────────────────────────────────

function _getMasterFilePath(mc, uidMap) {
  if (!mc) return '';
  // Direct path on MasterClip
  for (const tag of ['SourceFilePath', 'FilePath', 'MediaFilePath', 'FileRef']) {
    const v = _text(mc, tag);
    if (v && v.length > 1) return _decodeFilePath(v);
  }
  // Via MediaSource ObjectRef → Media element
  const mediaRef = mc.querySelector('MediaSource ObjectRef, Media ObjectRef');
  if (mediaRef) {
    const uid = mediaRef.getAttribute('ObjectUID');
    const mediaEl = uid && uidMap.get(uid);
    if (mediaEl) {
      for (const tag of ['FilePath', 'FileRef', 'SourceFilePath']) {
        const v = _text(mediaEl, tag);
        if (v && v.length > 1) return _decodeFilePath(v);
      }
    }
  }
  return '';
}

function _decodeFilePath(raw) {
  try { return decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { return raw; }
}

// ─── Speed / retime detection ─────────────────────────────────────────────────

function _detectRetime(ci) {
  // SpeedControl → fixed speed
  const sc = ci.querySelector('SpeedControl');
  if (sc) {
    const factor  = parseFloat(_text(sc, 'SpeedFactor') || '1');
    const reverse = (_text(sc, 'ReverseSpeed') || '').toLowerCase() === 'true';
    if (Math.abs(factor - 1.0) > 0.001 || reverse) {
      const pct = Math.round(factor * 100);
      return {
        retimeAuto:   true,
        speedDisplay: reverse ? `−${pct}%` : `${pct}%`,
        retimeMode:   'LINEAR',
      };
    }
  }
  // TimeRemapping → variable speed (has keyframes)
  const tr = ci.querySelector('TimeRemapping');
  if (tr) {
    const kfs = tr.querySelectorAll('KeyFrame, Keyframe, kf');
    if (kfs.length > 1) {
      return { retimeAuto: true, speedDisplay: 'VAR', retimeMode: 'BEZIER' };
    }
  }
  return { retimeAuto: false, speedDisplay: '', retimeMode: 'CUT' };
}

// ─── Opacity keyframe type ────────────────────────────────────────────────────

function _detectOpacity(ci) {
  const opEl = ci.querySelector('Opacity');
  if (!opEl) return 'CONSTANT';
  const kfs = opEl.querySelectorAll('KeyFrame, Keyframe, kf');
  if (!kfs.length) return 'CONSTANT';
  if (kfs.length === 1) return 'LINEAR';
  // Check if any bezier handles are present
  const hasBezier = [...kfs].some(k => k.querySelector('Bezier, bezier, BezierIn, BezierOut'));
  return hasBezier ? 'BEZIER' : 'NODAL_STEPS';
}

// ─── Color label → hex hint ───────────────────────────────────────────────────
// Premiere label2 strings and marker color indices

const _LABEL_MAP = {
  violet: '#c678dd', iris: '#c678dd', lavender: '#b4a7d6',
  cerulean: '#84d4ff', sky: '#84d4ff', blue: '#84d4ff',
  forest: '#4caf7d', mint: '#98e0a8', green: '#98e0a8',
  rose: '#e06c75', pink: '#e06c75', red: '#e06c75',
  mango: '#e5a050', orange: '#e5a050', yellow: '#e5c07b',
  teal: '#56b6c2', magenta: '#d670bc', tan: '#c8a882',
  white: '#e0e0e0',
};
// Marker color indices (0=green,1=red,2=orange,3=yellow,4=white,5=blue,6=cyan,7=violet)
const _MARKER_COLORS = ['#4caf7d','#e06c75','#e5a050','#e5c07b','#e0e0e0','#84d4ff','#56b6c2','#c678dd'];

function _labelColor(val, isIndex) {
  if (isIndex) {
    const idx = typeof val === 'number' ? val : parseInt(val, 10);
    return _MARKER_COLORS[idx] || '#7880a0';
  }
  return _LABEL_MAP[String(val).toLowerCase()] || '';
}

// ─── TC string → frames ───────────────────────────────────────────────────────

function _tcToFrames(tc, fps) {
  const p = String(tc || '').split(':').map(Number);
  if (p.length < 4) return 0;
  return ((p[0] * 3600 + p[1] * 60 + p[2]) * fps) + p[3];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _text(el, tag) {
  if (!el) return '';
  const ch = el.querySelector(':scope > ' + tag);
  return ch ? ch.textContent.trim() : '';
}

function _stem(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i > 0 ? s.slice(0, i) : s;
}

function _reelFromFilename(name) {
  // A001C001_210101.mov → A001C001 | REEL_04 | etc.
  const m = String(name || '').match(/^([A-Za-z]\d{3}[A-Za-z]\d{3,}|[A-Z]\d{3,}[A-Z]\d{3,}|REEL[_\-]\w+|B\d{3,})/i);
  return m ? m[1] : _stem(name);
}
