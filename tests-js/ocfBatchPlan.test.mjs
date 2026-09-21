// OCF preview batch-render planner (B perf). Run: node tests-js/ocfBatchPlan.test.mjs
import { planOcfBatchRender, batchRenderSavings } from '../src/scripts/features/vfxPull/ocfBatchPlan.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

// Typical 7-frame strip: HdlSt..HdlEnd around a 100-frame shot with 8f handles.
const POS = [
  { label: 'HdlSt',  absF: 992 },
  { label: 'In',     absF: 1000 },
  { label: '25%',    absF: 1025 },
  { label: '50%',    absF: 1050 },
  { label: '75%',    absF: 1075 },
  { label: 'Out',    absF: 1100 },
  { label: 'HdlEnd', absF: 1108 },
];
const plan = planOcfBatchRender(POS);
eq(plan.renderStart, 992, 'renderStart = min absF');
eq(plan.renderEnd, 1108, 'renderEnd = max absF');
eq(plan.frameCount, 117, 'frameCount = end - start + 1');
eq(plan.picks.length, 7, 'one pick per position');
eq(plan.picks[0].offset, 0, 'HdlSt offset 0');
eq(plan.picks[1].offset, 8, 'In offset = 1000-992');
eq(plan.picks[3].offset, 58, '50% offset = 1050-992');
eq(plan.picks[6].offset, 116, 'HdlEnd offset = 1108-992');
ok(plan.picks.every(p => p.offset >= 0 && p.offset < plan.frameCount), 'all offsets within the rendered range');

// ── handle reaches before frame 0 → clamp renderStart to 0 ──
const clamped = planOcfBatchRender([{ label: 'HdlSt', absF: -5 }, { label: 'In', absF: 0 }, { label: 'Out', absF: 20 }]);
eq(clamped.renderStart, 0, 'negative handle clamps renderStart to 0');
eq(clamped.picks[0].offset, 0, 'pre-clip HdlSt clamps to offset 0');
eq(clamped.picks[2].offset, 20, 'Out offset still correct');

// ── edge cases ──
eq(planOcfBatchRender([]), null, 'empty → null');
eq(planOcfBatchRender(null), null, 'null → null');
const single = planOcfBatchRender([{ label: 'In', absF: 500 }]);
eq(single.frameCount, 1, 'single position → 1-frame render');
eq(single.picks[0].offset, 0, 'single position offset 0');
// non-finite entries ignored
eq(planOcfBatchRender([{ label: 'x', absF: NaN }, { label: 'In', absF: 10 }]).picks.length, 1, 'non-finite absF dropped');

// ── savings ──
eq(batchRenderSavings(7), 6, '7 positions → 6 renders saved');
eq(batchRenderSavings(1), 0, '1 position → 0 saved');
eq(batchRenderSavings(0), 0, '0 → 0');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
