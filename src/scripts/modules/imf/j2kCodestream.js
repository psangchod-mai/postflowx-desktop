// scripts/modules/imf/j2kCodestream.js
// The one place that decides whether a JPEG 2000 codestream is HTJ2K (Part 15)
// or classic (Part 1). Pure byte inspection — no DOM, no WASM, unit-testable.
//
// Why this module exists: three places used to answer this question and they
// disagreed.
//   • src/sandbox/j2k_decoder.js  — scanned for SIZ, tested Rsiz & 0x4000, and
//     routed HT → OpenJPH / classic → OpenJPEG. Correct.
//   • imf_j2k.js decodeHTJ2K()    — did not sniff at all. It accepted any
//     codestream and handed it to OpenJPH's HTJ2KDecoder, which is the decoder
//     the sandbox reserves for HT only.
//   • imf_player.js parseJ2KHeader() — walked the marker segments properly and
//     captured Rsiz, but never tested the capability bit; the value was only
//     ever displayed.
// So the codebase already knew the answer twice and still routed on it zero
// times outside the sandbox. Import from here instead of re-deriving it.
'use strict';

export const MARKER = {
  SOC: 0xFF4F,  // Start of codestream — first two bytes of every J2K stream,
                // Part 1 and Part 15 alike. HTJ2K does NOT have its own SOC.
  SIZ: 0xFF51,  // Image and tile size — mandatory, immediately follows SOC.
  CAP: 0xFF50,  // Extended capabilities. Present iff Rsiz bit 14 is set; this
                // is the marker HTJ2K adds, not a different SOC.
  EOC: 0xFFD9,
};

// Rsiz bit 14. Set means "a CAP marker segment follows", which is how a Part 15
// (HTJ2K) codestream announces itself. Strictly, Pcap in the CAP segment names
// *which* extension; in practice every HT stream sets this bit and the sandbox
// has always routed on it alone, so this module matches that predicate exactly
// rather than inventing a stricter one the decoders were never tested against.
// `hasCap` is reported separately for callers that want the corroboration.
export const RSIZ_CAP_BIT = 0x4000;

function u16(bytes, off) {
  return ((bytes[off] & 0xff) << 8) | (bytes[off + 1] & 0xff);
}

// Multiply rather than `<< 24`: Xsiz is an unsigned 32-bit field, and a shift
// would sign-flip anything at or above 2^31 into a negative width.
function u32(bytes, off) {
  return ((bytes[off] & 0xff) * 0x1000000) +
         (((bytes[off + 1] & 0xff) << 16) |
          ((bytes[off + 2] & 0xff) << 8) |
           (bytes[off + 3] & 0xff));
}

// SIZ layout (ISO/IEC 15444-1 Table A.9), byte offsets from the marker:
//   +0 SIZ  +2 Lsiz  +4 Rsiz  +6 Xsiz  +10 Ysiz  +14 XOsiz  +18 YOsiz
//   +22 XTsiz  +26 YTsiz  +30 XTOsiz  +34 YTOsiz  +38 Csiz, then 3 bytes each.
// Lsiz = 38 + 3·Csiz, so a conforming segment with even one component is 41 or
// longer. Both private copies of this parse tested `Lsiz >= 38`, a length no
// SIZ can actually have — a looser gate on a marker match than the format
// allows, which matters only when the match is spurious, which is exactly when
// it matters.
export const SIZ_MIN_LSIZ = 41;
const SIZ_DIMS_END = 22;   // bytes from the marker needed to read through YOsiz

/**
 * Image dimensions from a SIZ segment at `sizOff`, or null if the segment is
 * too short, truncated, or describes an empty grid.
 */
function _readSizDims(bytes, sizOff) {
  if (u16(bytes, sizOff + 2) < SIZ_MIN_LSIZ) return null;
  if (sizOff + SIZ_DIMS_END > bytes.length) return null;
  const xsiz  = u32(bytes, sizOff + 6);
  const ysiz  = u32(bytes, sizOff + 10);
  const xosiz = u32(bytes, sizOff + 14);
  const yosiz = u32(bytes, sizOff + 18);
  // The image is the reference grid minus its origin: Xsiz − XOsiz, not Xsiz.
  // Both private parsers returned Xsiz and labelled it the width, which is
  // right only because IMF App#2E pins the image offset to zero. Nothing in
  // either parser depended on that being true, and neither said so.
  const width  = xsiz - xosiz;
  const height = ysiz - yosiz;
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height, xsiz, ysiz, xosiz, yosiz };
}

/**
 * Classify a raw JPEG 2000 codestream.
 *
 * @param {Uint8Array} bytes  Codestream, ideally starting at SOC. Indexed
 *   directly, never through a DataView, so a `subarray` view of a larger read
 *   buffer is read to its own length and cannot run into the next frame.
 * @returns {{kind:'htj2k'|'j2k'|'unknown', rsiz:number|null, markerOffset:number,
 *            hasCap:boolean, width:number|null, height:number|null,
 *            xsiz:number|null, ysiz:number|null, xosiz:number|null, yosiz:number|null}}
 *   kind 'unknown' means "not a J2K codestream" — callers must not guess a
 *   decoder for it. 'j2k' means classic Part 1. Never returns 'htj2k' on a
 *   stream whose SIZ could not be read.
 *
 *   `width`/`height` are the image size (Xsiz − XOsiz, Ysiz − YOsiz) and are
 *   null whenever the SIZ segment was absent, short, or truncated. Null means
 *   "not known", never "zero" — callers displaying dimensions must test for it
 *   rather than printing whatever came back.
 */
export function sniffCodestream(bytes) {
  const info = {
    kind: 'unknown', rsiz: null, markerOffset: -1, hasCap: false,
    width: null, height: null, xsiz: null, ysiz: null, xosiz: null, yosiz: null,
  };
  if (!bytes || bytes.length < 8) return info;
  if (u16(bytes, 0) !== MARKER.SOC) return info;

  // SIZ is mandatory and immediately follows SOC, so the walk below normally
  // resolves on its first step. The bounded scan is tolerance for streams with
  // a stray segment in front, matching what the sandbox has always accepted.
  let off = 2;
  const lim = Math.min(bytes.length - 6, 8192);
  while (off < lim) {
    const marker = u16(bytes, off);
    if (marker === MARKER.SIZ) {
      info.markerOffset = off;
      info.rsiz = u16(bytes, off + 4);
      info.kind = (info.rsiz & RSIZ_CAP_BIT) ? 'htj2k' : 'j2k';
      info.hasCap = _scanForCap(bytes, off, lim);
      Object.assign(info, _readSizDims(bytes, off));
      return info;
    }
    const len = u16(bytes, off + 2);
    if (len < 2) break;          // malformed length — stop walking, start scanning
    off += 2 + len;
  }

  // Length walk failed (truncated or malformed header). Fall back to a plain
  // byte scan for SIZ rather than guessing HT.
  for (let i = 2; i < lim; i++) {
    if (bytes[i] === 0xFF && bytes[i + 1] === 0x51) {
      info.markerOffset = i;
      info.rsiz = u16(bytes, i + 4);
      info.kind = (info.rsiz & RSIZ_CAP_BIT) ? 'htj2k' : 'j2k';
      info.hasCap = _scanForCap(bytes, i, lim);
      Object.assign(info, _readSizDims(bytes, i));
      return info;
    }
  }

  // Valid SOC but no readable SIZ. It is a codestream, but we cannot tell which
  // kind — report classic, the conservative choice: the classic decoder path has
  // a pure-JS fallback behind it, the HT path does not.
  info.kind = 'j2k';
  return info;
}

function _scanForCap(bytes, sizOff, lim) {
  const len = u16(bytes, sizOff + 2);
  if (len < 2) return false;
  let off = sizOff + 2 + len;
  while (off + 4 <= lim) {
    const marker = u16(bytes, off);
    if (marker === MARKER.CAP) return true;
    if (marker === 0xFF90 || marker === 0xFF93) return false;  // SOT/SOD — main header over
    const l = u16(bytes, off + 2);
    if (l < 2) return false;
    off += 2 + l;
  }
  return false;
}

/** True only for codestreams that OpenJPH (HTJ2K-only) should be given. */
export function isHTJ2KCodestream(bytes) {
  return sniffCodestream(bytes).kind === 'htj2k';
}

// ── Descriptor-level declaration ─────────────────────────────────────────────
// Everything above inspects codestream bytes and is authoritative. What follows
// answers the same question from an IMF CPL's EssenceDescriptorList: a
// *declaration*, available before a single frame has been read, of what the
// packager says the essence is. When the two disagree the bytes win — nothing
// here should ever be used to choose a decoder, only to label and to validate.
//
// It lives in this file anyway. Keeping the descriptor answer in imf_parser.js
// and the codestream answer here is precisely how the codebase came to hold two
// different definitions of "HTJ2K", one of which was true for every classic
// Part 1 package.

/**
 * PictureEssenceCoding UL fragments taken as declaring Part 15. Matched as
 * substrings of the dot-grouped UL text a CPL carries, lower-cased.
 *
 * Deliberately short, and shorter than it was. `04010202.03010000` was in this
 * set: that is the trailing-zero *generic* JPEG 2000 coding label, which a
 * classic Part 1 essence is entitled to declare, so matching it reported plain
 * J2K as HTJ2K. A fragment belongs here only if it names Part 15 specifically.
 *
 * The one remaining entry is inherited and unverified against SMPTE RP 224. It
 * is kept because a narrow check that may never fire is harmless, while
 * deleting a check on a hunch is the same unfounded move as adding one — but it
 * is reported as weaker evidence than the descriptor element below, so a
 * package that matches only this cannot quietly pass for a confirmed HT stream.
 */
export const HTJ2K_PEC_UL_FRAGMENTS = Object.freeze(['0d01030c']);

/**
 * Classify an essence descriptor's picture coding from CPL-declared signals.
 *
 * @param {object} sig
 * @param {boolean} sig.hasJ2KSubDescriptor      a JPEG 2000 sub-descriptor is present
 * @param {boolean} sig.hasExtendedCapabilities  J2KExtendedCapabilities is present
 * @param {string}  sig.pecUL                    PictureEssenceCoding text, or ''
 * @returns {{isJ2K:boolean, isHTJ2K:boolean, htEvidence:'extended-capabilities'|'pec-ul'|null}}
 *   `isHTJ2K` is exactly `htEvidence !== null`, and is never implied by
 *   `isJ2K`. Part 15 is a positive finding about a stream; "it is JPEG 2000"
 *   is not evidence for it.
 */
export function classifyJ2KDescriptor(sig) {
  const s = sig || {};
  const pecUL = typeof s.pecUL === 'string' ? s.pecUL.toLowerCase() : '';

  // J2KExtendedCapabilities exists to carry the CAP marker segment's Pcap/Ccap
  // values. A Part 1 codestream has no CAP marker, so the element has nothing
  // to describe and a Part 1 descriptor does not carry one: presence alone is
  // the signal. No Pcap bit is decoded here on purpose — the bit numbering is a
  // second fact to get wrong, and presence already answers the question asked.
  let htEvidence = null;
  if (s.hasExtendedCapabilities) htEvidence = 'extended-capabilities';
  else if (pecUL && HTJ2K_PEC_UL_FRAGMENTS.some(f => pecUL.includes(f))) htEvidence = 'pec-ul';

  // HT evidence implies J2K — both signals are JPEG 2000 constructs — but the
  // implication runs in that direction only.
  return { isJ2K: !!s.hasJ2KSubDescriptor || htEvidence !== null, isHTJ2K: htEvidence !== null, htEvidence };
}
