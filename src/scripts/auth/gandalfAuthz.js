// gandalfAuthz.js — PostFlowX authorization via Gandalf (replaces the Google
// Apps Script + Sheets AccessControl backend).
//
// WHY: authZ state (who can use PostFlowX, their role, and per-tab/action
// permissions) previously lived in a Google Sheet resolved by Apps Script
// (apps-script/auth-access/PfxAuthAccess.gs `pfxAuthResolveAccess_`). NECP's
// paved-road guidance (go/gandalf) is to use Gandalf as the authorization
// authority with Metatron/Meechum for identity. This module is the pure mapping
// layer: a Gandalf decision → the exact session shape the renderer already
// consumes, so nothing downstream (permissions.js / boot-guard / auth.js) changes.
//
// AuthN (Meechum/Edward → verified email) is unchanged. This module only owns
// AuthZ. It must run server-side (a Netflix backend/DGS/SBN service or the
// Gandalf Agent sidecar) — a desktop client cannot hold the identity used to
// query Gandalf. See docs/GANDALF_AUTHZ.md for the policy + deployment.
//
// Dual export: ES module (`import`) for the renderer/tests and CommonJS
// (`module.exports`) for a Node backend/agent.

// ── Canonical RBAC vocabulary (mirrors permissions.js TAB_CANONICAL_TO_DATA_MAIN
//    and the mutating-action list in isReadOnly()) ──────────────────────────────
export const PFX_GATED_TABS = [
  'pull_prep', 'cut_diff', 'plate_link', 'visual_qc', 't_conform',
  'bwav', 'preflight', 'imf', 'aces_look',
]; // render_queue + settings are always open (never gated) — see permissions.js

export const PFX_MUTATING_ACTIONS = [
  'save_project', 'load_timeline', 'load_video',
  'add_marker', 'edit_marker_meta', 'delete_marker',
  'open_annotation', 'edit_annotation',
  'export_csv', 'export_pdf', 'export_xlsx', 'export_package',
  'relink_all',
  'open_aces_look', 'save_aces_preset', 'load_aces_preset',
  'export_amf', 'export_clf', 'export_cdl', 'export_color_summary',
];

// Canonical role → permission set. This is the single source of truth that
// replaces free-form per-user `allowed_tabs` / `allowed_actions` sheet columns:
// group membership decides the ROLE, the role decides the permissions.
export const PFX_ROLES = {
  admin:  { tabs: ['*'],                actions: ['*'] },              // everything
  editor: { tabs: [...PFX_GATED_TABS],  actions: [...PFX_MUTATING_ACTIONS] }, // full editing
  viewer: { tabs: [...PFX_GATED_TABS],  actions: [] },                // read-only
};

/** Permission set ({tabs, actions}) for a role name; unknown → viewer (safe default). */
export function permissionsForRole(role) {
  const r = PFX_ROLES[role] ? role : 'viewer';
  const p = PFX_ROLES[r];
  return { role: r, tabs: [...p.tabs], actions: [...p.actions] };
}

// Highest-privilege group wins. Extend here if more roles/groups are added.
export const ROLE_GROUPS = [
  { role: 'admin',  group: 'postflowx-admins'  },
  { role: 'editor', group: 'postflowx-editors' },
  // everyone who passes the access gate but is in no role group → viewer
];

/**
 * Pure mapper: a resolved Gandalf decision → the nested PostFlowX session shape
 * (identical to Apps Script `pfxAuthNestedSession_`). No I/O — unit-testable.
 *
 * @param {object} p
 * @param {string}  p.email          verified Meechum identity
 * @param {boolean} p.access         result of the `postflowx` access-gate policy
 * @param {Record<string,boolean>} [p.memberships] group name → is-member
 * @param {object}  [p.featureFlags] optional flags to pass through
 * @param {string}  [p.expiresAt]    optional ISO expiry (session TTL)
 * @param {string}  [p.name] @param {string} [p.picture]
 * @returns {{ok:boolean,status:string,role?:string,permissions?:object,featureFlags?:object,expiresAt?:string,sessionToken?:string,user?:object}}
 */
export function sessionFromDecision({ email, access, memberships = {}, featureFlags = {}, expiresAt = '', name = '', picture = '' }) {
  if (!access) return { ok: false, status: 'pending' };  // not admitted by the policy
  // Highest-privilege matching group wins; default viewer.
  let role = 'viewer';
  for (const { role: r, group } of ROLE_GROUPS) {
    if (memberships[group]) { role = r; break; }
  }
  const perms = permissionsForRole(role);
  return {
    ok: true,
    status: 'active',
    role: perms.role,
    permissions: { tabs: perms.tabs, actions: perms.actions },
    featureFlags: featureFlags || {},
    expiresAt: expiresAt || '',
    sessionToken: '',
    user: { email: String(email || '').toLowerCase(), name: name || String(email || '').split('@')[0], picture: picture || '' },
  };
}

/**
 * Resolve a full session by querying an injected Gandalf client. The client is
 * an interface so this is testable with a mock and swappable for the real
 * `gandalf-authz-client` (Node) or the Gandalf Agent HTTP API.
 *
 * @param {object} p
 * @param {string} p.email
 * @param {{ isAuthorized(a:{email:string,policy:string,action:string}):Promise<boolean>,
 *           isMember(a:{email:string,group:string}):Promise<boolean> }} p.gandalf
 * @param {string} [p.policy='postflowx']
 * @param {string} [p.accessAction='access']
 * @param {object} [p.extras] name/picture/featureFlags/expiresAt passthrough
 */
export async function resolveSession({ email, gandalf, policy = 'postflowx', accessAction = 'access', extras = {} }) {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return { ok: false, status: 'pending' };
  if (!gandalf || typeof gandalf.isAuthorized !== 'function') {
    throw new Error('resolveSession: a Gandalf client with isAuthorized() is required');
  }
  const access = await gandalf.isAuthorized({ email: em, policy, action: accessAction });
  if (!access) return { ok: false, status: 'pending' };

  const memberships = {};
  if (typeof gandalf.isMember === 'function') {
    const results = await Promise.all(
      ROLE_GROUPS.map(({ group }) => gandalf.isMember({ email: em, group }).catch(() => false)),
    );
    ROLE_GROUPS.forEach(({ group }, i) => { memberships[group] = !!results[i]; });
  }
  return sessionFromDecision({ email: em, access: true, memberships, ...extras });
}
