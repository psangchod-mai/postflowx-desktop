// Tests for the Gandalf authorization mapper (replaces the Apps Script AccessControl
// sheet). Verifies role→permission expansion and that a Gandalf decision produces
// the SAME nested session shape the renderer already consumes (permissions.js).
import assert from 'node:assert/strict';
import {
  permissionsForRole, sessionFromDecision, resolveSession,
  PFX_GATED_TABS, PFX_MUTATING_ACTIONS,
} from '../src/scripts/auth/gandalfAuthz.js';

// ── role → permissions ──
assert.deepEqual(permissionsForRole('admin'),  { role: 'admin',  tabs: ['*'], actions: ['*'] });
assert.equal(permissionsForRole('editor').actions.length, PFX_MUTATING_ACTIONS.length);
assert.equal(permissionsForRole('editor').tabs.length, PFX_GATED_TABS.length);
assert.deepEqual(permissionsForRole('viewer').actions, [], 'viewer is read-only');
assert.equal(permissionsForRole('bogus').role, 'viewer', 'unknown role → viewer (safe default)');

// ── decision → session shape (matches pfxAuthNestedSession_) ──
const denied = sessionFromDecision({ email: 'x@netflix.com', access: false });
assert.deepEqual(denied, { ok: false, status: 'pending' }, 'no access → pending');

const adminSess = sessionFromDecision({
  email: 'A@Netflix.com', access: true, memberships: { 'postflowx-admins': true },
});
assert.equal(adminSess.ok, true);
assert.equal(adminSess.status, 'active');
assert.equal(adminSess.role, 'admin');
assert.deepEqual(adminSess.permissions, { tabs: ['*'], actions: ['*'] });
assert.equal(adminSess.user.email, 'a@netflix.com', 'email normalized lowercase');
assert.equal(adminSess.user.name, 'A', 'name defaults to local-part');

// highest-privilege group wins
const both = sessionFromDecision({
  email: 'e@netflix.com', access: true,
  memberships: { 'postflowx-admins': true, 'postflowx-editors': true },
});
assert.equal(both.role, 'admin', 'admin outranks editor');

const editor = sessionFromDecision({
  email: 'e@netflix.com', access: true, memberships: { 'postflowx-editors': true },
});
assert.equal(editor.role, 'editor');
assert.ok(editor.permissions.actions.includes('save_project'));

const viewer = sessionFromDecision({ email: 'v@netflixpartner.com', access: true, memberships: {} });
assert.equal(viewer.role, 'viewer', 'admitted but in no role group → viewer');
assert.deepEqual(viewer.permissions.actions, []);

// ── resolveSession with an injected (mock) Gandalf client ──
const mkGandalf = (opts) => ({
  async isAuthorized({ email }) { return opts.authorized.includes(email); },
  async isMember({ email, group }) { return (opts.groups[email] || []).includes(group); },
});

const g = mkGandalf({
  authorized: ['boss@netflix.com', 'cutter@netflix.com', 'watch@netflix.com'],
  groups: { 'boss@netflix.com': ['postflowx-admins'], 'cutter@netflix.com': ['postflowx-editors'] },
});

const rAdmin  = await resolveSession({ email: 'boss@netflix.com',   gandalf: g });
const rEditor = await resolveSession({ email: 'cutter@netflix.com', gandalf: g });
const rViewer = await resolveSession({ email: 'watch@netflix.com',  gandalf: g });
const rDenied = await resolveSession({ email: 'stranger@netflix.com', gandalf: g });

assert.equal(rAdmin.role, 'admin');
assert.equal(rEditor.role, 'editor');
assert.equal(rViewer.role, 'viewer');
assert.deepEqual(rDenied, { ok: false, status: 'pending' }, 'unknown user denied');

// contract guards
await assert.rejects(() => resolveSession({ email: 'a@b.com', gandalf: {} }),
  /Gandalf client/, 'missing client throws');
assert.deepEqual(await resolveSession({ email: '', gandalf: g }), { ok: false, status: 'pending' });

console.log('gandalfAuthz tests passed');
