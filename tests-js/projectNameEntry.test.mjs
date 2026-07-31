// tests-js/projectNameEntry.test.mjs
//
// Iteration 156. Save As was the last raw browser prompt() on the project bar:
//
//   const nn = prompt("Save As - Project name", cur);
//   if (!nn) return;
//
// An English field name in all seven languages, no trim, and a `!nn` that reads
// Cancel and an empty box as the same event — so pressing OK with nothing typed
// did nothing at all and looked exactly like a broken button.
//
// The tests below hold the two halves that matter to a reader: that Cancel and
// blank are now different events, and that the name actually used is the name
// they meant rather than whatever the clipboard had padding around it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  saveAsPromptLabel,
  nameEntryProblem,
  isCancelled,
  cleanProjectName,
} from '../src/scripts/core/projectNameEntry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const read = (p) => readFileSync(join(SRC, p), 'utf8');

// ── Cancel is an answer; an empty box is a failed request ────────────────────

test('pressing Cancel is silent, because the reader said no', () => {
  assert.equal(isCancelled(null), true);
  assert.equal(isCancelled(undefined), true);
});

test('typing nothing and pressing OK is not the same event as Cancel', () => {
  assert.equal(isCancelled(''), false, 'an empty box would still be swallowed');
  assert.equal(isCancelled('   '), false);
  assert.equal(isCancelled('EP103'), false);
});

test('an empty box earns a sentence rather than silence', () => {
  for (const typed of ['', '   ', '\t\n']) {
    const problem = nameEntryProblem(typed);
    assert.notEqual(problem, '', `${JSON.stringify(typed)} produced no message`);
    assert.ok(problem.length > 10, 'the message is not a sentence');
  }
});

test('a usable name has nothing to say about it', () => {
  for (const typed of ['EP103', 'ตอนที่ 3', '제3화', '  padded  ', '.']) {
    assert.equal(nameEntryProblem(typed), '', `${JSON.stringify(typed)} was rejected`);
  }
});

// ── The name that gets used is the name that was meant ───────────────────────

test('a pasted name does not carry its padding into the project', () => {
  assert.equal(cleanProjectName('  EP103 Reel 2  '), 'EP103 Reel 2');
  assert.equal(cleanProjectName('\tEP103\n'), 'EP103');
});

test('a run of whitespace inside a name is one space', () => {
  // "EP103    Reel 2" and "EP103 Reel 2" are the same folder once the folder
  // rule collapses underscores, so they must not be two rows in the recents
  // list pointing at one directory.
  assert.equal(cleanProjectName('EP103    Reel 2'), 'EP103 Reel 2');
  assert.equal(cleanProjectName('a\t\tb'), 'a b');
});

test('cleaning never throws on what a dialog can actually return', () => {
  assert.equal(cleanProjectName(null), '');
  assert.equal(cleanProjectName(undefined), '');
  assert.equal(cleanProjectName(''), '');
});

test('non-Latin names are untouched by the cleaning step', () => {
  assert.equal(cleanProjectName('ตอนที่ 3'), 'ตอนที่ 3');
  assert.equal(cleanProjectName('제3화'), '제3화');
});

// ── What the dialog says ─────────────────────────────────────────────────────

test('the dialog asks a question and then explains the folder rule', () => {
  const label = saveAsPromptLabel();
  const lines = label.split('\n');
  assert.equal(lines.length, 2, 'the label is not two lines');
  assert.ok(lines.every((l) => l.trim().length > 0), 'a line is blank');
  assert.ok(/underscore/i.test(lines[1]),
    'the second line does not say what happens to spaces');
});

test('the developer label is gone from the dialog', () => {
  assert.equal(/Save As - Project name/.test(saveAsPromptLabel()), false);
  const ui = read('scripts/ui.js');
  assert.equal(/prompt\("Save As - Project name"/.test(ui), false,
    'ui.js still passes the old English field name to prompt()');
});

// ── Wiring: the handler routes through the rules above ───────────────────────

test('the Save As handler distinguishes Cancel from a blank box', () => {
  const ui = read('scripts/ui.js');
  const at = ui.indexOf('on(bSaveAs, "click"');
  assert.notEqual(at, -1, 'the Save As handler moved or was renamed');
  const handler = ui.slice(at, at + 1200);

  for (const fn of ['saveAsPromptLabel', 'isCancelled', 'nameEntryProblem', 'cleanProjectName']) {
    assert.ok(handler.includes(fn), `the handler does not call ${fn}`);
  }
  assert.ok(handler.includes('showErrorBanner'),
    'the handler has no way to show the problem it just detected');
  assert.equal(/if \(!nn\) return;/.test(handler), false,
    'the handler still collapses Cancel and blank into one branch');
});

test('ui.js imports the rules rather than inlining them again', () => {
  const ui = read('scripts/ui.js');
  const imports = [...ui.matchAll(/^import\s.*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
  assert.ok(imports.includes('./core/projectNameEntry.js'),
    'ui.js does not import core/projectNameEntry.js');
});

test('the rules are importable with no DOM, which is why they could be tested', () => {
  const src = read('scripts/core/projectNameEntry.js');
  assert.equal(/\bwindow\b|\bdocument\b|\blocalStorage\b/.test(src), false,
    'the module reaches for a browser global');
  // The header quotes the old prompt() line it replaced, so the check for "this
  // module does not open a dialog itself" has to look at code, not prose.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/\bprompt\s*\(/.test(code), false,
    'the module opens a dialog instead of only supplying the words for one');
});
