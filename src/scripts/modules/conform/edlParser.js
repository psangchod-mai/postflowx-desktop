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

/** Drop-frame rates (29.97 / 59.94). Mirrors conform_lib.fps_is_drop(). */
export function fpsIsDrop(fps) {
  return Math.abs(fps - 29.97) < 0.01 || Math.abs(fps - 59.94) < 0.01;
}

/**
 * SMPTE timecode → frame count. Drop-frame math (ported from conform_lib.parse_tc)
 * is applied when the frame separator is ';' — a ';' authored by the NLE is the
 * authoritative drop-frame marker. Non-drop otherwise.
 */
export function tcToFrames(tc, fps) {
  if (!tc) return 0;
  const m = String(tc).trim().match(/^(\d+):(\d+):(\d+)([:;])(\d+)$/);
  if (!m) return 0;
  const h = +m[1], mi = +m[2], s = +m[3], f = +m[5];
  const isDrop = m[4] === ';';
  if (isDrop) {
    const nominal = Math.round(fps);
    const drop = nominal === 30 ? 2 : 4;   // 30→2/min, 60→4/min
    const totalMin = h * 60 + mi;
    const dropped = drop * (totalMin - Math.floor(totalMin / 10));
    return h * 3600 * nominal + mi * 60 * nominal + s * nominal + f - dropped;
  }
  const rate = fps > 0 ? Math.round(fps) : 24;
  return h * 3600 * rate + mi * 60 * rate + s * rate + f;
}

/**
 * Frame count → SMPTE timecode. Emits drop-frame (';' separator, DF math, ported
 * from conform_lib.frames_to_tc) when fps is a drop rate; non-drop otherwise.
 */
export function framesToTc(frames, fps) {
  frames = Math.max(0, Math.round(frames));
  let sep = ':';
  let rate = fps > 0 ? Math.round(fps) : 24;
  if (fpsIsDrop(fps)) {
    const nominal = Math.round(fps);
    const drop = nominal === 30 ? 2 : 4;
    const framesPerMin = nominal * 60 - drop;
    const framesPer10Min = framesPerMin * 10 + drop;
    const d = Math.floor(frames / framesPer10Min);
    const md = frames % framesPer10Min;
    if (md > drop) {
      frames += (drop * 9 * d) + drop * Math.floor((md - drop) / framesPerMin);
    } else {
      frames += drop * 9 * d;
    }
    sep = ';';
    rate = nominal;
  }
  const f = frames % rate;
  const s = Math.floor(frames / rate) % 60;
  const m = Math.floor(frames / (rate * 60)) % 60;
  const h = Math.floor(frames / (rate * 3600));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(f)}`;
}

// ── CMX3600 EDL ───────────────────────────────────────────────────────────────

export function parseEdl(text, fps = 24) {
  const events = [];
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    // Event line: "<num> <reel> <track> <transition>[ dur] srcIn srcOut recIn recOut".
    // Matches ANY transition (C/D/W/…) and consumes the optional dissolve/wipe
    // duration token, so dissolves and wipes are not silently dropped. Ported to
    // match conform_lib._EVENT_RE.
    const m = line.match(
      /^(\d+)\s+(\S+)\s+(\S+)\s+([A-Z])\s*(?:\d+)?\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/
    );
    if (m) {
      const [, idxStr, reel, track, , srcIn, srcOut, recIn, recOut] = m;
      // Keep video events only (drop audio-only rows like A1/A2). Mirrors
      // parse_edl(video_only=True).
      if (!/V/i.test(track)) { i++; continue; }
      const idx = parseInt(idxStr, 10);
      // Timeline duration comes from the RECORD TCs (authoritative), not the
      // source TCs — source points at WIP masters and is re-resolved by matching.
      const recInF  = tcToFrames(recIn, fps);
      const recOutF = tcToFrames(recOut, fps);
      // Scan next few lines for * [FROM] CLIP NAME (FROM optional, flexible spacing).
      let clipName = reel;
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
        const cm = lines[j].trim().match(/^\*\s*(?:FROM\s+)?CLIP\s+NAME[:\s]+(.+?)\s*$/i);
        if (cm) { clipName = cm[1].trim(); break; }
      }
      events.push({
        index: idx, reel, clipName,
        srcIn, srcOut, recIn, recOut,
        durationFrames: Math.max(0, recOutF - recInF),
        fps, track, comment: '',
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
  const lines = ['TITLE: PFX Conform Export',
    `FCM: ${fpsIsDrop(fps) ? 'DROP FRAME' : 'NON-DROP FRAME'}`, ''];
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
