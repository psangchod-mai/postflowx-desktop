// tests-js/workspaceAccess.test.mjs
// One name per workspace, and a pin that cannot lie.
//
// core/workspaceAccess.js exists because four places in the renderer turned a
// `data-main` key into something a person reads, and they disagreed: the tab
// said PLATE LINK 2.0, the Toolbox card said PLATE LINK 2.0, the no-access
// panel said "Plate Link", and the refusal toast said "platelink2". These
// tests are what stops that from growing back. The table is checked against
// src/index.html, not against itself, because src/index.html is the surface
// the user actually learns the name from — if somebody renames a tab there and
// not here, that is exactly the drift the module was written to end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  WORKSPACE_NAMES,
  workspaceName,
  lockedWorkspaceNotice,
  lockedPinNotice,
} from '../src/scripts/core/workspaceAccess.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(join(ROOT, 'src/index.html'), 'utf8');
const uiSrc = readFileSync(join(ROOT, 'src/scripts/ui.js'), 'utf8');

// The visible label of a toolbar tab: the text after the accent <span class="bar">
// and before the closing </div>, which is where every tab in the strip puts it.
function tabLabels(html) {
  const out = {};
  for (const m of html.matchAll(/<div class="tab [^>]*data-main="([^"]+)"[\s\S]*?<span class="bar"><\/span>([^<]*)<\/div>/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

test('every workspace name matches the label printed on its toolbar tab', () => {
  const labels = tabLabels(indexHtml);
  assert.ok(Object.keys(labels).length >= 9, `only found ${Object.keys(labels).length} tab labels`);
  for (const [key, name] of Object.entries(WORKSPACE_NAMES)) {
    assert.equal(
      labels[key],
      name,
      `WORKSPACE_NAMES.${key} is "${name}" but src/index.html's tab reads "${labels[key]}"`,
    );
  }
});

test('the table covers every tab that can be pinned or gated', () => {
  // The union of the two ui.js tables the module replaced. Miss one and that
  // workspace falls back to its raw data-main key in a refusal toast.
  const movable = uiSrc.slice(
    uiSrc.indexOf('const __PFX_TOOLBOX_MOVABLE_TABS = Object.freeze({'),
    uiSrc.indexOf('});', uiSrc.indexOf('const __PFX_TOOLBOX_MOVABLE_TABS = Object.freeze({')),
  );
  const movableKeys = [...movable.matchAll(/^\s{2}(\w+):\s*\{/gm)].map((m) => m[1]);
  assert.ok(movableKeys.length >= 9, `only found ${movableKeys.length} movable tabs`);

  const gated = uiSrc.match(/const _GATED_TABS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(gated, '_GATED_TABS is no longer a Set literal — update this test');
  const gatedKeys = [...gated[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(gatedKeys.length >= 7, `only found ${gatedKeys.length} gated tabs`);

  for (const key of new Set([...movableKeys, ...gatedKeys])) {
    assert.ok(
      Object.hasOwn(WORKSPACE_NAMES, key),
      `"${key}" can be pinned or gated but has no name in WORKSPACE_NAMES, so a refusal would call it "${key}"`,
    );
  }
});

test('ui.js keeps no second copy of a workspace name', () => {
  // The old `_gatedTabs` map and the old `label:` rows were the second and
  // third copies. A name reappearing as a literal in ui.js means a fourth.
  for (const name of Object.values(WORKSPACE_NAMES)) {
    assert.ok(
      !uiSrc.includes(`'${name}'`) && !uiSrc.includes(`"${name}"`),
      `ui.js contains the literal "${name}" — the name belongs only in core/workspaceAccess.js`,
    );
  }
});

test('the old disagreeing names are gone', () => {
  for (const stale of ["platelink2: 'Plate Link'", "'PULLS PREP 2.0'", "bwav: 'BWav Tools'"]) {
    assert.ok(!uiSrc.includes(stale), `ui.js still carries the old second name ${stale}`);
  }
  // Matched as call sites, not as bare text: the comments at both sites quote
  // the wording they replaced, and that record is the point of keeping them.
  assert.ok(
    !/toast\?\.\(\s*`Access denied/.test(uiSrc),
    'the refusal toast still names the workspace by its raw data-main key',
  );
  assert.ok(
    !/toast\?\.\(\s*'This workspace is not enabled/.test(uiSrc),
    'the card refusal is still an untranslated English literal',
  );
});

test('workspaceName is total: a key it does not know comes back as itself', () => {
  assert.equal(workspaceName('platelink2'), 'PLATE LINK 2.0');
  assert.equal(workspaceName('  platelink2  '), 'PLATE LINK 2.0');
  assert.equal(workspaceName('nosuchtab'), 'nosuchtab');
  for (const empty of [undefined, null, '', '   ']) assert.equal(workspaceName(empty), '');
  // Not a prototype lookup: `constructor` must not resolve to a function.
  assert.equal(workspaceName('constructor'), 'constructor');
  assert.equal(workspaceName('toString'), 'toString');
});

test('the table cannot be edited at runtime', () => {
  assert.throws(() => { WORKSPACE_NAMES.platelink2 = 'x'; }, TypeError);
});

test('a refusal names the workspace and says who can change it', () => {
  const n = lockedWorkspaceNotice({ key: 'platelink2' });
  assert.equal(n.name, 'PLATE LINK 2.0');
  assert.ok(n.opening.includes('PLATE LINK 2.0'), 'the refusal does not name the workspace');
  assert.ok(/whoever set up/.test(n.next), 'the refusal gives no next step');
  assert.equal(n.text, `${n.opening}\n${n.next}`);
  assert.ok(!/denied|error|forbidden/i.test(n.text), `blame-shaped wording: ${n.text}`);
});

test('a refusal for an unknown workspace still reads as a sentence', () => {
  // No name to quote, so the opening must stand alone rather than trail a
  // dangling colon — this is the shape a future un-tabled key would hit.
  const n = lockedWorkspaceNotice({});
  assert.equal(n.name, '');
  assert.ok(!n.opening.endsWith(':'), `dangling colon: ${n.opening}`);
  assert.ok(!n.opening.includes('“'), `empty quotes: ${n.opening}`);
  assert.ok(/whoever set up/.test(n.next));
});

test('the pin refusal explains that pinning would not have helped', () => {
  const n = lockedPinNotice({ key: 'bwav' });
  assert.equal(n.name, 'BWAV INSPECTOR');
  assert.ok(n.opening.includes('BWAV INSPECTOR'));
  assert.ok(/will not make the tab appear/.test(n.opening), `says nothing about the tab: ${n.opening}`);
  // Same remedy as the other notice, word for word — one translation to keep right.
  assert.equal(n.next, lockedWorkspaceNotice({ key: 'bwav' }).next);
});

test('the pin button refuses a locked workspace before it writes anything', () => {
  // The bug: the pin had no permission check, so it wrote pinned:true to
  // localStorage, lit up, and the tab still never appeared — permanently.
  const handler = uiSrc.slice(
    uiSrc.indexOf("workspaceTabsHost.querySelectorAll('.tb-workspace-pin')"),
    uiSrc.indexOf('// Delegated click handler for workspace tab cards'),
  );
  assert.ok(handler.length > 200 && handler.length < 3000, 'could not isolate the pin handler');
  const guard = handler.indexOf("btn.dataset.locked === '1'");
  const write = handler.indexOf('_pfxSetMovableTabPinned(');
  assert.ok(guard !== -1, 'the pin handler still has no permission check');
  assert.ok(write !== -1, 'the pin handler no longer writes — update this test');
  assert.ok(guard < write, 'the permission check runs after the write, so the setting still persists');
  assert.ok(handler.includes('lockedPinNotice'), 'the pin refusal is silent');
});

test('the pin button knows whether its workspace is locked', () => {
  // The guard above reads data-locked, so the markup has to set it.
  assert.ok(
    /class="tb-workspace-pin[^"]*"[\s\S]{0,400}?data-locked="\$\{allowed \? '0' : '1'\}"/.test(uiSrc),
    'the pin button no longer carries data-locked, so its guard can never fire',
  );
});

test('each card button says which workspace it moves', () => {
  // Nine cards drew nine identical "Move up" buttons. Sighted users tell them
  // apart by the row; a screen reader reads the accessible name alone.
  const start = uiSrc.indexOf('const named = (label)');
  assert.ok(start !== -1, 'the named() helper is gone — update this test');
  const cards = uiSrc.slice(start, uiSrc.indexOf('.join(\'\');', start));
  for (const cls of ['tb-workspace-move-up', 'tb-workspace-move-dn', 'tb-workspace-pin']) {
    const at = cards.indexOf(`${cls}`);
    assert.ok(at !== -1, `.${cls} is no longer rendered`);
    const btn = cards.slice(cards.lastIndexOf('<button', at), cards.indexOf('>', at));
    assert.ok(btn.includes('aria-label="${named('), `.${cls} has no workspace-named accessible name`);
    assert.ok(btn.includes('title="${escHtml('), `.${cls} lost its short tooltip`);
  }
});
