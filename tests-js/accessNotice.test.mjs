// tests-js/accessNotice.test.mjs
// The screen a locked-out user actually lands on.
//
// core/workspaceAccess.js gave the refusal *toast* a name and a next step.
// auth/noAccessView.js — the full pane that replaces a whole workspace — kept
// the old words: "Access Restricted" and "You don't have permission to access
// this feature with your current role.", in English, in all six locales,
// because nothing scanned it. These tests hold three things in place: the
// panel and the toast say the same sentence for the same event, the pending
// state offers a control instead of an instruction, and every value that
// reaches innerHTML goes through the escaper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  ACCESS_CONTACT,
  ACCESS_STATUSES,
  accessStatus,
  accessNotice,
  actionName,
  deniedActionNotice,
} from '../src/scripts/core/accessNotice.js';
import { lockedWorkspaceNotice, WORKSPACE_NAMES } from '../src/scripts/core/workspaceAccess.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const viewSrc = readFileSync(join(ROOT, 'src/scripts/auth/noAccessView.js'), 'utf8');
const uiSrc = readFileSync(join(ROOT, 'src/scripts/ui.js'), 'utf8');
const acesSrc = readFileSync(join(ROOT, 'src/scripts/features/aceslook/index.js'), 'utf8');
const permSrc = readFileSync(join(ROOT, 'src/scripts/auth/permissions.js'), 'utf8');
const indexHtml = readFileSync(join(ROOT, 'src/index.html'), 'utf8');

test('accessStatus is total: anything it does not know is the state that promises nothing', () => {
  for (const s of ACCESS_STATUSES) assert.equal(accessStatus(s), s);
  assert.equal(accessStatus('  PENDING  '), 'pending');
  assert.equal(accessStatus('Disabled'), 'disabled');
  assert.equal(accessStatus('nonsense'), 'denied');
  for (const empty of [undefined, null, '', '   ']) assert.equal(accessStatus(empty), 'denied');
  // Not a prototype lookup, for the same reason workspaceName() is not one:
  // this value arrives from an auth payload, and `constructor` must not become
  // a truthy status that skips the default.
  assert.equal(accessStatus('constructor'), 'denied');
});

test('every status says what happened and who can change it', () => {
  for (const status of [...ACCESS_STATUSES, 'nonsense']) {
    const n = accessNotice({ status, key: 'platelink2' });
    assert.ok(n.heading.trim().length > 0, `${status} has no heading`);
    assert.ok(n.body.trim().length > 0, `${status} has no body`);
    assert.ok(n.contactLabel.trim().length > 0, `${status} has no contact label`);
    // The whole point of the rewrite: no blame, no admin console vocabulary,
    // no error codes. "role" in particular is the word a colourist cannot act on.
    assert.ok(
      !/denied|forbidden|restricted|permission|\brole\b/i.test(`${n.heading} ${n.body}`),
      `${status} still reads like a security log: ${n.heading} — ${n.body}`,
    );
  }
});

test('the panel and the toast say the same sentence about the same event', () => {
  // Not merely similar: byte-identical, so there is one dictionary row to keep
  // right rather than two that drift into two different explanations.
  const panel = accessNotice({ status: 'denied', key: 'platelink2' });
  const toast = lockedWorkspaceNotice({});
  assert.equal(panel.heading, toast.opening);
  assert.equal(panel.body, toast.next);
});

test('the badge names the workspace the way the tab does', () => {
  assert.equal(accessNotice({ key: 'platelink2' }).name, 'PLATE LINK 2.0');
  assert.equal(accessNotice({ key: 'aceslook' }).name, 'ACES LOOK');
  // No key is a real case (an action-level block with no workspace); the panel
  // must then draw no badge at all rather than an empty pill.
  assert.equal(accessNotice({}).name, '');
});

test('only pending gets a button, because only pending can be resolved from here', () => {
  const pending = accessNotice({ status: 'pending' });
  assert.ok(pending.hint.trim().length > 0);
  assert.ok(pending.reloadLabel.trim().length > 0);
  for (const status of ['denied', 'disabled']) {
    const n = accessNotice({ status });
    assert.equal(n.hint, '', `${status} offers a reload hint that cannot help`);
    assert.equal(n.reloadLabel, '', `${status} offers a reload button that cannot help`);
  }
});

test('the contact address has a default and survives a blank override', () => {
  assert.equal(accessNotice({}).contact, ACCESS_CONTACT);
  assert.equal(accessNotice({ contact: '  ' }).contact, ACCESS_CONTACT);
  assert.equal(accessNotice({ contact: 'someone@example.com' }).contact, 'someone@example.com');
});

test('a blocked action is named, and is not accused', () => {
  const n = deniedActionNotice({ id: 'export_csv' });
  assert.ok(n.text.includes('Export CSV'), `the toast no longer says which action: ${n.text}`);
  // Was "⊘ Permission denied: Export CSV" — a log line with a prohibition sign.
  assert.ok(!/⊘|denied|permission/i.test(n.text), `blame-shaped wording: ${n.text}`);
  // No label to quote, so the sentence must stand alone rather than trail a
  // dangling colon and a pair of empty quotes.
  const bare = deniedActionNotice({});
  assert.ok(!bare.text.endsWith(':'), `dangling colon: ${bare.text}`);
  assert.ok(!bare.text.includes('“'), `empty quotes: ${bare.text}`);
});

test('an action id never reaches the user as an action id', () => {
  // The toast used to fall back to String(actionId), so an id the table did not
  // know was printed verbatim: `Your account cannot do this: "edit_cut"`. That
  // is a word from the permissions schema, quoted at someone who has never seen
  // the schema and cannot act on it. Saying less is the better answer.
  // `edit_cut` and `import_media` used to stand here as unknown ids, and the
  // better answer to those two turned out to be naming them rather than saying
  // less — the guard channel refuses them, so a user meets them. They moved to
  // the row below. What stays here is the case no table can ever cover.
  for (const unknown of ['nope', 'constructor', 'toString', '__proto__']) {
    assert.equal(actionName(unknown), '', `${unknown} is echoed back as its own name`);
    const t = deniedActionNotice({ id: unknown }).text;
    assert.ok(!t.includes(unknown), `the toast quotes the raw id: ${t}`);
    assert.ok(!/_/.test(t), `snake_case leaked into the toast: ${t}`);
  }
  for (const empty of [undefined, null, '', '   ']) assert.equal(actionName(empty), '');

  // Named now, and named in words. Not "reads like the id with the underscore
  // taken out" — `edit_cut` → "Edit Cut" is exactly that and is also the right
  // English, so the only thing worth asserting is that a person could read it.
  for (const known of ['edit_cut', 'import_media', 'play_media', 'undo', 'redo']) {
    const name = actionName(known);
    assert.notEqual(name, '', `${known} is refusable but nameless`);
    assert.ok(!/_/.test(name), `${known} kept its underscore: ${name}`);
    assert.ok(/^[A-Z]/.test(name), `${known} is not written as a label: ${name}`);
  }
});

test('every action id the renderer can block has a name', () => {
  // Not a spot check: the ids are grepped out of the call sites, so a new
  // showDeniedToast('…') with no entry in the table fails here rather than
  // shipping a nameless toast.
  const ids = new Set();
  for (const src of [uiSrc, acesSrc, permSrc, viewSrc,
    readFileSync(join(ROOT, 'src/scripts/features/aceslook/cards/ExportCard.js'), 'utf8')]) {
    for (const m of src.matchAll(/showDeniedToast\(\s*'([a-z_]+)'\s*\)/g)) ids.add(m[1]);
    for (const m of src.matchAll(/_ACTION_KEYS\s*=\s*\{([^}]*)\}/g)) {
      for (const p of m[1].matchAll(/'([a-z_]+)'/g)) ids.add(p[1]);
    }
  }
  assert.ok(ids.size > 0, 'the call-site scan found nothing, so this test proves nothing');
  for (const id of ids) {
    assert.notEqual(actionName(id), '', `${id} is blocked somewhere but has no name`);
  }
});

test('a locked tab gets the workspace sentence, not a half-answer', () => {
  // permissions.js openTab() sends this toast a workspace, not an action. The
  // two paths are one event to the user — a tab that will not open — so they
  // say the same thing, byte for byte, rather than two descriptions of it.
  for (const key of Object.keys(WORKSPACE_NAMES)) {
    const n = deniedActionNotice({ id: key });
    assert.equal(n.text, lockedWorkspaceNotice({ key }).text, `${key} drifted from the toast`);
    assert.ok(n.text.includes(WORKSPACE_NAMES[key]), `${key} is not named`);
  }
});

test('openTab hands the toast a key the name table knows', () => {
  // The bug this replaced: openTab computed `dataMain` one line *below* the
  // refusal, so the toast got the canonical key ('plate_link') while every
  // name table in the app is keyed by data-main ('platelink2').
  assert.ok(
    /showDeniedToast\(dataMain\)/.test(permSrc),
    'openTab passes the canonical tab key again, so the toast prints a raw key',
  );
  const gate = permSrc.slice(permSrc.indexOf('function openTab('), permSrc.indexOf('function openTab(') + 700);
  assert.ok(
    gate.indexOf('const dataMain') < gate.indexOf('showDeniedToast'),
    'dataMain is still resolved after the refusal, so the toast cannot use it',
  );
});

test('the toast can show a two-line notice without running it together', () => {
  // The workspace wording is "<what happened>\n<who can fix it>". textContent
  // keeps the newline; the default white-space collapses it on screen.
  assert.ok(/white-space:pre-line/.test(viewSrc), 'the toast collapses its second sentence');
});

test('the panel escapes everything it interpolates', () => {
  const body = viewSrc.slice(viewSrc.indexOf('container.innerHTML = `'), viewSrc.indexOf('`;', viewSrc.indexOf('container.innerHTML = `')));
  assert.ok(body.length > 400, 'could not isolate the panel markup');
  for (const m of body.matchAll(/\$\{([^}]*)\}/g)) {
    const expr = m[1].trim();
    assert.ok(
      expr.includes('_esc(') || expr.startsWith('n.name ?') || expr.startsWith('n.reloadLabel ?') || expr === '_ICON_LOCK',
      `unescaped interpolation in the no-access panel: \${${expr}}`,
    );
  }
  // The two literals the old version dropped in raw.
  assert.ok(!body.includes('${feature}'), 'the workspace name is still interpolated raw');
  assert.ok(!/\$\{msg\./.test(body), 'the message object is still interpolated raw');
});

test('the reload instruction comes with something to click', () => {
  assert.ok(viewSrc.includes('data-pfx-noaccess-reload'), 'the reload button is gone');
  assert.ok(
    /querySelector\('\[data-pfx-noaccess-reload\]'\)[\s\S]{0,80}addEventListener\('click'/.test(viewSrc),
    'the reload button is drawn but never wired, so it does nothing',
  );
  // Wired, not inline: an onclick= attribute would be a new thing for the CSP
  // and the XSS gate to reason about for no gain.
  assert.ok(!/onclick=/.test(viewSrc), 'the panel grew an inline handler');
});

test('a screen reader is told the pane changed', () => {
  // The pane is replaced in place with no navigation and no focus move, so
  // without a live region the user is told nothing at all.
  assert.ok(/role="status"/.test(viewSrc), 'the panel is not a live region');
  assert.ok(/aria-live="polite"/.test(viewSrc), 'the panel does not announce itself');
  assert.ok(/<svg aria-hidden="true"/.test(viewSrc), 'the lock icon is not hidden from the reader');
  assert.ok(/setAttribute\('role', 'status'\)/.test(viewSrc), 'the action toast is not announced');
});

test('no English sentence is left in the view layer', () => {
  // Words belong in core/accessNotice.js, where errorI18n.test.mjs can see
  // them. Anything sentence-shaped here is a string that ships untranslated.
  for (const stale of ['Access Restricted', 'current role', 'Permission denied', 'refresh your session']) {
    assert.ok(!viewSrc.includes(stale), `auth/noAccessView.js still carries the untranslated "${stale}"`);
  }
});

test('the view is loaded as a module, or its import never runs', () => {
  assert.ok(
    /<script type="module" src="scripts\/auth\/noAccessView\.js"><\/script>/.test(indexHtml),
    'noAccessView.js imports but is loaded as a classic script, so the panel never renders',
  );
});

test('no caller spells the workspace name itself', () => {
  // features/aceslook/index.js passed feature: 'ACES Look' at a tab labelled
  // ACES LOOK — the fifth copy of a name, and the drift workspaceAccess.js
  // was written to end. Both call sites now pass the key and let the table win.
  // Matched as a call site, not as bare text: the comment left at that line
  // quotes the wording it replaced, and keeping that record is the point of it.
  assert.ok(!/feature:\s*'ACES Look'/.test(acesSrc), 'the ACES panel still spells its own name');
  assert.ok(
    /renderNoAccess\(root, \{ status, key: 'aceslook' \}\)/.test(acesSrc),
    'the ACES panel no longer passes its data-main key',
  );
  assert.ok(
    /renderNoAccess\(target, \{ status: _tabStatus, key \}\)/.test(uiSrc),
    'the tab gate no longer passes the workspace key to the no-access panel',
  );
});

test('an unknown action id cannot pull a function out of the prototype chain', () => {
  // actionId reaches actionName() from call sites all over the renderer, so a
  // plain lookup would let `constructor` render a function body in the toast.
  // Asserted as behaviour, not as source text — the check above covers the
  // wording, this one covers the shape.
  assert.equal(actionName('constructor'), '');
  assert.equal(actionName('hasOwnProperty'), '');
  assert.equal(actionName('__proto__'), '');
});

test('the view layer no longer carries a name table of its own', () => {
  // The whole point of the move: names live where the i18n scanner can see
  // them. A second table here would go untranslated exactly as the first did.
  assert.ok(!/_actionLabel/.test(viewSrc), 'auth/noAccessView.js resolves names again');
  assert.ok(
    !/'Export CSV'|'Open Project'|'Save Preset'/.test(viewSrc),
    'auth/noAccessView.js spells action names in English again',
  );
  assert.ok(
    /deniedActionNotice\(\{ id: actionId \}\)/.test(viewSrc),
    'the view resolves the id before handing it over, which hides it from the scanner',
  );
});

test('no action name is defined in two dictionaries at once', () => {
  // Export CSV/PDF/XLSX already existed in LOCALE_FULL_DICT and PARITY_DICT.
  // They were moved into ERROR_DICT rather than copied: six rows per key, not
  // twelve, so there is one place to fix a translation and no silent winner.
  const i18nSrc = readFileSync(join(ROOT, 'src/scripts/modules/i18n.js'), 'utf8');
  for (const key of ['Export CSV', 'Export PDF', 'Export XLSX', 'Open Project', 'Open ACES Look']) {
    const n = (i18nSrc.match(new RegExp(`"${key}":`, 'g')) || []).length;
    assert.equal(n, 6, `"${key}" has ${n} rows, not one per locale`);
  }
});
