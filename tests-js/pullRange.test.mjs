// Conform-correctness tests — exercises the REAL pullRange.js math.
// Run: node tests-js/pullRange.test.mjs
import {
  normalizeSpeedPercent, readSpeedPercent, parseTransitionFrames, computePullRange, sourceTcAtRecord,
  sourceFrameAtRecord,
} from '../src/scripts/modules/pullRange.js';

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('PASS -', label); }
  else { failed++; console.error('FAIL -', label); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// ── normalizeSpeedPercent ──
eq(normalizeSpeedPercent(150), 150, 'percent passes through');
eq(normalizeSpeedPercent(50), 50, 'percent 50 passes through');
eq(normalizeSpeedPercent(0.5), 50, 'ratio 0.5 → 50%');
eq(normalizeSpeedPercent(1.5), 150, 'ratio 1.5 → 150%');
eq(normalizeSpeedPercent(0), 100, 'zero → 100% (no-op)');
eq(normalizeSpeedPercent(undefined), 100, 'missing → 100%');

// ── readSpeedPercent: the field-mismatch bug ──
eq(readSpeedPercent({ speedFactor: 50 }), 50, 'reads speedFactor (EDL field the matcher used to ignore)');
eq(readSpeedPercent({ speed: 150 }), 150, 'reads speed');
eq(readSpeedPercent({ speedPercent: 200 }), 200, 'reads speedPercent');
eq(readSpeedPercent({}), null, 'no speed field → null (retime skipped)');

// ── parseTransitionFrames ──
eq(parseTransitionFrames('D025'), 25, 'dissolve D025 → 25f');
eq(parseTransitionFrames('W012'), 12, 'wipe W012 → 12f');
eq(parseTransitionFrames('C'), 0, 'cut → 0f');
eq(parseTransitionFrames(''), 0, 'empty → 0f');
eq(parseTransitionFrames('D 024'), 24, 'spaced "D 024" → 24f');

// ── computePullRange: retime ──
{
  // 50% slow-mo: timeline 4s (96f@24) → native source 8s (192f)
  const r = computePullRange({ srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 24, speedFactor: 50 });
  eq(r.srcOutTc, '01:00:08:00', '50% slow-mo extends source out 4s→8s');
  eq(r.srcInTc, '01:00:00:00', 'slow-mo keeps srcIn anchor');
}
{
  // 200% undercrank: timeline 4s (96f) → native 2s (48f)
  const r = computePullRange({ srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 24, speed: 200 });
  eq(r.srcOutTc, '01:00:02:00', '200% undercrank shrinks source out 4s→2s');
}
{
  // No speed field → no change (and this is exactly what was broken before)
  const r = computePullRange({ srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 24 });
  eq(r.srcOutTc, '01:00:04:00', '100%/none → source out unchanged');
}
{
  // Dynamic retime → don't fabricate a precise range; note it
  const r = computePullRange({ srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 24, speedKeys: [{}, {}] });
  eq(r.dynamicRetime, true, 'dynamic retime flagged');
  ok(r.notes.some(n => /dynamic retime/i.test(n)), 'dynamic retime adds a verify note');
}

// ── computePullRange: per-event frame rate ──
{
  // Same TC string at 25fps vs 24fps yields different frame counts
  const r24 = computePullRange({ srcIn: '00:00:10:00', srcOut: '00:00:11:00', fps: 24 });
  const r25 = computePullRange({ srcIn: '00:00:10:00', srcOut: '00:00:11:00', fps: 25 });
  eq(r24.srcInFrames, 240, '10s @24 = 240f');
  eq(r25.srcInFrames, 250, '10s @25 = 250f (per-event fps honored)');
}

// ── computePullRange: transition + handles ──
{
  // dissolve D024 auto-adds 24f handles head & tail
  const r = computePullRange({ srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 24, transition: 'D024' });
  eq(r.handleHead, 24, 'transition adds 24f head handle');
  eq(r.handleTail, 24, 'transition adds 24f tail handle');
  eq(r.pullInTc, '00:59:59:00', 'pull-in extends 24f before srcIn for the dissolve');
  eq(r.pullOutTc, '01:00:05:00', 'pull-out extends 24f past srcOut for the dissolve');
}
{
  // configurable handles compose with transition
  const r = computePullRange(
    { srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 24, transition: 'D024' },
    { handleHead: 8, handleTail: 8 });
  eq(r.handleHead, 32, '8f handle + 24f transition = 32f head');
  eq(r.pullInTc, '00:59:58:16', 'pull-in = srcIn - 32f');
}
{
  // pull-in clamps at zero (never negative)
  const r = computePullRange({ srcIn: '00:00:00:05', srcOut: '00:00:01:00', fps: 24 }, { handleHead: 24 });
  eq(r.pullInFrames, 0, 'pull-in clamps to 0 (no negative source)');
}

// ── retime + transition combined ──
{
  const r = computePullRange(
    { srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 24, speedFactor: 50, transition: 'D012' });
  eq(r.srcOutTc, '01:00:08:00', 'retime applied to source out');
  eq(r.pullOutTc, '01:00:08:12', 'then transition handle (+12f) on the retimed out');
}

// ── sourceTcAtRecord: regression-safe per-event source burn-in ──
{
  // Same fps → identical to the legacy single-fps formula:
  //   framesToTC(recordFrame + (srcInF - recInF), fps)
  // 24p clip in 24p timeline: recIn 01:00:00:00, srcIn 10:00:00:00, playhead +48f
  const rf = 24 * 3600 + 48; // 01:00:02:00 in timeline frames @24
  const r = sourceTcAtRecord({ srcIn: '10:00:00:00', recIn: '01:00:00:00', recordFrame: rf, sourceFps: 24, timelineFps: 24 });
  eq(r, '10:00:02:00', 'same-fps source burn-in = srcIn + playhead offset (regression-safe)');
}
{
  // 30p clip in a 24p timeline: source TC must use 30-frame digits.
  // recordFrame = 24*3600 + 30 (01:00:01:06 @24 timeline); offset into clip = 30 frames.
  const rf = 24 * 3600 + 30;
  const r = sourceTcAtRecord({ srcIn: '10:00:00:00', recIn: '01:00:00:00', recordFrame: rf, sourceFps: 30, timelineFps: 24 });
  // srcInF(@30)=10*3600*30=1080000; +30 -recInF(@24=86400) ... recordFrame-recInF=30 → 1080030 → @30 = 10:00:01:00
  eq(r, '10:00:01:00', '30p clip in 24p timeline: source TC formatted at 30fps');
}

// ── sourceFrameAtRecord (speed-aware record→native source mapping) ──
// 100% == 1:1 (regression-safe, identical to the old srcInF + (recF - recInF)).
eq(sourceFrameAtRecord({ srcInF: 1000, recInF: 100, recordFrame: 100, speedPercent: 100 }), 1000, 'speed 100% at in-point → srcIn');
eq(sourceFrameAtRecord({ srcInF: 1000, recInF: 100, recordFrame: 150, speedPercent: 100 }), 1050, 'speed 100% +50 rec → +50 src (1:1)');
eq(sourceFrameAtRecord({ srcInF: 1000, recInF: 100, recordFrame: 150, speedPercent: undefined }), 1050, 'missing speed → 1:1');
eq(sourceFrameAtRecord({ srcInF: 1000, recInF: 100, recordFrame: 150, speedPercent: 0 }), 1050, 'zero speed → 1:1 (no-op)');
// 200% (2×): source advances twice as fast as record.
eq(sourceFrameAtRecord({ srcInF: 1000, recInF: 100, recordFrame: 150, speedPercent: 200 }), 1100, 'speed 200%: +50 rec → +100 src');
// 50% (half): source advances half as fast.
eq(sourceFrameAtRecord({ srcInF: 1000, recInF: 100, recordFrame: 200, speedPercent: 50 }), 1050, 'speed 50%: +100 rec → +50 src');
// 1608% overcrank (the reported shot): +10 rec frames → +161 native source frames.
eq(sourceFrameAtRecord({ srcInF: 1000, recInF: 100, recordFrame: 110, speedPercent: 1608 }), 1161, 'speed 1608%: +10 rec → +161 src');
// In-point always maps to srcIn regardless of speed (so HdlSt/In line up).
eq(sourceFrameAtRecord({ srcInF: 5000, recInF: 300, recordFrame: 300, speedPercent: 1608 }), 5000, 'retimed in-point still maps to srcIn');
// Never negative.
eq(sourceFrameAtRecord({ srcInF: 10, recInF: 100, recordFrame: 0, speedPercent: 200 }), 0, 'clamped to >= 0');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
