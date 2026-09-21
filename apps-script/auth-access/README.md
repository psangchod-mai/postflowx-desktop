# PostFlowX Auth / Access Control (Apps Script)

This add-on lets the PostFlowX **desktop app** turn a Google sign-in into a policy
session driven by the `AccessControl` tab of the shared config Sheet.

The desktop flow (`electron/ipc.js` → `'pfx:google-oauth'`) does loopback + PKCE
OAuth in the main process, then POSTs the Google **access token** to
`?path=auth/google`. This handler calls Google's **tokeninfo** endpoint to verify
the token's audience (against `PFX_OAUTH_CLIENT_ID`) and that the email is verified,
resolves the email from that token, looks the user up in `AccessControl`, and
returns their tabs / actions / feature flags.

## Netflix workforce and partner sign-in (Edward / Meechum)

The desktop app opens Meechum in the user's normal browser. Because Edward only
allows Netflix-owned HTTPS callbacks for this client, the app asks the user to
copy the final callback URL and then explicitly click **Paste callback URL**.
PostFlowX verifies the exact callback origin/path and OAuth state before sending
the one-time code and PKCE verifier to `?path=auth/meechum`.

Set these Script properties on this auth web app before deploying a new version:

- `PFX_MEECHUM_CLIENT_ID` — the Edward client ID.
- `PFX_MEECHUM_CLIENT_SECRET` — the Edward secret. Never place this in the app.
- `PFX_MEECHUM_REDIRECT_URI` — the exact registered callback URL.
- `PFX_MEECHUM_ISSUER` — optional; defaults to production Meechum.

The server exchanges the authorization code, reads Meechum userinfo, applies the
same `AccessControl` policy used by other sign-in methods, and returns only the
PostFlowX policy session. Meechum access and refresh tokens stay server-side.

## Email magic-link sign-in (PRIMARY — no Google Cloud required)

Because the team's Google Cloud console is admin-locked (no OAuth client can be
obtained), the **primary** desktop sign-in is a poll-based email magic link that
needs **no Google Cloud, no OAuth client, and no custom-protocol/deep-link** — it
runs entirely through this Apps Script + Sheet using `MailApp` and polling:

1. App POSTs `?path=requestLink { email }`. The backend generates a secret token,
   stores only its SHA-256 **hash** (plus a separate public `pollId`, expiry, and
   `confirmed`/`used` flags) in the new **`LoginTokens`** tab. It also mints a
   **6-digit verification code**, storing its hash in `code_hash` and the plaintext
   in `code_plain` (see *Verification code* below). It emails the user a link
   `<execUrl>?path=confirmLink&token=<SECRET>` and returns `{ ok:true, pollId }`.
   The secret token exists **only** in the email; the app only ever holds the `pollId`.
   The code is **never** emailed and **never** returned by any JSON API.
2. App shows a "check your email — waiting…" state and POLLs `?path=checkLink { pollId }`
   (no code yet) every few seconds (5-minute timeout + Resend).
3. User clicks the emailed link → `confirmLink` (GET) verifies the token hash, marks
   the row `confirmed`, and returns a friendly **HTML** page that **displays the
   6-digit code**. (This is the only route that returns HTML instead of JSON, and
   the only place the plaintext code leaves the server.)
4. The next poll sees `confirmed` and returns `{ ok:true, needsCode:true }`; the app
   reveals a code field. The user types the code from the confirmation page and the
   app POSTs `?path=checkLink { pollId, code }`.
5. On the **correct** code the backend marks the token `used` (single-use, under
   `LockService`), looks the row's email up in `AccessControl`, and returns the
   **same session shape** as `auth/google`. A wrong code returns
   `{ ok:true, needsCode:true, badCode:true }`; after **5** wrong tries the row is
   burned (→ `expired`).

### Verification code (binds the clicker to the app — defeats login-CSRF)

Without a code, the session is minted to **whoever holds the `pollId`** — i.e. the
requester. An attacker could request a link for a victim's email, the victim clicks
it, and the **attacker's** poll would receive the victim's session (login-CSRF). The
6-digit code closes this: it is shown **only** to the clicker (on the confirmLink
HTML page, after they prove email control by clicking) and must be typed into the
polling app, which submits it to `checkLink`. Only the code's SHA-256 hash is used
for the (constant-time) comparison.

**Code-storage decision (judgment call).** The plaintext code is stored in the
`code_plain` column so `confirmLink` can render it to the clicker. This is acceptable
because (a) the row lives in the **same private config Sheet** as all other access
data — no new trust boundary; (b) the code is single-use, numeric, and expires with
the link (~15 min); and (c) it is **never in the email and never returned by any JSON
API**. A Script-Property-keyed reversible store was judged overkill for a value with
this blast radius. Opportunistic cleanup (below) removes the row once used/expired.

The renderer wrappers are `pfxPolicyApi.requestLink` / `pfxPolicyApi.checkLink`
(`src/scripts/auth/policyApi.js`), driven by `PFX_AUTH.signInWithEmailLink` /
`PFX_AUTH.pollEmailLink` (`src/scripts/modules/auth.js`) and the primary UI in
`src/scripts/auth/login-ui.js`.

### `MailApp` send quota & sender identity

- The magic-link email is sent with **`MailApp.sendEmail`**, so the **sender is the
  account that deploys / owns the Apps Script project** (Execute as: Me).
- Daily quota: **~100 recipients/day** for consumer `@gmail.com` accounts,
  **~1500/day** for Google Workspace accounts. Each `requestLink` sends one email,
  and requests are rate-limited to one link per email per 60s — but heavy sign-in
  volume can still exhaust the quota. Deploy from a Workspace account if possible.
- A **global daily send cap** (`PFX_LINK_DAILY_CAP`, default **200**) is enforced
  before the per-email check: once hit, `requestLink` returns
  `{ ok:false, error:'rate_limited' }` and sends nothing until the date rolls over.
  Both rate limits are **fail-closed** — if the script lock can't be acquired,
  `requestLink` sends nothing rather than skipping the check.
- **First send triggers an authorization prompt**: the first time any `MailApp` call
  runs, Apps Script prompts the deploying owner to grant the "Send email as you"
  scope. Approve it once (run the deployment or a test send while signed in as the
  owner) or `requestLink` will fail until the scope is granted.

## Files

- [PfxAuthAccess.gs](/Users/psangchod/Documents/PostFlowX_2.5/PostFlowX_Desktop/apps-script/auth-access/PfxAuthAccess.gs)

## How to wire it (STANDALONE — recommended)

`PfxAuthAccess.gs` is **self-contained**: it ships its own `doGet(e)` / `doPost(e)`
entrypoints and forwards every path it does **not** own to your existing backend.
So you deploy it **alone in a new project** — no merging into, and no renaming of,
the existing project's `doGet` / `doPost`.

1. Create a **new blank** Apps Script project.
2. Paste in `PfxAuthAccess.gs` (this one file — nothing else is required).
3. **Set Script properties** (Project Settings → Script properties):
   - `PFX_CONFIG_SHEET_ID` — **required**; the shared config Sheet id.
   - `PFX_LEGACY_BACKEND_URL` — **optional**; the `/exec` URL of your **existing**
     PostFlowX backend. Every non-auth path (the AccessRequests intake, `annotate*`,
     `registerOrPingUser`, `versionManifest`, …) is transparently forwarded there,
     so those routes keep working with **no** changes to that project. If unset it
     defaults to the current backend URL baked into the file; set it to an **empty
     string** to disable forwarding (a friendly liveness message is returned then).
   - `PFX_OAUTH_CLIENT_ID` — only needed if the `?path=auth/google` Google sign-in
     path is used. `auth/google` **fails closed** (`server_not_configured`, HTTP 500)
     if it is unset, so the magic-link flow works without it.
   - `PFX_LINK_DAILY_CAP` — optional; see below.
4. **Deploy → Web App**: *Execute as:* **Me**, *Who has access:* **Anyone**.
5. **Approve the `MailApp` scope** on the first `requestLink` send (run a manual test
   send or the deployment while signed in as the owner), or `requestLink` will fail
   until the "Send email as you" scope is granted.
6. Copy the new `/exec` URL into the desktop app config (`postflowxAuthApiUrl` in
   `electron/authConfig.local.json` / `__PFX_BACKEND_URL`).

The **`LoginTokens`** and `AccessControl` tabs are auto-created on first use if
missing (see *Spreadsheet setup*), but you may add them ahead of time.

### How the legacy proxy works

`doGet` / `doPost` offer each request to the auth router first
(`pfxHandleAuthGet_` / `pfxHandleAuthRequest_`). Those return an output only for the
paths this file owns (`health`, `licenseCheck`, `confirmLink`, `auth/google`,
`requestLink`, `checkLink`) and `null` for anything else. On `null`,
`pfxAuthProxyToLegacy_(e, method)` rebuilds the query string from `e.parameter`,
forwards the same method (POSTing `e.postData.contents` with its content type) to
`PFX_LEGACY_BACKEND_URL`, and returns the upstream body verbatim. Any failure returns
`{ ok:false, error:'legacy_proxy_failed' }`; an explicitly empty
`PFX_LEGACY_BACKEND_URL` returns the legacy liveness message
`{ ok:true, message:'PostFlowX request endpoint is running.' }`.

### LoginTokens cleanup trigger (recommended)

`requestLink` opportunistically prunes rows, but for cleanup while sign-ins are idle
add a **Time-driven** trigger for `pfxAuthCleanupTrigger_` (see below).

## How to wire it (ALTERNATIVE — merge into an existing project)

If you would rather keep a single project, the router helpers still return `null`
for unowned paths, so you can call them from your existing combined entrypoints and
skip the proxy. Apps Script does **not** allow two functions with the same name, so
first rename your current entrypoints (`function doGet(e){…}` → `existingDoGet_(e)`,
`function doPost(e){…}` → `existingDoPost_(e)`) and delete the `doGet` / `doPost`
that `PfxAuthAccess.gs` defines (or don't paste them). Then:

```javascript
function doGet(e) {
  var path = String((e && e.parameter && e.parameter.path) || '');
  var out = pfxHandleAuthGet_(path, e && e.parameter ? e.parameter : {}); // health, licenseCheck, confirmLink
  if (out) return out;
  return existingDoGet_(e);                    // your renamed default / message
}

function doPost(e) {
  var path = String((e && e.parameter && e.parameter.path) || '');
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) {}
  var out = pfxHandleAuthRequest_(path, {
    token: body.token || '',
    params: e && e.parameter ? e.parameter : {},
    body: body,
  });
  if (out) return out;                         // auth/google, requestLink, checkLink
  return existingDoPost_(e);                    // your renamed AccessRequests intake
}
```

There must be exactly **one** `doGet` and **one** `doPost` in the whole project.
`confirmLink` returns an `HtmlService` output, which `doGet` can return directly.

> If `AnnotateSecurity.gs` also lives in this project, chain its router the same
> way. The helpers here are prefixed `pfxAuth*` specifically so they don't collide
> with AnnotateSecurity's `pfxJsonOut_` / `pfxReadSheetRows_` / etc.; you may
> de-duplicate later by reusing one shared set.

## Deployment settings (required)

Deploy → **Web App**:

- **Execute as:** Me (project owner) — needed to read/write the private Sheet.
- **Who has access:** Anyone — the desktop app posts unauthenticated; the *user*
  is authenticated by the Google access token in the POST body, not by the request.

## Script properties

Apps Script → **Project Settings → Script properties**:

- `PFX_CONFIG_SHEET_ID` = `1I92YHGwhteUxdO4ilUHM488c8HVnNMzyGEKMmyWvU-w`
- `PFX_OAUTH_CLIENT_ID` = the Google **Desktop OAuth client ID** the desktop app
  signs in with (the same `client_id` in `electron/authConfig.local.json`).
  **Required.** `auth/google` verifies that the incoming access token's audience
  matches this value and **fails closed** (`{ ok:false, error:'server_not_configured' }`,
  HTTP 500) if it is unset — without it, an access token minted for any other
  Google OAuth client could be replayed to impersonate a user.
- `PFX_LINK_DAILY_CAP` = optional integer, the **global** cap on magic-link emails
  sent per day (default **200** if unset). When the cap is reached `requestLink`
  returns `{ ok:false, error:'rate_limited' }` and sends nothing. The running count
  and date are tracked automatically in the `PFX_LINK_DAILY_COUNT` /
  `PFX_LINK_DAILY_DATE` Script Properties (managed by the script — do not set these
  by hand); the count resets when the date rolls over in the script's timezone.
- `PFX_LEGACY_BACKEND_URL` = optional; the `/exec` URL of the **existing** PostFlowX
  backend. In the **standalone** deployment every path this file does **not** own is
  forwarded here (so `annotate*`, the AccessRequests intake, `registerOrPingUser`,
  `versionManifest`, etc. keep working). If unset it defaults to the current backend
  URL baked into `PfxAuthAccess.gs`; set it to an **empty string** to disable
  forwarding, in which case the proxy returns the legacy liveness message
  `{ ok:true, message:'PostFlowX request endpoint is running.' }`. Ignored in the
  merge-into-existing deployment (there is nothing to forward to).

### LoginTokens cleanup trigger (recommended)

`requestLink` opportunistically prunes `used`/expired `LoginTokens` rows on each
call (`pfxAuthCleanupLoginTokens_`). For a **robust** cleanup that runs even when
sign-ins are idle, add a time-driven trigger:

- Apps Script → **Triggers** → **Add Trigger** → function `pfxAuthCleanupTrigger_`,
  event source **Time-driven**, e.g. a daily timer. It simply calls the same cleanup.

## Spreadsheet setup

Config Sheet: [Access / Config Sheet](https://docs.google.com/spreadsheets/d/1I92YHGwhteUxdO4ilUHM488c8HVnNMzyGEKMmyWvU-w/edit)

Tab `AccessControl`, headers in row 1:

```text
email | role | status | allowed_tabs | allowed_actions | feature_flags | expires_at | first_seen_at | last_seen_at | request_status
```

- `status` — `active` (allow), `pending` (not yet approved), `disabled` (blocked).
- `allowed_tabs` — comma list of canonical tab keys, or `*` for all. Canonical
  keys (from `src/scripts/auth/permissions.js`): `pull_prep, cut_diff, visual_qc,
  t_conform, aces_look, plate_link, bwav, preflight, imf` (`render_queue` and
  `settings` are always available and need not be listed).
- `allowed_actions` — comma list of action keys, or `*` for all
  (e.g. `save_project, add_marker, export_csv, relink_all, export_amf`).
- `feature_flags` — **comma-separated flag names**, e.g. `betaImf,newQc`
  (parsed to `{ betaImf: true, newQc: true }`). Blank → `{}`.
- `expires_at` — optional ISO date/timestamp; returned as `expiresAt`.

Example row:

```text
jane@studio.com | editor | active | pull_prep,cut_diff,imf | save_project,export_csv | betaImf | 2026-12-31 |  |  | approved
```

### Tab `LoginTokens` (magic-link)

Add a second tab named **`LoginTokens`**. The script auto-creates it (with this
header row) on the first `requestLink` if it is missing, but you can create it
yourself. Headers in row 1:

```text
token_hash | email | poll_id | created_at | expires_at | confirmed | used | code_hash | code_plain | code_attempts
```

- `token_hash` — hex **SHA-256** of the secret token. The raw token is never stored
  (it lives only in the emailed link), so a Sheet reader cannot replay it.
- `email` — the (sanitized, lowercased) requester email.
- `poll_id` — public random id the app polls with. Separate from the token so a
  leaked `poll_id` can only poll, never confirm.
- `created_at` / `expires_at` — ISO timestamps; links expire ~15 min after creation.
- `confirmed` — `TRUE` once the user clicks the emailed link (`confirmLink`).
- `used` — `TRUE` once `checkLink` has issued a session for it, OR the row was burned
  (send failure / too many wrong code attempts). Single-use.
- `code_hash` — hex **SHA-256** of the 6-digit verification code, used for the
  constant-time comparison at `checkLink`.
- `code_plain` — the plaintext 6-digit code, stored **only** so `confirmLink` can
  display it to the clicker (see *Verification code* above for why this is acceptable).
  It is never emailed and never returned by any JSON API.
- `code_attempts` — count of wrong-code submissions; at **5** the row is burned.

> Rows are append-only; `requestLink` opportunistically deletes `used`/expired rows,
> and the `pfxAuthCleanupTrigger_` time-driven trigger (above) is the robust option
> to keep the tab small.

## Routes

| Route                           | Method | Auth                         | Purpose                                              |
|---------------------------------|--------|------------------------------|-----------------------------------------------------|
| `?path=health`                  | GET    | none                         | Liveness probe → `{ ok:true, service:'pfx-auth' }`  |
| `?path=auth/google`             | POST   | Google access token (verified)| Sign-in: exchange token for a policy session        |
| `?path=requestLink`             | POST   | none (emails a secret link)  | Magic-link: send a one-time link, return a `pollId` |
| `?path=confirmLink&token=…`     | GET    | secret token (from email)    | Magic-link: user clicks link → mark confirmed (HTML)|
| `?path=checkLink`               | POST   | public `pollId` + 6-digit code | Magic-link: poll; once confirmed + code verified, issue the session |
| `?path=licenseCheck&email=…`    | GET    | **none** (email-keyed poll)  | Background re-validation (real-time revocation)      |

## Behavior summary — magic-link routes

**`requestLink` (POST)** — body `{ email }`. Never reveals whether the email is in
`AccessControl` (no enumeration); any syntactically valid email gets a link.

| Condition                       | Response                                              |
|--------------------------------|------------------------------------------------------|
| invalid email format            | `{ ok:false, error:'invalid_email' }` (HTTP 400)     |
| a live link issued < 60s ago    | `{ ok:false, error:'rate_limited' }` (HTTP 429)      |
| global daily cap hit            | `{ ok:false, error:'rate_limited' }` (HTTP 429)      |
| rate-limit lock not acquired    | `{ ok:false, error:'rate_limited' }` (HTTP 429, fail-closed) |
| email send failed               | `{ ok:false, error:'send_failed' }` (HTTP 502; row burned) |
| ok                              | `{ ok:true, pollId }` (email sent after the lock)    |

**`confirmLink` (GET)** — query `token`. Returns **HTML**, not JSON.

| Condition                            | Response                                         |
|--------------------------------------|--------------------------------------------------|
| valid + unexpired + unused           | HTML "✓ Link confirmed — **Your sign-in code: NNNNNN**" |
| already confirmed (double-click)     | HTML success page (code re-shown)                |
| invalid / expired / used / no token  | HTML error page                                  |

**`checkLink` (POST)** — body `{ pollId, code }`. `waiting:true` ("link not clicked
yet") and `needsCode:true` ("clicked — now enter the code") are both **distinct**
from the authz `status:'pending'`. Poll with **no** code to detect the confirmed
transition; submit the code on the Verify step.

| Condition                            | Response                                          |
|--------------------------------------|---------------------------------------------------|
| missing pollId                       | `{ ok:false, error:'missing_poll_id' }` (HTTP 400)|
| no row / expired / already used      | `{ ok:false, status:'expired' }`                  |
| not confirmed yet                    | `{ ok:true, waiting:true }` (keep polling)        |
| confirmed, no code submitted         | `{ ok:true, needsCode:true }` (show code input)   |
| confirmed, wrong code (< 5 tries)    | `{ ok:true, needsCode:true, badCode:true }`       |
| confirmed, wrong code (5th try)      | row burned → `{ ok:false, status:'expired' }`     |
| confirmed, correct code, no lock     | `{ ok:true, needsCode:true }` (retryable; never mints without the lock) |
| confirmed + correct → active         | `{ ok:true, role, permissions:{tabs,actions}, featureFlags, expiresAt, sessionToken:'' }` |
| confirmed + correct → email unknown  | auto-add pending row → `{ ok:false, status:'pending' }` |
| confirmed + correct → pending / blank| `{ ok:false, status:'pending' }`                  |
| confirmed + correct → disabled       | `{ ok:false, status:'disabled', error:'account_disabled' }` |

## Behavior summary — `auth/google` (POST, sign-in)

| AccessControl state            | Response                                             |
|--------------------------------|------------------------------------------------------|
| `PFX_OAUTH_CLIENT_ID` unset    | `{ ok:false, error:'server_not_configured' }` (HTTP 500) |
| token audience ≠ our client    | `{ ok:false, error:'aud_mismatch' }` (HTTP 401)      |
| token email not verified       | `{ ok:false, error:'email_unverified' }` (HTTP 401)  |
| email absent                   | auto-add pending row → `{ ok:false, status:'pending' }` |
| status = pending / blank       | `{ ok:false, status:'pending' }`                     |
| status = disabled              | `{ ok:false, status:'disabled', error:'account_disabled' }` |
| status = active                | `{ ok:true, role, permissions:{tabs,actions}, featureFlags, expiresAt, sessionToken:'' }` |

## Behavior summary — `licenseCheck` (GET, background re-validation)

This is the endpoint the **desktop** app polls in the background
(`src/scripts/auth/boot-guard.js` `_revalidateDesktopInBackground` →
`pfxBootPolicyFlow.run` → `pfxPolicyApi.licenseCheck`) to enforce **real-time
revocation** after a cache-first boot. It is **read-only** and **email-keyed**:
it takes an `email` query param and does **not** verify a Google token (that stays
on the `auth/google` sign-in path — this poll is a periodic re-check, not a
sign-in). Because it is read-only it does **not** auto-append a pending row for an
unknown email — that remains `auth/google`'s job.

It returns the **flat** policy shape (`allowedTabs` / `allowedActions` at the top
level) consumed by `boot-guard.js` `_normalizePolicySession`, **not** the nested
`permissions:{tabs,actions}` shape that `auth/google` returns. The desktop guard
only revokes the local session on an explicit `status:'disabled'|'pending'` and
treats `ok:true` as a silent refresh; transient failures fail open.

| AccessControl state            | Response                                             |
|--------------------------------|------------------------------------------------------|
| `email` param absent           | `{ ok:false, error:'missing_email' }` (HTTP 400)     |
| email unknown (no row)         | `{ ok:false, status:'pending' }` (no row appended)   |
| status = pending / blank       | `{ ok:false, status:'pending' }`                     |
| status = disabled              | `{ ok:false, status:'disabled' }`                    |
| status = active                | `{ ok:true, role, allowedTabs:[…], allowedActions:[…], featureFlags:{…}, expiresAt, status:'active' }` |

## Important limitation

This gates access and entitlements server-side, but it does not make the client
uncopyable. Keep sensitive entitlement decisions here in Apps Script; the desktop
app enforces them at the UI layer via `src/scripts/auth/permissions.js`.
