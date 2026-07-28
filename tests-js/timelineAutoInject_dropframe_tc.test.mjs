// tests-js/timelineAutoInject_dropframe_tc.test.mjs
//
// timelineAutoInject.js's TC_EXACT_RE/TC_FIND_RE/extractFirstTc only matched
// "HH:MM:SS:FF" (':'-only). edl.js's own timecode regex accepts ':' or ';'
// in every field and hands recIn/recOut through verbatim, so a drop-frame
// EDL's Event Table cells read "HH:MM:SS;FF" — extractFirstTc() then found
// no match, tcToFrames() returned NaN, and extractClips()/guessTimecodesFromRow()
// silently dropped or mis-positioned every DF row from the injected timeline
// strip.
//
// timelineAutoInject.js has no exports (it's a pure side-effect/auto-run
// module) and none of its internal helpers are exposed, so the relevant
// source is extracted as text and evaluated in isolation with `new Function`,
// mirroring the pattern used for amf_convert.js.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const src = readFileSync(ROOT + 'src/scripts/features/edl/timelineAutoInject.js', 'utf8');

function extractBlock(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error(`marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  if (end < 0) throw new Error(`end marker not found: ${endMarker}`);
  return src.slice(start, end);
}

// Pull TC_EXACT_RE, TC_FIND_RE, extractFirstTc, collectTcs, and tcToFrames
// together as one self-contained block (tcToFrames depends on the others).
const block = extractBlock(
  'const TC_EXACT_RE',
  'function parseIntLoose'
);

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

// eslint-disable-next-line no-new-func
const harness = new Function(`
  ${block}
  return { tcToFrames, extractFirstTc, collectTcs };
`)();

ok(harness.tcToFrames('01:00:10:00', 24) === 86640, 'NDF timecode still converts correctly');
ok(harness.tcToFrames('01:00:10;00', 24) === 86640, 'DF timecode ("HH:MM:SS;FF") converts, not NaN');
ok(Number.isNaN(harness.tcToFrames('garbage', 24)), 'malformed timecode safely returns NaN, not a crash');
ok(harness.extractFirstTc('LOC : 01:00:10;00') === '01:00:10;00', 'extractFirstTc finds a DF timecode embedded in text');

{
  const tcs = harness.collectTcs('01:00:00;00 01:00:00;00 01:00:10;00 01:00:20;00');
  ok(tcs.length === 4, 'collectTcs finds all 4 DF timecodes in a row, not just NDF ones');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
