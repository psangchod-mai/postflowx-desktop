// P1-TTML: TTML / IMSC subtitle validation. Run: node tests-js/imfTtml.test.mjs
import { validateTTML, SEV } from '../src/scripts/modules/imf/imf_validator.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
const byCode = (rs, code) => rs.find(r => r.code === code);
const sevOf = (rs, code) => byCode(rs, code)?.sev;

const CONFORMANT = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml"
    xmlns:ttp="http://www.w3.org/ns/ttml#parameter"
    xml:lang="en" ttp:timeBase="media" ttp:frameRate="24">
  <head>
    <styling><style xml:id="s1" tts:color="white"/></styling>
    <layout><region xml:id="bottom"/></layout>
  </head>
  <body>
    <div>
      <p region="bottom" style="s1" begin="00:00:01.000" end="00:00:03.000">Hello</p>
      <p region="bottom" begin="00:00:04.000" end="00:00:06.000">World</p>
    </div>
  </body>
</tt>`;

// ── Conformant IMSC → all PASS ──
{
  const r = validateTTML(CONFORMANT, { file: 'subs_en.xml' });
  ok(sevOf(r, 'TT001') === SEV.PASS, 'TT001 PASS — <tt> root');
  ok(sevOf(r, 'TT002') === SEV.PASS, 'TT002 PASS — xml:lang present');
  ok(sevOf(r, 'TT003') === SEV.PASS, 'TT003 PASS — timing model declared');
  ok(sevOf(r, 'TT004') === SEV.PASS, 'TT004 PASS — region/style resolve');
  ok(sevOf(r, 'TT005') === SEV.PASS, 'TT005 PASS — consistent timing');
  ok(!r.some(x => x.sev === SEV.FAIL), 'conformant TTML → no FAIL');
}

// ── Wrong root → TT001 FAIL ──
{
  const r = validateTTML('<notTT xml:lang="en"></notTT>');
  ok(sevOf(r, 'TT001') === SEV.FAIL, 'TT001 FAIL — wrong root');
}

// ── Missing xml:lang → TT002 FAIL ──
{
  const bad = CONFORMANT.replace(' xml:lang="en"', '');
  const r = validateTTML(bad);
  ok(sevOf(r, 'TT002') === SEV.FAIL, 'TT002 FAIL — no xml:lang');
}

// ── Frame-based timing without frameRate → TT003 FAIL ──
{
  const bad = `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en">
    <head><layout><region xml:id="r"/></layout></head>
    <body><div><p region="r" begin="10f" end="40f">X</p></div></body></tt>`;
  const r = validateTTML(bad);
  ok(sevOf(r, 'TT003') === SEV.FAIL, 'TT003 FAIL — frame offsets, no frameRate');
}

// ── Dangling region reference → TT004 FAIL ──
{
  const bad = CONFORMANT.replace('region="bottom"', 'region="ghost"');
  const r = validateTTML(bad);
  ok(sevOf(r, 'TT004') === SEV.FAIL, 'TT004 FAIL — undefined region ref');
  ok(byCode(r, 'TT004').detail.length > 0 || byCode(r, 'TT004').msg.includes('ghost'), 'TT004 names dangling ref');
}

// ── No body → TT004 FAIL ──
{
  const bad = `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en" ttp:frameRate="24"><head/></tt>`;
  const r = validateTTML(bad);
  ok(sevOf(r, 'TT004') === SEV.FAIL, 'TT004 FAIL — no body');
}

// ── end before begin → TT005 FAIL ──
{
  const bad = CONFORMANT.replace('begin="00:00:01.000" end="00:00:03.000"', 'begin="00:00:05.000" end="00:00:02.000"');
  const r = validateTTML(bad);
  ok(sevOf(r, 'TT005') === SEV.FAIL, 'TT005 FAIL — end < begin');
}

// ── Robustness: empty → [] no throw ──
{
  ok(validateTTML('').length === 0, 'empty TTML → [] no throw');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
