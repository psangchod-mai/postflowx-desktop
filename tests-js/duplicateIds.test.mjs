// tests-js/duplicateIds.test.mjs
// No static HTML file in this renderer may define the same id twice.
//
// WHY THIS EXISTS
// domContract.test.mjs guards the *phantom* element: an id the code reads that
// nothing defines. This file guards its mirror image, which is worse, because it
// looks like defensive programming while it breaks the feature.
//
// The CutDiff 2x inspector was moved out of the video-compare pane and into the
// right column. The old copy was left behind, hidden, under this comment:
//
//     <!-- Inspector moved to .cd2x-left-col — stub kept for legacy DOM refs -->
//     <div id="cd2x-inspector-stub" style="display:none">
//
// Eighteen ids — cd2x-insp-reel, -clip, -src-in, -src-out, -rec-in, -rec-out,
// -duration, -fps, -score-bar, -score-pct, -reason, -old-clip, -old-src-in,
// -old-rec-in, -status, -note, -note-save, -seek-btn — then existed twice in
// src/index.html. `getElementById` resolves first-in-document-order, and the
// stub came first, so every one of the 18 lookups in
// features/cutdiff2/index.js bound to the invisible copy.
//
// A duplicate kept "for compatibility" does not add a fallback. It shadows the
// real element. There is no second chance in DOM id resolution — first wins,
// unconditionally, whether or not the winner is display:none.
//
// What the user saw: open CutDiff 2x, click any row. The inspector opens and the
// event/type header fills in — those three ids were not duplicated. Then every
// single data field below stays "—" forever, the status dropdown and the note
// box write into detached hidden inputs, and Save Note and Seek VC are wired to
// controls nobody can see. Nothing throws. Nothing is logged. The panel looks
// like it is working and is simply empty, which for someone who is not an
// engineer is indistinguishable from "this file has no data in it".
//
// WHAT THIS CANNOT SEE
// Only static markup. An id minted at runtime from a template literal may
// legitimately be produced once per row, so multiplicity there says nothing.
// That keeps this gate at zero tolerance rather than needing a baseline: any
// duplicate in a checked-in .html file is unambiguous.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { parseHTML } from 'linkedom';

import { walk } from './lib/domIds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Ids appearing more than once in one document.
 * @returns {Array<[string, number]>} [id, occurrences], occurrences >= 2
 */
function duplicateIds(html) {
  const { document } = parseHTML(html);
  const counts = new Map();
  for (const el of document.querySelectorAll('[id]')) {
    const id = el.getAttribute('id');
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...counts].filter(([, n]) => n > 1).sort((a, b) => a[0].localeCompare(b[0]));
}

const files = walk(join(ROOT, 'src'), ['.html'], ROOT);
const scanned = files.map((f) => ({
  path: relative(ROOT, f),
  html: readFileSync(f, 'utf8'),
}));

// ── the scan has to work before what it reports means anything ───────────────

test('the scan actually sees the markup', () => {
  // A gate that passes by parsing nothing is the failure mode this whole file
  // exists to prevent, so pin the orders of magnitude.
  assert.ok(scanned.length >= 8, `only ${scanned.length} html files found under src/`);
  const totalIds = scanned.reduce((n, f) => {
    const { document } = parseHTML(f.html);
    return n + document.querySelectorAll('[id]').length;
  }, 0);
  assert.ok(totalIds > 1000, `only ${totalIds} elements with an id — parser probably failed`);
});

test('the detector reports a duplicate that is really there', () => {
  // The control for the gate below. Same function, same code path, a document
  // whose defect is exactly the one that shipped: a hidden earlier copy of an
  // id that also exists later in the document.
  const injected = `<html><body>
    <div id="stub" style="display:none"><span id="field">—</span></div>
    <div id="real"><span id="field">—</span></div>
  </body></html>`;
  assert.deepEqual(duplicateIds(injected), [['field', 2]]);

  // and does not invent one when the ids are distinct
  const clean = `<html><body><span id="a"></span><span id="b"></span></body></html>`;
  assert.deepEqual(duplicateIds(clean), []);
});

// ── the gate ─────────────────────────────────────────────────────────────────

test('no static html file defines an id twice', () => {
  const offenders = [];
  for (const { path, html } of scanned) {
    for (const [id, n] of duplicateIds(html)) offenders.push(`${path}: #${id} ×${n}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `duplicated element ids — getElementById binds to the FIRST one, so every ` +
      `later copy is unreachable:\n  ${offenders.join('\n  ')}`,
  );
});

// ── the specific regression ──────────────────────────────────────────────────

test('every field the CutDiff 2x inspector reads is inside the visible panel', () => {
  // Deleting the stub is only half the fix. This is the other half: the ids the
  // code reaches for must live in the panel the user is actually looking at. It
  // fails if a stub is re-added anywhere in the document, and it fails if the
  // panel is moved again and the fields are left behind.
  const html = readFileSync(join(ROOT, 'src/index.html'), 'utf8');
  const js = readFileSync(join(ROOT, 'src/scripts/features/cutdiff2/index.js'), 'utf8');
  const { document } = parseHTML(html);

  const panel = document.getElementById('cd2x-inspector');
  assert.ok(panel, '#cd2x-inspector is gone — the inspector has no home');
  // Compare a boolean, not the node: on failure node's assert renders the diff,
  // and rendering a linkedom element renders its whole subtree — which turned a
  // one-line failure into a 41-second one when this was checked against the
  // pre-fix markup.
  assert.equal(document.getElementById('cd2x-inspector-stub') === null, true,
    'the hidden inspector stub is back; it shadows the real panel');

  const ids = [...new Set(
    [...js.matchAll(/getElementById\(\s*['"](cd2x-insp[^'"]*)['"]\s*\)/g)].map((m) => m[1]),
  )];
  assert.ok(ids.length >= 20, `only ${ids.length} inspector lookups found — regex drifted?`);

  const stranded = ids.filter((id) => {
    const el = document.getElementById(id);
    return !el || !panel.contains(el);
  });
  assert.deepEqual(stranded, [],
    `inspector fields that do not resolve inside #cd2x-inspector: ${stranded.join(', ')}`);
});
