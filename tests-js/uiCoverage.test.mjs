// ─────────────────────────────────────────────────────────────────────────────
// Does the dictionary cover the strings that are actually on screen?
//
// i18nParity.test.mjs asks the inward question: of the keys the dictionary
// holds, which locales are missing one. This asks the outward one: of the
// strings a user reads, how many has the dictionary never heard of.
//
// The second failure is worse and much harder to see. applyI18n derives its
// lookup key from the rendered English wording, so a label with no key at all
// falls through in ALL SIX locales at once. Nothing looks asymmetric — every
// language is equally broken — so a per-locale parity scan reports a clean bill
// of health while a Korean user reads English.
//
// ── What is gated hard, and what is not ──────────────────────────────────────
//
// aria-label and placeholder are gated at zero. They are small, deliberate,
// and they are the strings a sighted mouse user never notices and a
// screen-reader or keyboard user cannot avoid — precisely where a fall-through
// is least visible to whoever is testing and most costly to whoever is
// affected. New ones are rare, and the fix is one row in UI_DICT_ROWS.
//
// Body text, title and <option> are NOT shrink-only. src/index.html is edited
// daily; a tight bound over 1800 strings would turn every ordinary copy edit
// into a red build, and a gate that cries wolf gets deleted. What guards them
// instead is a landslide bound: it will not notice one new sentence, and it
// will notice the i18n path breaking wholesale. That is a real weakening and it
// is written down here rather than hidden behind a number.
//
// ── What this cannot see ─────────────────────────────────────────────────────
//
//  - Strings built in JavaScript. This reads the static markup only; ui.js
//    creates plenty of DOM at runtime, and none of it is measured here.
//  - Whether a translation is any good. Presence is not quality.
//  - The other dictionaries — bwav's I18N and preflight's locale.js are
//    separate implementations with separate coverage.
//  - Wording drift. "Pull Prep How to Use" and "Pull Prep — How to Use" are two
//    keys as far as the dictionary is concerned; this reports the miss but
//    cannot tell you a near-identical key already exists.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadResolver, scanUI, missingFromDict, isProse, INDEX_PATH } from './lib/uiStrings.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Two placeholders that must stay English, with the reason each one does.
// This is an exclusion list, not a baseline: it is allowed to be tiny and it is
// checked below for staleness, so it cannot quietly become a parking lot.
const UNTRANSLATABLE_PLACEHOLDERS = [
  // An HTTP header name sent verbatim. Translating it would break the request.
  'X-PostFlowX-Token',
  // A sample address the user is meant to copy the shape of, not read.
  'name@example.com',
];
const MAX_EXCLUSIONS = 2;

// Landslide bound over body text + title + <option>. Measured at 1805.
// Headroom is for ordinary copy edits, not for new debt: if this number is ever
// raised, the raise is the thing to argue about.
const MAX_BODY_MISSES = 1900;

const { KEY_SET, FOLD_INDEX, toEnglishKey } = await loadResolver(ROOT);
const HTML = readFileSync(join(ROOT, INDEX_PATH), 'utf8');
const HITS = scanUI(HTML, toEnglishKey);

const missing = (kind) => missingFromDict(HITS, KEY_SET, kind);

// ── the scan has to work before what it reports means anything ───────────────

test('the resolver is the app\'s own, not a re-implementation', () => {
  // Approximating toEnglishKey here would mean approximating _candKeys, the
  // reverse maps and the fold index, and a gate that re-implements the thing it
  // measures drifts away from it. uiStrings.mjs executes the real code.
  assert.ok(KEY_SET instanceof Set, 'loadResolver did not return the real KEY_SET');
  assert.ok(KEY_SET.size > 600, `KEY_SET has only ${KEY_SET.size} keys — the slice probably cut too early`);
  assert.equal(typeof toEnglishKey, 'function', 'loadResolver did not return toEnglishKey');
});

test('the walk reaches every kind of string applyI18n translates', () => {
  // A walk that silently stopped early would report zero misses and look
  // perfect. Every kind applyI18n handles must actually turn up something.
  const seen = new Set();
  for (const meta of HITS.values()) for (const k of meta.kinds) seen.add(k);
  for (const kind of ['text', 'title', 'aria-label', 'option', 'placeholder']) {
    assert.ok(seen.has(kind), `the scan found no ${kind} at all — the walk is broken, not the UI`);
  }
  assert.ok(HITS.size > 1000, `only ${HITS.size} strings reached a lookup — ${INDEX_PATH} did not parse`);
});

test('the scan can tell a covered string from an uncovered one', () => {
  // Probe both directions. A detector that never fires and a detector that
  // always fires both report "no problem" on the day it matters.
  // The wrapper is not decoration: linkedom drops a bare "<body>…</body>"
  // fragment on the floor. scanUI refuses an empty body for exactly that
  // reason, and the last assertion here holds it to that.
  const probe = (markup, kind) =>
    missingFromDict(scanUI(`<!DOCTYPE html><html><body>${markup}</body></html>`, toEnglishKey), KEY_SET, kind);

  const unknown = 'Zzyzx quantum flange alignment';
  assert.deepEqual(
    probe(`<button aria-label="${unknown}">x</button>`, 'aria-label'),
    [unknown],
    'an aria-label the dictionary has never seen was not reported',
  );
  assert.deepEqual(
    probe('<button aria-label="How to Use">x</button>', 'aria-label'),
    [],
    'a fully translated aria-label was reported as missing',
  );
  assert.deepEqual(
    probe(`<input placeholder="${unknown}">`, 'placeholder'),
    [unknown],
    'an untranslated placeholder was not reported',
  );
  assert.throws(
    () => scanUI('<body><button aria-label="x">y</button></body>', toEnglishKey),
    /empty body/,
    'a fragment that parses to nothing must fail loudly, not scan clean',
  );
});

test('the prose filter drops furniture and keeps sentences', () => {
  // The walk is deliberately greedy, so this filter is what keeps the count
  // honest. It errs toward keeping: a false keep is one more visible line of
  // debt, a false drop hides a real gap forever.
  for (const s of ['00:00:00:00', '▼', '6', 'https://example.com/x', '{metafier} -e {out}', '.mov', '~/Library/Logs']) {
    assert.equal(isProse(s), false, `isProse kept furniture: ${JSON.stringify(s)}`);
  }
  for (const s of ['Volume', 'Mute audio', 'Search projects…']) {
    assert.equal(isProse(s), true, `isProse dropped a real string: ${JSON.stringify(s)}`);
  }
});

// ── the fold fallback must correct case, never guess ─────────────────────────

test('the folded lookup fixes a case mismatch', () => {
  // The markup says "NAME", the dictionary says "Name". Before FOLD_INDEX this
  // returned "NAME" and the user read English in all six locales.
  assert.equal(toEnglishKey('NAME'), 'Name');
  assert.equal(toEnglishKey('SIDE BY SIDE'), 'Side by side');
  assert.equal(toEnglishKey('  clip   name  '), 'Clip Name', 'whitespace should fold too');
});

test('the fold index holds no entry for keys that differ only by case', () => {
  // "PULL PREP" and "Pull Prep" are both real keys and may carry different
  // translations, so folding cannot pick between them and the pair is dropped.
  //
  // This asserts against FOLD_INDEX rather than through toEnglishKey on
  // purpose. Going through toEnglishKey looks like a stronger test and is
  // actually a vacuous one: _candKeys already tries the all-caps and all-lower
  // spellings, so for a group like PULL PREP / Pull Prep the exact-match loop
  // always wins and the fold is never consulted no matter what it contains.
  // Mutating the guard away left that version of this test passing.
  const groups = new Map();
  for (const k of KEY_SET) {
    const f = k.toLowerCase().replace(/\s+/g, ' ').trim();
    groups.set(f, [...(groups.get(f) || []), k]);
  }
  const colliding = [...groups.entries()].filter(([, ks]) => ks.length > 1);

  assert.ok(
    colliding.length > 0,
    'no two keys differ only by case any more, so this test proves nothing — delete it or the guard',
  );
  for (const [fold, ks] of colliding) {
    assert.equal(
      FOLD_INDEX.has(fold),
      false,
      `FOLD_INDEX would resolve ${JSON.stringify(fold)} to one of ${JSON.stringify(ks)} — a coin flip between ` +
      `keys that may carry different translations`,
    );
  }

  // And the other half: an unambiguous fold must still be there, or the guard
  // has been tightened into doing nothing.
  assert.equal(FOLD_INDEX.get('name'), 'Name');
});

test('an unknown string still comes back unchanged', () => {
  // The fallback must not invent a match. t() relies on the identity return to
  // decide the string has no translation.
  assert.equal(toEnglishKey('Zzyzx quantum flange alignment'), 'Zzyzx quantum flange alignment');
});

// ── the hard gates ───────────────────────────────────────────────────────────

test('every aria-label in the UI has a dictionary key', () => {
  const gaps = missing('aria-label');
  assert.deepEqual(
    gaps,
    [],
    `${gaps.length} aria-label(s) have no dictionary key, so a screen-reader user hears English in every ` +
    `language. Add a row to UI_DICT_ROWS in src/scripts/modules/i18n.js:\n  ${gaps.join('\n  ')}`,
  );
});

test('every placeholder in the UI has a dictionary key', () => {
  const gaps = missing('placeholder').filter((s) => !UNTRANSLATABLE_PLACEHOLDERS.includes(s));
  assert.deepEqual(
    gaps,
    [],
    `${gaps.length} placeholder(s) have no dictionary key, so the hint inside the field stays English in ` +
    `every language. Add a row to UI_DICT_ROWS in src/scripts/modules/i18n.js:\n  ${gaps.join('\n  ')}`,
  );
});

test('the exclusion list does not outlive what it describes', () => {
  // An exclusion for a placeholder that no longer exists is a claim about the
  // UI that stopped being true. Prune it rather than carrying it.
  const present = new Set(missing('placeholder'));
  for (const s of UNTRANSLATABLE_PLACEHOLDERS) {
    assert.ok(
      present.has(s),
      `${JSON.stringify(s)} is excluded but is no longer an untranslated placeholder — remove the exclusion`,
    );
  }
});

test('the exclusion list is sorted, unique and small', () => {
  const sorted = [...UNTRANSLATABLE_PLACEHOLDERS].sort();
  assert.deepEqual(UNTRANSLATABLE_PLACEHOLDERS, sorted, 'keep UNTRANSLATABLE_PLACEHOLDERS sorted so diffs read cleanly');
  assert.equal(new Set(UNTRANSLATABLE_PLACEHOLDERS).size, UNTRANSLATABLE_PLACEHOLDERS.length, 'duplicate exclusion');
  assert.ok(
    UNTRANSLATABLE_PLACEHOLDERS.length <= MAX_EXCLUSIONS,
    `${UNTRANSLATABLE_PLACEHOLDERS.length} exclusions vs a bound of ${MAX_EXCLUSIONS}. Two literals that are not ` +
    `prose is a fact about the UI; a growing list is a habit of writing the gate off`,
  );
});

// ── the landslide bound ──────────────────────────────────────────────────────

test('body text coverage has not collapsed', () => {
  // Deliberately loose — see the header. This catches the i18n path breaking
  // wholesale, not one new sentence.
  const total = missing('text').length + missing('title').length + missing('option').length;
  assert.ok(
    total <= MAX_BODY_MISSES,
    `${total} body/title/option strings have no dictionary key, past the bound of ${MAX_BODY_MISSES}. ` +
    `Either a lot of untranslated UI landed at once, or the dictionary stopped loading`,
  );
});
