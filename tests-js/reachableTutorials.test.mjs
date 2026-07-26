// tests-js/reachableTutorials.test.mjs
// Every tutorial the app authors must have a way in.
//
// WHY THIS EXISTS
// modalIds.test.mjs asks "does every id a router names actually exist?".
// This asks the opposite question — "does every element we authored have a
// router that names it?" — and the second question found what the first could
// not see.
//
// #playerTransportTutorialModal was 133 lines of finished, interactive help:
// eight clickable demo transport buttons, and prose explaining the scrub bar,
// the nav pod, jump-to-start/end and play forward/backward. It had a dedicated
// wiring function, _wirePlayerTransportDeepDive(). It had close-button wiring.
// It had two call sites shaped exactly like openers:
//
//     if (modalId === 'playerTransportTutorialModal') _wirePlayerTransportDeepDive();
//
// and no user could ever reach it. Both How-to-Use tables are keyed by tab, and
// the player is a panel *inside* a tab, not a tab of its own — so no key could
// ever yield that id, and both branches above were unreachable code that read
// like live code. The tutorial most directly aimed at a first-time user was the
// one tutorial the app had no door to.
//
// Nothing fails when this happens. There is no null, no throw, no console
// warning — the content simply sits there. That is why it needs a gate: the
// defect's whole signature is the absence of a line of code, and absence is
// what review is worst at seeing.
//
// THE RULE
// An id ending in "TutorialModal" authored in a checked-in .html file must be
// named by something in ui.js that can open it. There are three such routers:
// `_tutModalMap`, read by _openTutorial; `_tutMap`, read by the duplicate
// #btnTutorial handler; and _openTutorial's fallback branch, which names
// #genericTutorialModal directly rather than through a table. Those are the
// only code in the app that makes a tutorial visible, so a tutorial named by
// none of them is unreachable by construction.
//
// The third router was added when this gate went red on #genericTutorialModal —
// correctly, by its own reading, and wrongly in fact, because a user can open
// that modal from four different tabs. The rule was always "reachable", never
// "in a table"; the scan had quietly conflated the two. Worth recording, since
// the tempting fix was a fake table entry naming a tab key that does not exist,
// which would have turned a true gate into a decorative one.
//
// WHAT THIS CANNOT SEE
//  - Whether the door is *findable*. `player: 'playerTransportTutorialModal'`
//    is not a tab key; it works only because #pmTransportHelpBtn calls
//    _openTutorial('player'). The last test here pins that specific chain, but
//    the general rule cannot — "a table entry exists" is weaker than "a user
//    can discover it". A key nothing dispatches would still pass.
//  - Overlays that are not tutorials. The suffix is the whole net. A first pass
//    tried the broader question "is this overlay mentioned anywhere in JS?" over
//    all 22 authored hidden overlays and found zero orphans — a *mention* is far
//    too weak a proxy for reachability, which is exactly why this gate tests
//    routing instead.
//  - Whether the tutorial a router names is about the right feature. That is
//    modalIds.test.mjs's territory, and it cannot see it either.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { parseHTML } from 'linkedom';

import { walk } from './lib/domIds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TUTORIAL_ID = /^[A-Za-z][A-Za-z0-9_-]*TutorialModal$/;
const TABLE = /const\s+(_tutModalMap|_tutMap)\s*=\s*\{([\s\S]*?)\n\s*\};/g;
const VALUE = /[:,]\s*['"]([A-Za-z0-9_-]*TutorialModal)['"]/g;
// A third router, which is not a table. _openTutorial's fallback branch names a
// modal directly: a tab with no bespoke tutorial has content built into
// #genericTutorialModal at runtime and that id assigned to modalId. It is a real
// way in, so the scan has to see it — the rule here is "authored content must be
// reachable", not "must appear in a table", and reading only the tables would
// report the fallback modal as stranded when a user can plainly open it.
// Anchored on the assignment to modalId, which is the variable _openTutorial
// actually shows, so a bare mention in prose still does not count as a route.
const DIRECT = /modalId\s*=\s*[^;\n]*?['"]([A-Za-z0-9_-]*TutorialModal)['"]/g;

/** @returns {Map<string,string>} tutorial id -> the file that authors it */
function authoredTutorials() {
  const found = new Map();
  for (const f of walk(join(ROOT, 'src'), ['.html'], ROOT)) {
    const { document } = parseHTML(readFileSync(f, 'utf8'));
    for (const el of document.querySelectorAll('[id]')) {
      const id = el.getAttribute('id');
      if (TUTORIAL_ID.test(id)) found.set(id, relative(ROOT, f));
    }
  }
  return found;
}

/**
 * A value mentioned in a comment is not a route. The comments in _tutModalMap
 * and in _openTutorial explain exactly this bug by name, and a regex cannot
 * tell an explanation from a dispatch.
 */
const stripLineComments = (s) =>
  s.split('\n').filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join('\n');

/**
 * Pull the tutorial ids out of each router table.
 * @param {string} js
 * @returns {Map<string, string[]>} table name -> ids it can dispatch to
 */
function routerTables(js) {
  const tables = new Map();
  for (const m of js.matchAll(TABLE)) {
    const body = stripLineComments(m[2]);
    tables.set(m[1], [...body.matchAll(VALUE)].map((v) => v[1]));
  }
  return tables;
}

/** @returns {string[]} tutorial ids assigned straight to modalId, outside any table */
function directRoutes(js) {
  return [...stripLineComments(js).matchAll(DIRECT)].map((m) => m[1]);
}

const authored = authoredTutorials();
const ui = readFileSync(join(ROOT, 'src/scripts/ui.js'), 'utf8');
const tables = routerTables(ui);
const direct = directRoutes(ui);
const routed = new Set([...[...tables.values()].flat(), ...direct]);

// ── the scan has to work before what it reports means anything ───────────────

test('the scan actually finds the tutorials and both router tables', () => {
  assert.ok(authored.size >= 9, `only ${authored.size} authored tutorials — html parse probably failed`);
  assert.deepEqual(
    [...tables.keys()].sort(),
    ['_tutMap', '_tutModalMap'],
    'a router table was renamed or reshaped; this gate is reading nothing',
  );
  for (const [name, ids] of tables) {
    assert.ok(ids.length >= 8, `${name} yielded only ${ids.length} entries — the value regex probably drifted`);
  }
});

test('the detector separates a routed tutorial from a stranded one', () => {
  const probe = routerTables(
    [
      `const _tutModalMap = {`,
      `  edl: 'routedTutorialModal',`,
      `  // strandedTutorialModal is named only in this comment`,
      `};`,
      `const _tutMap = { edl: 'routedTutorialModal' };`,
    ].join('\n'),
  );
  assert.deepEqual(probe.get('_tutModalMap'), ['routedTutorialModal']);
  const reach = new Set([...probe.values()].flat());
  assert.equal(reach.has('routedTutorialModal'), true);
  // named in the source, but only in prose — not a route
  assert.equal(reach.has('strandedTutorialModal'), false);
});

// ── the gate ─────────────────────────────────────────────────────────────────

test('every authored tutorial is named by a router that can open it', () => {
  const stranded = [];
  for (const [id, file] of authored) {
    if (routed.has(id)) continue;
    stranded.push(`${id} — authored in ${file}, named by no router table`);
  }
  assert.deepEqual(
    stranded,
    [],
    `authored tutorial content with no way in. Nothing throws and nothing logs; ` +
      `the help simply never appears:\n  ${stranded.join('\n  ')}`,
  );
});

// ── the specific regression ──────────────────────────────────────────────────

test("the player transport tutorial has a door on the player", () => {
  // The general rule above is satisfied by a table entry alone. This pins the
  // rest of the chain, because 'player' is not a tab and nothing else would
  // ever dispatch it.
  assert.match(
    ui,
    /player:\s*'playerTransportTutorialModal'/,
    "_tutModalMap lost its 'player' entry",
  );
  assert.match(
    ui,
    /_openTutorial\('player'\)/,
    'nothing calls _openTutorial(\'player\') — the table entry is unreachable again',
  );

  const { document } = parseHTML(readFileSync(join(ROOT, 'src/index.html'), 'utf8'));
  const btn = document.getElementById('pmTransportHelpBtn');
  // Compare a boolean, not the node: node's assert renders a failing element's
  // whole subtree, which turns a one-line failure into a 40-second one.
  assert.equal(btn !== null, true, '#pmTransportHelpBtn is gone from the transport bar');
  assert.match(
    btn.getAttribute('aria-label') || '',
    /player transport/i,
    'the help button needs a name that says what it explains',
  );
  // It has to sit on the bar the tutorial is about, not somewhere else.
  assert.equal(
    btn.closest('.pm-controls') !== null,
    true,
    '#pmTransportHelpBtn moved off .pm-controls — the bar its tutorial documents',
  );
});
