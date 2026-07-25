// J2K codestream classification + decoder routing (C-RT2).
// Run: node tests-js/j2kCodestream.test.mjs
//
// The bug this locks down: decodeHTJ2K() had no sniff. It accepted any stream
// starting 0xFF4F (or 0xFF50, believed to be an "HTJ2K SOC" — no such marker
// exists) and handed it to OpenJPH, an HT-only decoder. Classic Part 1 IMF
// essence — the majority of real deliverables — therefore paid a full copy into
// the WASM heap plus a thrown exception on every single frame before falling
// through to the sandbox that could actually decode it. Meanwhile the sandbox
// held the only correct sniff in the codebase, and imf_player.js extracted the
// very Rsiz value needed to make the decision and never tested it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  sniffCodestream, isHTJ2KCodestream, MARKER, RSIZ_CAP_BIT,
} from '../src/scripts/modules/imf/j2kCodestream.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

// ── codestream builder ──
// SOC, then a SIZ segment with the given Rsiz, then optional extra segments.
// SIZ layout: FF51 Lsiz(2) Rsiz(2) Xsiz(4) Ysiz(4) XOsiz(4) YOsiz(4)
// XTsiz(4) YTsiz(4) XTOsiz(4) YTOsiz(4) Csiz(2) then Csiz×3 component bytes.
function be16(v) { return [(v >> 8) & 0xff, v & 0xff]; }
function be32(v) { return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]; }

function makeCodestream({ rsiz = 0, width = 1920, height = 1080, comps = 3, extra = [] } = {}) {
  const body = [
    ...be16(rsiz),
    ...be32(width), ...be32(height),
    ...be32(0), ...be32(0),
    ...be32(width), ...be32(height),
    ...be32(0), ...be32(0),
    ...be16(comps),
  ];
  for (let i = 0; i < comps; i++) body.push(0x09, 0x01, 0x01); // Ssiz(10-bit), XRsiz, YRsiz
  const lsiz = 2 + body.length;
  return new Uint8Array([
    ...be16(MARKER.SOC),
    ...be16(MARKER.SIZ), ...be16(lsiz), ...body,
    ...extra,
    ...be16(MARKER.EOC),
  ]);
}

// A CAP segment: FF50 Lcap(2) Pcap(4) Ccap(2). Part 15 sets Pcap bit 15.
const CAP_SEGMENT = [...be16(MARKER.CAP), ...be16(8), ...be32(1 << 15), ...be16(0)];

// ── classic Part 1 ──
{
  const s = sniffCodestream(makeCodestream({ rsiz: 0 }));
  eq(s.kind, 'j2k', 'Rsiz=0 → classic Part 1');
  eq(s.rsiz, 0, 'Rsiz read back');
  eq(s.markerOffset, 2, 'SIZ found immediately after SOC');
  eq(s.hasCap, false, 'no CAP segment');
  ok(!isHTJ2KCodestream(makeCodestream({ rsiz: 0 })), 'classic is not an HT codestream');
}
// Broadcast/IMF profile bits must not be mistaken for the capability bit.
for (const rsiz of [0x0001, 0x0002, 0x0003, 0x0004, 0x0100, 0x0102, 0x0400, 0x3FFF]) {
  eq(sniffCodestream(makeCodestream({ rsiz })).kind, 'j2k',
     `Rsiz=0x${rsiz.toString(16).padStart(4, '0')} (profile bits only) → classic`);
}

// ── HTJ2K Part 15 ──
// Rsiz values here are written as literals, NOT as RSIZ_CAP_BIT. Deriving the
// fixture from the constant under test makes the pair move together and the
// suite survives a wrong bit — verified by mutation.
eq(RSIZ_CAP_BIT, 0x4000, 'the capability bit is Rsiz bit 14 (ISO/IEC 15444-1 Amd. 8)');
{
  const s = sniffCodestream(makeCodestream({ rsiz: 0x4000, extra: CAP_SEGMENT }));
  eq(s.kind, 'htj2k', 'Rsiz=0x4000 → HTJ2K');
  eq(s.hasCap, true, 'CAP segment located after SIZ');
  ok(isHTJ2KCodestream(makeCodestream({ rsiz: 0x4000 })), 'HT codestream recognised');
}
eq(sniffCodestream(makeCodestream({ rsiz: 0x4004 })).kind, 'htj2k',
   'capability bit set alongside a profile → still HTJ2K');
// Bits above 14 are reserved; setting one must not be read as a capability.
eq(sniffCodestream(makeCodestream({ rsiz: 0x8000 })).kind, 'j2k',
   'Rsiz=0x8000 (reserved bit 15, not the capability bit) → classic');

// ── not a codestream: never guess a decoder ──
eq(sniffCodestream(new Uint8Array([0xFF, 0x50, 0, 0, 0, 0, 0, 0])).kind, 'unknown',
   '0xFF50 at offset 0 is CAP, not an SOC — not a codestream');
eq(sniffCodestream(new Uint8Array([0x00, 0x00, 0x00, 0x0C, 0x6A, 0x50, 0x20, 0x20])).kind, 'unknown',
   'JP2 container signature box (not a bare codestream) → unknown');
eq(sniffCodestream(new Uint8Array(0)).kind, 'unknown', 'empty → unknown');
eq(sniffCodestream(null).kind, 'unknown', 'null → unknown');
eq(sniffCodestream(new Uint8Array([0xFF, 0x4F])).kind, 'unknown', 'SOC alone (too short) → unknown');

// ── degenerate headers resolve conservatively, never to HT ──
// The classic rung has a pure-JS fallback behind it; the HT rung does not. So an
// unreadable header must land on classic, not on OpenJPH.
{
  const soConly = new Uint8Array(64); soConly[0] = 0xFF; soConly[1] = 0x4F;
  eq(sniffCodestream(soConly).kind, 'j2k', 'SOC with no SIZ → classic, not HT');
}
{
  // Zero-length segment: the length walk must bail out and the byte scan recover.
  const s = sniffCodestream(new Uint8Array([
    ...be16(MARKER.SOC), 0xFF, 0x64, 0x00, 0x00,
    ...be16(MARKER.SIZ), ...be16(41), ...be16(0x4000), ...new Array(37).fill(0),
  ]));
  eq(s.kind, 'htj2k', 'malformed segment length → byte-scan fallback still finds SIZ');
}

// ── the consumers must route through this module ──
// A sniff nothing calls is not a fix.
{
  const j2k = fs.readFileSync(path.join(root, 'src/scripts/modules/imf/imf_j2k.js'), 'utf8');
  ok(/import\s*\{[^}]*sniffCodestream[^}]*\}\s*from\s*['"]\.\/j2kCodestream\.js['"]/.test(j2k),
     'imf_j2k.js imports the shared sniff');
  ok(/sniff\.kind\s*===\s*'htj2k'/.test(j2k),
     'imf_j2k.js gates the direct OpenJPH path on kind === htj2k');
  ok(!/bytes\[1\]\s*!==\s*0x50/.test(j2k),
     'imf_j2k.js no longer treats 0xFF50 as an alternative SOC');
  // The regression in one line: the direct HT decoder must not be reachable
  // without the sniff having said htj2k.
  const direct = j2k.match(/if\s*\(!_directHTDisabled[^)]*\)/);
  ok(direct && /htj2k/.test(direct[0]),
     'the !_directHTDisabled guard itself carries the htj2k condition');

  const sbx = fs.readFileSync(path.join(root, 'src/sandbox/j2k_decoder.js'), 'utf8');
  ok(/import\s*\{[^}]*sniffCodestream[^}]*\}\s*from\s*['"]\.\.\/scripts\/modules\/imf\/j2kCodestream\.js['"]/.test(sbx),
     'sandbox imports the shared sniff');
  ok(!/function\s+sniffCodestream/.test(sbx),
     'sandbox no longer defines its own sniff (would drift from imf_j2k.js)');
}

// ── route accounting exists and is a copy, not the live object (C-RT2 HUD) ──
{
  const j2k = fs.readFileSync(path.join(root, 'src/scripts/modules/imf/imf_j2k.js'), 'utf8');
  ok(/export function getDecodeRouteStats/.test(j2k), 'getDecodeRouteStats is exported for the HUD');
  ok(/_noteRoute\('direct-openjph'\)/.test(j2k), 'direct OpenJPH decodes are counted');
  ok(/_noteRoute\(frame\.decoderKind/.test(j2k), 'sandbox decodes are counted by the backend that served them');
  ok(/byBackend:\s*\{\s*\.\.\._routeStats\.byBackend\s*\}/.test(j2k), 'stats are returned as a copy');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
