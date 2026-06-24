/**
 * byteRecover.js — PostFlowX NanoTrack occlusion recovery via YOLO + IoU matching
 *
 * When NanoTrack loses the target (score < threshold), this module:
 *   1. Runs YOLOv10-nano detection on the current frame
 *   2. Finds the detection with highest IoU overlap with the last known position
 *   3. Optionally filters by the semantic class of the target (face, person, etc.)
 *
 * Model: Xenova/yolos-tiny via Transformers.js (~9.7 MB, cached after first use)
 * License: Apache-2.0 (yolos-tiny), Apache-2.0 (Transformers.js)
 */

const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js';

let _detector = null;
let _tf = null;

async function _loadDetector(onProgress) {
  if (_detector) return _detector;
  _tf = _tf || await import(TRANSFORMERS_CDN);
  _tf.env.useBrowserCache(true);
  _detector = await _tf.pipeline('object-detection', 'Xenova/yolos-tiny', {
    dtype: 'q8',
    progress_callback: (d) => {
      if (onProgress && d.status === 'progress') onProgress(Math.round(d.progress ?? 0));
    },
  });
  return _detector;
}

function _iou(a, b) {
  const ix1 = Math.max(a.x1, b.x1), iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2), iy2 = Math.min(a.y2, b.y2);
  if (ix2 <= ix1 || iy2 <= iy1) return 0;
  const inter = (ix2-ix1)*(iy2-iy1);
  const areaA = (a.x2-a.x1)*(a.y2-a.y1), areaB = (b.x2-b.x1)*(b.y2-b.y1);
  return inter / (areaA + areaB - inter);
}

// ── VFX semantic class groups ─────────────────────────────────────────────────
// Maps tracked object type → COCO labels to accept for recovery
const SEMANTIC_GROUPS = {
  face:    ['person'],
  person:  ['person'],
  car:     ['car', 'truck', 'bus', 'motorcycle', 'bicycle'],
  vehicle: ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'airplane', 'boat'],
  screen:  ['tv', 'laptop', 'cell phone', 'monitor'],
  animal:  ['cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'bird'],
};

/**
 * Try to recover a lost track using YOLO detection.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas   current frame
 * @param {{x1,y1,x2,y2}}  lastKnownBox  last position before target was lost
 * @param {string}          [targetClass] semantic hint ('face','person','car',…)
 * @param {function}        [onProgress]  (pct)=>void
 * @returns {{x1,y1,x2,y2,score,label}|null}
 */
export async function recoverTrack(canvas, lastKnownBox, targetClass, onProgress) {
  const det = await _loadDetector(onProgress);
  const W = canvas.width, H = canvas.height;
  const blob = await (canvas instanceof OffscreenCanvas
    ? canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 })
    : new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.88)));
  const url = URL.createObjectURL(blob);
  let results;
  try {
    results = await det(url, { threshold: 0.35 });
  } finally {
    URL.revokeObjectURL(url);
  }

  if (!results?.length) return null;

  const allowed = targetClass ? (SEMANTIC_GROUPS[targetClass.toLowerCase()] || null) : null;
  let best = null, bestScore = -1;

  for (const r of results) {
    if (allowed && !allowed.includes(r.label.toLowerCase())) continue;
    const box = {
      x1: r.box.xmin,  y1: r.box.ymin,
      x2: r.box.xmax,  y2: r.box.ymax,
    };
    const iou  = _iou(lastKnownBox, box);
    const score = r.score * 0.6 + iou * 0.4;   // weighted by confidence + spatial proximity
    if (score > bestScore) { bestScore = score; best = { ...box, score: r.score, iou, label: r.label }; }
  }

  // Only accept if IoU with last position is reasonable (>0.05) or very confident
  if (!best || (best.iou < 0.05 && best.score < 0.75)) return null;
  return best;
}

/** Free the detection model from memory. */
export function disposeDetector() {
  try { _detector?.dispose?.(); } catch {}
  _detector = null;
}
