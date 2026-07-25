// SIZ image dimensions, and the convergence of the private SIZ parsers onto
// j2kCodestream.js.
// Run: node tests-js/j2kSizDims.test.mjs
//
// This codebase held four SIZ walks. Two were behind j2kCodestream.js; two were
// private copies — imf_player.js::parseJ2KHeader (feeding the centre-screen
// resolution readout) and imf_mxf.js::parseJ2KSIZ (feeding the truncated-frame
// heuristic). Both copies shared four defects:
//   • Xsiz reported as the width. The image is Xsiz − XOsiz.
//   • `Lsiz >= 38` accepted. No conforming SIZ is shorter than 41.
//   • An unbounded marker walk with no SOT/SOD stop.
//   • In the player's copy, a DataView built with no length, so the view ran to
//     the end of the underlying ArrayBuffer rather than to the frame.
// Nothing in tests-js/ read a width out of a codestream before this file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  sniffCodestream, MARKER, SIZ_MIN_LSIZ,
} from '../src/scripts/modules/imf/j2kCodestream.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

function be16(v) { return [(v >> 8) & 0xff, v & 0xff]; }
function be32(v) { return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]; }

// SIZ: FF51 Lsiz(2) Rsiz(2) Xsiz(4) Ysiz(4) XOsiz(4) YOsiz(4)
//      XTsiz(4) YTsiz(4) XTOsiz(4) YTOsiz(4) Csiz(2) then Csiz×3.
// `lsiz` overrides the computed length so a short segment can be built.
function makeCodestream({
  rsiz = 0, xsiz = 1920, ysiz = 1080, xosiz = 0, yosiz = 0,
  comps = 3, lsiz = null, extra = [],
} = {}) {
  const body = [
    ...be16(rsiz),
    ...be32(xsiz), ...be32(ysiz),
    ...be32(xosiz), ...be32(yosiz),
    ...be32(xsiz), ...be32(ysiz),
    ...be32(0), ...be32(0),
    ...be16(comps),
  ];
  for (let i = 0; i < comps; i++) body.push(0x09, 0x01, 0x01);
  return new Uint8Array([
    ...be16(MARKER.SOC),
    ...be16(MARKER.SIZ), ...be16(lsiz == null ? 2 + body.length : lsiz), ...body,
    ...extra,
    ...be16(MARKER.EOC),
  ]);
}

// ── the ordinary case ──
{
  const s = sniffCodestream(makeCodestream({ xsiz: 4096, ysiz: 2160 }));
  eq(s.width, 4096, 'Xsiz becomes the width when the origin is zero');
  eq(s.height, 2160, 'Ysiz becomes the height when the origin is zero');
  eq(s.xsiz, 4096, 'the raw reference-grid width is reported too');
  eq(s.xosiz, 0, 'and the origin, so a caller can tell the two apart');
}

// ── the defect: the image is the grid minus its origin ──
// IMF App#2E pins XOsiz/YOsiz to zero, which is why both private parsers got
// away with returning Xsiz for years. Neither one said it depended on that.
{
  const s = sniffCodestream(makeCodestream({ xsiz: 1920, ysiz: 1080, xosiz: 64, yosiz: 20 }));
  eq(s.width, 1856, 'width is Xsiz − XOsiz, not Xsiz');
  eq(s.height, 1060, 'height is Ysiz − YOsiz, not Ysiz');
  eq(s.xsiz, 1920, 'the grid extent is still available unmodified');
  eq(s.yosiz, 20, 'as is the origin');
}
// An origin at or past the grid edge describes no image at all.
for (const [xosiz, yosiz, why] of [[1920, 0, 'origin at the grid width'],
                                   [0, 1080, 'origin at the grid height'],
                                   [4000, 0, 'origin past the grid']]) {
  const s = sniffCodestream(makeCodestream({ xsiz: 1920, ysiz: 1080, xosiz, yosiz }));
  eq(s.width, null, `${why} → width is null, not zero or negative`);
  eq(s.height, null, `${why} → height is null too`);
}

// ── Lsiz floor: 38 is not a length a SIZ can have ──
eq(SIZ_MIN_LSIZ, 41, 'Lsiz = 38 + 3·Csiz, so one component gives 41');
{
  // The length the old parsers accepted. Routing must still work — the marker
  // and Rsiz are where they always were — but the dimensions are withheld,
  // because a segment this short is not a SIZ and its Xsiz field is not one.
  const s = sniffCodestream(makeCodestream({ rsiz: 0x4000, lsiz: 38 }));
  eq(s.width, null, 'Lsiz=38 yields no dimensions');
  eq(s.kind, 'htj2k', 'but classification is unaffected — routing does not depend on dims');
  eq(s.rsiz, 0x4000, 'and Rsiz is still read');
}
eq(sniffCodestream(makeCodestream({ lsiz: 40 })).width, null, 'Lsiz=40 is still below the floor');
eq(sniffCodestream(makeCodestream({ lsiz: 41 })).width, 1920, 'Lsiz=41 is accepted');

// ── nothing is guessed when SIZ is not there ──
{
  const s = sniffCodestream(new Uint8Array([...be16(MARKER.SOC), 0, 0, 0, 0, 0, 0, 0, 0]));
  eq(s.width, null, 'a codestream with no SIZ reports no width');
  eq(s.height, null, 'and no height');
  eq(s.kind, 'j2k', 'and is still conservatively classified as Part 1');
}
{
  const s = sniffCodestream(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  eq(s.kind, 'unknown', 'non-J2K bytes stay unknown');
  eq(s.width, null, 'and carry no dimensions');
}

// ── a view must be read to its own length, not the buffer's ──
// Two separate properties, and it is worth not conflating them.
//
// (1) Reads cannot reach the buffer behind the view. That holds because this
//     module indexes the Uint8Array rather than going through a DataView: an
//     out-of-range index is `undefined`, not the next frame's byte. The old
//     player parser built `new DataView(bytes.buffer, bytes.byteOffset)` with
//     no length, which genuinely did span to the end of the ArrayBuffer.
// (2) A SIZ truncated by the view boundary must report *unknown*, not a number
//     assembled from the fields that happened to fit. Property (1) makes the
//     missing fields read as zero, which is the dangerous case — zero is a
//     legal XOsiz, so the result looks entirely plausible.
{
  const cs = makeCodestream({ xsiz: 1920, ysiz: 1080, xosiz: 64, yosiz: 20 });
  const big = new Uint8Array(64 + cs.length + 4096);
  big.set(cs, 64);
  big.fill(0xAB, 64 + cs.length);   // "neighbouring frame" bytes

  eq(sniffCodestream(big.subarray(64)).width, 1856,
     'a subarray starting at SOC parses normally');

  // Clipped so Xsiz and Ysiz are inside the view but XOsiz and YOsiz are not.
  // Without the end-of-segment bound this returns 1920 × 1080 — the right shape,
  // the wrong picture, and no signal that anything was missing.
  const clipped = big.subarray(64, 64 + 16);
  const s = sniffCodestream(clipped);
  eq(s.markerOffset, 2, 'the SIZ marker inside the view is still found');
  eq(s.width, null, 'a SIZ truncated before XOsiz reports no width rather than an un-offset one');
  eq(s.height, null, 'nor a height');
  // And nothing was taken from the filler behind the view.
  ok(s.xsiz == null && s.xosiz == null, 'no partial grid fields leak out either');
}

// ── a 32-bit grid extent must not sign-flip ──
// `<< 24` on a byte >= 0x80 produces a negative number. Xsiz is unsigned.
{
  const s = sniffCodestream(makeCodestream({ xsiz: 0x80000010, ysiz: 8 }));
  eq(s.width, 0x80000010, 'Xsiz above 2^31 stays positive');
  ok(s.width > 0, 'and is not a negative width');
}

// ── the private copies are gone ──
{
  const p = read('src/scripts/modules/imf/imf_player.js');
  ok(/import \{ sniffCodestream \} from '\.\/j2kCodestream\.js'/.test(p),
     'imf_player imports the shared sniff');
  // The assignment form specifically. An earlier version of this guard matched
  // the bare expression and fired on the comment above parseJ2KHeader that
  // quotes the defect — a source-text guard has to be narrow enough that
  // describing the bug does not count as committing it.
  ok(!/=\s*new DataView\([a-zA-Z_.]+\.buffer,\s*[a-zA-Z_.]+\.byteOffset\)/.test(p),
     'the length-less DataView is gone from imf_player');
  ok(!/len >= 38/.test(p), 'and the Lsiz >= 38 gate with it');
  ok(!/dv\.getUint32\(off \+ 6\)/.test(p),
     'imf_player no longer walks SIZ itself');
}
{
  const m = read('src/scripts/modules/imf/imf_mxf.js');
  ok(/import \{ sniffCodestream \} from '\.\/j2kCodestream\.js'/.test(m),
     'imf_mxf imports the shared sniff');
  ok(!/len >= 38/.test(m), 'the Lsiz >= 38 gate is gone from imf_mxf too');
  ok(!/dv\.getUint32\(off \+ 6\)/.test(m),
     'imf_mxf no longer walks SIZ itself');
  // Latent, not live: readBytes() hands back a fresh whole-buffer Uint8Array,
  // so this view was already the right one. Pinned because the reader could
  // start returning subarrays and nothing would have said so.
  ok(!/=\s*new DataView\([a-zA-Z_.]+\.buffer\)/.test(m) && !/return new DataView\([a-zA-Z_.]+\.buffer\)/.test(m),
     'no DataView in imf_mxf is built without an explicit offset and length');
}
// The player's readout must keep testing for a missing width rather than
// printing it. `null × null` is the failure this guards.
{
  const p = read('src/scripts/modules/imf/imf_player.js');
  ok(/if \(j2k\?\.width && j2k\?\.height\)/.test(p),
     'the resolution readout is still guarded on both dimensions being known');
}

// ── existing behaviour is untouched ──
// Dimensions were added to sniffCodestream's return; the fields the decoder
// ladder routes on must read exactly as before.
{
  const classic = sniffCodestream(makeCodestream({ rsiz: 0 }));
  eq(classic.kind, 'j2k', 'classic still routes as Part 1');
  eq(classic.hasCap, false, 'and reports no CAP');
  const ht = sniffCodestream(makeCodestream({ rsiz: 0x4000 }));
  eq(ht.kind, 'htj2k', 'Rsiz bit 14 still routes as HT');
  eq(ht.markerOffset, 2, 'and SIZ is still located at 2');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
