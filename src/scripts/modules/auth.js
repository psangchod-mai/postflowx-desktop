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
  const PFX_BACKEND_URL = 'https://script.google.com/macros/s/AKfycbxUaExYv2zcGN55XBbToXx6bFmBjWx4VSxYmW4K3T-sFg08qm_pOzAArsZva7-rOncF/exec';
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
            // Always set a long expiry for desktop (30 days).
            expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
          },
        };
        localStorage.setItem('pfx_desktop_session.v1', JSON.stringify(desktop));
      } catch {}
    }
  }

  async function _pfxClear() {
    _pfxSession = null;
    if (window.PFX_PERMISSIONS?.setSession) window.PFX_PERMISSIONS.setSession(null);
    await chrome.storage.local.remove(PFX_SESSION_KEY);
    if (window.__PFX_IS_ELECTRON || window.__PFX_TARGET__ === 'desktop') {
      try { localStorage.removeItem('pfx_desktop_session.v1'); } catch {}
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

  /** Sign in with Google via Supabase OAuth PKCE + chrome.identity.launchWebAuthFlow. */
  async function signInWithGoogle() {
    // On Electron, trigger the Google OAuth popup first to populate _googleProfile.
    // The chrome.identity shim reads from _googleProfile (set by pfxPlatform.googleSignIn).
    if ((window.__PFX_IS_ELECTRON || window.__PFX_TARGET__ === 'desktop') && window.pfxPlatform?.googleSignIn) {
      const oauthResult = await window.pfxPlatform.googleSignIn();
      if (!oauthResult?.ok) {
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
    init, ready, signInWithGoogle, signOut, refreshSession,
    getSession, getUser, getPlan, isSignedIn, canUse, onChange,
    // PostFlowX RBAC
    getPfxSession, getPfxRole, canAccessTab, canDoAction, isReadOnly,
    PLAN_FEATURES, PLAN_DISPLAY,
  };
})();

window.PFX_AUTH = PFX_AUTH;
// Expose backend URL so boot-guard.js can reference it without duplication
// (boot-guard.js will use its own copy — this is just for tooling/debugging)
window.__PFX_BACKEND_URL_FROM_AUTH = PFX_AUTH._backendUrl || 'https://api.postflowx.com';
