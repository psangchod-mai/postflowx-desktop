// tests-js/modalIds.test.mjs
// Every string literal that names a modal must name a modal that exists.
//
// WHY THIS EXISTS
// domContract.test.mjs catches an id read through a literal
// `getElementById('x')`. It cannot see an id that reaches getElementById as a
// *variable* — looked up from a table:
//
//     const _tutModalMap = { …, trlconf: 'tconformTutorialModal', … };
//     const modal = document.getElementById(_tutModalMap[tabKey]);
//     if (!modal) return;                    // <- silent
//
// 'tconformTutorialModal' appeared exactly once in the whole codebase: as that
// value. No element, no runtime creation site, nothing. So the global "How to
// Use" button did nothing at all on the Timeline Convert tab — and because a
// second, duplicate handler is bound to the same button with its own table that
// mapped trlconf to 'settingsTutorialModal', what the user actually got was the
// Settings tutorial. Help for the wrong feature. Meanwhile #tlcTutorialModal —
// a fully authored, seven-language Timeline Convert tutorial already in
// index.html — was unreachable from the header.
//
// Nothing throws on that path. `if (!modal) return` is the guard that turns a
// broken lookup into a shrug, which is why a table like this needs a gate and
// not a code review.
//
// THE RULE
// A `*Modal` string literal in JS is an element id. It must either
//   (a) match an id in a checked-in .html file, or
//   (b) have a creation site — `something.id = 'thatName'` — somewhere in JS.
// (b) matters: five of this repo's modals are built at runtime and are real.
// The narrowing is principled rather than convenient — it distinguishes "built
// later" from "does not exist", which is the whole question.
//
// WHAT THIS CANNOT SEE
//  - Ids that do not end in "Modal". The suffix is what makes a bare string
//    unambiguously an element reference; a broader net would drown in prose.
//  - Whether the modal a name resolves to is the RIGHT one. Both tables here
//    now say 'tlcTutorialModal' because a human read them; a table that agreed
//    on the wrong existing id would pass.
//  - Ids assembled at runtime (`` `${kind}TutorialModal` ``).
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { parseHTML } from 'linkedom';

import { walk } from './lib/domIds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const LITERAL = /['"`]([A-Za-z][A-Za-z0-9_-]*Modal)['"`]/g;
const CREATED = /\.id\s*=\s*['"`]([A-Za-z][A-Za-z0-9_-]*Modal)['"`]/g;

/** Ids defined by checked-in markup. */
function staticIds() {
  const ids = new Set();
  for (const f of walk(join(ROOT, 'src'), ['.html'], ROOT)) {
    const { document } = parseHTML(readFileSync(f, 'utf8'));
    for (const el of document.querySelectorAll('[id]')) ids.add(el.getAttribute('id'));
  }
  return ids;
}

/**
 * @param {string[]} sources  JS file contents
 * @returns {{ used: Map<string, Set<string>>, created: Set<string> }}
 */
function scanJs(sources) {
  const used = new Map();
  const created = new Set();
  for (const { path, text } of sources) {
    text.split('\n').forEach((line, i) => {
      // A source grep cannot tell code from prose; drop whole-line comments so a
      // name mentioned only in an explanation is not treated as a reference.
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
      for (const m of line.matchAll(CREATED)) created.add(m[1]);
      for (const m of line.matchAll(LITERAL)) {
        if (!used.has(m[1])) used.set(m[1], new Set());
        used.get(m[1]).add(`${path}:${i + 1}`);
      }
    });
  }
  return { used, created };
}

const ids = staticIds();
const sources = walk(join(ROOT, 'src'), ['.js'], ROOT).map((f) => ({
  path: relative(ROOT, f),
  text: readFileSync(f, 'utf8'),
}));
const { used, created } = scanJs(sources);

// ── the scan has to work before what it reports means anything ───────────────

test('the scan actually sees the markup and the code', () => {
  assert.ok(ids.size > 1000, `only ${ids.size} static ids — html parse probably failed`);
  assert.ok(sources.length > 50, `only ${sources.length} js files — walk probably failed`);
  assert.ok(used.size >= 15, `only ${used.size} *Modal literals — regex probably drifted`);
  assert.ok(created.size >= 4, `only ${created.size} runtime-created modals — regex probably drifted`);
});

test('the detector separates "built at runtime" from "does not exist"', () => {
  const probe = scanJs([
    {
      path: 'probe.js',
      text: [
        `const a = document.getElementById('runtimeModal');`,
        `overlay.id = 'runtimeModal';`,
        `const b = { key: 'ghostModal' };`,
        `// mentions phantomModal only in prose`,
      ].join('\n'),
    },
  ]);
  assert.deepEqual([...probe.used.keys()].sort(), ['ghostModal', 'runtimeModal']);
  assert.deepEqual([...probe.created], ['runtimeModal']);
  // the prose-only name is not a reference
  assert.equal(probe.used.has('phantomModal'), false);
  // and the rule itself: only ghostModal is unaccounted for
  const unresolved = [...probe.used.keys()].filter((n) => !probe.created.has(n) && !ids.has(n));
  assert.deepEqual(unresolved, ['ghostModal']);
});

// ── the gate ─────────────────────────────────────────────────────────────────

test('every *Modal name resolves to an element that exists or is created', () => {
  const offenders = [];
  for (const [name, where] of used) {
    if (ids.has(name) || created.has(name)) continue;
    offenders.push(`${name} — referenced at ${[...where].join(', ')}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `modal names with no element and no creation site; getElementById returns ` +
      `null and the caller's "if (!modal) return" hides it:\n  ${offenders.join('\n  ')}`,
  );
});

// ── the specific regression ──────────────────────────────────────────────────

test('the Timeline Convert tab maps to the Timeline Convert tutorial', () => {
  // Both handlers bound to #btnTutorial keep their own table, and both fire on
  // one click. They must agree, and they must agree on the modal that is
  // actually about Timeline Convert — not merely on some id that exists.
  const ui = readFileSync(join(ROOT, 'src/scripts/ui.js'), 'utf8');
  // Only the entries whose value is a modal id — ui.js also maps trlconf to a
  // display name and to a project-scope key, and neither is an element.
  const targets = [...ui.matchAll(/trlconf\s*:\s*['"]([A-Za-z0-9_-]*Modal)['"]/g)].map((m) => m[1]);
  assert.ok(targets.length >= 2, `expected both handler tables, found ${targets.length}`);
  assert.deepEqual([...new Set(targets)], ['tlcTutorialModal'],
    'the two How-to-Use tables disagree about which modal Timeline Convert opens');

  const { document } = parseHTML(readFileSync(join(ROOT, 'src/index.html'), 'utf8'));
  const modal = document.getElementById('tlcTutorialModal');
  // Compare a boolean, not the node: node's assert renders a failing element's
  // whole subtree, which turns a one-line failure into a 40-second one.
  assert.equal(modal !== null, true, '#tlcTutorialModal is gone');
  assert.match(modal.getAttribute('aria-label') || '', /Timeline Convert/i);
});
