// fp_worker.js — off-main-thread fingerprint computation for trlconf.
// Handles: mean hash (mHash), Sobel edge hash (eHash), average luma.
// dHash is intentionally kept on the main thread (separate 9×8 canvas).
//
// Protocol:
//   IN  { type: 'compute', id: <any>, pixels: Uint8ClampedArray, w: number, h: number }
//   OUT { id: <any>, mHash: Uint8Array, eHash: Uint8Array, luma: number }
//   OUT { id: <any>, error: string }   — on failure

'use strict';

const W = 32, H = 18, N = W * H; // 576 pixels

function computeMHash(pixels) {
  const gray = new Float32Array(N);
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const p = i * 4;
    gray[i] = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
    sum += gray[i];
  }
  const mean = sum / N;
  const bits = new Uint8Array(N);
  for (let i = 0; i < N; i++) bits[i] = gray[i] >= mean ? 1 : 0;
  return bits;
}

function computeLuma(pixels) {
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const p = i * 4;
    sum += 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
  }
  return (sum / (N * 255)) * 100;
}

function computeEdgeHash(pixels) {
  const gray = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const p = i * 4;
    gray[i] = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
  }

  const mag = new Float32Array(N);
  let sumMag = 0, edgeCount = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const tl = gray[(y - 1) * W + (x - 1)], tc = gray[(y - 1) * W + x], tr = gray[(y - 1) * W + (x + 1)];
      const ml = gray[y       * W + (x - 1)],                              mr = gray[y       * W + (x + 1)];
      const bl = gray[(y + 1) * W + (x - 1)], bc = gray[(y + 1) * W + x], br = gray[(y + 1) * W + (x + 1)];
      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      const m  = Math.sqrt(gx * gx + gy * gy);
      mag[y * W + x] = m;
      sumMag += m;
      edgeCount++;
    }
  }

  const threshold = edgeCount > 0 ? sumMag / edgeCount : 1;
  const bits = new Uint8Array(N);
  for (let i = 0; i < N; i++) bits[i] = mag[i] >= threshold ? 1 : 0;
  return bits;
}

self.onmessage = (e) => {
  const { type, id, pixels, w, h } = e.data;
  if (type !== 'compute') return;
  try {
    if (!pixels || pixels.length < N * 4) {
      self.postMessage({ id, error: `pixels too short: ${pixels?.length}` });
      return;
    }
    const mHash = computeMHash(pixels);
    const eHash = computeEdgeHash(pixels);
    const luma  = computeLuma(pixels);
    // Transfer Uint8Arrays so no copy is made back to main thread.
    self.postMessage({ id, mHash, eHash, luma }, [mHash.buffer, eHash.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
