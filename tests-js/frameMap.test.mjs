// Frame-map reverse + speed correctness. Run: node tests-js/frameMap.test.mjs
import { buildFrameMapCSV, buildFrameMapJSON } from '../src/scripts/features/vfxPull/pullJobModel.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

// Parse the CSV → array of sourceFrame ints (column index 3).
function srcFrames(csv) {
  return csv.trim().split('\n').slice(1).map(line => Number(line.split(',')[3]));
}

const baseJob = {
  frameStart: 1001, fps: 24, sourcePath: '/cam/A001.mxf',
  exportIn: '01:00:00:00', // srcStart = 86400 @24
};

// Pure reverse: 10 source frames played backward 1:1 → 86409..86400 (REGRESSION-SAFE)
{
  const job = { ...baseJob, expectedFrameCount: 10, expectedRenderedFrameCount: 10, frameCount: 10,
    retime: { reversed: true, hasSpeedChange: true, speed: 1.0, speedPercent: 100 } };
  const f = srcFrames(buildFrameMapCSV(job));
  ok(f.length === 10, 'pure reverse: 10 output frames');
  ok(f[0] === 86409 && f[9] === 86400, 'pure reverse walks source backward 86409→86400 (stride 1)');
}

// Reverse + 50%: source span 10, baked output 20 → must stay within 86400..86409 (not overshoot)
{
  const job = { ...baseJob, expectedFrameCount: 10, expectedRenderedFrameCount: 20, frameCount: 20,
    retime: { reversed: true, hasSpeedChange: true, speed: 0.5, speedPercent: 50 } };
  const f = srcFrames(buildFrameMapCSV(job));
  ok(f.length === 20, 'reverse+50%: 20 output frames (baked 2×)');
  ok(f[0] === 86409, 'reverse+50% starts at the last source frame (86409)');
  ok(Math.max(...f) <= 86409 && Math.min(...f) >= 86400,
    'reverse+50% stays IN-BOUNDS of the 10-frame source (was overshooting to ~86419 before the fix)');
  ok(f[19] <= 86401, 'reverse+50% ends back near the first source frame');
}

// Forward 50% (control — unchanged by the fix)
{
  const job = { ...baseJob, expectedFrameCount: 10, expectedRenderedFrameCount: 20, frameCount: 20,
    retime: { reversed: false, hasSpeedChange: true, speed: 0.5, speedPercent: 50 } };
  const f = srcFrames(buildFrameMapCSV(job));
  ok(f[0] === 86400 && f[19] <= 86410, 'forward 50% still advances from srcStart (control)');
}

// ── Gap 4: buildFrameMapJSON (schema + plate-local numbering + AE keyframes) ──

// Constant 50% from an explicit per-frame source map → plate-local frame_map.
{
  const job = { ...baseJob, expectedRenderedFrameCount: 4, frameCount: 4,
    retime: { hasSpeedChange: true, isDynamic: true, speedPercent: 50,
      sourceFrameMap: [
        { sourceFrame: 86400, speed: 100, retimeType: 'dynamic' },
        { sourceFrame: 86401, speed: 50,  retimeType: 'dynamic' },
        { sourceFrame: 86401, speed: 50,  retimeType: 'dynamic' },
        { sourceFrame: 86402, speed: 50,  retimeType: 'dynamic' },
      ] } };
  const j = buildFrameMapJSON(job, { frameStart: 1001, frameCount: 4, shotName: 'SQ010', plateName: 'SQ010_PL01_v001' });
  ok(j.shot.pull_mode === 'B' && j.shot.has_speed_change === true, 'speed change → pull_mode B');
  ok(j.shot.frame_map.length === 4, 'one frame_map entry per output frame');
  ok(j.shot.frame_map[0].out_frame === 1001 && j.shot.frame_map[0].src_frame === 1001,
    'first output frame maps to first plate frame (plate-local)');
  ok(j.shot.frame_map[3].src_frame === 1003, 'plate-local source advances 86400→86402 ⇒ 1001→1003');
  ok(j.shot.output_range.first_frame === 1001 && j.shot.output_range.last_frame === 1004, 'output_range covers the run');
  ok(j.shot.nuke_retime.node_type === 'TimeWarp' && j.shot.nuke_retime.source_frames[3] === 1003,
    'nuke_retime carries plate-local source frames');
  ok(j.shot.ae_time_remap.keyframes_seconds.length === 4 &&
     j.shot.ae_time_remap.keyframes_seconds[0].time_sec === 0, 'AE time-remap keyframes derived in seconds');
}

// No speed change → pull_mode A, normal 1:1 map.
{
  const job = { ...baseJob, expectedRenderedFrameCount: 3, frameCount: 3, retime: {} };
  const j = buildFrameMapJSON(job, { frameStart: 1001, frameCount: 3 });
  ok(j.shot.pull_mode === 'A' && j.shot.has_speed_change === false, 'no speed change → pull_mode A');
  ok(j.shot.frame_map.map(e => e.src_frame).join(',') === '1001,1002,1003', 'normal 1:1 plate-local map');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
