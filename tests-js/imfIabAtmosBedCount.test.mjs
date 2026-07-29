// extractAdmProgrammeTreeFromCompanion() isAtmos regression (Iteration 75).
// Run: node tests-js/imfIabAtmosBedCount.test.mjs
import { extractAdmProgrammeTreeFromCompanion } from '../src/scripts/modules/imf/imf_iab_labels.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

// objectCount/bedCount/is51 all OR the companion-summary bed count with the
// name-matched bedObjects fallback, but isAtmos only checked the summary
// count — so a pure 5.1-bed track whose companion metadata omitted
// objectSummary.bedObjects (0/absent) was wrongly flagged as Atmos, because
// the 6 bed-named objects were counted as non-bed "objects".
{
  const result = extractAdmProgrammeTreeFromCompanion({
    objectNames: ['L_bed', 'R_bed', 'C_bed', 'LFE_bed', 'Ls_bed', 'Rs_bed'],
    objectSummary: { totalObjects: 6 }, // bedObjects omitted/0
  });

  ok(result.objectCount === 0, 'objectCount is 0 (all 6 objects are bed-named)');
  ok(result.bedCount === 6, 'bedCount is 6 (from name-matched fallback)');
  ok(result.is51 === true, 'is51 is true');
  ok(result.isAtmos === false, 'a pure 5.1-bed track (no non-bed objects) is not flagged as Atmos');
}

// A genuine Atmos mix (bed + real dynamic objects) must still report isAtmos.
{
  const result = extractAdmProgrammeTreeFromCompanion({
    objectNames: ['L_bed', 'R_bed', 'C_bed', 'LFE_bed', 'Ls_bed', 'Rs_bed', 'Object_01', 'Object_02'],
    objectSummary: { totalObjects: 8 },
  });

  ok(result.objectCount === 2, 'objectCount counts the 2 non-bed dynamic objects');
  ok(result.isAtmos === true, 'a bed + dynamic-object mix is still flagged as Atmos');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
