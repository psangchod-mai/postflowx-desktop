// Integration tests for conform-correctness wiring (#1 retime match, #2 transition pull).
// Exercises the REAL matcher + planner. Run: node tests-js/conformWiring.test.mjs
import { matchOcfToEvent } from '../src/scripts/smart/smartOcfMatcher.js';
import { buildExrJob }     from '../src/scripts/smart/smartExrPullPlanner.js';

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('PASS -', label); }
  else { failed++; console.error('FAIL -', label); }
}
const frameCount = (j) => j.expectedRenderedFrameCount ?? j.expectedFrameCount ?? j.frameCount;
const handlesOf  = (j) => j.handleFrames ?? j.handles;

// ── #1: retimed EDL events now drive OCF matching (speedFactor was ignored) ──
const ocf = {
  reel: 'A001', tcIn: '01:00:00:00', tcOut: '01:00:30:00',
  tcKnown: true, fps: 24, name: 'A001.mxf', path: '/cam/A001.mxf',
};
{
  // EDL parser sets speedFactor (NOT speedPercent) — the field the matcher used to ignore.
  const retimed = { reel: 'A001', srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 24, speedFactor: 50 };
  const r = matchOcfToEvent(ocf, retimed, {});
  ok(r.reasons.some(x => /retime\s*50%/i.test(x)),
    '#1 retimed event (speedFactor:50) triggers TC compensation in the matcher');
}
{
  const normal = { reel: 'A001', srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 24 };
  const r = matchOcfToEvent(ocf, normal, {});
  ok(!r.reasons.some(x => /retime/i.test(x)), 'control: non-retimed event has no retime note');
}

// ── #2: dissolves auto-extend the pulled source range ──
const baseEvent = { srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 24 }; // 96f segment
const cfg = { handleFrames: 8, outputBasePath: '/tmp' };
{
  const cut = buildExrJob({ event: { ...baseEvent }, marker: {}, matchResult: {}, config: cfg, projectMeta: {} });
  const dis = buildExrJob({ event: { ...baseEvent, transition: 'D024' }, marker: {}, matchResult: {}, config: cfg, projectMeta: {} });
  ok(frameCount(cut) === 113, `cut pull = 96 + 8+8 + 1 = 113f (got ${frameCount(cut)})`);
  ok(frameCount(dis) === frameCount(cut) + 48, `#2 dissolve D024 adds 24f head + 24f tail = +48f (got +${frameCount(dis) - frameCount(cut)})`);
  ok(handlesOf(dis) === 32, `#2 effective handles = base 8 + transition 24 = 32 (got ${handlesOf(dis)})`);
  ok(handlesOf(cut) === 8, 'cut keeps base handles (no transition)');
}
{
  // Wipe transition also counts
  const wipe = buildExrJob({ event: { ...baseEvent, transition: 'W012' }, marker: {}, matchResult: {}, config: cfg, projectMeta: {} });
  ok(handlesOf(wipe) === 20, `wipe W012 → base 8 + 12 = 20 handles (got ${handlesOf(wipe)})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
