# Partner sign-in (`NetflixPartnerLogin`)

How PostFlowX lets external **partner / vendor** accounts (Pandora-managed,
non-workforce — e.g. `@netflixpartner.com`) sign in alongside Netflix workforce.

Partners use the **same Meechum SSO** the app already uses; their identities just
live in **Pandora**. The single knob that admits them is the **`auth_strategy`** on
the app's Meechum client. This is a **Netflix identity-platform configuration**, not
something the app code can grant by itself — the code below only *requests* the
partner experience and must be matched by server-side config.

Source: Netflix engineering context (NECP) — Meechum / Pandora / Edward / Wall-E.

---

## 1. App-side config (already wired — this repo)

| Knob | Env var | Config key | Default |
|---|---|---|---|
| Meechum client id | `POSTFLOWX_MEECHUM_CLIENT_ID` | `meechumClientId` | `postflowx-desktop-test` |
| OIDC scopes | `POSTFLOWX_MEECHUM_SCOPES` | `meechumScopes` | `openid profile default` |
| **Auth strategy** | `POSTFLOWX_MEECHUM_AUTH_STRATEGY` | `meechumAuthStrategy` | *(empty = workforce-only)* |
| Redirect URI | `POSTFLOWX_MEECHUM_REDIRECT_URI` | `meechumRedirectUri` | `https://postflowx.netflix.net/oauth2/callback` — registered default used by the desktop copy/paste callback flow. |
| Loopback callbacks | `POSTFLOWX_MEECHUM_LOOPBACK_REDIRECTS` | `meechumLoopbackRedirects` | `true` — port 51900 is registered on the existing PostFlowX Edward client; ports 8477–8479 remain supported fallbacks when registered. |
| Token-exchange backend | `POSTFLOWX_AUTH_API_URL` | `postflowxAuthApiUrl` | *(unset)* |

Set the auth strategy to enable partners:
- **Prod:** `NetflixPartnerLogin`
- **Test:** `NetflixPartnerTestLogin`

When set, `electron/ipc.js` appends `auth_strategy=<value>` to the Meechum
authorization request; when empty, the request is unchanged (workforce-only).
`pfx:enterprise-auth-debug` reports `partnerLoginEnabled` for diagnostics.

One-line switch for a partner-enabled **build**:
```sh
POSTFLOWX_MEECHUM_CLIENT_ID="postflowx-desktop" \
POSTFLOWX_MEECHUM_AUTH_STRATEGY="NetflixPartnerLogin" \
POSTFLOWX_AUTH_API_URL="https://<partner-token-exchange>/exec" \
GOOGLE_DESKTOP_CLIENT_ID="…" npm run build:mac
```
For local dev, the same keys live in `electron/authConfig.local.json`.

---

## 2. Netflix-side config (identity admin — cannot be done from this repo)

These are required for partner accounts to actually authenticate:

1. **Edward** (`go/edward`) — on the PostFlowX Meechum client, set
   `auth_strategy` to `NetflixPartnerLogin` (prod) / `NetflixPartnerTestLogin`
   (test). The app uses the registered HTTPS callback by default. To enable
   automatic return to the desktop, register all three exact redirect URIs
   (`http://127.0.0.1:51900/oauth2/callback`; ports 8477–8479 are optional fallbacks), then
   set `meechumLoopbackRedirects` to `true`. `auth_strategy` must still match the
   app-side `meechumAuthStrategy`.
2. **Pandora** — ensure the partner users/groups are provisioned as partner
   identities.
3. **Gandalf** — add an authorization policy admitting the relevant partner
   groups. AuthN (Meechum) ≠ AuthZ; the app must still gate access. (The Gandalf
   MCP can model/validate this policy read-only before it's applied.)
4. **Token exchange** — a native desktop app cannot hold a client secret, so a
   backend (`postflowxAuthApiUrl`) or a Wall-E gateway performs the PKCE code →
   token exchange. Point `postflowxAuthApiUrl` at the partner-capable backend.
5. **Security review** — partners are external; complete `go/internetfacing`
   before shipping partner access.

---

## 2a. Gandalf authorization policy (validated against prod Gandalf)

AuthN (Meechum admits the partner) ≠ AuthZ (who PostFlowX lets in). The backend
that does the token exchange (`postflowxAuthApiUrl` / Wall-E) must call Gandalf
`isAuthorized` against a PostFlowX policy. There is **no `postflowx` policy yet**
(confirmed via Gandalf lookup) — create one at `go/gandalf`.

Verified building blocks (both read-only shared rules, reference directly):

| Rule | Type | Effect |
|---|---|---|
| `all-netflix-employees` | warden | allow workforce |
| `all-netflix-partners` | valarin: `match("@netflixpartner\.com$", $.subject.user.email)` | allow any `@netflixpartner.com` user |

A subject is authorized if **any** allow rule matches.

### Option A — broad (matches "login by @netflixpartner.com" literally)
Policy `postflowx` with two allow rules:
1. `all-netflix-employees`
2. `all-netflix-partners`

Simplest; admits all workforce + every `@netflixpartner.com` account. Zero new
rules to author (both already exist and are read-only/shared).

### Option B — least privilege (recommended)
Scope partners to the approved vendor orgs instead of all `@netflixpartner.com`:
1. Create id-group **`postflowx-partners`** (free name) — populate
   `group_definition` with the vendor Warden/Pandora `userGroup` IDs (and/or
   individual `users`):
   ```json
   { "userGroup": ["<vendor-org-usergroup-id>", "..."], "users": ["<partner-user-id>"] }
   ```
2. Policy `postflowx` with allow rules: `all-netflix-employees` + a rule bound to
   the `postflowx-partners` id-group.

Same shape as the verified `all-netflix-employees` id-group
(`{"userGroup":[...]}`). Prefer B unless Post Production explicitly wants the
entire partner domain.

> Gandalf is read-only via MCP — these are drafted, not applied. Your admin
> creates the policy at `go/gandalf`; the MCP was used to confirm the rule names,
> that no `postflowx` policy/id-group collides, and the exact `@netflixpartner.com`
> Valarin.

## 3. Test

- **Replicant** provisions test partner identities (can skip MFA in automation).
- Use `NetflixPartnerTestLogin` + the test client (`postflowx-desktop-test`)
  against the test backend until the prod review clears.
