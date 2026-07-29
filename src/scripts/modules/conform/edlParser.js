/**
 * edlParser.js — Parse EDL / FCP XML / OTIO into a uniform event list.
 *
 * Each ConformEvent:
 * {
 *   index:          number,
 *   reel:           string,
 *   clipName:       string,
 *   srcIn:          string,  // SMPTE TC "HH:MM:SS:FF"
 *   srcOut:         string,
 *   recIn:          string,
 *   recOut:         string,
 *   durationFrames: number,
 *   fps:            number,
 *   track:          string,
 *   comment:        string,
 * }
 */

export function tcToFrames(tc, fps) {
  if (!tc) return 0;
  const parts = tc.replace(';', ':').split(':');
  if (parts.length !== 4) return 0;
  const [h, m, s, f] = parts.map(Number);
  return Math.round(fps) * (h * 3600 + m * 60 + s) + f;
}

export function framesToTc(frames, fps) {
  const ifps = Math.max(1, Math.round(fps));
  const f = frames % ifps;
  const totalSecs = Math.floor(frames / ifps);
  const s = totalSecs % 60;
  const m = Math.floor(totalSecs / 60) % 60;
  const h = Math.floor(totalSecs / 3600);
  return [h, m, s, f].map(n => String(n).padStart(2, '0')).join(':');
}

// ── CMX3600 EDL ───────────────────────────────────────────────────────────────

export function parseEdl(text, fps = 24) {
  const events = [];
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    // Event line: "001  REEL  V  C  srcIn srcOut recIn recOut"
    const m = line.match(
      /^(\d{3,4})\s+(\S+)\s+\S+\s+C\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/
    );
    if (m) {
      const [, idxStr, reel, srcIn, srcOut, recIn, recOut] = m;
      const idx = parseInt(idxStr, 10);
      const fi = tcToFrames(srcIn, fps);
      const fo = tcToFrames(srcOut, fps);
      // Scan next few lines for * FROM CLIP NAME
      let clipName = reel;
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
        const cm = lines[j].trim().match(/^\*\s+FROM CLIP NAME:\s+(.+)/i);
        if (cm) { clipName = cm[1].trim(); break; }
      }
      events.push({
        index: idx, reel, clipName,
        srcIn, srcOut, recIn, recOut,
        durationFrames: Math.max(0, fo - fi),
        fps, track: 'V', comment: '',
      });
    }
    i++;
  }
  return events;
}

// ── FCP 7 XML / FCPXML ────────────────────────────────────────────────────────

export function parseFcpXml(text) {
  const events = [];
  let doc;
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml');
  } catch {
    return events;
  }
  const clipItems = doc.querySelectorAll('clipitem');
  let idx = 1;
  clipItems.forEach(ci => {
    const name     = ci.querySelector(':scope > name')?.textContent?.trim() || `clip_${idx}`;
    const fileEl   = ci.querySelector(':scope > file');
    const reel     = fileEl?.querySelector('name')?.textContent?.trim() || name;
    const rateEl   = ci.querySelector('rate timebase');
    const fps      = rateEl ? parseFloat(rateEl.textContent) || 24 : 24;
    const srcIn    = parseInt(ci.querySelector(':scope > in')?.textContent  || '0', 10);
    const srcOut   = parseInt(ci.querySelector(':scope > out')?.textContent || '0', 10);
    const recIn    = parseInt(ci.querySelector(':scope > start')?.textContent || '0', 10);
    const recOut   = parseInt(ci.querySelector(':scope > end')?.textContent  || '0', 10);
    events.push({
      index: idx++, reel, clipName: name,
      srcIn:  framesToTc(srcIn,  fps),
      srcOut: framesToTc(srcOut, fps),
      recIn:  framesToTc(recIn,  fps),
      recOut: framesToTc(recOut, fps),
      // Timeline duration comes from the RECORD TCs (authoritative), not the
      // source TCs — source points at WIP masters and is re-resolved by
      // matching. See parseEdl above.
      durationFrames: Math.max(0, recOut - recIn),
      fps, track: 'V', comment: '',
    });
  });
  return events;
}

// ── OpenTimelineIO JSON ───────────────────────────────────────────────────────

export function parseOtio(text) {
  const events = [];
  let data;
  try { data = JSON.parse(text); } catch { return events; }
  let idx = 1;
  const tracks = data?.tracks?.children || [];
  for (const track of tracks) {
    if (!(track.OTIO_SCHEMA || '').startsWith('Track')) continue;
    for (const child of (track.children || [])) {
      if (!(child.OTIO_SCHEMA || '').startsWith('Clip')) continue;
      const name = child.name || `clip_${idx}`;
      const sr = child.source_range || {};
      const fps = sr.start_time?.rate || sr.duration?.rate || 24;
      const si  = sr.start_time?.value ?? 0;
      const dur = sr.duration?.value ?? 0;
      events.push({
        index: idx++, reel: name, clipName: name,
        srcIn:  framesToTc(Math.round(si),       fps),
        srcOut: framesToTc(Math.round(si + dur), fps),
        recIn: '', recOut: '',
        durationFrames: Math.round(dur),
        fps, track: 'V', comment: '',
      });
    }
  }
  return events;
}

// ── Auto-detect and parse ─────────────────────────────────────────────────────

export function parseEditText(text, hint = '', fps = 24) {
  const trimmed = text.trimStart();
  let fmt = hint.toLowerCase();
  if (!fmt) {
    if (trimmed.startsWith('<')) fmt = 'fcpxml';
    else if (trimmed.startsWith('{')) fmt = 'otio';
    else fmt = 'edl';
  }
  if (fmt === 'fcpxml' || fmt === 'xml') return parseFcpXml(text);
  if (fmt === 'otio' || fmt === 'json') return parseOtio(text);
  return parseEdl(text, fps);
}

// ── Export helpers ────────────────────────────────────────────────────────────

export function eventsToEdl(events, fps = 24) {
  const lines = ['TITLE: PFX Conform Export', 'FCM: NON-DROP FRAME', ''];
  for (const ev of events) {
    const reel = (ev.reel || 'BL').substring(0, 8).padEnd(8);
    lines.push(`${String(ev.index).padStart(3,'0')}  ${reel}  V  C  ${ev.srcIn} ${ev.srcOut} ${ev.recIn} ${ev.recOut}`);
    if (ev.clipName && ev.clipName !== ev.reel) {
      lines.push(`* FROM CLIP NAME: ${ev.clipName}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
