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
  deniedActionNotice,
} from '../src/scripts/core/accessNotice.js';
import { lockedWorkspaceNotice } from '../src/scripts/core/workspaceAccess.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const viewSrc = readFileSync(join(ROOT, 'src/scripts/auth/noAccessView.js'), 'utf8');
const uiSrc = readFileSync(join(ROOT, 'src/scripts/ui.js'), 'utf8');
const acesSrc = readFileSync(join(ROOT, 'src/scripts/features/aceslook/index.js'), 'utf8');
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
  const n = deniedActionNotice({ label: 'Export CSV' });
  assert.ok(n.text.includes('Export CSV'), `the toast no longer says which action: ${n.text}`);
  // Was "⊘ Permission denied: Export CSV" — a log line with a prohibition sign.
  assert.ok(!/⊘|denied|permission/i.test(n.text), `blame-shaped wording: ${n.text}`);
  // No label to quote, so the sentence must stand alone rather than trail a
  // dangling colon and a pair of empty quotes.
  const bare = deniedActionNotice({});
  assert.ok(!bare.text.endsWith(':'), `dangling colon: ${bare.text}`);
  assert.ok(!bare.text.includes('“'), `empty quotes: ${bare.text}`);
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
  // actionId reaches _actionLabel from call sites all over the renderer.
  assert.ok(
    /Object\.hasOwn\(map, actionId\)/.test(viewSrc),
    '_actionLabel is a plain lookup again, so `constructor` renders a function body in the toast',
  );
});
