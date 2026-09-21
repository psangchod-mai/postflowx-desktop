// OTIO export builder + builder↔parser roundtrip. Run: node tests-js/otioExport.test.mjs
// Golden coverage for the LIVE (untested) src/scripts/modules/otio_export.js.
import { buildOTIOJSON } from '../src/scripts/modules/otio_export.js';
import { parseOTIO }     from '../src/scripts/parsers/otio.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

const ev1 = { clipName: 'A001C002', reel: 'A001', srcFile: 'A001C002.mxf',
              srcIn: '01:00:00:00', srcOut: '01:00:04:00', recIn: '01:00:00:00', recOut: '01:00:04:00' };
const ev2 = { clipName: 'B002C005', reel: 'B002', srcFile: 'B002C005.mxf',
              srcIn: '02:00:00:00', srcOut: '02:00:02:00', recIn: '01:00:04:00', recOut: '01:00:06:00' };

// ── golden structure (mode 'all') ──
const otio = buildOTIOJSON([ev1, ev2], [], null, { mode: 'all', fps: 24, projectName: 'SHOW' });
eq(otio.OTIO_SCHEMA, 'Timeline.1', 'top schema Timeline.1');
eq(otio.name, 'SHOW', 'timeline name from projectName');
eq(otio.global_start_time.value, 86400, 'global_start_time = 01:00:00:00 @24 = 86400');
const track = otio.tracks.children[0];
eq(track.OTIO_SCHEMA, 'Track.1', 'track schema');
eq(track.kind, 'Video', 'track kind Video');
const clips = track.children;
eq(clips.length, 2, 'one clip per event');
eq(clips[0].OTIO_SCHEMA, 'Clip.2', 'clip schema Clip.2');
eq(clips[0].name, 'A001C002', 'clip name = clipName');
eq(clips[0].source_range.start_time.value, 86400, 'source_range start = srcIn frames');
eq(clips[0].source_range.start_time.rate, 24, 'source_range rate');
eq(clips[0].source_range.duration.value, 96, 'source_range duration = 4s @24 = 96');
eq(clips[0].range_in_parent.start_time.value, 86400, 'range_in_parent start = recIn');
eq(clips[0].media_reference.OTIO_SCHEMA, 'ExternalReference.1', 'media_reference schema');
eq(clips[0].media_reference.target_url, 'file:///A001C002.mxf', 'media target_url');
eq(clips[0].media_reference.metadata.PostFlowX.reel, 'A001', 'media metadata reel');
eq(clips[0].markers.length, 0, 'no markers when none linked');

// ── roundtrip: build → parseOTIO → events match ──
const rt = parseOTIO(otio);
eq(rt.projectName, 'SHOW', 'roundtrip projectName');
eq(rt.fps, 24, 'roundtrip fps');
eq(rt.events.length, 2, 'roundtrip event count');
eq(rt.events[0].clipName, 'A001C002', 'roundtrip e0 clipName');
eq(rt.events[0].srcIn, '01:00:00:00', 'roundtrip e0 srcIn');
eq(rt.events[0].srcOut, '01:00:04:00', 'roundtrip e0 srcOut (start+4s)');
eq(rt.events[1].srcIn, '02:00:00:00', 'roundtrip e1 srcIn');
eq(rt.events[1].srcOut, '02:00:02:00', 'roundtrip e1 srcOut');
// roundtrip via JSON string too (export → file → re-import)
eq(parseOTIO(JSON.stringify(otio)).events.length, 2, 'roundtrip through JSON string');

// ── embedded marker ──
const markers = [{ id: 'm1', tc: '01:00:02:00', shotName: 'SH010', color: 'red', note: 'fix', noteType: 'paint' }];
const withMk = buildOTIOJSON([ev1], markers, new Map([['m1', 0]]), { mode: 'all', fps: 24 });
const c0 = withMk.tracks.children[0].children[0];
eq(c0.markers.length, 1, 'linked marker embedded in clip');
eq(c0.markers[0].name, 'SH010', 'marker name from shotName');
eq(c0.markers[0].color, 'RED', 'marker color mapped to OTIO RED');
eq(c0.markers[0].marked_range.start_time.value, 48, 'marker offset = mkTC - srcIn (2s @24)');
eq(c0.markers[0].metadata.PostFlowX.note, 'fix', 'marker note in metadata');

// ── vfxrename mode uses _pmShot as clip name ──
const vr = buildOTIOJSON(
  [{ clipName: 'A001C002', _pmShot: 'SH010_plate', reel: 'A001', srcIn: '01:00:00:00', srcOut: '01:00:02:00' }],
  [], null, { mode: 'vfxrename', fps: 24 });
eq(vr.tracks.children[0].children[0].name, 'SH010_plate', 'vfxrename → clip name = _pmShot');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
