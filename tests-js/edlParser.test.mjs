// CMX3600 EDL parser correctness. Run: node tests-js/edlParser.test.mjs
import { parseEDL } from '../src/scripts/parsers/edl.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

const EDL = `TITLE: MY_SHOW_REEL1
FCM: NON-DROP

001  A001      V     C        01:00:00:00 01:00:04:00 00:00:00:00 00:00:04:00
* SOURCE FILE: A001C002_220101.mxf
002  B002      V     C        02:00:10:00 02:00:12:00 00:00:04:00 00:00:06:00
* SOURCE FILE: B002C005_220102.mxf
003  C003      V     D    025 03:00:00:00 03:00:05:00 00:00:06:00 00:00:11:00
* SOURCE FILE: C003C001_220103.mxf
`;

const r = parseEDL(EDL, 'MY_SHOW_REEL1.edl');

eq(r.projectName, 'MY_SHOW_REEL1', 'project name from TITLE');
eq(r.sourceType, 'edl', 'sourceType=edl');
eq(r.events.length, 3, 'parsed 3 events');

// Event 0 — basic cut. NOTE: a SOURCE FILE comment intentionally overrides reel
// with the camera filename stem (better identity for OCF matching).
const e0 = r.events[0];
eq(e0.reel, 'A001C002_220101', 'e0 reel = SOURCE FILE stem (intentional override)');
eq(e0.srcIn, '01:00:00:00', 'e0 srcIn');
eq(e0.srcOut, '01:00:04:00', 'e0 srcOut');
eq(e0.recIn, '00:00:00:00', 'e0 recIn');
eq(e0.recOut, '00:00:04:00', 'e0 recOut');
eq(e0.srcFile, 'A001C002_220101.mxf', 'e0 SOURCE FILE comment captured');

// Event 1 — second cut, different reel/TC
const e1 = r.events[1];
eq(e1.srcIn, '02:00:10:00', 'e1 srcIn');
eq(e1.recIn, '00:00:04:00', 'e1 recIn (continues from e0 recOut)');

// Event 2 — dissolve transition (D + 25 frames)
const e2 = r.events[2];
eq(e2.transition, 'D025', 'e2 dissolve transition token D025');
eq(e2.srcIn, '03:00:00:00', 'e2 srcIn');
eq(e2.srcOut, '03:00:05:00', 'e2 srcOut');

// All events tagged with the guessed integer fps
ok(Number.isInteger(r.fps) && r.fps > 0, `fps is a positive integer (got ${r.fps})`);
ok(r.events.every(e => Number.isInteger(e.fps)), 'every event has an integer fps');

// ── Drop-frame header + semicolon TCs ──
const EDL_DF = `TITLE: DF_SHOW
FCM: DROP FRAME

001  A001      V     C        01:00:00;00 01:00:04;00 00:00:00;00 00:00:04;00
`;
const rdf = parseEDL(EDL_DF, 'DF_SHOW.edl');
eq(rdf.events.length, 1, 'DF EDL parses 1 event (was 0 — drop-frame ";" TCs were unmatched)');
eq(rdf.events[0]?.reel, 'A001', 'DF event reel (raw reel token — no SOURCE FILE comment)');
eq(rdf.events[0]?.srcIn, '01:00:00;00', 'DF event srcIn preserves ";" separator');
ok(rdf.fps >= 30, `DF EDL fps guessed >= 30 (got ${rdf.fps})`);

// ── Robustness: empty / garbage input doesn't throw ──
ok(parseEDL('', 'x.edl').events.length === 0, 'empty EDL → 0 events, no throw');
ok(Array.isArray(parseEDL('not an edl at all\nrandom text', 'x.edl').events), 'garbage input → events array, no throw');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
