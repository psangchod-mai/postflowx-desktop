// ocfIdtResolver Canon C-Log2 vs C-Log3 misclassification test.
// Run: node tests-js/ocfIdtResolverCanonLog.test.mjs
//
// _findBySearchStr returns on the first IDT_MAP entry whose match list hits.
// The Canon C-Log3 entry used to include a bare 'canon' vendor token, which
// short-circuited before the more specific clog2/clog3 tokens were checked —
// misclassifying any Canon C-Log2 (or even non-log Canon Rec.709) footage as
// C-Log3.
import { resolveIdtFromOCFMeta } from '../src/scripts/features/aceslook/services/ocfIdtResolver.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

{
  const result = resolveIdtFromOCFMeta({
    colorSpace: 'C-Log2',
    cameraFamily: 'Canon',
    codec: 'XF-AVC',
  });
  ok(result.colorSpaceLabel === 'Canon C-Log2 / Cinema Gamut',
    `Canon C-Log2 metadata resolves to the C-Log2 IDT, got "${result.colorSpaceLabel}"`);
}

{
  const result = resolveIdtFromOCFMeta({
    colorSpace: 'C-Log3',
    cameraFamily: 'Canon',
    codec: 'XF-AVC',
  });
  ok(result.colorSpaceLabel === 'Canon C-Log3 / Cinema Gamut',
    `Canon C-Log3 metadata still resolves to the C-Log3 IDT, got "${result.colorSpaceLabel}"`);
}

{
  // Non-log Canon footage with no clog2/clog3 marker must fall through to the
  // Rec.709 fallback, not be swept up by a generic vendor token.
  const result = resolveIdtFromOCFMeta({
    colorSpace: 'Rec.709',
    cameraType: 'Canon EOS R5 C',
    codec: 'H.264',
  });
  ok(result.colorSpaceLabel === 'Rec.709',
    `plain Canon Rec.709 footage resolves to Rec.709, got "${result.colorSpaceLabel}"`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
