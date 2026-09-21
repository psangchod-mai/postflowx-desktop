// IMF CPL/ASSETMAP XML primitives (namespace-agnostic). Run: node tests-js/imfXml.test.mjs
import imfXml from '../electron/imf/imf_xml.js';
const { getText, getAllBlocks, getFirstBlock, deepText, parseEditRate, normaliseUuid } = imfXml;

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function near(got, want, l) { ok(Math.abs(got - want) < 1e-6, `${l} (got ${got}, want ${want})`); }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

// ── parseEditRate (IMF "num den" or single) ──
near(parseEditRate('24000 1001'), 24000 / 1001, '24000 1001 → 23.976');
near(parseEditRate('30000 1001'), 30000 / 1001, '30000 1001 → 29.97');
eq(parseEditRate('24 1'), 24, '24 1 → 24');
eq(parseEditRate('25'), 25, 'single value 25 → 25');
ok(Number.isNaN(parseEditRate('')), 'empty → NaN');
ok(Number.isNaN(parseEditRate(null)), 'null → NaN');
ok(Number.isNaN(parseEditRate('24 0')), 'divide-by-zero (24 0) → NaN (guarded)');

// ── normaliseUuid ──
eq(normaliseUuid('urn:uuid:ABCD-1234'), 'abcd-1234', 'strips urn:uuid: + lowercases');
eq(normaliseUuid('URN:UUID:Ef'), 'ef', 'case-insensitive prefix strip');
eq(normaliseUuid('  PlainID  '), 'plainid', 'trims + lowercases plain id');
eq(normaliseUuid(''), '', 'empty → empty');

// ── Namespace-agnostic CPL parsing ──
const CPL = `<?xml version="1.0"?>
<r0:CompositionPlaylist xmlns:r0="...">
  <r0:Id>urn:uuid:AAAA-0001</r0:Id>
  <r0:EditRate>24000 1001</r0:EditRate>
  <r0:ContentTitleText>My IMF Title</r0:ContentTitleText>
  <r0:ReelList>
    <r0:Reel><r0:Id>urn:uuid:REEL-1</r0:Id></r0:Reel>
    <r0:Reel><r0:Id>urn:uuid:REEL-2</r0:Id></r0:Reel>
    <r0:Reel><r0:Id>urn:uuid:REEL-3</r0:Id></r0:Reel>
  </r0:ReelList>
</r0:CompositionPlaylist>`;

eq(getText(CPL, 'ContentTitleText'), 'My IMF Title', 'getText namespace-agnostic title');
eq(getText(CPL, 'EditRate'), '24000 1001', 'getText EditRate raw string');
near(parseEditRate(getText(CPL, 'EditRate')), 24000 / 1001, 'CPL EditRate → 23.976 (end-to-end)');
eq(getText(CPL, 'NonExistent'), '', 'getText missing tag → empty');

const reels = getAllBlocks(CPL, 'Reel');
eq(reels.length, 3, 'getAllBlocks finds all 3 Reels');
ok(getFirstBlock(CPL, 'Reel').includes('REEL-1'), 'getFirstBlock returns first Reel');
eq(normaliseUuid(getText(getFirstBlock(CPL, 'Reel'), 'Id')), 'reel-1', 'first reel Id normalised');

// CDATA handling
eq(getText('<Title><![CDATA[Quoted "Title"]]></Title>', 'Title'), 'Quoted "Title"', 'getText unwraps CDATA');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
