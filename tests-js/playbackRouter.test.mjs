// Playback engine routing (C1). Run: node tests-js/playbackRouter.test.mjs
// selectPlaybackEngine reads window.pfxPlatform at call-time → polyfill window.
//
// Note on coverage history: everything above the `selectEngine` block below
// tested `selectPlaybackEngine`, which has NO production caller. The function
// the app actually runs is the async `selectEngine`, and it was untested — which
// is how ENGINE.NATIVE_ENGINE came to be returned to a consumer that did not
// handle it. Tests on the unused twin of a live function are not coverage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.window = { pfxPlatform: {} };
const {
  isProResCodec, proResDisplayName, selectPlaybackEngine,
  selectEngine, ENGINE, PLAYBACK_PATH, pathForEngine,
} = await import('../src/scripts/core/playbackRouter.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }
const setPlatform = (p) => { window.pfxPlatform = p; };

// ── isProResCodec ──
ok(isProResCodec('apcn'), 'apcn is ProRes');
ok(isProResCodec('prores'), 'prores is ProRes');
ok(isProResCodec('APCH'), 'APCH (uppercase) is ProRes');
ok(!isProResCodec('h264'), 'h264 is not ProRes');
ok(!isProResCodec(''), 'empty is not ProRes');
ok(!isProResCodec(null), 'null is not ProRes');

// ── proResDisplayName ──
eq(proResDisplayName('apch'), 'Apple ProRes 422 HQ', 'apch label');
eq(proResDisplayName('apcn'), 'Apple ProRes 422', 'apcn label');
eq(proResDisplayName('ap4x'), 'Apple ProRes 4444 XQ', 'ap4x label');
eq(proResDisplayName('xyz'), 'Apple ProRes', 'unknown → generic ProRes');

// ── selectPlaybackEngine: non-ProRes always → chromium ──
setPlatform({ isMacApp: true, nativeEngine: true });
eq(selectPlaybackEngine({ codec_name: 'h264' }), 'chromium-video', 'h264 → chromium-video');
eq(selectPlaybackEngine({ codec_name: 'hevc' }), 'chromium-video', 'hevc → chromium-video');

// ── ProRes detection via codec_name / tag / fourcc ──
setPlatform({ isMacApp: true, nativeEngine: true });
eq(selectPlaybackEngine({ codec_name: 'prores' }), 'native-engine', 'prores codec_name → native-engine');
eq(selectPlaybackEngine({ codec_name: 'foo', codec_tag_string: 'apch' }), 'native-engine', 'prores via codec_tag_string');
eq(selectPlaybackEngine({ codec_name: 'apcn' }), 'native-engine', 'prores via PRORES_CODECS codec_name');

// ── ProRes engine preference ladder (macOS) ──
setPlatform({ isMacApp: true, nativeEngine: true, media: { getStill: () => {} } });
eq(selectPlaybackEngine({ codec_name: 'prores' }), 'native-engine', 'nativeEngine wins');
setPlatform({ isMacApp: true, media: { getStill: () => {} } });
eq(selectPlaybackEngine({ codec_name: 'prores' }), 'native-avfoundation', 'avfoundation when no nativeEngine');
setPlatform({ isMacApp: true });
eq(selectPlaybackEngine({ codec_name: 'prores' }), 'mpv', 'mpv when neither engine present');

// ── ProRes off macOS → proxy ──
setPlatform({ isMacApp: false });
eq(selectPlaybackEngine({ codec_name: 'prores' }), 'proxy', 'ProRes off-macOS → proxy');
setPlatform({});
eq(selectPlaybackEngine({ codec_name: 'prores' }), 'proxy', 'ProRes no platform → proxy');

// ── pathForEngine: every ENGINE value must map to a real path ──
// The regression this locks: ENGINE.NATIVE_ENGINE had no route, so it fell
// through a consumer's `else` into the Chromium player. Adding an ENGINE
// constant without a route now fails here instead of shipping silently.
for (const [key, value] of Object.entries(ENGINE)) {
  ok(pathForEngine(value) !== null, `ENGINE.${key} ("${value}") has a playback path`);
}
eq(pathForEngine(ENGINE.NATIVE_ENGINE), PLAYBACK_PATH.CANVAS_NATIVE, 'PFXNativeEngine → canvas-native');
eq(pathForEngine(ENGINE.NATIVE_AV),     PLAYBACK_PATH.CANVAS_NATIVE, 'NativeAVPlayerEngine → canvas-native');
eq(pathForEngine(ENGINE.MPV),           PLAYBACK_PATH.MPV,           'MPVPlayerEngine → mpv');
eq(pathForEngine(ENGINE.CHROMIUM_VIDEO), PLAYBACK_PATH.CHROMIUM,     'ChromiumVideo → chromium');
eq(pathForEngine('SomeFutureEngine'), null, 'unknown engine → null (loud), not chromium');
eq(pathForEngine(undefined), null, 'undefined engine → null');

// ── selectEngine (the function production actually calls) ──
// Shape the platform the way preload really does: `nativeEngine` is an
// unconditional object whose isReady getter returns true.
const proresProbe = {
  media: {
    ffprobeInfo: async () => ({ ok: true, codec_name: 'prores', codec_tag_string: 'apch', container: 'mov', fps: 24 }),
    getInfo:     async () => ({ ok: true, codec: 'apch', fps: 24 }),
    getStill:    () => {},
  },
};
setPlatform({ isMacApp: true, nativeEngine: { isReady: true }, ...proresProbe });
{
  const r = await selectEngine('/Volumes/X/shot_010.mov');
  eq(r.engine, ENGINE.NATIVE_ENGINE, 'ProRes on desktop → PFXNativeEngine');
  eq(r.htmlVideoBlocked, true, 'ProRes reports htmlVideoBlocked');
  // The defect in one line: the router blocks Chromium, so the path it resolves
  // to must not be Chromium.
  eq(pathForEngine(r.engine), PLAYBACK_PATH.CANVAS_NATIVE,
     'ProRes selection routes to the canvas engine, not the blocked Chromium player');
}

// isReady:false must make the lower rungs reachable again.
setPlatform({ isMacApp: true, nativeEngine: { isReady: false }, ...proresProbe });
eq((await selectEngine('/x.mov')).engine, ENGINE.NATIVE_AV, 'nativeEngine not ready → avf_bridge');
setPlatform({ isMacApp: true, nativeEngine: { isReady: false },
              media: { ffprobeInfo: proresProbe.media.ffprobeInfo, getInfo: proresProbe.media.getInfo } });
eq((await selectEngine('/x.mov')).engine, ENGINE.MPV, 'nativeEngine not ready + no getStill → mpv');

// Non-ProRes and off-desktop stay on the Chromium path.
setPlatform({ isMacApp: true, nativeEngine: { isReady: true },
              media: { ffprobeInfo: async () => ({ ok: true, codec_name: 'h264', codec_tag_string: 'avc1', container: 'mov' }),
                       getInfo: async () => ({ ok: true, codec: 'avc1' }) } });
{
  const r = await selectEngine('/x.mov');
  eq(r.engine, ENGINE.CHROMIUM_VIDEO, 'h264 → ChromiumVideo');
  eq(r.htmlVideoBlocked, false, 'h264 does not block html video');
}
setPlatform({ isMacApp: false });
eq((await selectEngine('/x.mov')).engine, ENGINE.CHROMIUM_VIDEO, 'off-desktop → ChromiumVideo');
eq((await selectEngine(null)).engine, ENGINE.CHROMIUM_VIDEO, 'no path → ChromiumVideo');

// ── the consumer must dispatch through the map, not a hand-rolled === chain ──
// A === chain is what silently dropped PFXNativeEngine; pathForEngine is only a
// fix while playableMedia actually uses it.
{
  const src = fs.readFileSync(path.join(root, 'src/scripts/core/playableMedia.js'), 'utf8');
  ok(/pathForEngine\s*\(\s*engine\s*\)/.test(src), 'playableMedia dispatches via pathForEngine(engine)');
  ok(!/engine\s*===\s*ENGINE\./.test(src), 'playableMedia has no hand-written engine === ENGINE.* branch');
  ok(/PLAYBACK_PATH\.CANVAS_NATIVE[\s\S]{0,200}_startNativeAVPath/.test(src),
     'canvas-native path starts the NativeAVPlayerEngine');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
