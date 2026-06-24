/**
 * smartAnnoAI.js — PostFlowX Annotate AI engine
 *
 * Lazy-loads ML models on first use (cached in IndexedDB after first download).
 * All inference runs in the browser — no server required.
 *
 * Models used:
 *   Object detection : Xenova/yolos-tiny          (~9.7 MB q8)
 *   SAM segmentation : Xenova/slimsam-50-uniform  (~35  MB q8) — click to mask
 *   Depth estimation : onnx-community/depth-anything-v2-small (19 MB q4f16)
 *   Face detection   : @mediapipe/tasks-vision BlazeFace (~0.2 MB)
 */

const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js';
const MEDIAPIPE_CDN    = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs';
const MEDIAPIPE_WASM   = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm/';
const MEDIAPIPE_FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

// ── Model cache (loaded once per session) ─────────────────────────────────────
let _tf = null;          // Transformers.js module
let _objDetector = null;
let _samModel = null;
let _samProcessor = null;
let _depthEstimator = null;
let _faceDetector = null;
let _mpVision = null;

// ── Load Transformers.js from CDN ─────────────────────────────────────────────
async function _loadTransformers() {
  if (_tf) return _tf;
  _tf = await import(TRANSFORMERS_CDN);
  // Use local cache (IndexedDB) — avoids re-downloading on every session
  _tf.env.useBrowserCache(true);
  _tf.env.allowRemoteModels(true);
  return _tf;
}

// ── Load MediaPipe Vision ─────────────────────────────────────────────────────
async function _loadMediaPipe() {
  if (_mpVision) return _mpVision;
  const { FilesetResolver } = await import(MEDIAPIPE_CDN);
  _mpVision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
  return _mpVision;
}

// ── Progress helper ───────────────────────────────────────────────────────────
function _progressCb(onProgress) {
  return (data) => {
    if (!onProgress) return;
    if (data.status === 'progress') onProgress(Math.round(data.progress ?? 0), data.file || '');
    else if (data.status === 'done') onProgress(100, data.file || '');
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect objects in an image — returns array of {label, score, box:{x1,y1,x2,y2}}.
 * box coords are normalized 0-1 relative to image dimensions.
 *
 * @param {HTMLImageElement|HTMLVideoElement|HTMLCanvasElement} imageEl
 * @param {function} [onProgress]  (pct:number, file:string)=>void
 * @param {number}   [threshold]   confidence threshold 0-1 (default 0.45)
 */
export async function detectObjects(imageEl, onProgress, threshold = 0.45) {
  const tf = await _loadTransformers();
  if (!_objDetector) {
    _objDetector = await tf.pipeline('object-detection', 'Xenova/yolos-tiny', {
      progress_callback: _progressCb(onProgress),
      dtype: 'q8',
    });
  }
  const w = imageEl.videoWidth || imageEl.naturalWidth || imageEl.width || 1;
  const h = imageEl.videoHeight || imageEl.naturalHeight || imageEl.height || 1;
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(imageEl, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  const url  = URL.createObjectURL(blob);
  try {
    const results = await _objDetector(url, { threshold });
    return results.map(r => ({
      label: r.label,
      score: r.score,
      box: {
        x1: r.box.xmin / w,
        y1: r.box.ymin / h,
        x2: r.box.xmax / w,
        y2: r.box.ymax / h,
      },
    }));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * SAM click-to-segment.
 * Given a click point (normalized 0-1), returns a tight bounding box {x1,y1,x2,y2}
 * (normalized 0-1) around the clicked object.
 *
 * @param {HTMLImageElement|HTMLVideoElement|HTMLCanvasElement} imageEl
 * @param {number} nx  normalized click X (0-1)
 * @param {number} ny  normalized click Y (0-1)
 * @param {function} [onProgress]
 */
export async function samClickSegment(imageEl, nx, ny, onProgress) {
  const tf = await _loadTransformers();
  if (!_samModel || !_samProcessor) {
    const MODEL = 'Xenova/slimsam-50-uniform';
    const cb = _progressCb(onProgress);
    [_samModel, _samProcessor] = await Promise.all([
      tf.SamModel.from_pretrained(MODEL, { dtype: 'q8', progress_callback: cb }),
      tf.AutoProcessor.from_pretrained(MODEL, { progress_callback: cb }),
    ]);
  }
  const w = imageEl.videoWidth || imageEl.naturalWidth || imageEl.width || 1;
  const h = imageEl.videoHeight || imageEl.naturalHeight || imageEl.height || 1;
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(imageEl, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
  const url  = URL.createObjectURL(blob);
  try {
    const rawImage = await tf.RawImage.fromURL(url);
    const clickPx = [[nx * w, ny * h]];
    const inputs  = await _samProcessor(rawImage, { input_points: [clickPx] });
    const outputs = await _samModel(inputs);
    const masks   = await _samProcessor.post_process_masks(
      outputs.pred_masks,
      inputs.original_sizes,
      inputs.reshaped_input_sizes,
    );
    // masks[0] is a boolean tensor (H × W). Find tight bbox from the best mask.
    const maskData = masks[0][0]; // Tensor2D
    const arr = await maskData.data;
    const mW = maskData.dims[1], mH = maskData.dims[0];
    let minX = mW, minY = mH, maxX = 0, maxY = 0, found = false;
    for (let y = 0; y < mH; y++) {
      for (let x = 0; x < mW; x++) {
        if (arr[y * mW + x]) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          found = true;
        }
      }
    }
    if (!found) return null;
    const PAD = 0.005; // 0.5% padding
    return {
      x1: Math.max(0, minX / mW - PAD),
      y1: Math.max(0, minY / mH - PAD),
      x2: Math.min(1, maxX / mW + PAD),
      y2: Math.min(1, maxY / mH + PAD),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Depth estimation — returns a grayscale ImageData (same dims as canvas).
 * Bright = near, dark = far.
 *
 * @param {HTMLImageElement|HTMLVideoElement|HTMLCanvasElement} imageEl
 * @param {function} [onProgress]
 */
export async function estimateDepth(imageEl, onProgress) {
  const tf = await _loadTransformers();
  if (!_depthEstimator) {
    _depthEstimator = await tf.pipeline('depth-estimation', 'onnx-community/depth-anything-v2-small', {
      progress_callback: _progressCb(onProgress),
      dtype: 'q4f16',
    });
  }
  const w = imageEl.videoWidth || imageEl.naturalWidth || imageEl.width || 1;
  const h = imageEl.videoHeight || imageEl.naturalHeight || imageEl.height || 1;
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(imageEl, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  const url  = URL.createObjectURL(blob);
  try {
    const { depth } = await _depthEstimator(url);
    // depth is a RawImage (grayscale). Convert to ImageData for canvas overlay.
    const depthW = depth.width, depthH = depth.height;
    const pixels = new Uint8ClampedArray(depthW * depthH * 4);
    const src    = depth.data; // Float32Array or Uint8Array
    // Normalize to 0-255
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < src.length; i++) { if (src[i] < lo) lo = src[i]; if (src[i] > hi) hi = src[i]; }
    const range = hi - lo || 1;
    for (let i = 0; i < src.length; i++) {
      const v = Math.round(((src[i] - lo) / range) * 255);
      pixels[i*4]   = v;
      pixels[i*4+1] = v;
      pixels[i*4+2] = v;
      pixels[i*4+3] = 180; // semi-transparent overlay
    }
    return new ImageData(pixels, depthW, depthH);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Detect faces — returns array of {x1,y1,x2,y2} in normalized 0-1 coords.
 *
 * @param {HTMLImageElement|HTMLVideoElement|HTMLCanvasElement} imageEl
 * @param {function} [onProgress]
 */
export async function detectFacesML(imageEl, onProgress) {
  const vision = await _loadMediaPipe();
  if (!_faceDetector) {
    if (onProgress) onProgress(10, 'Loading BlazeFace…');
    const { FaceDetector } = await import(MEDIAPIPE_CDN);
    _faceDetector = await FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MEDIAPIPE_FACE_MODEL, delegate: 'GPU' },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.5,
    });
    if (onProgress) onProgress(100, 'BlazeFace ready');
  }
  const w = imageEl.videoWidth || imageEl.naturalWidth || imageEl.width || 1;
  const h = imageEl.videoHeight || imageEl.naturalHeight || imageEl.height || 1;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(imageEl, 0, 0);
  const result = _faceDetector.detect(canvas);
  return (result.detections || []).map(d => ({
    x1: d.boundingBox.originX / w,
    y1: d.boundingBox.originY / h,
    x2: (d.boundingBox.originX + d.boundingBox.width)  / w,
    y2: (d.boundingBox.originY + d.boundingBox.height) / h,
    score: d.categories?.[0]?.score ?? 1,
    keypoints: (d.keypoints || []).map(k => ({ x: k.x, y: k.y, label: k.label })),
  }));
}

/** Free all loaded models to reclaim memory. */
export function disposeAll() {
  try { _samModel?.dispose?.(); } catch {}
  try { _samProcessor?.dispose?.(); } catch {}
  try { _objDetector?.dispose?.(); } catch {}
  try { _depthEstimator?.dispose?.(); } catch {}
  try { _faceDetector?.close?.(); } catch {}
  _tf = _objDetector = _samModel = _samProcessor = _depthEstimator = _faceDetector = _mpVision = null;
}
