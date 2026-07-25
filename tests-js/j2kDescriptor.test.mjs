// Descriptor-level JPEG 2000 / HTJ2K classification, and the wiring that
// carries it to the operator.
// Run: node tests-js/j2kDescriptor.test.mjs
//
// The defect this covers: imf_parser.js computed `isHTJ2K = isJ2K || …`, so
// every classic Part 1 IMP was labelled HTJ2K — and three branches written for
// plain J2K (the codec string, the J2K badge, the validator's PASS) were
// unreachable. Nothing in tests-js/ mentioned HTJ2K before this file, which is
// why it survived.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyJ2KDescriptor, HTJ2K_PEC_UL_FRAGMENTS,
} from '../src/scripts/modules/imf/j2kCodestream.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

// ── the core rule: J2K is not evidence of Part 15 ──
// This is the whole bug in one assertion. A classic Part 1 essence carries a
// JPEG2000SubDescriptor and nothing else; it must not read as HTJ2K.
{
  const c = classifyJ2KDescriptor({ hasJ2KSubDescriptor: true, pecUL: '' });
  eq(c.isJ2K, true, 'a JPEG2000SubDescriptor makes it JPEG 2000');
  eq(c.isHTJ2K, false, 'being JPEG 2000 is not evidence of Part 15');
  eq(c.htEvidence, null, 'and no evidence is reported');
}

// ── HTJ2K is a positive finding, and says which signal carried it ──
{
  const c = classifyJ2KDescriptor({ hasJ2KSubDescriptor: true, hasExtendedCapabilities: true, pecUL: '' });
  eq(c.isHTJ2K, true, 'J2KExtendedCapabilities declares Part 15');
  eq(c.htEvidence, 'extended-capabilities', 'the strong signal is named');
  eq(c.isJ2K, true, 'still JPEG 2000');
}
// The element only exists to carry the CAP segment a Part 1 stream cannot have,
// so it is sufficient on its own — a descriptor may omit the sub-descriptor.
eq(classifyJ2KDescriptor({ hasExtendedCapabilities: true }).isJ2K, true,
   'HT evidence implies JPEG 2000 even with no sub-descriptor present');

// ── the UL fallback is weaker, and is reported as such ──
eq(HTJ2K_PEC_UL_FRAGMENTS.length, 1, 'exactly one inherited UL fragment is trusted');
{
  const ul = `060e2b34.0401010d.${HTJ2K_PEC_UL_FRAGMENTS[0]}.01000000`;
  const c = classifyJ2KDescriptor({ hasJ2KSubDescriptor: true, pecUL: ul });
  eq(c.isHTJ2K, true, 'a Part 15 UL fragment declares HTJ2K');
  eq(c.htEvidence, 'pec-ul', 'reported as the weaker signal, not flattened into one boolean');
}
// Case is not a signal. CPLs are written by many tools.
eq(classifyJ2KDescriptor({ pecUL: HTJ2K_PEC_UL_FRAGMENTS[0].toUpperCase() }).isHTJ2K, true,
   'UL matching is case-insensitive');
// The descriptor element outranks the UL when both are present.
eq(classifyJ2KDescriptor({ hasExtendedCapabilities: true, pecUL: HTJ2K_PEC_UL_FRAGMENTS[0] }).htEvidence,
   'extended-capabilities', 'the stronger signal wins when both are present');

// ── the generic JPEG 2000 label must not read as Part 15 ──
// This UL was in the HT fragment list. A classic essence declaring the generic
// coding label was reported as HTJ2K, which is the false positive that put the
// wrong decoder name in the status bar.
{
  const generic = '060e2b34.0401010d.04010202.03010000';
  const c = classifyJ2KDescriptor({ hasJ2KSubDescriptor: true, pecUL: generic });
  eq(c.isHTJ2K, false, 'the generic JPEG 2000 coding label is not a Part 15 declaration');
  eq(c.isJ2K, true, 'but it is still JPEG 2000');
}
ok(!HTJ2K_PEC_UL_FRAGMENTS.some(f => f.includes('03010000')),
   'no trailing-zero generic label sits in the HT fragment list');

// ── nothing at all ──
for (const empty of [null, undefined, {}, { pecUL: '' }, { pecUL: null }]) {
  const c = classifyJ2KDescriptor(empty);
  eq(c.isJ2K, false, `${JSON.stringify(empty)} → not JPEG 2000`);
  eq(c.isHTJ2K, false, `${JSON.stringify(empty)} → not HTJ2K`);
}
// A non-J2K picture descriptor (RGBA, CDCI) reaches here with a UL that matches
// nothing; it must not be dragged into the J2K family.
eq(classifyJ2KDescriptor({ pecUL: '060e2b34.0401010d.04010202.71000000' }).isJ2K, false,
   'an unrelated coding UL alone does not make it JPEG 2000');

// ── isHTJ2K is exactly htEvidence !== null, with no third state ──
for (const sig of [
  { hasJ2KSubDescriptor: true },
  { hasExtendedCapabilities: true },
  { pecUL: HTJ2K_PEC_UL_FRAGMENTS[0] },
  {},
]) {
  const c = classifyJ2KDescriptor(sig);
  eq(c.isHTJ2K, c.htEvidence !== null,
     `flag and evidence agree for ${JSON.stringify(sig)}`);
}

// ── the parser must use this module, not re-derive ──
{
  const p = read('src/scripts/modules/imf/imf_parser.js');
  ok(/import \{ classifyJ2KDescriptor \} from '\.\/j2kCodestream\.js'/.test(p),
     'imf_parser imports the shared classifier');
  ok(!/isHTJ2K\s*=\s*isJ2K\s*\|\|/.test(p),
     'the `isHTJ2K = isJ2K || …` derivation is gone');
  ok(!/ContainerConstraintsSubDescriptor'\)/.test(p),
     'ST 379-2 container constraints no longer count as evidence of JPEG 2000');
  // The old flag was load-bearing for picture detection: narrowing HT without
  // this line would drop a J2K descriptor with unparsed dimensions out of the
  // running for primary picture descriptor.
  ok(/const isPicture = isRGBA \|\| isCDCI \|\| isJ2K \|\|/.test(p),
     'picture detection keys off isJ2K, not the narrowed HT flag');
}

// ── the primary picture descriptor must actually leave the parser ──
// It was computed, used internally, and never returned, so five call sites read
// undefined. Fixing the label without exporting it would have left them dark;
// exporting it without fixing the label would have spread the wrong label.
{
  const p = read('src/scripts/modules/imf/imf_parser.js');
  const ret = p.slice(p.lastIndexOf('  return {'));
  ok(/^\s*picDesc,\s*$/m.test(ret), 'parseCPL returns picDesc');
  ok(/^\s*isHTJ2K:\s+!!picDesc\.isHTJ2K,/m.test(ret), 'and the HT flag at the top level');
  ok(/^\s*htEvidence:\s+picDesc\.htEvidence \|\| null,/m.test(ret), 'and which signal carried it');
}
{
  // The consumers that had been reading undefined. Guarded here so a future
  // refactor that drops picDesc again fails a test instead of silently
  // switching two HUD readouts back off.
  const e = read('src/scripts/modules/imf/imf_player_engine.js');
  ok(/cpl\?\.picDesc\?\.isHTJ2K/.test(e),
     'the engine still reads picDesc for its HTJ2K status/limitations');
  const u = read('src/scripts/modules/imf/imf_ui.js');
  ok(/const pd\s*=\s*cpl\.picDesc \|\| \{\}/.test(u),
     'the status bar reads picDesc for the decoder line');
}

// ── the validator must read the flags, not its own display string ──
{
  const v = read('src/scripts/modules/imf/imf_validator.js');
  const blk = v.slice(v.indexOf("if (cpl.codec && cpl.codec !== '–')"), v.indexOf("'PIC004'") + 400);
  ok(/const isHTJ2K = !!cpl\.isHTJ2K/.test(blk),
     'PIC004 severity comes from the parsed flag');
  ok(!/cpl\.codec\.includes\('HTJ2K'\)/.test(v),
     'no substring-matching of the codec label decides severity any more');
  ok(/cpl\.htEvidence === 'pec-ul'/.test(blk),
     'UL-only evidence gets a different, weaker note than a descriptor declaration');
  ok(/isHTJ2K \? SEV\.INFO : isJ2K \? SEV\.PASS/.test(blk),
     'the PASS arm for classic J2K is still there — and is now reachable');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
