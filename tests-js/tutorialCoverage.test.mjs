// tests-js/tutorialCoverage.test.mjs
// Every tab must answer the How to Use button.
//
// WHY THIS EXISTS
// This is the third question in a set, and each one found what the others could
// not see:
//
//   modalIds.test.mjs         "does every id a router names actually exist?"
//   reachableTutorials.test   "does every authored tutorial have a router?"
//   this file                 "does every *tab* get an answer?"
//
// The first two were both green while a third of the app had no help at all.
// _tutModalMap named a modal for eight tabs. Twelve tabs carry data-main. The
// four with no entry — home, bwav, preflight, renderq — hit this line:
//
//     const modalId = _tutModalMap[tabKey];
//     if (!modalId) return;          // <- HOME, BWAV, PREFLIGHT, RENDER QUEUE
//
// and the global How to Use button did nothing. No modal, no message, no
// console warning, no throw. Both existing gates were satisfied: every id named
// existed, and every tutorial authored was named. Neither gate asks about the
// tabs, and the tabs are what the user is actually standing on when they press
// the button.
//
// A help button that silently does nothing is worse than no help button. "No
// guide for this screen" is information; nothing happening is a broken app.
//
// THE RULE
// Every `data-main` tab in index.html must resolve to a specific answer:
//   - an entry in _tutModalMap naming a modal that exists, or
//   - the home tab, which opens the real Setup Guide instead of a modal, or
//   - an entry in _tutFallbackContent.
//
// _fillFallbackTutorial does have a generic "no walkthrough yet" branch for an
// unknown key, and that is a genuine safety net — but it is deliberately NOT
// accepted here. A new tab should make this gate fail, so whoever adds it
// decides what its help says. The net is there for the case nobody planned;
// it is not a plan.
//
// WHAT THIS CANNOT SEE
//  - Whether the help is correct, current, or about the right feature. Every
//    test here is satisfied by an entry existing. Prose that describes a button
//    that was removed last year passes.
//  - Whether the user can find the button, or whether the modal is readable
//    once open. Reachability is not usability.
//  - Tabs built at runtime. The scan reads the authored markup only.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseHTML } from 'linkedom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ui = readFileSync(join(ROOT, 'src/scripts/ui.js'), 'utf8');
const html = readFileSync(join(ROOT, 'src/index.html'), 'utf8');
const { document } = parseHTML(html);

/** Drop whole-line comments — a key named in prose is not a route. */
const stripComments = (s) =>
  s.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

/** @returns {Map<string,string>} tab key -> modal id, from _tutModalMap */
function tutModalMap(js) {
  const m = js.match(/const\s+_tutModalMap\s*=\s*\{([\s\S]*?)\n\s*\};/);
  if (!m) return new Map();
  const out = new Map();
  for (const e of stripComments(m[1]).matchAll(/([A-Za-z][A-Za-z0-9_]*)\s*:\s*['"]([^'"]+)['"]/g)) {
    out.set(e[1], e[2]);
  }
  return out;
}

/** @returns {string[]} tab keys that have authored fallback content */
function fallbackKeys(js) {
  const m = js.match(/const\s+_tutFallbackContent\s*=\s*\{([\s\S]*?)\n\s*\};/);
  if (!m) return [];
  return [...stripComments(m[1]).matchAll(/^\s{4}([A-Za-z][A-Za-z0-9_]*)\s*:\s*\{/gm)].map((e) => e[1]);
}

const tabs = [...document.querySelectorAll('.tabs .tab[data-main]')].map((el) => ({
  key: el.getAttribute('data-main'),
  label: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
}));
const mapped = tutModalMap(ui);
const fallback = new Set(fallbackKeys(ui));
const domIds = new Set([...document.querySelectorAll('[id]')].map((el) => el.getAttribute('id')));

// ── the scan has to work before what it reports means anything ───────────────

test('the scan finds the tabs, the router table and the fallback table', () => {
  assert.ok(tabs.length >= 10, `only ${tabs.length} tabs found — the html parse or selector drifted`);
  assert.ok(mapped.size >= 8, `_tutModalMap yielded only ${mapped.size} entries — the key regex drifted`);
  assert.ok(fallback.size >= 3, `_tutFallbackContent yielded only ${fallback.size} entries — the key regex drifted`);
});

test('the detectors separate a real entry from one named only in a comment', () => {
  const probe = tutModalMap(
    ['const _tutModalMap = {', "  edl: 'realModal',", "  // ghost: 'commentedModal',", '};'].join('\n'),
  );
  assert.deepEqual([...probe.entries()], [['edl', 'realModal']]);

  const probeFb = fallbackKeys(
    [
      'const _tutFallbackContent = {',
      '    bwav: {',
      "      title: 'x',",
      '    },',
      "    // ghost: { title: 'y' },",
      '};',
    ].join('\n'),
  );
  assert.deepEqual(probeFb, ['bwav']);
});

// ── the gate ─────────────────────────────────────────────────────────────────

test('every tab answers the How to Use button', () => {
  const silent = [];
  for (const { key, label } of tabs) {
    if (mapped.has(key)) continue;
    if (key === 'home') continue; // routed to the Setup Guide; pinned below
    if (fallback.has(key)) continue;
    silent.push(`${key} (${label}) — no _tutModalMap entry and no _tutFallbackContent entry`);
  }
  assert.deepEqual(
    silent,
    [],
    'these tabs would show the user nothing when they press How to Use. Add an ' +
      'entry to _tutFallbackContent in src/scripts/ui.js:\n  ' +
      silent.join('\n  '),
  );
});

test('every modal a tab is routed to actually exists', () => {
  const missing = [];
  for (const { key } of tabs) {
    const id = mapped.get(key);
    if (id && !domIds.has(id)) missing.push(`${key} -> #${id}`);
  }
  assert.deepEqual(missing, [], `_tutModalMap routes a tab to a modal that is not in the DOM:\n  ${missing.join('\n  ')}`);
});

test('fallback content is not authored for a tab that does not exist', () => {
  // The reverse direction. A gate that checks a mapping one way has a blind spot
  // exactly the size of the other way: help written for a renamed or deleted tab
  // is dead text nobody will ever see, and nothing else here would notice.
  const tabKeys = new Set(tabs.map((t) => t.key));
  const orphans = [...fallback].filter((k) => !tabKeys.has(k));
  assert.deepEqual(orphans, [], `_tutFallbackContent has help for non-existent tabs: ${orphans.join(', ')}`);
});

// ── the specific regression ──────────────────────────────────────────────────

test('a missing router entry is no longer answered with a silent return', () => {
  // The whole defect in two lines. Pinned on the shape rather than on exact
  // text: what matters is that the lookup's failure path does something.
  const fn = ui.slice(ui.indexOf('function _openTutorial(tabKey)'));
  const head = fn.slice(0, fn.indexOf('const modal = document.getElementById(modalId)'));
  assert.ok(head.length > 0, '_openTutorial was renamed or restructured; this gate is reading nothing');
  assert.doesNotMatch(
    head,
    /_tutModalMap\[tabKey\];\s*\n\s*if\s*\(!modalId\)\s*return;/,
    'the silent no-op is back: a tab with no entry in _tutModalMap presses How to ' +
      'Use and nothing at all happens',
  );
  assert.match(head, /_fillFallbackTutorial\(/, '_openTutorial no longer reaches the fallback');
});

test('the generic modal the fallback fills is present and complete', () => {
  for (const id of ['genericTutorialModal', 'genericTutorialTitleText', 'genericTutorialBody']) {
    assert.equal(domIds.has(id), true, `#${id} is missing — the fallback has nothing to fill`);
  }
  const modal = document.getElementById('genericTutorialModal');
  assert.equal(
    modal.querySelector('.pfx-tutorial-backdrop') !== null,
    true,
    'no .pfx-tutorial-backdrop — _openTutorial wires click-outside-to-close onto it',
  );
  assert.equal(
    modal.querySelector('.pfx-tutorial-close') !== null,
    true,
    'no .pfx-tutorial-close — _openTutorial wires the close button by that class',
  );
});

test("the home tab's Setup Guide route is not dead", () => {
  // home deliberately has no modal: the Setup Guide is a real interactive
  // walkthrough. That only helps if the global it calls is actually assigned.
  assert.match(ui, /pfxOpenSetupGuide/, '_openTutorial lost its Setup Guide route for the home tab');

  // Read defensively. setupWizard.js is currently untracked while homeScreen.js
  // — which is tracked — imports it, so on a fresh clone this path does not
  // exist. A bare readFileSync would throw ENOENT here, and because the runner
  // takes a crash as a dead process, every gate file after this one would
  // silently never run. Naming the real cause is worth three lines.
  const wizardPath = join(ROOT, 'src/scripts/features/home/setupWizard.js');
  let wizard = null;
  try {
    wizard = readFileSync(wizardPath, 'utf8');
  } catch (err) {
    assert.fail(
      `src/scripts/features/home/setupWizard.js is missing (${err.code}). The home ` +
        'tab routes How to Use to window.pfxOpenSetupGuide, and homeScreen.js imports ' +
        'this file, so its absence breaks the home screen itself — not just the help.',
    );
  }
  assert.match(
    wizard,
    /window\.pfxOpenSetupGuide\s*=/,
    'nothing assigns window.pfxOpenSetupGuide — the home tab would fall through to the generic modal',
  );
});

test('the fallback renders without innerHTML', () => {
  // Content is authored data, but building it with innerHTML would still add a
  // sink to a file that has a scanner pointed at it. textContent keeps the
  // fallback out of that argument entirely.
  const start = ui.indexOf('function _fillFallbackTutorial(tabKey)');
  assert.ok(start > 0, '_fillFallbackTutorial was renamed; this gate is reading nothing');
  const body = ui.slice(start, ui.indexOf('function _openTutorial(tabKey)'));
  assert.doesNotMatch(body, /innerHTML/, '_fillFallbackTutorial started using innerHTML');
  assert.match(body, /textContent/, '_fillFallbackTutorial stopped using textContent');
});
