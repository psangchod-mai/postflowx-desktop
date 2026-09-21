// Marker→timeline-clip matching by record TC. Run: node tests-js/markerClipMatcher.test.mjs
// Golden coverage for the LIVE (untested) src/scripts/modules/markerClipMatcher.js.
import { buildClipsFromEvents, matchMarkersToTimelineClips }
  from '../src/scripts/modules/markerClipMatcher.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

const FPS = 24;
const m1 = (id, recIn, recOut) => ({ id, recIn, recOut, shotName: id });
const match = (markers, clips) => matchMarkersToTimelineClips(markers, clips, FPS);

// ── buildClipsFromEvents ──
const clips = buildClipsFromEvents([
  { recIn: '01:00:00:00', recOut: '01:00:04:00', clipName: 'A', trackIndex: 0, srcFile: 'A.mxf', srcIn: '10:00:00:00', srcOut: '10:00:04:00' },
  { recIn: '01:00:04:00', recOut: '01:00:08:00', clipName: 'B', trackIndex: 0 },
], FPS);
eq(clips.length, 2, 'buildClips: 2 clips');
eq(clips[0].recInF, 86400, 'clip A recInF = 01:00:00:00 @24');
eq(clips[0].recOutF, 86496, 'clip A recOutF = +4s');
eq(clips[0].clipId, 0, 'clip A id');
eq(clips[0].trackRaw, 'V1', 'clip A trackRaw default V1');
eq(clips[0].srcIn, '10:00:00:00', 'clip A srcIn carried');
eq(buildClipsFromEvents([{ recIn: '01:00:00:00', recOut: '01:00:00:00', reel: 'R1' }], FPS)[0].recOutF, 86401, 'zero-length clip → recOut = recIn+1');
eq(buildClipsFromEvents([{ recIn: '01:00:00:00', reel: 'R1' }], FPS)[0].clipName, 'R1', 'clipName falls back to reel');

// ── exact containment (single) → matched / 100 ──
const ex = match([m1('mx', '01:00:02:00')], clips).get('mx');
eq(ex.matchStatus, 'matched', 'exact: status matched');
eq(ex.confidence, 100, 'exact: confidence 100');
eq(ex.matchedClipName, 'A', 'exact: matched clip A');
eq(ex.matchedTrack, 'V1', 'exact: matched track V1');

// ── boundary is half-open [in, out): recOut belongs to the NEXT clip ──
const bd = match([m1('mb', '01:00:04:00')], clips).get('mb');
eq(bd.matchedClipName, 'B', 'boundary 01:00:04:00 → clip B (half-open range)');
eq(bd.confidence, 100, 'boundary: exact 100');

// ── orphan → confidence 0 ──
const orf = match([m1('mo', '02:00:00:00')], clips).get('mo');
eq(orf.matchStatus, 'orphan', 'orphan status');
eq(orf.confidence, 0, 'orphan confidence 0');
eq(orf.matchedClipId, null, 'orphan no clip');

// ── overlap-only (marker starts before clip) → matched / 80 ──
const ov = match([{ id: 'mv', recIn: '00:59:59:00', recOut: '01:00:01:00' }], clips).get('mv');
eq(ov.matchStatus, 'matched', 'overlap: matched');
eq(ov.confidence, 80, 'overlap-only confidence 80');
ok(/Overlap/.test(ov.warning || ''), 'overlap: warning set');

// ── multi_match: marker inside two overlapping clips, preferTrack picks V1 ──
const multiClips = buildClipsFromEvents([
  { recIn: '01:00:00:00', recOut: '01:00:06:00', clipName: 'C', trackIndex: 1 }, // V2 listed first
  { recIn: '01:00:00:00', recOut: '01:00:04:00', clipName: 'A', trackIndex: 0 }, // V1
], FPS);
const mm = match([m1('mm', '01:00:02:00')], multiClips).get('mm');
eq(mm.matchStatus, 'multi_match', 'multi: status multi_match');
eq(mm.confidence, 50, 'multi: confidence 50');
eq(mm.matchedTrack, 'V1', 'multi: preferTrack(0)=V1 wins over V2 despite list order');
eq(mm.candidates.length, 2, 'multi: 2 candidates reported');

// ── each marker evaluated independently (dup ranges don't conflict) ──
const dup = match([m1('d1', '01:00:02:00'), m1('d2', '01:00:02:00')], clips);
eq(dup.get('d1').matchedClipName, 'A', 'dup d1 → A');
eq(dup.get('d2').matchedClipName, 'A', 'dup d2 → A (independent, no conflict)');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
