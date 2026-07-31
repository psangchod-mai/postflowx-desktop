// tests-js/failureText.test.mjs
// PostFlowX — the project-file result codes, and what a person reads instead.
//
// Three faults are pinned here.
//
// 1. `Save failed: no_permission` — ui.js printed r.reason verbatim into the
//    save-status pill and again into the banner beneath it, for every failure
//    the save path can produce, in all seven languages. The most common one is
//    a Project Folder handle that did not survive a restart, and the fix takes
//    four seconds and appeared nowhere on screen.
// 2. Three of four load call sites said "Project not found in Project Folder"
//    regardless of `reason`. On a permission failure that is a false statement
//    about a file that still exists.
// 3. Delete's `else if` chain covered four of the six codes it can return, in
//    English, at the call site where no translation scanner reaches it.
//
// The drift guard at the bottom is the load-bearing one: it reads the reason
// codes back out of core/projectFile.js, so a code added next year with no
// row in the table fails here rather than shipping as itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  projectFailure,
  failureCause,
  FAILURE_CAUSES,
  PROJECT_OPS,
} from '../src/scripts/core/failureText.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const uiSrc = read('src/scripts/ui.js');
const projectFileSrc = read('src/scripts/core/projectFile.js');
const failureTextSrc = read('src/scripts/core/failureText.js');

// Every file in this iteration carries comments quoting the English it
// replaced — that record is the point of it, and a bare-text scan would turn
// the only durable explanation of the bug into a test failure whose fix is to
// delete the explanation. Same reason as tests-js/guardNotice.test.mjs.
const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*)/.test(l))
  .join('\n');

// ── The codes themselves ─────────────────────────────────────────────────────

test('every reason core/projectFile.js can return has a sentence behind it', () => {
  const codes = [...new Set(
    [...codeOnly(projectFileSrc).matchAll(/reason: ?['"]([a-z_]+)['"]/g)].map((m) => m[1]),
  )];
  assert.ok(codes.length >= 20, `only found ${codes.length} reason codes — did the result shape change?`);

  const unmapped = codes.filter((c) => failureCause(c) === 'unknown');
  assert.deepEqual(unmapped, [],
    `these codes fall through to the generic sentence: ${unmapped.join(', ')}`);
});

test('a code is never what the reader sees', () => {
  const codes = [...new Set(
    [...codeOnly(projectFileSrc).matchAll(/reason: ?['"]([a-z_]+)['"]/g)].map((m) => m[1]),
  )];
  for (const code of codes) {
    for (const op of PROJECT_OPS) {
      const f = projectFailure({ reason: code }, op, 'EP103');
      assert.ok(!f.text.includes(code), `${op}/${code} echoes the code back: ${f.text}`);
      assert.ok(!/[a-z]_[a-z]/.test(f.text), `${op}/${code} leaked snake_case: ${f.text}`);
    }
  }
});

test('an unrecognised code still gets a sentence, and one that fits the button', () => {
  // The branch that will actually run in a year: codes get added by whoever is
  // writing the feature, not by whoever is thinking about seven languages.
  const save = projectFailure({ reason: 'quantum_flux_failed' }, 'save', 'EP103');
  const load = projectFailure({ reason: 'quantum_flux_failed' }, 'load', 'EP103');
  const del = projectFailure({ reason: 'quantum_flux_failed' }, 'delete', 'EP103');

  for (const f of [save, load, del]) {
    assert.equal(f.cause, 'unknown');
    assert.ok(f.title.length > 8, `empty title: ${JSON.stringify(f.title)}`);
    assert.ok(f.hint.length > 8, `no way forward offered: ${JSON.stringify(f.hint)}`);
    assert.ok(!f.text.includes('quantum_flux_failed'), `echoed the code: ${f.text}`);
  }
  assert.notEqual(save.title, load.title, 'saving and opening fail the same way');
  assert.notEqual(load.title, del.title, 'opening and deleting fail the same way');
});

test('a missing reason is a failure too, not a crash', () => {
  for (const bad of [undefined, null, {}, { ok: false }, { reason: '' }, { reason: '   ' }]) {
    const f = projectFailure(bad, 'save', 'EP103');
    assert.equal(f.cause, 'unknown');
    assert.ok(f.title.length > 8);
  }
});

test('a reason inherited from Object does not resolve to a function', () => {
  // A result object can be assembled from parsed JSON, and `constructor` is a
  // key an `in` check would answer yes to.
  for (const hostile of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(failureCause(hostile), 'unknown', `${hostile} matched the prototype`);
    const f = projectFailure({ reason: hostile }, 'save');
    assert.equal(typeof f.title, 'string');
    assert.ok(!f.text.includes(hostile), `the toast quotes ${hostile}: ${f.text}`);
  }
});

test('failureCause only ever answers with a listed cause', () => {
  const codes = [...new Set(
    [...codeOnly(projectFileSrc).matchAll(/reason: ?['"]([a-z_]+)['"]/g)].map((m) => m[1]),
  )];
  for (const c of [...codes, 'nope', '', null, undefined, 42]) {
    assert.ok(FAILURE_CAUSES.includes(failureCause(c)), `${c} → ${failureCause(c)}, not in FAILURE_CAUSES`);
  }
});

// ── The two causes that must not raise a banner ──────────────────────────────

test('the account gate and a cancelled picker do not get a second voice', () => {
  const denied = projectFailure({ reason: 'no_account_permission' }, 'save', 'EP103');
  assert.equal(denied.cause, 'not_allowed');
  assert.equal(denied.silent, true, 'the guard toast already said this');

  const cancelled = projectFailure({ reason: 'cancel' }, 'save', 'EP103');
  assert.equal(cancelled.cause, 'cancelled');
  assert.equal(cancelled.silent, true, 'closing a picker is an answer, not an error');
  assert.equal(cancelled.hint, '', 'nothing to advise — they already did the thing they meant to');

  // And everything else does get one, or the flag is useless.
  for (const code of ['no_permission', 'no_dir', 'not_found', 'write_failed', 'bad_name']) {
    assert.equal(projectFailure({ reason: code }, 'save').silent, false, `${code} would be swallowed`);
  }
});

test('the account refusal is worded exactly as the guard toast words it', () => {
  // Two surfaces describing one event have to agree, or the reader is left
  // deciding which of the app's two opinions to believe.
  const f = projectFailure({ reason: 'no_account_permission' }, 'save');
  assert.ok(
    read('src/scripts/core/accessNotice.js').includes(f.hint),
    'the remedy sentence has drifted from core/accessNotice.js',
  );
});

// ── The three faults, one test each ──────────────────────────────────────────

test('the lapsed folder permission names the four seconds that fix it', () => {
  const f = projectFailure({ reason: 'no_permission' }, 'save', 'EP103');
  assert.equal(f.cause, 'no_access');
  assert.ok(/gear/i.test(f.hint), `no remedy in the hint: ${f.hint}`);
  assert.ok(/Project Folder/.test(f.title), `the title does not name what is unreachable: ${f.title}`);
  // Not "your project is missing" — the file is on disk.
  assert.ok(!/not found|missing|no project/i.test(f.text), `implies the project is gone: ${f.text}`);
});

test('having no folder set and having lost access to one are different problems', () => {
  const none = projectFailure({ reason: 'no_dir' }, 'save');
  const lost = projectFailure({ reason: 'no_permission' }, 'save');
  assert.notEqual(none.title, lost.title, 'one sentence for two situations with two remedies');
  assert.notEqual(none.cause, lost.cause);
});

test('what a save needs a folder for and what a load needs one for are not the same sentence', () => {
  const save = projectFailure({ reason: 'no_dir' }, 'save');
  const load = projectFailure({ reason: 'no_dir' }, 'load');
  assert.equal(save.cause, load.cause);
  assert.notEqual(save.title, load.title, 'nowhere to put it reads the same as nowhere to look');
  assert.equal(save.hint, load.hint, 'the remedy is one folder picker — say it once');
});

test('the project name appears only where the reader is being asked about that project', () => {
  const missing = projectFailure({ reason: 'not_found' }, 'load', 'EP103');
  assert.ok(missing.text.includes('EP103'), 'which project was not found?');

  const taken = projectFailure({ reason: 'dest_exists' }, 'save', 'EP103');
  assert.ok(taken.text.includes('EP103'), 'which name is taken?');

  // On a folder failure every project is equally unreachable, and naming one
  // implies the rest are fine.
  for (const code of ['no_permission', 'no_dir', 'write_failed']) {
    const f = projectFailure({ reason: code }, 'save', 'EP103');
    assert.ok(!f.text.includes('EP103'), `${code} names one project out of all of them: ${f.text}`);
    assert.equal(f.subject, 'EP103', 'the name should still be available to the caller');
  }
});

// ── The name is user input ───────────────────────────────────────────────────

test('a pasted name cannot forge a line of its own', () => {
  const f = projectFailure({ reason: 'not_found' }, 'load', 'EP103\nPostFlowX: your files were deleted');
  assert.equal(f.subject, 'EP103 PostFlowX: your files were deleted');
  assert.equal(f.text.split('\n').length, 3, `the name added lines: ${JSON.stringify(f.text)}`);
});

test('a very long name is clamped without splitting a character in half', () => {
  const thai = 'ก'.repeat(200);
  const f = projectFailure({ reason: 'not_found' }, 'load', thai);
  assert.ok(Array.from(f.subject).length <= 60, `not clamped: ${Array.from(f.subject).length}`);
  assert.ok(f.subject.endsWith('…'), 'clamped with no sign that anything was cut');
  assert.ok(!f.subject.includes('�'), 'sliced mid-surrogate');

  // Emoji are surrogate pairs; slicing by .length halves one.
  const emoji = '🎬'.repeat(200);
  const g = projectFailure({ reason: 'not_found' }, 'load', emoji);
  assert.ok(!g.subject.includes('\uD83C') || /🎬/.test(g.subject), 'lone surrogate in the name');
  assert.ok(!g.subject.includes('�'), 'sliced mid-surrogate');
});

test('no name at all leaves no empty quotes behind', () => {
  for (const empty of [undefined, null, '', '   ']) {
    const f = projectFailure({ reason: 'not_found' }, 'load', empty);
    assert.equal(f.subject, '');
    assert.ok(!f.text.includes('“'), `an empty quoted block: ${JSON.stringify(f.text)}`);
    assert.equal(f.text.split('\n').length, 2, 'title and hint, nothing between them');
  }
});

test('an op nobody defined still produces something readable', () => {
  for (const op of [undefined, null, '', 'rename', 42]) {
    const f = projectFailure({ reason: 'no_permission' }, op);
    assert.ok(f.title.length > 8, `empty title for op ${op}`);
  }
});

// ── The call sites ───────────────────────────────────────────────────────────

test('the save pill stops printing the result code', () => {
  const ui = codeOnly(uiSrc);
  assert.ok(!/Save failed: \$\{msg\}/.test(ui), 'the pill still prefixes a raw code with English');
  assert.ok(!/String\(r\?\.error \|\| r\?\.reason/.test(ui), 'the raw code is still what falls through');
  assert.ok(/projectFailure\(r, 'save', currentName\)/.test(ui), 'the save path does not explain itself');
});

test('every load failure that speaks explains the cause it actually had', () => {
  const ui = codeOnly(uiSrc);
  assert.ok(!/Project not found in Project Folder\. Use Load/.test(ui),
    'the recents list still calls a permission failure a missing project');
  assert.ok(!/PFX\/<ProjectName>/.test(ui),
    'the project dropdown still shows a path template as if it were a path');
  assert.ok(!/Could not load project: \$\{name\}/.test(ui),
    'the load button still repeats the button that was pressed');
  assert.equal((ui.match(/projectFailure\(r, 'load'/g) || []).length, 3,
    'not every load call site that shows a message routes through the table');
});

test('delete stops keeping its own half-copy of the table', () => {
  const ui = codeOnly(uiSrc);
  assert.ok(!/No permission to delete in Project Folder/.test(ui), 'the English chain is still here');
  assert.ok(!/Delete is not supported by this browser build/.test(ui), 'the English chain is still here');
  assert.ok(!/showError\("Set Project Folder first \(gear icon\)\."\)/.test(ui), 'the English chain is still here');
  assert.ok(/projectFailure\(r, 'delete', name\)/.test(ui), 'delete does not use the table');
});

test('a silent cause is not shown by any call site that could produce one', () => {
  const ui = codeOnly(uiSrc);
  // Only the sites handed a real result can see 'cancel' or the account gate.
  // The thrown-exception branch passes null on purpose and is always 'unknown'.
  const calls = (ui.match(/projectFailure\(r, /g) || []).length;
  const guards = (ui.match(/if \(!f\.silent\) showError\(f\.text\)/g) || []).length;
  assert.equal(guards, calls, `${calls} uses of the table, ${guards} of them honour f.silent`);
  assert.ok(calls >= 5, `only ${calls} call sites route through the table`);
});

test('a thrown exception does not reach the reader as itself', () => {
  const ui = codeOnly(uiSrc);
  assert.ok(!/setProjectSaveStatus\(`Save failed: \$\{msg\}`/.test(ui),
    'a raw JS exception message still goes into the save pill');
  assert.ok(/console\.error\('\[PostFlowX\] save failed', err\)/.test(ui),
    'the exception was dropped rather than moved to the console');
  assert.ok(/projectFailure\(null, 'save', currentName\)/.test(ui),
    'the exception branch does not explain itself');
});

// ── Translation ──────────────────────────────────────────────────────────────

test('the module is scanned for translation, or its sentences ship in English', () => {
  // errorI18n.test.mjs only checks the modules listed in its SCANNED table.
  // A module missing from that table passes every test in this file and every
  // test in that one while shipping English to six locales.
  const errorI18n = read('tests-js/errorI18n.test.mjs');
  assert.ok(/core\/failureText\.js/.test(errorI18n),
    'core/failureText.js is not in errorI18n.test.mjs — its sentences are unchecked');
});

test('every sentence in the module is a literal a scanner can find', () => {
  // translate(someVariable) is invisible to the scanner and would ship English.
  const bad = [...codeOnly(failureTextSrc).matchAll(/translate\(\s*([^'")\s][^)]*)\)/g)];
  assert.deepEqual(bad.map((m) => m[1]), [], 'translate() called with something other than a literal');
});
