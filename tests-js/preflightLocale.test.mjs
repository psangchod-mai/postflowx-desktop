// tests-js/preflightLocale.test.mjs
// The Preflight pane speaks the app's language, and every language it claims to
// speak has files behind it.
//
// This pane shipped 21 config files — ui_strings, checks.i18n and
// requirements.i18n across seven languages, roughly 148K of translated check
// text — of which exactly one set was ever reachable. The only code that wrote
// settings.locale hung off qs("localeSelect"), an id app/index.html has never
// contained, so the handler was never attached and six translations sat on disk
// being packaged and never rendered.
//
// Two failure modes have to stay closed, and they pull in opposite directions:
//
//   1. A locale the pane offers but has no files for. loadConfig's safeJson
//      swallows a 404 and hands back an empty dictionary, so this does not
//      throw — it renders blank labels. The disk check below is why the list in
//      locale.js can say "checked, not assumed".
//   2. A locale the host offers that the pane silently drops. That is the old
//      bug wearing a different hat: the user picks Thai, nothing objects, and
//      the pane stays English.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  PREFLIGHT_LOCALES,
  DEFAULT_LOCALE,
  normalizeLocale,
  preferredLocale,
} from '../src/tools/preflight/app/locale.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const APP_JS = read('src/tools/preflight/app/app.js');
const PANE_LANG = read('src/scripts/core/paneLang.js');
const INDEX_HTML = read('src/index.html');

/**
 * Source with whole-line comments removed.
 *
 * Written after the first run of this file failed on itself: the comments in
 * app.js explaining *why* the pane no longer calls location.reload() and no
 * longer looks up #localeSelect both contain those strings, so a plain grep for
 * them reported the bug as still present. This is the mirror image of the trap
 * in tests-js/lib/domIds.mjs, where a comment reading `id="errors"` convinced
 * the scanner the element existed. A comment cannot call a function, and it
 * cannot be the fix either — but it must not be mistaken for the bug.
 *
 * Whole-line only, matching domIds.mjs: a trailing `// note` after real code
 * leaves the code intact.
 */
const stripComments = (src) =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

const APP_CODE = stripComments(APP_JS);

// ── normalizeLocale ──────────────────────────────────────────────────────────

test('a locale the pane already has passes through', () => {
  for (const l of PREFLIGHT_LOCALES) assert.equal(normalizeLocale(l), l);
  // Case and separator are how the same locale arrives from three different
  // sources: the picker sends "zh-TW", navigator.language may send "zh-tw",
  // and a POSIX-shaped environment sends "zh_TW".
  assert.equal(normalizeLocale('zh-tw'), 'zh-TW');
  assert.equal(normalizeLocale('ZH-TW'), 'zh-TW');
  assert.equal(normalizeLocale('zh_TW'), 'zh-TW');
  assert.equal(normalizeLocale('  th  '), 'th');
});

test('a region suffix is dropped when the base language is enough', () => {
  assert.equal(normalizeLocale('en-GB'), 'en');
  assert.equal(normalizeLocale('en-US'), 'en');
  assert.equal(normalizeLocale('ja-JP'), 'ja');
  assert.equal(normalizeLocale('ko-KR'), 'ko');
  assert.equal(normalizeLocale('th-TH'), 'th');
});

test('Simplified Chinese gets English, not Traditional', () => {
  // The pane has zh-TW and nothing else Chinese. Serving Traditional to a
  // Simplified reader is a worse answer than English, because it looks like it
  // worked. Only an explicitly Traditional tag maps across.
  assert.equal(normalizeLocale('zh-CN'), DEFAULT_LOCALE);
  assert.equal(normalizeLocale('zh-Hans'), DEFAULT_LOCALE);
  assert.equal(normalizeLocale('zh'), DEFAULT_LOCALE);
  assert.equal(normalizeLocale('zh-Hant'), 'zh-TW');
  assert.equal(normalizeLocale('zh-Hant-TW'), 'zh-TW');
  assert.equal(normalizeLocale('zh-HK'), 'zh-TW');
  assert.equal(normalizeLocale('zh-MO'), 'zh-TW');
});

test('the same language under two codes lands in one place', () => {
  // The picker sends "fil"; a browser may report "tl". Indonesian changed code
  // from "in" to "id" in 1989 and some platforms still emit the old one.
  assert.equal(normalizeLocale('tl'), 'fil');
  assert.equal(normalizeLocale('tl-PH'), 'fil');
  assert.equal(normalizeLocale('fil-PH'), 'fil');
  assert.equal(normalizeLocale('in-ID'), 'id');
  assert.equal(normalizeLocale('id-ID'), 'id');
});

test('anything unrecognised lands on English rather than on nothing', () => {
  // Nothing here may return a locale with no files — that is the blank-label
  // failure, which is silent.
  for (const raw of ['de', 'fr-CA', 'xx', 'klingon', '-', '   ', '', null, undefined, 0, NaN]) {
    assert.equal(normalizeLocale(raw), DEFAULT_LOCALE, `normalizeLocale(${JSON.stringify(raw)})`);
  }
  // `in` alone is ambiguous enough to leave alone — only the "in-XX" form is
  // the legacy Indonesian tag. Whatever it maps to, it must be loadable.
  assert.ok(PREFLIGHT_LOCALES.includes(normalizeLocale('in')));
});

test('normalizeLocale can only ever return a locale that exists', () => {
  const inputs = [
    ...PREFLIGHT_LOCALES, 'en-GB', 'zh', 'zh-CN', 'zh-Hant', 'tl', 'in-ID',
    'pt-BR', 'ru', 'ar-EG', 'i', 'e', '-tw', 'hant', 'thx', 'ide', 'file',
  ];
  for (const raw of inputs) {
    assert.ok(
      PREFLIGHT_LOCALES.includes(normalizeLocale(raw)),
      `normalizeLocale(${JSON.stringify(raw)}) → ${normalizeLocale(raw)}, which has no config files`
    );
  }
});

// ── preferredLocale ──────────────────────────────────────────────────────────

const fakeStore = (v) => ({ getItem: (k) => (k === 'mps.lang' ? v : null) });

test('the title bar outranks whatever this pane last ran as', () => {
  // The user changing the app language is a statement of intent; settings.locale
  // is only a record of the past.
  assert.equal(preferredLocale('ja', fakeStore('th'), { language: 'ko' }), 'th');
});

test('the saved pane locale outranks the OS guess', () => {
  assert.equal(preferredLocale('ja', fakeStore(null), { language: 'ko' }), 'ja');
});

test('with nothing saved, the OS is better than assuming English', () => {
  assert.equal(preferredLocale(null, fakeStore(null), { language: 'ko-KR' }), 'ko');
  assert.equal(preferredLocale('', fakeStore(null), { language: 'de-DE' }), DEFAULT_LOCALE);
  assert.equal(preferredLocale(null, fakeStore(null), null), DEFAULT_LOCALE);
  assert.equal(preferredLocale(null, fakeStore(null), {}), DEFAULT_LOCALE);
});

test('storage that throws does not take the pane down with it', () => {
  // The renderer is loaded with loadFile() — a file:// document — where reading
  // localStorage can throw outright rather than return null. This runs during
  // init(), so an uncaught throw here means the pane never starts.
  const hostile = { getItem() { throw new Error('SecurityError'); } };
  assert.equal(preferredLocale('th', hostile, { language: 'ko' }), 'th');
  assert.equal(preferredLocale(null, hostile, { language: 'ko' }), 'ko');
});

test('a title-bar value is normalized, not trusted', () => {
  assert.equal(preferredLocale(null, fakeStore('zh-CN'), null), DEFAULT_LOCALE);
  assert.equal(preferredLocale(null, fakeStore('en-GB'), null), 'en');
});

// ── the files behind the promise ─────────────────────────────────────────────

test('every offered locale has all three of its config files', () => {
  const missing = [];
  for (const l of PREFLIGHT_LOCALES) {
    for (const f of [`ui_strings.${l}.json`, `checks.i18n.${l}.json`, `requirements.i18n.${l}.json`]) {
      if (!existsSync(join(ROOT, 'src/tools/preflight/config', f))) missing.push(f);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `locale.js offers a language whose config is not on disk. loadConfig's safeJson ` +
      `swallows the 404 and returns an empty dictionary, so this renders blank ` +
      `labels rather than failing:\n` + missing.map((f) => `  ${f}`).join('\n')
  );
});

test('the pane offers exactly what the title bar offers', () => {
  // Both directions matter. A language in the picker but not here is the
  // original bug — the user picks it and the pane quietly stays English. A
  // language here but not in the picker is unreachable code pretending to be a
  // feature.
  const picker = [...INDEX_HTML.matchAll(/<option value="([\w-]+)"[^>]*>\s*[^<]*<\/option>/g)]
    .map((m) => m[1]);
  const langSelect = /<select id="langSelect"[\s\S]*?<\/select>/.exec(INDEX_HTML);
  assert.ok(langSelect, '#langSelect is gone from src/index.html; this test no longer proves anything');
  const hostLocales = [...langSelect[0].matchAll(/value="([\w-]+)"/g)].map((m) => m[1]);

  assert.ok(hostLocales.length >= 7, `only ${hostLocales.length} host languages parsed; the scan broke`);
  assert.ok(picker.length > 0);
  assert.deepEqual(
    [...hostLocales].sort(),
    [...PREFLIGHT_LOCALES].sort(),
    'the host language picker and PREFLIGHT_LOCALES have drifted apart'
  );
});

// ── the wiring ───────────────────────────────────────────────────────────────

test('the two ends of the language broadcast agree on the message name', () => {
  // paneLang.js posts it, app.js listens for it, and nothing checks the string
  // matches. If they drift the pane simply never changes language, which is
  // indistinguishable from the bug this replaced.
  const sent = /LANG_MESSAGE\s*=\s*['"]([^'"]+)['"]/.exec(PANE_LANG);
  assert.ok(sent, 'LANG_MESSAGE is no longer a literal in paneLang.js');
  assert.ok(
    APP_CODE.includes(`d.type !== "${sent[1]}"`) || APP_CODE.includes(`d.type !== '${sent[1]}'`),
    `paneLang.js broadcasts "${sent[1]}" but preflight/app.js does not listen for it`
  );
});

test('changing language does not reload the pane', () => {
  // state.files holds File objects that are deliberately not persisted, so a
  // reload throws away everything the user selected — and what comes back is a
  // stored run whose card titles were baked in the previous language anyway.
  // The reload cost the files and did not even fix the text.
  assert.ok(
    !/location\s*\.\s*reload\s*\(/.test(APP_CODE),
    'preflight/app.js calls location.reload(); a language change must not discard state.files'
  );
});

test('the dead picker is gone rather than merely bypassed', () => {
  assert.ok(
    !APP_CODE.includes('localeSelect'),
    'app.js still references #localeSelect, an element app/index.html has never contained'
  );
});

test('applyStaticLabels binds no listeners', () => {
  // It runs once at init and again on every language change. An
  // addEventListener inside it turns one click into two, then three.
  const body = /function applyStaticLabels\(\)\s*\{[\s\S]*?\n\}/.exec(APP_CODE);
  assert.ok(body, 'applyStaticLabels is gone or no longer a function declaration');
  assert.ok(
    !/addEventListener/.test(body[0]),
    'applyStaticLabels binds a listener; it is called repeatedly, so handlers would stack'
  );
  // And it must actually still do the work it was extracted to do.
  assert.ok(/setText\(/.test(body[0]), 'applyStaticLabels no longer writes any labels');
});

test('relocalize loads the new config before mutating anything', () => {
  // Order is the whole safety property: if loadConfig fails, the pane must be
  // left in the language it was in rather than half-translated.
  const body = /async function relocalize\([\s\S]*?\n\}/.exec(APP_CODE);
  assert.ok(body, 'relocalize is gone or no longer an async function declaration');
  const load = body[0].indexOf('await loadConfig(');
  const assign = body[0].indexOf('state.config = ');
  assert.ok(load > -1 && assign > -1, 'relocalize no longer loads or assigns config');
  assert.ok(load < assign, 'relocalize assigns state.config before the load that could fail');
  assert.ok(/catch/.test(body[0]), 'relocalize does not handle a failed config load');
});
