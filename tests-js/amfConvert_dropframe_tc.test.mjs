// tests-js/amfConvert_dropframe_tc.test.mjs
//
// amf_convert.js defines tcToFrames three separate times (module scope for
// master-mode Nuke segment building, inside __buildAEPCommonJSX's returned
// AE-project-builder text, and inside exportAEJSX's generated .jsx text for
// After Effects marker/segment timing). All three regexes only matched
// "HH:MM:SS:FF". edl.js's own timecode regex (/\b\d{2}[:;]\d{2}[:;]\d{2}[:;]\d{2}\b/g)
// accepts ':' or ';' in every position, so drop-frame EDLs hand recIn/recOut
// straight through as "HH:MM:SS;FF" — every one of these tcToFrames copies
// then returned 0 for real DF timecodes, collapsing VFX comp segments and AE
// timing markers to zero-length/zero-position.
//
// amf_convert.js touches `document` at module scope, so it cannot be
// import()'d under plain Node; each tcToFrames body is instead extracted as
// text and evaluated in isolation with `new Function`, mirroring the existing
// pattern in saveOutcome.test.mjs / toastContract.test.mjs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const src = readFileSync(ROOT + 'src/scripts/modules/amf_convert.js', 'utf8');

const defs = [...src.matchAll(/function tcToFrames\([^)]*\)\s*\{[\s\S]*?\n\s*\}/g)].map((m) => m[0]);

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

ok(defs.length === 3, `found exactly 3 tcToFrames definitions in amf_convert.js (got ${defs.length})`);

defs.forEach((rawBody, i) => {
  // The third definition lives inside a template literal that gets written
  // out as .jsx text; its "\\d" is the *source* form that the template
  // literal itself unescapes to "\d" at runtime, before ExtendScript ever
  // sees it. Reproduce that one unescape step so the regex is evaluated the
  // same way it actually runs, not as raw double-backslash source text.
  const body = rawBody.replace(/\\\\d/g, '\\d');
  // eslint-disable-next-line no-new-func
  const tcToFrames = new Function('tc', 'fps', `${body}\nreturn tcToFrames(tc, fps);`);

  ok(tcToFrames('01:00:10:00', 30) === 108300, `def #${i + 1}: NDF timecode still converts correctly`);
  ok(tcToFrames('01:00:10;00', 30) === 108300, `def #${i + 1}: DF timecode ("HH:MM:SS;FF") converts, not silently 0`);
  ok(tcToFrames('garbage', 30) === 0, `def #${i + 1}: malformed timecode safely returns 0, not a crash`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
