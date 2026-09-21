// Watch-folder action proposer (D1). Run: node tests-js/watchFolderPropose.test.mjs
import { classifyFile, proposeAction } from '../src/scripts/features/watchFolder/proposeAction.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

// ── classifyFile ──
eq(classifyFile('/x/A001C002_001.mxf'), 'ocf', 'mxf → ocf');
eq(classifyFile('/x/A001.ari'), 'ocf', 'ari → ocf');
eq(classifyFile('/x/B002.r3d'), 'ocf', 'r3d → ocf');
eq(classifyFile('/x/cut_v3.edl'), 'timeline', 'edl → timeline');
eq(classifyFile('/x/seq.fcpxml'), 'timeline', 'fcpxml → timeline');
eq(classifyFile('/x/ASSETMAP.xml'), 'imf', 'ASSETMAP → imf');
eq(classifyFile('/x/CPL_abc-123.xml'), 'imf', 'CPL_*.xml → imf');
eq(classifyFile('/x/reel.wav'), 'audio', 'wav → audio');
eq(classifyFile('/x/proxy.mov'), 'video', 'mov → video (review/proxy)');
eq(classifyFile('/x/dailies.mp4'), 'video', 'mp4 → video');
eq(classifyFile('/x/notes.txt'), 'other', 'txt → other');
eq(classifyFile(''), 'other', 'empty → other');

// ── proposeAction: single kind ──
const ocf = proposeAction(['/d/A001.mxf', '/d/A002.mxf', '/d/A003.mxf']);
eq(ocf.action, 'ocf.smartLink', 'ocf set → Smart Link OCF');
eq(ocf.count, 3, 'ocf count 3');
eq(ocf.tab, 'prepmark', 'ocf → prepmark tab');

// ── empty / non-actionable ──
eq(proposeAction([]), null, 'empty → null');
eq(proposeAction(['/d/readme.txt', '/d/log.log']), null, 'only-other → null');

// ── priority: ONE action even with mixed kinds ──
const mixed = proposeAction(['/d/cut.edl', '/d/A001.mxf', '/d/A002.mxf']);
eq(mixed.kind, 'timeline', 'timeline beats ocf (priority)');
eq(mixed.count, 1, 'mixed: timeline count');
ok(/also .*ocf/.test(mixed.reason), 'mixed: reason mentions other kinds');
ok(mixed.breakdown.ocf === 2 && mixed.breakdown.timeline === 1, 'mixed: breakdown counts both');

const imfWins = proposeAction(['/d/ASSETMAP.xml', '/d/video.mxf', '/d/cut.edl']);
eq(imfWins.kind, 'imf', 'imf beats timeline + ocf');
eq(imfWins.action, 'imf.validate', 'imf → validate action');

// ── object entries accepted ──
const objs = proposeAction([{ path: '/d/a.wav' }, { path: '/d/b.wav' }]);
eq(objs.kind, 'audio', 'object entries → audio');
eq(objs.count, 2, 'object entries count');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
