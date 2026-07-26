import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// PostFlowX ships in 7 languages, but until now every failure message was
// English-only: friendlyError.js builds its text in JS and hands the renderer a
// finished string, so the i18n MutationObserver — which translates DOM text
// against a dictionary — never had a key to look up. friendlyError.js now calls
// window.PFX_t on each part, and i18n.js carries an ERROR_DICT for them.
//
// That coupling is invisible: you can add a rule to friendlyError.js, watch all
// 46 of its tests pass, and have silently shipped an English-only error to six
// locales. This file is the thing that notices. It reads both sources as TEXT —
// neither can be imported here, i18n.js because it touches window/document at
// load, and it is the dictionary literal we want to check anyway, not whatever
// a running app merged into DICT.

const SRC_DIR = fileURLToPath(new URL('../src/scripts/', import.meta.url));
const friendlySrc = readFileSync(SRC_DIR + 'core/friendlyError.js', 'utf8');
const i18nSrc = readFileSync(SRC_DIR + 'modules/i18n.js', 'utf8');

const LANGS = ['ko', 'ja', 'zh-TW', 'th', 'id', 'fil'];

// ── Extract every string friendlyError.js can put in front of a user ─────────
// Two shapes: literal `title:/message:/hint:` values in the RULES table, and
// _t("…") calls for the parts that are assembled in code (the ENOENT message
// and the generic fallback). Anything else in that file is a regex or a
// comment, and `raw` is deliberately excluded — it is support-log text.

const STRING_LIT = String.raw`('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
const unquote = (lit) => new Function('return ' + lit)();

function userFacingStrings(src) {
  const found = new Set();
  for (const m of src.matchAll(new RegExp(`\\b(?:title|message|hint):\\s*${STRING_LIT}`, 'g'))) {
    found.add(unquote(m[1]));
  }
  for (const m of src.matchAll(new RegExp(`\\b_t\\(\\s*${STRING_LIT}\\s*\\)`, 'g'))) {
    found.add(unquote(m[1]));
  }
  found.delete('');   // `title: ''` on the pass-through return — no label shown.
  return [...found];
}

// ── Extract the ERROR_DICT literal from i18n.js ──────────────────────────────
// Brace-counting rather than a regex: the value contains braces of its own, and
// a lazy match would stop at the first `}` inside it.

function errorDict(src) {
  const start = src.indexOf('const ERROR_DICT = {');
  assert.notEqual(start, -1, 'ERROR_DICT is missing from i18n.js');
  const open = src.indexOf('{', start);
  let depth = 0, end = -1, inStr = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.notEqual(end, -1, 'ERROR_DICT literal is not balanced');
  return new Function('return ' + src.slice(open, end))();
}

const STRINGS = userFacingStrings(friendlySrc);
const DICT = errorDict(i18nSrc);

// ── The extraction itself has to be trustworthy ──────────────────────────────
// If a refactor changed how rules are written, the regexes above would quietly
// find nothing and every coverage test below would vacuously pass.

test('the source scan actually found the rule strings', () => {
  assert.ok(STRINGS.length >= 45, `only found ${STRINGS.length} strings — did the RULES table change shape?`);
  // Spot-check one of each shape so a half-broken scan cannot slip through.
  assert.ok(STRINGS.includes('Disk full'), 'missed a literal title');
  assert.ok(STRINGS.includes('Free up space or choose another drive, then try again.'), 'missed a literal hint');
  assert.ok(STRINGS.includes("That file or folder couldn't be found."), 'missed a _t() call');
});

// ── Coverage: no locale may be missing a message ─────────────────────────────

for (const lang of LANGS) {
  test(`${lang}: every failure message is translated`, () => {
    const map = DICT[lang];
    assert.ok(map, `ERROR_DICT has no "${lang}" — the app offers this language`);
    const missing = STRINGS.filter((s) => !map[s] || !String(map[s]).trim());
    assert.deepEqual(missing, [], `untranslated in ${lang}:\n  ${missing.join('\n  ')}`);
  });

  test(`${lang}: no translation is a copy of the English`, () => {
    // A byte-identical value is the signature of a stub someone meant to come
    // back to. Proper nouns are the legitimate exception: "Resolve Engine",
    // "Simple Mode" and "IMF Validation" appear untranslated in every other
    // dict in i18n.js, so an error that renamed them would send the user
    // looking for a menu that is not there. Those only ever appear inside a
    // longer sentence, so requiring the sentence itself to differ is enough.
    const map = DICT[lang];
    const copied = STRINGS.filter((s) => map[s] === s);
    assert.deepEqual(copied, [], `identical to English in ${lang}:\n  ${copied.join('\n  ')}`);
  });
}

test('the six locales cover exactly the same keys', () => {
  // Catches a key added to one language and forgotten in the rest, which
  // otherwise only shows up for the one user who speaks the missing language.
  const ref = Object.keys(DICT.ko).sort();
  for (const lang of LANGS.slice(1)) {
    assert.deepEqual(Object.keys(DICT[lang]).sort(), ref, `${lang} key set differs from ko`);
  }
});

test('no dictionary entry is left behind after a rule is reworded', () => {
  // The opposite drift: dead keys accumulate, and the next person cannot tell
  // which of two similar entries is the live one.
  const live = new Set(STRINGS);
  const orphans = Object.keys(DICT.ko).filter((k) => !live.has(k));
  assert.deepEqual(orphans, [], `in ERROR_DICT but no longer in friendlyError.js:\n  ${orphans.join('\n  ')}`);
});

// ── The wiring, not just the data ────────────────────────────────────────────

test('ERROR_DICT is merged into DICT before the reverse index is built', () => {
  // Merging after KEY_SET/REVERSE are built would leave the entries invisible
  // to language switching — present in the file, dead at runtime.
  const merge = i18nSrc.indexOf('Object.entries(ERROR_DICT)');
  const keySet = i18nSrc.indexOf('const KEY_SET = new Set()');
  assert.notEqual(merge, -1, 'ERROR_DICT is never merged into DICT');
  assert.ok(merge < keySet, 'ERROR_DICT is merged after KEY_SET is built, so it will not be indexed');
});

test('friendlyError reaches i18n through the window global, not an import', () => {
  // An import would break the Node tests (no window) and pull the 3,700-line
  // dictionary into every consumer of this module.
  assert.match(friendlySrc, /window\.PFX_t/, 'friendlyError.js no longer calls window.PFX_t');
  assert.doesNotMatch(friendlySrc, /^\s*import .*i18n/m, 'friendlyError.js must not import i18n.js');
  assert.match(i18nSrc, /window\.PFX_t\s*=/, 'i18n.js no longer exposes window.PFX_t');
});

test('translations stay short enough for a toast', () => {
  // Same 170-char budget friendlyErrorRules.test.mjs holds English to. Thai and
  // Filipino run longest, and a hint that wraps to four lines in a toast is a
  // hint nobody reads.
  const long = [];
  for (const lang of LANGS) {
    for (const [k, v] of Object.entries(DICT[lang])) {
      if (v.length > 170) long.push(`${lang}: ${k} → ${v.length} chars`);
    }
  }
  assert.deepEqual(long, [], long.join('\n  '));
});

test('the product name is never translated away', () => {
  // "PostFlowX" is how the user identifies the app in a support request.
  const withName = STRINGS.filter((s) => s.includes('PostFlowX'));
  assert.ok(withName.length >= 6, 'expected several messages to name the app');
  for (const lang of LANGS) {
    for (const s of withName) {
      assert.match(DICT[lang][s], /PostFlowX/, `${lang} dropped the product name from: ${s}`);
    }
  }
});
