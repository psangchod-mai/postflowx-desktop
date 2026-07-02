// P1-OPL: OutputProfileList semantic validation. Run: node tests-js/imfOpl.test.mjs
import { validateOPL, SEV } from '../src/scripts/modules/imf/imf_validator.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
const byCode = (rs, code) => rs.find(r => r.code === code);
const sevOf = (rs, code) => byCode(rs, code)?.sev;

const CPL_ID = 'urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const CONFORMANT = `<?xml version="1.0"?>
<opl:OutputProfileList xmlns:opl="http://www.smpte-ra.org/schemas/2067-100/2016">
  <opl:Id>urn:uuid:11111111-2222-3333-4444-555555555555</opl:Id>
  <opl:CompositionPlaylistId>${CPL_ID}</opl:CompositionPlaylistId>
  <opl:AliasList>
    <opl:Alias handle="src">cpl:MainImage</opl:Alias>
    <opl:Alias handle="toned"/>
  </opl:AliasList>
  <opl:MacroList>
    <opl:Macro name="colour-transform">
      <opl:InputList><opl:Handle>src</opl:Handle></opl:InputList>
      <opl:OutputList><opl:Handle>toned</opl:Handle></opl:OutputList>
      <opl:ScaleFactor>1 1</opl:ScaleFactor>
    </opl:Macro>
    <opl:Macro name="downscale">
      <opl:InputList><opl:Handle>toned</opl:Handle></opl:InputList>
      <opl:OutputList><opl:Handle>out</opl:Handle></opl:OutputList>
      <opl:Scale>0.5</opl:Scale>
    </opl:Macro>
  </opl:MacroList>
</opl:OutputProfileList>`;

// ── Conformant OPL → all PASS ──
{
  const r = validateOPL(CONFORMANT, { cplId: CPL_ID });
  ok(sevOf(r, 'OPL001') === SEV.PASS, 'OPL001 PASS — valid urn:uuid Id');
  ok(sevOf(r, 'OPL002') === SEV.PASS, 'OPL002 PASS — CPL reference resolves');
  ok(sevOf(r, 'OPL003') === SEV.PASS, 'OPL003 PASS — named macros');
  ok(sevOf(r, 'OPL004') === SEV.PASS, 'OPL004 PASS — handles resolve');
  ok(sevOf(r, 'OPL005') === SEV.PASS, 'OPL005 PASS — scales/aliases sane');
  ok(!r.some(x => x.sev === SEV.FAIL), 'conformant OPL → no FAIL');
}

// ── Missing Id → OPL001 FAIL ──
{
  const bad = CONFORMANT.replace(/<opl:Id>.*<\/opl:Id>/, '');
  const r = validateOPL(bad, { cplId: CPL_ID });
  ok(sevOf(r, 'OPL001') === SEV.FAIL, 'OPL001 FAIL — no Id');
}

// ── CPL reference does not resolve → OPL002 FAIL ──
{
  const r = validateOPL(CONFORMANT, { cplId: 'urn:uuid:99999999-0000-0000-0000-000000000000' });
  ok(sevOf(r, 'OPL002') === SEV.FAIL, 'OPL002 FAIL — CPL id mismatch');
  ok(byCode(r, 'OPL002').remediation, 'OPL002 carries a remediation hint');
  ok(byCode(r, 'OPL002').resourceRef?.kind === 'opl', 'OPL002 resourceRef points at opl');
}

// ── Missing CPL reference → OPL002 FAIL ──
{
  const bad = CONFORMANT.replace(/<opl:CompositionPlaylistId>.*<\/opl:CompositionPlaylistId>/, '');
  const r = validateOPL(bad);
  ok(sevOf(r, 'OPL002') === SEV.FAIL, 'OPL002 FAIL — no CompositionPlaylistId');
}

// ── Empty MacroList → OPL003 WARN ──
{
  const bad = CONFORMANT.replace(/<opl:MacroList>[\s\S]*<\/opl:MacroList>/, '<opl:MacroList></opl:MacroList>');
  const r = validateOPL(bad, { cplId: CPL_ID });
  ok(sevOf(r, 'OPL003') === SEV.WARN, 'OPL003 WARN — empty MacroList');
}

// ── Dangling input handle → OPL004 FAIL ──
{
  const bad = CONFORMANT.replace('<opl:Handle>src</opl:Handle>', '<opl:Handle>ghost</opl:Handle>');
  const r = validateOPL(bad, { cplId: CPL_ID });
  ok(sevOf(r, 'OPL004') === SEV.FAIL, 'OPL004 FAIL — dangling handle');
  ok(byCode(r, 'OPL004').detail.includes('ghost'), 'OPL004 names the dangling handle');
}

// ── Bad scale value → OPL005 FAIL ──
{
  const bad = CONFORMANT.replace('<opl:Scale>0.5</opl:Scale>', '<opl:Scale>-3</opl:Scale>');
  const r = validateOPL(bad, { cplId: CPL_ID });
  ok(sevOf(r, 'OPL005') === SEV.FAIL, 'OPL005 FAIL — negative scale');
}

// ── Robustness: empty / wrong-root → [] no throw ──
{
  ok(validateOPL('').length === 0, 'empty OPL → [] no throw');
  ok(validateOPL('<Foo/>').length === 0, 'wrong-root OPL → [] (schema handles root)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
