/**
 * PostFlowX Auth / Access Control — Apps Script Web App (SELF-CONTAINED)
 * ---------------------------------------------------------------------------
 * This file is fully self-contained. You can deploy it ALONE in a brand-new,
 * blank Apps Script project — there is NO need to merge it into, or rename the
 * doGet/doPost of, your existing PostFlowX backend project.
 *
 * How it stays out of your way: this file defines its own doGet(e)/doPost(e)
 * entrypoints. They first offer each request to the auth router
 * (pfxHandleAuthGet_ / pfxHandleAuthRequest_). Any path the router does NOT own
 * (health, auth/google, requestLink, confirmLink, checkLink, licenseCheck) is
 * transparently forwarded to your legacy PostFlowX backend via
 * pfxAuthProxyToLegacy_ — so existing routes (annotate, access-request intake,
 * etc.) keep working unchanged.
 *
 * DEPLOY (recommended standalone flow):
 *   1. Create a NEW blank Apps Script project.
 *   2. Paste THIS one file in.
 *   3. Project Settings → Script properties:
 *        PFX_CONFIG_SHEET_ID   (REQUIRED) — the shared config Sheet id.
 *        PFX_LEGACY_BACKEND_URL (optional) — the /exec URL of your existing
 *                                PostFlowX backend to forward non-auth routes to.
 *                                Defaults to the value below if unset. Set it to
 *                                an empty string to DISABLE forwarding (then a
 *                                friendly liveness message is returned instead).
 *        PFX_OAUTH_CLIENT_ID   (only needed if the ?path=auth/google Google
 *                                sign-in path is used) — the Desktop OAuth client
 *                                id the app signs in with. auth/google FAILS
 *                                CLOSED (server_not_configured) when it is unset.
 *        PFX_MEECHUM_CLIENT_ID / PFX_MEECHUM_CLIENT_SECRET /
 *        PFX_MEECHUM_REDIRECT_URI (required for ?path=auth/meechum) — keep the
 *                                Edward secret here, never in the desktop app.
 *        PFX_LINK_DAILY_CAP    (optional) — global magic-link emails/day cap
 *                                (default 200). PFX_LINK_DAILY_COUNT /
 *                                PFX_LINK_DAILY_DATE are managed automatically.
 *   4. Deploy → Web App → Execute as: Me, Who has access: Anyone.
 *   5. Approve the MailApp "Send email as you" scope on the first requestLink
 *      send (run a test send / the deployment while signed in as the owner).
 *   6. Copy the /exec URL into the desktop app config.
 *
 * ALTERNATIVE (merge into an existing project): the router helpers return null
 * for paths they do not own, so you can instead call pfxHandleAuthGet_ /
 * pfxHandleAuthRequest_ from your existing combined doGet/doPost and skip the
 * proxy entirely. See README.md.
 *
 * All helpers are prefixed pfxAuth* / PFX_AUTH_* so they never collide with the
 * pfx* helpers in AnnotateSecurity.gs if both files live in one project.
 */

var PFX_AUTH_DEFAULT_SHEET_ID = '1I92YHGwhteUxdO4ilUHM488c8HVnNMzyGEKMmyWvU-w';
var PFX_AUTH_ACCESS_SHEET = 'AccessControl';
var PFX_AUTH_LOGIN_SHEET = 'LoginTokens';
var PFX_AUTH_LINK_TTL_MS = 15 * 60 * 1000; // magic links live ~15 minutes
var PFX_AUTH_DEFAULT_DAILY_CAP = 200;
var PFX_AUTH_MAX_CODE_ATTEMPTS = 5;
var PFX_AUTH_LOCK_TIMEOUT_MS = 10000;

// Default legacy backend to forward non-auth routes to (the existing PostFlowX
// AccessRequests / annotate backend). Overridden by Script Property
// PFX_LEGACY_BACKEND_URL.
var PFX_AUTH_DEFAULT_LEGACY_URL =
  'https://script.google.com/macros/s/AKfycbxhdc-5B2q-YYs_og7BU7fpJHz3VAcGKzDVu422XViMvZndXhy1ytGjTgJmNwKLSXgS/exec';

var PFX_AUTH_ACCESS_HEADERS = [
  'email', 'role', 'status', 'allowed_tabs', 'allowed_actions', 'feature_flags',
  'expires_at', 'first_seen_at', 'last_seen_at', 'request_status',
];

var PFX_AUTH_LOGIN_HEADERS = [
  'token_hash', 'email', 'poll_id', 'created_at', 'expires_at',
  'confirmed', 'used', 'code_hash', 'code_plain', 'code_attempts',
];

// ── Standalone entrypoints ──────────────────────────────────────────────────

function doGet(e) {
  var path = String((e && e.parameter && e.parameter.path) || '');
  var out = pfxHandleAuthGet_(path, (e && e.parameter) ? e.parameter : {});
  if (out) return out;
  return pfxAuthProxyToLegacy_(e, 'get');
}

function doPost(e) {
  var path = String((e && e.parameter && e.parameter.path) || '');
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { body = {}; }
  var out = pfxHandleAuthRequest_(path, {
    token: (body && body.token) || '',
    params: (e && e.parameter) ? e.parameter : {},
    body: body,
  });
  if (out) return out;
  return pfxAuthProxyToLegacy_(e, 'post');
}

// ── Router helpers (documented signatures; return null for unowned paths) ─────

function pfxHandleAuthGet_(path, params) {
  params = params || {};
  switch (String(path || '')) {
    case 'health':       return pfxAuthHealth_();
    case 'licenseCheck': return pfxAuthLicenseCheck_(params);
    case 'confirmLink':  return pfxAuthConfirmLink_(params);
    default:             return null;
  }
}

function pfxHandleAuthRequest_(path, req) {
  req = req || {};
  switch (String(path || '')) {
    case 'auth/google':  return pfxAuthGoogle_(req);
    case 'auth/meechum': return pfxAuthMeechum_(req);
    case 'requestLink':  return pfxAuthRequestLink_(req);
    case 'checkLink':    return pfxAuthCheckLink_(req);
    default:             return null;
  }
}

// ── Route: auth/meechum (POST { code, codeVerifier, redirectUri }) ───────────
//
// Edward's token endpoint authenticates confidential clients. The desktop app
// therefore sends the one-time authorization code + PKCE verifier here, while
// the client secret remains in Apps Script Properties. Only the resulting
// PostFlowX policy session is returned; Meechum tokens never reach the desktop.
function pfxAuthMeechum_(req) {
  var body = req.body || {};
  var code = String(body.code || '').trim();
  var verifier = String(body.codeVerifier || '').trim();
  var requestedRedirect = String(body.redirectUri || '').trim();
  var clientId = String(pfxAuthGetScriptProp_('PFX_MEECHUM_CLIENT_ID', '')).trim();
  var clientSecret = String(pfxAuthGetScriptProp_('PFX_MEECHUM_CLIENT_SECRET', '')).trim();
  var configuredRedirect = String(pfxAuthGetScriptProp_('PFX_MEECHUM_REDIRECT_URI', '')).trim();
  var issuer = String(pfxAuthGetScriptProp_('PFX_MEECHUM_ISSUER', 'https://meechum.prod.netflix.net/')).trim();

  if (!clientId || !clientSecret || !configuredRedirect) {
    return pfxAuthJsonOut_({ ok: false, error: 'meechum_server_not_configured' }, 500);
  }
  // The token exchange MUST reuse the exact redirect_uri the authorization request
  // used (OAuth rule). Accept the app-provided redirect when it is either the
  // configured HTTPS one (copy-paste flow) OR a loopback 127.0.0.1 callback
  // (native-app "Automatic" flow, RFC 8252) — the Edward client still gates which
  // redirects Meechum will actually honor, so this is not a bypass.
  var isLoopback = /^http:\/\/127\.0\.0\.1:\d{1,5}\/oauth2\/callback$/.test(requestedRedirect);
  var redirectUri = (requestedRedirect && (requestedRedirect === configuredRedirect || isLoopback))
    ? requestedRedirect
    : '';
  if (!code || !verifier || !redirectUri) {
    return pfxAuthJsonOut_({ ok: false, error: 'invalid_meechum_request' }, 400);
  }

  var tokenResp;
  try {
    tokenResp = UrlFetchApp.fetch(
      issuer.replace(/\/$/, '') + '/as/token.oauth2',
      {
        method: 'post',
        contentType: 'application/x-www-form-urlencoded',
        headers: {
          Authorization: 'Basic ' + Utilities.base64Encode(clientId + ':' + clientSecret),
          Accept: 'application/json',
        },
        payload: {
          code: code,
          client_id: clientId,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: verifier,
        },
        muteHttpExceptions: true,
        followRedirects: true,
      }
    );
  } catch (err) {
    return pfxAuthJsonOut_({ ok: false, error: 'meechum_token_unreachable' }, 502);
  }

  var tokens = {};
  try { tokens = JSON.parse(tokenResp.getContentText() || '{}'); } catch (err) { tokens = {}; }
  if (tokenResp.getResponseCode() < 200 || tokenResp.getResponseCode() >= 300 || !tokens.access_token) {
    return pfxAuthJsonOut_({
      ok: false,
      error: String(tokens.error_description || tokens.error || 'meechum_token_exchange_failed'),
    }, 401);
  }

  var userResp;
  try {
    userResp = UrlFetchApp.fetch(
      issuer.replace(/\/$/, '') + '/idp/userinfo.openid',
      {
        headers: { Authorization: 'Bearer ' + tokens.access_token, Accept: 'application/json' },
        muteHttpExceptions: true,
        followRedirects: true,
      }
    );
  } catch (err) {
    return pfxAuthJsonOut_({ ok: false, error: 'meechum_userinfo_unreachable' }, 502);
  }

  var user = {};
  try { user = JSON.parse(userResp.getContentText() || '{}'); } catch (err) { user = {}; }
  if (userResp.getResponseCode() < 200 || userResp.getResponseCode() >= 300) {
    return pfxAuthJsonOut_({ ok: false, error: 'meechum_userinfo_failed' }, 401);
  }
  var email = String(user.email || user.mail || user.preferred_username || '').trim().toLowerCase();
  if (!pfxAuthValidEmail_(email)) {
    return pfxAuthJsonOut_({ ok: false, error: 'meechum_email_missing' }, 401);
  }

  var acc = pfxAuthResolveAccess_(email);
  if (!acc.found) {
    pfxAuthAppendPending_(email);
    return pfxAuthJsonOut_({ ok: false, status: 'pending' }, 200);
  }
  if (acc.status === 'disabled') {
    return pfxAuthJsonOut_({ ok: false, status: 'disabled', error: 'account_disabled' }, 200);
  }
  if (acc.status === 'expired') {
    return pfxAuthJsonOut_({ ok: false, status: 'expired', error: 'account_expired' }, 200);
  }
  if (acc.status !== 'active') {
    return pfxAuthJsonOut_({ ok: false, status: 'pending' }, 200);
  }

  var session = pfxAuthNestedSession_(acc);
  session.user = {
    email: email,
    name: String(user.name || user.displayName || user.display_name || email.split('@')[0]),
    picture: String(user.picture || ''),
  };
  return pfxAuthJsonOut_(session, 200);
}

// ── Route: health ────────────────────────────────────────────────────────────

function pfxAuthHealth_() {
  return pfxAuthJsonOut_({ ok: true, service: 'pfx-auth' }, 200);
}

// ── Route: auth/google (POST { token } = Google ACCESS token) ─────────────────

function pfxAuthGoogle_(req) {
  var body = req.body || {};
  var token = String(req.token || body.token || '').trim();

  var clientId = String(pfxAuthGetScriptProp_('PFX_OAUTH_CLIENT_ID', '')).trim();
  if (!clientId) {
    // Fail CLOSED: without a known client id any Google access token could be replayed.
    return pfxAuthJsonOut_({ ok: false, error: 'server_not_configured' }, 500);
  }
  if (!token) {
    return pfxAuthJsonOut_({ ok: false, error: 'aud_mismatch' }, 401);
  }

  var info = null;
  try {
    var resp = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token),
      { muteHttpExceptions: true, followRedirects: true }
    );
    info = JSON.parse(resp.getContentText() || '{}');
  } catch (err) {
    info = null;
  }

  if (!info || (info.aud !== clientId && info.azp !== clientId)) {
    return pfxAuthJsonOut_({ ok: false, error: 'aud_mismatch' }, 401);
  }
  if (String(info.email_verified) !== 'true') {
    return pfxAuthJsonOut_({ ok: false, error: 'email_unverified' }, 401);
  }

  var email = String(info.email || '').trim().toLowerCase();
  return pfxAuthSessionForEmail_(email, true);
}

// ── Route: licenseCheck (GET ?email=… — READ-ONLY, no token, no append) ───────

function pfxAuthLicenseCheck_(params) {
  var email = String((params && params.email) || '').trim().toLowerCase();
  if (!email) return pfxAuthJsonOut_({ ok: false, error: 'missing_email' }, 400);

  var acc = pfxAuthResolveAccess_(email);
  if (!acc.found)               return pfxAuthJsonOut_({ ok: false, status: 'pending' }, 200);
  if (acc.status === 'disabled') return pfxAuthJsonOut_({ ok: false, status: 'disabled' }, 200);
  if (acc.status === 'expired') return pfxAuthJsonOut_({ ok: false, status: 'expired' }, 200);
  if (acc.status !== 'active')  return pfxAuthJsonOut_({ ok: false, status: 'pending' }, 200);

  // FLAT shape consumed by boot-guard.js _normalizePolicySession.
  return pfxAuthJsonOut_(pfxAuthFlatSession_(acc), 200);
}

// ── Route: requestLink (POST { email }) ───────────────────────────────────────

function pfxAuthRequestLink_(req) {
  var body = req.body || {};
  var email = String(body.email || '').trim().toLowerCase();
  if (!pfxAuthValidEmail_(email)) {
    return pfxAuthJsonOut_({ ok: false, error: 'invalid_email' }, 400);
  }

  // Opportunistic prune of used/expired rows.
  pfxAuthCleanupLoginTokens_();

  var lock = LockService.getScriptLock();
  var haveLock = false;
  try { haveLock = lock.tryLock(PFX_AUTH_LOCK_TIMEOUT_MS); } catch (e) { haveLock = false; }
  if (!haveLock) {
    // Fail CLOSED — never skip the rate-limit check by sending without the lock.
    return pfxAuthJsonOut_({ ok: false, error: 'rate_limited' }, 429);
  }

  var token, pollId, code;
  try {
    var props = PropertiesService.getScriptProperties();

    // Global daily cap (with date rollover), checked BEFORE the per-email check.
    var cap = parseInt(pfxAuthGetScriptProp_('PFX_LINK_DAILY_CAP', String(PFX_AUTH_DEFAULT_DAILY_CAP)), 10);
    if (isNaN(cap) || cap <= 0) cap = PFX_AUTH_DEFAULT_DAILY_CAP;
    var tz = Session.getScriptTimeZone() || 'Etc/UTC';
    var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    var storedDate = props.getProperty('PFX_LINK_DAILY_DATE') || '';
    var count = parseInt(props.getProperty('PFX_LINK_DAILY_COUNT') || '0', 10) || 0;
    if (storedDate !== today) {
      count = 0;
      props.setProperty('PFX_LINK_DAILY_DATE', today);
      props.setProperty('PFX_LINK_DAILY_COUNT', '0');
    }
    if (count >= cap) {
      lock.releaseLock();
      return pfxAuthJsonOut_({ ok: false, error: 'rate_limited' }, 429);
    }

    // Per-email 60s live-link check.
    var sheet = pfxAuthGetLoginSheet_();
    if (pfxAuthHasLiveLink_(sheet, email)) {
      lock.releaseLock();
      return pfxAuthJsonOut_({ ok: false, error: 'rate_limited' }, 429);
    }

    token = pfxAuthRandomToken_();
    pollId = Utilities.getUuid();
    code = pfxAuthRandomCode_();
    var now = new Date();
    var expires = new Date(now.getTime() + PFX_AUTH_LINK_TTL_MS);

    // Header order: token_hash|email|poll_id|created_at|expires_at|confirmed|used|code_hash|code_plain|code_attempts
    sheet.appendRow([
      pfxAuthSha256Hex_(token),
      pfxAuthSanitizeCell_(email),
      pollId,
      now.toISOString(),
      expires.toISOString(),
      false,
      false,
      pfxAuthSha256Hex_(code),
      pfxAuthSanitizeCell_(code),
      0,
    ]);

    count += 1;
    props.setProperty('PFX_LINK_DAILY_COUNT', String(count));
    props.setProperty('PFX_LINK_DAILY_DATE', today);

    lock.releaseLock();
    haveLock = false;
  } catch (err) {
    if (haveLock) { try { lock.releaseLock(); } catch (e) {} }
    // Fail closed on any error under the lock.
    return pfxAuthJsonOut_({ ok: false, error: 'rate_limited' }, 429);
  }

  // Send the email OUTSIDE the lock. The secret token exists only in the link.
  try {
    var execUrl = ScriptApp.getService().getUrl();
    var link = execUrl + '?path=confirmLink&token=' + encodeURIComponent(token);
    var subject = 'Your PostFlowX sign-in link';
    var bodyText =
      'Confirm your PostFlowX sign-in by opening this link:\n\n' + link + '\n\n' +
      'This link expires in 15 minutes. After you open it you will see a 6-digit ' +
      'sign-in code — type that code into PostFlowX to finish signing in.\n\n' +
      'If you did not request this, you can safely ignore this email.';
    MailApp.sendEmail(email, subject, bodyText);
  } catch (sendErr) {
    // Burn the row so a link that never arrived can never be confirmed.
    try {
      var s2 = pfxAuthGetLoginSheet_();
      var burn = pfxAuthFindLoginRow_(s2, { pollId: pollId });
      if (burn) pfxAuthSetLoginCell_(burn, 'used', true);
    } catch (e) {}
    return pfxAuthJsonOut_({ ok: false, error: 'send_failed' }, 502);
  }

  return pfxAuthJsonOut_({ ok: true, pollId: pollId }, 200);
}

// ── Route: confirmLink (GET ?token=… — returns HTML) ──────────────────────────

function pfxAuthConfirmLink_(params) {
  var token = String((params && params.token) || '').trim();
  if (!token) return pfxAuthHtmlOut_(pfxAuthConfirmErrorHtml_());

  var sheet = pfxAuthGetLoginSheet_();
  var rowObj = pfxAuthFindLoginRow_(sheet, { tokenHash: pfxAuthSha256Hex_(token) });
  if (!rowObj || rowObj.used || pfxAuthIsExpired_(rowObj.expiresAt)) {
    return pfxAuthHtmlOut_(pfxAuthConfirmErrorHtml_());
  }

  // Sanitize the code to digits only before embedding it into HTML.
  var code = String(rowObj.codePlain || '').replace(/\D/g, '');
  if (!rowObj.confirmed) pfxAuthSetLoginCell_(rowObj, 'confirmed', true);
  // Double-click (already confirmed) simply re-shows the code.
  return pfxAuthHtmlOut_(pfxAuthConfirmSuccessHtml_(code));
}

// ── Route: checkLink (POST { pollId, code }) ──────────────────────────────────

function pfxAuthCheckLink_(req) {
  var body = req.body || {};
  var pollId = String(body.pollId || '').trim();
  var code = String(body.code || '').trim();
  if (!pollId) return pfxAuthJsonOut_({ ok: false, error: 'missing_poll_id' }, 400);

  var sheet = pfxAuthGetLoginSheet_();
  var rowObj = pfxAuthFindLoginRow_(sheet, { pollId: pollId });
  if (!rowObj || rowObj.used || pfxAuthIsExpired_(rowObj.expiresAt)) {
    return pfxAuthJsonOut_({ ok: false, status: 'expired' }, 200);
  }
  if (!rowObj.confirmed) return pfxAuthJsonOut_({ ok: true, waiting: true }, 200);
  if (!code) return pfxAuthJsonOut_({ ok: true, needsCode: true }, 200);

  // Constant-time comparison of the code hashes.
  var provided = pfxAuthSha256Hex_(code);
  if (!pfxAuthConstEq_(provided, rowObj.codeHash)) {
    var attempts = rowObj.codeAttempts + 1;
    if (attempts >= PFX_AUTH_MAX_CODE_ATTEMPTS) {
      pfxAuthSetLoginCell_(rowObj, 'used', true); // burn on the 5th wrong try
      return pfxAuthJsonOut_({ ok: false, status: 'expired' }, 200);
    }
    pfxAuthSetLoginCell_(rowObj, 'code_attempts', attempts);
    return pfxAuthJsonOut_({ ok: true, needsCode: true, badCode: true }, 200);
  }

  // Correct code — mint ONLY while holding the lock; otherwise stay retryable.
  var lock = LockService.getScriptLock();
  var haveLock = false;
  try { haveLock = lock.tryLock(PFX_AUTH_LOCK_TIMEOUT_MS); } catch (e) { haveLock = false; }
  if (!haveLock) return pfxAuthJsonOut_({ ok: true, needsCode: true }, 200);

  var email = '';
  try {
    // Re-read the row under the lock to defend against a concurrent mint.
    var fresh = pfxAuthFindLoginRow_(sheet, { pollId: pollId });
    if (!fresh || fresh.used || pfxAuthIsExpired_(fresh.expiresAt)) {
      lock.releaseLock();
      return pfxAuthJsonOut_({ ok: false, status: 'expired' }, 200);
    }
    pfxAuthSetLoginCell_(fresh, 'used', true); // single-use
    email = String(fresh.email || '').trim().toLowerCase();
    lock.releaseLock();
    haveLock = false;
  } catch (err) {
    if (haveLock) { try { lock.releaseLock(); } catch (e) {} }
    return pfxAuthJsonOut_({ ok: true, needsCode: true }, 200);
  }

  return pfxAuthSessionForEmail_(email, true);
}

// ── AccessControl resolution + session builders ───────────────────────────────

// Returns { found, status, role, tabs, actions, featureFlags, expiresAt }.
function pfxAuthResolveAccess_(email) {
  var target = String(email || '').trim().toLowerCase();
  var res = { found: false, status: 'pending', role: '', tabs: [], actions: [], featureFlags: {}, expiresAt: '' };
  if (!target) return res;

  var sheet = pfxAuthGetAccessSheet_();
  var values = sheet.getDataRange().getValues();
  if (!values || values.length < 2) return res;

  var idx = pfxAuthHeaderIndex_(values[0]);
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var rowEmail = String(row[idx['email']] || '').trim().toLowerCase();
    if (rowEmail && rowEmail === target) {
      var status = String(row[idx['status']] || '').trim().toLowerCase();
      if (!status) status = 'pending';
      res.found = true;
      res.status = status;
      res.role = String(row[idx['role']] || '').trim() || 'viewer';
      res.tabs = pfxAuthSplitList_(row[idx['allowed_tabs']]);
      res.actions = pfxAuthSplitList_(row[idx['allowed_actions']]);
      res.featureFlags = pfxAuthParseFlags_(row[idx['feature_flags']]);
      res.expiresAt = pfxAuthCoerceDate_(row[idx['expires_at']]);
      // A blank expiry means the entitlement has no scheduled end. Once an
      // expiry is configured, however, it is authoritative and must override
      // an otherwise-active status on every auth path.
      if (res.status === 'active' && res.expiresAt && pfxAuthIsExpired_(res.expiresAt)) {
        res.status = 'expired';
      }
      return res;
    }
  }
  return res;
}

// Shared decision for the AUTHENTICATED routes (auth/google, checkLink):
// returns the nested session on active, pending/disabled JSON otherwise, and
// (when autoAppend) auto-appends a pending AccessControl row for an unknown email.
function pfxAuthSessionForEmail_(email, autoAppend) {
  var acc = pfxAuthResolveAccess_(email);
  if (!acc.found) {
    if (autoAppend) pfxAuthAppendPending_(email);
    return pfxAuthJsonOut_({ ok: false, status: 'pending' }, 200);
  }
  if (acc.status === 'disabled') {
    return pfxAuthJsonOut_({ ok: false, status: 'disabled', error: 'account_disabled' }, 200);
  }
  if (acc.status === 'expired') {
    return pfxAuthJsonOut_({ ok: false, status: 'expired', error: 'account_expired' }, 200);
  }
  if (acc.status !== 'active') {
    return pfxAuthJsonOut_({ ok: false, status: 'pending' }, 200);
  }
  return pfxAuthJsonOut_(pfxAuthNestedSession_(acc), 200);
}

// Nested shape consumed by auth.js pollEmailLink / ipc.js Google sign-in.
function pfxAuthNestedSession_(acc) {
  return {
    ok: true,
    role: acc.role || 'viewer',
    permissions: { tabs: acc.tabs || [], actions: acc.actions || [] },
    featureFlags: acc.featureFlags || {},
    expiresAt: acc.expiresAt || '',
    sessionToken: '',
  };
}

// Flat shape consumed by boot-guard.js _normalizePolicySession (licenseCheck).
function pfxAuthFlatSession_(acc) {
  return {
    ok: true,
    role: acc.role || 'viewer',
    allowedTabs: acc.tabs || [],
    allowedActions: acc.actions || [],
    featureFlags: acc.featureFlags || {},
    expiresAt: acc.expiresAt || '',
    status: 'active',
  };
}

// LockService-guarded pending auto-append (sanitized). No-op for a blank email.
function pfxAuthAppendPending_(email) {
  var clean = String(email || '').trim().toLowerCase();
  if (!clean) return; // never write a junk empty-email row
  var lock = LockService.getScriptLock();
  var haveLock = false;
  try { haveLock = lock.tryLock(PFX_AUTH_LOCK_TIMEOUT_MS); } catch (e) { haveLock = false; }
  try {
    // Re-check under the lock so two concurrent sign-ins don't double-append.
    if (pfxAuthResolveAccess_(clean).found) return;
    var sheet = pfxAuthGetAccessSheet_();
    var now = new Date().toISOString();
    // email|role|status|allowed_tabs|allowed_actions|feature_flags|expires_at|first_seen_at|last_seen_at|request_status
    sheet.appendRow([
      pfxAuthSanitizeCell_(clean), '', 'pending', '', '', '', '', now, '', 'pending',
    ]);
  } catch (err) {
    // swallow — an append failure must not surface as a hard error to the client
  } finally {
    if (haveLock) { try { lock.releaseLock(); } catch (e) {} }
  }
}

// ── LoginTokens sheet helpers ─────────────────────────────────────────────────

function pfxAuthGetLoginSheet_() {
  var ss = pfxAuthGetConfigSpreadsheet_();
  var sheet = ss.getSheetByName(PFX_AUTH_LOGIN_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(PFX_AUTH_LOGIN_SHEET);
    sheet.getRange(1, 1, 1, PFX_AUTH_LOGIN_HEADERS.length).setValues([PFX_AUTH_LOGIN_HEADERS]);
  }
  return sheet;
}

function pfxAuthGetAccessSheet_() {
  var ss = pfxAuthGetConfigSpreadsheet_();
  var sheet = ss.getSheetByName(PFX_AUTH_ACCESS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(PFX_AUTH_ACCESS_SHEET);
    sheet.getRange(1, 1, 1, PFX_AUTH_ACCESS_HEADERS.length).setValues([PFX_AUTH_ACCESS_HEADERS]);
  }
  return sheet;
}

// Find a LoginTokens row by tokenHash OR pollId. Returns a live handle
// { rowIndex, sheet, idx, ...fields } for in-place updates, or null.
function pfxAuthFindLoginRow_(sheet, opts) {
  opts = opts || {};
  var values = sheet.getDataRange().getValues();
  if (!values || values.length < 2) return null;
  var idx = pfxAuthHeaderIndex_(values[0]);
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (opts.tokenHash && String(row[idx['token_hash']] || '').trim() === opts.tokenHash) {
      return pfxAuthMapLoginRow_(row, idx, r + 1, sheet);
    }
    if (opts.pollId && String(row[idx['poll_id']] || '').trim() === opts.pollId) {
      return pfxAuthMapLoginRow_(row, idx, r + 1, sheet);
    }
  }
  return null;
}

function pfxAuthMapLoginRow_(row, idx, rowIndex, sheet) {
  return {
    rowIndex: rowIndex,
    sheet: sheet,
    idx: idx,
    tokenHash: String(row[idx['token_hash']] || '').trim(),
    email: String(row[idx['email']] || '').trim(),
    pollId: String(row[idx['poll_id']] || '').trim(),
    createdAt: row[idx['created_at']],
    expiresAt: row[idx['expires_at']],
    confirmed: pfxAuthToBool_(row[idx['confirmed']]),
    used: pfxAuthToBool_(row[idx['used']]),
    codeHash: String(row[idx['code_hash']] || '').trim(),
    codePlain: String(row[idx['code_plain']] || '').trim(),
    codeAttempts: parseInt(row[idx['code_attempts']] || '0', 10) || 0,
  };
}

function pfxAuthSetLoginCell_(rowObj, colName, value) {
  var col = rowObj.idx[colName];
  if (col == null) return;
  rowObj.sheet.getRange(rowObj.rowIndex, col + 1).setValue(value);
}

// True if there is a not-used, unexpired link for this email created < 60s ago.
function pfxAuthHasLiveLink_(sheet, email) {
  var target = String(email || '').trim().toLowerCase();
  var values = sheet.getDataRange().getValues();
  if (!values || values.length < 2) return false;
  var idx = pfxAuthHeaderIndex_(values[0]);
  var now = Date.now();
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (String(row[idx['email']] || '').trim().toLowerCase() !== target) continue;
    if (pfxAuthToBool_(row[idx['used']])) continue;
    var exp = new Date(row[idx['expires_at']]).getTime();
    if (!isNaN(exp) && exp < now) continue; // already expired
    var created = new Date(row[idx['created_at']]).getTime();
    if (!isNaN(created) && (now - created) < 60 * 1000) return true;
  }
  return false;
}

// Opportunistic cleanup of used/expired LoginTokens rows.
function pfxAuthCleanupLoginTokens_() {
  try {
    var sheet = pfxAuthGetLoginSheet_();
    var values = sheet.getDataRange().getValues();
    if (!values || values.length < 2) return;
    var idx = pfxAuthHeaderIndex_(values[0]);
    var now = Date.now();
    // Delete bottom-up so row indices stay valid.
    for (var r = values.length - 1; r >= 1; r--) {
      var row = values[r];
      var used = pfxAuthToBool_(row[idx['used']]);
      var exp = new Date(row[idx['expires_at']]).getTime();
      var expired = isNaN(exp) ? true : (exp < now);
      if (used || expired) sheet.deleteRow(r + 1);
    }
  } catch (e) {}
}

// Time-driven trigger target: Triggers → pfxAuthCleanupTrigger_ (e.g. daily).
function pfxAuthCleanupTrigger_() {
  pfxAuthCleanupLoginTokens_();
}

// ── Legacy proxy (forward non-auth routes to the existing backend) ────────────

function pfxAuthProxyToLegacy_(e, method) {
  try {
    // Read the raw prop: unset → default forward URL; explicit empty → disabled.
    var raw = PropertiesService.getScriptProperties().getProperty('PFX_LEGACY_BACKEND_URL');
    var url = (raw == null) ? PFX_AUTH_DEFAULT_LEGACY_URL : String(raw).trim();
    if (!url) {
      // Forwarding disabled — return the legacy liveness message.
      return pfxAuthJsonOut_({ ok: true, message: 'PostFlowX request endpoint is running.' }, 200);
    }

    var params = (e && e.parameter) ? e.parameter : {};
    var qsParts = [];
    for (var k in params) {
      if (params.hasOwnProperty(k)) {
        qsParts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
      }
    }
    var qs = qsParts.join('&');
    var full = url + (qs ? ((url.indexOf('?') >= 0 ? '&' : '?') + qs) : '');

    var opts = { method: method, muteHttpExceptions: true, followRedirects: true };
    if (String(method).toLowerCase() === 'post') {
      opts.payload = (e && e.postData && e.postData.contents) || '';
      opts.contentType = (e && e.postData && e.postData.type) || 'application/json';
    }

    var resp = UrlFetchApp.fetch(full, opts);
    return ContentService
      .createTextOutput(resp.getContentText())
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return pfxAuthJsonOut_({ ok: false, error: 'legacy_proxy_failed' }, 502);
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function pfxAuthGetScriptProp_(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return (v == null || v === '') ? fallback : v;
}

function pfxAuthGetConfigSpreadsheet_() {
  var id = pfxAuthGetScriptProp_('PFX_CONFIG_SHEET_ID', PFX_AUTH_DEFAULT_SHEET_ID);
  return SpreadsheetApp.openById(String(id || '').trim());
}

function pfxAuthHeaderIndex_(headerRow) {
  var idx = {};
  for (var i = 0; i < headerRow.length; i++) {
    idx[String(headerRow[i] || '').trim()] = i;
  }
  return idx;
}

function pfxAuthValidEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

// SHA-256 hex digest of a UTF-8 string.
function pfxAuthSha256Hex_(str) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(str), Utilities.Charset.UTF_8
  );
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] + 256) % 256;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

// Secret token = two concatenated UUIDs (dashes stripped) — never stored raw.
function pfxAuthRandomToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

// 6-digit verification code (zero-padded).
function pfxAuthRandomCode_() {
  var n = Math.floor(Math.random() * 1000000);
  var s = String(n);
  while (s.length < 6) s = '0' + s;
  return s;
}

// Constant-time string comparison (used on the SHA-256 code hashes).
function pfxAuthConstEq_(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  var res = 0;
  for (var i = 0; i < a.length; i++) {
    res |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  }
  return res === 0;
}

// Formula-injection guard for Sheet cells (leading = + - @ → prefix apostrophe).
function pfxAuthSanitizeCell_(value) {
  var s = String(value == null ? '' : value);
  if (/^[=+\-@]/.test(s)) return "'" + s;
  return s;
}

function pfxAuthToBool_(value) {
  if (value === true) return true;
  var v = String(value == null ? '' : value).trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'y';
}

// '*' → ['*']; comma-separated list → trimmed non-empty array; blank → [].
function pfxAuthSplitList_(value) {
  var s = String(value == null ? '' : value).trim();
  if (s === '*') return ['*'];
  if (!s) return [];
  return s.split(',')
    .map(function (v) { return String(v || '').trim(); })
    .filter(function (v) { return !!v; });
}

// Comma-separated flag names → { name: true }; blank → {}.
function pfxAuthParseFlags_(value) {
  var out = {};
  var s = String(value == null ? '' : value).trim();
  if (!s) return out;
  s.split(',').forEach(function (name) {
    var n = String(name || '').trim();
    if (n) out[n] = true;
  });
  return out;
}

// Coerce a Date/ISO/string into an ISO timestamp string (blank → '').
function pfxAuthCoerceDate_(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date) return value.toISOString();
  var d = new Date(value);
  if (!isNaN(d.getTime())) return d.toISOString();
  return String(value);
}

// Fail-closed: an unparseable expiry is treated as expired.
function pfxAuthIsExpired_(expiresAt) {
  var t = new Date(expiresAt).getTime();
  if (isNaN(t)) return true;
  return t < Date.now();
}

function pfxAuthJsonOut_(obj, status) {
  var output = ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
  if (typeof output.setHeader === 'function') {
    output.setHeader('Cache-Control', 'no-store, max-age=0');
    output.setHeader('X-PFX-Status', String(status || 200));
  }
  return output;
}

function pfxAuthHtmlOut_(html) {
  return HtmlService.createHtmlOutput(html)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function pfxAuthConfirmSuccessHtml_(code) {
  var safe = String(code || '').replace(/\D/g, '');
  return '' +
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<title>PostFlowX sign-in confirmed</title>' +
    '<style>' +
    'body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
    'background:#0f1020;color:#e7e7f2;display:flex;min-height:100vh;align-items:center;justify-content:center}' +
    '.card{background:#1a1a2e;border:1px solid #2a2a44;border-radius:16px;padding:40px 44px;max-width:440px;' +
    'text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.4)}' +
    '.check{font-size:44px;line-height:1}' +
    'h1{font-size:20px;margin:16px 0 6px}' +
    'p{color:#a6a6c8;font-size:14px;line-height:1.5;margin:0 0 22px}' +
    '.code{font-family:"SF Mono",Menlo,Consolas,monospace;font-size:38px;letter-spacing:10px;font-weight:700;' +
    'color:#f5c542;background:#241d08;border:1px solid #4a3c10;border-radius:12px;padding:16px 8px 16px 18px}' +
    '.hint{margin-top:22px;font-size:12px;color:#6f6f92}' +
    '</style></head><body><div class="card">' +
    '<div class="check">&#10003;</div>' +
    '<h1>Link confirmed</h1>' +
    '<p>Enter this 6-digit code in PostFlowX to finish signing in:</p>' +
    '<div class="code">' + safe + '</div>' +
    '<div class="hint">You can close this tab after entering the code. The code is single-use and expires shortly.</div>' +
    '</div></body></html>';
}

function pfxAuthConfirmErrorHtml_() {
  return '' +
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<title>PostFlowX link problem</title>' +
    '<style>' +
    'body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
    'background:#0f1020;color:#e7e7f2;display:flex;min-height:100vh;align-items:center;justify-content:center}' +
    '.card{background:#1a1a2e;border:1px solid #2a2a44;border-radius:16px;padding:40px 44px;max-width:440px;' +
    'text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.4)}' +
    '.x{font-size:44px;line-height:1;color:#ff6b6b}' +
    'h1{font-size:20px;margin:16px 0 6px}' +
    'p{color:#a6a6c8;font-size:14px;line-height:1.5;margin:0}' +
    '</style></head><body><div class="card">' +
    '<div class="x">&#10005;</div>' +
    '<h1>This sign-in link is not valid</h1>' +
    '<p>It may have expired, already been used, or be incorrect. Return to PostFlowX ' +
    'and request a new sign-in link.</p>' +
    '</div></body></html>';
}
