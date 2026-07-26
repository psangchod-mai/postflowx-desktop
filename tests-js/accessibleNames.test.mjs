// tests-js/accessibleNames.test.mjs
// Every interactive control in this renderer must have an accessible name.
//
// WHY THIS EXISTS
// A control with no accessible name is announced by VoiceOver as its bare role:
// "slider", "pop-up button", "check box". Nothing else. Not what it does, not
// what it is currently set to, not which of the seven sliders on this screen it
// happens to be. The user hears "slider" and has no way to find out.
//
// Thirty-four of them shipped. The worst were not obscure: the main playback
// scrubber (#pmScrub), the IMF viewer's scrubber and volume (#imfSeek,
// #imfVolSlider), the annotation brush size (#pmQaSize), and the select-all
// checkbox on the shot list (#pl2SelectAll) — that last one sat inside
//
//     <label class="pl2-sel-all-wrap" title="Select / deselect all shots">
//       <input type="checkbox" id="pl2SelectAll">
//     </label>
//
// which looks labelled and is not. A wrapping <label> names its control from
// its TEXT; this one has no text, only a title on the label rather than on the
// input, and a title on an ancestor names nothing. A sighted user hovers and
// gets a tooltip. A screen-reader user gets "check box".
//
// Two more, #folderPicker and #filePicker in the preflight tool, are positioned
// off-screen at opacity 0 — but that is not display:none, so they stay in the
// accessibility tree and stay tabbable. Hiding a control visually does not
// excuse it from having a name; it just means only the screen-reader user ever
// meets it.
//
// WHAT COUNTS AS A NAME
// aria-label, aria-labelledby, label[for], a wrapping <label> with text, title,
// and — for buttons — the button's own text. placeholder is accepted last,
// because real assistive tech does fall back to it, but it is a weak name: it
// disappears from the control the moment the user types.
//
// WHAT THIS CANNOT SEE
//  - Only <input>/<select>/<textarea>/<button> in static markup. Controls built
//    at runtime, and div/span elements given role="button", are invisible here.
//  - Visibility is judged from the element's OWN inline style/hidden attribute,
//    never an ancestor's. Walking up would drop every control in an inactive
//    tab panel — those are inline display:none until clicked, which is most of
//    this app. A control one tab click away still needs a name.
//  - Whether the name is any GOOD. "Slider 3" would pass. Only absence is
//    mechanically detectable; accuracy is a review question.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { parseHTML } from 'linkedom';

import { walk } from './lib/domIds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Hidden for our purposes only if the element itself says so. See header. */
function selfHidden(el) {
  if (el.hasAttribute('hidden')) return true;
  if (/display:\s*none/i.test(el.getAttribute('style') || '')) return true;
  return (el.getAttribute('type') || '').toLowerCase() === 'hidden';
}

/** The accessible name, or null. Order mirrors the AccName spec closely enough. */
function accessibleName(el, document) {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();

  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const text = by
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || '')
      .join(' ')
      .trim();
    if (text) return text;
  }

  const id = el.getAttribute('id');
  if (id) {
    // CSS.escape is not available here; ids in this repo are attribute-safe.
    const lab = document.querySelector(`label[for="${id}"]`);
    if (lab && lab.textContent.trim()) return lab.textContent.trim();
  }

  // A wrapping <label> names its control with no for= at all — but only via its
  // text. A title on the label does not carry down to the input inside it.
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.tagName === 'LABEL') {
      const text = p.textContent.replace(/\s+/g, ' ').trim();
      if (text) return text;
      break;
    }
  }

  if (el.tagName === 'BUTTON') {
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    if (text) return text;
  }

  const title = el.getAttribute('title');
  if (title && title.trim()) return title.trim();

  const placeholder = el.getAttribute('placeholder');
  if (placeholder && placeholder.trim()) return placeholder.trim();

  return null;
}

/** @returns {string[]} human-readable descriptions of unnamed controls */
function unnamedControls(html) {
  const { document } = parseHTML(html);
  const out = [];
  for (const el of document.querySelectorAll('input, select, textarea, button')) {
    if (selfHidden(el)) continue;
    if (accessibleName(el, document)) continue;
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    out.push(`<${tag}${type ? ` type=${type}` : ''}> #${el.getAttribute('id') || '(no id)'}`);
  }
  return out;
}

const scanned = walk(join(ROOT, 'src'), ['.html'], ROOT).map((f) => ({
  path: relative(ROOT, f),
  html: readFileSync(f, 'utf8'),
}));

// ── the scan has to work before what it reports means anything ───────────────

test('the scan actually sees the controls', () => {
  assert.ok(scanned.length >= 8, `only ${scanned.length} html files found under src/`);
  const total = scanned.reduce((n, f) => {
    const { document } = parseHTML(f.html);
    return n + document.querySelectorAll('input, select, textarea, button').length;
  }, 0);
  assert.ok(total > 500, `only ${total} controls found — parser probably failed`);
});

test('the detector finds a missing name that is really missing', () => {
  // The control for the gate below, built from the shapes that actually
  // shipped rather than an invented one.
  const bad = `<html><body>
    <input type="range" id="scrub">
    <label title="Select / deselect all shots"><input type="checkbox" id="all"></label>
    <select id="fps"><option>24</option></select>
  </body></html>`;
  assert.deepEqual(unnamedControls(bad), [
    '<input type=range> #scrub',
    '<input type=checkbox> #all',   // title on the LABEL names nothing
    '<select> #fps',
  ]);

  // …and does not cry wolf on each of the six ways a name can be supplied.
  const good = `<html><body>
    <input type="range" id="a" aria-label="Scrub playhead">
    <span id="lbl">Volume</span><input type="range" id="b" aria-labelledby="lbl">
    <label for="c">Frame rate</label><select id="c"></select>
    <label>Reel name <input id="d"></label>
    <button id="e">Run preflight</button>
    <button id="f" title="Mute">&#128266;</button>
    <input id="g" type="hidden">
    <input id="h" style="display:none">
  </body></html>`;
  assert.deepEqual(unnamedControls(good), []);
});

// ── the gate ─────────────────────────────────────────────────────────────────

test('every visible control has an accessible name', () => {
  const offenders = [];
  for (const { path, html } of scanned) {
    for (const desc of unnamedControls(html)) offenders.push(`${path}: ${desc}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `controls a screen reader announces only as their role:\n  ${offenders.join('\n  ')}`,
  );
});
