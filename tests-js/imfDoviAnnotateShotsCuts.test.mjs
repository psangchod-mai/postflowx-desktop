// annotateShots() isCut regression (Iteration 74). Run: node tests-js/imfDoviAnnotateShotsCuts.test.mjs
import { annotateShots } from '../src/scripts/modules/imf/imf_dovi_metafier.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

// DoVi CM XML Shot lists are contiguous by construction (no gaps between
// consecutive shots). A regression made isCut mirror gapBefore>0, so a
// perfectly contiguous 3-shot sequence with 2 real cuts reported 0.
{
  const shots = [
    { begin: 0, end: 99 },
    { begin: 100, end: 199 },
    { begin: 200, end: 299 },
  ];
  annotateShots(shots);

  ok(shots[0].isCut === false, 'first shot is never a cut');
  ok(shots[1].isCut === true, 'second shot (contiguous) is still a cut');
  ok(shots[2].isCut === true, 'third shot (contiguous) is still a cut');
  ok(shots.filter(s => s.isCut).length === 2, 'contiguous 3-shot sequence reports 2 cuts, not 0');

  ok(shots.every(s => s.gapBefore === 0), 'gapBefore stays 0 for contiguous shots (unrelated to isCut)');
}

// gapBefore must remain an independent anomaly signal, unaffected by the
// isCut redefinition, so consumers that check gapBefore directly still work.
{
  const shots = [
    { begin: 0, end: 99 },
    { begin: 150, end: 249 }, // 50-frame gap before this shot
  ];
  annotateShots(shots);

  ok(shots[1].isCut === true, 'shot after a gap is still flagged as a cut');
  ok(shots[1].gapBefore === 50, 'gapBefore reports the real frame gap independent of isCut');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
