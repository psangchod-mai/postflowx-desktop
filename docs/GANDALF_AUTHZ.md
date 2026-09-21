# PostFlowX Authorization — Gandalf migration

Replaces the Google Apps Script + Google Sheets `AccessControl` backend
(`apps-script/auth-access/PfxAuthAccess.gs` → `pfxAuthResolveAccess_`) with
**Gandalf**, the Netflix paved-road authorization authority. Identity
(**Meechum/Edward** → verified email) is unchanged; only *authorization* moves.

Source: NECP (go/necp) full-evidence answer + Gandalf MCP validation against prod
(2026-07). See also `docs/PARTNER_AUTH.md`.

---

## Why move off Apps Script + Sheets

Today a Google Sheet is the security source of truth: each row is
`email, role, status, allowed_tabs, allowed_actions, feature_flags, …`. Problems:
a spreadsheet gates production content access (audit/latency/tamper risk), group
membership is hand-maintained, and there is no closed-group guarantee.

Gandalf gives: a real policy authority, closed **Pandora**-backed group
membership, and per-resource ACLs — with a Node client so an Electron/Node stack
needs no rewrite.

---

## Validated building blocks (Gandalf MCP, prod)

| Name | Type | Status | Use |
|---|---|---|---|
| `all-netflix-employees` | warden, allow, `read_only` (id 3793) | ✅ exists | workforce access |
| `all-netflix-partners` | valarin `match("@netflixpartner\.com$", $.subject.user.email)`, allow, `read_only` (id 377357) | ✅ exists | partner access |
| `postflowx` | policy | ❌ **does not exist yet** (HTTP 412) | **create at go/gandalf** |

---

## Target design

### 1. Access gate — policy `postflowx`
A subject is admitted if **any** allow rule matches. Create policy `postflowx`
with allow rules:
1. `all-netflix-employees` (workforce), and
2. `all-netflix-partners` (or a narrower `postflowx-partners` id-group if partner
   access should be scoped tighter than "any @netflixpartner.com").

`isAuthorized(subject, policy="postflowx", action="access")` → replaces the
sheet's `status: active | pending`.

### 2. Roles — Gandalf ID Groups (delegated to closed Pandora groups)
Create id-groups, each owned by a closed Pandora group:

| Group | Role |
|---|---|
| `postflowx-admins` | `admin` |
| `postflowx-editors` | `editor` |
| *(admitted, in neither)* | `viewer` |

Highest-privilege group wins. Add more tiers by extending `ROLE_GROUPS` in
`src/scripts/auth/gandalfAuthz.js`.

### 3. Permissions — canonical, in code (not per-user in a sheet)
`allowed_tabs` / `allowed_actions` are no longer stored per user. The **role**
determines the permission set, defined once in `PFX_ROLES`
(`src/scripts/auth/gandalfAuthz.js`), mirroring `permissions.js`:

- `admin` → `tabs: ['*'], actions: ['*']`
- `editor` → all gated tabs + all mutating actions
- `viewer` → all gated tabs, no mutating actions (read-only)

(`render_queue` and `settings` remain ungated in `permissions.js`.)

---

## Resolver (implemented + unit-tested)

`src/scripts/auth/gandalfAuthz.js` is the pure mapping layer, tested in
`tests-js/gandalfAuthz.test.mjs`:

- `resolveSession({ email, gandalf })` — queries an **injected** Gandalf client
  (`isAuthorized` + `isMember`) and returns the **exact nested session shape** the
  Apps Script produced (`pfxAuthNestedSession_`): `{ ok, status, role,
  permissions:{tabs,actions}, featureFlags, expiresAt, sessionToken, user }`.
  Because the shape is identical, **nothing downstream changes** — `permissions.js`,
  `boot-guard`, and `auth.js` consume it unchanged.
- `sessionFromDecision(...)` — the pure decision→session mapper (no I/O).

The `gandalf` client is an interface so it swaps between a mock (tests), the
`gandalf-authz-client` Node library, or the Gandalf Agent HTTP API without
touching the mapping logic.

---

## Where it runs (deployment)

A desktop client cannot hold the identity used to call Gandalf, and the Meechum
token exchange already needs a server-side secret. So the resolver runs in a
**backend**, exactly where the Apps Script runs today:

1. **Preferred:** stand up a small Netflix service (SBN/DGS or Node) that (a) does
   the Meechum code→token exchange (moving `PFX_MEECHUM_CLIENT_SECRET` out of Apps
   Script), (b) calls `resolveSession({ email, gandalf })`, (c) returns the session.
   Front it with Wall-E; authenticate the service with Metatron.
2. **Interim:** keep the current Apps Script *only* for the Meechum exchange, but
   have it call the new resolver service for the authZ decision (delete the
   `AccessControl` sheet logic).

The desktop app is unchanged except pointing `postflowxAuthApiUrl`
(`authConfig.json`) at the new service — same request/response contract as
`?path=auth/meechum`.

---

## Cutover plan

1. **Create** the `postflowx` policy + `postflowx-admins` / `postflowx-editors`
   id-groups (Pandora-backed) at https://portal.gandalf.netflix.net. Validate with
   the Gandalf MCP before enabling.
2. **Deploy** the resolver behind the backend (option 1 or 2 above), wiring a real
   Gandalf client into `resolveSession`.
3. **Feature-flag** the switch: add `authProvider: 'gandalf' | 'appsScript'` to the
   runtime config; default `appsScript` until the policy is verified live, then
   flip to `gandalf`.
4. **Migrate** existing `AccessControl` rows → group membership: admins/editors → the
   respective Pandora groups; everyone else is viewer-by-default once admitted.
5. **Decommission** the `AccessControl` + `LoginTokens` sheets and the
   sheet-resolution code once traffic is fully on Gandalf.

## Not done here (needs Netflix-side / deploy access)
- Creating the policy + id-groups in the Gandalf portal (manual).
- Standing up / deploying the backend service and wiring the real Gandalf client.
- End-to-end verification against live Gandalf (blocked without the above).

The **mapping core is implemented and tested**; the remaining work is portal
config + deployment.
