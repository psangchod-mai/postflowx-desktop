// PostFlowX – VFX Reviews Auto Cut (Patch A)
// Multi-signal cut detection for V1 timeline shot splitting.

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const sleep0 = () => new Promise((resolve) => setTimeout(resolve, 0));

export const AUTO_CUT_PRESETS = {
  rough: {
    label: 'Rough',
    minFrames: 24,
    cutThreshold: 0.78,
    uncertainThreshold: 0.64,
    mergeTinyUnderFrames: 8,
    maxSamples: 10000,
    targetSampleFrames: 8,
    madScale: 4.8,
  },
  standard: {
    label: 'Standard',
    minFrames: 12,
    cutThreshold: 0.68,
    uncertainThreshold: 0.56,
    mergeTinyUnderFrames: 4,
    maxSamples: 14000,
    targetSampleFrames: 6,
    madScale: 4.1,
  },
  fine: {
    label: 'Fine',
    minFrames: 6,
    cutThreshold: 0.60,
    uncertainThreshold: 0.50,
    mergeTinyUnderFrames: 2,
    maxSamples: 16000,
    targetSampleFrames: 4,
    madScale: 3.5,
  },
};

const AUTO_CUT_MODES = {
  shot: {
    scoreBias: 0.03,
    minGapScale: 1.0,
    allowDenseCuts: false,
  },
  detailed: {
    scoreBias: -0.035,
    minGapScale: 0.55,
    allowDenseCuts: true,
  },
};

function median(values) {
  const arr = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!arr.length) return 0;
  const mid = Math.floor(arr.length / 2);
  return (arr.length % 2) ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function mad(values, med) {
  const arr = (Array.isArray(values) ? values : []).map((v) => Math.abs((Number(v) || 0) - med));
  return median(arr);
}

function percentile(values, p) {
  const arr = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!arr.length) return 0;
  const q = clamp01(p);
  const idx = Math.min(arr.length - 1, Math.max(0, Math.floor(q * (arr.length - 1))));
  return arr[idx] || 0;
}

function normalizePreset(preset) {
  const key = String(preset || 'standard').toLowerCase();
  return AUTO_CUT_PRESETS[key] ? key : 'standard';
}

function normalizeMode(mode) {
  const key = String(mode || 'shot').toLowerCase();
  return AUTO_CUT_MODES[key] ? key : 'shot';
}

function normalizeIgnoreRegions(ignoreRegions = []) {
  if (!Array.isArray(ignoreRegions)) return [];
  return ignoreRegions.map((r) => ({
    x: Number(r?.x) || 0,
    y: Number(r?.y) || 0,
    w: Number(r?.w) || 0,
    h: Number(r?.h) || 0,
    enabled: r?.enabled !== false,
  })).filter((r) => r.enabled && r.w > 0 && r.h > 0);
}

function buildMask(width, height, regions) {
  const out = new Uint8Array(width * height);
  out.fill(1);
  if (!regions.length) return out;

  for (const region of regions) {
    let x = region.x;
    let y = region.y;
    let w = region.w;
    let h = region.h;

    // Treat <=1 as normalized coordinates; otherwise assume pixels.
    if (x <= 1 && y <= 1 && w <= 1 && h <= 1) {
      x *= width;
      y *= height;
      w *= width;
      h *= height;
    }

    const x0 = Math.max(0, Math.min(width, Math.floor(x)));
    const y0 = Math.max(0, Math.min(height, Math.floor(y)));
    const x1 = Math.max(x0, Math.min(width, Math.ceil(x + w)));
    const y1 = Math.max(y0, Math.min(height, Math.ceil(y + h)));

    for (let yy = y0; yy < y1; yy++) {
      const row = yy * width;
      for (let xx = x0; xx < x1; xx++) out[row + xx] = 0;
    }
  }
  return out;
}

function extractFrameFeatures(imgData, mask) {
  const width = Number(imgData?.width) || 0;
  const height = Number(imgData?.height) || 0;
  const data = imgData?.data;
  if (!width || !height || !data?.length) return null;

  const n = width * height;
  const luma = new Uint8Array(n);
  const hist = new Uint32Array(16);
  let count = 0;
  let sum = 0;
  let black = 0;
  let highlight = 0;

  for (let i = 0, px = 0; i < data.length; i += 4, px++) {
    if (mask && !mask[px]) {
      luma[px] = 0;
      continue;
    }
    const y = Math.round((data[i] * 0.2126) + (data[i + 1] * 0.7152) + (data[i + 2] * 0.0722));
    luma[px] = y;
    sum += y;
    count++;
    hist[Math.max(0, Math.min(15, Math.floor(y / 16)))]++;
    if (y <= 24) black++;
    if (y >= 228) highlight++;
  }

  if (!count) return null;

  let edgeSum = 0;
  let edgeCount = 0;
  for (let yy = 1; yy < height; yy++) {
    for (let xx = 1; xx < width; xx++) {
      const idx = yy * width + xx;
      if (mask && !mask[idx]) continue;
      const left = idx - 1;
      const up = idx - width;
      if ((mask && !mask[left]) || (mask && !mask[up])) continue;
      edgeSum += Math.abs(luma[idx] - luma[left]) + Math.abs(luma[idx] - luma[up]);
      edgeCount += 2;
    }
  }

  const histNorm = Array.from(hist, (v) => v / count);
  return {
    width,
    height,
    count,
    luma,
    hist: histNorm,
    meanLuma: sum / count / 255,
    blackRatio: black / count,
    highlightRatio: highlight / count,
    edgeMean: edgeCount ? (edgeSum / edgeCount / 255) : 0,
  };
}

function diffFeatures(a, b) {
  if (!a || !b || !a.luma || !b.luma || a.luma.length !== b.luma.length) {
    return {
      lumaDelta: 0,
      histDelta: 0,
      edgeDelta: 0,
      similarity: 1,
      blackDelta: 0,
      highlightSpike: 0,
      meanDelta: 0,
    };
  }

  let lumaAbs = 0;
  for (let i = 0; i < a.luma.length; i++) lumaAbs += Math.abs(a.luma[i] - b.luma[i]);
  const lumaDelta = lumaAbs / (a.luma.length * 255);

  let histDelta = 0;
  for (let i = 0; i < a.hist.length; i++) histDelta += Math.abs((a.hist[i] || 0) - (b.hist[i] || 0));
  histDelta *= 0.5;

  const edgeDelta = Math.abs((a.edgeMean || 0) - (b.edgeMean || 0));
  const meanDelta = Math.abs((a.meanLuma || 0) - (b.meanLuma || 0));
  const blackDelta = Math.abs((a.blackRatio || 0) - (b.blackRatio || 0));
  const highlightSpike = Math.max(0, (b.highlightRatio || 0) - (a.highlightRatio || 0));

  const similarity = clamp01(1 - (
    (lumaDelta * 0.68) +
    (histDelta * 0.18) +
    (edgeDelta * 0.10) +
    (meanDelta * 0.04)
  ));

  return {
    lumaDelta,
    histDelta,
    edgeDelta,
    similarity,
    blackDelta,
    highlightSpike,
    meanDelta,
  };
}

function dominantReasons(metrics = {}) {
  const out = [];
  if ((metrics.lumaDelta || 0) >= 0.14) out.push('luma_jump');
  if ((metrics.histDelta || 0) >= 0.12) out.push('hist_delta');
  if (((1 - (metrics.similarity || 1)) || 0) >= 0.18) out.push('similarity_drop');
  if ((metrics.edgeDelta || 0) >= 0.08) out.push('edge_change');
  if ((metrics.highlightSpike || 0) >= 0.05) out.push('highlight_spike');
  if ((metrics.blackDelta || 0) >= 0.08) out.push('black_ratio_shift');
  return out.slice(0, 3);
}

function classifyCut(metrics = {}, mode = 'shot') {
  const highlightSpike = Number(metrics.highlightSpike) || 0;
  const blackDelta = Number(metrics.blackDelta) || 0;
  const edgeDelta = Number(metrics.edgeDelta) || 0;
  const lumaDelta = Number(metrics.lumaDelta) || 0;
  const histDelta = Number(metrics.histDelta) || 0;

  if (highlightSpike >= 0.08 && lumaDelta >= 0.14) return 'flash_cut';
  if (blackDelta >= 0.14 && lumaDelta >= 0.12) return 'fade_like';
  if (mode === 'detailed' && edgeDelta >= 0.10 && histDelta >= 0.10 && lumaDelta >= 0.10) return 'motion_break';
  return 'hard_cut';
}

function mergeDenseCandidates(candidates, fps, minGapFrames) {
  const minGapSec = Math.max(1 / Math.max(1, fps), (Number(minGapFrames) || 1) / Math.max(1, fps));
  const kept = [];
  let merged = 0;
  for (const cand of candidates) {
    const prev = kept[kept.length - 1];
    if (!prev) {
      kept.push(cand);
      continue;
    }
    if ((cand.timeSec - prev.timeSec) < minGapSec) {
      if ((cand.score || 0) > (prev.score || 0)) kept[kept.length - 1] = cand;
      merged++;
      continue;
    }
    kept.push(cand);
  }
  return { kept, merged };
}

function mergeTinySegments(candidates, fps, mergeTinyUnderFrames, durationSec) {
  const keep = [];
  let tinyMerged = 0;
  let lastBoundary = 0;

  for (const cand of candidates) {
    const segFrames = Math.round((cand.timeSec - lastBoundary) * fps);
    if (segFrames > 0 && segFrames < mergeTinyUnderFrames) {
      tinyMerged++;
      continue;
    }
    keep.push(cand);
    lastBoundary = cand.timeSec;
  }

  if (keep.length) {
    const tailFrames = Math.round((Math.max(0, durationSec) - keep[keep.length - 1].timeSec) * fps);
    if (tailFrames > 0 && tailFrames < mergeTinyUnderFrames) {
      keep.pop();
      tinyMerged++;
    }
  }

  return { kept: keep, tinyMerged };
}

export async function analyzeClipForAutoCut(opts = {}) {
  const clip = opts?.clip || null;
  const url = String(opts?.url || clip?.url || '');
  if (!url) throw new Error('V1 clip not linked (drop/relink the media first).');

  const mode = normalizeMode(opts?.mode);
  const presetKey = normalizePreset(opts?.preset);
  const preset = {
    ...AUTO_CUT_PRESETS[presetKey],
    ...(opts?.thresholds && typeof opts.thresholds === 'object' ? opts.thresholds : {}),
  };
  const modeCfg = AUTO_CUT_MODES[mode] || AUTO_CUT_MODES.shot;
  const fps = Math.max(1, Math.round(Number(opts?.fps || clip?.fps || 24)) || 24);
  const ignoreRegions = normalizeIgnoreRegions(opts?.ignoreRegions || []);
  const onProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : null;
  const shouldAbort = typeof opts?.shouldAbort === 'function' ? opts.shouldAbort : () => false;

  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  try { v.crossOrigin = 'anonymous'; } catch {}
  v.style.position = 'fixed';
  v.style.left = '-99999px';
  v.style.top = '0';
  v.style.width = '16px';
  v.style.height = '16px';
  v.style.opacity = '0';
  v.style.pointerEvents = 'none';
  document.body.appendChild(v);

  const cleanup = () => {
    try { v.pause(); } catch {}
    try { v.removeAttribute('src'); v.load(); } catch {}
    try { v.remove(); } catch {}
  };

  const waitFor = (ev) => new Promise((resolve, reject) => {
    const onOk = () => { cleanupEv(); resolve(true); };
    const onErr = () => { cleanupEv(); reject(new Error('Cannot decode V1 clip (H.264 only).')); };
    const cleanupEv = () => {
      try { v.removeEventListener(ev, onOk); } catch {}
      try { v.removeEventListener('error', onErr); } catch {}
    };
    v.addEventListener(ev, onOk, { once: true });
    v.addEventListener('error', onErr, { once: true });
  });

  const seekTo = (t) => new Promise((resolve) => {
    const onSeek = () => { try { v.removeEventListener('seeked', onSeek); } catch {} resolve(true); };
    v.addEventListener('seeked', onSeek);
    try { v.currentTime = t; } catch {
      try { v.removeEventListener('seeked', onSeek); } catch {}
      resolve(false);
    }
  });

  try {
    if (shouldAbort()) throw new Error('aborted');

    v.src = url;
    v.load();
    await waitFor('loadedmetadata');
    const durationSec = Math.max(0, Number(v.duration) || Number(clip?.durationSec) || 0);
    if (!durationSec || !Number.isFinite(durationSec)) throw new Error('Unknown duration');

    const W = 96;
    const H = 54;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas not supported');
    const mask = buildMask(W, H, ignoreRegions);

    let sampleStepSec = Math.max(2 / fps, (Number(preset.targetSampleFrames) || 6) / fps);
    if ((durationSec / sampleStepSec) > (Number(preset.maxSamples) || 14000)) {
      sampleStepSec = durationSec / Math.max(1, Number(preset.maxSamples) || 14000);
    }
    sampleStepSec = Math.max(1 / fps, Math.min(sampleStepSec, 0.75));

    const grabAt = async (timeSec) => {
      if (shouldAbort()) throw new Error('aborted');
      const tt = Math.max(0, Math.min(durationSec - 0.001, Number(timeSec) || 0));
      await seekTo(tt);
      try {
        ctx.drawImage(v, 0, 0, W, H);
        const img = ctx.getImageData(0, 0, W, H);
        return extractFrameFeatures(img, mask);
      } catch (err) {
        throw new Error('Cannot read video frames (security restriction).');
      }
    };

    const samples = [];
    let prevFeat = await grabAt(0);
    let prevTimeSec = 0;
    const sampleCount = Math.max(1, Math.floor(durationSec / sampleStepSec));
    for (let i = 1; i <= sampleCount; i++) {
      const timeSec = Math.min(durationSec - 0.001, i * sampleStepSec);
      const feat = await grabAt(timeSec);
      const metrics = diffFeatures(prevFeat, feat);
      samples.push({ timeSec, prevTimeSec, ...metrics });
      prevFeat = feat;
      prevTimeSec = timeSec;
      if (i % 24 === 0) {
        try { onProgress && onProgress(Math.min(0.98, timeSec / durationSec)); } catch {}
        await sleep0();
      }
    }

    if (!samples.length) {
      try { onProgress && onProgress(1); } catch {}
      return {
        cuts: [],
        stats: { segments: 1, uncertain: 0, tinyMerged: 0, sampledFrames: 0 },
        meta: { mode, preset: presetKey },
      };
    }

    const rawScores = samples.map((s) => clamp01(
      (s.lumaDelta * 0.30) +
      (s.histDelta * 0.25) +
      (s.edgeDelta * 0.20) +
      ((1 - s.similarity) * 0.25) +
      (Math.min(0.16, s.highlightSpike) * 0.12) +
      (Math.min(0.14, s.blackDelta) * 0.06)
    ));

    const med = median(rawScores);
    const dev = mad(rawScores, med);
    const p96 = percentile(rawScores, 0.96);
    const adaptiveBase = Math.max(
      Number(preset.cutThreshold) || 0.68,
      med + (dev * (Number(preset.madScale) || 4.1)),
      p96 * 0.87
    );
    const adaptiveThreshold = clamp01(adaptiveBase + (Number(modeCfg.scoreBias) || 0));
    const uncertainThreshold = clamp01(Math.min(
      adaptiveThreshold - 0.02,
      Math.max(Number(preset.uncertainThreshold) || 0.56, adaptiveThreshold * 0.82)
    ));

    const candidates = [];
    for (let i = 0; i < samples.length; i++) {
      const score = rawScores[i];
      if (score < uncertainThreshold) continue;
      const prev = rawScores[i - 1] ?? -1;
      const next = rawScores[i + 1] ?? -1;
      if (score < prev || score < next) continue;

      const metrics = samples[i];
      const type = classifyCut(metrics, mode);
      const reasons = dominantReasons(metrics);
      const uncertain = score < adaptiveThreshold || ((1 - metrics.similarity) < 0.16 && score < (adaptiveThreshold + 0.04));
      const confidence = clamp01((score - uncertainThreshold) / Math.max(0.001, 1 - uncertainThreshold));
      candidates.push({
        timeSec: metrics.timeSec,
        frame: Math.round(metrics.timeSec * fps),
        type,
        confidence,
        uncertain,
        reason: reasons.join('+') || 'multi_signal_cut',
        score,
      });
    }

    const minGapFrames = Math.max(2, Math.round((Number(preset.minFrames) || 6) * (Number(modeCfg.minGapScale) || 1)));
    const deduped = mergeDenseCandidates(candidates, fps, minGapFrames);
    const mergedTiny = mergeTinySegments(deduped.kept, fps, Math.max(1, Number(preset.mergeTinyUnderFrames) || 0), durationSec);
    const cuts = mergedTiny.kept.map((cut) => ({
      timeSec: Number(cut.timeSec) || 0,
      frame: Number.isFinite(cut.frame) ? cut.frame : Math.round((Number(cut.timeSec) || 0) * fps),
      type: String(cut.type || 'hard_cut'),
      confidence: clamp01(cut.confidence),
      reason: String(cut.reason || 'multi_signal_cut'),
      uncertain: !!cut.uncertain,
      score: clamp01(cut.score),
    }));

    const uncertainCount = cuts.filter((cut) => cut.uncertain).length;
    try { onProgress && onProgress(1); } catch {}

    return {
      cuts,
      stats: {
        segments: Math.max(1, cuts.length + 1),
        uncertain: uncertainCount,
        tinyMerged: Number(deduped.merged || 0) + Number(mergedTiny.tinyMerged || 0),
        sampledFrames: samples.length,
        threshold: adaptiveThreshold,
      },
      meta: { mode, preset: presetKey, fps, stepSec: sampleStepSec },
    };
  } finally {
    cleanup();
  }
}


export async function analyzeClipForSceneCutDetect(opts = {}) {
  const clip = opts?.clip || null;
  const url = String(opts?.url || clip?.url || '');
  if (!url) throw new Error('V1 clip not linked (drop/relink the media first).');

  const fps = Math.max(1, Math.round(Number(opts?.fps || clip?.fps || 24)) || 24);
  const sensitivity = Math.max(0, Math.min(100, parseInt(String(opts?.sensitivity ?? 60), 10) || 60));
  const sensN = sensitivity / 100;
  const onProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : null;
  const shouldAbort = typeof opts?.shouldAbort === 'function' ? opts.shouldAbort : () => false;

  const sampleInterval = 0.25 + (1 - sensN) * 0.25;
  const hardMult = 3.6 - sensN * 1.6;
  const dissolveMult = 1.25 - sensN * 0.35;
  const dissolveMin = 1.0 + (1 - sensN) * 1.0;
  const minGapSec = Math.max(1 / fps, 0.5 + (1 - sensN) * 0.5);

  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  try { v.crossOrigin = 'anonymous'; } catch {}
  v.style.position = 'fixed';
  v.style.left = '-99999px';
  v.style.top = '0';
  v.style.width = '16px';
  v.style.height = '16px';
  v.style.opacity = '0';
  v.style.pointerEvents = 'none';
  document.body.appendChild(v);

  const cleanup = () => {
    try { v.pause(); } catch {}
    try { v.removeAttribute('src'); v.load(); } catch {}
    try { v.remove(); } catch {}
  };

  const waitFor = (ev) => new Promise((resolve, reject) => {
    const onOk = () => { cleanupEv(); resolve(true); };
    const onErr = () => { cleanupEv(); reject(new Error('Cannot decode V1 clip (H.264 only).')); };
    const cleanupEv = () => {
      try { v.removeEventListener(ev, onOk); } catch {}
      try { v.removeEventListener('error', onErr); } catch {}
    };
    v.addEventListener(ev, onOk, { once: true });
    v.addEventListener('error', onErr, { once: true });
  });

  const seekTo = (t) => new Promise((resolve) => {
    const onSeek = () => { try { v.removeEventListener('seeked', onSeek); } catch {} resolve(true); };
    v.addEventListener('seeked', onSeek);
    try { v.currentTime = t; } catch {
      try { v.removeEventListener('seeked', onSeek); } catch {}
      resolve(false);
    }
  });

  const frameToLuma = (imgData) => {
    const data = imgData?.data;
    if (!data?.length) return new Uint8Array(0);
    const out = new Uint8Array((imgData.width || 0) * (imgData.height || 0));
    let oi = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      out[oi++] = (54 * r + 183 * g + 19 * b) >> 8;
    }
    return out;
  };

  const diffLuma = (a, b) => {
    if (!a || !b || a.length !== b.length) return 0;
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / Math.max(1, a.length);
  };

  try {
    if (shouldAbort()) throw new Error('aborted');

    v.src = url;
    v.load();
    await waitFor('loadedmetadata');
    const durationSec = Math.max(0, Number(v.duration) || Number(clip?.durationSec) || 0);
    if (!durationSec || !Number.isFinite(durationSec)) throw new Error('Unknown duration');

    const W = 160;
    const H = 90;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas not supported');

    let prevLuma = null;
    let ema = 0;
    let emavar = 25;
    let dissolveOn = false;
    let dissolveStart = 0;
    let sampledFrames = 0;
    const rawCuts = [];

    const updateStats = (x) => {
      const alpha = 0.05;
      const d = x - ema;
      ema = ema + alpha * d;
      emavar = (1 - alpha) * emavar + alpha * d * d;
      const std = Math.sqrt(Math.max(1e-6, emavar));
      return { ema, std };
    };

    const sampleCount = Math.max(1, Math.ceil(durationSec / sampleInterval));
    for (let i = 0; i <= sampleCount; i++) {
      if (shouldAbort()) throw new Error('aborted');
      const t = Math.min(durationSec - 0.001, i * sampleInterval);
      await seekTo(Math.max(0, t));
      try {
        ctx.drawImage(v, 0, 0, W, H);
        const img = ctx.getImageData(0, 0, W, H);
        const luma = frameToLuma(img);
        if (prevLuma) {
          sampledFrames += 1;
          const x = diffLuma(luma, prevLuma);
          const { std } = updateStats(x);
          const hardThr = Math.max(18, ema + std * hardMult);
          const motionThr = Math.max(8, ema + std * dissolveMult);

          if (x >= hardThr) {
            rawCuts.push({
              timeSec: t,
              frame: Math.round(t * fps),
              type: 'hard_cut',
              confidence: clamp01(0.5 + ((x - hardThr) / Math.max(1, 255 - hardThr))),
              uncertain: x < (hardThr * 1.08),
              reason: 'scene_cut_detect',
              score: clamp01(x / 255),
            });
            dissolveOn = false;
          } else if (x >= motionThr) {
            if (!dissolveOn) {
              dissolveOn = true;
              dissolveStart = t;
            }
          } else if (dissolveOn) {
            const dur = t - dissolveStart;
            if (dur >= dissolveMin) {
              const mid = dissolveStart + (dur * 0.5);
              rawCuts.push({
                timeSec: mid,
                frame: Math.round(mid * fps),
                type: 'dissolve',
                confidence: clamp01(0.56 + sensN * 0.18),
                uncertain: true,
                reason: 'scene_dissolve_detect',
                score: clamp01(motionThr / 255),
              });
            }
            dissolveOn = false;
          }
        }
        prevLuma = luma;
      } catch {
        throw new Error('Cannot read video frames (security restriction).');
      }
      if ((i % 5) === 0) {
        try { onProgress && onProgress(Math.min(0.98, t / durationSec), { cuts: rawCuts.length }); } catch {}
        await sleep0();
      }
    }

    if (dissolveOn) {
      const tailTime = Math.min(durationSec - 0.001, sampleCount * sampleInterval);
      const dur = tailTime - dissolveStart;
      if (dur >= dissolveMin) {
        const mid = dissolveStart + (dur * 0.5);
        rawCuts.push({
          timeSec: mid,
          frame: Math.round(mid * fps),
          type: 'dissolve',
          confidence: clamp01(0.56 + sensN * 0.18),
          uncertain: true,
          reason: 'scene_dissolve_detect',
          score: clamp01(0.36 + sensN * 0.12),
        });
      }
    }

    const cuts = [];
    const sortedCuts = rawCuts
      .filter((cut) => Number.isFinite(Number(cut?.timeSec)) && Number(cut.timeSec) > 0 && Number(cut.timeSec) < (durationSec - 0.05))
      .sort((a, b) => Number(a.timeSec) - Number(b.timeSec));
    for (const cut of sortedCuts) {
      const prev = cuts[cuts.length - 1];
      if (!prev || (Number(cut.timeSec) - Number(prev.timeSec)) >= minGapSec) cuts.push(cut);
      else if ((Number(cut.confidence) || 0) > (Number(prev.confidence) || 0)) cuts[cuts.length - 1] = cut;
    }

    const uncertainCount = cuts.filter((cut) => !!cut?.uncertain).length;
    try { onProgress && onProgress(1, { cuts: cuts.length }); } catch {}

    return {
      cuts,
      stats: {
        segments: Math.max(1, cuts.length + 1),
        uncertain: uncertainCount,
        tinyMerged: 0,
        sampledFrames,
        threshold: sensitivity / 100,
      },
      meta: {
        mode: 'shot',
        preset: 'standard',
        fps,
        sensitivity,
        stepSec: sampleInterval,
      },
    };
  } finally {
    cleanup();
  }
}
