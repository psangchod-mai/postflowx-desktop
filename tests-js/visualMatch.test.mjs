// Visual-fallback OCF relink candidate picker. Run: node tests-js/visualMatch.test.mjs
import { pickVisualMatch } from '../src/scripts/features/vfxPull/referenceMatchEngine.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

// Clear winner: high score and a wide margin → confident.
{
  const p = pickVisualMatch([{ index: 0, score: 42, label: 'A' }, { index: 1, score: 88, label: 'B' }, { index: 2, score: 30, label: 'C' }]);
  ok(p.confident, 'clear winner → confident');
  ok(p.best.index === 1, 'best is the highest score (B)');
  ok(p.ranked[0].score === 88 && p.ranked[1].score === 42, 'ranked sorted desc');
}

// Ambiguous: two candidates within the margin → not confident.
{
  const p = pickVisualMatch([{ index: 0, score: 82, label: 'A' }, { index: 1, score: 78, label: 'B' }]);
  ok(!p.confident, 'tie within margin → not confident');
  ok(/Ambiguous/.test(p.reason), 'reason explains the ambiguity');
}

// Below minimum score → not confident even if it's the top.
{
  const p = pickVisualMatch([{ index: 0, score: 45, label: 'A' }, { index: 1, score: 10, label: 'B' }]);
  ok(!p.confident && p.best.index === 0, 'low top score → not confident but still reported');
  ok(/need ≥/.test(p.reason), 'reason cites the score threshold');
}

// Single strong candidate (no runner-up) → confident.
{
  const p = pickVisualMatch([{ index: 3, score: 91, label: 'solo' }]);
  ok(p.confident && p.runnerUp === null, 'single strong candidate → confident, no runner-up');
}

// Custom thresholds respected.
{
  const p = pickVisualMatch([{ index: 0, score: 70 }, { index: 1, score: 66 }], { minScore: 50, minMargin: 3 });
  ok(p.confident, 'margin 4 ≥ custom minMargin 3 → confident');
}

// Empty / invalid input → graceful.
{
  const p = pickVisualMatch([]);
  ok(!p.confident && p.best === null, 'no candidates → not confident, best null');
  const q = pickVisualMatch([{ index: 0, score: 'x' }, { index: 1 }]);
  ok(!q.confident && q.best === null, 'non-numeric scores filtered out');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
