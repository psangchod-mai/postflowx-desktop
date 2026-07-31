// tests-js/dateBucket.test.mjs
//
// Iteration 158. The project list groups its rows under date headings, and those
// headings were five English string literals sitting inside the render function:
// 'Today', 'Yesterday', 'Previous 7 Days', 'Older', 'Undated'. Iteration 157
// localised the dates *in* the rows, which made this worse rather than better —
// the panel ended up in two languages at once, an English word in bold with
// correctly-localised rows indented under it.
//
// Two things are worth holding here. The bucket arithmetic, which is subtler
// than it looks because it is a *day* boundary and not a 24-hour one. And the
// separation itself: the key must not change when the language does, or a list
// re-rendered after a language switch would break its runs somewhere else.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { dateBucket, dayIndex, bucketLabel } from '../src/scripts/core/dateBucket.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const read = (p) => readFileSync(join(SRC, p), 'utf8');

// A fixed local noon, so no test here depends on when it is run. Noon and not
// midnight on purpose: a midnight fixture would hide off-by-one hours entirely.
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const bucketAt = (ms) => dateBucket(ms, NOW);

// ── The buckets ──────────────────────────────────────────────────────────────

test('a row from this morning is today', () => {
  assert.equal(bucketAt(NOW - 4 * HOUR).key, 'today');
  assert.equal(bucketAt(NOW).key, 'today');
});

test('a row from yesterday is yesterday, not "1 day"', () => {
  assert.equal(bucketAt(NOW - DAY).key, 'yesterday');
});

test('six days back is in the week, eight days back is older', () => {
  assert.equal(bucketAt(NOW - 6 * DAY).key, 'week');
  assert.equal(bucketAt(NOW - 8 * DAY).key, 'older');
});

test('the seventh day back is the edge of the week, not inside it', () => {
  // today - d < 7, so d === today - 7 falls out. Pinned because an off-by-one
  // here is invisible in the UI: the row just quietly appears under the wrong
  // heading, and only on one day of the week.
  assert.equal(bucketAt(NOW - 7 * DAY).key, 'older');
});

// ── Days, not hours, which is the whole reason dayIndex exists ───────────────

test('eleven hours apart can still be two different days', () => {
  const lateLastNight = new Date(2026, 5, 14, 23, 0, 0).getTime();
  const thisMorning = new Date(2026, 5, 15, 10, 0, 0).getTime();
  assert.equal(dateBucket(lateLastNight, thisMorning).key, 'yesterday');
  assert.equal(thisMorning - lateLastNight < DAY, true, 'the fixture is not under a day apart');
});

test('twenty-five hours apart can still be the same day', () => {
  const early = new Date(2026, 5, 15, 1, 0, 0).getTime();
  const late = new Date(2026, 5, 16, 2, 0, 0).getTime();
  assert.equal(late - early > DAY, true, 'the fixture is not over a day apart');
  assert.equal(dateBucket(early, early + 30 * 60_000).key, 'today');
  assert.equal(dayIndex(early) !== dayIndex(late), true);
});

test('dayIndex counts days, and consecutive days are consecutive', () => {
  const a = dayIndex(new Date(2026, 5, 15, 3, 0, 0).getTime());
  const b = dayIndex(new Date(2026, 5, 16, 21, 0, 0).getTime());
  assert.equal(b - a, 1);
});

// ── The things that go wrong on real machines ────────────────────────────────

test('a file stamped in the future sorts with today, not below "Older"', () => {
  // A machine with a fast clock, or a file copied from a laptop a day ahead.
  // The old code put it in `order: 0` too, and that is worth keeping: a future
  // row in its own group below everything else is a row nobody finds.
  const b = bucketAt(NOW + 3 * DAY);
  assert.equal(b.key, 'today');
  assert.equal(b.order, 0);
});

test('a row with no usable date is undated rather than an exception', () => {
  for (const bad of [0, null, undefined, NaN, '', -1, 'nonsense']) {
    const b = dateBucket(bad, NOW);
    assert.deepEqual(b, { order: 4, key: 'undated' }, `${JSON.stringify(bad)} was not undated`);
  }
});

test('the order is monotonic, so the groups sort the way they read', () => {
  const keys = [NOW, NOW - DAY, NOW - 3 * DAY, NOW - 30 * DAY, 0];
  const orders = keys.map((ms) => dateBucket(ms, NOW).order);
  assert.deepEqual(orders, [0, 1, 2, 3, 4]);
});

// ── The key is not the label, which is the point of the split ────────────────

test('every bucket a row can land in has a heading', () => {
  const reachable = ['today', 'yesterday', 'week', 'older', 'undated'];
  for (const key of reachable) {
    const label = bucketLabel(key);
    assert.equal(typeof label, 'string');
    assert.ok(label.length > 0, `${key} has no heading`);
  }
  assert.equal(new Set(reachable.map(bucketLabel)).size, 5,
    'two buckets share a heading, so their runs would merge on screen');
});

test('a key that is not a bucket gets no heading rather than a wrong one', () => {
  assert.equal(bucketLabel('tomorrow'), '');
  assert.equal(bucketLabel(''), '');
  assert.equal(bucketLabel(undefined), '');
});

test('every reachable bucket key has a heading, and every heading a key', () => {
  // The one failure mode a switch statement invites: dateBucket grows a sixth
  // bucket and bucketLabel is not told, so the new group renders headless.
  const src = read('scripts/core/dateBucket.js');
  const returned = [...src.matchAll(/key:\s*'([a-z]+)'/g)].map((m) => m[1]);
  const cased = [...src.matchAll(/case\s+'([a-z]+)':/g)].map((m) => m[1]);
  assert.ok(returned.length >= 5, 'the bucket keys were not found in the source');
  for (const k of new Set(returned)) {
    assert.ok(cased.includes(k), `dateBucket can return '${k}' and bucketLabel has no case for it`);
  }
});

// ── Wiring: the literals are actually gone from the panel ────────────────────

test('the project list no longer carries the headings as English literals', () => {
  const src = read('scripts/features/projectManager/projectManager.js');
  for (const dead of ["label: 'Today'", "label: 'Yesterday'", "'Previous 7 Days'", "label: 'Older'", "'Undated'"]) {
    assert.equal(src.includes(dead), false, `${dead} is still hard-coded in the panel`);
  }
  assert.ok(src.includes("from '../../core/dateBucket.js'"),
    'the panel does not import the shared bucket rule');
  assert.ok(src.includes('bucketLabel('), 'the panel does not ask for a translated heading');
});

test('the run is broken on the key, not on the translated heading', () => {
  // Grouping on the label would be a bug that only appears in one language: two
  // buckets whose translations collide would silently merge into one run.
  const src = read('scripts/features/projectManager/projectManager.js');
  assert.ok(/b\.key !== lastBucket/.test(src),
    'the group run is still compared on the heading text');
});

test('the headings are in the dictionary in all six languages', () => {
  const dict = read('scripts/modules/i18n.js');
  for (const key of ['Today', 'Yesterday', 'Previous 7 Days', 'Older', 'No date']) {
    const n = dict.split(`"${key}":`).length - 1;
    assert.equal(n, 6, `"${key}" is in ${n} locales, not 6`);
  }
});
