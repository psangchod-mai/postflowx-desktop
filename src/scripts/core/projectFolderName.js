// scripts/core/projectFolderName.js
// PostFlowX — turning a project name a person typed into a folder name on disk.
//
// ── The fault ────────────────────────────────────────────────────────────────
//
// core/projectFile.js writes every project to `PFX/<folder>/`, and the folder
// name came from one line:
//
//   .replace(/[^a-zA-Z0-9._-]/g, "_")
//
// Fifty-two letters and ten digits. Everything else — every Thai, Korean,
// Japanese and Chinese character — was replaced with an underscore, the
// underscores were then collapsed and stripped from both ends, and what was
// left is what went on disk:
//
//   "ตอนที่ 3"      → "3"
//   "ตอนที่ 4"      → "4"
//   "제3화"          → "3"
//   "第3話"          → "3"
//   "제목"           → "Project"     (nothing survived; the fallback ran)
//
// The app ships in Korean, Japanese, Traditional Chinese, Thai, Indonesian and
// Filipino. An editor who names a project in the language the app is running
// in does not get a badly-named folder — they get a *shared* one. "ตอนที่ 3"
// and "제3화" are the same directory. Saving the second one writes its
// project.json over the first, and the first is gone: not corrupted, not
// recoverable from a dialog, overwritten. Two projects named entirely in Thai
// with no digits in them are both "Project", so are the third and the fourth.
//
// Nothing on screen said any of this. The name box kept showing "ตอนที่ 3"
// because the box holds what was typed; only the folder was renamed, silently,
// somewhere the reader never looks.
//
// ── What changed ─────────────────────────────────────────────────────────────
//
// The allowed set becomes "letters, numbers and the marks that go with them"
// in the Unicode sense — \p{L}, \p{N}, \p{M} — instead of the ASCII subset of
// the same idea. \p{M} matters more than it looks: Thai vowel signs and tone
// marks (◌ี in ที่) are combining marks, not letters, and leaving them out
// would shred Thai worse than it shreds Korean.
//
// For a name that was already pure ASCII this is a no-op, byte for byte:
// \p{L} contains a-zA-Z and \p{N} contains 0-9, so "EP103 Reel 2" still lands
// on "EP103_Reel_2" and every project already on disk still resolves to the
// folder it is already in. That is the point of writing it as a widening
// rather than a rewrite — there is no migration, because nothing that used to
// work moves.
//
// Everything a filesystem actually objects to is still replaced: `/` and `\`
// and `:` are punctuation, not letters, so they were never in \p{L}\p{N}\p{M}
// to begin with, and neither is a control character or an emoji.
//
// ── The two guards the old line did not have ─────────────────────────────────
//
// `.` and `..` came through the old code untouched — `.` is in the allowed set
// and the end-trim only removed underscores. `getDirectoryHandle("..")` is not
// a traversal in the File System Access API (it rejects the name outright),
// but it is a save that fails with a DOMException instead of a sentence, so
// a name that is nothing but dots now takes the fallback.
//
// And length. The old code could not produce a long non-ASCII name because it
// could not produce a non-ASCII name at all; now that Thai survives, so does
// its byte count, and a directory entry is limited to 255 *bytes*, not
// characters. A 90-character Thai title is 270 bytes and the save would fail
// at the filesystem with nothing readable attached. Clamping to 200 bytes
// leaves room for the suffixes callers append to this base name
// (`.autosave.json` and friends) and only bites names far longer than anyone
// types on purpose.

const FALLBACK = 'Project';

// Letters, digits, and combining marks, plus the three punctuation characters
// the old allow-list carried. `u` is required for \p{…} to mean anything.
const NOT_ALLOWED = /[^\p{L}\p{N}\p{M}._-]/gu;

// A directory entry is capped at 255 bytes on APFS, HFS+ and ext4 alike, and
// callers append up to ~20 bytes of suffix to what this returns.
const MAX_BYTES = 200;

const BYTES = new TextEncoder();

/**
 * Trim a string to at most `MAX_BYTES` UTF-8 bytes without splitting a
 * character in half. Walks code points rather than UTF-16 units so that an
 * emoji or a CJK ideograph is dropped whole.
 *
 * @param {string} s
 * @returns {string}
 */
function clampBytes(s) {
  if (BYTES.encode(s).length <= MAX_BYTES) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const size = BYTES.encode(ch).length;
    if (used + size > MAX_BYTES) break;
    out += ch;
    used += size;
  }
  return out;
}

/**
 * The folder name for a project, given the name the user typed.
 *
 * Pure, DOM-free and total: every input returns a non-empty string that is a
 * legal single path component. Callers pass the result straight to
 * `getDirectoryHandle(..., { create:true })`, so "returns something usable"
 * is not a convenience, it is the contract.
 *
 * @param {string|null|undefined} name Project name as typed.
 * @returns {string} A folder name; `'Project'` when nothing usable survives.
 */
export function projectFolderName(name) {
  // NFC first: on macOS a Korean name typed in one input method and pasted
  // from another can arrive decomposed, and two spellings of one word must
  // not become two folders.
  const s = String(name == null ? '' : name)
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, '_')
    .replace(NOT_ALLOWED, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  // Dots-only is `.` or `..` or a run of them — a name the filesystem reads as
  // a position rather than a place.
  if (!s || /^\.+$/.test(s)) return FALLBACK;

  const clamped = clampBytes(s).replace(/_+$/g, '');
  return clamped || FALLBACK;
}
