import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const trailer = readFileSync(join(ROOT, 'src/scripts/features/trlconf/index.js'), 'utf8');
const player = readFileSync(join(ROOT, 'src/scripts/core/nativeAVPlayer.js'), 'utf8');
const pullsPrep = readFileSync(join(ROOT, 'src/scripts/prep_mark.js'), 'utf8');
const companion = readFileSync(join(ROOT, 'electron/companion.js'), 'utf8');

test('Trailer Conform reads native Apple ProRes frames directly with AVFoundation', () => {
  assert.match(trailer, /neOpen\(nativePath, 30_000\)/);
  assert.match(trailer, /neFrameExtract\(session\.sessionId, frame, outputWidth, 0\.96/);
  assert.match(trailer, /_loadNativeFrameSource\(file, nativePath/);
  assert.match(trailer, /const _nativeMediaSessions = new Map\(\)/);
  assert.match(trailer, /Each _loadVideo call/);
  assert.doesNotMatch(trailer, /_nativeFrameSources/);
  assert.match(trailer, /avfoundation-prores-v1/);
  assert.match(trailer, /Direct Apple ProRes · AVFoundation/);
  assert.match(trailer, /const raw = match\[2\] \? atob\(match\[3\]\)/);
  assert.doesNotMatch(trailer, /fetch\(dataUrl\)/);
  assert.doesNotMatch(trailer, /nativeBuildMediaProxy/);
});

test('native player does not auto-create proxies for ProRes sessions', () => {
  assert.match(player, /const session = await ne\.open\(filePath\)/);
  assert.match(player, /HW Decode \(AVFoundation\)/);
  assert.doesNotMatch(player, /ne\.proxyCreate/);
  assert.doesNotMatch(player, /session\.needsProxy/);
});

test('desktop QuickTime playback prefers the proven direct AVFoundation bridge and ignores cached proxies', () => {
  const playable = readFileSync(join(ROOT, 'src/scripts/core/playableMedia.js'), 'utf8');
  assert.match(playable, /preferBridge:\s*true/);
  assert.match(playable, /const allowCachedProxy = !\(nativePath && \/\\\.mov\$\/i\.test/);
  assert.match(player, /if \(this\._opts\.preferBridge && window\.pfxPlatform\?\.media\?\.getInfo\)/);
  assert.match(player, /return await this\._openBridge\(filePath\)/);
});

test('Pulls Prep sends QuickTime references to direct AVFoundation playback before companion proxy routing', () => {
  const desktopPicker = pullsPrep.indexOf('window.pfxPlatform?.isMacApp && window.pfxPlatform?.pickFile');
  const pickedNativePath = pullsPrep.indexOf("await _pmLoadVideo({ name: fname, type: /\\.mov$/i.test(filePath) ? 'video/quicktime'", desktopPicker);
  const directGate = pullsPrep.indexOf("if (/\\.mov$/i.test(filePath) && window.pfxPlatform?.media?.getStill)");
  const directOpen = pullsPrep.indexOf("await _pmLoadVideo({ name: fname, type: 'video/quicktime', _nativePath: filePath }, null)", directGate);
  const companionOpen = pullsPrep.indexOf('const openResp = await sharedMediaOpen(filePath)', directGate);
  assert.ok(desktopPicker >= 0, 'desktop-native picker is present');
  assert.ok(pickedNativePath > desktopPicker, 'desktop picker passes its native path to the unified player');
  assert.ok(directGate >= 0, 'QuickTime direct-play gate is present');
  assert.ok(directOpen > directGate, 'direct-play gate passes the native path to the unified player');
  assert.ok(companionOpen > directOpen, 'direct AVFoundation routing runs before companion/proxy routing');
});

test('Pulls Prep Annotate pauses and freshly decodes the active AVFoundation frame', () => {
  assert.match(pullsPrep, /const _nativeCanvas = pmVideo\?\._pfxNativeCanvas/);
  assert.match(pullsPrep, /_nativeEngine\.pause\(\)/);
  assert.match(pullsPrep, /_nativeEngine\.captureCurrentFrameDataUrl\?\.\(8000\)/);
  assert.match(pullsPrep, /_nativeCanvas\.toDataURL\('image\/jpeg', 0\.92\)/);
  assert.match(pullsPrep, /srcVideoCurrentFrame = Math\.max\(0, Number\(_nativeEngine\.currentFrame\)/);
  assert.match(player, /async captureCurrentFrameDataUrl\(timeoutMs = 8000\)/);
});

test('packaged companion does not mutate the signed app with Python bytecode caches', () => {
  assert.match(companion, /PYTHONDONTWRITEBYTECODE:\s*'1'/);
});
