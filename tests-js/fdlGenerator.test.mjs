// FDL (Frame/Format Decision List) generator. Run: node tests-js/fdlGenerator.test.mjs
// Golden coverage for the LIVE src/.../vfxPull/fdlGenerator.js (the archived
// ascFdl.js was a different, framing-geometry FDL — this is the pull-plan FDL).
import { buildFDL, buildFDLJson, buildFDLCsv, buildFDLTxt } from '../src/scripts/features/vfxPull/fdlGenerator.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

// ── Representative inputs (deterministic except meta.generatedAt) ──
const job = {
  shotId: 'SH010', plateName: 'SH010_plate_v1',
  frameStart: 1001, expectedRenderedFrameCount: 120, handleFrames: 8,
  fps: 24, exr: true, color: { mode: 'aces' },
  naming: { resolution: '4096x2160', clipName: 'A001C002' },
  sourcePath: '/ocf/A001C002.mxf', exportIn: '01:00:00:00', exportOut: '01:00:05:00',
};
const referenceInfo = { path: '/ref/q.mov', width: 2048, height: 1080, tcIn: '10:00:00:00', tcOut: '10:00:05:00' };
const matchResult = { matchMethod: 'timecode', confidence: 98, warnings: [] };

const fdl = buildFDL({ job, matchResult, referenceInfo });

// ── structure / identity ──
eq(fdl.schema, 'postflowx.vfxpull.fdl.v1', 'schema tag');
eq(fdl.shotName, 'SH010', 'shotName from job.shotId');
eq(fdl.plateName, 'SH010_plate_v1', 'plateName');
eq(fdl.source.resolution, '4096x2160', 'source.resolution');
eq(fdl.source.clipName, 'A001C002', 'source.clipName');
eq(fdl.reference.resolution, '2048x1080', 'reference.resolution from w×h');

// ── frame-range math (GOLDEN) ──
eq(fdl.pull.frameStart, 1001, 'frameStart');
eq(fdl.pull.frameEnd, 1120, 'frameEnd = start + frames - 1 (1001+120-1)');
eq(fdl.pull.handles, 8, 'handles');
eq(fdl.pull.outputFormat, 'EXR', 'outputFormat EXR (job.exr)');
eq(fdl.pull.outputColorSpace, 'ACES2065-1 AP0', 'aces mode → ACES2065-1 AP0');

// ── reformat scale (GOLDEN) — min(refW/srcW, refH/srcH), 4dp ──
eq(fdl.pull.referenceReformat.scale, 0.5, 'auto scale 4096x2160→2048x1080 = 0.5');
eq(fdl.pull.referenceReformat.fit, 'centerCrop', 'default fit centerCrop');
ok(/Auto-computed/.test(fdl.pull.referenceReformat.notes), 'auto scale notes');

// non-trivial golden scale: 4608x3164 → 3840x2160 = min(0.8333, 0.6827) = 0.6827
const fdl2 = buildFDL({ job: { ...job, naming: { resolution: '4608x3164' } },
                        referenceInfo: { width: 3840, height: 2160 }, matchResult });
eq(fdl2.pull.referenceReformat.scale, 0.6827, 'auto scale 4608x3164→3840x2160 = 0.6827');

// ── AMF precedence ──
eq(fdl.color.amf, 'SH010_plate_v1.amf', 'amf falls back to plateName.amf');
eq(buildFDL({ job, matchResult, referenceInfo, amfFileName: 'explicit.amf' }).color.amf,
   'explicit.amf', 'explicit amfFileName wins');

// ── explicit reformat passthrough (crop + cropBox both stored) ──
const fdlRf = buildFDL({ job, matchResult,
  referenceInfo: { width: 2048, height: 1080, reformat: { scale: 0.5, cropBox: [0, 0, 100, 200], fit: 'letterbox', notes: 'manual' } } });
eq(fdlRf.pull.referenceReformat.fit, 'letterbox', 'explicit reformat fit');
eq(JSON.stringify(fdlRf.pull.referenceReformat.crop), '[0,0,100,200]', 'crop from cropBox');
eq(JSON.stringify(fdlRf.pull.referenceReformat.cropBox), '[0,0,100,200]', 'cropBox preserved');

// ── qc ──
eq(fdl.qc.matchMethod, 'timecode', 'qc.matchMethod');
eq(fdl.qc.confidence, 98, 'qc.confidence');

// ── JSON round-trip ──
ok(JSON.stringify(JSON.parse(buildFDLJson(fdl))) === JSON.stringify(fdl), 'buildFDLJson round-trips');

// ── CSV: header + row + escaping ──
const csvFdl = buildFDL({ job, matchResult: { matchMethod: 'reel', confidence: 80, warnings: ['has, a comma'] }, referenceInfo });
const csv = buildFDLCsv([csvFdl]);
const [hdr, row] = csv.split('\r\n');
ok(hdr.startsWith('schema,shotName,plateName,'), 'CSV header order');
ok(row.includes('"has, a comma"'), 'CSV escapes comma-containing warning');
eq(buildFDLCsv([]), '', 'CSV empty array → empty string');

// ── TXT human block ──
const txt = buildFDLTxt(fdl);
ok(txt.includes('PostFlowX FDL'), 'TXT title');
ok(txt.includes('SH010') && txt.includes('ACES2065-1 AP0'), 'TXT contains shot + colorspace');

// ── defaults when sparse ──
const bare = buildFDL({});
eq(bare.pull.frameStart, 1001, 'default frameStart 1001');
eq(bare.pull.frameEnd, 1001, 'default frameEnd (1 frame)');
eq(bare.pull.handles, 8, 'default handles 8');
eq(bare.pull.referenceReformat.scale, null, 'no resolutions → null scale');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
