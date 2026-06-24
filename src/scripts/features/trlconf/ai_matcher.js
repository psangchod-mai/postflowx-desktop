// scripts/features/trlconf/ai_matcher.js
// MobileNetV3 Small (1024-dim embeddings) for cross-grade frame matching.
// Replaces the mean-hash / Hamming approach with CNN feature vectors +
// cosine similarity — robust to colour grading, subtitle overlays, rescaling.
//
// Usage:
//   import { loadModel, extractEmbedding, searchMasterAI, AI_W, AI_H } from './ai_matcher.js';
//   await loadModel(progressCallback);          // one-time; TF.js caches in IndexedDB
//   const emb = await extractEmbedding(videoEl, canvas);
//   const { bestSec, confidence } = await searchMasterAI(emb, masterVideo, canvas, fps, approxSec);

// ── Constants ─────────────────────────────────────────────────────────────────

export const AI_W = 224;
export const AI_H = 224;

// TFHub SavedModel (graph model) — feature_vector head, no classification.
// Returns [1, 1024] float32.
const _MODEL_URL =
  'https://tfhub.dev/google/tfjs-model/imagenet/mobilenet_v3_small_100_224/feature_vector/5/default/1/model.json';

// ── Module state ──────────────────────────────────────────────────────────────

let _model       = null;
let _loadPromise = null;

// ── Internal helpers ──────────────────────────────────────────────────────────

// TF.js is loaded as a static <script defer> in index.html.
// Wait up to 30 s for window.tf.loadGraphModel to become available.
async function _ensureTfJs() {
  if (typeof tf !== 'undefined' && typeof tf.loadGraphModel === 'function') return;

  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    (function poll() {
      if (typeof tf !== 'undefined' && typeof tf.loadGraphModel === 'function') {
        resolve();
      } else if (Date.now() > deadline) {
        reject(new Error('TF.js did not become available within 30 s — check assets/ai/tf.min.js'));
      } else {
        setTimeout(poll, 120);
      }
    })();
  });
}

async function _seekVideo(video, timeSec) {
  return new Promise((resolve, reject) => {
    const t = Math.max(0, Math.min(timeSec, (video.duration || 0) - 0.001));
    if (Math.abs(video.currentTime - t) < 0.001) { resolve(); return; }
    let timer;
    const onSeeked = () => { clearTimeout(timer); video.removeEventListener('seeked', onSeeked); resolve(); };
    timer = setTimeout(() => { video.removeEventListener('seeked', onSeeked); reject(new Error(`Seek timeout @ ${t.toFixed(2)}s`)); }, 7000);
    video.addEventListener('seeked', onSeeked);
    video.currentTime = t;
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load TF.js + MobileNetV3 Small.
 * First call downloads ~2.5 MB from TFHub; TF.js auto-caches in IndexedDB
 * so subsequent calls return instantly from cache.
 *
 * @param {function(string): void} [onProgress]  Optional status callback.
 */
export async function loadModel(onProgress) {
  if (_model) return _model;
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    onProgress?.('Loading TF.js runtime…');
    await _ensureTfJs();

    onProgress?.('Loading MobileNetV3 model (first run ~2.5 MB, then cached)…');
    const model = await tf.loadGraphModel(_MODEL_URL);

    // Warm-up: one forward pass primes WebGL shaders so the first real call is fast.
    // tf.tidy doesn't work with async, so dispose manually.
    onProgress?.('Warming up GPU…');
    const dummy = tf.zeros([1, AI_H, AI_W, 3]);
    try {
      const warmOut = model.predict(dummy);
      const warmTensor = (warmOut instanceof Promise) ? await warmOut : warmOut;
      warmTensor.dispose();
    } finally {
      dummy.dispose();
    }

    _model = model;
    onProgress?.('AI model ready');
    return _model;
  })().catch(err => {
    _loadPromise = null; // allow retry
    throw err;
  });

  return _loadPromise;
}

/**
 * Extract a 1024-dim feature embedding from the current video frame.
 * Seeks are done externally; call this immediately after the seek resolves.
 *
 * @param {HTMLVideoElement} videoEl
 * @param {HTMLCanvasElement} canvas   Must be AI_W × AI_H (224 × 224).
 * @returns {Promise<Float32Array>}    1024-dimensional feature vector.
 */
export async function extractEmbedding(videoEl, canvas) {
  if (!_model) throw new Error('AI model not loaded — call loadModel() first');

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(videoEl, 0, 0, AI_W, AI_H);

  // Build input tensor synchronously inside tf.tidy for automatic intermediate cleanup
  const batched = tf.tidy(() => {
    const pixels = tf.browser.fromPixels(canvas);           // [224, 224, 3] uint8
    const norm   = pixels.toFloat().div(tf.scalar(255.0)); // [224, 224, 3] 0–1
    return norm.expandDims(0);                              // [1, 224, 224, 3]
  });

  // predict() returns a Tensor in TF.js 3.x sync mode or a Promise in some 4.x builds
  try {
    const rawOut    = _model.predict(batched);
    const outTensor = (rawOut instanceof Promise) ? await rawOut : rawOut;
    const data      = await outTensor.data();               // Float32Array(1024)
    outTensor.dispose();
    return new Float32Array(data);
  } finally {
    batched.dispose();
  }
}

/**
 * Cosine similarity between two embedding vectors. Returns 0–1.
 * Values ≥ 0.95 indicate a strong match; < 0.85 is a poor match.
 */
export function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Map cosine similarity to a 0–100 confidence score.
 * The scaling is calibrated for same-source video:
 *   ≥ 0.97 cosine → 100%
 *   ≤ 0.80 cosine →   0%
 */
export function simToConfidence(sim) {
  return Math.round(Math.max(0, Math.min(100, ((sim - 0.80) / 0.17) * 100)));
}

/**
 * Coarse+fine AI frame search — same interface as the hash-based
 * _searchMasterForFrame in index.js so the call sites are drop-in replaceable.
 *
 * Coarse pass: ±30 s, 2 s step.
 * Fine pass:   ±1.5 s, 1-frame step.
 *
 * @param {Float32Array} refEmb       Embedding of the reference frame.
 * @param {HTMLVideoElement} masterVideo
 * @param {HTMLCanvasElement} canvas  224 × 224
 * @param {number} fps
 * @param {number} approxSec          Proxy srcIn as a coarse hint.
 * @returns {Promise<{bestSec: number, distance: number, confidence: number}>}
 */
export async function searchMasterAI(refEmb, masterVideo, canvas, fps, approxSec) {
  const duration    = masterVideo.duration || 0;
  const COARSE_STEP = 2;
  const COARSE_WIN  = 30;
  const FINE_STEP   = 1 / fps;
  const FINE_WIN    = 1.5;

  let bestSec = Math.max(0, Math.min(approxSec, duration));
  let bestSim = -1;

  const _getEmb = async (t) => {
    await _seekVideo(masterVideo, t);
    return extractEmbedding(masterVideo, canvas);
  };

  // ── Coarse pass ─────────────────────────────────────────────────────────
  const cStart = Math.max(0, approxSec - COARSE_WIN);
  const cEnd   = Math.min(duration - 0.1, approxSec + COARSE_WIN);

  for (let t = cStart; t <= cEnd + 0.001; t += COARSE_STEP) {
    try {
      const sim = cosineSimilarity(refEmb, await _getEmb(t));
      if (sim > bestSim) { bestSim = sim; bestSec = t; }
      if (bestSim >= 0.99) break; // near-perfect match, stop early
    } catch { /* skip bad seek */ }
  }

  // ── Fine pass ────────────────────────────────────────────────────────────
  const fStart = Math.max(0, bestSec - FINE_WIN);
  const fEnd   = Math.min(duration - 0.1, bestSec + FINE_WIN);

  for (let t = fStart; t <= fEnd + FINE_STEP * 0.1; t += FINE_STEP) {
    try {
      const sim = cosineSimilarity(refEmb, await _getEmb(t));
      if (sim > bestSim) { bestSim = sim; bestSec = t; }
      if (bestSim >= 0.99) break;
    } catch { /* skip */ }
  }

  return {
    bestSec,
    distance:   Math.min(1, Math.max(0, 1 - bestSim)), // clamp [0,1]; bestSim=-1 when all seeks fail
    confidence: simToConfidence(bestSim),
  };
}

/** Returns true once the model is loaded and ready. */
export function isReady() {
  return _model !== null;
}
