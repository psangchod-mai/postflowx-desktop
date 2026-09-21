import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const player = readFileSync(join(ROOT, 'src/scripts/core/nativeAVPlayer.js'), 'utf8');
const prep = readFileSync(join(ROOT, 'src/scripts/prep_mark.js'), 'utf8');
const css = readFileSync(join(ROOT, 'src/styles/main.css'), 'utf8');

test('AVFoundation Program Monitor uses a contain rectangle instead of stretching', () => {
  assert.match(player, /const scale = Math\.min\(cw \/ iw, ch \/ ih\)/);
  assert.match(player, /const dx = Math\.round\(\(cw - dw\) \/ 2\)/);
  assert.match(player, /const dy = Math\.round\(\(ch - dh\) \/ 2\)/);
  assert.match(player, /ctx\.drawImage\(img, dx, dy, dw, dh\)/);
});

test('native player exposes non-disruptive explicit-frame capture for thumbnails', () => {
  assert.match(player, /async captureFrameDataUrl\(frame, timeoutMs = 8000\)/);
  assert.match(player, /return await this\._extractFrame\(f\)/);
  assert.match(prep, /directEngine\.captureFrameDataUrl\(frameInVideo, 8500\)/);
  assert.match(prep, /sharedMediaGetFrame\(_pmNativeAssetId, frameInVideo/);
});

test('Electron does not fall through to the unsupported legacy thumbnail action', () => {
  assert.match(prep, /if \(window\.pfxPlatform\?\.media\?\.getStill\) \{[\s\S]*AVFoundation returned no thumbnail image[\s\S]*\}\s*\/\/ Bound the companion seek/);
  assert.match(prep, /Thumbnail unavailable — click to retry/);
});

test('expanded Pull Prep thumbnails reserve a stable widescreen frame', () => {
  assert.match(css, /\.pm-layer-thumb-full \{[^}]*aspect-ratio: 16 \/ 9/);
  assert.match(css, /\.pm-layer-thumb-full-empty \{[^}]*aspect-ratio: 16 \/ 9/);
});
