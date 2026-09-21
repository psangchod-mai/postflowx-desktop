// Property/fuzz tests for core frame↔TC + seek math. Run: node tests-js/timecodeFuzz.test.mjs
// Deterministic LCG seed → any failure is reproducible. These explore the input
// space golden tests miss (a golden test already caught seekModel's round/floor bug).
import { timecodeToFrames, framesToTimecode, tcToFrames, framesToTC } from '../src/scripts/modules/utils_time.js';
import seekModel from '../electron/native/seekModel.js';
const { frameToSeconds, secondsToFrame } = seekModel;

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; } else { failed++; console.error('FAIL -', l); } }
// Seeded PRNG (mulberry32) — reproducible across runs.
let _s = 0x9e3779b9;
function rnd() { _s |= 0; _s = (_s + 0x6D2B79F5) | 0; let t = Math.imul(_s ^ (_s >>> 15), 1 | _s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const randInt = (max) => Math.floor(rnd() * max);

const N = 4000;

// ── NDF round-trip (timecodeToFrames/framesToTimecode, non-drop) ──
// Uses round(fps) base internally → must round-trip EXACTLY at every supported rate.
for (const fps of [24, 25, 30, 50, 60, 23.976, 29.97, 59.94]) {
  const settings = { general: { frameRate: fps, timecodeMode: 'non-drop' } };
  let bad = 0, ex = '';
  for (let k = 0; k < N; k++) {
    const f = randInt(30 * 3600 * 60);          // up to 30h at 60fps
    const rt = timecodeToFrames(framesToTimecode(f, settings), settings);
    if (rt !== f) { bad++; if (!ex) ex = `f=${f} → ${framesToTimecode(f, settings)} → ${rt}`; }
  }
  ok(bad === 0, `NDF round-trip @${fps} (${bad}/${N} bad${ex ? ', e.g. ' + ex : ''})`);
}

// ── Drop-frame round-trip (29.97 DF, 59.94 DF) — the buggiest arithmetic ──
for (const fps of [29.97, 59.94]) {
  const settings = { general: { frameRate: fps, timecodeMode: 'drop' } };
  let bad = 0, ex = '';
  for (let k = 0; k < N; k++) {
    const f = randInt(30 * 3600 * 60);
    const rt = timecodeToFrames(framesToTimecode(f, settings), settings);
    if (rt !== f) { bad++; if (!ex) ex = `f=${f} → ${framesToTimecode(f, settings)} → ${rt}`; }
  }
  ok(bad === 0, `DF round-trip @${fps} (${bad}/${N} bad${ex ? ', e.g. ' + ex : ''})`);
}

// ── Bare NDF helpers, nominal-base contract, at EVERY supported rate ──
// This list used to stop at 60 and skip 23.976/29.97/59.94 — the only rates where
// the "nominal-base" contract in this comment says anything at all, because they
// are the only ones where the nominal base differs from the rate. The bare pair
// took the rate at face value, so it was not invertible at any of them
// ('01:00:00:00' @23.976 → 86313 → '00:59:59:23'). tcToFrames/framesToTC now round
// to the whole-frame base themselves, which is what the wrapper above them was
// already doing on their behalf.
for (const fps of [24, 25, 30, 50, 60, 23.976, 29.97, 59.94]) {
  let bad = 0, ex = '';
  for (let k = 0; k < N; k++) {
    const f = randInt(30 * 3600 * fps);
    const rt = tcToFrames(framesToTC(f, fps), fps);
    if (rt !== f) { bad++; if (!ex) ex = `f=${f} → ${framesToTC(f, fps)} → ${rt}`; }
  }
  ok(bad === 0, `tcToFrames/framesToTC round-trip @${fps} (${bad}/${N} bad${ex ? ', e.g. ' + ex : ''})`);
}

// ── seekModel: mid-frame seconds must land back on the same frame, all rates ──
for (const fps of [24, 23.976, 25, 29.97, 30, 50, 59.94, 60]) {
  let bad = 0, ex = '';
  for (let k = 0; k < N; k++) {
    const f = randInt(30 * 3600 * 60);
    const rt = secondsToFrame(frameToSeconds(f, fps), fps);
    if (rt !== f) { bad++; if (!ex) ex = `f=${f} → ${frameToSeconds(f, fps)}s → ${rt}`; }
  }
  ok(bad === 0, `seekModel frame→sec→frame @${fps} (${bad}/${N} bad${ex ? ', e.g. ' + ex : ''})`);
}

console.log(`\n${passed} passed, ${failed} failed  (${N} samples each)`);
process.exit(failed ? 1 : 0);
