// OTIO parser correctness. Run: node tests-js/otioParser.test.mjs
import { parseOTIO } from '../src/scripts/parsers/otio.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

const clip = (name, url, startVal, durVal, rate) => ({
  OTIO_SCHEMA: 'Clip.2', name,
  source_range: {
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: { OTIO_SCHEMA: 'RationalTime.1', value: startVal, rate },
    duration:   { OTIO_SCHEMA: 'RationalTime.1', value: durVal,   rate },
  },
  media_reference: { OTIO_SCHEMA: 'ExternalReference.1', target_url: url },
});

const otio = {
  OTIO_SCHEMA: 'Timeline.1', name: 'MY_OTIO',
  global_start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 86400, rate: 24 }, // 01:00:00:00
  tracks: {
    OTIO_SCHEMA: 'Stack.1',
    children: [{
      OTIO_SCHEMA: 'Track.1', kind: 'Video',
      children: [
        clip('A001C002', 'file:///cam/A001C002.mov', 86400, 96, 24), // src 01:00:00:00, 4s
        clip('B002C005', 'file:///cam/B002C005.mov', 90000, 48, 24), // src 01:02:30:00, 2s
      ],
    }],
  },
};

const r = parseOTIO(otio);

eq(r.projectName, 'MY_OTIO', 'project name');
eq(r.fps, 24, 'fps = 24');
eq(r.events.length, 2, 'parsed 2 clips');

const [e0, e1] = r.events;
eq(e0.srcIn, '01:00:00:00', 'e0 srcIn from source_range start');
eq(e0.srcOut, '01:00:04:00', 'e0 srcOut = start + duration (4s)');
eq(e0.srcFile, 'A001C002.mov', 'e0 srcFile from media_reference target_url');
eq(e0.recIn, '01:00:00:00', 'e0 recIn = timeline global_start');
eq(e0.recOut, '01:00:04:00', 'e0 recOut = recIn + 4s');
eq(e1.srcIn, '01:02:30:00', 'e1 srcIn');
eq(e1.recIn, '01:00:04:00', 'e1 recIn continues from e0 recOut (track cursor)');

// Accept both string JSON and object
ok(parseOTIO(JSON.stringify(otio)).events.length === 2, 'accepts JSON string input');

// Resolve OTIO: preserve an extreme retime and animated resize exactly once.
{
  const resolveOtio = JSON.parse(JSON.stringify(otio));
  const c = resolveOtio.tracks.children[0].children[0];
  c.effects = [
    { OTIO_SCHEMA: 'LinearTimeWarp.1', time_scalar: 16.08 },
    {
      OTIO_SCHEMA: 'Effect.1',
      metadata: { Resolve_OTIO: {
        Enabled: true, 'Effect Name': 'Transform', Parameters: [
          { 'Parameter ID': 'transformationZoomX', 'Parameter Value': 1, 'Key Frames': {
            0: { Value: 1 }, 96: { Value: 2.56 },
          } },
          { 'Parameter ID': 'transformationZoomY', 'Parameter Value': 1, 'Key Frames': {
            0: { Value: 1 }, 96: { Value: 2.56 },
          } },
        ],
      } },
    },
  ];
  const [event] = parseOTIO(resolveOtio).events;
  eq(Math.round(event.speedFactor), 1608, 'Resolve LinearTimeWarp 16.08x is stored as 1608%');
  eq(event.transform.scaleX, 2.56, 'Resolve animated scale X is preserved');
  eq(event.transform.scaleY, 2.56, 'Resolve animated scale Y is preserved');
  ok(event.transform.animated === true, 'Resolve animated transform is flagged');
  ok(/Scale 100–256%/.test(event.transformSummary), 'Resolve resize summary is human readable');
}

// ── Rate normalization: 30000/1001 → nominal 30 ──
{
  const o2 = JSON.parse(JSON.stringify(otio));
  const r3997 = 30000 / 1001;
  o2.global_start_time.rate = r3997;
  o2.tracks.children[0].children.forEach(c => {
    c.source_range.start_time.rate = r3997;
    c.source_range.duration.rate = r3997;
  });
  const r2 = parseOTIO(o2);
  eq(r2.fps, 30, 'exact rate 30000/1001 normalized to nominal 30');
}

// ── Robustness ──
ok(parseOTIO('').events.length === 0, 'empty string → 0 events, no throw');
ok(parseOTIO('{bad json').events.length === 0, 'bad JSON → 0 events, no throw');
ok(Array.isArray(parseOTIO({}).events), 'empty object → events array, no throw');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
