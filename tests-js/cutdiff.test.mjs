// Cut-diff (OLD vs NEW timeline) classification. Run: node tests-js/cutdiff.test.mjs
import { computeCutDiff, summarizeDiff, DIFF_TYPES } from '../src/scripts/modules/cutdiff.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
const ev = (clip, reel, srcIn, srcOut) => ({ clipName: clip, reel, srcIn, srcOut, fps: 24 });
const typeOf = (diff, clip) => diff.find(d => d.clipName === clip)?.diffType;

// NEW — clip not present in OLD
{
  const d = computeCutDiff([ev('A', 'R1', '01:00:00:00', '01:00:04:00')],
                           [ev('B', 'R2', '02:00:00:00', '02:00:04:00')]);
  ok(typeOf(d, 'B') === DIFF_TYPES.NEW, 'NEW: clip absent from OLD → NEW');
}

// EXTENDED — same clip, NEW longer
{
  const d = computeCutDiff([ev('A', 'R1', '01:00:00:00', '01:00:04:00')],   // 96f
                           [ev('A', 'R1', '01:00:00:00', '01:00:06:00')]);  // 144f (+48)
  ok(typeOf(d, 'A') === DIFF_TYPES.EXTENDED, 'EXTENDED: NEW duration > OLD → EXTENDED');
}

// TRIMMED — same clip, NEW shorter
{
  const d = computeCutDiff([ev('A', 'R1', '01:00:00:00', '01:00:06:00')],   // 144f
                           [ev('A', 'R1', '01:00:00:00', '01:00:04:00')]);  // 96f (-48)
  ok(typeOf(d, 'A') === DIFF_TYPES.TRIMMED, 'TRIMMED: NEW duration < OLD → TRIMMED');
}

// CHANGED — same duration, different source in-point (re-cut / different take)
{
  const d = computeCutDiff([ev('A', 'R1', '01:00:00:00', '01:00:04:00')],   // src 01:00:00:00
                           [ev('A', 'R1', '01:00:10:00', '01:00:14:00')]);  // src +10s, same 96f
  ok(typeOf(d, 'A') === DIFF_TYPES.CHANGED, 'CHANGED: same duration, different source → CHANGED');
}

// UNCHANGED — hidden by default, shown with includeUnchanged
{
  const old = [ev('A', 'R1', '01:00:00:00', '01:00:04:00')];
  const neu = [ev('A', 'R1', '01:00:00:00', '01:00:04:00')];
  ok(computeCutDiff(old, neu).length === 0, 'UNCHANGED hidden by default');
  const d = computeCutDiff(old, neu, { includeUnchanged: true });
  ok(typeOf(d, 'A') === DIFF_TYPES.UNCHANGED, 'UNCHANGED shown with includeUnchanged');
}

// includeTrimmed:false suppresses TRIMMED
{
  const d = computeCutDiff([ev('A', 'R1', '01:00:00:00', '01:00:06:00')],
                           [ev('A', 'R1', '01:00:00:00', '01:00:04:00')], { includeTrimmed: false });
  ok(d.length === 0, 'includeTrimmed:false suppresses TRIMMED rows');
}

// Duration tolerance — a 1-frame diff (≤ durTol 2) is UNCHANGED, not EXTENDED
{
  const d = computeCutDiff([ev('A', 'R1', '01:00:00:00', '01:00:04:00')],     // 96f
                           [ev('A', 'R1', '01:00:00:00', '01:00:04:01')],     // 97f (+1)
                           { includeUnchanged: true });
  ok(typeOf(d, 'A') === DIFF_TYPES.UNCHANGED, '+1 frame within durTol → UNCHANGED (not EXTENDED)');
}

// Identity matching — same clipName different reel are NOT matched
{
  const d = computeCutDiff([ev('A', 'R1', '01:00:00:00', '01:00:04:00')],
                           [ev('A', 'R2', '01:00:00:00', '01:00:06:00')]);
  ok(typeOf(d, 'A') === DIFF_TYPES.NEW, 'same clipName + different reel → NEW (not EXTENDED)');
}

// Two takes of the same clip — both matched, not collapsed
{
  const old = [ev('A', 'R1', '01:00:00:00', '01:00:04:00'), ev('A', 'R1', '01:00:00:00', '01:00:04:00')];
  const neu = [ev('A', 'R1', '01:00:00:00', '01:00:06:00'), ev('A', 'R1', '01:00:00:00', '01:00:02:00')];
  const d = computeCutDiff(old, neu, { includeTrimmed: true });
  ok(d.length === 2, 'two takes of same clip → two diff rows (OLD entries consumed once each)');
}

// summarizeDiff tallies
{
  const d = computeCutDiff(
    [ev('A', 'R1', '01:00:00:00', '01:00:04:00'), ev('C', 'R3', '03:00:00:00', '03:00:08:00')],
    [ev('A', 'R1', '01:00:00:00', '01:00:06:00'), ev('B', 'R2', '02:00:00:00', '02:00:04:00')]);
  const s = summarizeDiff(d);
  ok(s.EXTENDED === 1 && s.NEW === 1, 'summary tallies 1 EXTENDED + 1 NEW');
}

// Robustness
ok(Array.isArray(computeCutDiff(null, null)), 'null inputs → array, no throw');
ok(computeCutDiff([], []).length === 0, 'empty inputs → empty diff');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
