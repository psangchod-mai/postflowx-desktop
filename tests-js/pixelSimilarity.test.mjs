import test from 'node:test';
import assert from 'node:assert/strict';
import { robustPixelSimilarity, pixelSimilarityStatus } from '../src/scripts/modules/conform/pixelSimilarity.js';

function image(width, height, fn) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4;
    const [r, g, b] = fn(x, y);
    out[p] = r; out[p + 1] = g; out[p + 2] = b; out[p + 3] = 255;
  }
  return out;
}

const W = 64, H = 36;

test('continuous picture score is exact for identical frames', () => {
  const a = image(W, H, (x, y) => [(x * 7 + y * 3) % 256, (x * 2) % 256, (y * 9) % 256]);
  assert.equal(robustPixelSimilarity(a, a, W, H), 100);
  assert.equal(pixelSimilarityStatus(100), 'OK');
});

test('continuous picture score rejects a different composition', () => {
  const a = image(W, H, (x, y) => [x < W / 2 ? 240 : 20, y * 5, 30]);
  const b = image(W, H, (x, y) => [y < H / 2 ? 20 : 240, 30, x * 3]);
  const score = robustPixelSimilarity(a, b, W, H);
  assert.ok(score < 72, `different shots scored ${score}`);
  assert.equal(pixelSimilarityStatus(score), 'NO_MATCH');
});

test('continuous picture score tolerates a localized burn-in', () => {
  const a = image(W, H, (x, y) => [(x * 5 + y * 2) % 256, (x + y) * 3 % 256, y * 6]);
  const b = new Uint8ClampedArray(a);
  for (let y = H - 8; y < H; y++) for (let x = 0; x < 20; x++) {
    const p = (y * W + x) * 4;
    b[p] = 255; b[p + 1] = 255; b[p + 2] = 255;
  }
  assert.ok(robustPixelSimilarity(a, b, W, H) >= 88);
});
