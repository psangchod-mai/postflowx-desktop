// tests-js/domContract.test.mjs
// The renderer may not look up an element id that nothing defines.
//
// Three consecutive iterations of this project each found the same bug by hand,
// in three different files, and each one had been shipping for months:
//
//     ui.js             $("#errors")       — 66 error messages, none displayed
//     bwav/app.js       #localeSelect      — 6 translations, none selectable
//     preflight/app.js  #localeSelect      — 18 locale files, none selectable
//
// None of them threw. getElementById returned null, the `if (!el) return` beside
// it read that as "nothing to do", and the feature was off with no error, no log
// line, and no way for the user to tell a refused action from a broken app. For
// a tool aimed at people who are not engineers, that is the worst failure shape
// available: the button is there, it looks enabled, and pressing it does nothing.
//
// So the sweep was run across the whole tree, and it found 311 such ids across
// 440 lookup sites — of which 0 crash, 6 are a deliberate `a || b` fallback, and
// 434 do nothing at all, quietly. Reading them showed the honest answer: they
// are mostly *drift*, not a backlog of 311 bugs. A pane gets redesigned, an
// element is renamed, and the old lookup stays behind next to a working
// replacement. Fixing them wholesale would be busywork with a real chance of
// breaking something that currently works.
//
// The value is therefore not in the 311. It is in making 312 impossible. This
// file freezes the known set and fails on anything new, which turns a bug that
// took three lucky discoveries into one that cannot be committed.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { walk, definedIds, idReads, classify } from './lib/domIds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'tests-js/fixtures/phantom-ids.json');
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

const files = walk(join(ROOT, 'src'), ['.js', '.html'], ROOT);
const defined = definedIds(files);
const reads = idReads(files, undefined, ROOT);
const missing = reads.filter((r) => !defined.has(r.id));

// ── the scan has to work before anything it reports means anything ───────────

test('the scan actually sees the tree', () => {
  // A test that greps can pass by finding nothing, which is the exact failure
  // this file exists to prevent. Pin the orders of magnitude.
  assert.ok(files.length > 100, `only ${files.length} source files found`);
  assert.ok(defined.size > 1000, `only ${defined.size} ids defined`);
  assert.ok(reads.length > 1000, `only ${reads.length} id lookups found`);
});

test('an id defined only inside a template literal still counts as defined', () => {
  // #eventScroll exists nowhere in any .html file — ui.js mints it from a
  // backtick string. Most of this renderer's markup works that way, so a scan
  // that read HTML alone would report hundreds of live elements as missing and
  // the baseline would be worthless.
  assert.ok(defined.has('eventScroll'), 'template-literal markup is not being scanned');
  assert.ok(defined.has('langSelect'), 'static index.html markup is not being scanned');
  assert.ok(!defined.has('pfxDefinitelyNotARealElementId'), 'the definition scan matches anything');
});

test('a comment mentioning an id does not create the element', () => {
  // This is not hypothetical. errorBanner.js opens by explaining that no element
  // with id="errors" has ever existed — and that sentence, quoted verbatim in a
  // comment, was enough to make the scan believe the element was there. The
  // documentation of a bug registered as its fix. Three other ids were hidden
  // the same way.
  assert.ok(!defined.has('errors'), 'a commented-out id is being counted as defined');
  assert.ok(
    /No element with id="errors" has ever existed/.test(
      readFileSync(join(ROOT, 'src/scripts/core/errorBanner.js'), 'utf8')
    ),
    'the comment this guards against was reworded; the test no longer proves anything'
  );
});

// ── classify(), including the two branches real code does not currently hit ──

test('classify distinguishes what a missing element costs', () => {
  assert.equal(classify('const x = ', '.textContent = 1', 'foo', ''), 'crash');
  assert.equal(classify('const x = ', ' || $("#bar")', 'foo', ''), 'fallback');
  assert.equal(classify('const x = ', ';', 'foo', ''), 'silent');
  assert.equal(classify('const x = ', '?.textContent', 'foo', ''), 'silent');
});

test('a same-line guard is recognised as a guard', () => {
  // `if ($("#kFps")) $("#kFps").textContent = x` — the second lookup is
  // dereferenced, but the first one is the guard. Without this, ui.js reports
  // three crashes that cannot happen.
  assert.equal(classify('if ($("#kFps")) $("#kFps")', '.textContent = x', 'kFps', ''), 'silent');
  assert.equal(classify('  ', '.textContent = x', 'kFps', ''), 'crash');
});

test('a dereference on the following line is caught', () => {
  // No phantom id in the tree currently does this, so without a synthetic case
  // this branch would be dead code inside the very check meant to find dead
  // code.
  assert.equal(classify('  const el = ', ';', 'foo', '  el.textContent = 1;'), 'crash');
  // With the receiver still attached, which is what real source looks like.
  // Anchored hard on `=`, this branch matched the repo's own $("#x") helper and
  // nothing else — it passed the line above while never firing on a real file.
  assert.equal(classify('  const el = document.', ';', 'foo', '  el.textContent = 1;'), 'crash');
  assert.equal(classify('  const el = doc.body.', ';', 'foo', '  el.textContent = 1;'), 'crash');
  assert.equal(classify('  const el = ', ';', 'foo', '  el?.textContent = 1;'), 'silent');
  assert.equal(classify('  const el = ', ';', 'foo', '  if (el) el.textContent = 1;'), 'silent');
  assert.equal(classify('  const el = ', ';', 'foo', null), 'silent');
});

// ── the gates ────────────────────────────────────────────────────────────────

test('no element lookup is dereferenced without a guard', () => {
  // This one is at zero and must stay there. Every id below resolves to null,
  // so a bare `.textContent` on it throws — and an uncaught throw in a renderer
  // handler abandons whatever the user was in the middle of.
  const crashes = missing.filter((r) => r.kind === 'crash');
  assert.deepEqual(
    crashes.map((r) => `${r.file}:${r.line} #${r.id} — ${r.text}`),
    [],
    'a lookup that cannot succeed is dereferenced anyway'
  );
});

test('no element id is looked up that nothing defines', () => {
  const known = new Set(baseline);
  const fresh = [...new Set(missing.filter((r) => !known.has(r.id)).map((r) => r.id))].sort();
  assert.deepEqual(
    fresh,
    [],
    `new phantom element id(s). Nothing in src/ creates these, so every lookup ` +
      `returns null and the code around it silently does nothing:\n` +
      fresh.map((id) => `  #${id}  ${missing.filter((r) => r.id === id).map((r) => `${r.file}:${r.line}`).join(' ')}`).join('\n') +
      `\n\nFix the id, or — if the lookup is deliberately optional — add it to ` +
      `tests-js/fixtures/phantom-ids.json with a note in the commit message.`
  );
});

test('the baseline does not outlive what it describes', () => {
  // The failure mode this project keeps hitting is a stale claim, not a stale
  // fix: an audit note said the tool panes had no translations long after they
  // had three sets. A frozen list of known-bad ids rots the same way. Once an id
  // is defined, its entry has to go, or the list slowly stops meaning anything.
  const stale = baseline.filter((id) => defined.has(id));
  assert.deepEqual(
    stale,
    [],
    `these ids now exist and must be deleted from tests-js/fixtures/phantom-ids.json:\n` +
      stale.map((id) => `  #${id}`).join('\n')
  );
});

test('the baseline only ever shrinks', () => {
  const live = new Set(missing.map((r) => r.id));
  assert.ok(
    baseline.length <= 311,
    `the baseline grew to ${baseline.length}; it is a debt list, not a parking lot`
  );
  assert.ok(
    [...live].every((id) => baseline.includes(id)),
    'a live phantom is missing from the baseline'
  );
});

test('the baseline is sorted and free of duplicates', () => {
  // Purely so its diffs stay readable — a list this long is only reviewable if
  // an entry appears in one predictable place.
  assert.deepEqual(
    baseline,
    [...new Set(baseline)].sort(),
    'sort tests-js/fixtures/phantom-ids.json and drop the duplicates'
  );
});
