// scripts/app/core/timelineModel.js
// Shared helpers to keep timeline parsing/layout consistent across tabs.
// - Extracts a stable sequence base (record) start frame when available.
// - Builds a multi-track timeline model from parser events.
// - Optionally expands overlaps into additional visual lanes for readability.

import { tcToFrames } from '../modules/utils_time.js';

function _parseTCStrict(s, fps){
  const m = String(s || '').trim().match(/^(\d{1,4}):(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const f = tcToFrames(`${m[1]}:${m[2]}:${m[3]}:${m[4]}`, fps);
  return Number.isFinite(f) ? f : null;
}

function _isAudioEvent(ev){
  if (!ev) return false;
  const t = String(ev.type || ev.kind || '').toLowerCase();
  const roleRaw = String(ev.role || ev.trackType || '').toLowerCase().trim();
  if (t === 'audio' || t === 'a' || roleRaw === 'audio' || roleRaw === 'a') return true;
  const src = String(ev.srcFile || ev.assetName || ev.clipName || ev.reel || '');
  return /\.(wav|aif|aiff|mp3|m4a|aac|flac)$/i.test(src);
}

function _trackIndex0(ev){
  if (!ev) return 0;
  if (Number.isFinite(+ev.trackIndex)) return Math.max(0, +ev.trackIndex);
  if (Number.isFinite(+ev.track)) return Math.max(0, +ev.track);
  const role = String(ev.role || '').toUpperCase().trim();
  const m = role.match(/^V(\d+)$/);
  if (m) return Math.max(0, (parseInt(m[1], 10) || 1) - 1);
  return 0;
}

export function getSeqBaseFrames(obj, fps = 24){
  try{
    const v = obj?._seqBaseFrames;
    if (Number.isFinite(+v)) return Math.max(0, Math.floor(+v));
  }catch{}
  try{
    const ev0 = obj?.events?.[0];
    const v2 = ev0?._seqBaseFrames;
    if (Number.isFinite(+v2)) return Math.max(0, Math.floor(+v2));
  }catch{}
  // Fallback: derive from earliest recIn
  try{
    const evs = Array.isArray(obj?.events) ? obj.events : (Array.isArray(obj) ? obj : []);
    let minF = Infinity;
    for (const e of evs){
      if (_isAudioEvent(e)) continue;
      const f = _parseTCStrict(e?.recIn, fps);
      if (f != null && f < minF) minF = f;
    }
    if (Number.isFinite(minF) && minF !== Infinity) return Math.max(0, Math.floor(minF));
  }catch{}
  return null;
}

function _allocateOverlapLanes(items, getInOut){
  // Greedy interval partitioning: assigns each item to the earliest lane that doesn't overlap.
  const lanesEnd = []; // lane -> last endF
  const laneItems = []; // lane -> items[]
  for (const it of items){
    const r = getInOut(it);
    if (!r) continue;
    const s = Number(r.inF) || 0;
    const e = Math.max(s + 1, Number(r.outF) || (s + 1));
    let lane = 0;
    while (lane < lanesEnd.length && s < lanesEnd[lane]) lane++;
    if (lane >= lanesEnd.length){
      lanesEnd.push(e);
      laneItems.push([]);
    } else {
      lanesEnd[lane] = Math.max(lanesEnd[lane], e);
    }
    laneItems[lane].push(it);
  }
  return laneItems;
}

export function buildImportedTimelineFromEvents(events, fps = 24, opts = {}){
  const list = Array.isArray(events) ? events : [];
  const hideDisabled = !!opts.hideDisabled;
  const includeAudio = !!opts.includeAudio;
  const explodeOverlaps = (opts.explodeOverlaps === true);
  const seqBaseOpt = opts.seqBaseFrames;
  const seqBase = Number.isFinite(+seqBaseOpt) ? Math.max(0, Math.floor(+seqBaseOpt)) : null;

  const items = [];
  for (let i = 0; i < list.length; i++){
    const e = list[i];
    if (!e || typeof e !== 'object') continue;
    if (!includeAudio && _isAudioEvent(e)) continue;
    if (hideDisabled && e.disabled) continue;

    const inF = _parseTCStrict(e.recIn, fps);
    const outF = _parseTCStrict(e.recOut, fps);
    if (inF == null || outF == null) continue;
    if (outF <= inF) continue;

    const tr0 = _trackIndex0(e);
    const clipName = String(e.clipName || e.reel || e.srcFile || 'CLIP');
    const reel = String(e.reel || '');

    items.push({
      eventIndex: i,
      inF,
      outF,
      clipName,
      reel,
      label: clipName,
      srcIn: e.srcIn || '',
      srcOut: e.srcOut || '',
      srcFile: e.srcFile || '',
      trackRaw: tr0,
      disabled: !!e.disabled,
    });
  }

  let baseFrames = Infinity;
  let endFrames = 0;
  for (const it of items){
    if (it.inF < baseFrames) baseFrames = it.inF;
    if (it.outF > endFrames) endFrames = it.outF;
  }
  if (!Number.isFinite(baseFrames) || baseFrames === Infinity) baseFrames = 0;
  if (seqBase != null) baseFrames = seqBase;
  const durationFrames = Math.max(1, endFrames - (seqBase != null ? Math.min(seqBase, endFrames) : baseFrames));

  // Group by raw track
  const byRaw = new Map();
  for (const it of items){
    const k = it.trackRaw || 0;
    if (!byRaw.has(k)) byRaw.set(k, []);
    byRaw.get(k).push(it);
  }
  // Sort within raw track
  for (const [k, arr] of byRaw.entries()){
    arr.sort((a,b)=> (a.inF - b.inF) || (a.outF - b.outF));
    byRaw.set(k, arr);
  }
  // Tracks (Resolve-style by default):
  // - When explodeOverlaps=false (default), keep the parser's raw track indices (V1/V2/...).
  // - When explodeOverlaps=true, stack overlaps into additional visual lanes per raw track.
  const tracks = [];
  const rawKeys = Array.from(byRaw.keys()).sort((a,b)=>a-b);

  if (!explodeOverlaps){
    for (const rk of rawKeys){
      const arr = byRaw.get(rk) || [];
      tracks.push({ trackIndex: Number(rk) || 0, items: arr });
    }
  } else {
    let vBase = 0;
    for (const rk of rawKeys){
      const arr = byRaw.get(rk) || [];
      const laneBuckets = _allocateOverlapLanes(arr, (x)=>({ inF:x.inF, outF:x.outF }));
      for (let li = 0; li < laneBuckets.length; li++){
        const laneItems = laneBuckets[li] || [];
        const trackIndex = vBase + li;
        tracks.push({ trackIndex, items: laneItems });
      }
      vBase += Math.max(1, laneBuckets.length);
    }
  }

  // Honor a hint (e.g. parser videoTrackCount) by padding empty tracks up to count
  try{
    const hint = Number.isFinite(+opts.videoTrackCountHint) ? Math.max(1, +opts.videoTrackCountHint) : 0;
    if (hint && tracks.length < hint){
      for (let t = tracks.length; t < hint; t++) tracks.push({ trackIndex: t, items: [] });
    }
  }catch{}

  return { baseFrames, durationFrames, fps, tracks };
}
