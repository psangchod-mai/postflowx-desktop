// Decode-route accounting and its HUD summary (C-RT2).
// Run: node tests-js/decodeRoute.test.mjs
//
// Iteration 4 added counters recording which decoder served each frame; nothing
// read them. This covers the summariser that turns them into the operator HUD
// line, and asserts the player actually renders it — a counter no one displays
// is the same blind spot that let the routing bug ship in the first place.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  summarizeDecodeRoute, getDecodeRouteStats, resetDecodeRouteStats,
  WASTED_ATTEMPT_WARN_PCT,
} from '../src/scripts/modules/imf/imf_j2k.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

const stats = (byBackend, extra = {}) => ({
  byBackend,
  total: Object.values(byBackend).reduce((a, b) => a + b, 0),
  directFailures: 0, failed: 0, rejected: 0, last: null,
  ...extra,
});

// ── nothing decoded yet renders nothing, not a zero ──
// A HUD reading "OpenJPH 0%" before the first frame is worse than a blank.
eq(summarizeDecodeRoute(null), null, 'null stats → no summary');
eq(summarizeDecodeRoute(undefined), null, 'undefined stats → no summary');
eq(summarizeDecodeRoute(stats({})), null, 'zero frames → no summary');
eq(summarizeDecodeRoute({ byBackend: { 'direct-openjph': 5 }, total: 0 }), null,
   'total 0 despite a stray counter → no summary');

// ── single backend: name it, no percentage noise ──
{
  const s = summarizeDecodeRoute(stats({ 'direct-openjph': 120 }));
  eq(s.label, 'OpenJPH', 'direct OpenJPH labelled by decoder, not by transport');
  eq(s.text, 'OpenJPH', 'a single backend needs no share figure');
  eq(s.mixed, false, 'one backend is not mixed');
  eq(s.sharePct, 100, 'share is 100%');
  eq(s.degraded, false, 'the HT fast path is not degraded');
}
eq(summarizeDecodeRoute(stats({ 'sandbox:j2k-openjpeg': 48 })).label, 'OpenJPEG',
   'classic Part 1 via the sandbox reads as OpenJPEG');
eq(summarizeDecodeRoute(stats({ 'sandbox:htj2k-openjph': 48 })).label, 'OpenJPH',
   'sandbox HT and direct HT are the same decoder to an operator');

// ── the pure-JS rung is a correctness net, never a playback path ──
{
  const s = summarizeDecodeRoute(stats({ 'sandbox:j2k-fallback': 30 }));
  eq(s.label, 'JS fallback', 'the pure-JS baseline is named plainly');
  eq(s.degraded, true, 'serving frames from the JS fallback is degraded even at full cadence');
}
// Dominance is what colours the HUD: mostly-WASM with a few fallback frames is
// not the same finding as running on the fallback.
eq(summarizeDecodeRoute(stats({ 'sandbox:j2k-openjpeg': 95, 'sandbox:j2k-fallback': 5 })).degraded, false,
   'a handful of fallback frames among healthy ones is not a degraded rung');

// ── mixed backends report the dominant share ──
{
  const s = summarizeDecodeRoute(stats({ 'sandbox:j2k-openjpeg': 75, 'direct-openjph': 25 }));
  eq(s.backend, 'sandbox:j2k-openjpeg', 'dominant backend wins');
  eq(s.mixed, true, 'two backends is mixed');
  eq(s.text, 'OpenJPEG 75%', 'mixed routing shows the share');
}
// Ties must not flicker between frames — first to serve a frame holds the label.
eq(summarizeDecodeRoute(stats({ 'direct-openjph': 10, 'sandbox:j2k-openjpeg': 10 })).backend,
   'direct-openjph', 'a tie resolves to the earliest backend, stably');

// ── thrown-away direct attempts: the iteration-4 defect, made visible ──
eq(WASTED_ATTEMPT_WARN_PCT, 10, 'the wasted-attempt threshold is 10% of decoded frames');
{
  const s = summarizeDecodeRoute(stats({ 'sandbox:j2k-openjpeg': 100 }, { directFailures: 100 }));
  eq(s.wastedPct, 100, 'one failed direct attempt per frame is 100% waste');
  eq(s.degraded, true, 'per-frame wasted attempts are a degraded state');
  ok(/⚠100% wasted/.test(s.text), 'the HUD says so out loud');
}
// Boundary: warm-up noise must not cry wolf on every clip.
ok(!/wasted/.test(summarizeDecodeRoute(stats({ 'sandbox:j2k-openjpeg': 100 }, { directFailures: 9 })).text),
   '9% wasted attempts (startup warm-up) stays quiet');
ok(/wasted/.test(summarizeDecodeRoute(stats({ 'sandbox:j2k-openjpeg': 100 }, { directFailures: 10 })).text),
   '10% wasted attempts warns — threshold is inclusive');
eq(summarizeDecodeRoute(stats({ 'sandbox:j2k-openjpeg': 100 }, { directFailures: 9 })).degraded, false,
   'below the threshold is not degraded');

// ── an unrecognised backend degrades to its raw name, never to silence ──
{
  const s = summarizeDecodeRoute(stats({ 'sandbox:some-future-decoder': 12 }));
  eq(s.label, 'sandbox:some-future-decoder', 'unknown backends still get named');
  ok(s.text.length > 0, 'a new decode rung is visible before anyone adds a label for it');
}

// ── the live counters are a copy, and resettable ──
{
  const a = getDecodeRouteStats();
  a.byBackend['forged'] = 999;
  a.total = 999;
  eq(getDecodeRouteStats().total, 0, 'mutating a returned snapshot cannot corrupt the counters');
  ok(!('forged' in getDecodeRouteStats().byBackend), 'byBackend is copied, not aliased');
  resetDecodeRouteStats();
  eq(getDecodeRouteStats().last, null, 'reset clears the last-backend marker');
}

// ── the player must actually render this ──
{
  const p = fs.readFileSync(path.join(root, 'src/scripts/modules/imf/imf_player.js'), 'utf8');
  ok(/summarizeDecodeRoute\s*=\s*m\.summarizeDecodeRoute/.test(p),
     'player binds summarizeDecodeRoute from the J2K module');
  ok(/_summarizeDecodeRoute\(_getDecodeRouteStats\(\)\)/.test(p),
     'player feeds the live counters to the summariser');
  ok(/bits\.push\(route\.text\)/.test(p),
     'the summary is pushed into the HUD line (not computed and dropped)');
  ok(/route\?\.degraded\s*\?/.test(p),
     'a degraded rung recolours the HUD instead of being reported green');
  ok(/_resetDecodeRouteStats\(\)/.test(p),
     'route counters are reset per reel, like every other per-clip counter');
  // The HUD is off by default and toggled with H; the route line must live
  // inside that block, not be burned onto delivery captures.
  const hud = p.slice(p.indexOf('if (S.showRtHud)'), p.indexOf('const barH = 26;'));
  ok(hud.includes('_summarizeDecodeRoute'), 'the route readout is inside the toggled HUD block');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
