// tests-js/amfConvert_fractionalFpsTcToFrames.test.mjs
//
// exportNukeNK()'s module-scope tcToFrames(tc, fps) (amf_convert.js, ~line
// 2528) multiplied the timecode's HH:MM:SS component directly by `fps` --
// but `fps` here is `base?.fps || DEFAULT_FPS`, the parser's raw fractional
// NTSC rate (23.976/29.97/59.94), not the nominal whole-frame base a
// timecode's FF field actually counts against. A 23.976fps EDL's
// "00:00:05:00" (5 real seconds -> 120 frames at the 24-frame nominal base)
// was converted to 119.88 instead of 120, producing a non-integer
// recInF/recOutF/durF and Root.last_frame in the exported .nk script --
// the same fps-base-vs-fractional-rate bug class already fixed in
// filters.js (Iteration 50) and eventDuration.js, converged here via the
// shared nominalBase() helper from utils_time.js.
//
// amf_convert.js touches `document` at module scope, so it can't be
// import()'d under plain Node (see amfConvert_dropframe_tc.test.mjs for the
// same constraint) -- this test extracts just the module-scope tcToFrames
// body as text and evaluates it with `new Function`, providing a stub
// nominalBase matching the real one's rounding behavior.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const src = readFileSync(ROOT + 'src/scripts/modules/amf_convert.js', 'utf8');

// The module-scope definition is the first of the three tcToFrames copies in
// this file (the other two live inside AE/ExtendScript JSX template-literal
// text and are a separate, not-yet-converged instance of this bug class).
const m = src.match(/function tcToFrames\([^)]*\)\s*\{[\s\S]*?\n\}/);

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

ok(!!m, 'found the module-scope tcToFrames definition in amf_convert.js');

function nominalBase(fps) {
  const n = Number(fps);
  if (!Number.isFinite(n) || n <= 0) return 24;
  return Math.round(n);
}

// eslint-disable-next-line no-new-func
const tcToFrames = new Function('nominalBase', 'tc', 'fps', `${m[0]}\nreturn tcToFrames(tc, fps);`);
const call = (tc, fps) => tcToFrames(nominalBase, tc, fps);

ok(call('00:00:05:00', 23.976) === 120, `5 real seconds at 23.976fps is 120 frames on the 24-frame nominal base (got ${call('00:00:05:00', 23.976)})`);
ok(Number.isInteger(call('00:00:05:00', 23.976)), 'frame count is a whole number, not a fraction');
ok(call('01:00:00:00', 29.97) === 108000, `1 hour at 29.97fps is 108000 frames on the 30-frame nominal base (got ${call('01:00:00:00', 29.97)})`);
ok(call('00:00:01:00', 59.94) === 60, `1 real second at 59.94fps is 60 frames on the 60-frame nominal base (got ${call('00:00:01:00', 59.94)})`);
ok(call('01:00:10:00', 30) === 108300, `whole-number fps is unaffected (got ${call('01:00:10:00', 30)})`);
ok(call('01:00:10;00', 30) === 108300, 'drop-frame semicolon separator still normalizes and converts correctly');
ok(call('garbage', 24) === 0, 'malformed timecode safely returns 0, not a crash');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
