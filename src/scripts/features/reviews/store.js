// PostFlowX – VFX Reviews (H.264-only) Virtual Timeline Store
// Drop-in module: one dependency, modules/utils_time.js, which is itself a leaf
// (zero imports) — so "drop-in" still means two files, not a dependency tree.
// It is imported rather than copied because a private copy of the timecode base
// is exactly what made the marker source timecodes below wrong.

import { nominalBase } from '../../modules/utils_time.js';

const uid = () => Math.random().toString(36).slice(2, 10);

// ---- Version helpers (smart swap like Resolve/Premiere "replace edit") ----
const stripExt = (n) => String(n || '').replace(/\.[^./\\]+$/, '');
const parseVersionNum = (n) => {
  const s = stripExt(n);
  const m = s.match(/(?:^|[._-])(v|ver|version)\s*0*(\d+)$/i);
  if (!m) return 0;
  const v = parseInt(m[2], 10);
  return Number.isFinite(v) ? v : 0;
};
const parseShotKey = (n) => {
  const s = stripExt(n);
  return s.replace(/(?:^|[._-])(v|ver|version)\s*0*\d+$/i, '');
};

const DEFAULT_MARKER_VERSION_DATA = Object.freeze({
  status: '',
  issueType: 'General',
  severity: 'S2',
  note: '',
  noteTypeGroup: '',
  noteType: '',
  scopeOfWork: '',
  scopeOfWorkList: [],
  thumbDataUrl: null,
  thumbKey: null,
  thumbBaseDataUrl: null,
  thumbBaseKey: null,
  thumbAnnoDataUrl: null,
  thumbAnnoKey: null,
  thumbAnnotated: false,
  annoShapes: [],
});

const cloneMarkerShapes = (shapes) => {
  if (!Array.isArray(shapes)) return [];
  try { return JSON.parse(JSON.stringify(shapes)); } catch { return shapes.slice(); }
};

const cloneMarkerVersionData = (src = {}) => ({
  status: String(src?.status || ''),
  issueType: String(src?.issueType || DEFAULT_MARKER_VERSION_DATA.issueType) || DEFAULT_MARKER_VERSION_DATA.issueType,
  severity: String(src?.severity || DEFAULT_MARKER_VERSION_DATA.severity) || DEFAULT_MARKER_VERSION_DATA.severity,
  note: String(src?.note || ''),
  noteTypeGroup: String(src?.noteTypeGroup || ''),
  noteType: String(src?.noteType || ''),
  scopeOfWork: String(src?.scopeOfWork || ''),
  scopeOfWorkList: Array.isArray(src?.scopeOfWorkList) ? src.scopeOfWorkList.slice() : [],
  thumbDataUrl: (typeof src?.thumbDataUrl === 'string' && src.thumbDataUrl) ? src.thumbDataUrl : null,
  thumbKey: (typeof src?.thumbKey === 'string' && src.thumbKey) ? src.thumbKey : null,
  thumbBaseDataUrl: (typeof src?.thumbBaseDataUrl === 'string' && src.thumbBaseDataUrl) ? src.thumbBaseDataUrl : null,
  thumbBaseKey: (typeof src?.thumbBaseKey === 'string' && src.thumbBaseKey) ? src.thumbBaseKey : null,
  thumbAnnoDataUrl: (typeof src?.thumbAnnoDataUrl === 'string' && src.thumbAnnoDataUrl) ? src.thumbAnnoDataUrl : null,
  thumbAnnoKey: (typeof src?.thumbAnnoKey === 'string' && src.thumbAnnoKey) ? src.thumbAnnoKey : null,
  thumbAnnotated: !!src?.thumbAnnotated,
  annoShapes: cloneMarkerShapes(src?.annoShapes),
});

const sanitizeMarkerReviewMap = (map = {}) => {
  const src = (map && typeof map === 'object' && !Array.isArray(map)) ? map : {};
  const out = {};
  for (const [clipId, value] of Object.entries(src)) {
    const key = String(clipId || '').trim();
    if (!key) continue;
    out[key] = cloneMarkerVersionData(value);
  }
  return out;
};

const DEFAULT_AUTO_CUT_SETTINGS = {
  mode: 'shot',
  preset: 'standard',
  ignoreRegions: [],
  thresholds: null,
  roiSnapStep: 0,
};

const normalizeV1CutViewMode = (value) => (String(value || 'all').toLowerCase() === 'uncertain') ? 'uncertain' : 'all';

const normalizeRoiSnapStep = (value) => {
  const raw = Number(value);
  const allowed = [0, 0.005, 0.01, 0.02, 0.05, 0.1];
  if (!Number.isFinite(raw)) return DEFAULT_AUTO_CUT_SETTINGS.roiSnapStep;
  let best = allowed[0];
  let bestDiff = Math.abs(raw - best);
  for (const step of allowed) {
    const diff = Math.abs(raw - step);
    if (diff < bestDiff) { best = step; bestDiff = diff; }
  }
  return best;
};

const normalizeAutoCutSettings = (settings = {}) => {
  const src = (settings && typeof settings === 'object') ? settings : {};
  const mode = (String(src.mode || DEFAULT_AUTO_CUT_SETTINGS.mode).toLowerCase() === 'detailed') ? 'detailed' : 'shot';
  const preset = ['rough', 'standard', 'fine'].includes(String(src.preset || '').toLowerCase())
    ? String(src.preset).toLowerCase()
    : DEFAULT_AUTO_CUT_SETTINGS.preset;
  const ignoreRegions = Array.isArray(src.ignoreRegions)
    ? src.ignoreRegions
        .map((r) => ({
          x: Number(r?.x) || 0,
          y: Number(r?.y) || 0,
          w: Number(r?.w) || 0,
          h: Number(r?.h) || 0,
          enabled: r?.enabled !== false,
        }))
        .filter((r) => r.enabled !== false && r.w > 0 && r.h > 0)
    : [];
  const thresholds = (src.thresholds && typeof src.thresholds === 'object') ? { ...src.thresholds } : null;
  const roiSnapStep = normalizeRoiSnapStep(src.roiSnapStep);
  return { mode, preset, ignoreRegions, thresholds, roiSnapStep };
};

const normalizeV1CutEntry = (entry, fps = 24) => {
  if (entry == null) return null;

  const toTimeSec = (value, fallbackFrame = null) => {
    if (Number.isFinite(Number(value))) return Number(value);
    if (Number.isFinite(Number(fallbackFrame)) && fps > 0) return Number(fallbackFrame) / fps;
    return NaN;
  };

  if (typeof entry === 'number') {
    const timeSec = toTimeSec(entry);
    if (!Number.isFinite(timeSec) || timeSec <= 0) return null;
    return {
      timeSec,
      frame: Math.round(timeSec * fps),
      type: 'hard_cut',
      confidence: null,
      reason: 'legacy_cut',
      uncertain: false,
      score: null,
    };
  }

  if (typeof entry !== 'object') return null;
  const frame = Number.isFinite(Number(entry.frame)) ? Number(entry.frame) : null;
  const timeSec = toTimeSec(entry.timeSec ?? entry.time ?? entry.sec, frame);
  if (!Number.isFinite(timeSec) || timeSec <= 0) return null;

  let confidence = entry.confidence;
  if (confidence == null || confidence === '') confidence = null;
  else confidence = Math.max(0, Math.min(1, Number(confidence) || 0));

  let score = entry.score;
  if (score == null || score === '') score = null;
  else score = Math.max(0, Math.min(1, Number(score) || 0));

  return {
    timeSec,
    frame: Number.isFinite(frame) ? frame : Math.round(timeSec * fps),
    type: String(entry.type || 'hard_cut'),
    confidence,
    reason: String(entry.reason || 'auto_cut'),
    uncertain: !!entry.uncertain,
    score,
  };
};

const normalizeV1Cuts = (cuts, fps = 24) => {
  const arr = Array.isArray(cuts) ? cuts : [];
  const next = arr
    .map((entry) => normalizeV1CutEntry(entry, fps))
    .filter(Boolean)
    .sort((a, b) => Number(a.timeSec || 0) - Number(b.timeSec || 0));

  const uniq = [];
  const eps = 1 / Math.max(1, fps);
  for (const cut of next) {
    const prev = uniq[uniq.length - 1];
    if (!prev || Math.abs(Number(cut.timeSec || 0) - Number(prev.timeSec || 0)) > eps) uniq.push(cut);
    else if ((Number(cut.confidence) || 0) > (Number(prev.confidence) || 0)) uniq[uniq.length - 1] = cut;
  }
  return uniq;
};

const normalizeV1CutsMap = (map, fps = 24) => {
  const src = (map && typeof map === 'object') ? map : {};
  const out = {};
  for (const [clipId, cuts] of Object.entries(src)) out[String(clipId)] = normalizeV1Cuts(cuts, fps);
  return out;
};

const normalizeV1CutStatsMap = (map = {}) => {
  const src = (map && typeof map === 'object') ? map : {};
  const out = {};
  for (const [clipId, value] of Object.entries(src)) {
    const v = (value && typeof value === 'object') ? value : {};
    out[String(clipId)] = {
      segments: Math.max(1, Number(v.segments) || 1),
      uncertain: Math.max(0, Number(v.uncertain) || 0),
      tinyMerged: Math.max(0, Number(v.tinyMerged) || 0),
      sampledFrames: Math.max(0, Number(v.sampledFrames) || 0),
      threshold: Number.isFinite(Number(v.threshold)) ? Number(v.threshold) : null,
      mode: (String(v.mode || '').toLowerCase() === 'detailed') ? 'detailed' : 'shot',
      preset: ['rough', 'standard', 'fine'].includes(String(v.preset || '').toLowerCase()) ? String(v.preset).toLowerCase() : 'standard',
    };
  }
  return out;
};

const normalizeSelectedV1Cut = (value, cutsMap = {}, fps = 24) => {
  if (!value || typeof value !== 'object') return null;
  const clipId = String(value.clipId || '');
  const timeSec = Number(value.timeSec);
  if (!clipId || !Number.isFinite(timeSec)) return null;
  const cuts = Array.isArray(cutsMap?.[clipId]) ? normalizeV1Cuts(cutsMap[clipId], fps) : [];
  if (!cuts.length) return null;
  const eps = 0.75 / Math.max(1, fps);
  let best = cuts.find((cut) => Math.abs((Number(cut?.timeSec) || 0) - timeSec) <= eps) || null;
  if (!best) {
    best = cuts.slice().sort((a, b) => Math.abs((Number(a?.timeSec) || 0) - timeSec) - Math.abs((Number(b?.timeSec) || 0) - timeSec))[0] || null;
  }
  return best ? { clipId, timeSec: Number(best.timeSec) || 0 } : null;
};

/**
 * Parse timecode "HH:MM:SS:FF" → total frames.
 *
 * Counts on the whole-frame base, not the playback rate: 23.976 fits 24 frame
 * fields into a timecode second and 29.97 NDF fits 30, because HH:MM:SS:FF has
 * no way to express a fractional field. Multiplying by 23.976 read
 * "01:00:00:00" as 86313.6 frames instead of 86400 — off by 86 frames, and
 * fractional, which is how a frame field of "23.616000000003282" ended up
 * formatted into a marker's source timecode by framesToTc below.
 */
export function tcToFrames(tc, fps) {
  if (!tc) return 0;
  const m = String(tc).trim().match(/^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  const ff = Number(m[4]);
  const total = (((hh * 60 + mm) * 60) + ss) * nominalBase(fps) + ff;
  return Number.isFinite(total) ? total : 0;
}

/**
 * Format frames → "HH:MM:SS:FF" (non-drop).
 *
 * Same base as tcToFrames, so the pair round-trips. Dividing a frame count by
 * the fractional rate left `ff` fractional, and pad2 does not round — it
 * stringified the float whole, so a marker's srcTC read "01:00:09:23.616…".
 *
 * The frame counts added to a parse result elsewhere in this file come from
 * `seconds * fps` at the real rate, which is correct and stays: elapsed frames
 * really are wall-clock seconds times the true rate. Only the mapping between a
 * frame count and its HH:MM:SS:FF label uses the nominal base.
 */
export function framesToTc(frames, fps) {
  const base = nominalBase(fps);
  const f = Math.max(0, Math.floor(frames || 0));
  const totalSec = Math.floor(f / base);
  const ff = f % base;
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
}

export function secondsToClock(t) {
  const s = Math.max(0, Number(t) || 0);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor(s / 60) % 60;
  const ss = Math.floor(s) % 60;
  const ms = Math.floor((s - Math.floor(s)) * 1000);
  const pad2 = (n) => String(n).padStart(2, '0');
  const pad3 = (n) => String(n).padStart(3, '0');
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.${pad3(ms)}`;
}

export class ReviewsStore {
  constructor() {
    /** @type {any} */
    this.state = {
      fps: 24,
      pxPerSec: 80,
      clips: [],
      // V1 timeline order (clipIds). Importing media adds to `clips` only.
      // User explicitly adds clips to the V1 timeline via UI actions.
      timelineClipIds: [],
      autoCutSettings: { ...DEFAULT_AUTO_CUT_SETTINGS },
      // Optional: per-clip cut points (seconds, relative to the clip) used to split
      // V1 into shot-sized segments for fast navigation (Prev/Next) and QC workflows.
      // { [clipId]: Array<number|object> }
      v1CutsByClip: {},
      v1CutStatsByClip: {},
      selectedV1Cut: null,
      v1CutViewMode: 'all',
      segments: [],
      // V2 overlays (manual layer above V1)
      overlays: [],
      activeIndex: -1,
      activeLayer: 'V1', // 'V1' | 'V2'
      activeOverlayId: null,
      isPlaying: false,
      globalTimeSec: 0,
      markers: [],
      selectedMarkerId: null,
    };

    /** @type {Set<(state:any, action:string)=>void>} */
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(action) {
    for (const fn of this.listeners) fn(this.state, action);
  }


  _blankMarkerVersionData() {
    return cloneMarkerVersionData(DEFAULT_MARKER_VERSION_DATA);
  }

  _captureMarkerVersionData(marker, clipId = null) {
    if (!marker || String(marker.layer || '') !== 'V2') return sanitizeMarkerReviewMap(marker?.reviewByClipId);
    const key = String(clipId || marker.clipId || '').trim();
    const map = sanitizeMarkerReviewMap(marker.reviewByClipId);
    if (!key) {
      marker.reviewByClipId = map;
      return map;
    }
    map[key] = cloneMarkerVersionData(marker);
    marker.reviewByClipId = map;
    return map;
  }

  _getMarkerVersionData(marker, clipId = null) {
    const key = String(clipId || marker?.clipId || '').trim();
    if (!key) return null;
    const map = sanitizeMarkerReviewMap(marker?.reviewByClipId);
    marker.reviewByClipId = map;
    return map[key] ? cloneMarkerVersionData(map[key]) : null;
  }

  _syncMarkerCurrentVersionData(marker) {
    if (!marker || String(marker.layer || '') !== 'V2') return marker;
    const key = String(marker.clipId || '').trim();
    const map = sanitizeMarkerReviewMap(marker.reviewByClipId);
    if (key) map[key] = cloneMarkerVersionData(marker);
    marker.reviewByClipId = map;
    return marker;
  }

  _captureMarkersForOverlay(ovl) {
    if (!ovl) return;
    const clipId = String(ovl.clipId || '').trim();
    if (!clipId) return;
    const start = Math.max(0, Number(ovl.globalStartSec) || 0);
    const end = Math.max(start, Number(ovl.globalEndSec) || (start + (Number(ovl.durationSec) || 0)));
    for (const marker of (this.state.markers || [])) {
      if (!marker || String(marker.layer || '') !== 'V2') continue;
      const gt = Math.max(0, Number(marker.globalTimeSec) || 0);
      if (gt < start || gt >= end) continue;
      this._captureMarkerVersionData(marker, clipId);
    }
  }

  _normalizeMarkerRecord(marker) {
    if (!marker || typeof marker !== 'object') return marker;
    const next = { ...marker };
    next.scopeOfWorkList = Array.isArray(next.scopeOfWorkList) ? next.scopeOfWorkList.slice() : [];
    next.annoShapes = cloneMarkerShapes(next.annoShapes);
    next.reviewByClipId = sanitizeMarkerReviewMap(next.reviewByClipId);
    if (String(next.layer || '') === 'V2') {
      const key = String(next.clipId || '').trim();
      if (key && !next.reviewByClipId[key]) next.reviewByClipId[key] = cloneMarkerVersionData(next);
    }
    return next;
  }

  set(partial, action = 'state') {
    this.state = { ...this.state, ...partial };
    this.emit(action);
  }

  setTime(globalTimeSec, action = 'time') {
    const t = Math.max(0, Number(globalTimeSec) || 0);
    if (t === this.state.globalTimeSec) return;
    const changedActive = this._updateActiveForTime(t);
    this.state.globalTimeSec = t;
    this.emit(action);
    if (changedActive) this.emit('active');
  }

  rebuildSegments(action = 'clips') {
    const segs = [];
    let acc = 0;
    const byId = new Map(this.state.clips.map(c => [c.id, c]));
    const order = Array.isArray(this.state.timelineClipIds) ? this.state.timelineClipIds : [];
    const fps = Math.max(1, Number(this.state.fps) || 24);
    const cutsMap = (this.state.v1CutsByClip && typeof this.state.v1CutsByClip === 'object') ? this.state.v1CutsByClip : {};
    for (let i = 0; i < order.length; i++) {
      const c = byId.get(order[i]);
      if (!c) continue;
      const dur = Math.max(0, Number(c.durationSec) || 0);

      // Resolve cut points (seconds, relative to clip). We split V1 into shot-sized sub-segments.
      const rawCuts = Array.isArray(cutsMap?.[c.id]) ? cutsMap[c.id] : [];
      const cuts = normalizeV1Cuts(rawCuts, fps)
        .filter((cut) => Number(cut?.timeSec) > 0.001 && Number(cut?.timeSec) < Math.max(0.001, dur - 0.001));

      // Unique with epsilon (1 frame)
      const uniqCuts = [];
      for (const cut of cuts) {
        const prev = uniqCuts[uniqCuts.length - 1];
        if (!prev || Math.abs(Number(cut.timeSec || 0) - Number(prev.timeSec || 0)) > (1 / fps)) uniqCuts.push(cut);
        else if ((Number(cut.confidence) || 0) > (Number(prev.confidence) || 0)) uniqCuts[uniqCuts.length - 1] = cut;
      }

      const makeSeg = (inSec, outSec, subIndex, subCount) => {
        const segDur = Math.max(0, Number(outSec) - Number(inSec));
        if (segDur <= (1 / fps) * 0.25) return; // ignore tiny slivers

        const start = acc;
        const end = acc + segDur;

        // Segment startTC = clip startTC + inSec (so SRC TC stays correct per segment)
        let segStartTC = c.startTC || '00:00:00:00';
        try{
          const baseFrames = tcToFrames(c.startTC || '00:00:00:00', fps);
          const offFrames = Math.round(Math.max(0, Number(inSec) || 0) * fps);
          segStartTC = framesToTc(baseFrames + offFrames, fps);
        }catch{}

        const label = (subCount > 1)
          ? `${c.name} · ${String(subIndex + 1).padStart(3, '0')}`
          : c.name;
        const leadCut = (subCount > 1 && subIndex > 0) ? (uniqCuts[subIndex - 1] || null) : null;

        segs.push({
          index: segs.length,
          // Position inside V1 timelineClipIds order. Used so we can delete a clip
          // from the timeline without removing it from the Bin.
          tlPos: i,
          clipId: c.id,
          name: label,
          baseName: c.name,
          url: c.url,
          durationSec: segDur,
          globalStartSec: start,
          globalEndSec: end,
          startTC: segStartTC,
          inSec: Math.max(0, Number(inSec) || 0),
          subIndex: Number(subIndex) || 0,
          subCount: Number(subCount) || 1,
          canPlay: c.canPlay !== false,
          type: String(leadCut?.type || (subCount > 1 ? 'auto_cut' : 'clip')),
          confidence: (leadCut?.confidence == null) ? null : Math.max(0, Math.min(1, Number(leadCut.confidence) || 0)),
          reason: String(leadCut?.reason || (subCount > 1 ? 'auto_cut' : 'clip')),
          uncertain: !!leadCut?.uncertain,
          cutTimeSec: Number.isFinite(Number(leadCut?.timeSec)) ? Number(leadCut.timeSec) : null,
          cutFrame: Number.isFinite(Number(leadCut?.frame)) ? Number(leadCut.frame) : null,
        });
        acc = end;
      };

      if (uniqCuts.length) {
        const subCount = uniqCuts.length + 1;
        let prev = 0;
        for (let ci = 0; ci < uniqCuts.length; ci++) {
          const t = Number(uniqCuts[ci]?.timeSec) || 0;
          makeSeg(prev, t, ci, subCount);
          prev = t;
        }
        makeSeg(prev, dur, uniqCuts.length, subCount);
      } else {
        makeSeg(0, dur, 0, 1);
      }
    }
    this.state.segments = segs;

    // Recompute overlay ends (in case clip durations update)
    for (let i = 0; i < this.state.overlays.length; i++) {
      const o = this.state.overlays[i];
      if (!o) continue;
      const dur = Math.max(0, Number(o.durationSec) || 0);
      o.globalEndSec = (Number(o.globalStartSec) || 0) + dur;
    }

    // Clamp activeIndex
    if (this.state.activeIndex >= segs.length) this.state.activeIndex = segs.length - 1;
    if (segs.length === 0) {
      this.state.activeIndex = -1;
      this.state.globalTimeSec = 0;
    } else if (this.state.activeIndex < 0) {
      this.state.activeIndex = 0;
      this.state.globalTimeSec = 0;
    }

    // Clamp playhead to duration
    const total = this.totalDurationSec();
    if (this.state.globalTimeSec > total) {
      const fps = Math.max(1, Number(this.state.fps) || 24);
      this.state.globalTimeSec = Math.max(0, total - (1 / fps));
    }

    this.state.selectedV1Cut = normalizeSelectedV1Cut(this.state.selectedV1Cut, this.state.v1CutsByClip, fps);

    this.emit(action);
  }

  /** Remove a single V1 segment from the timeline (does NOT remove from Bin). */
  removeTimelineSegment(segIndex) {
    const idx = Math.max(0, Math.min(this.state.segments.length - 1, Number(segIndex) || 0));
    const seg = this.state.segments[idx];
    if (!seg) return;
    const tlPos = Number(seg.tlPos);
    if (!Number.isFinite(tlPos)) return;

    const prevTime = Number(this.state.globalTimeSec) || 0;
    const order = Array.isArray(this.state.timelineClipIds) ? this.state.timelineClipIds.slice() : [];
    if (tlPos < 0 || tlPos >= order.length) return;
    order.splice(tlPos, 1);
    this.state.timelineClipIds = order;
    this.rebuildSegments('clips');
    this.setTime(prevTime, 'time');
  }

  totalDurationSec() {
    const s = this.state.segments;
    const v1 = s.length ? (s[s.length - 1].globalEndSec || 0) : 0;
    let v2 = 0;
    for (const o of this.state.overlays) v2 = Math.max(v2, Number(o?.globalEndSec) || 0);
    return Math.max(v1, v2);
  }

  overlayAtTime(globalTimeSec) {
    const t = Math.max(0, Number(globalTimeSec) || 0);
    // Later overlays are considered "on top".
    for (let i = this.state.overlays.length - 1; i >= 0; i--) {
      const o = this.state.overlays[i];
      if (!o) continue;
      const s = Number(o.globalStartSec) || 0;
      const e = Number(o.globalEndSec) || 0;
      if (t >= s && t < e) return o;
    }
    return null;
  }

  /** Resolve what should play at global time t (V2 overlay has priority). */
  getPlaybackAtTime(globalTimeSec) {
    const t = Math.max(0, Number(globalTimeSec) || 0);
    const ovl = this.overlayAtTime(t);
    const base = this.globalToSegment(t);
    const v1Seg = this.state.segments[base.index] || null;

    if (ovl) {
      const inSec = Math.max(0, Number(ovl.inSec) || 0);
      const local = Math.max(0, (t - (Number(ovl.globalStartSec) || 0)) + inSec);
      const clipIdx = this.state.clips.findIndex(c => c.id === ovl.clipId);
      return { layer: 'V2', seg: ovl, localTimeSec: local, v1Index: base.index, clipIndex: clipIdx };
    }
    if (!v1Seg) return { layer: 'V1', seg: null, localTimeSec: 0, v1Index: -1, clipIndex: -1 };
    return { layer: 'V1', seg: v1Seg, localTimeSec: base.localTimeSec, v1Index: base.index, clipIndex: this.state.clips.findIndex(c => c.id === v1Seg.clipId) };
  }

  _updateActiveForTime(globalTimeSec) {
    const t = Math.max(0, Number(globalTimeSec) || 0);
    const base = this.globalToSegment(t);
    const ovl = this.overlayAtTime(t);

    let changed = false;
    if (base.index !== this.state.activeIndex && base.index >= 0) {
      this.state.activeIndex = base.index;
      changed = true;
    }

    const nextLayer = ovl ? 'V2' : 'V1';
    const nextOvlId = ovl ? ovl.id : null;
    if (nextLayer !== this.state.activeLayer || nextOvlId !== this.state.activeOverlayId) {
      this.state.activeLayer = nextLayer;
      this.state.activeOverlayId = nextOvlId;
      changed = true;
    }
    return changed;
  }

  globalToSegment(globalTimeSec) {
    const t = Math.max(0, Number(globalTimeSec) || 0);
    const segs = this.state.segments;
    if (!segs.length) return { index: -1, localTimeSec: 0 };
    // Fast path for last
    if (t >= segs[segs.length - 1].globalEndSec) {
      const last = segs[segs.length - 1];
      return { index: last.index, localTimeSec: Math.max(0, last.durationSec - 0.001) };
    }
    for (const seg of segs) {
      if (t >= seg.globalStartSec && t < seg.globalEndSec) {
        return { index: seg.index, localTimeSec: t - seg.globalStartSec };
      }
    }
    // Before first
    return { index: segs[0].index, localTimeSec: 0 };
  }

  segmentToGlobal(index, localTimeSec) {
    const seg = this.state.segments[index];
    if (!seg) return 0;
    return seg.globalStartSec + Math.max(0, Number(localTimeSec) || 0);
  }

  /** Add clips (File list). Creates object URLs. */
  async addClips(files, opts = {}) {
    const arr = Array.from(files || []);
    if (!arr.length) return;

    const _b = (typeof opts === 'string') ? opts : (opts && typeof opts === 'object' ? (opts.bin || opts.target || '') : '');
    const _bs = String(_b || '').toLowerCase();
    const targetBin = (_bs === 'ref' || _bs === 'v1') ? 'ref' : 'shots';

    const newClips = [];
    for (const f of arr) {
      const name = f.name || 'Untitled';
      const lower = name.toLowerCase();
      const isVideo = (f.type || '').startsWith('video/') || lower.endsWith('.mp4') || lower.endsWith('.mov');
      if (!isVideo) continue;
      // H.264-only policy: we cannot hard-detect codec without decoding; we mark playable by attempting load.
      const url = URL.createObjectURL(f);
      newClips.push({
        id: uid(),
        name,
        shotKey: parseShotKey(name),
        version: parseVersionNum(name),
        bin: targetBin,
        // File object is session-only (not serializable). Keep for current session playback.
        file: f,
        // Serializable metadata for relink after refresh.
        fileMeta: {
          name,
          size: Number(f.size) || 0,
          lastModified: Number(f.lastModified) || 0,
          type: String(f.type || ''),
        },
        url,
        createdAt: Date.now(),
        durationSec: 0,
        canPlay: true,
        startTC: '00:00:00:00',
      });
    }

    if (!newClips.length) return;

    this.state.clips = [...this.state.clips, ...newClips];
    // IMPORTANT: importing media should NOT automatically populate the V1 timeline.
    // Keep `segments` intact until user explicitly adds clips to the timeline.
    this.emit('clips');

    // Duration discovery is async: UI can update as metadata loads.
    this.emit('clips_added');
    return newClips;
  }

  /** Append a clip to the end of the V1 timeline (Resolve-like explicit edit). */
  appendToTimeline(clipId) {
    const idx = this.state.clips.findIndex(x => x.id === clipId);
    if (idx < 0) return;
    const c = this.state.clips[idx];
    // Smart bin separation: anything edited into V1 becomes a Ref clip.
    if ((String(c?.bin || '').toLowerCase() !== 'ref')) {
      this.state.clips[idx] = { ...c, bin: 'ref' };
    }
    if (!Array.isArray(this.state.timelineClipIds)) this.state.timelineClipIds = [];
    this.state.timelineClipIds = [...this.state.timelineClipIds, clipId];
    this.rebuildSegments('clips');
  }

  _refreshV1CutStatsForClip(clipId, patch = {}) {
    const id = String(clipId || '');
    if (!id) return;
    const cuts = Array.isArray(this.state.v1CutsByClip?.[id]) ? normalizeV1Cuts(this.state.v1CutsByClip[id], Math.max(1, Number(this.state.fps) || 24)) : [];
    if (!this.state.v1CutStatsByClip || typeof this.state.v1CutStatsByClip !== 'object') this.state.v1CutStatsByClip = {};
    const prev = (this.state.v1CutStatsByClip[id] && typeof this.state.v1CutStatsByClip[id] === 'object') ? this.state.v1CutStatsByClip[id] : {};
    this.state.v1CutStatsByClip[id] = {
      segments: Math.max(1, Number(patch.segments) || (cuts.length + 1)),
      uncertain: Math.max(0, Number(patch.uncertain) || cuts.filter((cut) => cut?.uncertain).length),
      tinyMerged: Math.max(0, Number(patch.tinyMerged) || Number(prev.tinyMerged) || 0),
      sampledFrames: Math.max(0, Number(patch.sampledFrames) || Number(prev.sampledFrames) || 0),
      threshold: Number.isFinite(Number(patch.threshold)) ? Number(patch.threshold) : (Number.isFinite(Number(prev.threshold)) ? Number(prev.threshold) : null),
      mode: (String(patch.mode || prev.mode || this.state.autoCutSettings?.mode || 'shot').toLowerCase() === 'detailed') ? 'detailed' : 'shot',
      preset: ['rough', 'standard', 'fine'].includes(String(patch.preset || prev.preset || this.state.autoCutSettings?.preset || 'standard').toLowerCase())
        ? String(patch.preset || prev.preset || this.state.autoCutSettings?.preset || 'standard').toLowerCase()
        : 'standard',
    };
  }

  getV1CutMarkers() {
    const out = [];
    const byId = new Map(this.state.clips.map((c) => [c.id, c]));
    const order = Array.isArray(this.state.timelineClipIds) ? this.state.timelineClipIds : [];
    const cutsMap = (this.state.v1CutsByClip && typeof this.state.v1CutsByClip === 'object') ? this.state.v1CutsByClip : {};
    const fps = Math.max(1, Number(this.state.fps) || 24);
    let acc = 0;
    for (let i = 0; i < order.length; i++) {
      const c = byId.get(order[i]);
      if (!c) continue;
      const dur = Math.max(0, Number(c.durationSec) || 0);
      const cuts = normalizeV1Cuts(cutsMap?.[c.id], fps).filter((cut) => Number(cut?.timeSec) > 0.001 && Number(cut?.timeSec) < Math.max(0.001, dur - 0.001));
      for (let ci = 0; ci < cuts.length; ci++) {
        const cut = cuts[ci];
        out.push({
          id: `${String(c.id)}:${String((cut.frame != null) ? cut.frame : Math.round((Number(cut.timeSec) || 0) * fps))}:${ci}` ,
          clipId: c.id,
          clipName: c.name,
          clipIndex: i,
          cutIndex: ci,
          timeSec: Number(cut.timeSec) || 0,
          frame: (cut.frame != null) ? Number(cut.frame) : Math.round((Number(cut.timeSec) || 0) * fps),
          globalTimeSec: acc + (Number(cut.timeSec) || 0),
          type: String(cut.type || 'hard_cut'),
          confidence: (cut.confidence == null) ? null : Math.max(0, Math.min(1, Number(cut.confidence) || 0)),
          reason: String(cut.reason || 'auto_cut'),
          uncertain: !!cut.uncertain,
          score: (cut.score == null) ? null : Math.max(0, Math.min(1, Number(cut.score) || 0)),
          clipDurationSec: dur,
        });
      }
      acc += dur;
    }
    return out;
  }

  getSelectedV1Cut() {
    return normalizeSelectedV1Cut(this.state.selectedV1Cut, this.state.v1CutsByClip, Math.max(1, Number(this.state.fps) || 24));
  }

  selectV1Cut(cutRef) {
    const next = normalizeSelectedV1Cut(cutRef, this.state.v1CutsByClip, Math.max(1, Number(this.state.fps) || 24));
    const prev = this.getSelectedV1Cut();
    const same = ((!prev && !next) || (prev && next && String(prev.clipId) === String(next.clipId) && Math.abs((Number(prev.timeSec) || 0) - (Number(next.timeSec) || 0)) <= (0.75 / Math.max(1, Number(this.state.fps) || 24))));
    if (same) return next;
    this.state.selectedV1Cut = next;
    this.emit('cuts');
    return next;
  }

  getSegmentBoundaryInfo(segIndex) {
    const idx = Math.max(0, Math.min(this.state.segments.length - 1, Number(segIndex) || 0));
    const seg = this.state.segments[idx];
    if (!seg) return null;
    const fps = Math.max(1, Number(this.state.fps) || 24);
    const cuts = normalizeV1Cuts(this.state.v1CutsByClip?.[seg.clipId], fps);
    const clipStartGlobalSec = Math.max(0, (Number(seg.globalStartSec) || 0) - (Number(seg.inSec) || 0));
    const makeCutMeta = (cut, cutIndex) => cut ? ({
      ...cut,
      clipId: seg.clipId,
      clipName: seg.baseName || seg.name,
      cutIndex,
      globalTimeSec: clipStartGlobalSec + (Number(cut.timeSec) || 0),
    }) : null;
    const leadIndex = (Number(seg.subIndex) || 0) > 0 ? ((Number(seg.subIndex) || 0) - 1) : -1;
    const trailIndex = (Number(seg.subIndex) || 0) < cuts.length ? Number(seg.subIndex) || 0 : -1;
    return {
      segment: seg,
      clipId: seg.clipId,
      clipStartGlobalSec,
      leading: leadIndex >= 0 ? makeCutMeta(cuts[leadIndex], leadIndex) : null,
      trailing: trailIndex >= 0 ? makeCutMeta(cuts[trailIndex], trailIndex) : null,
    };
  }

  addV1CutAtTime(clipId, timeSec, patch = {}) {
    const id = String(clipId || '');
    if (!id) return null;
    const fps = Math.max(1, Number(this.state.fps) || 24);
    const clip = (this.state.clips || []).find((c) => c && c.id === id) || null;
    const dur = Math.max(0, Number(clip?.durationSec) || 0);
    const minGapSec = 1 / fps;
    const nextTime = Math.max(minGapSec, Math.min(Math.max(minGapSec, dur - minGapSec), Number(timeSec) || 0));
    if (!Number.isFinite(nextTime) || nextTime <= minGapSec * 0.5 || nextTime >= Math.max(minGapSec, dur - minGapSec * 0.5)) return null;
    const cuts = normalizeV1Cuts(this.state.v1CutsByClip?.[id], fps);
    const eps = 0.75 / fps;
    if (cuts.some((cut) => Math.abs((Number(cut?.timeSec) || 0) - nextTime) <= eps)) {
      return this.selectV1Cut({ clipId: id, timeSec: nextTime });
    }
    const entry = normalizeV1CutEntry({
      timeSec: nextTime,
      frame: Math.round(nextTime * fps),
      type: patch.type || 'manual_split',
      confidence: (patch.confidence == null) ? 1 : patch.confidence,
      reason: patch.reason || 'manual_split',
      uncertain: !!patch.uncertain,
      score: (patch.score == null) ? 1 : patch.score,
    }, fps);
    if (!entry) return null;
    if (!this.state.v1CutsByClip || typeof this.state.v1CutsByClip !== 'object') this.state.v1CutsByClip = {};
    this.state.v1CutsByClip[id] = normalizeV1Cuts([...(cuts || []), entry], fps);
    this._refreshV1CutStatsForClip(id);
    const prevTime = Number(this.state.globalTimeSec) || 0;
    this.rebuildSegments('cuts');
    this.setTime(prevTime, 'time');
    const selected = this.selectV1Cut({ clipId: id, timeSec: nextTime });
    const marker = this.getV1CutMarkers().find((cut) => selected && String(cut.clipId) === String(selected.clipId) && Math.abs((Number(cut.timeSec) || 0) - (Number(selected.timeSec) || 0)) <= eps) || null;
    return marker || selected;
  }

  splitSegmentAtGlobalTime(globalTimeSec) {
    const map = this.globalToSegment(globalTimeSec);
    const seg = this.state.segments[map.index] || null;
    if (!seg) return null;
    const clipTime = Math.max(0, Number(seg.inSec) || 0) + Math.max(0, Number(globalTimeSec) - Number(seg.globalStartSec || 0));
    return this.addV1CutAtTime(seg.clipId, clipTime, { type: 'manual_split', reason: 'manual_split', confidence: 1, uncertain: false, score: 1 });
  }

  removeV1CutAtTime(clipId, timeSec, epsilonFrames = 0.75) {
    const id = String(clipId || '');
    if (!id) return null;
    const fps = Math.max(1, Number(this.state.fps) || 24);
    const cuts = normalizeV1Cuts(this.state.v1CutsByClip?.[id], fps);
    if (!cuts.length) return null;
    const eps = Math.max(0.25, Number(epsilonFrames) || 0.75) / fps;
    const idx = cuts.findIndex((cut) => Math.abs((Number(cut?.timeSec) || 0) - (Number(timeSec) || 0)) <= eps);
    if (idx < 0) return null;
    const nextCuts = cuts.slice(0, idx).concat(cuts.slice(idx + 1));
    this.state.v1CutsByClip[id] = nextCuts;
    this._refreshV1CutStatsForClip(id);
    const prevTime = Number(this.state.globalTimeSec) || 0;
    this.rebuildSegments('cuts');
    this.setTime(prevTime, 'time');
    const nextSel = nextCuts[idx] || nextCuts[idx - 1] || null;
    if (nextSel) this.selectV1Cut({ clipId: id, timeSec: nextSel.timeSec });
    else this.selectV1Cut(null);
    return true;
  }

  mergeSegmentWithPrevious(segIndex) {
    const info = this.getSegmentBoundaryInfo(segIndex);
    if (!info?.leading) return null;
    return this.removeV1CutAtTime(info.clipId, info.leading.timeSec);
  }

  mergeSegmentWithNext(segIndex) {
    const info = this.getSegmentBoundaryInfo(segIndex);
    if (!info?.trailing) return null;
    return this.removeV1CutAtTime(info.clipId, info.trailing.timeSec);
  }

  nudgeV1Cut(clipId, timeSec, deltaFrames = 0) {
    const id = String(clipId || '');
    if (!id) return null;
    const fps = Math.max(1, Number(this.state.fps) || 24);
    const cuts = normalizeV1Cuts(this.state.v1CutsByClip?.[id], fps);
    if (!cuts.length) return null;
    const eps = 0.75 / fps;
    const idx = cuts.findIndex((cut) => Math.abs((Number(cut?.timeSec) || 0) - (Number(timeSec) || 0)) <= eps);
    if (idx < 0) return null;
    const clip = (this.state.clips || []).find((c) => c && c.id === id) || null;
    const dur = Math.max(0, Number(clip?.durationSec) || 0);
    const minGapSec = 1 / fps;
    const prevTimeSec = idx > 0 ? (Number(cuts[idx - 1]?.timeSec) || 0) : 0;
    const nextTimeSec = idx < (cuts.length - 1) ? (Number(cuts[idx + 1]?.timeSec) || 0) : dur;
    const desired = (Number(cuts[idx]?.timeSec) || 0) + ((Number(deltaFrames) || 0) / fps);
    const nextTime = Math.max(prevTimeSec + minGapSec, Math.min(nextTimeSec - minGapSec, desired));
    if (!Number.isFinite(nextTime) || Math.abs(nextTime - (Number(cuts[idx]?.timeSec) || 0)) < (0.1 / fps)) {
      return this.getSelectedV1Cut();
    }
    const nextCuts = cuts.slice();
    nextCuts[idx] = normalizeV1CutEntry({
      ...nextCuts[idx],
      timeSec: nextTime,
      frame: Math.round(nextTime * fps),
      reason: nextCuts[idx]?.reason || 'manual_adjust',
    }, fps);
    this.state.v1CutsByClip[id] = normalizeV1Cuts(nextCuts, fps);
    this._refreshV1CutStatsForClip(id);
    const prevTime = Number(this.state.globalTimeSec) || 0;
    this.rebuildSegments('cuts');
    this.setTime(prevTime, 'time');
    const selected = this.selectV1Cut({ clipId: id, timeSec: nextTime });
    return this.getV1CutMarkers().find((cut) => selected && String(cut.clipId) === String(selected.clipId) && Math.abs((Number(cut.timeSec) || 0) - (Number(selected.timeSec) || 0)) <= eps) || selected;
  }

  toggleV1CutUncertain(clipId, timeSec) {
    const id = String(clipId || '');
    if (!id) return null;
    const fps = Math.max(1, Number(this.state.fps) || 24);
    const cuts = normalizeV1Cuts(this.state.v1CutsByClip?.[id], fps);
    if (!cuts.length) return null;
    const eps = 0.75 / fps;
    const idx = cuts.findIndex((cut) => Math.abs((Number(cut?.timeSec) || 0) - (Number(timeSec) || 0)) <= eps);
    if (idx < 0) return null;
    const nextCuts = cuts.slice();
    nextCuts[idx] = normalizeV1CutEntry({ ...nextCuts[idx], uncertain: !nextCuts[idx]?.uncertain }, fps);
    this.state.v1CutsByClip[id] = normalizeV1Cuts(nextCuts, fps);
    this._refreshV1CutStatsForClip(id);
    const prevTime = Number(this.state.globalTimeSec) || 0;
    this.rebuildSegments('cuts');
    this.setTime(prevTime, 'time');
    return this.selectV1Cut({ clipId: id, timeSec: nextCuts[idx]?.timeSec });
  }

  selectAdjacentV1Cut(direction = 1, opts = {}) {
    const dir = Number(direction) < 0 ? -1 : 1;
    const uncertainOnly = !!opts?.uncertainOnly;
    const markers = (this.getV1CutMarkers() || []).filter((cut) => !uncertainOnly || cut?.uncertain);
    if (!markers.length) return null;
    const fps = Math.max(1, Number(this.state.fps) || 24);
    const selected = this.getSelectedV1Cut();
    const selectedMarker = selected
      ? markers.find((cut) => String(cut.clipId || '') === String(selected.clipId || '') && Math.abs((Number(cut.timeSec) || 0) - (Number(selected.timeSec) || 0)) <= (0.75 / fps))
      : null;
    let idx = selectedMarker ? markers.indexOf(selectedMarker) : -1;
    if (idx < 0) {
      const anchor = Number.isFinite(Number(opts?.anchorGlobalTimeSec)) ? Number(opts.anchorGlobalTimeSec) : Math.max(0, Number(this.state.globalTimeSec) || 0);
      if (dir > 0) idx = markers.findIndex((cut) => (Number(cut.globalTimeSec) || 0) > (anchor + (0.25 / fps)));
      else idx = markers.map((cut, i) => [cut, i]).filter(([cut]) => (Number(cut.globalTimeSec) || 0) < (anchor - (0.25 / fps))).map(([, i]) => i).pop() ?? -1;
      if (idx < 0) idx = dir > 0 ? 0 : (markers.length - 1);
    } else {
      idx += dir;
      if (idx < 0) idx = markers.length - 1;
      if (idx >= markers.length) idx = 0;
    }
    const target = markers[idx] || null;
    if (!target) return null;
    return this.selectV1Cut({ clipId: target.clipId, timeSec: target.timeSec });
  }

  setAutoCutSettings(patch = {}) {
    this.state.autoCutSettings = normalizeAutoCutSettings({
      ...(this.state.autoCutSettings || DEFAULT_AUTO_CUT_SETTINGS),
      ...((patch && typeof patch === 'object') ? patch : {}),
    });
    this.emit('cuts');
  }

  setV1CutViewMode(mode = 'all') {
    const next = normalizeV1CutViewMode(mode);
    if (this.state.v1CutViewMode === next) return next;
    this.state.v1CutViewMode = next;
    this.emit('cuts');
    return next;
  }


  acceptUncertainV1CutsForClip(clipId) {
    const id = String(clipId || '');
    if (!id) return 0;
    const fps = Math.max(1, Number(this.state.fps) || 24);
    const cuts = normalizeV1Cuts(this.state.v1CutsByClip?.[id], fps);
    if (!cuts.length) return 0;
    let changed = 0;
    const nextCuts = cuts.map((cut) => {
      if (!cut?.uncertain) return cut;
      changed += 1;
      return normalizeV1CutEntry({ ...cut, uncertain: false, reason: String(cut?.reason || 'auto_cut') }, fps);
    });
    if (changed > 0) {
      this.state.v1CutsByClip[id] = normalizeV1Cuts(nextCuts, fps);
      this._refreshV1CutStatsForClip(id);
      const prevTime = Number(this.state.globalTimeSec) || 0;
      this.rebuildSegments('cuts');
      this.setTime(prevTime, 'time');
      this.state.selectedV1Cut = normalizeSelectedV1Cut(this.state.selectedV1Cut, this.state.v1CutsByClip, fps);
      this.emit('cuts');
    }
    return changed;
  }

  rejectUncertainV1CutsForClip(clipId) {
    const id = String(clipId || '');
    if (!id) return 0;
    const fps = Math.max(1, Number(this.state.fps) || 24);
    const cuts = normalizeV1Cuts(this.state.v1CutsByClip?.[id], fps);
    if (!cuts.length) return 0;
    let changed = 0;
    const nextCuts = cuts.filter((cut) => {
      const drop = !!cut?.uncertain;
      if (drop) changed += 1;
      return !drop;
    });
    if (changed > 0) {
      this.state.v1CutsByClip[id] = normalizeV1Cuts(nextCuts, fps);
      this._refreshV1CutStatsForClip(id);
      const prevTime = Number(this.state.globalTimeSec) || 0;
      this.rebuildSegments('cuts');
      this.setTime(prevTime, 'time');
      this.state.selectedV1Cut = normalizeSelectedV1Cut(this.state.selectedV1Cut, this.state.v1CutsByClip, fps);
      this.emit('cuts');
    }
    return changed;
  }

  acceptAllUncertainV1Cuts(scope = 'timeline') {
    const fps = Math.max(1, Number(this.state.fps) || 24);
    const clipIds = (scope === 'all')
      ? (this.state.clips || []).map((c) => String(c?.id || '')).filter(Boolean)
      : Array.from(new Set((this.state.timelineClipIds || []).map((id) => String(id || '')).filter(Boolean)));
    let changed = 0;
    for (const id of clipIds) {
      const cuts = normalizeV1Cuts(this.state.v1CutsByClip?.[id], fps);
      if (!cuts.length) continue;
      let touched = false;
      const nextCuts = cuts.map((cut) => {
        if (!cut?.uncertain) return cut;
        touched = true;
        changed += 1;
        return normalizeV1CutEntry({ ...cut, uncertain: false, reason: String(cut?.reason || 'auto_cut') }, fps);
      });
      if (touched) {
        this.state.v1CutsByClip[id] = normalizeV1Cuts(nextCuts, fps);
        this._refreshV1CutStatsForClip(id);
      }
    }
    if (changed > 0) {
      const prevTime = Number(this.state.globalTimeSec) || 0;
      this.rebuildSegments('cuts');
      this.setTime(prevTime, 'time');
      this.state.selectedV1Cut = normalizeSelectedV1Cut(this.state.selectedV1Cut, this.state.v1CutsByClip, fps);
      this.emit('cuts');
    }
    return changed;
  }

  rejectAllUncertainV1Cuts(scope = 'timeline') {
    const fps = Math.max(1, Number(this.state.fps) || 24);
    const clipIds = (scope === 'all')
      ? (this.state.clips || []).map((c) => String(c?.id || '')).filter(Boolean)
      : Array.from(new Set((this.state.timelineClipIds || []).map((id) => String(id || '')).filter(Boolean)));
    let changed = 0;
    for (const id of clipIds) {
      const cuts = normalizeV1Cuts(this.state.v1CutsByClip?.[id], fps);
      if (!cuts.length) continue;
      const nextCuts = cuts.filter((cut) => {
        const drop = !!cut?.uncertain;
        if (drop) changed += 1;
        return !drop;
      });
      if (nextCuts.length !== cuts.length) {
        this.state.v1CutsByClip[id] = normalizeV1Cuts(nextCuts, fps);
        this._refreshV1CutStatsForClip(id);
      }
    }
    if (changed > 0) {
      const prevTime = Number(this.state.globalTimeSec) || 0;
      this.rebuildSegments('cuts');
      this.setTime(prevTime, 'time');
      this.state.selectedV1Cut = normalizeSelectedV1Cut(this.state.selectedV1Cut, this.state.v1CutsByClip, fps);
      this.emit('cuts');
    }
    return changed;
  }

  /** Set/replace cut points (seconds, relative to clip) for V1 auto-split. */
  setV1CutsForClip(clipId, cutTimesSec = [], stats = null) {
    const id = String(clipId || '');
    if (!id) return;
    const fps = Math.max(1, Number(this.state.fps) || 24);
    const next = normalizeV1Cuts(cutTimesSec, fps);
    if (!this.state.v1CutsByClip || typeof this.state.v1CutsByClip !== 'object') this.state.v1CutsByClip = {};
    if (!this.state.v1CutStatsByClip || typeof this.state.v1CutStatsByClip !== 'object') this.state.v1CutStatsByClip = {};
    this.state.v1CutsByClip[id] = next;

    const srcStats = (stats && typeof stats === 'object') ? stats : {};
    this.state.v1CutStatsByClip[id] = {
      segments: Math.max(1, Number(srcStats.segments) || (next.length + 1)),
      uncertain: Math.max(0, Number(srcStats.uncertain) || next.filter((cut) => cut?.uncertain).length),
      tinyMerged: Math.max(0, Number(srcStats.tinyMerged) || 0),
      sampledFrames: Math.max(0, Number(srcStats.sampledFrames) || 0),
      threshold: Number.isFinite(Number(srcStats.threshold)) ? Number(srcStats.threshold) : null,
      mode: (String(srcStats.mode || this.state.autoCutSettings?.mode || 'shot').toLowerCase() === 'detailed') ? 'detailed' : 'shot',
      preset: ['rough', 'standard', 'fine'].includes(String(srcStats.preset || this.state.autoCutSettings?.preset || 'standard').toLowerCase())
        ? String(srcStats.preset || this.state.autoCutSettings?.preset || 'standard').toLowerCase()
        : 'standard',
    };
    this.rebuildSegments('cuts');
  }

  clearV1CutsForClip(clipId) {
    const id = String(clipId || '');
    if (!id) return;
    if (!this.state.v1CutsByClip || typeof this.state.v1CutsByClip !== 'object') this.state.v1CutsByClip = {};
    if (!this.state.v1CutStatsByClip || typeof this.state.v1CutStatsByClip !== 'object') this.state.v1CutStatsByClip = {};
    if (this.state.v1CutsByClip[id]) {
      try { delete this.state.v1CutsByClip[id]; } catch { this.state.v1CutsByClip[id] = []; }
      try { delete this.state.v1CutStatsByClip[id]; } catch { this.state.v1CutStatsByClip[id] = null; }
      if (String(this.state.selectedV1Cut?.clipId || '') === id) this.state.selectedV1Cut = null;
      this.rebuildSegments('cuts');
    }
  }

  clearAllV1Cuts() {
    this.state.v1CutsByClip = {};
    this.state.v1CutStatsByClip = {};
    this.state.selectedV1Cut = null;
    this.rebuildSegments('cuts');
  }

  /** Update clip fields by clipId */
  updateClip(clipId, patch) {
    const idx = this.state.clips.findIndex(c => c.id === clipId);
    if (idx < 0) return;
    this.state.clips[idx] = { ...this.state.clips[idx], ...patch };

    // Keep overlays in sync when we learn duration/canPlay/startTC.
    if (patch && (patch.durationSec != null || patch.canPlay != null || patch.startTC != null || patch.url != null)) {
      const c = this.state.clips[idx];
      for (let i = 0; i < this.state.overlays.length; i++) {
        const o = this.state.overlays[i];
        if (!o || o.clipId !== clipId) continue;
        const next = { ...o };
        next.name = c.name;
        next.shotKey = c.shotKey || parseShotKey(c.name);
        next.version = c.version || parseVersionNum(c.name);
        if (next.fullDuration) next.durationSec = Math.max(0, Number(c.durationSec) || 0);
        if (patch.canPlay != null) next.canPlay = c.canPlay !== false;
        if (patch.startTC != null) next.startTC = c.startTC || '00:00:00:00';
        next.url = c.url;
        next.globalEndSec = (Number(next.globalStartSec) || 0) + Math.max(0, Number(next.durationSec) || 0);
        this.state.overlays[i] = next;
      }
      this.emit('overlays');
    }
    this.rebuildSegments('clips');
  }

  removeClip(clipId) {
    const clip = this.state.clips.find(c => c.id === clipId);
    if (clip?.url) {
      try { URL.revokeObjectURL(clip.url); } catch {}
    }
    this.state.clips = this.state.clips.filter(c => c.id !== clipId);
    // Also remove from V1 timeline order
    this.state.timelineClipIds = (this.state.timelineClipIds || []).filter(id => id !== clipId);
    // Remove overlays belonging to that clip
    this.state.overlays = this.state.overlays.filter(o => o.clipId !== clipId);
    // Remove markers belonging to that clip
    this.state.markers = this.state.markers.filter(m => m.clipId !== clipId);
    // Remove any stored V1 cut map for this clip
    try{
      if (this.state.v1CutsByClip && typeof this.state.v1CutsByClip === 'object') {
        delete this.state.v1CutsByClip[String(clipId)];
      }
      if (this.state.v1CutStatsByClip && typeof this.state.v1CutStatsByClip === 'object') {
        delete this.state.v1CutStatsByClip[String(clipId)];
      }
      if (String(this.state.selectedV1Cut?.clipId || '') === String(clipId || '')) this.state.selectedV1Cut = null;
    }catch{}
    this.rebuildSegments('clips');
    this.emit('markers');
    this.emit('overlays');
  }

  clearAll() {
    for (const c of this.state.clips) {
      if (c.url) {
        try { URL.revokeObjectURL(c.url); } catch {}
      }
    }
    this.state.clips = [];
    this.state.timelineClipIds = [];
    this.state.v1CutsByClip = {};
    this.state.v1CutStatsByClip = {};
    this.state.selectedV1Cut = null;
    this.state.v1CutViewMode = 'all';
    this.state.segments = [];
    this.state.overlays = [];
    this.state.markers = [];
    this.state.activeIndex = -1;
    this.state.activeLayer = 'V1';
    this.state.activeOverlayId = null;
    this.state.globalTimeSec = 0;
    this.state.isPlaying = false;
    this.state.selectedMarkerId = null;
    this.emit('clips');
    this.emit('overlays');
    this.emit('markers');
    this.emit('time');
  }

  setActiveIndex(index) {
    const i = Math.max(0, Math.min(this.state.segments.length - 1, index));
    if (i === this.state.activeIndex) return;
    this.state.activeIndex = i;
    this.emit('active');
  }

  /** Add a V2 overlay clip at global timeline time. */
  addOverlay(clipId, globalStartSec, { inSec = 0, durationSec = null } = {}) {
    const c = this.state.clips.find(x => x.id === clipId);
    if (!c) return null;
    const start = Math.max(0, Number(globalStartSec) || 0);
    const dur = durationSec == null ? Math.max(0, Number(c.durationSec) || 0) : Math.max(0, Number(durationSec) || 0);
    const ovl = {
      id: uid(),
      clipId: c.id,
      name: c.name,
      shotKey: c.shotKey || parseShotKey(c.name),
      version: c.version || parseVersionNum(c.name),
      url: c.url,
      inSec: Math.max(0, Number(inSec) || 0),
      durationSec: dur,
      globalStartSec: start,
      globalEndSec: start + dur,
      fullDuration: durationSec == null,
      canPlay: c.canPlay !== false,
      startTC: c.startTC || '00:00:00:00',
      createdAt: Date.now(),
    };
    this.state.overlays = [...this.state.overlays, ovl];
    this.emit('overlays');
    this.emit('clips');
    return ovl;
  }

  moveOverlay(overlayId, newGlobalStartSec) {
    const idx = this.state.overlays.findIndex(o => o.id === overlayId);
    if (idx < 0) return;
    const o = this.state.overlays[idx];
    const start = Math.max(0, Number(newGlobalStartSec) || 0);
    const dur = Math.max(0, Number(o.durationSec) || 0);
    this.state.overlays[idx] = { ...o, globalStartSec: start, globalEndSec: start + dur };
    this.emit('overlays');
    this.emit('clips');
  }

  removeOverlay(overlayId) {
    this.state.overlays = this.state.overlays.filter(o => o.id !== overlayId);
    if (this.state.activeOverlayId === overlayId) {
      this.state.activeOverlayId = null;
      this.state.activeLayer = 'V1';
      this.emit('active');
    }
    this.emit('overlays');
    this.emit('clips');
  }

  // ---- V2 Version switching (swap overlay clip, keep timing) ----
  getVersionsForShotKey(key) {
    const k = String(key || '');
    if (!k) return [];
    const list = this.state.clips
      .map(c => ({
        ...c,
        shotKey: c.shotKey || parseShotKey(c.name),
        version: c.version || parseVersionNum(c.name),
      }))
      .filter(c => c.shotKey === k);
    list.sort((a, b) => {
      const va = Number(a.version) || 0;
      const vb = Number(b.version) || 0;
      if (va !== vb) return vb - va; // latest first
      return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
    });
    return list;
  }

  setOverlayClip(overlayId, newClipId) {
    const idx = this.state.overlays.findIndex(o => o.id === overlayId);
    if (idx < 0) return;
    const c = this.state.clips.find(x => x.id === newClipId);
    if (!c) return;
    const o = this.state.overlays[idx];
    const inSec = Math.max(0, Number(o.inSec) || 0);
    let dur = Math.max(0, Number(o.durationSec) || 0);
    const clipDur = Math.max(0, Number(c.durationSec) || 0);
    if (clipDur > 0) {
      const maxDur = Math.max(0, clipDur - inSec);
      if (o.fullDuration) dur = maxDur;
      else dur = Math.min(dur, maxDur || dur);
    }
    const start = Math.max(0, Number(o.globalStartSec) || 0);
    try { this._captureMarkersForOverlay(o); } catch {}
    this.state.overlays[idx] = {
      ...o,
      clipId: c.id,
      name: c.name,
      shotKey: c.shotKey || parseShotKey(c.name),
      version: c.version || parseVersionNum(c.name),
      url: c.url,
      canPlay: c.canPlay !== false,
      startTC: c.startTC || '00:00:00:00',
      durationSec: dur,
      globalEndSec: start + dur,
    };

    // Version-aware note sync: keep timing aligned to the new clip,
    // but load/store note payloads separately for each version.
    try {
      this._syncMarkersForOverlay(this.state.overlays[idx], {
        previousClipId: String(o.clipId || ''),
        previousClipName: String(o.name || ''),
      });
    } catch {}
    this.emit('overlays');
    this.emit('clips');
  }

  _syncMarkersForOverlay(ovl, opts = {}) {
    if (!ovl) return;
    const fps = Number(this.state.fps) || 24;
    const start = Math.max(0, Number(ovl.globalStartSec) || 0);
    const end = Math.max(start, Number(ovl.globalEndSec) || (start + (Number(ovl.durationSec) || 0)));
    const inSec = Math.max(0, Number(ovl.inSec) || 0);
    const clipId = String(ovl.clipId || '');
    const clipName = String(ovl.name || '');
    const startTC = String(ovl.startTC || '00:00:00:00');
    const startFrames = tcToFrames(startTC, fps);
    const previousClipId = String(opts?.previousClipId || '');

    let changed = false;
    const updated = (this.state.markers || []).map(m => {
      if (!m) return m;
      if (String(m.layer || '') !== 'V2') return this._normalizeMarkerRecord(m);
      const gt = Math.max(0, Number(m.globalTimeSec) || 0);
      if (gt < start || gt >= end) return this._normalizeMarkerRecord(m);

      const next = this._normalizeMarkerRecord({ ...m });
      try {
        this._captureMarkerVersionData(next, previousClipId || String(m.clipId || ''));
      } catch {}

      const local = Math.max(0, (gt - start) + inSec);
      const localFrame = Math.round(local * fps);
      const srcFrames = startFrames + localFrame;
      const variant = this._getMarkerVersionData(next, clipId) || this._blankMarkerVersionData();
      const reviewByClipId = sanitizeMarkerReviewMap(next.reviewByClipId);
      if (clipId && !reviewByClipId[clipId]) reviewByClipId[clipId] = cloneMarkerVersionData(variant);

      const patch = {
        clipId,
        clipName,
        srcTC: framesToTc(srcFrames, fps),
        localTimeSec: local,
        localFrame,
        reviewByClipId,
        ...variant,
      };

      const merged = { ...next, ...patch };
      if (
        String(m.clipId || '') === String(merged.clipId || '') &&
        String(m.clipName || '') === String(merged.clipName || '') &&
        String(m.srcTC || '') === String(merged.srcTC || '') &&
        Number(m.localFrame || 0) === Number(merged.localFrame || 0) &&
        Number(m.localTimeSec || 0) === Number(merged.localTimeSec || 0) &&
        String(m.status || '') === String(merged.status || '') &&
        String(m.issueType || '') === String(merged.issueType || '') &&
        String(m.severity || '') === String(merged.severity || '') &&
        String(m.note || '') === String(merged.note || '') &&
        String(m.noteTypeGroup || '') === String(merged.noteTypeGroup || '') &&
        String(m.noteType || '') === String(merged.noteType || '') &&
        String(m.scopeOfWork || '') === String(merged.scopeOfWork || '') &&
        JSON.stringify(m.scopeOfWorkList || []) === JSON.stringify(merged.scopeOfWorkList || []) &&
        String(m.thumbKey || '') === String(merged.thumbKey || '') &&
        String(m.thumbBaseKey || '') === String(merged.thumbBaseKey || '') &&
        String(m.thumbAnnoKey || '') === String(merged.thumbAnnoKey || '') &&
        String(m.thumbDataUrl || '') === String(merged.thumbDataUrl || '') &&
        String(m.thumbBaseDataUrl || '') === String(merged.thumbBaseDataUrl || '') &&
        String(m.thumbAnnoDataUrl || '') === String(merged.thumbAnnoDataUrl || '') &&
        !!m.thumbAnnotated === !!merged.thumbAnnotated &&
        JSON.stringify(m.annoShapes || []) === JSON.stringify(merged.annoShapes || []) &&
        JSON.stringify(m.reviewByClipId || {}) === JSON.stringify(merged.reviewByClipId || {})
      ) return merged;

      changed = true;
      return merged;
    });

    if (changed) {
      this.state.markers = updated;
      this.emit('markers');
    }
  }

  cycleOverlayVersion(overlayId, dir = 1) {
    const o = this.state.overlays.find(x => x.id === overlayId);
    if (!o) return;
    const key = o.shotKey || parseShotKey(o.name);
    const vers = this.getVersionsForShotKey(key);
    if (vers.length < 2) return;
    const curIdx = Math.max(0, vers.findIndex(v => v.id === o.clipId));
    const step = Number(dir) || 1;
    const nextIdx = (curIdx + step + vers.length) % vers.length;
    this.setOverlayClip(overlayId, vers[nextIdx].id);
  }

  addMarker({ note = '' } = {}) {
    const fps = this.state.fps;
    const globalSec = this.state.globalTimeSec;
    const pb = this.getPlaybackAtTime(globalSec);
    const seg = pb?.seg;
    if (!seg) return null;
    const localTimeSec = Math.max(0, Number(pb.localTimeSec) || 0);

    const globalFrame = Math.round(globalSec * fps);
    const localFrame = Math.round(localTimeSec * fps);
    const startFrames = tcToFrames(seg.startTC || '00:00:00:00', fps);
    const srcFrames = startFrames + localFrame;

    const marker = {
      id: uid(),
      createdAt: Date.now(),
      // Review workflow fields
      status: '', // '' | APPROVED | NEED_FIX | HOLD
      issueType: 'General',
      severity: 'S2',
      thumbDataUrl: null,
      thumbAnnotated: false,
      layer: pb.layer,
      clipId: seg.clipId,
      clipIndex: pb.clipIndex,
      clipName: seg.name,
      globalTimeSec: globalSec,
      globalFrame,
      localTimeSec,
      localFrame,
      srcTC: framesToTc(srcFrames, fps),
      note,
      // Spot-On style taxonomy
      noteTypeGroup: '', // add | remove | change
      noteType: '',
      scopeOfWork: '',
      scopeOfWorkList: [],
      reviewByClipId: {},
    };

    if (String(marker.layer || '') === 'V2' && marker.clipId) {
      marker.reviewByClipId = this._captureMarkerVersionData(marker, marker.clipId);
    } else {
      marker.reviewByClipId = sanitizeMarkerReviewMap(marker.reviewByClipId);
    }

    this.state.markers = [...this.state.markers, marker].sort((a, b) => a.globalTimeSec - b.globalTimeSec);
    this.state.selectedMarkerId = marker.id;
    this.emit('markers');
    return marker;
  }

  updateMarker(markerId, patch) {
    const idx = this.state.markers.findIndex(m => m.id === markerId);
    if (idx < 0) return;
    const next = this._normalizeMarkerRecord({ ...this.state.markers[idx], ...(patch && typeof patch === 'object' ? patch : {}) });
    if (String(next.layer || '') === 'V2') this._syncMarkerCurrentVersionData(next);
    this.state.markers[idx] = next;
    this.emit('markers');
  }

  removeMarker(markerId) {
    const id = String(markerId || '');
    const prev = Array.isArray(this.state.markers) ? this.state.markers.slice() : [];
    const wasSelected = (String(this.state.selectedMarkerId || '') === id);
    const prevIdx = prev.findIndex(m => String(m?.id || '') === id);

    this.state.markers = prev.filter(m => String(m?.id || '') !== id);

    // UX: if the deleted marker was selected, auto-select the nearest remaining marker
    // so the Notes panel never ends up blank after a delete.
    if (wasSelected) {
      const arr = this.state.markers;
      if (arr.length) {
        const pick = Math.min(Math.max(0, Number.isFinite(prevIdx) ? prevIdx : 0), arr.length - 1);
        this.state.selectedMarkerId = String(arr[pick]?.id || arr[arr.length - 1]?.id || '') || null;
      } else {
        this.state.selectedMarkerId = null;
      }
    }

    this.emit('markers');
  }

  selectMarker(markerId) {
    const nextId = markerId == null ? null : String(markerId);
    if (this.state.selectedMarkerId === nextId) return;
    this.state.selectedMarkerId = nextId;
    this.emit('marker_select');
  }

  getSelectedMarker() {
    return this.state.markers.find(m => m.id === this.state.selectedMarkerId) || null;
  }

  exportMarkersJSON() {
    const payload = {
      type: 'PostFlowX_VFXReviews_Markers',
      version: 1,
      exportedAt: new Date().toISOString(),
      fps: this.state.fps,
      clips: this.state.segments.map(s => ({
        index: s.index,
        clipId: s.clipId,
        name: s.name,
        durationSec: s.durationSec,
        startTC: s.startTC,
      })),
      overlays: this.state.overlays.map(o => ({
        id: o.id,
        clipId: o.clipId,
        name: o.name,
        globalStartSec: o.globalStartSec,
        durationSec: o.durationSec,
        inSec: o.inSec,
      })),
      markers: this.state.markers,
    };
    return JSON.stringify(payload, null, 2);
  }

  exportMarkersCSV() {
    const header = [
      'GlobalTime', 'GlobalFrame', 'ClipIndex', 'ClipName', 'LocalTime', 'LocalFrame', 'SRC_TC',
      'NoteTypeGroup', 'NoteType', 'ScopeOfWork', 'IssueType', 'Severity', 'Status', 'Note'
    ];
    const rows = this.state.markers.map(m => ([
      secondsToClock(m.globalTimeSec),
      m.globalFrame,
      m.clipIndex,
      m.clipName,
      secondsToClock(m.localTimeSec),
      m.localFrame,
      m.srcTC,
      (m.noteTypeGroup || ''),
      (m.noteType || ''),
      (m.scopeOfWork || ''),
      (m.issueType || 'General'),
      (m.severity || 'S2'),
      m.status || '',
      (m.note || '').replace(/\r?\n/g, ' '),
    ]));

    const esc = (v) => {
      const s = String(v ?? '');
      return /[\",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    return [header, ...rows].map(r => r.map(esc).join(',')).join('\n');
  }

  /** Export full state for project save (best-effort, JSON-serializable). */
  exportState() {
    // state is already plain data, but we clone to avoid accidental mutation.
    try{ return JSON.parse(JSON.stringify(this.state)); }catch{ return this.state; }
  }

  /** Import previously saved state and rebuild derived structures. */
  importState(state) {
    if (!state || typeof state !== 'object') return;
    // Keep only known keys to avoid injecting unexpected props.
    // Normalize clips: blob: URLs and File objects do NOT survive refresh.
    // We keep lightweight metadata so Media Manager can relink.
    const tlIds = Array.isArray(state.timelineClipIds) ? state.timelineClipIds : [];

    const normClips = (Array.isArray(state.clips) ? state.clips : []).map((c) => {
      const name = String(c?.name || 'Untitled');
      const url = String(c?.url || '');
      const fileMeta = (c && typeof c === 'object' && c.fileMeta && typeof c.fileMeta === 'object') ? c.fileMeta : null;
      const size = Number(fileMeta?.size ?? c?.size ?? 0) || 0;
      const lastModified = Number(fileMeta?.lastModified ?? c?.lastModified ?? 0) || 0;
      const type = String(fileMeta?.type ?? c?.type ?? '') || '';
      const stableMeta = { name, size, lastModified, type };

      // If this was a previous session blob URL, it is now invalid.
      const urlOk = url && !url.startsWith('blob:') ? url : '';
      const canPlay = urlOk ? (c?.canPlay !== false) : false;

      const rawBin = String(c?.bin || c?.role || '').toLowerCase();
      const bin = (rawBin === 'ref' || rawBin === 'v1') ? 'ref'
        : (rawBin === 'shots' || rawBin === 'v2') ? 'shots'
        : (tlIds.includes(c?.id) ? 'ref' : 'shots');

      return {
        ...c,
        bin,
        name,
        url: urlOk,
        canPlay,
        file: null,
        // FileSystemFileHandle is not JSON-serializable; exportState() JSON-izes it to {}.
        // Explicitly clear it here so we never store a broken {} as a "handle".
        // The real handle is reloaded from the dedicated media-handles IDB snapshot on mount.
        fsHandle: null,
        fileMeta: stableMeta,
      };
    });

    const markers = (Array.isArray(state.markers) ? state.markers : []).map((marker) => this._normalizeMarkerRecord(marker)).filter(Boolean);
    const sel = state.selectedMarkerId || null;
    const selOk = !!(sel && markers.some(m => m && m.id === sel));
    const selFinal = selOk ? sel : (markers.length ? (markers[0]?.id || null) : null);

    const next = {
      fps: Number(state.fps) || 24,
      pxPerSec: Number(state.pxPerSec) || 80,
      clips: normClips,
      timelineClipIds: Array.isArray(state.timelineClipIds) ? state.timelineClipIds : [],
      autoCutSettings: normalizeAutoCutSettings(state.autoCutSettings),
      v1CutsByClip: normalizeV1CutsMap(state.v1CutsByClip, Number(state.fps) || 24),
      v1CutStatsByClip: normalizeV1CutStatsMap(state.v1CutStatsByClip),
      selectedV1Cut: normalizeSelectedV1Cut(state.selectedV1Cut, normalizeV1CutsMap(state.v1CutsByClip, Number(state.fps) || 24), Number(state.fps) || 24),
      v1CutViewMode: normalizeV1CutViewMode(state.v1CutViewMode),
      segments: Array.isArray(state.segments) ? state.segments : [],
      // Normalize overlay blob URLs: they're snapshots of clip.url at creation time.
      // After refresh the blob is revoked; syncOverlayToState now resolves from live clip,
      // but clearing here prevents videoV2 from trying to load a dead URL before relink runs.
      overlays: (Array.isArray(state.overlays) ? state.overlays : []).map(o => {
        if (!o) return o;
        const rawUrl = String(o.url || '');
        return rawUrl.startsWith('blob:') ? { ...o, url: '', canPlay: false } : o;
      }),
      activeIndex: Number.isFinite(state.activeIndex) ? state.activeIndex : -1,
      activeLayer: (state.activeLayer === 'V2') ? 'V2' : 'V1',
      activeOverlayId: state.activeOverlayId || null,
      isPlaying: !!state.isPlaying,
      globalTimeSec: Number(state.globalTimeSec) || 0,
      markers,
      selectedMarkerId: selFinal,
    };

    this.state = next;
    // Rebuild segments to ensure global ranges are consistent.
    this.rebuildSegments('import');
    this.setTime(this.state.globalTimeSec, 'import');
    this.emit('import');
  }
}
