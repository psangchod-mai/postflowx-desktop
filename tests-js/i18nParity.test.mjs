// tests-js/i18nParity.test.mjs
// A translated app must not show English to a user who picked another language.
//
// WHY THIS EXISTS
// The renderer ships six non-English locales and t() has no fallback chain: it
// looks the string up in one dictionary and returns the English key on a miss.
// A missing entry is therefore not a degraded translation, it is untranslated
// text rendered with no trace in any log. Nothing failed, nothing warned, and
// the only way to find it was to count.
//
// Counting found that the gap was structural rather than scattered. The 660-key
// merged dictionary is assembled from four literal blocks, and the largest of
// them — LOCALE_FULL_DICT, 303 keys — was authored for zh-TW/th/id/fil. Korean
// and Japanese received 157 of those keys and never got the rest. Both locales
// were missing 150 of the same strings, 142 of which all four other locales had.
// This is what that looked like on screen:
//
//     locale   English strings shown   of 660
//       fil            173              26%
//       ja             142              22%
//       ko             131              20%
//       id              95              14%
//       th              58               9%
//       zh-TW           17               3%
//
// Export, Duration, Status, Reset, the whole camera-profile panel and every
// takeover-dialog field came out in English for Japanese and Korean users. Not
// as a design decision — nobody decided anything; the block was simply never
// finished, and there was no gate that could notice.
//
// TWO SPECIES, DELIBERATELY KEPT APART
//   absent   — no entry at all, so t() falls through. Always a defect when the
//              string is provably translatable.
//   identity — an entry whose value equals its key. Sometimes a genuine choice,
//              sometimes a silent no-op, and the difference needs a human.
//
// The second category is why this gate does not simply demand 100% coverage.
// Filipino post-production says "Lens Flare" and "Cut Diff"; Indonesian says
// "VFX Marker". Those locales prove it in their own authored entries — fil maps
// "PULL PREP" to "Pull Prep" on purpose. A gate that demanded Tagalog for
// "Lens Flare" would be wrong, and satisfying it by adding key→key pairs would
// change nothing a user sees while making the number look fixed. So identity is
// recorded in its own baseline and never counted as repaired.
//
// PROVABLY TRANSLATABLE
// A string counts against a locale only if some *other* locale renders it as
// something other than the English key. That is the honest bar: a human has
// already demonstrated the string can be said in another language, so falling
// back to English here is a gap rather than a loanword. It biases the scan
// toward "we missed one" and away from "we invented one", which is the same
// direction domIds.mjs is biased and for the same reason.
//
// WHAT THIS CANNOT SEE
//  - Whether a translation is *good*. Only whether one exists and differs from
//    English. A confident mistranslation passes.
//  - Strings that never reach t() at all. src/index.html carries zero
//    data-i18n attributes; the main UI is translated imperatively by walking
//    text nodes, so a string the walker never visits is invisible here.
//  - The app's other, unrelated i18n implementations — bwav's I18N table and
//    src/tools/preflight/app/locale.js each have their own dictionaries.
//  - Plurals, ordering and interpolation. The dictionary is flat strings.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadDict, readI18nSource, allKeys, untranslated, provablyTranslatable } from './lib/i18nDict.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (n) => JSON.parse(readFileSync(join(ROOT, 'tests-js/fixtures', n), 'utf8'));

const ABSENT = fixture('i18n-absent.json');
const IDENTITY = fixture('i18n-identity.json');

// The six locales normLang() can return besides 'en'. English is the key space
// itself, so it has no entries and cannot be measured against itself.
const LOCALES = ['ko', 'ja', 'zh-TW', 'th', 'id', 'fil'];

// Hard ceilings, written as literals. A baseline is a debt list, not a parking
// lot: raising one of these is an edit somebody has to justify in review, which
// is the entire mechanism. 31 absent is down from 366.
const MAX_ABSENT = 31;
const MAX_IDENTITY = 250;

const DICT = await loadDict(ROOT);
const KEYS = allKeys(DICT);
const SOURCE = readI18nSource(ROOT);

const measured = { absent: [], identity: [] };
for (const loc of LOCALES) {
  const { absent, identity } = untranslated(DICT, loc, LOCALES);
  for (const k of absent) measured.absent.push(`${loc} -> ${k}`);
  for (const k of identity) measured.identity.push(`${loc} -> ${k}`);
}
measured.absent.sort();
measured.identity.sort();

// ── the scan has to work before what it reports means anything ───────────────

test('the dictionary loads by running the real merge code', () => {
  // Re-deriving DICT by parsing the source would mean re-implementing four merge
  // loops, and a gate that re-implements the thing it measures drifts away from
  // it. i18nDict.mjs executes the file's own construction half instead, so these
  // are the objects t() reads. Pin the shape before trusting any count below.
  assert.ok(DICT && typeof DICT === 'object', 'loadDict returned nothing');
  for (const loc of LOCALES) {
    assert.ok(DICT[loc], `DICT has no ${loc} — normLang can return it, so t() would fall through for every string`);
  }
  assert.equal(
    Object.keys(DICT.en || {}).length,
    0,
    'DICT.en gained entries. English is the key space; entries there mean the keys are no longer the English text',
  );
});

test('the scan actually sees the dictionary', () => {
  // Every assertion below is of the form "we found nothing new". A scan that
  // matched nothing at all would satisfy all of them, so pin the magnitudes.
  assert.ok(KEYS.size > 600, `only ${KEYS.size} distinct keys — the slice boundary or a merge loop drifted`);
  for (const loc of LOCALES) {
    const n = Object.keys(DICT[loc]).length;
    assert.ok(n > 600, `${loc} carries only ${n} entries — a dictionary block stopped merging`);
  }
  assert.ok(
    measured.absent.length + measured.identity.length > 0,
    'the scan found nothing untranslated at all, which would be the first time — verify the detector before celebrating',
  );
});

test('the detector separates a gap from a deliberate loanword', () => {
  // Four locales, one key each, covering every branch of the classifier.
  const probe = {
    en: {},
    ko: { Widget: '위젯' }, //          translated — not reported
    ja: {}, //                          absent, and ko proves it translatable
    'zh-TW': { Widget: 'Widget' }, //   identity — reported, but as identity
    th: { Widget: '   ' }, //           blank is not a translation
    id: {}, //                          absent
    fil: {},
  };
  const locs = ['ko', 'ja', 'zh-TW', 'th', 'id', 'fil'];
  assert.equal(untranslated(probe, 'ko', locs).absent.length, 0, 'a real translation was reported as a gap');
  assert.deepEqual(untranslated(probe, 'ja', locs).absent, ['Widget'], 'a missing entry was not reported');
  assert.deepEqual(untranslated(probe, 'zh-TW', locs).identity, ['Widget'], 'an identity entry was not reported');
  assert.deepEqual(untranslated(probe, 'zh-TW', locs).absent, [], 'identity was miscounted as absent');
  assert.deepEqual(untranslated(probe, 'th', locs).identity, [], 'a whitespace value was treated as a translation');

  // And the provability bar itself: with nobody translating it, nobody is short of it.
  const loan = { en: {}, ko: { 'Lens Flare': 'Lens Flare' }, ja: {}, 'zh-TW': {}, th: {}, id: {}, fil: {} };
  assert.equal(
    provablyTranslatable(loan, 'ja', 'Lens Flare', locs),
    false,
    'a term no locale has ever translated was demanded of a locale that omits it',
  );
  assert.deepEqual(untranslated(loan, 'ja', locs).absent, [], 'an unproven term was counted against a locale');
});

// ── the gate ─────────────────────────────────────────────────────────────────

test('no locale newly falls through to English', () => {
  const fresh = measured.absent.filter((e) => !ABSENT.includes(e));
  assert.deepEqual(
    fresh,
    [],
    'a string other locales translate now has no entry here, so t() returns the English key. ' +
      'The user sees English inside their own language with nothing logged anywhere:\n  ' +
      fresh.join('\n  '),
  );
});

test('no locale newly gains an entry that does nothing', () => {
  const fresh = measured.identity.filter((e) => !IDENTITY.includes(e));
  assert.deepEqual(
    fresh,
    [],
    'a new entry maps a key to itself. That is either a deliberate loanword — in which case ' +
      'add it to i18n-identity.json and say why — or a placeholder somebody meant to come ' +
      'back to, which now looks translated to every tool that counts coverage:\n  ' +
      fresh.join('\n  '),
  );
});

// ── the baselines have to stay honest ────────────────────────────────────────

test('the baselines do not outlive what they describe', () => {
  const stale = [
    ...ABSENT.filter((e) => !measured.absent.includes(e)).map((e) => `i18n-absent.json: ${e}`),
    ...IDENTITY.filter((e) => !measured.identity.includes(e)).map((e) => `i18n-identity.json: ${e}`),
  ];
  assert.deepEqual(
    stale,
    [],
    'these entries are fixed — the string was translated, or the key is gone. Delete them, or ' +
      'the baseline quietly re-permits the debt it was written to retire:\n  ' + stale.join('\n  '),
  );
});

test('the baselines only ever shrink', () => {
  assert.ok(
    ABSENT.length <= MAX_ABSENT,
    `i18n-absent.json grew to ${ABSENT.length}; an untranslated string is a bug, not a baseline entry`,
  );
  assert.ok(
    IDENTITY.length <= MAX_IDENTITY,
    `i18n-identity.json grew to ${IDENTITY.length}; it is a debt list, not a parking lot`,
  );
});

test('the baselines are sorted and free of duplicates', () => {
  for (const [name, list] of [['i18n-absent.json', ABSENT], ['i18n-identity.json', IDENTITY]]) {
    assert.deepEqual(list, [...list].sort(), `${name} is out of order — regenerate it sorted`);
    assert.equal(new Set(list).size, list.length, `${name} has duplicate entries`);
  }
});

// ── the specific regression ──────────────────────────────────────────────────

test('the parity backfill stays a gap-fill and never a replacement', () => {
  // The three dictionary merges above PARITY_DICT use Object.assign, because each
  // is meant to override the one before it. This one is not: it exists only to
  // remove fall-throughs. If it ever becomes an Object.assign it would silently
  // overwrite 335 hand-authored strings with whatever this block happens to hold,
  // and the coverage count — the only number anybody checks — would not move.
  const block = SOURCE.slice(SOURCE.indexOf('const PARITY_DICT'));
  assert.ok(block.length > 0, 'PARITY_DICT is gone; the backfill was reverted');
  const merge = block.slice(block.indexOf('for (const [lang, map] of Object.entries(PARITY_DICT)'));
  assert.ok(merge.length > 0, 'the PARITY_DICT merge loop is gone; the block is now dead data');
  assert.match(
    merge,
    /if \(!\(k in target\)\) target\[k\] = v;/,
    'the parity merge lost its "only if missing" guard and can now clobber authored translations',
  );
  assert.doesNotMatch(
    merge.slice(0, merge.indexOf('\n}')),
    /Object\.assign/,
    'the parity merge became an Object.assign — it would overwrite, not fill',
  );
});

test('Japanese and Korean got the block they were missing', () => {
  // Pinned by script rather than by exact string: asserting the literal
  // translation would make every wording review a test edit, while asserting the
  // writing system catches the regression that actually happened — the entry
  // vanishing, or being "fixed" with a key→key pair.
  const SCRIPTS = {
    ko: /[\u{AC00}-\u{D7AF}]/u, //        Hangul
    ja: /[\u{3040}-\u{30FF}]/u, //        kana
    'zh-TW': /[\u{4E00}-\u{9FFF}]/u, //   Han
    th: /[\u{0E00}-\u{0E7F}]/u, //        Thai
  };
  // One string from each area the LOCALE_FULL_DICT shortfall left in English.
  const PINNED = ['Export XLSX', 'Duration', 'Status', 'Reset', 'Bundled Camera Format Library (reference)',
    'Reason for takeover (required)', 'Project name'];
  const broken = [];
  for (const [loc, re] of Object.entries(SCRIPTS)) {
    for (const key of PINNED) {
      const v = DICT[loc][key];
      if (typeof v !== 'string' || !v.trim()) { broken.push(`${loc} -> ${key}: no entry`); continue; }
      if (!re.test(v)) broken.push(`${loc} -> ${key}: ${JSON.stringify(v)} has no ${loc} script in it`);
    }
  }
  assert.deepEqual(broken, [], 'strings this backfill translated are back to English:\n  ' + broken.join('\n  '));
});

test('every key some locale carries is reachable from the English key space', () => {
  // t() is keyed on the English string, so a key that no locale can produce is
  // dead weight the coverage count still divides by. Cheap to state, and it is
  // the invariant the whole measurement rests on.
  for (const loc of LOCALES) {
    for (const k of Object.keys(DICT[loc])) {
      assert.ok(KEYS.has(k), `${loc} has key ${JSON.stringify(k)} that allKeys() missed`);
    }
  }
  assert.equal(KEYS.size, new Set([...KEYS]).size);
});
