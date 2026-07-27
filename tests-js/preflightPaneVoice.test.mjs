// tests-js/preflightPaneVoice.test.mjs
// The Preflight pane speaks seven languages about your delivery. This checks it
// speaks them about itself too.
//
// WHY THIS EXISTS
// The pane ships ~148K of translated check text in seven locales — every check
// title, every severity, every "here is how to fix it" paragraph — and locale.js
// picks the right one from the OS language. So a Thai producer reads the entire
// delivery spec in Thai, presses Run, and used to get:
//
//     Preflight failed: Failed to fetch
//
// Two separate defects welded into one line. The label was an English literal
// that no dictionary could see, and the tail was an exception's own text —
// "Failed to fetch", "NotReadableError", "The user aborted a request" — which is
// not a sentence anybody outside this codebase can act on, in any language.
// Eight of app.js's nine alert() calls looked like that; five of them pasted the
// raw exception. The ninth already read `state.config.ui.labels.select_scope_first`,
// which is how we know the pattern was understood and simply had not been
// applied.
//
// WHAT IS PINNED HERE
//   1. No alert() and no progress label in the controller is a bare English
//      literal. Every one goes through paneLabel / paneText / failureAlert.
//   2. No alert() hands the user an exception's own `.message`.
//   3. Every key those call sites name exists in all seven shipped configs —
//      because paneLabel falls back to English silently, a missing key is not a
//      crash, it is an invisible regression to English.
//   4. The English cell in ui_strings.en.json is byte-identical to the fallback
//      written at the call site. If those drift, English users and the English
//      config disagree and nobody finds out.
//   5. No locale cell is the English string back again.
//   6. Every {placeholder} in an English cell survives into all six
//      translations. A translator who drops {count} does not throw — the number
//      just never appears.
//   7. failureReason answers with a sentence, never with the exception text, for
//      the four failure families this pane can actually produce.
//   8. The console.error next to each raw-exception site is still there. Taking
//      the exception out of the dialog is only defensible because the technical
//      detail moved to the console rather than vanishing.
//
// WHAT THIS CANNOT SEE
//   - Whether the six translations read well. It proves the cells exist, are not
//     English, and keep their placeholders. Not that they are good Thai. All 174
//     new cells are machine-authored and want a native-speaker pass.
//   - Whether locale.js picks the right file at runtime. That is its own
//     concern; nothing here mounts the pane.
//   - The pane's OTHER surface: ui.js's nineteen `labels?.key || "English"`
//     reads are the convention this work copied, and they are not gated here.
//     Two of them were found reading keys that no config defines — see the
//     absent-key test at the bottom, which is the narrow part of that gap this
//     iteration closed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { paneLabel, paneText, failureReason, failureAlert } from '../src/tools/preflight/app/paneText.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(ROOT + p, 'utf8');

const APP_PATH = 'src/tools/preflight/app/app.js';
const UI_PATH = 'src/tools/preflight/app/ui.js';
const CONFIG_DIR = 'src/tools/preflight/config/';

const app = read(APP_PATH);
const appLines = app.split('\n');

// locale.js is the authority on which locales ship; hardcoding the list here
// would let a new locale be added without its cells being checked.
const LOCALES = (() => {
  const m = read('src/tools/preflight/app/locale.js').match(/PREFLIGHT_LOCALES\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'PREFLIGHT_LOCALES is gone from locale.js');
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
})();

const labelsOf = (locale) =>
  JSON.parse(read(`${CONFIG_DIR}ui_strings.${locale}.json`)).ui_language.labels;

// ── Floors: the file still looks like the file this checks ────────────────────

test('floor: the controller still has the call sites this gates', () => {
  const alerts = appLines.filter((l) => /\balert\s*\(/.test(l));
  assert.equal(alerts.length, 9, `expected 9 alert() calls in the controller, found ${alerts.length}`);
  assert.ok(LOCALES.length === 7, `expected 7 shipped locales, locale.js lists ${LOCALES.length}`);
  assert.match(app, /import \{ paneLabel, paneText, failureAlert \} from "\.\/paneText\.js";/,
    'app.js no longer imports the pane-text helpers');
});

// ── 1 + 2. Nothing English, nothing raw, reaches a dialog ────────────────────

// Pull the string literals out of an expression, ignoring the ones that are
// already an argument to paneLabel/paneText/failureAlert — those ARE the
// fallbacks and are supposed to be English. Comment lines are stripped first;
// a sentence in a `//` comment is not something a user sees.
function bareEnglishIn(expr) {
  // The lookahead has to include `}` — several of these calls are the last
  // property of an object literal, so what follows the helper's closing paren
  // is ` }`, not a comma. Leaving it out made the strip fail on app.js:943 and
  // reported the helper's own fallback as untranslated English.
  const withoutHelpers = expr.replace(
    /\b(?:paneLabel|paneText|failureAlert)\s*\([\s\S]*?\)\s*(?=[,)\];}]|$)/g, '');
  return [...withoutHelpers.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)]
    .map((m) => m[2].replace(/\$\{[\s\S]*?\}/g, ''))
    .filter((s) => /[A-Za-z]{4,}/.test(s));
}

test('no alert() shows a bare English literal', () => {
  const offenders = appLines
    .map((l, i) => ({ n: i + 1, l }))
    .filter(({ l }) => /\balert\s*\(/.test(l) && !/^\s*(\/\/|\*)/.test(l))
    .filter(({ l }) => bareEnglishIn(l.slice(l.indexOf('alert('))).length > 0)
    .map(({ n, l }) => `${APP_PATH}:${n}  ${l.trim().slice(0, 100)}`);
  assert.deepEqual(offenders, [],
    `English hardcoded into a dialog in a pane that speaks 7 languages:\n  ${offenders.join('\n  ')}`);
});

test('no alert() hands the user an exception message', () => {
  // The species: `alert(\`Preflight failed: ${e?.message || e}\`)`. Match on the
  // access, not on any particular variable name, so a rename does not smuggle
  // one back in.
  const offenders = appLines
    .map((l, i) => ({ n: i + 1, l }))
    .filter(({ l }) => /\balert\s*\(/.test(l) && !/^\s*(\/\/|\*)/.test(l))
    .filter(({ l }) => /\w+\s*\??\.\s*message\b|\bString\s*\(\s*e\w*\s*\)/.test(l))
    .map(({ n, l }) => `${APP_PATH}:${n}  ${l.trim().slice(0, 100)}`);
  assert.deepEqual(offenders, [],
    `a raw exception is being shown in a dialog again:\n  ${offenders.join('\n  ')}`);
});

test('no progress label or meta line is a bare English literal', () => {
  // These are what a producer stares at during a long scan wondering whether it
  // has hung. `meta: \`0/${arr.length}\`` is digits and a slash — no dictionary
  // needed — which is why the filter requires four consecutive letters.
  const offenders = appLines
    .map((l, i) => ({ n: i + 1, l }))
    .filter(({ l }) => /^\s*(?:label|meta)\s*:|[{,]\s*(?:label|meta)\s*:/.test(l))
    .filter(({ l }) => !/^\s*(\/\/|\*)/.test(l))
    .filter(({ l }) => bareEnglishIn(l).length > 0)
    .map(({ n, l }) => `${APP_PATH}:${n}  ${l.trim().slice(0, 100)}`);
  assert.deepEqual(offenders, [],
    `untranslated English on the progress strip:\n  ${offenders.join('\n  ')}`);
});

// ── 3 + 4. Every key the code names is in every config, with matching English ─

// Read (key, fallback) pairs straight out of the source. Deriving the list this
// way means a twenty-sixth key added next month is checked without anyone
// remembering to come back here.
const CALL_RE = /\b(?:paneLabel|paneText|failureAlert)\s*\(\s*[A-Za-z_$][\w$.?]*\s*,\s*"([^"]+)"\s*,\s*"((?:[^"\\]|\\.)*)"/g;

const CALL_SITES = (() => {
  const out = new Map();
  for (const m of app.matchAll(CALL_RE)) {
    const key = m[1];
    const fallback = JSON.parse(`"${m[2]}"`);
    const prev = out.get(key);
    // The same key is read from several places (three rescan catches, two import
    // loops). They must all state the same fallback, or which one a user sees
    // depends on which code path failed.
    if (prev !== undefined) {
      assert.equal(fallback, prev,
        `key "${key}" has two different English fallbacks in app.js: ${JSON.stringify(prev)} vs ${JSON.stringify(fallback)}`);
    }
    out.set(key, fallback);
  }
  return out;
})();

// paneText.js carries its own fallbacks for the failure sentences, in tables
// rather than at a call site. Same contract, different shape — two shapes, in
// fact: BY_NAME rows open with the key (`['err_permission', '…']`) and
// BY_MESSAGE rows open with a regex (`[/…/i, 'err_offline', '…']`), so it takes
// two patterns to see both.
const REASON_KEYS = (() => {
  const src = read('src/tools/preflight/app/paneText.js');
  const out = new Map();
  for (const re of [/\[\s*'(err_\w+)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*\]/g,
                    /'(err_\w+)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*\]/g]) {
    for (const m of src.matchAll(re)) out.set(m[1], m[2].replace(/\\'/g, "'"));
  }
  return out;
})();

test('floor: key extraction found the call sites, not nothing', () => {
  // 17 keys at call sites + 7 err_* sentences = the 24 the controller can name.
  // The configs hold 25 of them; the extra is `views`, read by renderApp rather
  // than passed to a helper, and checked at the bottom of this file. Exact
  // equality rather than a floor: a key that disappears is as interesting as
  // one that appears, and both should make somebody look here.
  assert.equal(CALL_SITES.size, 17, `extracted ${CALL_SITES.size} keys from app.js, expected 17`);
  assert.equal(REASON_KEYS.size, 7, `extracted ${REASON_KEYS.size} err_* keys from paneText.js, expected 7`);
});

test('every key the pane reads exists in all seven shipped configs', () => {
  // paneLabel falls back to English silently — by design, so a half-translated
  // config degrades instead of crashing. That is also why a missing key is
  // invisible in the app and has to be caught here.
  const missing = [];
  const wanted = [...CALL_SITES.keys(), ...REASON_KEYS.keys()];
  for (const locale of LOCALES) {
    const labels = labelsOf(locale);
    for (const key of wanted) {
      const v = labels[key];
      if (typeof v !== 'string' || !v.trim()) missing.push(`${locale}: ${key}`);
    }
  }
  assert.deepEqual(missing, [],
    `these locales will silently show English for these keys:\n  ${missing.join('\n  ')}`);
});

test('the English config matches the fallback written at the call site', () => {
  // Two sources of truth for the same sentence. If they drift, an English user
  // sees one string and a translator is handed the other.
  const drift = [];
  const en = labelsOf('en');
  for (const [key, fallback] of [...CALL_SITES, ...REASON_KEYS]) {
    if (en[key] !== fallback) {
      drift.push(`${key}\n      code:   ${JSON.stringify(fallback)}\n      config: ${JSON.stringify(en[key])}`);
    }
  }
  assert.deepEqual(drift, [],
    `ui_strings.en.json and the code fallbacks disagree:\n    ${drift.join('\n    ')}`);
});

// ── 5. No cell is the English back again ─────────────────────────────────────

test('no locale cell is just the English string again', () => {
  // A row that copies the English passes a naive "is it present" check while
  // showing English to the user — the exact failure this file exists to catch,
  // one level down.
  const en = labelsOf('en');
  const echoes = [];
  const wanted = [...CALL_SITES.keys(), ...REASON_KEYS.keys()];
  for (const locale of LOCALES.filter((l) => l !== 'en')) {
    const labels = labelsOf(locale);
    for (const key of wanted) {
      if (labels[key] && en[key] && labels[key].trim() === en[key].trim()) {
        echoes.push(`${locale}/${key}: ${JSON.stringify(labels[key])}`);
      }
    }
  }
  assert.deepEqual(echoes, [], `identity translations:\n  ${echoes.join('\n  ')}`);
});

// ── 6. Placeholders survive translation ──────────────────────────────────────

test('every {placeholder} survives into all seven locales', () => {
  // paneText substitutes by name. A cell that drops {count} does not throw —
  // the number just never appears, which is worse than an error because the
  // line still looks finished.
  const en = labelsOf('en');
  const lost = [];
  const names = (s) => new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
  for (const key of CALL_SITES.keys()) {
    const want = names(en[key]);
    if (!want.size) continue;
    for (const locale of LOCALES) {
      const got = names(labelsOf(locale)[key]);
      if ([...want].some((n) => !got.has(n)) || [...got].some((n) => !want.has(n))) {
        lost.push(`${locale}/${key}: [${[...got].sort()}] != [${[...want].sort()}]`);
      }
    }
  }
  assert.deepEqual(lost, [], `placeholders dropped or invented in translation:\n  ${lost.join('\n  ')}`);
});

test('paneText actually substitutes, in every locale', () => {
  // The floor under the test above: proves the substitution runs and that no
  // brace is left behind in the rendered string.
  for (const locale of LOCALES) {
    const config = { ui: { labels: labelsOf(locale) } };
    const out = paneText(config, 'meta_imported', 'x', { done: 3, total: 12, added: 2 });
    assert.match(out, /3/, `${locale}: meta_imported lost {done}: ${out}`);
    assert.match(out, /12/, `${locale}: meta_imported lost {total}: ${out}`);
    assert.doesNotMatch(out, /\{\w+\}/, `${locale}: an unsubstituted placeholder shipped: ${out}`);
  }
});

// ── 7. failureReason answers with a sentence, not an exception ───────────────

// Every entry is a failure this pane can actually produce — showDirectoryPicker,
// FileSystemFileHandle.getFile, fetch() on a config JSON, or reading a File are
// the only four things it does that can fail. `expect` is the key whose
// translated sentence should come back.
const FAILURES = [
  { what: 'the folder picker was denied', err: Object.assign(new Error('The request is not allowed by the user agent'), { name: 'NotAllowedError' }), expect: 'err_permission' },
  { what: 'a cross-origin config read', err: Object.assign(new Error('The operation is insecure.'), { name: 'SecurityError' }), expect: 'err_permission' },
  { what: 'the drive went away mid-read', err: Object.assign(new Error('The I/O read operation failed.'), { name: 'NotReadableError' }), expect: 'err_unreadable' },
  { what: 'the file was moved after being picked', err: Object.assign(new Error('A requested file or directory could not be found'), { name: 'NotFoundError' }), expect: 'err_missing' },
  { what: 'the disk filled up', err: Object.assign(new Error('Quota exceeded.'), { name: 'QuotaExceededError' }), expect: 'err_no_space' },
  { what: 'a config JSON could not be fetched', err: new TypeError('Failed to fetch'), expect: 'err_offline' },
  { what: 'the companion server is not running', err: new TypeError('NetworkError when attempting to fetch resource.'), expect: 'err_offline' },
  { what: 'a node-side ENOENT bubbled up', err: new Error('ENOENT: no such file or directory, open \'/Vol/Show_A/A001.mov\''), expect: 'err_missing' },
  { what: 'a node-side ENOSPC bubbled up', err: new Error('ENOSPC: no space left on device, write'), expect: 'err_no_space' },
  { what: 'a huge file blew the buffer', err: new RangeError('Array buffer allocation failed'), expect: 'err_too_large' },
  { what: 'something nobody predicted', err: new Error('kaboom 0x8badf00d'), expect: 'err_unknown' },
];

test('every failure this pane can produce gets a sentence, in every language', () => {
  const wrong = [];
  for (const locale of LOCALES) {
    const labels = labelsOf(locale);
    const config = { ui: { labels } };
    for (const f of FAILURES) {
      const got = failureReason(config, f.err);
      if (got !== labels[f.expect]) {
        wrong.push(`${locale} / ${f.what}\n      want ${f.expect}: ${JSON.stringify(labels[f.expect])}\n      got:            ${JSON.stringify(got)}`);
      }
    }
  }
  assert.deepEqual(wrong, [], `failureReason gave the wrong answer:\n    ${wrong.join('\n    ')}`);
});

test('the exception\'s own text never reaches the user', () => {
  // The point of the whole exercise. Every distinctive fragment of every
  // exception above must be absent from what comes back, in every locale.
  const leaked = [];
  for (const locale of LOCALES) {
    const config = { ui: { labels: labelsOf(locale) } };
    for (const f of FAILURES) {
      const out = failureAlert(config, 'preflight_failed', 'The preflight run failed.', f.err);
      for (const fragment of ['ENOENT', 'ENOSPC', 'Failed to fetch', 'NetworkError', '0x8badf00d',
                              '/Vol/Show_A/A001.mov', 'Quota exceeded', 'user agent', 'Array buffer']) {
        if (out.includes(fragment)) leaked.push(`${locale} / ${f.what}: ${JSON.stringify(fragment)} in ${JSON.stringify(out)}`);
      }
    }
  }
  assert.deepEqual(leaked, [], `exception text is reaching the dialog:\n  ${leaked.join('\n  ')}`);
});

test('an AbortError is not turned into an apology', () => {
  // Closing the folder picker is not a failure. Exactly two things in this pane
  // open one — rescanFolderAndRun and onPickForReq — and each filters AbortError
  // before it reaches the alert. failureReason deliberately has no rule for it,
  // so if a guard is ever dropped the user gets the vague-but-honest unknown
  // sentence rather than a confident wrong diagnosis about permissions.
  const config = { ui: { labels: labelsOf('th') } };
  const abort = Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
  assert.equal(failureReason(config, abort), labelsOf('th').err_unknown,
    'AbortError acquired a rule — check that cancelling still is not reported as a failure');

  // Count invocations, not mentions: line 341 is a comment about the picker and
  // 344 is the feature test for it, neither of which can throw.
  const pickers = appLines.filter((l) => /await\s+window\.showDirectoryPicker\s*\(/.test(l)
    && !/^\s*(\/\/|\*)/.test(l)).length;
  const guards = appLines.filter((l) => /AbortError/.test(l)).length;
  assert.equal(guards, pickers,
    `${pickers} folder pickers but ${guards} AbortError guards in app.js — one of them now alerts on cancel`);
});

test('a name match wins over a message match', () => {
  // A DOMException keeps the useful half of its identity in .name and loses it
  // the moment the browser rewords the message. If the order ever inverts, this
  // error — whose message says "not allowed" but whose name says the drive is
  // gone — would be diagnosed as a permissions problem.
  const labels = labelsOf('en');
  const config = { ui: { labels } };
  const err = Object.assign(new Error('read not allowed right now'), { name: 'NotReadableError' });
  assert.equal(failureReason(config, err), labels.err_unreadable,
    'the message table is being consulted before the name table');
});

test('paneLabel degrades to the fallback rather than to blank', () => {
  // The three ways a config can be partial. A pane that renders an empty dialog
  // is worse than one that renders English.
  assert.equal(paneLabel(undefined, 'x', 'F'), 'F', 'a missing config blanked the string');
  assert.equal(paneLabel({ ui: {} }, 'x', 'F'), 'F', 'a config with no labels blanked the string');
  assert.equal(paneLabel({ ui: { labels: { x: '   ' } } }, 'x', 'F'), 'F', 'a whitespace-only cell blanked the string');
  assert.equal(paneLabel({ ui: { labels: { x: 'ja' } } }, 'x', 'F'), 'ja', 'a real cell was ignored');
});

// ── 8. The technical detail moved, it did not vanish ─────────────────────────

test('every failureAlert site still logs the exception to the console', () => {
  // Taking the exception text out of the dialog is only defensible because it
  // is still written where a support engineer looks. If a console.error is ever
  // deleted, the detail is gone for good and the trade stops being a trade.
  const orphans = [];
  appLines.forEach((l, i) => {
    if (!/failureAlert\s*\(/.test(l)) return;
    // The log sits on a line just above, inside the same catch.
    const window = appLines.slice(Math.max(0, i - 4), i).join('\n');
    if (!/console\.(error|warn)\s*\(/.test(window)) orphans.push(`${APP_PATH}:${i + 1}  ${l.trim().slice(0, 80)}`);
  });
  assert.deepEqual(orphans, [],
    `these dialogs drop the exception without logging it anywhere:\n  ${orphans.join('\n  ')}`);
});

// ── The two keys the code read that no config defined ────────────────────────

test('keys read by the renderer are defined, not just fallen back on', () => {
  // Found while scanning for orphaned config keys, in the opposite direction:
  // ui.js:419 reads `drop_hint`, which existed in none of the seven files, and
  // app.js:411 reads `L.views`, which existed only in fil. Both rendered the
  // hardcoded English in every other language including English's own config.
  // The scan that found them had to match three access shapes — `labels.key`,
  // `L.key` after `const L = state.config.ui.labels`, and `labels["key"]`. A
  // scanner that matches only the first under-reports; that is how this check
  // came to be written against all three.
  const sources = { [APP_PATH]: app, [UI_PATH]: read(UI_PATH) };
  const readKeys = new Map();
  for (const [path, src] of Object.entries(sources)) {
    const body = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const seen = new Set();
    for (const re of [/\blabels\s*\??\.\s*(\w+)/g, /\bL\s*\??\.\s*(\w+)/g,
                      /\b(?:labels|L)\s*\??\[\s*['"](\w+)['"]\s*\]/g]) {
      for (const m of body.matchAll(re)) seen.add(m[1]);
    }
    for (const k of seen) if (!readKeys.has(k)) readKeys.set(k, path);
  }
  assert.ok(readKeys.size >= 20, `only found ${readKeys.size} label reads — did the scan shape change?`);

  const en = labelsOf('en');
  // Not every identifier after a `.` is a config key — `labels.length` and the
  // like are properties of whatever object happens to be named `L` elsewhere.
  // Only flag names that at least one shipped locale defines, plus the two this
  // iteration added, so the check cannot be satisfied by the code simply
  // stopping reading them.
  const anywhere = new Set(LOCALES.flatMap((l) => Object.keys(labelsOf(l))));
  const undefinedKeys = [...readKeys]
    .filter(([k]) => anywhere.has(k))
    .filter(([k]) => typeof en[k] !== 'string' || !en[k].trim())
    .map(([k, path]) => `${k} (read in ${path})`);
  assert.deepEqual(undefinedKeys, [],
    `the code reads these keys but ui_strings.en.json does not define them, so every ` +
    `language falls back to the hardcoded literal:\n  ${undefinedKeys.join('\n  ')}`);

  for (const k of ['drop_hint', 'views']) {
    assert.ok(readKeys.has(k), `${k} is no longer read — if that is deliberate, drop it from all seven configs`);
    for (const locale of LOCALES) {
      const v = labelsOf(locale)[k];
      assert.ok(typeof v === 'string' && v.trim(), `${locale} lost its ${k} cell again`);
    }
  }
});
