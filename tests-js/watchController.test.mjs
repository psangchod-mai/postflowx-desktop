// Watch-folder controller orchestration (D1). Run: node tests-js/watchController.test.mjs
import { createWatchController } from '../src/scripts/features/watchFolder/watchController.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

// Fake clock so settle timing is deterministic.
let T = 0; const now = () => T;
const proposals = [];
const ctl = createWatchController({ settleMs: 1000, now, onProposal: (p) => proposals.push(p) });

// Events ignored before start()
ctl.onFsEvent('/d/early.mxf');
eq(ctl.pendingCount(), 0, 'events ignored before start()');

ctl.start(() => 'fake-timer-handle');   // injected scheduler — we drive tick() ourselves
ok(ctl.isActive(), 'active after start');

// A camera roll lands across a short burst
T = 0;    ctl.onFsEvent('/r/A001.mxf');
T = 200;  ctl.onFsEvent('/r/A002.mxf');
T = 400;  ctl.onFsEvent('/r/.DS_Store');     // junk, filtered
T = 400;  ctl.onFsEvent('/r/A003.mxf.part'); // in-progress, filtered
eq(ctl.pendingCount(), 2, 'only 2 real files pending (junk/part filtered)');

// Not settled yet (last event at 400, only 900ms elapsed)
T = 900;  eq(ctl.tick(), null, 'tick before settle → no proposal');
eq(proposals.length, 0, 'no proposal emitted yet');

// Settled (1000ms quiet since the last real event)
T = 1400; const p = ctl.tick();
ok(p && p.kind === 'ocf' && p.count === 2, 'settled tick → ocf proposal for 2 files');
eq(proposals.length, 1, 'onProposal fired exactly once');
eq(proposals[0].tab, 'prepmark', 'proposal routes to prepmark tab');
eq(ctl.pendingCount(), 0, 'batch consumed');

// Idle tick does nothing
T = 5000; eq(ctl.tick(), null, 'idle tick → null');
eq(proposals.length, 1, 'no duplicate proposal');

// A pure-junk burst settles to no proposal (tick returns null, sink not called)
T = 6000; ctl.onFsEvent('/r/.hidden'); ctl.onFsEvent('/r/x.tmp');
eq(ctl.pendingCount(), 0, 'junk-only burst adds nothing');
T = 8000; eq(ctl.tick(), null, 'junk-only → no proposal');
eq(proposals.length, 1, 'still one proposal total');

// stop() deactivates and clears
let cleared = null;
ctl.stop((h) => { cleared = h; });
ok(!ctl.isActive(), 'inactive after stop');
ctl.onFsEvent('/r/B001.mxf');
eq(ctl.pendingCount(), 0, 'events ignored after stop');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
