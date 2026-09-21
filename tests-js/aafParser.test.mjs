// AAF worker-JSON → events adapter. Run: node tests-js/aafParser.test.mjs
import { parseAAFJson } from '../src/scripts/parsers/aaf_wasm.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

const worker = {
  fps: 24,
  projectName: 'AVID_SHOW',
  events: [
    { event: 1, reel: 'A001', clipName: 'A001C002', sourceFile: '/avid/A001C002.mxf', srcIn: '01:00:00:00', srcOut: '01:00:04:00', recIn: '00:00:00:00', recOut: '00:00:04:00', fps: 24 },
    { event: 2, sourceFile: '/avid/B002C005.mxf', srcIn: '02:00:00:00', srcOut: '02:00:02:00', fps: 24 }, // no reel → derive from sourceFile
    { event: 3 }, // no reel/clip/source → filtered out
  ],
};

const r = parseAAFJson(worker, 'AVID_SHOW.aaf');
eq(r.projectName, 'AVID_SHOW', 'projectName from worker');
eq(r.sourceType, 'aaf', 'sourceType=aaf');
eq(r.fps, 24, 'fps');
eq(r.events.length, 2, 'eventless row filtered out → 2 events');

const e0 = r.events[0];
eq(e0.reel, 'A001', 'e0 reel from worker');
eq(e0.srcIn, '01:00:00:00', 'e0 srcIn string pass-through');
eq(e0.srcOut, '01:00:04:00', 'e0 srcOut');
eq(e0.srcFile, '/avid/A001C002.mxf', 'e0 srcFile from sourceFile');

const e1 = r.events[1];
eq(e1.reel, 'B002C005', 'e1 reel derived from sourceFile stem (no reel attr)');
eq(e1.srcFile, '/avid/B002C005.mxf', 'e1 srcFile = sourceFile');
eq(e1.clipName, 'B002C005', 'e1 clipName falls back to reel');

// normTC: frame-number → TC conversion
{
  const r2 = parseAAFJson({ fps: 24, events: [{ reel: 'X', srcIn: 86400, srcOut: 86496 }] });
  eq(r2.events[0].srcIn, '01:00:00:00', 'frame number 86400 @24 → 01:00:00:00');
  eq(r2.events[0].srcOut, '01:00:04:00', 'frame number 86496 @24 → 01:00:04:00');
}

// projectName fallback to filename stem
eq(parseAAFJson({ events: [] }, '/x/MyCut.aaf').projectName, 'MyCut', 'projectName falls back to filename stem');

// Drop-frame TC string must be preserved (not mangled to 00:00:00:00)
{
  const r3 = parseAAFJson({ fps: 29.97, events: [{ reel: 'A', srcIn: '01:00:00;00', srcOut: '01:00:04;00' }] });
  eq(r3.events[0].srcIn, '01:00:00;00', 'drop-frame srcIn preserved (not mangled)');
}

// Robustness
ok(parseAAFJson(null).events.length === 0, 'null → 0 events, no throw');
ok(parseAAFJson({}).events.length === 0, 'empty object → 0 events');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
