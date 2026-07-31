// tests-js/relativeTime.test.mjs
//
// Iteration 157. Four files each carried their own "N minutes ago" ladder, all
// four in English, and all four untranslatable in the shape they were written —
// they glued a number to the word "ago", which is not how the phrase is built in
// any of the six languages this app ships. trlconf even hand-coded the English
// plural rule as `${n === 1 ? '' : 's'}`.
//
// The replacement asks Intl. These tests hold the two things that matter: that
// the boundaries behave, and that the output is actually different per locale —
// because a shared helper that returns English everywhere would pass every
// structural check and fix nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { relativeTime, savedLabel, absoluteDateTime } from '../src/scripts/core/relativeTime.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const read = (p) => readFileSync(join(SRC, p), 'utf8');

const NOW = 1_800_000_000_000;      // a fixed clock, so nothing here is flaky
const ago = (ms) => NOW - ms;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

const at = (ms, lang) => relativeTime(ms, { now: NOW, lang });

// ── The reader's own language, which is the whole point ──────────────────────

test('the same moment reads differently in each of the six languages', () => {
  const langs = ['en', 'ko', 'ja', 'zh-TW', 'th', 'id', 'fil'];
  const out = langs.map((l) => at(ago(5 * MIN), l));
  for (const [i, s] of out.entries()) {
    assert.ok(s.length > 0, `${langs[i]} produced nothing`);
  }
  assert.ok(new Set(out).size >= 5,
    `seven locales produced only ${new Set(out).size} distinct strings: ${JSON.stringify(out)}`);
});

test('no locale is handed the English word "ago"', () => {
  for (const lang of ['ko', 'ja', 'zh-TW', 'th']) {
    for (const d of [5 * MIN, 3 * HOUR, 2 * DAY]) {
      assert.equal(/\bago\b/.test(at(ago(d), lang)), false,
        `${lang} at ${d}ms still says "ago"`);
    }
  }
});

test('the number is written the way the locale writes numbers', () => {
  // Not an assertion about digits — an assertion that the number is present at
  // all, in every locale, which a naive dictionary lookup would have lost.
  for (const lang of ['en', 'ko', 'ja', 'th', 'id', 'fil']) {
    assert.match(at(ago(5 * MIN), lang), /\d|٥|五/, `${lang} dropped the count`);
  }
});

// ── Boundaries ───────────────────────────────────────────────────────────────

test('something that just happened does not read as a count', () => {
  assert.equal(/\d/.test(at(NOW, 'en')), false, 'zero seconds ago showed a number');
  assert.equal(at(NOW, 'en'), at(ago(30_000), 'en'), '30s should still be "now"');
});

test('a clock that ran backwards reads as now, not as the future', () => {
  const future = NOW + 10 * MIN;
  const s = at(future, 'en');
  assert.equal(/in \d/.test(s), false, `a future timestamp rendered as ${JSON.stringify(s)}`);
  assert.equal(s, at(NOW, 'en'));
});

test('minutes, hours and days each get their own unit', () => {
  assert.match(at(ago(5 * MIN), 'en'), /minute/);
  assert.match(at(ago(3 * HOUR), 'en'), /hour/);
  assert.match(at(ago(3 * DAY), 'en'), /day/);
});

test('one day ago is the idiom, not the arithmetic', () => {
  assert.equal(at(ago(25 * HOUR), 'en'), 'yesterday');
});

test('anything older than a week becomes a date', () => {
  const s = at(ago(40 * DAY), 'en');
  assert.equal(/ago|yesterday/.test(s), false, `${JSON.stringify(s)} is still relative`);
  assert.match(s, /\d{4}/, 'the date has no year in it');
});

test('the boundary between hours and days is a day, not a rounding accident', () => {
  assert.match(at(ago(23 * HOUR), 'en'), /hour/);
  assert.equal(/hour/.test(at(ago(25 * HOUR), 'en')), false);
});

// ── Totality: a status pill is the wrong place to throw ──────────────────────

test('no timestamp produces no label rather than an exception', () => {
  for (const bad of [0, null, undefined, NaN, '', -1, 'nonsense']) {
    assert.equal(relativeTime(bad, { now: NOW }), '', `${JSON.stringify(bad)} produced a label`);
  }
});

test('an unrecognised language falls back instead of throwing', () => {
  assert.ok(at(ago(5 * MIN), 'not-a-locale!!').length > 0);
  assert.ok(at(ago(5 * MIN), '').length > 0);
});

// ── The save pill ────────────────────────────────────────────────────────────

test('the pill puts the time inside a sentence, not after a bare English word', () => {
  const s = savedLabel(ago(5 * MIN), { now: NOW, lang: 'en' });
  assert.ok(s.includes(at(ago(5 * MIN), 'en')), 'the pill lost the time');
  assert.equal(s.includes('{when}'), false, 'the placeholder was not filled in');
});

test('the pill says nothing when nothing has been saved', () => {
  assert.equal(savedLabel(0, { now: NOW }), '');
  assert.equal(savedLabel(null, { now: NOW }), '');
});

// ── The tooltip that says what "3 days ago" actually was ─────────────────────

test('the exact timestamp is spelled out in the reader’s language too', () => {
  const out = ['en', 'ko', 'ja', 'zh-TW', 'th'].map((l) => absoluteDateTime(NOW, { lang: l }));
  for (const s of out) assert.ok(s.length > 0);
  assert.ok(new Set(out).size >= 4,
    `the tooltip is the same text in five languages: ${JSON.stringify(out)}`);
  assert.equal(/\bJan\b|\bFeb\b|\bMar\b/.test(absoluteDateTime(NOW, { lang: 'th' })), false,
    'the Thai tooltip still uses an English month abbreviation');
});

test('the tooltip carries the time of day, not just the date', () => {
  assert.match(absoluteDateTime(NOW, { lang: 'en' }), /\d:\d{2}/);
});

test('the tooltip has nothing to say about a missing timestamp', () => {
  for (const bad of [0, null, undefined, NaN, -1]) {
    assert.equal(absoluteDateTime(bad), '');
  }
});

// ── Wiring: the four ladders are actually gone ───────────────────────────────

test('ui.js no longer builds the phrase out of "m ago"', () => {
  const src = read('scripts/ui.js');
  assert.equal(/\$\{Math\.floor\(s\/60\)\}m ago/.test(src), false);
  assert.ok(/from "\.\/core\/relativeTime\.js"/.test(src), 'ui.js does not import the rule');
  assert.ok(src.includes('savedLabel(__lastSaveMs)'),
    "the save pill is not built from the locale's own sentence");
});

test('the project list no longer has its own English month names', () => {
  const src = read('scripts/features/projectManager/projectManager.js');
  assert.equal(/'Jan','Feb','Mar'/.test(src), false,
    'the hand-written month-name array is still there');
  assert.equal(/return 'Yesterday';/.test(src), false);
  assert.ok(/relativeTime/.test(src), 'projectManager does not use the shared rule');
});

// The conform badge in features/trlconf was wired to the shared rule too, but
// the function it lives in does not exist in the last commit — it is part of a
// larger unlanded change in that file. Asserting on it here would pin a test to
// a working tree, so the assertion waits until that work lands.

test('the render queue reaches the rule through the window bridge', () => {
  // It is a classic <script src> in index.html, so it has no import statement
  // available to it — which is why it kept the fourth copy of the ladder for as
  // long as it did. The bridge is the same one i18n.js publishes for t().
  const html = read('index.html');
  assert.match(html, /<script src="scripts\/render_queue\.js" defer><\/script>/,
    'render_queue.js is a module now — it can import the rule directly');

  const rq = read('scripts/render_queue.js');
  assert.ok(rq.includes('window.PFX_relTime'), 'the render queue is not on the shared rule');
  assert.equal(/\$\{s\}s ago/.test(rq), false, 'the hand-rolled seconds ladder is still there');
  assert.equal(/\$\{Math\.floor\(s\/60\)\}m ago/.test(rq), false,
    'the hand-rolled minutes ladder is still there');
});

test('the bridge is published, and does not need a DOM to be imported', () => {
  // The publish is guarded: this very test file imports the module in node,
  // where `window` does not exist, and an unguarded assignment would throw at
  // import time and take the whole suite with it.
  const src = read('scripts/core/relativeTime.js');
  assert.ok(src.includes('window.PFX_relTime = relativeTime'), 'the bridge is not published');
  assert.ok(src.includes('window.PFX_absTime = absoluteDateTime'), 'the tooltip has no bridge');
  assert.match(src, /try \{[^}]*window\.PFX_relTime/s, 'the bridge assignment is not guarded');
  // And the proof it holds: we got here, having imported the module at the top.
  assert.equal(typeof relativeTime, 'function');
});
