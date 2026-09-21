// PostFlowX Auth — Supabase + Google OAuth (PKCE) for MV3 Chrome Extension
// ─────────────────────────────────────────────────────────────────────────────
// SETUP REQUIRED:
//   1. Create a project at https://supabase.com
//   2. Enable Google OAuth in Authentication → Providers → Google
//   3. Add Chrome extension redirect URL to Google OAuth allowed redirect URIs:
//        https://<YOUR_EXTENSION_ID>.chromiumapp.org/
//      (find your extension ID at chrome://extensions)
//   4. Fill in SUPABASE_URL and SUPABASE_ANON_KEY below
//   5. Run the SQL in supabase_setup.sql in your Supabase SQL editor
// ─────────────────────────────────────────────────────────────────────────────

const PFX_AUTH = (() => {
  'use strict';

  // ── ⚙️  CONFIG — fill these in ──────────────────────────────────────────────
  const SUPABASE_URL      = 'https://YOUR_PROJECT_ID.supabase.co';
  const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
  // ─────────────────────────────────────────────────────────────────────────────

  const STORAGE_KEY = 'pfx_auth_session_v2';

  // ── PostFlowX Backend ────────────────────────────────────────────────────
  // ⚙️  Replace with your real backend URL. Change in boot-guard.js too.
  const PFX_BACKEND_URL = 'https://script.google.com/macros/s/AKfycbxhdc-5B2q-YYs_og7BU7fpJHz3VAcGKzDVu422XViMvZndXhy1ytGjTgJmNwKLSXgS/exec';
  const PFX_SESSION_KEY = 'postflowxSession';

  // Plan → allowed feature keys
  const PLAN_FEATURES = {
    free: [
      'pulls_prep',
      'cutdiff_basic',
      'edl_export',
      'bwav_inspector',
      'preflight',
    ],
    pro: [
      'pulls_prep',
      'cutdiff_basic',
      'cutdiff2_full',
      'plate_link',
      'vfx_marker',
      'smart_timeline',
      'edl_export',
      'ale_export',
      'imf_basic',
      'bwav_inspector',
      'preflight',
      'visual_qc',
    ],
    enterprise: ['*'],
  };

  const PLAN_DISPLAY = {
    free:       { label: 'FREE',       color: '#64648a', bg: '#1a1a2e' },
    pro:        { label: 'PRO',        color: '#f5c542', bg: '#2a2010' },
    enterprise: { label: 'ENTERPRISE', color: '#c678dd', bg: '#1e1228' },
  };

  // ── State ──────────────────────────────────────────────────────────────────
  let _session    = null;   // Supabase session
  let _pfxSession = null;   // PostFlowX backend session (role + permissions)
  let _plan       = 'free';
  let _listeners  = [];
  let _ready      = false;
  let _readyResolvers = [];

  // ── PKCE ──────────────────────────────────────────────────────────────────
  function _randomHex(n) {
    return Array.from(crypto.getRandomValues(new Uint8Array(n)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function _generatePKCE() {
    const verifier  = _randomHex(32);
    const encoded   = new TextEncoder().encode(verifier);
    const hashBuf   = await crypto.subtle.digest('SHA-256', encoded);
    const challenge = btoa(String.fromCharCode(...new Uint8Array(hashBuf)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return { verifier, challenge };
  }

  // ── Supabase REST ─────────────────────────────────────────────────────────
  async function _authFetch(path, opts = {}, bearerToken = null) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
      ...opts,
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        ...(bearerToken ? { 'Authorization': `Bearer ${bearerToken}` } : {}),
        ...(opts.headers || {}),
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.message || body.error_description || body.error || `HTTP ${res.status}`);
    }
    return body;
  }

  async function _restFetch(path, opts = {}, token = null) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      ...opts,
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) return null;
    return res.json().catch(() => null);
  }

  // ── Session persistence ───────────────────────────────────────────────────
  async function _save(session) {
    _session = session;
    await chrome.storage.local.set({ [STORAGE_KEY]: session });
  }

  async function _load() {
    const s = await chrome.storage.local.get(STORAGE_KEY);
    return s[STORAGE_KEY] || null;
  }

  async function _clear() {
    _session = null;
    _plan    = 'free';
    await chrome.storage.local.remove(STORAGE_KEY);
  }

  // ── PostFlowX Backend Session ─────────────────────────────────────────────
  async function _pfxExchange(googleToken) {
    const res = await fetch(`${PFX_BACKEND_URL}/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: googleToken }),
    });
    if (!res.ok) throw new Error(`Backend HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(data.error || 'Access denied by backend');
    return data;
  }

  async function _pfxSave(payload) {
    _pfxSession = payload;
    if (window.PFX_PERMISSIONS?.setSession) window.PFX_PERMISSIONS.setSession(payload);
    await chrome.storage.local.set({ [PFX_SESSION_KEY]: payload });
    // On Electron, also persist to localStorage so boot-guard finds it on next launch.
    if (window.__PFX_IS_ELECTRON || window.__PFX_TARGET__ === 'desktop') {
      try {
        const desktop = {
          ...payload,
          session: {
            ...payload.session,
            // Honor the backend-provided expiry (mirrors the sheet's expires_at)
            // so revocation/expiry actually takes effect. Only fall back to a
            // SHORT default TTL (8h, matching ipc.js) when the backend gives none.
            expiresAt: payload.session?.expiresAt
              || new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
          },
        };
        window.PFX_SESSION_STORE?.save(desktop);
      } catch {}
    }
  }

  async function _pfxClear() {
    _pfxSession = null;
    if (window.PFX_PERMISSIONS?.setSession) window.PFX_PERMISSIONS.setSession(null);
    await chrome.storage.local.remove(PFX_SESSION_KEY);
    if (window.__PFX_IS_ELECTRON || window.__PFX_TARGET__ === 'desktop') {
      window.PFX_SESSION_STORE?.clear();
    }
  }

  function _backendConfigured() {
    return !PFX_BACKEND_URL.includes('api.postflowx.com');
  }

  async function _getChromeProfile() {
    return new Promise(resolve => {
      try {
        chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, info => resolve(info || {}));
      } catch {
        resolve({});
      }
    });
  }

  async function _signInWithBackendPolicy() {
    const info = await _getChromeProfile();
    const email = String(info?.email || '').trim().toLowerCase();
    if (!email) {
      throw new Error('No Google account signed in to Chrome. Please sign into Chrome first.');
    }

    if (!_backendConfigured()) {
      const synth = {
        ok: true,
        user: { email, name: email.split('@')[0], picture: null },
        role: 'admin',
        permissions: { tabs: ['*'], actions: ['*'] },
        session: {
          token: `dev-${Date.now()}`,
          expiresAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
        },
      };
      await _pfxSave(synth);
      return synth;
    }

    const flow = window.pfxBootPolicyFlow;
    if (!flow?.run) {
      throw new Error('Policy service is unavailable. Please reload PostFlowX and try again.');
    }

    const policyResult = await flow.run({
      email,
      name: email.split('@')[0],
      version: chrome.runtime?.getManifest?.()?.version || '',
    });

    if (!policyResult?.ok || !policyResult.policy) {
      if (policyResult?.policy?.status === 'pending') {
        throw new Error('Your account has been registered, but access is still pending approval.');
      }
      if (policyResult?.policy?.status === 'disabled') {
        throw new Error('Your PostFlowX access is currently disabled.');
      }
      throw new Error('We could not reach the access policy service. Please try again in a moment.');
    }

    const payload = {
      ok: true,
      status: policyResult.policy.status || 'active',
      request_status: policyResult.policy.request_status || 'approved',
      user: {
        email,
        name: email.split('@')[0],
        picture: null,
      },
      role: policyResult.policy.role || 'viewer',
      permissions: {
        tabs: policyResult.policy.allowedTabs || [],
        actions: policyResult.policy.allowedActions || [],
      },
      featureFlags: policyResult.policy.featureFlags || {},
      session: {
        token: null,
        expiresAt: policyResult.policy.expiresAt || new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    };
    await _pfxSave(payload);
    return payload;
  }

  function _pfxPermissions() {
    return _pfxSession?.permissions || null;
  }

  function canAccessTab(tabId) {
    // Delegate to PFX_PERMISSIONS if available (richer logic including canonical mapping)
    if (window.PFX_PERMISSIONS) return window.PFX_PERMISSIONS.canAccessTab(tabId);
    const p = _pfxPermissions();
    if (!p) return true;
    const tabs = p.tabs || [];
    return tabs.includes('*') || tabs.includes(tabId);
  }

  function canDoAction(actionId) {
    if (window.PFX_PERMISSIONS) return window.PFX_PERMISSIONS.canDoAction(actionId);
    const p = _pfxPermissions();
    if (!p) return true;
    const actions = p.actions || [];
    return actions.includes('*') || actions.includes(actionId);
  }

  function getPfxSession()  { return _pfxSession; }
  function getPfxRole()     { return _pfxSession?.role || null; }

  /**
   * Re-check access without starting a second OAuth flow.
   *
   * This deliberately reuses only the identity already verified by Meechum /
   * Google and requires a fresh REMOTE policy response before restoring access.
   * It must never accept an email typed by the user or unlock from policy cache.
   */
  async function recheckAccess() {
    const isDesktop = window.__PFX_IS_ELECTRON || window.__PFX_TARGET__ === 'desktop';
    let current = _pfxSession;
    if (isDesktop) {
      current = window.PFX_SESSION_STORE?.load?.() || current;
    } else if (!current) {
      const stored = await chrome.storage.local.get(PFX_SESSION_KEY).catch(() => ({}));
      current = stored[PFX_SESSION_KEY] || null;
    }

    const email = String(current?.user?.email || '').trim().toLowerCase();
    const token = current?.session?.token || '';
    const expiresAt = new Date(current?.session?.expiresAt || 0).getTime();

    // Do not keep rechecking a synthetic development identity in a packaged
    // build. Clear both renderer and encrypted desktop copies so the next
    // action starts the real Meechum/Google sign-in flow.
    if (isDesktop && !window.pfxPlatform?.devBypass &&
        (token === 'dev-bypass' || email === 'local-dev@postflowx.local')) {
      await _pfxClear();
      return { state: 'needs_sign_in' };
    }

    if (!email || !expiresAt || expiresAt <= Date.now()) {
      return { state: 'needs_sign_in' };
    }

    const flow = window.pfxBootPolicyFlow;
    if (!flow?.run) return { state: 'error' };
    const result = await flow.run({
      email,
      name: current?.user?.name || email.split('@')[0],
      pfxToken: token,
      version: chrome.runtime?.getManifest?.()?.version || '',
    });

    // A cached allow is not sufficient to lift a deny overlay.
    if (result?.ok && result.policy && result.source === 'remote') {
      const policy = result.policy;
      const payload = {
        ...current,
        ok: true,
        status: policy.status || 'active',
        request_status: policy.request_status || 'approved',
        user: { ...current.user, email },
        role: policy.role || current.role || 'viewer',
        permissions: {
          tabs: policy.allowedTabs || [],
          actions: policy.allowedActions || [],
        },
        featureFlags: policy.featureFlags || {},
        session: {
          ...current.session,
          token,
          expiresAt: policy.expiresAt || current.session.expiresAt,
        },
      };
      await _pfxSave(payload);
      _notify('access_rechecked');
      return { state: 'active', payload };
    }

    const status = String(result?.policy?.status || '').trim().toLowerCase();
    if (status === 'pending' || status === 'disabled' || status === 'expired') {
      return { state: status };
    }
    return { state: 'error' };
  }

  function isReadOnly() {
    if (window.PFX_PERMISSIONS) return window.PFX_PERMISSIONS.isReadOnly();
    const p = _pfxPermissions();
    if (!p) return false;
    const actions = p.actions || [];
    if (actions.includes('*')) return false;
    const mutating = ['edit_cut','save_project','export','import_media',
                      'import_timeline','annotate','comment','relink_media'];
    return !mutating.some(a => actions.includes(a));
  }

  // ── Plan ──────────────────────────────────────────────────────────────────
  async function _fetchPlan(token) {
    try {
      const rows = await _restFetch(
        '/user_profiles?select=plan&limit=1',
        { headers: { 'Accept': 'application/json' } },
        token
      );
      return rows?.[0]?.plan || 'free';
    } catch { return 'free'; }
  }

  // ── Listeners ─────────────────────────────────────────────────────────────
  function _notify(event = 'change') {
    const payload = { event, session: _session, user: _session?.user || null, plan: _plan };
    _listeners.forEach(fn => { try { fn(payload); } catch {} });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Restore session from storage and set up auto-refresh. Call once on startup. */
  async function init() {
    const stored = await _load();
    if (stored?.access_token) {
      const expiresAt  = stored.expires_at ? stored.expires_at * 1000 : 0;
      const needsRenew = expiresAt && (expiresAt - Date.now()) < 5 * 60 * 1000;

      if (needsRenew && stored.refresh_token) {
        try {
          await _doRefresh(stored.refresh_token);
        } catch {
          await _clear();
        }
      } else {
        _session = stored;
        _plan    = await _fetchPlan(stored.access_token);
      }
    }
    // Restore PostFlowX backend session
    const pfxStored = await chrome.storage.local.get(PFX_SESSION_KEY).catch(() => ({}));
    if (pfxStored[PFX_SESSION_KEY]) {
      _pfxSession = pfxStored[PFX_SESSION_KEY];
      if (window.PFX_PERMISSIONS?.setSession) window.PFX_PERMISSIONS.setSession(_pfxSession);
    }

    _ready = true;
    _readyResolvers.forEach(r => r());
    _readyResolvers = [];
    _notify('init');
  }

  /** Returns a promise that resolves when init() has completed. */
  function ready() {
    return _ready
      ? Promise.resolve()
      : new Promise(r => _readyResolvers.push(r));
  }

  /** Sign in desktop workforce and partner users through Edward/Meechum. */
  async function signInWithEnterprise() {
    const isDesktop = window.__PFX_IS_ELECTRON || window.__PFX_TARGET__ === 'desktop';
    if (!isDesktop || !window.pfxPlatform?.enterpriseSignIn) {
      return signInWithGoogle();
    }

    // Preserve the explicit local-development bypass without sending the user
    // through a real enterprise login window.
    let bypass = null;
    try { bypass = await window.pfxPlatform?.devAuthBypass?.(); } catch {}
    if (bypass?.ok && bypass.accessToken === 'dev-bypass') {
      const synth = {
        ok: true,
        user: { email: bypass.email, name: bypass.name, picture: '' },
        role: 'admin',
        permissions: { tabs: ['*'], actions: ['*'] },
        featureFlags: {},
        session: {
          token: 'dev-bypass',
          expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        },
      };
      await _pfxSave(synth);
      _notify('signed_in');
      return synth;
    }

    const oauthResult = await window.pfxPlatform.enterpriseSignIn();
    if (!oauthResult?.ok) {
      const status = String(oauthResult?.status || '').trim().toLowerCase();
      const rawErr = oauthResult?.error || 'Netflix sign-in failed';
      // A legacy backend expresses "email not provisioned" as `not_found`;
      // treat it exactly like `pending` so the user sees the friendly
      // "registered, pending approval" message rather than a raw error code.
      if (status === 'pending' || status === 'not_found' || rawErr === 'not_found') {
        throw new Error('Your account has been registered, but access is still pending approval.');
      }
      if (status === 'disabled') {
        throw new Error('Your PostFlowX access is currently disabled.');
      }
      throw new Error(rawErr === 'MEECHUM_DESKTOP_CLIENT_MISSING'
        ? 'Netflix sign-in is not configured for this build. Contact your administrator.'
        : rawErr);
    }

    if (oauthResult.pfxSession) {
      await _pfxSave(oauthResult.pfxSession);
      _notify('signed_in');
      return oauthResult.pfxSession;
    }

    // The Electron preload exposes the verified Meechum identity through the
    // chrome.identity compatibility shim. Reuse the existing PostFlowX access
    // policy service to resolve roles, feature flags, and permissions.
    const payload = await _signInWithBackendPolicy();
    _notify('signed_in');
    return payload;
  }

  /** Sign in with Google via Supabase OAuth PKCE + chrome.identity.launchWebAuthFlow. */
  async function signInWithGoogle() {
    // On Electron, trigger the Google OAuth popup first to populate _googleProfile.
    // The chrome.identity shim reads from _googleProfile (set by pfxPlatform.googleSignIn).
    if ((window.__PFX_IS_ELECTRON || window.__PFX_TARGET__ === 'desktop') && window.pfxPlatform?.googleSignIn) {
      const oauthResult = await window.pfxPlatform.googleSignIn();
      if (!oauthResult?.ok) {
        // Backend policy status (pending/disabled) is passed through by ipc.js —
        // map it to a user-facing message rather than surfacing a raw error.
        const status = String(oauthResult?.status || '').trim().toLowerCase();
        if (status === 'pending') {
          throw new Error('Your account has been registered, but access is still pending approval.');
        }
        if (status === 'disabled') {
          throw new Error('Your PostFlowX access is currently disabled.');
        }
        const rawErr = oauthResult?.error || 'Google sign-in failed';
        throw new Error(rawErr === 'GOOGLE_DESKTOP_CLIENT_ID_MISSING'
          ? 'Google sign-in is not configured for this build. Contact your administrator.'
          : rawErr);
      }

      // Dev bypass: synthetic session — skip backend + Supabase entirely.
      if (oauthResult.accessToken === 'dev-bypass') {
        const synth = {
          ok: true,
          user: { email: oauthResult.email, name: oauthResult.name, picture: '' },
          role: 'admin',
          permissions: { tabs: ['*'], actions: ['*'] },
          featureFlags: {},
          session: {
            token: 'dev-bypass',
            expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
          },
        };
        await _pfxSave(synth);
        _notify('signed_in');
        return synth;
      }

      // Backend auth completed in main process — use pfxSession directly, skip _signInWithBackendPolicy.
      if (oauthResult.pfxSession) {
        await _pfxSave(oauthResult.pfxSession);
        _notify('signed_in');
        return oauthResult.pfxSession;
      }
    }

    if (SUPABASE_URL.includes('YOUR_PROJECT_ID')) {
      const payload = await _signInWithBackendPolicy();
      _notify('signed_in');
      return payload;
    }

    const { verifier, challenge } = await _generatePKCE();
    const redirectURL = chrome.identity.getRedirectURL();

    const authURL = `${SUPABASE_URL}/auth/v1/authorize?` + new URLSearchParams({
      provider: 'google',
      redirect_to: redirectURL,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scopes: 'email profile openid',
    });

    const responseURL = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow({ url: authURL, interactive: true }, url => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'Auth cancelled'));
        } else if (!url) {
          reject(new Error('Auth cancelled'));
        } else {
          resolve(url);
        }
      });
    });

    const code = new URL(responseURL).searchParams.get('code');
    if (!code) throw new Error('No auth code returned — check Supabase redirect URL config');

    const session = await _authFetch('/token?grant_type=pkce', {
      method: 'POST',
      body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
    });

    session.expires_at = Math.floor(Date.now() / 1000) + (session.expires_in || 3600);
    await _save(session);
    _plan = await _fetchPlan(session.access_token);

    // Exchange with PostFlowX backend for role + permissions
    if (_backendConfigured()) {
      try {
        const googleToken = await new Promise((resolve, reject) => {
          chrome.identity.getAuthToken({ interactive: false }, t =>
            chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(t)
          );
        });
        if (googleToken) {
          const pfxPayload = await _pfxExchange(googleToken);
          await _pfxSave(pfxPayload);
        }
      } catch (e) {
        console.warn('[PFX Auth] Backend exchange failed (non-fatal):', e.message);
      }
    }

    _notify('signed_in');
    return session;
  }

  // ── Email magic-link sign-in (poll-based, primary desktop flow) ────────────
  // No Google Cloud / OAuth client / deep-link — pure renderer↔Apps Script HTTP.
  // The SECRET token lives only in the emailed link; the app only ever holds the
  // public pollId returned here.

  /**
   * Request a magic-link email. Returns { ok:true, pollId, email } on success.
   * Throws a user-facing Error for invalid email / rate-limit / network failure.
   */
  async function signInWithEmailLink(email) {
    const e = String(email || '').trim().toLowerCase();
    if (!e) throw new Error('Please enter your email address.');
    const res = await window.pfxPolicyApi?.requestLink?.({ email: e });
    if (res == null) {
      // Network error — fail without locking anyone out; the user can retry.
      throw new Error('We could not reach the sign-in service. Check your connection and try again.');
    }
    if (!res.ok) {
      if (res.error === 'invalid_email') throw new Error('That does not look like a valid email address.');
      if (res.error === 'rate_limited') throw new Error('A sign-in link was just sent. Please wait a minute before requesting another.');
      throw new Error('Could not send a sign-in link. Please try again in a moment.');
    }
    return { ok: true, pollId: res.pollId, email: e };
  }

  /**
   * Poll ONCE for magic-link confirmation. The caller (login-ui) owns the interval,
   * timeout, and Resend button. On the ACTIVE result this persists the session via
   * _pfxSave (same path as Google sign-in) and fires 'signed_in'.
   *
   * Poll with no `code` to detect the confirmed→needsCode transition; pass the
   * 6-digit `code` on the Verify step. The session is only minted server-side once
   * the code the clicker saw is submitted (defeats login-CSRF).
   *
   * Returns { state, payload?, badCode? } where state is one of:
   *   'waiting'  — link not clicked yet (keep polling)
   *   'needsCode'— clicked; the app must collect + submit the code (badCode:true when
   *                a submitted code was wrong)
   *   'active'   — signed in; session persisted
   *   'pending' | 'disabled' — authz decision (stop polling, show message)
   *   'expired'  — link/poll no longer valid (stop polling, offer Resend)
   *   'error'    — transient/network (caller may keep polling)
   */
  async function pollEmailLink(pollId, email, code) {
    const res = await window.pfxPolicyApi?.checkLink?.({ pollId, code });
    if (res == null) return { state: 'error' }; // transient — keep polling, never lock out
    if (res.ok && res.waiting) return { state: 'waiting' };
    if (res.ok && res.needsCode) return { state: 'needsCode', badCode: !!res.badCode };
    if (res.ok && res.permissions) {
      const em = String(email || '').trim().toLowerCase();
      const payload = {
        ok: true,
        status: 'active',
        request_status: 'approved',
        user: { email: em, name: em ? em.split('@')[0] : 'PostFlowX User', picture: null },
        role: res.role || 'viewer',
        permissions: {
          tabs: res.permissions.tabs || [],
          actions: res.permissions.actions || [],
        },
        featureFlags: res.featureFlags || {},
        session: {
          token: res.sessionToken || null,
          // Honor the backend expiry (mirrors AccessControl.expires_at); fall back
          // to a SHORT default only when the backend gives none.
          expiresAt: res.expiresAt || new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
        },
      };
      await _pfxSave(payload);
      _notify('signed_in');
      return { state: 'active', payload };
    }
    const status = String(res.status || '').trim().toLowerCase();
    if (status === 'pending')  return { state: 'pending' };
    if (status === 'disabled') return { state: 'disabled' };
    if (status === 'expired')  return { state: 'expired' };
    return { state: 'error' };
  }

  /** Sign out and clear session. */
  async function signOut() {
    if (_session?.access_token) {
      await _authFetch('/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${_session.access_token}` },
      }).catch(() => {});
    }
    // Revoke PostFlowX backend session
    if (_pfxSession?.session?.token && !PFX_BACKEND_URL.includes('api.postflowx.com')) {
      await fetch(`${PFX_BACKEND_URL}/auth/logout`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${_pfxSession.session.token}` },
      }).catch(() => {});
    }
    await _clear();
    await _pfxClear();
    _notify('signed_out');
  }

  async function _doRefresh(refreshToken) {
    const session = await _authFetch('/token?grant_type=refresh_token', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    session.expires_at = Math.floor(Date.now() / 1000) + (session.expires_in || 3600);
    await _save(session);
    _plan = await _fetchPlan(session.access_token);
    _notify('token_refreshed');
    return session;
  }

  /** Manually refresh the access token. */
  async function refreshSession() {
    const token = _session?.refresh_token;
    if (!token) throw new Error('Not signed in');
    return _doRefresh(token);
  }

  // Getters
  function getSession()  { return _session; }
  function getUser()     { return _session?.user || null; }
  function getPlan()     { return _plan; }
  function isSignedIn()  { return !!_session?.access_token; }

  /** Check if the current user's plan allows a feature. */
  function canUse(feature) {
    if (_plan === 'enterprise') return true;
    const allowed = PLAN_FEATURES[_plan] || PLAN_FEATURES.free;
    return allowed.includes('*') || allowed.includes(feature);
  }

  /** Subscribe to auth state changes. fn({ event, session, user, plan }). */
  function onChange(fn) {
    _listeners.push(fn);
    return () => { _listeners = _listeners.filter(l => l !== fn); };
  }

  // Auto-refresh: check every 10 minutes.
  // Guard with a flag so a slow refresh (network stall) doesn't cause the next
  // interval tick to call _doRefresh concurrently with the same refresh token —
  // Supabase refresh tokens are single-use, so the second call would receive a
  // 400 and silently invalidate the session.
  let _autoRefreshing = false;
  setInterval(async () => {
    if (_autoRefreshing) return;
    if (!_session?.refresh_token) return;
    const expiresAt = _session.expires_at ? _session.expires_at * 1000 : 0;
    if (expiresAt && (expiresAt - Date.now()) < 10 * 60 * 1000) {
      _autoRefreshing = true;
      await _doRefresh(_session.refresh_token).catch(() => {});
      _autoRefreshing = false;
    }
  }, 10 * 60 * 1000);

  return {
    init, ready, signInWithEnterprise, signInWithGoogle, signInWithEmailLink, pollEmailLink, signOut, refreshSession,
    getSession, getUser, getPlan, isSignedIn, canUse, onChange,
    // PostFlowX RBAC
    getPfxSession, getPfxRole, recheckAccess, canAccessTab, canDoAction, isReadOnly,
    applyPolicySession: _pfxSave,
    PLAN_FEATURES, PLAN_DISPLAY,
  };
})();

window.PFX_AUTH = PFX_AUTH;
// Expose backend URL so boot-guard.js can reference it without duplication
// (boot-guard.js will use its own copy — this is just for tooling/debugging)
window.__PFX_BACKEND_URL_FROM_AUTH = PFX_AUTH._backendUrl || 'https://api.postflowx.com';
