// tl_convert/index.js — Timeline Convert toolbox feature.
// Export: EDL32, OTIO, FCPXML, FCPXMLD, FCP7 XML, AAF XML Metadata Preview (.aaf.xml), NLE Linked AAF (.aaf via helper), Pro Tools AAF (.aaf via helper)
// Import: .edl, .fcpxml, .fcpxmld, .xml, .otio/.otioz, .aaf, .ale, .prproj (via window.__MPS_parseFromFiles)
'use strict';

(function () {

  // ── Local state (independent of Pull Prep) ───────────────────────────────

  let _tlcLocalEvents      = null;  // null = no local import yet
  let _tlcLocalProjectName = '';
  let _tlcLocalFps         = 24;
  let _tlcSourceFileHandle = null; // FileSystemFileHandle from showOpenFilePicker/drag-drop

  // ── Helpers ──────────────────────────────────────────────────────────────

  function _activeRaw() {
    return window.__MPS_EDL_RAW || window.__PFX_TIMELINE_RAW || null;
  }

  function getEvents() {
    const raw = _activeRaw();
    return _tlcLocalEvents ?? (Array.isArray(raw?.events) ? raw.events : []);
  }

  function getProjectName() {
    const raw = _activeRaw();
    return _tlcLocalProjectName || raw?.projectName || window.__MPS_PROJECT_NAME || 'Timeline';
  }

  function getFps() {
    const raw = _activeRaw();
    const n = Number(_tlcLocalEvents ? _tlcLocalFps : raw?.fps) || _tlcLocalFps || 24;
    // Snap near-integer fps values (24, 25, 30, 50, 60) to exact integers so
    // _rateInfo never mis-classifies a true 24fps timeline as 23.976.
    for (const exact of [24, 25, 30, 50, 60]) {
      if (Math.abs(n - exact) < 0.02) return exact;
    }
    return n;
  }

  // reelMode: 'orig' | 'clip' | 'file'
  function safeReel(ev, reelMode) {
    let name;
    if (reelMode === 'clip') {
      name = ev.clipName || ev.clip || ev.name || ev.reel || 'CLIP';
    } else if (reelMode === 'file') {
      const raw = ev.srcFile || '';
      const base = raw.split(/[\\/]/).pop() || '';
      name = (base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base) || ev.reel || 'UNTITLED';
    } else {
      name = ev.reel || 'UNTITLED';
    }
    // strip file extension (handles reel/clip names that include .mov/.mp4 etc.)
    const dotIdx = name.lastIndexOf('.');
    if (dotIdx > 0) name = name.slice(0, dotIdx);
    // strip trailing version suffix (_v1 / __v1 / -v001 etc.) then leftover separators
    return name
      .replace(/[_\-]+v\d+$/i, '')
      .replace(/[_\-]+$/, '')
      .replace(/\s+/g, '_');
  }

  function xmlEsc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  function _htmlEsc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function tcToFrames(tc, fps) {
    fps = Math.max(1, Math.round(fps || 24));
    if (tc == null || tc === '') return 0;
    if (typeof tc === 'number' && Number.isFinite(tc)) return Math.max(0, Math.round(tc));
    const m = String(tc).trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[:;.](\d{2})$/);
    if (!m) return 0;
    const h = parseInt(m[1], 10) || 0;
    const mn = parseInt(m[2], 10) || 0;
    const sec = parseInt(m[3], 10) || 0;
    const f = parseInt(m[4], 10) || 0;
    return ((h * 3600 + mn * 60 + sec) * fps) + f;
  }

  function framesToTC(frames, fps, drop = false) {
    // Display timecode only. For conversion math we keep integer frames so cross-format
    // round trips do not drift. Drop-frame separator is preserved for NLEs that read it.
    fps = Math.max(1, Math.round(fps || 24));
    frames = Math.max(0, Math.round(frames || 0));
    const f = frames % fps;
    const totalSec = Math.floor(frames / fps);
    const sec = totalSec % 60;
    const min = Math.floor(totalSec / 60) % 60;
    const h = Math.floor(totalSec / 3600);
    const sep = drop ? ';' : ':';
    return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}${sep}${String(f).padStart(2,'0')}`;
  }

  function _isNtscRate(fps) {
    const n = Number(fps) || 24;
    return Math.abs(n - 23.976) < 0.02 || Math.abs(n - 29.97) < 0.02 || Math.abs(n - 59.94) < 0.02;
  }

  function _rateInfo(fps) {
    const n = Number(fps) || 24;
    if (Math.abs(n - 23.976) < 0.02 || Math.abs(n - 23.98) < 0.02) return { num: 24000, den: 1001, fpsInt: 24, ntsc: true };
    if (Math.abs(n - 29.97) < 0.02 || Math.abs(n - 29.976) < 0.02) return { num: 30000, den: 1001, fpsInt: 30, ntsc: true };
    if (Math.abs(n - 59.94) < 0.02) return { num: 60000, den: 1001, fpsInt: 60, ntsc: true };
    const r = Math.max(1, Math.round(n));
    return { num: r, den: 1, fpsInt: r, ntsc: false };
  }

  function fcpRational(fps) {
    const r = _rateInfo(fps);
    // FCPXML frameDuration is the duration of ONE frame in seconds.
    return `${r.den}/${r.num}s`;
  }

  function _fcpTime(frames, fps) {
    const r = _rateInfo(fps);
    const num = Math.max(0, Math.round(frames || 0)) * r.den;
    const den = r.num;
    const g = _gcd(num, den);
    return `${num / g}/${den / g}s`;
  }

  function _gcd(a, b) {
    a = Math.abs(a || 0); b = Math.abs(b || 1);
    while (b) { const t = b; b = a % b; a = t; }
    return a || 1;
  }

  function _eventType(ev) {
    const t = String(ev?.type || ev?.role || ev?.track || '').toLowerCase();
    if (/audio|sound|^a\d*/.test(t)) return 'audio';
    return 'video';
  }

  function _trackIndex(ev) {
    const raw = ev?.trackIndex ?? ev?.track;
    if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.round(raw));
    const m = String(raw || '').match(/[VA](\d+)/i);
    return m ? Math.max(0, parseInt(m[1], 10) - 1) : 0;
  }

  function _trackName(ev) {
    const kind = _eventType(ev) === 'audio' ? 'A' : 'V';
    return `${kind}${_trackIndex(ev) + 1}`;
  }

  function _srcInF(ev, fps) { return tcToFrames(ev?.srcIn || '00:00:00:00', fps); }
  function _srcOutF(ev, fps) { return tcToFrames(ev?.srcOut || ev?.srcIn || '00:00:00:00', fps); }
  function _recInF(ev, fps) { return tcToFrames(ev?.recIn || '00:00:00:00', fps); }
  function _recOutF(ev, fps) { return tcToFrames(ev?.recOut || ev?.recIn || '00:00:00:00', fps); }
  function _srcDurF(ev, fps) { return Math.max(1, _srcOutF(ev, fps) - _srcInF(ev, fps)); }
  function _recDurF(ev, fps) { return Math.max(1, _recOutF(ev, fps) - _recInF(ev, fps)); }

  function _sortedEvents(events, fps) {
    return Array.from(events || [])
      .filter(ev => ev && (ev.recIn || ev.recOut || ev.srcIn || ev.srcOut))
      .sort((a,b) => (_recInF(a,fps) - _recInF(b,fps)) || (_trackIndex(a) - _trackIndex(b)) || ((a.event||0) - (b.event||0)));
  }

  function _timelineBounds(events, fps) {
    const arr = _sortedEvents(events, fps);
    if (!arr.length) return { start: 0, end: 0, duration: 0 };
    const start = Math.min(...arr.map(ev => _recInF(ev, fps)));
    const end = Math.max(...arr.map(ev => _recOutF(ev, fps)));
    return { start, end, duration: Math.max(0, end - start) };
  }

  function _eventsByTrack(events, fps, kind = 'video') {
    const out = new Map();
    for (const ev of _sortedEvents(events, fps)) {
      if (_eventType(ev) !== kind) continue;
      const key = _trackIndex(ev);
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(ev);
    }
    return [...out.entries()].sort((a,b) => a[0] - b[0]);
  }

  function _cleanId(s) {
    return String(s || 'x').replace(/[^a-zA-Z0-9_\-:.]/g, '_');
  }

  function _sanitizeEdlReel(s, maxLen) {
    const x = String(s || 'REEL').trim().replace(/\.[^.\s]+$/,'').replace(/\s+/g,'_').replace(/[^A-Za-z0-9_\-.]/g,'_');
    return (x || 'REEL').slice(0, maxLen || 32);
  }

  // ── Export: EDL32 ────────────────────────────────────────────────────────

  // Resolve a speed percentage (100 = normal) from the various event fields.
  function _evSpeedPct(ev) {
    const norm = v => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : null; };
    return norm(ev.speed) ?? norm(ev.speedFactor) ?? norm(ev?.fx?.speed?.percent) ?? null;
  }

  function toEDL32(events, fps, reelParam) {
    // CMX-style EDL with 32-char reel safety by default. Enable Trim 8 for legacy
    // online rooms that still require strict 8-char reel/tape names.
    const opts = (reelParam && typeof reelParam === 'object') ? reelParam : {};
    const legacyMode = (typeof reelParam === 'string') ? reelParam : null;
    const r = _rateInfo(fps);
    const lines = [`TITLE: ${getProjectName()}`, `FCM: ${r.ntsc ? 'DROP FRAME' : 'NON-DROP FRAME'}`, ''];
    let cut = 1;
    for (const ev of _sortedEvents(events, fps)) {
      if (_eventType(ev) !== 'video') continue;
      const rawReel = legacyMode ? safeReel(ev, legacyMode) : (ev.reel || ev.clipName || 'REEL');
      const reel = _sanitizeEdlReel(rawReel, opts.trim8 ? 8 : 32);
      const srcIn  = ev.srcIn  || '00:00:00:00';
      const srcOut = ev.srcOut || ev.srcIn || '00:00:00:00';
      const recIn  = ev.recIn  || '00:00:00:00';
      const recOut = ev.recOut || ev.recIn || '00:00:00:00';
      const track = _structureMode === 'flat' ? 'V' : (_trackName(ev) === 'V1' ? 'V' : _trackName(ev));
      const trans = (ev.transition || 'C').toString().replace(/\s+/g, '');
      const reelCol = reel.padEnd(opts.trim8 ? 8 : Math.max(8, reel.length));
      lines.push(`${String(cut).padStart(3,'0')}  ${reelCol} ${track.padEnd(5)} ${trans.padEnd(8)} ${srcIn} ${srcOut} ${recIn} ${recOut}`);
      const clipLabel = (ev.clipName || ev.clip || ev.name || '').slice(0, 96);
      if (clipLabel) lines.push(`* FROM CLIP NAME: ${clipLabel}`);
      if (ev._originalReel) lines.push(`* ORIGINAL REEL: ${ev._originalReel}`);
      if (ev.srcFile) lines.push(`* SOURCE FILE: ${ev.srcFile}`);
      const sp = _evSpeedPct(ev);
      if (sp && Math.abs(sp - 100) > 0.01) lines.push(`* SPEED: ${sp}%`);
      const markers = ev.markers || ev._markers || [];
      for (const mk of markers) {
        const label = mk?.label || mk?.name || mk?.value || mk?.comment;
        const tc = mk?.tc || mk?.timecode || ev.recIn;
        if (label) lines.push(`* LOC: ${tc || recIn} ${mk?.color || 'GREEN'} ${label}`);
      }
      lines.push('');
      cut++;
    }
    return lines.join('\n');
  }

  // ── Export: OTIO ─────────────────────────────────────────────────────────

  function _otioRational(value, rate) {
    return { OTIO_SCHEMA: 'RationalTime.1', value, rate };
  }

  function _otioRange(start, dur, rate) {
    return { OTIO_SCHEMA: 'TimeRange.1', start_time: _otioRational(start, rate), duration: _otioRational(dur, rate) };
  }

  function _otioMediaRef(ev, fps, reel) {
    const srcUrl = ev.srcFile ? `file://${String(ev.srcFile).replace(/\\/g, '/')}` : `reel://${reel}`;
    const srcDur = Math.max(_srcOutF(ev, fps), _srcDurF(ev, fps));
    return {
      OTIO_SCHEMA: 'ExternalReference.1',
      target_url: srcUrl,
      available_range: _otioRange(0, Math.max(1, srcDur), fps),
      metadata: { PostFlowX: { reel, source_file: ev.srcFile || '' } },
    };
  }

  function _otioMarkers(ev, fps) {
    const out = [];
    const markers = ev.markers || ev._markers || [];
    for (const mk of markers) {
      const name = mk?.label || mk?.name || mk?.value || mk?.comment || 'Marker';
      const mf = Number.isFinite(Number(mk?.frame)) ? Number(mk.frame) : (mk?.tc ? tcToFrames(mk.tc, fps) : _recInF(ev, fps));
      out.push({
        OTIO_SCHEMA: 'Marker.2',
        name: String(name),
        color: String(mk?.color || 'GREEN').toUpperCase(),
        marked_range: _otioRange(Math.max(0, mf - _recInF(ev, fps)), 1, fps),
        metadata: { PostFlowX: mk || {} },
      });
    }
    return out;
  }

  function toOTIO(events, fps, useClipName) {
    const rate = Number(_rateInfo(fps).num) / Number(_rateInfo(fps).den);
    const bounds = _timelineBounds(events, fps);
    const children = [];

    for (const [idx, evs] of _eventsByTrack(events, fps, 'video')) {
      let cursor = bounds.start;
      const trackKids = [];
      for (const ev of evs) {
        const recIn = _recInF(ev, fps);
        const recDur = _recDurF(ev, fps);
        if (recIn > cursor) {
          trackKids.push({ OTIO_SCHEMA: 'Gap.1', name: 'Gap', source_range: _otioRange(0, recIn - cursor, rate) });
        }
        const srcIn = _srcInF(ev, fps);
        const srcDur = _srcDurF(ev, fps);
        const reel = safeReel(ev, useClipName);
        const clip = {
          OTIO_SCHEMA: 'Clip.2',
          name: ev.clipName || ev.clip || ev.name || reel || `Clip ${trackKids.length + 1}`,
          source_range: _otioRange(srcIn, recDur, rate),
          media_reference: _otioMediaRef(ev, fps, reel),
          metadata: {
            PostFlowX: {
              reel, track: `V${idx + 1}`,
              srcIn: ev.srcIn || '', srcOut: ev.srcOut || '', recIn: ev.recIn || '', recOut: ev.recOut || '',
              original_reel: ev._originalReel || '', source_type: ev.sourceType || '', source_file: ev.srcFile || '',
            }
          },
        };
        const sp = _evSpeedPct(ev);
        if (sp && Math.abs(sp - 100) > 0.01) {
          clip.effects = [{ OTIO_SCHEMA: 'LinearTimeWarp.1', name: `Speed ${sp}%`, time_scalar: sp / 100 }];
          clip.metadata.PostFlowX.speed_percent = sp;
          // Keep full source duration in metadata so a conform system can choose its own retime policy.
          clip.metadata.PostFlowX.source_duration_frames = srcDur;
        }
        const mks = _otioMarkers(ev, fps);
        if (mks.length) clip.markers = mks;
        trackKids.push(clip);
        cursor = Math.max(cursor, recIn + recDur);
      }
      children.push({ OTIO_SCHEMA: 'Track.1', name: `V${idx + 1}`, kind: 'Video', children: trackKids });
    }

    return JSON.stringify({
      OTIO_SCHEMA: 'Timeline.1',
      name: getProjectName(),
      global_start_time: _otioRational(bounds.start, rate),
      tracks: { OTIO_SCHEMA: 'Stack.1', name: 'tracks', children },
      metadata: { PostFlowX: { source: 'Timeline Convert', structure: _structureMode, fps } },
    }, null, 2);
  }

  // ── Export: FCPXML ───────────────────────────────────────────────────────

  function _assetKey(ev, reel) {
    return _cleanId(reel || ev.srcFile || ev.clipName || ev.reel || 'asset');
  }

  function _fcpxMarkerXml(ev, fps, baseRecInF) {
    const out = [];
    const markers = ev.markers || ev._markers || [];
    for (const mk of markers) {
      const label = xmlEsc(mk?.label || mk?.name || mk?.value || mk?.comment || 'Marker');
      const mf = Number.isFinite(Number(mk?.frame)) ? Number(mk.frame) : (mk?.tc ? tcToFrames(mk.tc, fps) : baseRecInF);
      const localF = Math.max(0, mf - baseRecInF);
      out.push(`                <marker start="${_fcpTime(localF, fps)}" value="${label}"/>`);
    }
    return out;
  }

  function _isDropFrameCapable(fps) {
    const n = Number(fps) || 24;
    return Math.abs(n - 29.97) < 0.02 || Math.abs(n - 59.94) < 0.02;
  }

  function _hasDropFrameTC(events) {
    return (events || []).some(ev =>
      /;/.test(String(ev.recIn || ev.recOut || ev.srcIn || ev.srcOut || ''))
    );
  }

  function _fcpTcFormat(events, fps) {
    return (_isDropFrameCapable(fps) && _hasDropFrameTC(events)) ? 'DF' : 'NDF';
  }

  function _aafDropFrame(events, fps) {
    return _isDropFrameCapable(fps) && _hasDropFrameTC(events);
  }

  function _fileUrl(pathOrName) {
    const raw = String(pathOrName || '').replace(/\\/g, '/');
    if (!raw) return '';
    if (/^[a-zA-Z]:\//.test(raw)) return 'file:///' + encodeURI(raw);
    if (raw.startsWith('/')) return 'file://' + encodeURI(raw);
    return 'file://localhost/Offline/' + encodeURIComponent(raw);
  }

  function toFCPXML(events, fps, useClipName, version = '1.10') {
    const r = _rateInfo(fps);
    const fpsInt = r.fpsInt;
    const tcFormat = _fcpTcFormat(events, fps);
    const projName = xmlEsc(getProjectName());
    const bounds = _timelineBounds(events, fps);
    const L = [];
    L.push(`<?xml version="1.0" encoding="UTF-8"?>`);
    L.push(`<!DOCTYPE fcpxml>`);
    L.push(`<fcpxml version="${version}">`);
    L.push(`  <resources>`);
    L.push(`    <format id="r1" name="FFVideoFormat${fpsInt}p" frameDuration="${fcpRational(fps)}" width="1920" height="1080"/>`);

    // Build per-asset source bounds (min srcIn, max srcOut) across all clips sharing that asset.
    const assetBounds = new Map(); // key → { minSrcIn, maxSrcOut, src, name }
    for (const ev of _sortedEvents(events, fps)) {
      if (_eventType(ev) !== 'video') continue;
      const reel = safeReel(ev, useClipName);
      const key = _assetKey(ev, reel);
      const srcIn  = _srcInF(ev, fps);
      const srcOut = _srcOutF(ev, fps);
      const src = ev.srcFile ? _fileUrl(ev.srcFile) : _fileUrl(reel);
      if (!assetBounds.has(key)) {
        assetBounds.set(key, { minSrcIn: srcIn, maxSrcOut: srcOut, src, name: reel });
      } else {
        const b = assetBounds.get(key);
        b.minSrcIn  = Math.min(b.minSrcIn, srcIn);
        b.maxSrcOut = Math.max(b.maxSrcOut, srcOut);
      }
    }

    const assets = new Map(); // key → id
    let aid = 2;
    for (const [key, b] of assetBounds) {
      const id = `r${aid++}`;
      assets.set(key, id);
      const assetDur = Math.max(1, b.maxSrcOut - b.minSrcIn);
      L.push(`    <asset id="${id}" name="${xmlEsc(b.name)}" src="${xmlEsc(b.src)}" start="${_fcpTime(b.minSrcIn, fps)}" duration="${_fcpTime(assetDur, fps)}" hasVideo="1" format="r1"/>`);
    }
    L.push(`  </resources>`);
    L.push(`  <library>`);
    L.push(`    <event name="${projName}">`);
    L.push(`      <project name="${projName}">`);
    L.push(`        <sequence duration="${_fcpTime(bounds.duration || 1, fps)}" format="r1" tcStart="${_fcpTime(bounds.start, fps)}" tcFormat="${tcFormat}" audioLayout="stereo" audioRate="48k">`);
    L.push(`          <spine>`);

    const tracks = _eventsByTrack(events, fps, 'video');
    const v1 = (tracks.find(([idx]) => idx === 0) || [0, []])[1];
    let cursor = bounds.start;
    let gapId = 1;
    for (const ev of v1) {
      const recIn  = _recInF(ev, fps);
      const recDur = _recDurF(ev, fps);
      if (recIn > cursor) {
        L.push(`            <gap name="Gap" offset="${_fcpTime(cursor - bounds.start, fps)}" duration="${_fcpTime(recIn - cursor, fps)}"/>`);
      }
      const reel   = safeReel(ev, useClipName);
      const id     = assets.get(_assetKey(ev, reel));
      const clipN  = xmlEsc(ev.clipName || ev.clip || ev.name || reel);
      const srcInF = _srcInF(ev, fps);
      L.push(`            <asset-clip ref="${id}" name="${clipN}" offset="${_fcpTime(recIn - bounds.start, fps)}" start="${_fcpTime(srcInF, fps)}" duration="${_fcpTime(recDur, fps)}" tcFormat="${tcFormat}">`);
      L.push(..._fcpxMarkerXml(ev, fps, recIn));
      L.push(`            </asset-clip>`);
      cursor = Math.max(cursor, recIn + recDur);
    }
    if (cursor < bounds.end) {
      L.push(`            <gap name="Gap ${gapId++}" offset="${_fcpTime(cursor - bounds.start, fps)}" duration="${_fcpTime(bounds.end - cursor, fps)}"/>`);
    }

    // Higher video tracks are emitted as lane clips with explicit timeline offsets.
    for (const [idx, evs] of tracks) {
      if (idx === 0) continue;
      for (const ev of evs) {
        const reel   = safeReel(ev, useClipName);
        const id     = assets.get(_assetKey(ev, reel));
        const clipN  = xmlEsc(ev.clipName || ev.clip || ev.name || reel);
        const recIn  = _recInF(ev, fps);
        const recDur = _recDurF(ev, fps);
        const srcInF = _srcInF(ev, fps);
        L.push(`            <asset-clip ref="${id}" name="${clipN}" lane="${idx + 1}" offset="${_fcpTime(recIn - bounds.start, fps)}" start="${_fcpTime(srcInF, fps)}" duration="${_fcpTime(recDur, fps)}" tcFormat="${tcFormat}">`);
        L.push(..._fcpxMarkerXml(ev, fps, recIn));
        L.push(`            </asset-clip>`);
      }
    }

    L.push(`          </spine>`);
    L.push(`        </sequence>`);
    L.push(`      </project>`);
    L.push(`    </event>`);
    L.push(`  </library>`);
    L.push(`</fcpxml>`);
    return L.join('\n');
  }

  function toFCPXMLD(events, fps, useClipName) { return toFCPXML(events, fps, useClipName, '1.10'); }

  // ── Export: AAF (AAFXML interchange profile) ─────────────────────────────
  // This browser-only export writes standards-shaped AAFXML metadata. True binary
  // Pro Tools AAF with embedded/consolidated audio must be produced by the native
  // helper/AAF SDK because Chrome cannot author OLE Structured Storage AAF safely.

  function _umid() {
    const h = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
    return `urn:smpte:umid:060a2b34.01010101.01010f00.13000000.${h()}.${h()}.${h()}.${h()}`;
  }

  function _uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random()*16|0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function toAAFXMLMetadata(events, fps, useClipName, profile = 'xml_metadata') {
    const r = _rateInfo(fps);
    const fpsInt = r.fpsInt;
    const drop = _aafDropFrame(events, fps);
    const projName = xmlEsc(getProjectName());
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
    const validEvs = _sortedEvents(events, fps).filter(e => _eventType(e) === 'video');
    const bounds = _timelineBounds(validEvs, fps);

    const mobs = validEvs.map(ev => ({ ev, masterMobID: _umid(), srcMobID: _umid() }));
    const compMobID = _umid();
    const compositionName = profile === 'protools_audio'
      ? `${projName}_ProTools_AAFXMLMetadata`
      : projName;

    const L = [];
    L.push(`<?xml version="1.0" encoding="utf-8"?>`);
    L.push(`<!-- PostFlowX AAFXML metadata-preview — real binary .aaf requires PostFlowX Native Helper -->`);
    L.push(`<aaf:AAF xmlns:aaf="http://www.aafassociation.org/aafxml/1.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`);
    L.push(`  <aaf:Header>`);
    L.push(`    <aaf:ByteOrder>KLVLittleEndian</aaf:ByteOrder>`);
    L.push(`    <aaf:LastModified>${now}</aaf:LastModified>`);
    L.push(`    <aaf:Version aaf:major="1" aaf:minor="1"/>`);
    L.push(`    <aaf:ObjectModelVersion>1</aaf:ObjectModelVersion>`);
    L.push(`  </aaf:Header>`);
    L.push(`  <aaf:Preface>`);
    L.push(`    <aaf:LastModified>${now}</aaf:LastModified>`);
    L.push(`    <aaf:Version aaf:major="1" aaf:minor="1"/>`);
    L.push(`    <aaf:OperationalPattern>urn:smpte:ul:060e2b34.04010101.0d010201.01010100</aaf:OperationalPattern>`);
    L.push(`    <aaf:Identifications>`);
    L.push(`      <aaf:Identification>`);
    L.push(`        <aaf:CompanyName>PostFlowX</aaf:CompanyName>`);
    L.push(`        <aaf:ProductName>PostFlowX Timeline Convert</aaf:ProductName>`);
    L.push(`        <aaf:ProductVersionString>3.1</aaf:ProductVersionString>`);
    L.push(`        <aaf:ProductID>urn:uuid:6ba7b810-9dad-11d1-80b4-00c04fd430c8</aaf:ProductID>`);
    L.push(`        <aaf:Date>${now}</aaf:Date>`);
    L.push(`        <aaf:ToolkitVersion aaf:major="1" aaf:minor="1" aaf:tertiary="0" aaf:patchLevel="0" aaf:buildType="Release"/>`);
    L.push(`        <aaf:Platform>PostFlowX/Chrome</aaf:Platform>`);
    L.push(`        <aaf:GenerationAUID>urn:uuid:${_uuid()}</aaf:GenerationAUID>`);
    L.push(`      </aaf:Identification>`);
    L.push(`    </aaf:Identifications>`);
    L.push(`    <aaf:ContentStorage>`);
    L.push(`      <aaf:Mobs>`);

    // Top-level CompositionMob: TC1 primary timecode + V1 picture track only.
    // No fake filler audio slots — real audio requires native helper.
    L.push(`        <aaf:CompositionMob>`);
    L.push(`          <aaf:MobID>${compMobID}</aaf:MobID>`);
    L.push(`          <aaf:Name>${compositionName}</aaf:Name>`);
    L.push(`          <aaf:UsageCode>Usage_TopLevel</aaf:UsageCode>`);
    L.push(`          <aaf:LastModified>${now}</aaf:LastModified>`);
    L.push(`          <aaf:CreationTime>${now}</aaf:CreationTime>`);
    L.push(`          <aaf:Slots>`);

    // Primary timecode track.
    L.push(`            <aaf:TimelineMobSlot>`);
    L.push(`              <aaf:SlotID>100</aaf:SlotID>`);
    L.push(`              <aaf:SlotName>TC1</aaf:SlotName>`);
    L.push(`              <aaf:PhysicalTrackNumber>1</aaf:PhysicalTrackNumber>`);
    L.push(`              <aaf:EditRate>${r.num}/${r.den}</aaf:EditRate>`);
    L.push(`              <aaf:Origin>0</aaf:Origin>`);
    L.push(`              <aaf:Segment><aaf:Timecode><aaf:DataDefinition>Timecode</aaf:DataDefinition><aaf:Length>${bounds.duration}</aaf:Length><aaf:Start>${bounds.start}</aaf:Start><aaf:FPS>${fpsInt}</aaf:FPS><aaf:Drop>${drop}</aaf:Drop></aaf:Timecode></aaf:Segment>`);
    L.push(`            </aaf:TimelineMobSlot>`);

    // Video sequence track (V1).
    L.push(`            <aaf:TimelineMobSlot>`);
    L.push(`              <aaf:SlotID>1</aaf:SlotID>`);
    L.push(`              <aaf:SlotName>V1</aaf:SlotName>`);
    L.push(`              <aaf:PhysicalTrackNumber>1</aaf:PhysicalTrackNumber>`);
    L.push(`              <aaf:EditRate>${r.num}/${r.den}</aaf:EditRate>`);
    L.push(`              <aaf:Origin>0</aaf:Origin>`);
    L.push(`              <aaf:Segment>`);
    L.push(`                <aaf:Sequence>`);
    L.push(`                  <aaf:DataDefinition>Picture</aaf:DataDefinition>`);
    L.push(`                  <aaf:Length>${bounds.duration}</aaf:Length>`);
    L.push(`                  <aaf:Components>`);
    let cursor = bounds.start;
    for (const { ev, masterMobID } of mobs) {
      const recIn  = _recInF(ev, fps);
      const recDur = _recDurF(ev, fps);
      if (recIn > cursor) {
        L.push(`                    <aaf:Filler><aaf:DataDefinition>Picture</aaf:DataDefinition><aaf:Length>${recIn - cursor}</aaf:Length></aaf:Filler>`);
      }
      L.push(`                    <aaf:SourceClip>`);
      L.push(`                      <aaf:DataDefinition>Picture</aaf:DataDefinition>`);
      L.push(`                      <aaf:Length>${recDur}</aaf:Length>`);
      L.push(`                      <aaf:StartPosition>${_srcInF(ev, fps)}</aaf:StartPosition>`);
      L.push(`                      <aaf:SourceMobID>${masterMobID}</aaf:SourceMobID>`);
      L.push(`                      <aaf:SourceMobSlotID>1</aaf:SourceMobSlotID>`);
      L.push(`                    </aaf:SourceClip>`);
      cursor = Math.max(cursor, recIn + recDur);
    }
    if (cursor < bounds.end) {
      L.push(`                    <aaf:Filler><aaf:DataDefinition>Picture</aaf:DataDefinition><aaf:Length>${bounds.end - cursor}</aaf:Length></aaf:Filler>`);
    }
    L.push(`                  </aaf:Components>`);
    L.push(`                </aaf:Sequence>`);
    L.push(`              </aaf:Segment>`);
    L.push(`            </aaf:TimelineMobSlot>`);

    L.push(`          </aaf:Slots>`);
    L.push(`          <aaf:UserComments>`);
    L.push(`            <aaf:TaggedValue><aaf:Name>PostFlowX_AAF_Profile</aaf:Name><aaf:Value>${profile}</aaf:Value></aaf:TaggedValue>`);
    L.push(`            <aaf:TaggedValue><aaf:Name>PostFlowX_Note</aaf:Name><aaf:Value>AAFXML metadata-preview only. Binary .aaf requires PostFlowX Native Helper.</aaf:Value></aaf:TaggedValue>`);
    L.push(`          </aaf:UserComments>`);
    L.push(`        </aaf:CompositionMob>`);

    // MasterMob + SourceMob per clip.
    for (const { ev, masterMobID, srcMobID } of mobs) {
      const reel   = safeReel(ev, useClipName);
      const clipN  = xmlEsc(ev.clipName || ev.clip || ev.name || reel);
      const reelX  = xmlEsc(reel);
      const lenF   = _srcDurF(ev, fps);
      const srcInF = _srcInF(ev, fps);
      const locUrl = ev.srcFile ? _fileUrl(ev.srcFile) : '';

      L.push(`        <aaf:MasterMob>`);
      L.push(`          <aaf:MobID>${masterMobID}</aaf:MobID>`);
      L.push(`          <aaf:Name>${clipN}</aaf:Name>`);
      L.push(`          <aaf:Slots><aaf:TimelineMobSlot><aaf:SlotID>1</aaf:SlotID><aaf:SlotName>V1</aaf:SlotName><aaf:EditRate>${r.num}/${r.den}</aaf:EditRate><aaf:Segment><aaf:SourceClip><aaf:DataDefinition>Picture</aaf:DataDefinition><aaf:Length>${lenF}</aaf:Length><aaf:StartPosition>${srcInF}</aaf:StartPosition><aaf:SourceMobID>${srcMobID}</aaf:SourceMobID><aaf:SourceMobSlotID>1</aaf:SourceMobSlotID></aaf:SourceClip></aaf:Segment></aaf:TimelineMobSlot></aaf:Slots>`);
      L.push(`        </aaf:MasterMob>`);

      L.push(`        <aaf:SourceMob>`);
      L.push(`          <aaf:MobID>${srcMobID}</aaf:MobID>`);
      L.push(`          <aaf:Name>${reelX}</aaf:Name>`);
      L.push(`          <aaf:Slots><aaf:TimelineMobSlot><aaf:SlotID>1</aaf:SlotID><aaf:SlotName>TC1</aaf:SlotName><aaf:EditRate>${r.num}/${r.den}</aaf:EditRate><aaf:Segment><aaf:Timecode><aaf:DataDefinition>Timecode</aaf:DataDefinition><aaf:Length>${lenF}</aaf:Length><aaf:Start>${srcInF}</aaf:Start><aaf:FPS>${fpsInt}</aaf:FPS><aaf:Drop>${drop}</aaf:Drop></aaf:Timecode></aaf:Segment></aaf:TimelineMobSlot></aaf:Slots>`);
      if (locUrl) {
        L.push(`          <aaf:EssenceDescription><aaf:ImportDescriptor><aaf:SampleRate>${r.num}/${r.den}</aaf:SampleRate><aaf:Length>${lenF}</aaf:Length><aaf:Locators><aaf:NetworkLocator><aaf:URLString>${xmlEsc(locUrl)}</aaf:URLString></aaf:NetworkLocator></aaf:Locators></aaf:ImportDescriptor></aaf:EssenceDescription>`);
      } else {
        L.push(`          <aaf:EssenceDescription><aaf:TapeDescriptor><aaf:SampleRate>${r.num}/${r.den}</aaf:SampleRate><aaf:Length>${lenF}</aaf:Length><aaf:TapeName>${reelX}</aaf:TapeName></aaf:TapeDescriptor></aaf:EssenceDescription>`);
      }
      L.push(`        </aaf:SourceMob>`);
    }

    L.push(`      </aaf:Mobs>`);
    L.push(`    </aaf:ContentStorage>`);
    L.push(`  </aaf:Preface>`);
    L.push(`</aaf:AAF>`);
    return L.join('\n');
  }

  // ── Export: AAF XML Metadata Preview (.aaf.xml) ──────────────────────────
  // Clearly marked as NOT real AAF. For inspection / debugging only.

  function toAAFMetadataPreview(events, fps) {
    const drop    = _aafDropFrame(events, fps);
    const proj    = xmlEsc(getProjectName());
    const now     = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
    const bounds  = _timelineBounds(events, fps);
    const startTC = xmlEsc(framesToTC(bounds.start, fps, drop));
    const sorted  = _sortedEvents(events, fps);
    const L = [];
    L.push(`<?xml version="1.0" encoding="UTF-8"?>`);
    L.push(`<AAFMetadataPreview generatedBy="PostFlowX" realAAF="false" project="${proj}" fps="${fps}" dropFrame="${drop}" timelineStart="${startTC}" generated="${now}">`);
    for (const ev of sorted) {
      const reel    = xmlEsc(ev.reel || 'UNTITLED');
      const clipN   = xmlEsc(ev.clipName || ev.clip || ev.name || reel);
      const recIn   = xmlEsc(ev.recIn   || '');
      const recOut  = xmlEsc(ev.recOut  || '');
      const srcIn   = xmlEsc(ev.srcIn   || '');
      const srcOut  = xmlEsc(ev.srcOut  || '');
      const srcFile = xmlEsc(ev.srcFile || '');
      const track   = xmlEsc(_trackName(ev));
      const type    = xmlEsc(ev.type || _eventType(ev));
      L.push(`  <Event clipName="${clipN}" reel="${reel}" recIn="${recIn}" recOut="${recOut}" srcIn="${srcIn}" srcOut="${srcOut}" srcFile="${srcFile}" track="${track}" type="${type}"/>`);
    }
    L.push(`</AAFMetadataPreview>`);
    return L.join('\n');
  }

  // ── Native AAF export (real binary .aaf via PostFlowX Native Helper) ─────

  async function exportAAFNative(profile) {
    // Pre-flight: helper must be checked and ready
    if (!_aafHelperStatus.checked || !_aafHelperStatus.available) {
      _setExportStatus('PostFlowX Native Helper is not available. Open the panel and click Check.', false);
      return;
    }
    if (!_aafHelperStatus.aafWriter) {
      _setExportStatus('AAF Writer (pyaaf2) is not installed in the Native Helper. Run: pip install pyaaf2', false);
      return;
    }
    if (profile === 'protools_audio' && !_aafHelperStatus.ffmpeg) {
      _setExportStatus('Pro Tools AAF requires ffmpeg. Install ffmpeg and restart the Native Helper.', false);
      return;
    }

    const events = _getTransformedEvents();
    const fps    = getFps();
    const proj   = (getProjectName() || 'timeline').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const drop   = _aafDropFrame(events, fps);
    const bounds = _timelineBounds(events, fps);
    const isNLE  = profile === 'nle_linked';

    const action = isNLE ? 'exportNLELinkedAAF' : 'exportProToolsAAF';

    const payload = {
      action,
      projectName: getProjectName(),
      fps,
      dropFrame: drop,
      timelineStartFrame: bounds.start,
      events: events
        .filter(ev => ev.recIn || ev.recOut)
        .map(ev => ({
          reel:       ev.reel       || '',
          clipName:   ev.clipName   || ev.clip || ev.name || '',
          srcIn:      ev.srcIn      || '',
          srcOut:     ev.srcOut     || '',
          recIn:      ev.recIn      || '',
          recOut:     ev.recOut     || '',
          srcFile:    ev.srcFile    || '',
          audioFile:  ev.audioFile  || '',
          audioPath:  ev.audioPath  || '',
          trackIndex: ev.trackIndex ?? 0,
          type:       ev.type       || '',
        })),
      options: isNLE ? {
        linkVideo:                   _aafOptions.nle.linkVideo,
        embedVideo:                  _aafOptions.nle.embedVideo,
        includeMarkers:              _aafOptions.nle.includeMarkers,
        includeTimecodeTrack:        _aafOptions.nle.includeTimecodeTrack,
        includeAudioTracksIfPresent: _aafOptions.nle.includeAudioTracksIfPresent,
        mediaRoots:                  [..._aafMediaRoots],
      } : {
        sampleRate:        _aafOptions.protools.sampleRate,
        bitDepth:          _aafOptions.protools.bitDepth,
        handlesFrames:     _aafOptions.protools.handlesFrames,
        embedAudio:        _aafOptions.protools.embedAudio,
        consolidateAudio:  _aafOptions.protools.consolidateAudio,
        splitMonoTracks:   _aafOptions.protools.splitMonoTracks,
        includeVideoGuide: _aafOptions.protools.includeVideoGuide,
        mediaRoots:        [..._aafAudioRoots],
      },
    };

    _setExportStatus('Sending to PostFlowX Native Helper…', null);

    try {
      const resp = await new Promise((resolve, reject) => {
        const guard = setTimeout(() => reject(new Error('Native Helper did not respond in time.')), 14000);
        chrome.runtime.sendMessage({ type: 'IMF_COMPANION_CALL', payload, timeoutMs: 13000 }, bridgeResp => {
          clearTimeout(guard);
          void chrome.runtime.lastError;
          if (!bridgeResp) { reject(new Error('No response from background bridge.')); return; }
          if (!bridgeResp.ok) { reject(new Error(bridgeResp.error?.message || bridgeResp.error?.userMessage || 'Native Helper error.')); return; }
          resolve(bridgeResp.response || {});
        });
      });

      // Error response
      if (resp?.status === 'error' || resp?.ok === false) {
        const err  = (resp?.error && typeof resp.error === 'object') ? resp.error : {};
        const code = err.code || resp?.code || 'UNKNOWN';
        const msg  = err.userMessage || err.message || resp?.message || 'Native helper error.';

        if (code === 'AAF_MISSING_AUDIO_MEDIA') {
          const missing = Array.isArray(resp?.data?.missing) ? resp.data.missing.slice(0, 10) : [];
          const detail  = missing.length
            ? '\n' + missing.map(m => '• ' + (m.reel || m.clipName || m.expected || 'unknown')).join('\n')
            : '';
          _setExportStatus('Pro Tools AAF blocked: missing source audio/media paths.' + detail, false);
        } else if (code === 'AAF_WRITER_MISSING') {
          _setExportStatus('Real AAF export requires AAF SDK or pyaaf2 support in the Native Helper.', false);
        } else if (code === 'FFMPEG_MISSING') {
          _setExportStatus('Pro Tools AAF requires ffmpeg for audio consolidation.', false);
        } else {
          _setExportStatus(msg, false);
        }
        return;
      }

      // Success — data can be in resp.data (legacy) or resp.result (v1)
      const data        = (resp?.data && typeof resp.data === 'object') ? resp.data
                        : (resp?.result && typeof resp.result === 'object') ? resp.result
                        : {};
      const bytesBase64 = data.bytesBase64 || data.base64 || resp?.base64 || resp?.bytesBase64;

      if (!bytesBase64) {
        _setExportStatus('Native helper returned no AAF data.', false);
        return;
      }

      const bytes = Uint8Array.from(atob(bytesBase64), c => c.charCodeAt(0));

      if (bytes.length === 0) {
        _setExportStatus('Native helper returned an empty AAF file.', false);
        return;
      }

      // Must not look like XML
      const head = String.fromCharCode(...bytes.slice(0, 5));
      if (head.startsWith('<?xml') || head.startsWith('<')) {
        _setExportStatus('Native helper returned XML instead of binary AAF. Export blocked.', false);
        return;
      }

      const filename = profile === 'nle_linked'
        ? `${proj}_pfx_nle_linked.aaf`
        : `${proj}_pfx_protools_audio.aaf`;

      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);

      const successMsg = profile === 'nle_linked'
        ? 'AAF / NLE Linked AAF exported.'
        : 'Pro Tools Audio AAF exported with embedded/consolidated audio.';
      _setExportStatus(successMsg, true);
    } catch (err) {
      _setExportStatus('Native helper failed: ' + err.message, false);
    }
  }

  // ── Export: FCP7 XML ─────────────────────────────────────────────────────

  function toFCP7XML(events, fps, useClipName) {
    const r = _rateInfo(fps);
    const fpsInt = r.fpsInt;
    const ntsc = r.ntsc ? 'TRUE' : 'FALSE';
    const projName = xmlEsc(getProjectName());
    const bounds = _timelineBounds(events, fps);
    const L = [];
    L.push(`<?xml version="1.0" encoding="UTF-8"?>`);
    L.push(`<!DOCTYPE xmeml>`);
    L.push(`<xmeml version="4">`);
    L.push(`  <sequence id="sequence-1">`);
    L.push(`    <name>${projName}</name>`);
    L.push(`    <duration>${bounds.duration}</duration>`);
    L.push(`    <rate><timebase>${fpsInt}</timebase><ntsc>${ntsc}</ntsc></rate>`);
    L.push(`    <timecode><rate><timebase>${fpsInt}</timebase><ntsc>${ntsc}</ntsc></rate><string>${framesToTC(bounds.start, fps, r.ntsc)}</string><frame>${bounds.start}</frame><displayformat>${r.ntsc ? 'DF' : 'NDF'}</displayformat></timecode>`);
    L.push(`    <media>`);
    L.push(`      <video>`);
    L.push(`        <format><samplecharacteristics><rate><timebase>${fpsInt}</timebase><ntsc>${ntsc}</ntsc></rate><width>1920</width><height>1080</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>`);

    let ci = 1;
    const fileIds = new Map();
    for (const [idx, evs] of _eventsByTrack(events, fps, 'video')) {
      L.push(`        <track>`);
      for (const ev of evs) {
        const reel = safeReel(ev, useClipName);
        const clipN = xmlEsc(ev.clipName || ev.clip || ev.name || reel);
        const key = _assetKey(ev, reel);
        let fid = fileIds.get(key);
        if (!fid) { fid = `file-${fileIds.size + 1}`; fileIds.set(key, fid); }
        const srcInF = _srcInF(ev, fps);
        const srcOutF = _srcOutF(ev, fps);
        const recInF = _recInF(ev, fps) - bounds.start;
        const recOutF = _recOutF(ev, fps) - bounds.start;
        const pathurl = ev.srcFile ? `file://${String(ev.srcFile).replace(/\\/g, '/')}` : `file:///media/${encodeURIComponent(reel)}`;
        L.push(`          <clipitem id="clipitem-${ci++}">`);
        L.push(`            <name>${clipN}</name>`);
        L.push(`            <enabled>TRUE</enabled>`);
        L.push(`            <rate><timebase>${fpsInt}</timebase><ntsc>${ntsc}</ntsc></rate>`);
        L.push(`            <start>${recInF}</start><end>${recOutF}</end>`);
        L.push(`            <in>${srcInF}</in><out>${srcOutF}</out>`);
        L.push(`            <file id="${fid}">`);
        L.push(`              <name>${xmlEsc(reel)}</name>`);
        L.push(`              <pathurl>${xmlEsc(pathurl)}</pathurl>`);
        L.push(`              <rate><timebase>${fpsInt}</timebase><ntsc>${ntsc}</ntsc></rate>`);
        L.push(`              <timecode><rate><timebase>${fpsInt}</timebase><ntsc>${ntsc}</ntsc></rate><string>${ev.srcIn || '00:00:00:00'}</string><frame>${srcInF}</frame><displayformat>${r.ntsc ? 'DF' : 'NDF'}</displayformat></timecode>`);
        L.push(`              <media><video><samplecharacteristics><rate><timebase>${fpsInt}</timebase><ntsc>${ntsc}</ntsc></rate><width>1920</width><height>1080</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video></media>`);
        L.push(`            </file>`);
        const markers = ev.markers || ev._markers || [];
        for (const mk of markers) {
          const label = xmlEsc(mk?.label || mk?.name || mk?.value || mk?.comment || 'Marker');
          const mf = Number.isFinite(Number(mk?.frame)) ? Number(mk.frame) : (mk?.tc ? tcToFrames(mk.tc, fps) : _recInF(ev, fps));
          L.push(`            <marker><name>${label}</name><in>${Math.max(recInF, mf - bounds.start)}</in><out>${Math.max(recInF + 1, mf - bounds.start + 1)}</out><comment>${label}</comment></marker>`);
        }
        L.push(`          </clipitem>`);
      }
      L.push(`        </track>`);
    }
    L.push(`      </video>`);
    L.push(`    </media>`);
    L.push(`  </sequence>`);
    L.push(`</xmeml>`);
    return L.join('\n');
  }

  // ── Modal state ──────────────────────────────────────────────────────────

  const FORMATS    = ['edl32','otio','fcpxml','fcpxmld','xml','aaf_nle_linked','aaf_protools_audio'];
  const FORMAT_EXT = { edl32:'edl', otio:'otio', fcpxml:'fcpxml', fcpxmld:'fcpxmld', xml:'xml', aaf_nle_linked:'aaf', aaf_protools_audio:'aaf' };

  let _mode         = 'export'; // 'export' | 'import'
  let _activeFormat = 'edl32';
  let _reelMode     = 'orig';   // 'orig' | 'clip' | 'file'
  let _lastContent  = '';
  let _structureMode = 'preserve'; // 'preserve' | 'flat'
  let _reelSource    = 'orig';     // 'orig' | 'filename' | 'clipname' | 'basename' | 'regex'
  let _reelOpts      = { noExt: false, forceUpper: false, trim8: false, origComment: false, regexPattern: '' };
  let _flatOpts      = { srcFilter: 'ocf', exclGfx: true, exclTemp: true, keepMarker: false };

  // ── AAF Native Helper state ──────────────────────────────────────────────
  let _aafHelperStatus = { checked: false, available: false, aafWriter: false, ffmpeg: false, version: null, errorCode: null, error: null };
  let _aafMediaRoots   = [];
  let _aafAudioRoots   = [];
  let _aafOptions = {
    nle: { linkVideo: true, embedVideo: false, includeMarkers: true, includeTimecodeTrack: true, includeAudioTracksIfPresent: true },
    protools: { sampleRate: 48000, bitDepth: 24, handlesFrames: 8, consolidateAudio: true, embedAudio: true, splitMonoTracks: true, includeVideoGuide: false },
  };

  let _tlcSuggestedRoots = []; // populated on import from file paths
  let _tlcAutoDetectedFormat = null; // set on import, shown as badge

  // ── Smart UI helpers ─────────────────────────────────────────────────────

  function _autoDetectFormat(filename) {
    const ext = (filename || '').split('.').pop().toLowerCase();
    const map = { edl:'fcpxml', fcpxml:'edl32', fcpxmld:'edl32', xml:'otio',
                  otio:'edl32', otioz:'edl32', aaf:'edl32', ale:'edl32',
                  prproj:'otio', json:'otio' };
    return map[ext] || null;
  }

  function _settingsKey(name) {
    return 'pfxTlc_v1_' + (name || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64);
  }

  function _saveSettings() {
    const key = _settingsKey(getProjectName());
    try {
      localStorage.setItem(key, JSON.stringify({
        activeFormat:  _activeFormat,
        structureMode: _structureMode,
        reelSource:    _reelSource,
        reelOpts:      _reelOpts,
        flatOpts:      _flatOpts,
        aafMediaRoots: _aafMediaRoots,
        aafAudioRoots: _aafAudioRoots,
        aafOptions:    _aafOptions,
      }));
    } catch (_) {}
  }

  function _loadSettings(name) {
    const key = _settingsKey(name);
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return false;
      const s = JSON.parse(raw);
      if (s.activeFormat  && FORMATS.includes(s.activeFormat))  _activeFormat  = s.activeFormat;
      if (s.structureMode) _structureMode = s.structureMode;
      if (s.reelSource)    _reelSource    = s.reelSource;
      if (s.reelOpts)      _reelOpts      = Object.assign({}, _reelOpts,  s.reelOpts);
      if (s.flatOpts)      _flatOpts      = Object.assign({}, _flatOpts,  s.flatOpts);
      if (Array.isArray(s.aafMediaRoots)) _aafMediaRoots = s.aafMediaRoots;
      if (Array.isArray(s.aafAudioRoots)) _aafAudioRoots = s.aafAudioRoots;
      if (s.aafOptions?.nle)      Object.assign(_aafOptions.nle,      s.aafOptions.nle);
      if (s.aafOptions?.protools) Object.assign(_aafOptions.protools, s.aafOptions.protools);
      return true;
    } catch (_) { return false; }
  }

  function _tlcSyncDomFromState() {
    const smEl = document.querySelector(`input[name="tlcStructMode"][value="${_structureMode}"]`);
    if (smEl) smEl.checked = true;
    const rsEl = document.getElementById('tlcReelSource');
    if (rsEl) rsEl.value = _reelSource;
    const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
    setChk('tlcOptNoExt',       _reelOpts.noExt);
    setChk('tlcOptUpper',       _reelOpts.forceUpper);
    setChk('tlcOptTrim8',       _reelOpts.trim8);
    setChk('tlcOptOrigComment', _reelOpts.origComment);
    const rxEl = document.getElementById('tlcReelRegex');
    if (rxEl) rxEl.value = _reelOpts.regexPattern || '';
    const fsEl = document.getElementById('tlcFlatSrc');
    if (fsEl) fsEl.value = _flatOpts.srcFilter || 'ocf';
    setChk('tlcFlatExclGfx',    _flatOpts.exclGfx);
    setChk('tlcFlatExclTemp',   _flatOpts.exclTemp);
    setChk('tlcFlatKeepMarker', _flatOpts.keepMarker);
    const flatPanel = document.getElementById('tlcFlatFilter');
    if (flatPanel) flatPanel.style.display = _structureMode === 'flat' ? 'flex' : 'none';
    if (rxEl) rxEl.style.display = _reelSource === 'regex' ? '' : 'none';
    FORMATS.forEach(fmt => {
      const tab = document.getElementById(`tlcTab_${fmt}`);
      if (tab) tab.classList.toggle('active', fmt === _activeFormat);
    });
  }

  function _extractRootSuggestions(events) {
    const dirs = [];
    for (const ev of (events || [])) {
      for (const field of [ev.srcFile, ev.audioFile, ev.audioPath]) {
        if (typeof field !== 'string' || !field) continue;
        let p = field.replace(/^file:\/\/localhost/, '').replace(/^file:\/\//, '');
        const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
        if (slash > 0) dirs.push(p.slice(0, slash));
      }
    }
    if (!dirs.length) return [];
    const segs = dirs.map(p => p.split(/[/\\]/).filter(Boolean));
    const common = segs[0].slice();
    for (let i = 1; i < segs.length; i++) {
      let j = 0;
      while (j < common.length && j < segs[i].length && common[j] === segs[i][j]) j++;
      common.length = j;
    }
    const suggestions = [];
    if (common.length) {
      const sep = dirs[0].startsWith('/') ? '/' : '\\';
      suggestions.push((dirs[0].startsWith('/') ? '/' : '') + common.join(sep));
    }
    for (const d of [...new Set(dirs)]) {
      if (!suggestions.includes(d) && suggestions.length < 5) suggestions.push(d);
    }
    return suggestions.slice(0, 5);
  }

  function _tlcPreflight(events, fps, format) {
    const errors = [], warnings = [];
    if (!events || !events.length) { warnings.push('No events loaded.'); return { errors, warnings }; }
    const noSrc = events.filter(ev => !ev.srcFile && !ev.reel && !ev.assetName);
    if (noSrc.length) warnings.push(`${noSrc.length} event(s) have no source reference.`);
    const zeroDur = events.filter(ev => ev.recIn && ev.recOut && ev.recIn === ev.recOut);
    if (zeroDur.length) warnings.push(`${zeroDur.length} zero-duration event(s).`);
    const knownFps = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
    if (fps && !knownFps.some(f => Math.abs(f - fps) < 0.02))
      warnings.push(`Unusual frame rate: ${fps} fps.`);
    if (format === 'edl32') {
      const longR = events.filter(ev => ev.reel && ev.reel.length > 8);
      if (longR.length) warnings.push(`${longR.length} reel name(s) over 8 chars — enable "Trim to 8" if needed.`);
    }
    if (format === 'aaf_nle_linked' || format === 'aaf_protools_audio') {
      const noPath = events.filter(ev => !ev.srcFile && !ev.audioFile && !ev.audioPath);
      if (noPath.length) errors.push(`${noPath.length} event(s) have no file path — AAF links will be broken.`);
    }
    return { errors, warnings };
  }

  function _preflightHtml(errors, warnings) {
    if (!errors.length && !warnings.length) return '';
    const parts = [];
    errors.forEach(e   => parts.push(`<span class="tlc-pf-err">&#9888; ${_htmlEsc(e)}</span>`));
    warnings.forEach(w => parts.push(`<span class="tlc-pf-warn">&#9432; ${_htmlEsc(w)}</span>`));
    return `<div class="tlc-preflight">${parts.join('')}</div>`;
  }

  // ── Reel name resolver (new unified system) ─────────────────────────────

  function resolveReel(ev, source, opts) {
    const stemFn = s => { s = String(s || ''); const i = s.lastIndexOf('.'); return i > 0 ? s.slice(0, i) : s; };
    const baseFn = p => String(p || '').split(/[\\/]/).pop() || '';
    let name;
    switch (source) {
      case 'filename':
        name = stemFn(baseFn(ev.srcFile || '') || baseFn(ev.assetName || '') || ev.reel || 'REEL');
        break;
      case 'clipname':
        name = stemFn(ev.clipName || ev.clip || ev.name || ev.reel || 'CLIP');
        break;
      case 'basename': {
        const raw = ev.srcFile || ev.assetName || '';
        name = stemFn(baseFn(raw)) || stemFn(ev.reel || '') || 'REEL';
        break;
      }
      case 'regex': {
        const src = ev.reel || ev.srcFile || ev.clipName || '';
        try {
          const m = opts.regexPattern ? src.match(new RegExp(opts.regexPattern)) : null;
          name = (m && (m[1] !== undefined ? m[1] : m[0])) || src || 'REEL';
        } catch (_) { name = src || 'REEL'; }
        break;
      }
      default: // 'orig'
        name = ev.reel || 'REEL';
    }
    if (opts.noExt) { const di = name.lastIndexOf('.'); if (di > 0) name = name.slice(0, di); }
    if (opts.forceUpper) name = name.toUpperCase();
    return name || 'REEL';
  }

  // ── Clip classification ──────────────────────────────────────────────────

  const _GFX_RE  = /\b(title|graphic|gfx|lower.?third|slate|card|logo|bug|ident|overlay|bumper|pkg|l3rd|lwr)\b/i;
  const _TEMP_RE = /\b(offline|temp|wip|placeholder|missing|not.?found|filler|mute|silence)\b/i;
  const _OCF_RE  = /\.(mov|mxf|r3d|braw|ari|dpx|exr|cine|dng|mp4|m4v|mts|m2ts|avi|mkv)$/i;
  const _BL_RE   = /^(BL|black|filler|silence|offline|gap|empty)$/i;

  function _isOcfClip(ev) {
    if (ev.isOCF) return true;
    const src = String(ev.srcFile || ev.assetName || '');
    if (src && _OCF_RE.test(src)) return true;
    const reel = String(ev.reel || '');
    return reel.length > 0 && !_BL_RE.test(reel);
  }

  // ── Structure transforms ─────────────────────────────────────────────────

  function preserveSourceStructure(events, reelSource, reelOpts) {
    if (reelSource === 'orig' && !reelOpts.noExt && !reelOpts.forceUpper) return events;
    return events.map(ev => {
      const origReel = ev.reel;
      const newReel  = resolveReel(ev, reelSource, reelOpts);
      return Object.assign({}, ev, {
        reel: newReel,
        _originalReel: (reelOpts.origComment && newReel !== origReel) ? origReel : undefined,
      });
    });
  }

  function flattenForMps(events, reelSource, reelOpts, flatOpts) {
    const srcFilter  = flatOpts.srcFilter  || 'ocf';
    const exclGfx    = flatOpts.exclGfx    !== false;
    const exclTemp   = flatOpts.exclTemp   !== false;
    const keepMarker = !!flatOpts.keepMarker;

    const filtered = events.filter(ev => {
      if (ev.type && ev.type !== 'video') return false;
      if (ev.trackIndex !== undefined && ev.trackIndex !== 0) return false;
      const name = String(ev.clipName || ev.name || ev.reel || '');
      if (exclGfx  && _GFX_RE.test(name))  return false;
      if (exclTemp && _TEMP_RE.test(name)) return false;
      if (_BL_RE.test(String(ev.reel || '')) && !ev.srcIn) return false;
      if (srcFilter === 'ocf') {
        const hasMarkers = ev.markers && ev.markers.length;
        if (!_isOcfClip(ev) && !(keepMarker && hasMarkers)) return false;
      } else if (srcFilter === 'real') {
        if (!ev.srcIn && !ev.srcFile) return false;
      }
      return true;
    });

    return filtered.map((ev, i) => {
      const origReel = ev.reel;
      const newReel  = resolveReel(ev, reelSource, reelOpts);
      return Object.assign({}, ev, {
        event: i + 1,
        reel: newReel,
        trackIndex: 0,
        _originalReel: (reelOpts.origComment && newReel !== origReel) ? origReel : undefined,
      });
    });
  }

  function _getTransformedEvents() {
    const raw = getEvents();
    return _structureMode === 'flat'
      ? flattenForMps(raw, _reelSource, _reelOpts, _flatOpts)
      : preserveSourceStructure(raw, _reelSource, _reelOpts);
  }

  // ── Export logic ─────────────────────────────────────────────────────────

  function _generate() {
    const events = _getTransformedEvents();
    const fps    = getFps();
    try {
      switch (_activeFormat) {
        case 'edl32':   _lastContent = toEDL32(events, fps, _reelOpts);  break;
        case 'otio':    _lastContent = toOTIO(events, fps, 'orig');       break;
        case 'fcpxml':  _lastContent = toFCPXML(events, fps, 'orig');     break;
        case 'fcpxmld': _lastContent = toFCPXMLD(events, fps, 'orig');    break;
        case 'xml':     _lastContent = toFCP7XML(events, fps, 'orig');    break;
        case 'aaf_nle_linked':
            _lastContent = 'Real binary AAF / NLE Linked AAF will be generated by PostFlowX Native Helper.\nThis export preserves V tracks, TC, reel, source clips, markers, and linked media.';
            break;
        case 'aaf_protools_audio':
            _lastContent = 'Real binary Pro Tools Audio AAF will be generated by PostFlowX Native Helper.\nThis export creates/consolidates 48kHz 24-bit mono WAV/BWF audio with handles.';
            break;
        default:        _lastContent = '';
      }
    } catch (err) {
      _lastContent = `/* Error generating ${_activeFormat}: ${err.message} */`;
    }
    return _lastContent;
  }

  // ── AAF Helper status check ──────────────────────────────────────────────

  function callNativeHelper(payload) {
    return new Promise(resolve => {
      if (typeof chrome === 'undefined' || typeof chrome.runtime?.sendMessage !== 'function') {
        resolve({ status: 'error', code: 'NATIVE_MESSAGING_UNAVAILABLE', userMessage: 'Native Messaging is not available. PostFlowX must run as a Chrome extension.' });
        return;
      }
      const guard = setTimeout(() => resolve({ status: 'error', code: 'TIMEOUT', userMessage: 'Native Helper did not respond in time.' }), 14000);
      chrome.runtime.sendMessage({ type: 'IMF_COMPANION_CALL', payload, timeoutMs: 13000 }, resp => {
        clearTimeout(guard);
        void chrome.runtime.lastError;
        if (!resp) {
          resolve({ status: 'error', code: 'EMPTY_NATIVE_RESPONSE', userMessage: 'Native Helper returned no response.' });
          return;
        }
        if (!resp.ok) {
          const rawErr = resp.error?.message || resp.error?.userMessage || '';
          const m = String(rawErr).toLowerCase();
          let code = 'NATIVE_HELPER_ERROR';
          if (/not found|cannot find|not_found/i.test(m))    code = 'HOST_NOT_FOUND';
          else if (/forbidden|access/i.test(m))              code = 'HOST_FORBIDDEN';
          else if (/exited|disconnected|invalid/i.test(m))   code = 'HOST_CRASHED';
          resolve({ status: 'error', code, userMessage: rawErr, rawError: rawErr });
          return;
        }
        // Bridge wraps response in resp.response
        const inner = resp.response || {};
        resolve(inner);
      });
    });
  }

  async function _checkAAFHelperStatus() {
    if (typeof chrome === 'undefined' || typeof chrome.runtime?.sendNativeMessage !== 'function' || !chrome.runtime?.id) {
      _aafHelperStatus = { checked: true, available: false, aafWriter: false, ffmpeg: false, version: null, errorCode: 'NATIVE_MESSAGING_UNAVAILABLE', error: 'Native Messaging unavailable. PostFlowX must run as a Chrome extension.' };
      _renderAAFPanel();
      return;
    }

    _aafHelperStatus = { checked: false, available: false, aafWriter: false, ffmpeg: false, version: null, errorCode: null, error: null };
    _renderAAFPanel();

    const resp = await callNativeHelper({ action: 'aafCapabilities', extensionId: chrome.runtime.id });

    if (resp.status === 'error' || resp.ok === false) {
      const code = resp.code || 'NATIVE_HELPER_ERROR';
      _aafHelperStatus = { checked: true, available: false, aafWriter: false, ffmpeg: false, version: null, errorCode: code, error: resp.userMessage || resp.rawError || 'Native Helper error.' };
      _renderAAFPanel();
      return;
    }

    const ok   = resp?.status === 'ok' || resp?.ok === true;
    const data = (resp?.data && typeof resp.data === 'object') ? resp.data
               : (resp?.result && typeof resp.result === 'object') ? resp.result : {};
    _aafHelperStatus = {
      checked:   true,
      available: ok,
      aafWriter: !!(data.aafWriter),
      ffmpeg:    !!(data.ffmpeg),
      version:   data.version || null,
      errorCode: ok ? null : (resp?.error?.code || 'HELPER_ERROR'),
      error:     ok ? null : (resp?.error?.message || resp?.message || 'Helper responded with error.'),
    };
    _renderAAFPanel();
  }

  function _aafDownloadInstaller(platform) {
    const extId = (typeof chrome !== 'undefined' && chrome.runtime?.id) ? chrome.runtime.id : 'PASTE_YOUR_EXTENSION_ID_HERE';
    let content, filename;
    if (platform === 'mac') {
      content = _aafMacInstallerText(extId);
      filename = 'install_postflowx_helper.command';
    } else {
      content = _aafWinInstallerText(extId);
      filename = 'install_postflowx_helper.ps1';
    }
    const blob = new Blob([content], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function _aafMacInstallerText(extId) {
    return `#!/usr/bin/env bash
# PostFlowX Native Helper — macOS Installer
# Double-click in Finder or run:  bash install_postflowx_helper.command
set -euo pipefail
BLUE='\\033[0;34m'; GREEN='\\033[0;32m'; YELLOW='\\033[1;33m'; RED='\\033[0;31m'; NC='\\033[0m'
EXTENSION_ID="${extId}"
HOST_NAME="com.postflowx.companion"
INSTALL_DIR="$HOME/Library/Application Support/PostFlowX/helper"
WRAPPER_PATH="$INSTALL_DIR/postflowx-helper"
CHROME_NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_NAME="\${HOST_NAME}.json"
echo ""
echo -e "\${BLUE}╔══════════════════════════════════════════════════╗\${NC}"
echo -e "\${BLUE}║   PostFlowX Native Helper — macOS Installer     ║\${NC}"
echo -e "\${BLUE}╚══════════════════════════════════════════════════╝\${NC}"
echo ""
if [[ -z "$EXTENSION_ID" || "$EXTENSION_ID" == "PASTE_YOUR_EXTENSION_ID_HERE" ]]; then
  echo -e "\${YELLOW}Extension ID was not pre-filled.\${NC}"
  echo "Open chrome://extensions (Developer mode on) and copy the Extension ID."
  read -rp "Paste Extension ID: " EXTENSION_ID
fi
EXTENSION_ID="\${EXTENSION_ID// /}"
if [[ ! "$EXTENSION_ID" =~ ^[a-z]{32}$ ]]; then
  echo -e "\${RED}Invalid Extension ID: must be 32 lowercase letters.\${NC}"; exit 1
fi
PYTHON=""
for py in python3 python; do
  if command -v "$py" &>/dev/null && "$py" -c "import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)" 2>/dev/null; then
    PYTHON="$(command -v "$py")"; break
  fi
done
if [[ -z "$PYTHON" ]]; then
  echo -e "\${RED}Python 3.10+ not found.\${NC} Install from https://www.python.org/"; exit 1
fi
echo -e "\${GREEN}Python:\${NC} $PYTHON ($("$PYTHON" --version))"
if ! "$PYTHON" -c "import postflowx_companion" 2>/dev/null; then
  echo -e "\${YELLOW}Installing postflowx_companion via pip...\${NC}"
  "$PYTHON" -m pip install --quiet postflowx-companion || {
    echo -e "\${RED}pip install failed.\${NC} Run: $PYTHON -m pip install postflowx-companion"; exit 1
  }
fi
mkdir -p "$INSTALL_DIR"
printf '#!/usr/bin/env bash\\nexec "%s" -m postflowx_companion.app --mode native-host "$@"\\n' "$PYTHON" > "$WRAPPER_PATH"
chmod +x "$WRAPPER_PATH"
echo -e "\${GREEN}Wrapper:\${NC} $WRAPPER_PATH"
mkdir -p "$CHROME_NM_DIR"
cat > "$CHROME_NM_DIR/$MANIFEST_NAME" <<JSON
{
  "name": "$HOST_NAME",
  "description": "PostFlowX Native Helper",
  "path": "$WRAPPER_PATH",
  "type": "stdio",
  "allowed_origins": [ "chrome-extension://$EXTENSION_ID/" ]
}
JSON
echo -e "\${GREEN}Manifest:\${NC} $CHROME_NM_DIR/$MANIFEST_NAME"
for BROWSER in "Google/Chrome Beta" "Google/Chrome Canary" "Chromium"; do
  ALT_DIR="$HOME/Library/Application Support/$BROWSER/NativeMessagingHosts"
  if [[ -d "$(dirname "$ALT_DIR")" ]]; then
    mkdir -p "$ALT_DIR"; cp "$CHROME_NM_DIR/$MANIFEST_NAME" "$ALT_DIR/$MANIFEST_NAME"
    echo -e "\${GREEN}Also installed for:\${NC} $BROWSER"
  fi
done
echo ""; echo -e "\${GREEN}✓ Installation complete.\${NC}"; echo ""
echo "Next steps:"
echo "  1. Quit and relaunch Google Chrome."
echo "  2. Open PostFlowX → Timeline Convert → AAF NLE or PT AAF."
echo "  3. Click 'Re-check Helper'."
`;
  }

  function _aafWinInstallerText(extId) {
    return `# PostFlowX Native Helper — Windows Installer
# Run: powershell -ExecutionPolicy Bypass -File install_postflowx_helper.ps1
$ExtensionId = "${extId}"
$HostName = "com.postflowx.companion"
$InstallDir = "$env:LOCALAPPDATA\\PostFlowX\\Helper"
$WrapperPath = "$InstallDir\\postflowx-helper.bat"
$ManifestPath = "$InstallDir\\$HostName.json"
$RegKey = "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\$HostName"
Write-Host "" ; Write-Host "================================================" -ForegroundColor Blue
Write-Host "  PostFlowX Native Helper — Windows Installer" -ForegroundColor Blue
Write-Host "================================================" -ForegroundColor Blue ; Write-Host ""
if ([string]::IsNullOrWhiteSpace($ExtensionId) -or $ExtensionId -eq "PASTE_YOUR_EXTENSION_ID_HERE") {
  Write-Host "Extension ID not pre-filled." -ForegroundColor Yellow
  Write-Host "Open chrome://extensions (Developer mode on) and copy the Extension ID."
  $ExtensionId = Read-Host "Paste Extension ID"
}
$ExtensionId = $ExtensionId.Trim()
if ($ExtensionId -notmatch '^[a-z]{32}$') { Write-Host "Invalid Extension ID." -ForegroundColor Red; exit 1 }
$PythonCmd = $null
foreach ($py in @("python","python3","py")) {
  try { $v = & $py --version 2>&1; if ($v -match "Python 3\\.(?:1[0-9]|[2-9]\\d)") { $PythonCmd=$py; break } } catch {}
}
if (-not $PythonCmd) { Write-Host "Python 3.10+ not found. https://www.python.org/" -ForegroundColor Red; exit 1 }
Write-Host "Python: $PythonCmd" -ForegroundColor Green
$hasModule = & $PythonCmd -c "import postflowx_companion; print('ok')" 2>&1
if ($hasModule -ne 'ok') {
  Write-Host "Installing postflowx_companion..." -ForegroundColor Yellow
  & $PythonCmd -m pip install --quiet postflowx-companion
  if ($LASTEXITCODE -ne 0) { Write-Host "pip install failed." -ForegroundColor Red; exit 1 }
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$PythonFull = (Get-Command $PythonCmd -ErrorAction Stop).Source
[System.IO.File]::WriteAllText($WrapperPath, "@echo off\`r\`n\`"$PythonFull\`" -m postflowx_companion.app --mode native-host %*", [System.Text.Encoding]::ASCII)
Write-Host "Wrapper: $WrapperPath" -ForegroundColor Green
$manifest = '{ "name": "' + $HostName + '", "description": "PostFlowX Native Helper", "path": "' + $WrapperPath.Replace('\\','\\\\') + '", "type": "stdio", "allowed_origins": [ "chrome-extension://' + $ExtensionId + '/" ] }'
[System.IO.File]::WriteAllText($ManifestPath, $manifest, [System.Text.Encoding]::UTF8)
Write-Host "Manifest: $ManifestPath" -ForegroundColor Green
New-Item -Path $RegKey -Force | Out-Null
Set-ItemProperty -Path $RegKey -Name "(Default)" -Value $ManifestPath
Write-Host "Registry: $RegKey" -ForegroundColor Green
Write-Host "" ; Write-Host "Installation complete!" -ForegroundColor Green ; Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Quit and relaunch Google Chrome."
Write-Host "  2. Open PostFlowX > Timeline Convert > AAF NLE or PT AAF."
Write-Host "  3. Click Re-check Helper."
`;
  }

  // ── AAF Panel renderer ───────────────────────────────────────────────────

  function _renderAAFPanel() {
    const panel = document.getElementById('tlcAafPanel');
    if (!panel) return;

    const isNLE = _activeFormat === 'aaf_nle_linked';
    const isPT  = _activeFormat === 'aaf_protools_audio';
    if (!isNLE && !isPT) { panel.innerHTML = ''; return; }

    const hs    = _aafHelperStatus;
    const roots = isNLE ? _aafMediaRoots : _aafAudioRoots;

    // Status pill
    let pillClass, pillLabel;
    if (!hs.checked) {
      pillClass = 'aaf-pill-checking'; pillLabel = 'Checking…';
    } else if (!hs.available) {
      const isForbidden = hs.errorCode === 'HOST_FORBIDDEN';
      pillClass = 'aaf-pill-error'; pillLabel = isForbidden ? 'Access Denied' : 'Not Installed';
    } else if (!hs.aafWriter) {
      pillClass = 'aaf-pill-warn'; pillLabel = 'AAF Deps Missing';
    } else if (isPT && !hs.ffmpeg) {
      pillClass = 'aaf-pill-warn'; pillLabel = 'AAF Deps Missing';
    } else {
      pillClass = 'aaf-pill-ready'; pillLabel = 'Ready';
    }

    const extId    = (typeof chrome !== 'undefined' && chrome.runtime?.id) ? chrome.runtime.id : '—';
    const hostName = 'com.postflowx.companion';

    const canExport = hs.checked && hs.available && hs.aafWriter && (!isPT || hs.ffmpeg);
    const showInstall = hs.checked && !hs.available;
    const showAvailableBody = hs.available;

    // ── Install / blocked section ──────────────────────────────────────────
    let installHtml = '';
    if (showInstall) {
      const code = hs.errorCode || 'HOST_NOT_FOUND';
      let reasonHtml = '';
      if (code === 'HOST_NOT_FOUND') {
        reasonHtml = 'Native Messaging host is not registered. Run the installer below to set up PostFlowX Native Helper.';
      } else if (code === 'HOST_FORBIDDEN') {
        reasonHtml = 'Native Helper is installed, but this Chrome Extension ID is not allowed. Re-run the installer with your current Extension ID, or update the manifest manually.';
      } else if (code === 'HOST_CRASHED') {
        reasonHtml = 'Native Helper started but exited unexpectedly. Verify your installation and click Re-check.';
      } else if (code === 'NATIVE_MESSAGING_UNAVAILABLE') {
        reasonHtml = 'Native Messaging API is unavailable. PostFlowX must run as a loaded Chrome extension (not from a plain file:// URL).';
      } else {
        reasonHtml = _htmlEsc(hs.error || 'Native Helper error.');
      }
      const showDownloadBtns = code === 'HOST_NOT_FOUND' || code === 'HOST_FORBIDDEN';
      installHtml = `
        <div class="aaf-install-section">
          <div class="aaf-install-reason">${reasonHtml}</div>
          <div class="aaf-install-info">
            <div class="aaf-install-info-row">
              <span class="aaf-install-info-lbl">Host name</span>
              <code class="aaf-install-info-val">${hostName}</code>
            </div>
            <div class="aaf-install-info-row">
              <span class="aaf-install-info-lbl">Extension ID</span>
              <code class="aaf-install-info-val" id="aafExtIdDisplay">${_htmlEsc(extId)}</code>
            </div>
          </div>
          ${showDownloadBtns ? `
          <div class="aaf-install-steps">
            <div class="aaf-install-step">1. Click "Copy Extension ID" and keep it handy.</div>
            <div class="aaf-install-step">2. Download the installer for your OS below.</div>
            <div class="aaf-install-step">3. Run the installer and paste the Extension ID when prompted.</div>
            <div class="aaf-install-step">4. Quit and relaunch Chrome.</div>
            <div class="aaf-install-step">5. Return here and click "Re-check Helper".</div>
          </div>
          <div class="aaf-install-btns">
            <button id="aafBtnInstallMac" class="aaf-btn-sm">⬇ macOS Installer</button>
            <button id="aafBtnInstallWin" class="aaf-btn-sm">⬇ Windows Installer</button>
            <button id="aafBtnCopyExtId" class="aaf-btn-sm">Copy Extension ID</button>
          </div>` : ''}
          <div class="aaf-install-btns" style="margin-top:${showDownloadBtns?'6px':'0'};">
            <button id="aafBtnCheck" class="aaf-btn-sm">Re-check Helper</button>
          </div>
          <div class="aaf-status-warn" style="margin-top:4px;">For install instructions, go to <strong>Settings &rarr; Native Helper</strong>.</div>
        </div>`;
    }

    // ── Helper status sub-text (when available) ────────────────────────────
    let helperSubHtml = '';
    if (!hs.checked) {
      helperSubHtml = '<div class="aaf-status-msg">Contacting PostFlowX Native Helper…</div>';
    } else if (hs.available) {
      if (!hs.aafWriter || (isPT && !hs.ffmpeg)) {
        helperSubHtml = '<div class="aaf-status-msg aaf-status-warn">Native Helper is installed, but AAF support is missing. Go to <strong>Settings &rarr; Native Helper</strong> and run the <strong>Full Native Helper Installer</strong>.</div>';
      } else if (hs.version) {
        helperSubHtml = `<div class="aaf-status-msg">Companion v${_htmlEsc(hs.version)}</div>`;
      }
    }

    // ── Roots section ──────────────────────────────────────────────────────
    const rootTitle       = isNLE ? 'Media Roots' : 'Audio / Media Roots';
    const rootPlaceholder = isNLE ? '/Volumes/SHOW/Media' : '/Volumes/SHOW/Audio';
    const rootsHtml = roots.length === 0
      ? '<div class="aaf-roots-empty">No paths added</div>'
      : roots.map((r, i) =>
          `<div class="aaf-root-item"><span class="aaf-root-path">${_htmlEsc(r)}</span><button class="aaf-root-remove" data-idx="${i}" title="Remove">✕</button></div>`
        ).join('');
    // Suggestion chips: paths detected from imported file's source references
    const unusedSuggestions = _tlcSuggestedRoots.filter(s => !roots.includes(s));
    const suggestHtml = unusedSuggestions.length
      ? `<div class="aaf-suggest-row">${unusedSuggestions.map(s =>
          `<button class="aaf-suggest-chip" data-path="${_htmlEsc(s)}" title="Add ${_htmlEsc(s)}">${_htmlEsc(s)}</button>`
        ).join('')}</div>`
      : '';

    // ── Options section ────────────────────────────────────────────────────
    let optHtml = '';
    if (isNLE) {
      const o = _aafOptions.nle;
      optHtml = `
        <label class="aaf-check-lbl"><input type="checkbox" id="aafOptLinkVideo" ${o.linkVideo?'checked':''}> Link video clips</label>
        <label class="aaf-check-lbl aaf-check-disabled"><input type="checkbox" id="aafOptEmbedVideo" disabled> Embed video (not supported)</label>
        <label class="aaf-check-lbl"><input type="checkbox" id="aafOptMarkers" ${o.includeMarkers?'checked':''}> Include markers</label>
        <label class="aaf-check-lbl"><input type="checkbox" id="aafOptTC" ${o.includeTimecodeTrack?'checked':''}> Include TC1 track</label>
        <label class="aaf-check-lbl"><input type="checkbox" id="aafOptAudio" ${o.includeAudioTracksIfPresent?'checked':''}> Include audio if present</label>`;
    } else {
      const o = _aafOptions.protools;
      optHtml = `
        <div class="aaf-opt-row"><span class="aaf-opt-lbl">Sample rate</span>
          <select id="aafOptSampleRate" class="aaf-select">
            <option value="48000" ${o.sampleRate===48000?'selected':''}>48 000 Hz</option>
            <option value="96000" ${o.sampleRate===96000?'selected':''}>96 000 Hz</option>
          </select>
        </div>
        <div class="aaf-opt-row"><span class="aaf-opt-lbl">Bit depth</span>
          <select id="aafOptBitDepth" class="aaf-select">
            <option value="24" ${o.bitDepth===24?'selected':''}>24-bit</option>
            <option value="16" ${o.bitDepth===16?'selected':''}>16-bit</option>
            <option value="32" ${o.bitDepth===32?'selected':''}>32-bit float</option>
          </select>
        </div>
        <div class="aaf-opt-row"><span class="aaf-opt-lbl">Handles (frames)</span>
          <input type="number" id="aafOptHandles" class="aaf-num-inp" value="${o.handlesFrames}" min="0" max="240">
        </div>
        <label class="aaf-check-lbl"><input type="checkbox" id="aafOptConsolidate" ${o.consolidateAudio?'checked':''}> Consolidate audio</label>
        <label class="aaf-check-lbl"><input type="checkbox" id="aafOptEmbed" ${o.embedAudio?'checked':''}> Embed audio in AAF</label>
        <label class="aaf-check-lbl"><input type="checkbox" id="aafOptSplitMono" ${o.splitMonoTracks?'checked':''}> Split to mono tracks</label>
        <label class="aaf-check-lbl"><input type="checkbox" id="aafOptVideoGuide" ${o.includeVideoGuide?'checked':''}> Include video guide ref</label>`;
    }

    // ── Readiness ──────────────────────────────────────────────────────────
    const events   = getEvents ? getEvents() : [];
    const evCount  = events.filter(e => e.recIn || e.recOut).length;
    const vidCount = events.filter(e => (e.type || '').match(/^v/i) || (e.trackIndex ?? 1) === 0).length;
    const audCount = events.filter(e => (e.type || '').match(/^a/i) || e.audioFile || e.audioPath).length;

    // ── Blocked message ────────────────────────────────────────────────────
    let blockedMsg = '';
    if (hs.checked && hs.available) {
      if (!hs.aafWriter) blockedMsg = 'AAF export unavailable. Run Full Native Helper Installer from Settings.';
      else if (isPT && !hs.ffmpeg) blockedMsg = 'Pro Tools AAF unavailable. Run Full Native Helper Installer from Settings.';
    }

    const title    = isNLE ? 'AAF / NLE Linked AAF' : 'Pro Tools Audio AAF';
    const subtitle = isNLE
      ? 'Binary .aaf for Avid Media Composer / DaVinci Resolve conform. Requires Native Helper + pyaaf2.'
      : 'Consolidated mono WAV/BWF with handles. Requires Native Helper + pyaaf2 + ffmpeg.';
    const exportLabel = isNLE ? 'Export NLE Linked AAF' : 'Export Pro Tools AAF';

    panel.innerHTML = `
      <div class="aaf-panel">
        <div class="aaf-panel-hd">
          <div class="aaf-panel-title">${_htmlEsc(title)}</div>
          <div class="aaf-panel-sub">${_htmlEsc(subtitle)}</div>
        </div>

        <div class="aaf-section">
          <div class="aaf-section-hd">Native Helper</div>
          <div class="aaf-helper-row">
            <span class="aaf-pill ${pillClass}">${pillLabel}</span>
            ${!showInstall ? `<button id="aafBtnCheck" class="aaf-btn-sm">Re-check</button>` : ''}
          </div>
          ${helperSubHtml}
        </div>

        ${installHtml}

        ${showAvailableBody ? `
        <div class="aaf-section">
          <div class="aaf-section-hd">${_htmlEsc(rootTitle)}</div>
          <div class="aaf-roots-list" id="aafRootsList">${rootsHtml}</div>
          ${suggestHtml}
          <div class="aaf-root-add-row">
            <input type="text" id="aafRootInput" class="aaf-root-inp" placeholder="${_htmlEsc(rootPlaceholder)}">
            <button id="aafBtnAddRoot" class="aaf-btn-sm">Add Path</button>
          </div>
        </div>
        <div class="aaf-section">
          <div class="aaf-section-hd">Export Options</div>
          <div class="aaf-opts-inner">${optHtml}
          </div>
        </div>
        <div class="aaf-section">
          <div class="aaf-section-hd">Readiness</div>
          <div class="aaf-ready-row"><span class="aaf-ready-label">Events</span><span class="aaf-ready-val">${evCount}</span></div>
          <div class="aaf-ready-row"><span class="aaf-ready-label">Video events</span><span class="aaf-ready-val">${vidCount}</span></div>
          <div class="aaf-ready-row"><span class="aaf-ready-label">Audio events</span><span class="aaf-ready-val">${audCount}</span></div>
          ${(() => { const pf = _tlcPreflight(events, getFps(), _activeFormat); return _preflightHtml(pf.errors, pf.warnings); })()}
        </div>` : ''}

        ${blockedMsg ? `<div class="aaf-blocked-msg">${_htmlEsc(blockedMsg)}</div>` : ''}
        <button id="aafBtnExport" class="aaf-export-btn${canExport ? '' : ' aaf-export-btn-disabled'}" ${canExport ? '' : 'disabled'}>${_htmlEsc(exportLabel)}</button>
      </div>`;

    // ── Bind events ────────────────────────────────────────────────────────
    panel.querySelector('#aafBtnCheck')?.addEventListener('click', () => {
      _aafHelperStatus = { checked: false, available: false, aafWriter: false, ffmpeg: false, version: null, errorCode: null, error: null };
      _checkAAFHelperStatus();
    });

    panel.querySelector('#aafBtnInstallMac')?.addEventListener('click', () => _aafDownloadInstaller('mac'));
    panel.querySelector('#aafBtnInstallWin')?.addEventListener('click', () => _aafDownloadInstaller('win'));

    panel.querySelector('#aafBtnCopyExtId')?.addEventListener('click', () => {
      const id = (typeof chrome !== 'undefined' && chrome.runtime?.id) ? chrome.runtime.id : '';
      if (!id) return;
      navigator.clipboard?.writeText(id).then(() => {
        const btn = panel.querySelector('#aafBtnCopyExtId');
        if (btn) { const orig = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = orig; }, 1500); }
      }).catch(() => {});
    });

    panel.querySelector('#aafBtnAddRoot')?.addEventListener('click', () => {
      const inp = panel.querySelector('#aafRootInput');
      const val = (inp ? inp.value : '').trim();
      if (!val) return;
      if (isNLE) { if (!_aafMediaRoots.includes(val)) _aafMediaRoots.push(val); }
      else       { if (!_aafAudioRoots.includes(val)) _aafAudioRoots.push(val); }
      if (inp) inp.value = '';
      _saveSettings();
      _renderAAFPanel();
    });

    panel.querySelectorAll('.aaf-suggest-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const p = chip.dataset.path;
        if (!p) return;
        if (isNLE) { if (!_aafMediaRoots.includes(p)) _aafMediaRoots.push(p); }
        else       { if (!_aafAudioRoots.includes(p)) _aafAudioRoots.push(p); }
        _saveSettings();
        _renderAAFPanel();
      });
    });

    panel.querySelector('#aafRootInput')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') panel.querySelector('#aafBtnAddRoot')?.click();
    });

    panel.querySelectorAll('.aaf-root-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        if (!Number.isInteger(idx) || idx < 0) return;
        if (isNLE) _aafMediaRoots.splice(idx, 1);
        else       _aafAudioRoots.splice(idx, 1);
        _saveSettings();   // persist removal (add/suggest paths already do)
        _renderAAFPanel();
      });
    });

    if (isNLE) {
      panel.querySelector('#aafOptLinkVideo')?.addEventListener('change', e => { _aafOptions.nle.linkVideo = e.target.checked; _saveSettings(); });
      panel.querySelector('#aafOptMarkers')?.addEventListener('change',   e => { _aafOptions.nle.includeMarkers = e.target.checked; _saveSettings(); });
      panel.querySelector('#aafOptTC')?.addEventListener('change',        e => { _aafOptions.nle.includeTimecodeTrack = e.target.checked; _saveSettings(); });
      panel.querySelector('#aafOptAudio')?.addEventListener('change',     e => { _aafOptions.nle.includeAudioTracksIfPresent = e.target.checked; _saveSettings(); });
    } else {
      panel.querySelector('#aafOptSampleRate')?.addEventListener('change', e => { _aafOptions.protools.sampleRate = parseInt(e.target.value, 10); _saveSettings(); });
      panel.querySelector('#aafOptBitDepth')?.addEventListener('change',   e => { _aafOptions.protools.bitDepth = parseInt(e.target.value, 10); _saveSettings(); });
      panel.querySelector('#aafOptHandles')?.addEventListener('input',     e => { _aafOptions.protools.handlesFrames = parseInt(e.target.value, 10) || 0; _saveSettings(); });
      panel.querySelector('#aafOptConsolidate')?.addEventListener('change', e => { _aafOptions.protools.consolidateAudio = e.target.checked; _saveSettings(); });
      panel.querySelector('#aafOptEmbed')?.addEventListener('change',       e => { _aafOptions.protools.embedAudio = e.target.checked; _saveSettings(); });
      panel.querySelector('#aafOptSplitMono')?.addEventListener('change',   e => { _aafOptions.protools.splitMonoTracks = e.target.checked; _saveSettings(); });
      panel.querySelector('#aafOptVideoGuide')?.addEventListener('change',  e => { _aafOptions.protools.includeVideoGuide = e.target.checked; _saveSettings(); });
    }

    panel.querySelector('#aafBtnExport')?.addEventListener('click', () => {
      exportAAFNative(isNLE ? 'nle_linked' : 'protools_audio');
    });
  }

  function _renderExport() {
    const preview  = document.getElementById('tlcPreview');
    const aafPanel = document.getElementById('tlcAafPanel');
    const dlBtn    = document.getElementById('tlcDownloadBtn');
    const copyBtn  = document.getElementById('tlcCopyBtn');
    const counter  = document.getElementById('tlcEventCount');
    const events   = getEvents();

    // Persist settings every time the export pane renders
    _saveSettings();

    if (counter) counter.textContent = `${events.filter(e => e.recIn || e.recOut).length} events`;

    const isAAFNative = _activeFormat === 'aaf_nle_linked' || _activeFormat === 'aaf_protools_audio';

    if (preview)  preview.style.display  = isAAFNative ? 'none' : '';
    if (aafPanel) aafPanel.style.display = isAAFNative ? ''     : 'none';
    if (dlBtn)    dlBtn.style.display    = isAAFNative ? 'none' : '';
    if (copyBtn)  copyBtn.style.display  = isAAFNative ? 'none' : '';

    FORMATS.forEach(fmt => {
      const tab = document.getElementById(`tlcTab_${fmt}`);
      if (tab) tab.classList.toggle('active', fmt === _activeFormat);
    });

    // Auto-detect badge: show which format was suggested on import
    let autoDetectBadge = document.getElementById('tlcAutoDetectBadge');
    if (_tlcAutoDetectedFormat === _activeFormat) {
      if (!autoDetectBadge) {
        autoDetectBadge = document.createElement('span');
        autoDetectBadge.id = 'tlcAutoDetectBadge';
        autoDetectBadge.className = 'tlc-auto-badge';
        const tabEl = document.getElementById(`tlcTab_${_activeFormat}`);
        tabEl?.appendChild(autoDetectBadge);
      }
      autoDetectBadge.textContent = 'auto';
    } else if (autoDetectBadge) {
      autoDetectBadge.remove();
    }

    if (!isAAFNative) {
      if (preview) preview.value = _generate();
      // Preflight row above the preview textarea
      const pf = _tlcPreflight(events, getFps(), _activeFormat);
      const pfHtml = _preflightHtml(pf.errors, pf.warnings);
      let pfRow = document.getElementById('tlcPreflightRow');
      if (pfHtml) {
        if (!pfRow) {
          pfRow = document.createElement('div');
          pfRow.id = 'tlcPreflightRow';
          preview?.parentNode?.insertBefore(pfRow, preview);
        }
        pfRow.innerHTML = pfHtml;
        pfRow.style.display = '';
      } else if (pfRow) {
        pfRow.style.display = 'none';
      }
      _setExportStatus('');
    } else {
      const pfRow = document.getElementById('tlcPreflightRow');
      if (pfRow) pfRow.style.display = 'none';
      _setExportStatus('');
      if (!_aafHelperStatus.checked) _checkAAFHelperStatus();
      else _renderAAFPanel();
    }
  }

  function _setExportStatus(msg, ok) {
    let el = document.getElementById('tlcExportStatus');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tlcExportStatus';
      el.style.cssText = 'font-size:11px;padding:4px 8px;border-radius:4px;margin-top:4px;white-space:pre-wrap;word-break:break-word;';
      const dlBtn = document.getElementById('tlcDownloadBtn');
      dlBtn?.parentNode?.insertBefore(el, dlBtn.nextSibling);
    }
    el.textContent = msg;
    el.style.color      = ok === false ? '#ff6b6b' : ok === true ? '#4caf80' : 'rgba(255,255,255,.6)';
    el.style.background = ok === false ? 'rgba(255,107,107,.08)' : 'transparent';
  }

  function _validateFCPXML(xmlStr, events, fps) {
    const errs = [];
    const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
    if (doc.querySelector('parsererror')) {
      errs.push('XML parse error: ' + (doc.querySelector('parsererror')?.textContent || 'malformed XML').slice(0, 120));
      return errs;
    }
    if (!doc.querySelector('fcpxml resources')) errs.push('Missing <resources> block.');
    if (!doc.querySelector('fcpxml sequence'))  errs.push('Missing <sequence> element.');

    const seqEl = doc.querySelector('sequence');
    if (seqEl) {
      const fmt = seqEl.getAttribute('tcFormat');
      if (fmt === 'DF' && !_isDropFrameCapable(fps)) {
        errs.push(`tcFormat="DF" on sequence but fps ${fps} is not drop-frame capable (only 29.97/59.94 support DF).`);
      }
    }

    doc.querySelectorAll('asset').forEach(a => {
      const fmt = a.getAttribute('tcFormat');
      if (fmt === 'DF' && !_isDropFrameCapable(fps)) {
        errs.push(`Asset "${a.getAttribute('name')}" has tcFormat="DF" for non-DF fps.`);
      }
    });

    const spineItems = doc.querySelectorAll('spine > asset-clip, spine > gap');
    spineItems.forEach(el => {
      if (!el.hasAttribute('offset')) {
        errs.push(`<${el.tagName} name="${el.getAttribute('name') || '?'}"> in spine is missing offset attribute.`);
      }
    });

    const assetEls = doc.querySelectorAll('asset[start]');
    let allZeroStart = assetEls.length > 0;
    assetEls.forEach(a => { if (a.getAttribute('start') !== '0s') allZeroStart = false; });
    if (allZeroStart && assetEls.length > 0) {
      const hasNonZeroSrcIn = (events || []).some(ev => {
        const f = tcToFrames(ev?.srcIn || '', Math.round(Number(fps) || 24));
        return f > 0;
      });
      if (hasNonZeroSrcIn) errs.push('All asset start times are 0s but events have non-zero source TC — source TC may be lost.');
    }

    doc.querySelectorAll('asset[src]').forEach(a => {
      const src = a.getAttribute('src') || '';
      if (/^file:\/\/[^/]/.test(src) && !src.startsWith('file://localhost')) {
        errs.push(`Asset "${a.getAttribute('name')}" has invalid file URL: ${src.slice(0, 80)}`);
      }
    });

    return errs;
  }

  function _validateAAFXML(xmlStr, events, fps) {
    const errs = [];
    const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
    if (doc.querySelector('parsererror')) {
      errs.push('XML parse error: ' + (doc.querySelector('parsererror')?.textContent || 'malformed').slice(0, 120));
      return errs;
    }
    const root = doc.documentElement;
    if (root.tagName !== 'AAFMetadataPreview') {
      errs.push('Root element must be <AAFMetadataPreview>.');
    }
    if (root.getAttribute('realAAF') !== 'false') {
      errs.push('AAFMetadataPreview must have realAAF="false".');
    }
    if (root.getAttribute('generatedBy') !== 'PostFlowX') {
      errs.push('Missing generatedBy="PostFlowX" on root element.');
    }
    return errs;
  }

  async function _download() {
    if (!_lastContent) _generate();
    const proj = (getProjectName() || 'timeline').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const ext = FORMAT_EXT[_activeFormat] || _activeFormat;

    // AAF native: send to Native Helper and download binary .aaf.
    if (_activeFormat === 'aaf_nle_linked') {
      await exportAAFNative('nle_linked');
      return;
    }
    if (_activeFormat === 'aaf_protools_audio') {
      await exportAAFNative('protools_audio');
      return;
    }
    // Validate FCPXML / FCPXMLD before writing.
    if (_activeFormat === 'fcpxml' || _activeFormat === 'fcpxmld') {
      const errs = _validateFCPXML(_lastContent, getEvents(), getFps());
      if (errs.length) {
        _setExportStatus('Export blocked — validation errors:\n' + errs.map(e => '• ' + e).join('\n'), false);
        const preview = document.getElementById('tlcPreview');
        if (preview) preview.value = '<!-- VALIDATION ERRORS — fix before exporting -->\n' +
          errs.map(e => '<!-- ' + e + ' -->').join('\n') + '\n\n' + _lastContent;
        return;
      }
      _setExportStatus('');
    }

    // FCPXMLD is a package folder. Write <name>.fcpxmld/Info.fcpxml and
    // <name>.fcpxmld/CurrentVersion.fcpxmld/Info.fcpxml for full FCP compatibility.
    if (_activeFormat === 'fcpxmld' && window.showDirectoryPicker) {
      try {
        const root = await window.showDirectoryPicker({ mode: 'readwrite' });
        const pkg  = await root.getDirectoryHandle(`${proj}_pfx.fcpxmld`, { create: true });

        const fh = await pkg.getFileHandle('Info.fcpxml', { create: true });
        const wr = await fh.createWritable();
        await wr.write(_lastContent);
        await wr.close();

        const cvDir = await pkg.getDirectoryHandle('CurrentVersion.fcpxmld', { create: true });
        const cvFh  = await cvDir.getFileHandle('Info.fcpxml', { create: true });
        const cvWr  = await cvFh.createWritable();
        await cvWr.write(_lastContent);
        await cvWr.close();

        _setExportStatus(`Saved ${proj}_pfx.fcpxmld package.`, true);
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
        // fall through to single-file fallback
      }
    }

    // FCPXMLD fallback: save as .fcpxml with a clear notice.
    const suggestedName = _activeFormat === 'fcpxmld' ? `${proj}_pfx.fcpxml` : `${proj}_pfx.${ext}`;
    if (_activeFormat === 'fcpxmld') {
      _setExportStatus('Browser cannot create an FCPXMLD package here. Saved FCPXML fallback.', null);
    }

    if (window.showSaveFilePicker) {
      try {
        const acceptExt = _activeFormat === 'fcpxmld' ? '.fcpxml' : `.${ext}`;
        const opts = {
          suggestedName,
          types: [{ description: 'Timeline file', accept: { 'text/plain': [acceptExt] } }],
        };
        if (_tlcSourceFileHandle && _activeFormat !== 'fcpxmld') opts.startIn = _tlcSourceFileHandle;
        const fh = await window.showSaveFilePicker(opts);
        const writable = await fh.createWritable();
        await writable.write(_lastContent);
        await writable.close();
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }

    const blob = new Blob([_lastContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function _copy() {
    if (!_lastContent) _generate();
    navigator.clipboard.writeText(_lastContent).catch(() => {
      const ta = document.getElementById('tlcPreview');
      if (ta) { ta.select(); document.execCommand('copy'); }
    });
    const btn = document.getElementById('tlcCopyBtn');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    }
  }

  // ── Import logic ─────────────────────────────────────────────────────────

  function _setImportStatus(msg, ok) {
    const el = document.getElementById('tlcImportStatus');
    if (!el) return;
    el.textContent = msg;
    el.style.color = ok === false ? '#ff6b6b' : ok === true ? '#4caf80' : 'rgba(255,255,255,.5)';
  }

  function _handleImportFiles(files) {
    if (!files || !files.length) return;
    const supported = Array.from(files).filter(f => /\.(edl|fcpxml|fcpxmld|xml|otio|otioz|json|aaf|ale|prproj)$/i.test(f.name));
    if (!supported.length) {
      _setImportStatus('Unsupported file type. Use .edl, .fcpxml, .fcpxmld, .xml, .otio, .otioz, .aaf, .ale, or .prproj', false);
      return;
    }
    const parseFn = window.__MPS_parseFromFiles;
    if (typeof parseFn !== 'function') {
      _setImportStatus('Parser not ready — try reloading the extension.', false);
      return;
    }
    _setImportStatus(`Loading ${supported[0].name}…`);
    const dz = document.getElementById('tlcDropZone');
    if (dz) dz.style.borderColor = 'rgba(110,168,240,.5)';
    parseFn(supported).then(parsed => {
      if (!parsed?.events?.length) {
        _setImportStatus('No events found in file.', false);
        if (dz) dz.style.borderColor = 'rgba(255,107,107,.5)';
        return;
      }
      // Store locally — does NOT affect Pull Prep state
      _tlcLocalEvents      = parsed.events;
      _tlcLocalProjectName = parsed.projectName || supported[0].name.replace(/\.[^.]+$/, '');
      _tlcLocalFps         = parseFloat(parsed.fps) || 24;
      // Auto-detect best output format from input extension
      const detected = _autoDetectFormat(supported[0].name);
      if (detected) { _activeFormat = detected; _tlcAutoDetectedFormat = detected; }
      else            _tlcAutoDetectedFormat = null;
      // Extract root path suggestions from file paths in the timeline
      _tlcSuggestedRoots = _extractRootSuggestions(parsed.events);
      // Restore saved per-project settings (overrides auto-detect if project was used before)
      _loadSettings(_tlcLocalProjectName);
      _setImportStatus(`Loaded: ${supported[0].name}`, true);
      if (dz) dz.style.borderColor = 'rgba(76,175,128,.5)';
      // Switch back to export so user can immediately convert
      setTimeout(() => { _setMode('export'); _tlcSyncDomFromState(); _renderExport(); }, 800);
    }).catch(err => {
      _setImportStatus(`Error: ${err?.message || String(err)}`, false);
      if (dz) dz.style.borderColor = 'rgba(255,107,107,.5)';
    });
  }

  // ── Mode switching ───────────────────────────────────────────────────────

  function _setMode(mode) {
    _mode = mode;
    const exportPane = document.getElementById('tlcExportPane');
    const importPane = document.getElementById('tlcImportPane');
    const modeImp = document.getElementById('tlcModeImport');
    const copyBtn = document.getElementById('tlcCopyBtn');
    const dlBtn   = document.getElementById('tlcDownloadBtn');

    if (exportPane) exportPane.style.display = mode === 'export' ? 'flex' : 'none';
    if (importPane) importPane.style.display = mode === 'import' ? 'flex' : 'none';
    if (modeImp)    modeImp.classList.toggle('active', mode === 'import');
    if (copyBtn)    copyBtn.style.display = mode === 'export' ? '' : 'none';
    if (dlBtn)      dlBtn.style.display   = mode === 'export' ? '' : 'none';

    if (mode === 'import') {
      _setImportStatus('Drop a timeline file or browse…');
      const dz = document.getElementById('tlcDropZone');
      if (dz) dz.style.borderColor = '';
    }
  }

  // ── Open / close ─────────────────────────────────────────────────────────

  function _readReelMode() {
    const r = document.querySelector('input[name="tlcReelMode"]:checked');
    return r ? r.value : 'orig';
  }

  function _readOptions() {
    // Structure mode
    const sm = document.querySelector('input[name="tlcStructMode"]:checked');
    _structureMode = sm ? sm.value : 'preserve';

    // Reel source (new dropdown supersedes old radio)
    const rs = document.getElementById('tlcReelSource');
    if (rs) {
      _reelSource = rs.value || 'orig';
    } else {
      // fallback: map old radio to new source
      const rm = _readReelMode();
      _reelSource = rm === 'clip' ? 'clipname' : rm === 'file' ? 'filename' : 'orig';
    }
    _reelMode = _reelSource; // keep backward compat

    // Reel opts
    _reelOpts = {
      noExt:        !!(document.getElementById('tlcOptNoExt')?.checked),
      forceUpper:   !!(document.getElementById('tlcOptUpper')?.checked),
      trim8:        !!(document.getElementById('tlcOptTrim8')?.checked),
      origComment:  !!(document.getElementById('tlcOptOrigComment')?.checked),
      regexPattern:  (document.getElementById('tlcReelRegex')?.value || '').trim(),
    };

    // Flat filter opts
    const fsEl = document.getElementById('tlcFlatSrc');
    _flatOpts = {
      srcFilter:   fsEl ? fsEl.value : 'ocf',
      exclGfx:     !!(document.getElementById('tlcFlatExclGfx')?.checked),
      exclTemp:    !!(document.getElementById('tlcFlatExclTemp')?.checked),
      keepMarker:  !!(document.getElementById('tlcFlatKeepMarker')?.checked),
    };

    // Show/hide flat filter panel
    const flatPanel = document.getElementById('tlcFlatFilter');
    if (flatPanel) flatPanel.style.display = _structureMode === 'flat' ? 'flex' : 'none';

    // Show/hide regex input
    const regexInp = document.getElementById('tlcReelRegex');
    if (regexInp) regexInp.style.display = _reelSource === 'regex' ? '' : 'none';
  }

  function openTimelineConvert(initialMode) {
    _reelMode = _readReelMode();
    _readOptions();
    _loadSettings(getProjectName());
    _tlcSyncDomFromState();
    const hasData = !!getEvents().length;
    _setMode(initialMode || (hasData ? 'export' : 'import'));
    if (_mode === 'export') _renderExport();
    if (typeof window.setMainTab === 'function') window.setMainTab('tlconvert');
  }

  function _close() {
    if (typeof window.setMainTab === 'function') window.setMainTab('home');
  }

  // ── Tutorial i18n ────────────────────────────────────────────────────────

  const _TLC_I18N = {
    eng: {
      title: 'Timeline Convert — How to Use',
      s1_h: 'Overview',
      s1_p: 'Timeline Convert converts your edit timeline between professional interchange formats. Load a timeline in PostFlowX, open this tool, and export or import in the format your NLE or pipeline needs.',
      s2_h: 'Export a Timeline',
      s2_steps: [
        'Open a project in PostFlowX so the timeline is loaded.',
        'Click the <b>Timeline Convert</b> button to open this panel.',
        'Pick an output format using the tabs at the top of the panel.',
        'Adjust <b>Reel Name</b> mode if needed (Original / Clip Name / File Name).',
        'Click <b>Copy</b> to copy to clipboard, or <b>Download</b> to save as a file.',
      ],
      s2_tip: 'The preview pane updates live as you switch formats or reel modes.',
      s3_h: 'Supported Output Formats',
      s3_edl:    'EDL 32 — CMX 3600 cut list. Industry standard for offline/online conform. 32-char reel limit.',
      s3_otio:   'OTIO — OpenTimelineIO JSON. For DaVinci Resolve, Flame, and pipeline tools.',
      s3_fcpxml:  'FCPXML — Final Cut Pro X native. Full event/clip metadata, markers.',
      s3_fcpxmld: 'FCPXML DTD — Legacy Final Cut Pro 7 XML format for older workflows.',
      s3_xml:    'FCP7 XML — Final Cut Pro 7 sequence XML. Compatible with Premiere via import.',
      s3_aaf:    'AAF — Advanced Authoring Format for Avid Media Composer. Full MobID + tape descriptors.',
      s4_h: 'Reel Name Options',
      s4_p: 'Controls how the reel/tape name is written into the exported file.',
      s4_reel: 'Original',
      s4_reel_d: 'Use the reel name stored in the event data (default).',
      s4_clip: 'Clip Name',
      s4_clip_d: 'Use the clip name — useful when reel names are missing or inconsistent.',
      s4_file: 'File Name',
      s4_file_d: 'Use the source file name (without extension) as the reel ID.',
      s4_tip: 'For EDL exports, reel names are truncated to 32 characters to comply with CMX 3600.',
      s5_h: 'Import a Timeline',
      s5_p: 'Switch to Import mode to read an existing timeline file back into PostFlowX.',
      s5_ul: [
        'Click the <b>IMPORT</b> button in the toolbar to switch to import mode.',
        'Drag & drop a file onto the drop zone, or click <b>Browse</b> to pick one.',
        'Supported import formats: <b>.edl, .fcpxml, .fcpxmld, .xml, .otio, .otioz, .aaf, .ale, .prproj</b>',
        'After import the timeline loads into the PostFlowX viewer automatically.',
      ],
      s5_tip: 'AAF import is supported through the PostFlowX AAF parser. Pro Tools binary AAF with embedded audio still requires the native helper/AAF SDK export.',
    },
    th: {
      title: 'Timeline Convert — วิธีใช้',
      s1_h: 'ภาพรวม',
      s1_p: 'Timeline Convert แปลง timeline ระหว่างฟอร์แมตมาตรฐานวิชาชีพ โหลด timeline ใน PostFlowX แล้วเปิดเครื่องมือนี้เพื่อ export หรือ import ในฟอร์แมตที่ NLE หรือ pipeline ต้องการ',
      s2_h: 'Export Timeline',
      s2_steps: [
        'เปิดโปรเจกต์ใน PostFlowX เพื่อให้โหลด timeline',
        'คลิก <b>Timeline Convert</b> เพื่อเปิดแผงนี้',
        'เลือกฟอร์แมตผลลัพธ์โดยใช้แท็บที่ด้านบนของแผง',
        'ปรับโหมด <b>Reel Name</b> ตามต้องการ (Original / Clip Name / File Name)',
        'คลิก <b>Copy</b> เพื่อคัดลอก หรือ <b>Download</b> เพื่อบันทึกเป็นไฟล์',
      ],
      s2_tip: 'หน้าต่างแสดงผลจะอัปเดตแบบเรียลไทม์เมื่อเปลี่ยนฟอร์แมตหรือโหมด Reel',
      s3_h: 'ฟอร์แมต Output ที่รองรับ',
      s3_edl:    'EDL 32 — CMX 3600 cut list มาตรฐานอุตสาหกรรมสำหรับการ conform จำกัดชื่อ reel 32 ตัวอักษร',
      s3_otio:   'OTIO — OpenTimelineIO JSON สำหรับ DaVinci Resolve, Flame และเครื่องมือ pipeline',
      s3_fcpxml:  'FCPXML — ฟอร์แมตดั้งเดิมของ Final Cut Pro X รองรับ metadata และ marker',
      s3_fcpxmld: 'FCPXML DTD — Final Cut Pro 7 XML สำหรับ workflow รุ่นเก่า',
      s3_xml:    'FCP7 XML — sequence XML ของ Final Cut Pro 7 เข้ากันได้กับ Premiere',
      s3_aaf:    'AAF — Advanced Authoring Format สำหรับ Avid Media Composer พร้อม MobID ครบถ้วน',
      s4_h: 'ตัวเลือก Reel Name',
      s4_p: 'ควบคุมวิธีการเขียนชื่อ reel/tape ลงในไฟล์ที่ export',
      s4_reel: 'Original',
      s4_reel_d: 'ใช้ชื่อ reel ที่เก็บอยู่ใน event data (ค่าเริ่มต้น)',
      s4_clip: 'Clip Name',
      s4_clip_d: 'ใช้ชื่อ clip — เหมาะเมื่อชื่อ reel ขาดหายหรือไม่สม่ำเสมอ',
      s4_file: 'File Name',
      s4_file_d: 'ใช้ชื่อไฟล์ต้นทาง (ไม่รวมนามสกุล) เป็น reel ID',
      s4_tip: 'สำหรับการ export EDL ชื่อ reel จะถูกตัดให้เหลือ 32 ตัวอักษรตามมาตรฐาน CMX 3600',
      s5_h: 'Import Timeline',
      s5_p: 'สลับไปที่โหมด Import เพื่ออ่านไฟล์ timeline ที่มีอยู่กลับเข้า PostFlowX',
      s5_ul: [
        'คลิกปุ่ม <b>IMPORT</b> ในแถบเครื่องมือเพื่อสลับไปโหมด import',
        'ลากและวางไฟล์ลงใน drop zone หรือคลิก <b>Browse</b> เพื่อเลือกไฟล์',
        'ฟอร์แมต import ที่รองรับ: <b>.edl, .fcpxml, .fcpxmld, .xml, .otio, .otioz, .aaf, .ale, .prproj</b>',
        'หลังจาก import timeline จะโหลดเข้า PostFlowX viewer โดยอัตโนมัติ',
      ],
      s5_tip: 'รองรับ AAF import ผ่าน parser ของ PostFlowX แล้ว แต่ Pro Tools AAF แบบ binary/embedded audio ต้องใช้ native helper/AAF SDK export',
    },
    jp: {
      title: 'Timeline Convert — 使い方',
      s1_h: '概要',
      s1_p: 'Timeline Convert はタイムラインをプロ用交換フォーマット間で変換します。PostFlowX でプロジェクトを開き、このツールで NLE やパイプラインに必要なフォーマットへエクスポート・インポートできます。',
      s2_h: 'タイムラインのエクスポート',
      s2_steps: [
        'PostFlowX でプロジェクトを開いてタイムラインを読み込みます。',
        '<b>Timeline Convert</b> ボタンをクリックしてパネルを開きます。',
        'パネル上部のタブで出力フォーマットを選択します。',
        '必要に応じて <b>Reel Name</b> モードを調整します（Original / Clip Name / File Name）。',
        '<b>Copy</b> でクリップボードにコピー、または <b>Download</b> でファイル保存します。',
      ],
      s2_tip: 'フォーマットやリールモードを切り替えると、プレビューがリアルタイムで更新されます。',
      s3_h: '対応出力フォーマット',
      s3_edl:    'EDL 32 — CMX 3600 カットリスト。オフライン/オンラインコンフォームの業界標準。リール名32文字制限。',
      s3_otio:   'OTIO — OpenTimelineIO JSON。DaVinci Resolve、Flame、パイプラインツール向け。',
      s3_fcpxml:  'FCPXML — Final Cut Pro X ネイティブ形式。イベント/クリップメタデータ、マーカー対応。',
      s3_fcpxmld: 'FCPXML DTD — 旧 Final Cut Pro 7 XML（レガシーワークフロー用）。',
      s3_xml:    'FCP7 XML — Final Cut Pro 7 シーケンス XML。Premiere からインポート可能。',
      s3_aaf:    'AAF — Avid Media Composer 向け Advanced Authoring Format。MobID・テープ記述子完全対応。',
      s4_h: 'リール名オプション',
      s4_p: 'エクスポートファイルへのリール/テープ名の記述方式を制御します。',
      s4_reel: 'Original',
      s4_reel_d: 'イベントデータに保存されたリール名を使用（デフォルト）。',
      s4_clip: 'Clip Name',
      s4_clip_d: 'クリップ名を使用 — リール名が欠落または不統一の場合に有効。',
      s4_file: 'File Name',
      s4_file_d: 'ソースファイル名（拡張子なし）をリール ID として使用。',
      s4_tip: 'EDL エクスポートでは CMX 3600 仕様に準拠するため、リール名は32文字に切り詰められます。',
      s5_h: 'タイムラインのインポート',
      s5_p: 'Import モードに切り替えて、既存のタイムラインファイルを PostFlowX に読み込みます。',
      s5_ul: [
        'ツールバーの <b>IMPORT</b> ボタンをクリックしてインポートモードに切り替えます。',
        'ドロップゾーンにファイルをドラッグ＆ドロップ、または <b>Browse</b> でファイルを選択します。',
        '対応インポート形式: <b>.edl, .fcpxml, .fcpxmld, .xml, .otio, .otioz, .aaf, .ale, .prproj</b>',
        'インポート後、タイムラインは PostFlowX ビューアに自動的に読み込まれます。',
      ],
      s5_tip: 'AAF インポートは PostFlowX AAF parser で対応します。Pro Tools 用の binary/embedded audio AAF は native helper/AAF SDK export が必要です。',
    },
    id: {
      title: 'Timeline Convert — Cara Penggunaan',
      s1_h: 'Gambaran Umum',
      s1_p: 'Timeline Convert mengonversi timeline edit antara format pertukaran profesional. Muat timeline di PostFlowX, buka alat ini, lalu ekspor atau impor dalam format yang dibutuhkan NLE atau pipeline Anda.',
      s2_h: 'Ekspor Timeline',
      s2_steps: [
        'Buka proyek di PostFlowX agar timeline termuat.',
        'Klik tombol <b>Timeline Convert</b> untuk membuka panel ini.',
        'Pilih format output menggunakan tab di bagian atas panel.',
        'Sesuaikan mode <b>Reel Name</b> jika perlu (Original / Clip Name / File Name).',
        'Klik <b>Copy</b> untuk salin ke clipboard, atau <b>Download</b> untuk simpan sebagai file.',
      ],
      s2_tip: 'Panel pratinjau diperbarui secara langsung saat Anda mengganti format atau mode reel.',
      s3_h: 'Format Output yang Didukung',
      s3_edl:    'EDL 32 — Daftar potongan CMX 3600. Standar industri untuk offline/online conform. Batas reel 32 karakter.',
      s3_otio:   'OTIO — OpenTimelineIO JSON. Untuk DaVinci Resolve, Flame, dan alat pipeline.',
      s3_fcpxml:  'FCPXML — Format native Final Cut Pro X. Metadata event/klip lengkap, penanda.',
      s3_fcpxmld: 'FCPXML DTD — Format XML Final Cut Pro 7 lama untuk workflow lawas.',
      s3_xml:    'FCP7 XML — Sequence XML Final Cut Pro 7. Kompatibel dengan Premiere melalui impor.',
      s3_aaf:    'AAF — Advanced Authoring Format untuk Avid Media Composer. MobID penuh + deskriptor kaset.',
      s4_h: 'Opsi Nama Reel',
      s4_p: 'Mengontrol cara nama reel/tape ditulis ke dalam file yang diekspor.',
      s4_reel: 'Original',
      s4_reel_d: 'Gunakan nama reel yang tersimpan di data event (default).',
      s4_clip: 'Clip Name',
      s4_clip_d: 'Gunakan nama klip — berguna saat nama reel hilang atau tidak konsisten.',
      s4_file: 'File Name',
      s4_file_d: 'Gunakan nama file sumber (tanpa ekstensi) sebagai ID reel.',
      s4_tip: 'Untuk ekspor EDL, nama reel dipotong menjadi 32 karakter sesuai CMX 3600.',
      s5_h: 'Impor Timeline',
      s5_p: 'Beralih ke mode Import untuk membaca file timeline yang ada kembali ke PostFlowX.',
      s5_ul: [
        'Klik tombol <b>IMPORT</b> di toolbar untuk beralih ke mode impor.',
        'Seret & letakkan file ke drop zone, atau klik <b>Browse</b> untuk memilih file.',
        'Format impor yang didukung: <b>.edl, .fcpxml, .fcpxmld, .xml, .otio, .otioz, .aaf, .ale, .prproj</b>',
        'Setelah impor, timeline dimuat ke penampil PostFlowX secara otomatis.',
      ],
      s5_tip: 'Impor AAF tidak didukung — gunakan ekspor saja untuk file AAF.',
    },
    kr: {
      title: 'Timeline Convert — 사용 방법',
      s1_h: '개요',
      s1_p: 'Timeline Convert는 편집 타임라인을 전문 교환 포맷 간에 변환합니다. PostFlowX에서 타임라인을 불러온 후 이 도구를 열어 NLE 또는 파이프라인에 필요한 포맷으로 내보내거나 가져올 수 있습니다.',
      s2_h: '타임라인 내보내기',
      s2_steps: [
        'PostFlowX에서 프로젝트를 열어 타임라인을 불러옵니다.',
        '<b>Timeline Convert</b> 버튼을 클릭하여 이 패널을 엽니다.',
        '패널 상단의 탭을 사용하여 출력 포맷을 선택합니다.',
        '필요에 따라 <b>Reel Name</b> 모드를 조정합니다 (Original / Clip Name / File Name).',
        '<b>Copy</b>를 클릭하여 클립보드에 복사하거나 <b>Download</b>로 파일을 저장합니다.',
      ],
      s2_tip: '포맷이나 릴 모드를 전환하면 미리보기 창이 실시간으로 업데이트됩니다.',
      s3_h: '지원 출력 포맷',
      s3_edl:    'EDL 32 — CMX 3600 컷 리스트. 오프라인/온라인 컨폼의 업계 표준. 릴 이름 32자 제한.',
      s3_otio:   'OTIO — OpenTimelineIO JSON. DaVinci Resolve, Flame 및 파이프라인 도구용.',
      s3_fcpxml:  'FCPXML — Final Cut Pro X 네이티브 포맷. 이벤트/클립 메타데이터, 마커 완전 지원.',
      s3_fcpxmld: 'FCPXML DTD — 구 Final Cut Pro 7 XML 포맷 (레거시 워크플로우용).',
      s3_xml:    'FCP7 XML — Final Cut Pro 7 시퀀스 XML. Premiere로 가져오기 호환.',
      s3_aaf:    'AAF — Avid Media Composer용 Advanced Authoring Format. 전체 MobID + 테이프 디스크립터.',
      s4_h: '릴 이름 옵션',
      s4_p: '내보낸 파일에 릴/테이프 이름이 작성되는 방식을 제어합니다.',
      s4_reel: 'Original',
      s4_reel_d: '이벤트 데이터에 저장된 릴 이름 사용 (기본값).',
      s4_clip: 'Clip Name',
      s4_clip_d: '클립 이름 사용 — 릴 이름이 없거나 일관성이 없을 때 유용.',
      s4_file: 'File Name',
      s4_file_d: '소스 파일 이름 (확장자 제외)을 릴 ID로 사용.',
      s4_tip: 'EDL 내보내기 시 CMX 3600 규격 준수를 위해 릴 이름은 32자로 잘립니다.',
      s5_h: '타임라인 가져오기',
      s5_p: 'Import 모드로 전환하여 기존 타임라인 파일을 PostFlowX로 불러옵니다.',
      s5_ul: [
        '툴바의 <b>IMPORT</b> 버튼을 클릭하여 가져오기 모드로 전환합니다.',
        '드롭 존에 파일을 드래그 앤 드롭하거나 <b>Browse</b>를 클릭하여 파일을 선택합니다.',
        '지원 가져오기 포맷: <b>.edl, .fcpxml, .fcpxmld, .xml, .otio, .otioz, .aaf, .ale, .prproj</b>',
        '가져오기 후 타임라인이 자동으로 PostFlowX 뷰어에 로드됩니다.',
      ],
      s5_tip: 'AAF 가져오기는 PostFlowX AAF parser를 통해 지원됩니다. Pro Tools binary/embedded audio AAF는 native helper/AAF SDK export가 필요합니다.',
    },
    ph: {
      title: 'Timeline Convert — Paano Gamitin',
      s1_h: 'Pangkalahatang-ideya',
      s1_p: 'Kino-convert ng Timeline Convert ang iyong edit timeline sa pagitan ng mga propesyonal na interchange format. Mag-load ng timeline sa PostFlowX, buksan ang tool na ito, at i-export o i-import sa format na kailangan ng iyong NLE o pipeline.',
      s2_h: 'Mag-export ng Timeline',
      s2_steps: [
        'Buksan ang isang proyekto sa PostFlowX para ma-load ang timeline.',
        'I-click ang <b>Timeline Convert</b> para buksan ang panel na ito.',
        'Piliin ang output format gamit ang mga tab sa itaas ng panel.',
        'I-adjust ang <b>Reel Name</b> mode kung kinakailangan (Original / Clip Name / File Name).',
        'I-click ang <b>Copy</b> para kopyahin sa clipboard, o <b>Download</b> para i-save bilang file.',
      ],
      s2_tip: 'Ang preview panel ay nag-a-update nang live habang nagpapalit ka ng format o reel mode.',
      s3_h: 'Mga Sinusuportahang Output Format',
      s3_edl:    'EDL 32 — CMX 3600 cut list. Pamantayan ng industriya para sa offline/online conform. Limitasyon sa reel: 32 karakter.',
      s3_otio:   'OTIO — OpenTimelineIO JSON. Para sa DaVinci Resolve, Flame, at mga pipeline tool.',
      s3_fcpxml:  'FCPXML — Native na format ng Final Cut Pro X. Buong event/clip metadata at markers.',
      s3_fcpxmld: 'FCPXML DTD — Legacy na Final Cut Pro 7 XML format para sa mas lumang workflow.',
      s3_xml:    'FCP7 XML — Sequence XML ng Final Cut Pro 7. Compatible sa Premiere sa pamamagitan ng import.',
      s3_aaf:    'AAF — Advanced Authoring Format para sa Avid Media Composer. Buong MobID + tape descriptors.',
      s4_h: 'Mga Opsyon ng Reel Name',
      s4_p: 'Kinokontrol kung paano isinusulat ang reel/tape name sa na-export na file.',
      s4_reel: 'Original',
      s4_reel_d: 'Gamitin ang reel name na nakaimbak sa event data (default).',
      s4_clip: 'Clip Name',
      s4_clip_d: 'Gamitin ang clip name — kapaki-pakinabang kapag nawawala o hindi consistent ang mga reel name.',
      s4_file: 'File Name',
      s4_file_d: 'Gamitin ang source file name (walang extension) bilang reel ID.',
      s4_tip: 'Para sa EDL export, ang mga reel name ay pinutol sa 32 karakter ayon sa CMX 3600.',
      s5_h: 'Mag-import ng Timeline',
      s5_p: 'Lumipat sa Import mode para basahin ang isang kasalukuyang timeline file pabalik sa PostFlowX.',
      s5_ul: [
        'I-click ang <b>IMPORT</b> button sa toolbar para lumipat sa import mode.',
        'I-drag & drop ang file sa drop zone, o i-click ang <b>Browse</b> para pumili ng file.',
        'Mga sinusuportahang import format: <b>.edl, .fcpxml, .fcpxmld, .xml, .otio, .otioz, .aaf, .ale, .prproj</b>',
        'Pagkatapos ng import, awtomatikong na-load ang timeline sa PostFlowX viewer.',
      ],
      s5_tip: 'Sinusuportahan na ang AAF import gamit ang PostFlowX AAF parser. Kailangan pa rin ng native helper/AAF SDK export para sa Pro Tools binary/embedded audio AAF.',
    },
    tw: {
      title: 'Timeline Convert — 使用說明',
      s1_h: '概覽',
      s1_p: 'Timeline Convert 可將您的剪輯時間軸在專業交換格式之間進行轉換。在 PostFlowX 中載入時間軸，開啟此工具，即可匯出或匯入 NLE 或製作流程所需的格式。',
      s2_h: '匯出時間軸',
      s2_steps: [
        '在 PostFlowX 中開啟專案以載入時間軸。',
        '點擊 <b>Timeline Convert</b> 按鈕開啟此面板。',
        '使用面板頂部的分頁選擇輸出格式。',
        '視需要調整 <b>Reel Name</b> 模式（Original / Clip Name / File Name）。',
        '點擊 <b>Copy</b> 複製到剪貼簿，或點擊 <b>Download</b> 儲存為檔案。',
      ],
      s2_tip: '當您切換格式或 Reel 模式時，預覽窗格會即時更新。',
      s3_h: '支援的輸出格式',
      s3_edl:    'EDL 32 — CMX 3600 剪輯清單。離線/線上套片的業界標準。Reel 名稱限制 32 個字元。',
      s3_otio:   'OTIO — OpenTimelineIO JSON。適用於 DaVinci Resolve、Flame 及流程工具。',
      s3_fcpxml:  'FCPXML — Final Cut Pro X 原生格式。完整的事件/片段詮釋資料及標記。',
      s3_fcpxmld: 'FCPXML DTD — 舊版 Final Cut Pro 7 XML 格式，適用於較舊的工作流程。',
      s3_xml:    'FCP7 XML — Final Cut Pro 7 序列 XML。可透過匯入與 Premiere 相容。',
      s3_aaf:    'AAF — 適用於 Avid Media Composer 的進階製作格式。完整 MobID + 磁帶描述符。',
      s4_h: 'Reel Name 選項',
      s4_p: '控制 Reel/磁帶名稱寫入匯出檔案的方式。',
      s4_reel: 'Original',
      s4_reel_d: '使用儲存在事件資料中的 Reel 名稱（預設）。',
      s4_clip: 'Clip Name',
      s4_clip_d: '使用片段名稱 — 適用於 Reel 名稱遺失或不一致的情況。',
      s4_file: 'File Name',
      s4_file_d: '使用來源檔案名稱（不含副檔名）作為 Reel ID。',
      s4_tip: '匯出 EDL 時，Reel 名稱將依 CMX 3600 規範截斷為 32 個字元。',
      s5_h: '匯入時間軸',
      s5_p: '切換至匯入模式，將現有時間軸檔案讀回 PostFlowX。',
      s5_ul: [
        '點擊工具列中的 <b>IMPORT</b> 按鈕切換至匯入模式。',
        '將檔案拖放至拖放區，或點擊 <b>Browse</b> 選擇檔案。',
        '支援的匯入格式：<b>.edl, .fcpxml, .fcpxmld, .xml, .otio, .otioz, .aaf, .ale, .prproj</b>',
        '匯入後，時間軸將自動載入 PostFlowX 檢視器。',
      ],
      s5_tip: 'AAF 匯入已透過 PostFlowX AAF parser 支援。Pro Tools binary/embedded audio AAF 仍需 native helper/AAF SDK export。',
    },
  };

  function _tlcTutLangGet() {
    return localStorage.getItem('pfxTutLang') || 'eng';
  }

  function _tlcTutLangSet(l) {
    localStorage.setItem('pfxTutLang', l);
  }

  function _tlcTutBodyHtml(t) {
    const exportSteps = t.s2_steps.map(s => `<p>${s}</p>`).join('');
    const importItems = t.s5_ul.map(s => `<p>${s}</p>`).join('');

    return `
<div class="pfx-tut-step">
  <div class="pfx-tut-num">1</div>
  <div class="pfx-tut-content">
    <div class="pfx-tut-step-title">${t.s1_h}</div>
    <p>${t.s1_p}</p>
  </div>
</div>

<div class="pfx-tut-step">
  <div class="pfx-tut-num">2</div>
  <div class="pfx-tut-content">
    <div class="pfx-tut-step-title">${t.s2_h}</div>
    ${exportSteps}
    <div class="pfx-tut-tip">${t.s2_tip}</div>
  </div>
</div>

<div class="pfx-tut-step">
  <div class="pfx-tut-num">3</div>
  <div class="pfx-tut-content">
    <div class="pfx-tut-step-title">${t.s3_h}</div>
    <div class="pfx-tut-grid">
      <span class="pfx-tut-col" style="color:#ffdf7e">EDL 32</span><span>${t.s3_edl}</span>
      <span class="pfx-tut-col" style="color:#7be3d7">OTIO</span><span>${t.s3_otio}</span>
      <span class="pfx-tut-col" style="color:#7bf7b0">FCPXML</span><span>${t.s3_fcpxml}</span>
      <span class="pfx-tut-col" style="color:#7bbeff">FCPXML DTD</span><span>${t.s3_fcpxmld}</span>
      <span class="pfx-tut-col" style="color:#b8a0ff">FCP7 XML</span><span>${t.s3_xml}</span>
      <span class="pfx-tut-col" style="color:#ff9e6c">AAF</span><span>${t.s3_aaf}</span>
    </div>
  </div>
</div>

<div class="pfx-tut-step">
  <div class="pfx-tut-num">4</div>
  <div class="pfx-tut-content">
    <div class="pfx-tut-step-title">${t.s4_h}</div>
    <p>${t.s4_p}</p>
    <div class="pfx-tut-grid">
      <span class="pfx-tut-col">${t.s4_reel}</span><span>${t.s4_reel_d}</span>
      <span class="pfx-tut-col">${t.s4_clip}</span><span>${t.s4_clip_d}</span>
      <span class="pfx-tut-col">${t.s4_file}</span><span>${t.s4_file_d}</span>
    </div>
    <div class="pfx-tut-tip">${t.s4_tip}</div>
  </div>
</div>

<div class="pfx-tut-step">
  <div class="pfx-tut-num">5</div>
  <div class="pfx-tut-content">
    <div class="pfx-tut-step-title">${t.s5_h}</div>
    <p>${t.s5_p}</p>
    ${importItems}
    <div class="pfx-tut-tip">${t.s5_tip}</div>
  </div>
</div>`;
  }

  function _renderTlcTutorial(lang) {
    const t = _TLC_I18N[lang] || _TLC_I18N.eng;
    const titleEl = document.getElementById('tlcTutorialTitleText');
    const bodyEl  = document.getElementById('tlcTutorialBody');
    const selEl   = document.getElementById('tlcTutorialLang');
    if (titleEl) titleEl.textContent = t.title;
    if (bodyEl)  bodyEl.innerHTML = _tlcTutBodyHtml(t);
    if (selEl)   selEl.value = lang;
  }

  // ── Bind ─────────────────────────────────────────────────────────────────

  function _bind() {
    // Export format tabs
    FORMATS.forEach(fmt => {
      const tab = document.getElementById(`tlcTab_${fmt}`);
      if (tab) tab.addEventListener('click', () => { _activeFormat = fmt; _renderExport(); });
    });

    // Reel mode radios
    document.querySelectorAll('input[name="tlcReelMode"]').forEach(r => {
      r.addEventListener('change', () => { _reelMode = _readReelMode(); _renderExport(); });
    });

    // New options controls
    ['tlcStructPreserve','tlcStructFlat'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', () => { _readOptions(); _renderExport(); });
    });
    document.getElementById('tlcReelSource')?.addEventListener('change', () => { _readOptions(); _renderExport(); });
    ['tlcOptNoExt','tlcOptUpper','tlcOptTrim8','tlcOptOrigComment'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', () => { _readOptions(); _renderExport(); });
    });
    document.getElementById('tlcReelRegex')?.addEventListener('input', () => { _readOptions(); _renderExport(); });
    ['tlcFlatSrc'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', () => { _readOptions(); _renderExport(); });
    });
    ['tlcFlatExclGfx','tlcFlatExclTemp','tlcFlatKeepMarker'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', () => { _readOptions(); _renderExport(); });
    });

    // Import toggle — clicking Import switches mode; import pane's back happens after load
    const modeImp = document.getElementById('tlcModeImport');
    if (modeImp) modeImp.addEventListener('click', () => {
      _mode === 'import' ? (_setMode('export'), _renderExport()) : _setMode('import');
    });

    // How to Use
    const helpBtn = document.getElementById('tlcHelpBtn');
    const tutModal = document.getElementById('tlcTutorialModal');
    if (helpBtn && tutModal) {
      helpBtn.addEventListener('click', () => {
        _renderTlcTutorial(_tlcTutLangGet());
        tutModal.style.display = 'flex';
      });
      tutModal.querySelector('.pfx-tutorial-backdrop')?.addEventListener('click', () => { tutModal.style.display = 'none'; });
      tutModal.querySelector('.pfx-tutorial-close')?.addEventListener('click', () => { tutModal.style.display = 'none'; });
      const langSel = document.getElementById('tlcTutorialLang');
      if (langSel) langSel.addEventListener('change', () => {
        _tlcTutLangSet(langSel.value);
        _renderTlcTutorial(langSel.value);
      });
    }

    // Action buttons
    const closeBtn = document.getElementById('tlcClose');
    if (closeBtn) closeBtn.addEventListener('click', _close);
    const copyBtn = document.getElementById('tlcCopyBtn');
    if (copyBtn) copyBtn.addEventListener('click', _copy);
    const dlBtn = document.getElementById('tlcDownloadBtn');
    if (dlBtn) dlBtn.addEventListener('click', _download);

    // Import: browse button + file input
    const browseBtn  = document.getElementById('tlcBrowseBtn');
    const fileInput  = document.getElementById('tlcFileInput');
    const _tlcOpenPicker = async () => {
      if (window.showOpenFilePicker) {
        try {
          const [handle] = await window.showOpenFilePicker({
            types: [{ description: 'Timeline files', accept: { 'text/plain': ['.edl','.fcpxml','.fcpxmld','.xml','.otio','.otioz','.aaf','.ale','.prproj','.json'] } }],
            multiple: false,
          });
          _tlcSourceFileHandle = handle;
          _handleImportFiles([await handle.getFile()]);
          return;
        } catch (e) {
          if (e.name === 'AbortError') return;
        }
      }
      fileInput?.click();
    };
    if (browseBtn && fileInput) {
      browseBtn.addEventListener('click', _tlcOpenPicker);
      fileInput.addEventListener('change', () => {
        _tlcSourceFileHandle = null; // fallback path — no handle available
        _handleImportFiles(fileInput.files);
        fileInput.value = '';
      });
    }

    // Import: drop zone
    const dz = document.getElementById('tlcDropZone');
    if (dz) {
      dz.addEventListener('click', e => {
        if (e.target === dz || e.target.tagName === 'SVG' || e.target.tagName === 'path' ||
            e.target.tagName === 'DIV' || e.target.tagName === 'polyline' || e.target.tagName === 'line') {
          _tlcOpenPicker();
        }
      });
      dz.addEventListener('dragover', e => {
        e.preventDefault();
        dz.style.background = 'rgba(110,168,240,.08)';
        dz.style.borderColor = 'rgba(110,168,240,.5)';
      });
      dz.addEventListener('dragleave', () => {
        dz.style.background = '';
        dz.style.borderColor = '';
      });
      dz.addEventListener('drop', async e => {
        e.preventDefault();
        dz.style.background = '';
        // Try to capture a FileSystemFileHandle from the drop (Chrome 86+)
        const items = Array.from(e.dataTransfer?.items || []);
        if (items.length && typeof items[0].getAsFileSystemHandle === 'function') {
          try {
            const handle = await items[0].getAsFileSystemHandle();
            if (handle && handle.kind === 'file') {
              _tlcSourceFileHandle = handle;
              _handleImportFiles([await handle.getFile()]);
              return;
            }
          } catch (_) {}
        }
        _tlcSourceFileHandle = null;
        _handleImportFiles(e.dataTransfer?.files);
      });
    }

    // Home screen card / quick action dispatches this event to open TL Convert
    window.addEventListener('pfx:open-tl-convert', () => openTimelineConvert());

    // Escape: close TL Convert tab if it is currently active
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        const pane = document.getElementById('main-tlconvert');
        if (pane && pane.style.display !== 'none') _close();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bind);
  } else {
    _bind();
  }

  window.openTimelineConvert = openTimelineConvert;

})();
