// Watch-folder settle/debounce + ignore filter (D1). Run: node tests-js/watchFolderSettle.test.mjs
import { isIgnorable, createBatcher } from '../src/scripts/features/watchFolder/settleBatch.js';
import { proposeAction } from '../src/scripts/features/watchFolder/proposeAction.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

// ── isIgnorable ──
ok(isIgnorable('/d/.DS_Store'), '.DS_Store ignored');
ok(isIgnorable('/d/.syncing'), 'dotfile ignored');
ok(isIgnorable('/d/A001.mxf.tmp'), '.tmp ignored');
ok(isIgnorable('/d/clip.mov.part'), '.part ignored');
ok(isIgnorable('/d/note.txt~'), 'backup~ ignored');
ok(isIgnorable('/d/Thumbs.db'), 'Thumbs.db ignored');
ok(!isIgnorable('/d/A001C002.mxf'), 'real mxf NOT ignored');
ok(!isIgnorable('/d/cut.edl'), 'real edl NOT ignored');

// ── batcher: settle window ──
const b = createBatcher({ settleMs: 1500 });
eq(b.add('/d/A001.mxf', 1000), true, 'add real file → accepted');
eq(b.add('/d/.DS_Store', 1000), false, 'add junk → rejected');
eq(b.pendingCount(), 1, 'one pending (junk not counted)');
eq(b.ready(2000), null, 'not ready: only 1000ms since last event (<1500)');
b.add('/d/A002.mxf', 2200);                 // new event resets the quiet timer
eq(b.ready(3000), null, 'not ready: 800ms since the 2200 event');
const batch = b.ready(3800);                // 1600ms quiet → settled
ok(Array.isArray(batch) && batch.length === 2, 'ready: settled batch of 2 files');
eq(b.pendingCount(), 0, 'batch consumed → store reset');
eq(b.ready(9999), null, 'nothing pending after consume');

// ── dedup: same path touched repeatedly = one entry ──
const b2 = createBatcher({ settleMs: 1000 });
b2.add('/d/X.mxf', 100); b2.add('/d/X.mxf', 200); b2.add('/d/X.mxf', 300);
eq(b2.pendingCount(), 1, 'repeated events on same path dedup to 1');
eq(b2.ready(1300).length, 1, 'settled batch has the single deduped path');

// ── end-to-end: settled batch → proposeAction ──
const b3 = createBatcher({ settleMs: 500 });
['/r/A001.mxf', '/r/A002.mxf', '/r/A003.mxf', '/r/.DS_Store', '/r/A001.mxf.part'].forEach(p => b3.add(p, 0));
const settled = b3.ready(600);
eq(settled.length, 3, 'junk + .part filtered, 3 real OCF remain');
const proposal = proposeAction(settled);
eq(proposal.kind, 'ocf', 'proposeAction on settled batch → ocf');
eq(proposal.count, 3, 'proposal counts 3 ocf');

// ── clear ──
const b4 = createBatcher();
b4.add('/d/a.mxf', 0); b4.clear();
eq(b4.pendingCount(), 0, 'clear() empties pending');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
