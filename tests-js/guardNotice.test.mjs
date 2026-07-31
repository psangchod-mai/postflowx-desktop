// tests-js/guardNotice.test.mjs
// The other refusal channel — the one that told people the wrong thing.
//
// PFX_GUARD.toast() and the read-only badge are a second vocabulary alongside
// showDeniedToast(), and nothing scanned it. Three faults shipped together:
//
//   1. The badge blamed the account. project-lease.js already distinguishes
//      "another window holds the lease" from "no edit permission", but ui.js
//      dropped the reason on the floor and read-only.js hard-coded the
//      permission sentence, so a user whose only problem was a second open
//      window was sent to an administrator who could not help them.
//   2. Ten call sites spelled their own English refusal, five of them printing
//      the permission key — `Import blocked — no import_timeline permission`.
//   3. .pfx-guard-toast was `white-space: nowrap` with no max-width, so the
//      two-sentence wording ran off both edges of the window.
//
// These tests hold the fix in place: the cause decides the words, the words
// live where the i18n scanner can see them, and a call site names an action
// rather than writing a sentence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  READ_ONLY_CAUSES,
  readOnlyCause,
  readOnlyNotice,
  guardNotice,
  actionName,
  deniedActionNotice,
} from '../src/scripts/core/accessNotice.js';
import { PFX_SHORTCUT_MUTATING } from '../src/scripts/core/shortcuts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');

// Comments stripped, because every one of these files carries a comment
// quoting the English it replaced — `Read-only — "cut_add" shortcut blocked`
// and friends — and keeping that record next to the fix is the point of it.
// A bare-text scan would make the only durable explanation of the bug into a
// test failure, and the way to pass would be to delete the explanation.
const codeOnly = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter(l => !/^\s*(\/\/|\*)/.test(l))
  .join('\n');

const guardSrc     = read('src/scripts/auth/guarded-action.js');
const readOnlySrc  = read('src/scripts/auth/read-only.js');
const leaseSrc     = read('src/scripts/auth/project-lease.js');
const shortcutsSrc = read('src/scripts/core/shortcuts.js');
const uiSrc        = read('src/scripts/ui.js');
const indexHtml    = read('src/index.html');
const css          = read('src/styles/main.css');

// Every file that refuses something through this channel. The id scan below
// reads all of them, so a new deny() with no name in the table fails here.
const CALL_SITES = [
  'src/scripts/ui.js',
  'src/scripts/prep_mark.js',
  'src/scripts/core/projectFile.js',
  'src/scripts/core/shortcuts.js',
  'src/scripts/auth/media-coordinator.js',
  'src/scripts/features/cutdiff2/index.js',
  'src/scripts/components/annotateModal/index.js',
];

test('readOnlyCause is total: an unrecognised reason promises nothing', () => {
  assert.equal(readOnlyCause('Another tab holds the edit lease'), 'lease');
  assert.equal(readOnlyCause('No edit permission'), 'permission');
  // Both real reasons come from project-lease.js verbatim; if either string is
  // reworded there without being reworded here, the badge silently degrades to
  // the no-remedy wording instead of lying, and this test says so first.
  for (const m of leaseSrc.matchAll(/_onChange\?\.\(true, '([^']+)'\)/g)) {
    assert.notEqual(readOnlyCause(m[1]), 'unknown', `lease reason "${m[1]}" is not classified`);
  }
  for (const empty of [undefined, null, '', '   ']) assert.equal(readOnlyCause(empty), 'unknown');
  assert.equal(readOnlyCause('something nobody wrote'), 'unknown');
  assert.ok(READ_ONLY_CAUSES.includes(readOnlyCause('constructor')));
});

test('each cause is described as itself, not as the other one', () => {
  const lease = readOnlyNotice({ reason: 'Another tab holds the edit lease' });
  const perm  = readOnlyNotice({ reason: 'No edit permission' });

  assert.equal(lease.cause, 'lease');
  assert.equal(perm.cause, 'permission');
  assert.notEqual(lease.opening, perm.opening);
  assert.notEqual(lease.next, perm.next);

  // The bug in one line: a second window is not an account problem, so the
  // lease wording must not send the user to whoever administers accounts.
  assert.ok(!/account/i.test(lease.opening + lease.next), `lease blames the account: ${lease.text}`);
  // …and the permission wording must not suggest closing a window that is not
  // open, which is what the single hard-coded sentence could never express.
  assert.ok(/close/i.test(lease.next), `the lease notice does not say what to do: ${lease.next}`);
});

test('the honest dead end offers no remedy at all', () => {
  const n = readOnlyNotice({ reason: 'unrecognised' });
  assert.equal(n.cause, 'unknown');
  assert.equal(n.next, '');
  assert.equal(n.text, n.opening);
  assert.equal(n.title, n.opening);
  assert.ok(n.opening.trim().length > 0);
});

test('the badge has a short label and a full tooltip, on one line', () => {
  for (const cause of READ_ONLY_CAUSES) {
    const n = readOnlyNotice({ cause });
    assert.ok(n.badge.trim().length > 0, `${cause} has no badge label`);
    assert.ok(n.badge.length < 20, `${cause} badge is a sentence, not a pill: ${n.badge}`);
    // title= is an attribute — a newline in it renders as a space anyway, so
    // the two sentences are joined with punctuation instead. text is the toast
    // form and keeps the break.
    assert.ok(!n.title.includes('\n'), `${cause} tooltip carries a raw newline`);
    if (n.next) assert.ok(n.text.includes('\n'), `${cause} toast runs both sentences together`);
  }
});

test('an explicit cause beats a reason string', () => {
  // read-only.js remembers a reason; guardedAction knows only that read-only is
  // on. Both paths reach the same builder, so it accepts either.
  assert.equal(readOnlyNotice({ cause: 'lease', reason: 'No edit permission' }).cause, 'lease');
  assert.equal(readOnlyNotice({ cause: 'nonsense', reason: 'No edit permission' }).cause, 'permission');
});

test('read-only names the situation; a permission block names the action', () => {
  // Read-only stops every mutating action at once, so naming the one that was
  // pressed adds nothing and pushes the way out further down the toast.
  const ro = guardNotice({ actionId: 'cut_add', readOnly: true, reason: 'Another tab holds the edit lease' });
  assert.equal(ro.cause, 'lease');
  assert.equal(ro.text, readOnlyNotice({ reason: 'Another tab holds the edit lease' }).text);
  assert.ok(!ro.text.includes('cut_add'), `the id leaked into the toast: ${ro.text}`);

  // A permission refusal is specific to one action, so the action is named.
  const perm = guardNotice({ actionId: 'export_csv' });
  assert.equal(perm.cause, 'permission');
  assert.equal(perm.text, deniedActionNotice({ id: 'export_csv' }).text);
  assert.ok(perm.text.includes('Export CSV'));
});

test('no refusal this channel can produce contains a raw permission key', () => {
  const ids = new Set();
  for (const p of CALL_SITES) {
    for (const m of read(p).matchAll(/PFX_GUARD\?\.deny\?\.\(\s*'([a-z_]+)'\s*\)/g)) ids.add(m[1]);
  }
  // shortcuts.js passes the id through as a variable, so its set is the source.
  for (const id of PFX_SHORTCUT_MUTATING) ids.add(id);
  assert.ok(ids.size >= 8, `the call-site scan found only ${ids.size} ids, so it proves little`);

  for (const id of ids) {
    assert.notEqual(actionName(id), '', `${id} is refused somewhere but has no name`);
    for (const state of [{ actionId: id }, { actionId: id, readOnly: true }]) {
      const t = guardNotice(state).text;
      assert.ok(!t.includes(id), `the raw id reaches the user: ${t}`);
      assert.ok(!/_/.test(t), `snake_case leaked into the toast: ${t}`);
    }
  }
});

test('a call site names an action; it never writes the sentence', () => {
  // The whole point of deny(actionId). toast() stays public — three ui.js call
  // sites pass an already-built workspace notice — but nothing may pass a bare
  // English literal any more.
  for (const p of CALL_SITES) {
    const src = read(p);
    for (const m of src.matchAll(/PFX_GUARD\?\.toast\?\.\(\s*(['"`])/g)) {
      assert.fail(`${p} spells its own refusal sentence at offset ${m.index}`);
    }
  }
  for (const stale of ['Permission denied', 'shortcut blocked', 'Import blocked', 'Read-only —']) {
    for (const p of [...CALL_SITES, 'src/scripts/auth/guarded-action.js']) {
      assert.ok(!codeOnly(read(p)).includes(stale), `${p} still carries the untranslated "${stale}"`);
    }
  }
});

test('the save result stops contradicting the toast it fires alongside', () => {
  // `return { ok:false, error: 'Permission denied: save_project' }` looked
  // internal, but ui.js renders r.error verbatim in the save-status pill — so a
  // blocked save produced a translated toast and, next to it, an English pill
  // reading "Save failed: Permission denied: save_project".
  const pf = codeOnly(read('src/scripts/core/projectFile.js'));
  assert.ok(!/Permission denied/.test(pf),
    'projectFile.js still returns the raw permission key as its error text');
  assert.equal((pf.match(/reason: 'no_account_permission'/g) || []).length, 2,
    'both save paths should report a machine-readable reason instead of an English one');
  assert.ok(/deniedActionNotice\(\{ id: 'save_project' \}\)\.text/.test(pf),
    'the save refusal does not reuse the translated sentence');
  // Iteration 152 replaced ui.js's `r?.reason === 'no_account_permission'`
  // special case with a `silent` flag carried on the notice, so every caller
  // inherits the fix instead of the one that was hand-patched here. The
  // guarantee is unchanged: the save pill shows a translated sentence and the
  // banner stays shut when the guard toast has already spoken.
  const ui = codeOnly(read('src/scripts/ui.js'));
  assert.ok(!/Save failed: \$\{/.test(ui),
    'ui.js still prefixes the refusal with an untranslated "Save failed:"');
  assert.ok(/if \(!f\.silent\) showError\(f\.text\)/.test(ui),
    'ui.js no longer suppresses the banner for a refusal the guard toast already reported');
  assert.ok(/no_account_permission: 'not_allowed'/.test(read('src/scripts/core/failureText.js')),
    'the account refusal is not mapped to the cause the silent list names');
  assert.ok(/const SILENT = Object\.freeze\(\[[^\]]*'not_allowed'/.test(read('src/scripts/core/failureText.js')),
    "'not_allowed' dropped off the silent list, so the refusal is reported twice again");
  // And not under the code that already means something else: 'no_permission'
  // is the folder permission the OS refused, writeProjectV4ViaFS() returns it,
  // and it reaches this same caller. Sharing the code would have silenced that
  // failure's banner too, leaving a pill reading "Save failed: no_permission".
  assert.ok(!/reason: 'no_permission', error:/.test(pf),
    'the account refusal reuses the filesystem permission code');
});

test('guardedAction stopped interpolating the caller label', () => {
  // Its `label` argument was printed verbatim when supplied and the raw
  // permission key when it was not — the worst wording in the app, in the one
  // function every future call site was meant to use.
  assert.ok(/deny\(actionId\)/.test(guardSrc), 'guardedAction no longer routes through deny()');
  assert.ok(!/\$\{label\}|\$\{who\}/.test(guardSrc), 'guardedAction interpolates a caller string again');
  assert.ok(/return \{ guardedAction, toast, deny, denyText \};/.test(guardSrc), 'deny() is not exported');
});

test('the classic auth scripts can reach the translated wording', () => {
  // guarded-action.js, read-only.js and media-coordinator.js are plain
  // <script src=…> and cannot import, which is the structural reason every
  // string in them used to be an English literal. core/noticeGlobals.js is the
  // bridge; without its module tag the fallbacks ship instead.
  assert.ok(
    /<script type="module" src="scripts\/core\/noticeGlobals\.js"><\/script>/.test(indexHtml),
    'noticeGlobals.js is not loaded, so window.PFX_NOTICE never exists',
  );
  const bridge = read('src/scripts/core/noticeGlobals.js');
  assert.ok(/window\.PFX_NOTICE\s*=/.test(bridge), 'the bridge publishes nothing');
  for (const fn of ['guardNotice', 'readOnlyNotice', 'actionName']) {
    assert.ok(bridge.includes(fn), `the bridge does not publish ${fn}`);
  }
  // It bridges only. Any decision made here would be invisible to the scanner.
  assert.ok(!/translate\(/.test(bridge), 'the bridge grew wording of its own');
});

test('the badge no longer hard-codes one cause', () => {
  assert.ok(
    !readOnlySrc.includes('you do not have edit permissions'),
    'read-only.js still tells everyone their account is the problem',
  );
  assert.ok(/PFX_NOTICE\?\.readOnlyNotice/.test(readOnlySrc), 'the badge does not consult the notice builder');
  // apply() is called again when a lease changes hands, so the badge is
  // rewritten every time rather than only on create — otherwise the first
  // cause's tooltip stays on screen for the second cause's situation.
  const badge = readOnlySrc.slice(readOnlySrc.indexOf('function _ensureBadge'));
  assert.ok(/b\.title\s*=/.test(badge) && badge.indexOf('b.title') > badge.indexOf('appendChild'),
    'the tooltip is only set when the badge is created');
  assert.ok(/reason\b/.test(readOnlySrc) && /return \{ apply, remove, isActive, reason \};/.test(readOnlySrc),
    'read-only.js does not expose the reason it was given');
});

test('ui.js stops throwing away the reason the lease gave it', () => {
  // `(readOnly, reason) => { if (readOnly) apply(); }` is how a second open
  // window came to be reported as a missing permission.
  assert.ok(/PFX_LEASE\?\.init\?\.\(\(readOnly, reason\)/.test(uiSrc), 'the lease callback signature changed');
  assert.ok(/PFX_READONLY\?\.apply\?\.\(reason\)/.test(uiSrc), 'ui.js drops the lease reason again');
  assert.ok(/PFX_READONLY\?\.apply\?\.\('No edit permission'\)/.test(uiSrc),
    'the permission branch no longer names its own cause');
});

test('the shortcut gate decides whether to refuse, not what to say', () => {
  assert.ok(/PFX_GUARD\?\.deny\?\.\(actionId\)/.test(shortcutsSrc), 'shortcuts.js does not route through deny()');
  const gate = codeOnly(shortcutsSrc).slice(
    codeOnly(shortcutsSrc).indexOf('export function isShortcutAllowed'),
    codeOnly(shortcutsSrc).indexOf('function safeParseJSON'),
  );
  assert.ok(gate.length > 60, 'could not isolate the shortcut gate');
  assert.ok(!/Read-only|blocked"|\$\{actionId\}/.test(gate),
    'the shortcut gate spells its own wording again');
});

test('the toast can hold the longer wording without clipping', () => {
  const block = css.slice(css.indexOf('.pfx-guard-toast {'), css.indexOf('.pfx-guard-toast--on'));
  assert.ok(block.length > 100, 'could not isolate the toast rule');
  assert.ok(/white-space:\s*pre-line/.test(block), 'the toast collapses the newline between its two sentences');
  assert.ok(!/white-space:\s*nowrap/.test(block), 'the toast still refuses to wrap');
  // Centred with translateX(-50%), so an unbounded width is clipped at *both*
  // edges rather than overflowing to one side where it could be scrolled to.
  assert.ok(/max-width:/.test(block), 'the toast has no width bound, so long wording runs off screen');
});

test('the new wording exists in every locale', () => {
  // errorI18n.test.mjs proves this for the whole scanned set; these are the two
  // rows where the product name is load-bearing and a translator dropping it
  // would leave the sentence naming no application at all.
  const i18nSrc = read('src/scripts/modules/i18n.js');
  for (const key of [
    'This project is open in another PostFlowX window',
    'Ask whoever set up your PostFlowX account if you need to make changes.',
    'Read Only',
    'Play Video',
  ]) {
    const n = (i18nSrc.match(new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}":`, 'g')) || []).length;
    assert.equal(n, 6, `"${key}" has ${n} rows, not one per locale`);
  }
});
