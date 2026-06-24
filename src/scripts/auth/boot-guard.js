// scripts/auth/boot-guard.js — PostFlowX Auth Boot Guard
// Sets window.__pfxBootGuard (a Promise).
// ui.js awaits it before calling bootModules().
// Shows login/denied UI if auth fails.
//
// Source of truth:
// - Remote policy comes from the Apps Script AccessControl backend
// - Short-lived failover cache lives in chrome.storage.session via policyCache.js
// - The resolved UI session is mirrored in chrome.storage.local for display/use
//
// Fail-closed is mandatory:
// - remote policy success => allow
// - remote failure + valid session cache => allow cached policy
// - no valid remote + no valid cache => block protected tabs/actions

(function () {
  'use strict';

  // ⚙️  Replace with your Apps Script exec URL or real backend URL.
  //     Change in auth.js (PFX_BACKEND_URL) too.
  //     Example: 'https://script.google.com/macros/s/AKfycby.../exec'
  const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbxUaExYv2zcGN55XBbToXx6bFmBjWx4VSxYmW4K3T-sFg08qm_pOzAArsZva7-rOncF/exec';
  window.__PFX_BACKEND_URL = BACKEND_URL;

  const BACKEND_CONFIGURED = !BACKEND_URL.includes('api.postflowx.com');

  const PFXS_KEY = 'postflowxSession';

  // ── Storage helpers ──────────────────────────────────────────────────────
  async function _load() {
    try { const s = await chrome.storage.local.get(PFXS_KEY); return s[PFXS_KEY] || null; }
    catch { return null; }
  }
  async function _save(data) {
    try { await chrome.storage.local.set({ [PFXS_KEY]: data }); } catch {}
  }
  async function _clear() {
    try { await chrome.storage.local.remove(PFXS_KEY); } catch {}
  }

  // ── Synthetic session (plan-based, no backend) ───────────────────────────
  function _syntheticSession() {
    const plan = window.PFX_AUTH?.getPlan?.() || 'free';
    // Single source of truth: auth/planPolicy.js (window.PFX_PLAN_POLICY).
    // Fail-closed to the free policy if it somehow didn't load.
    const P = window.PFX_PLAN_POLICY;
    const tabs    = P ? P.tabsForPlan(plan)    : ['pull_prep'];
    const actions = P ? P.actionsForPlan(plan) : ['open_project', 'view_markers'];
    return {
      ok:   true,
      user: window.PFX_AUTH?.getUser?.() || {},
      role: plan === 'enterprise' ? 'admin' : plan === 'pro' ? 'editor' : 'viewer',
      permissions: {
        tabs,
        actions,
      },
      session: {
        token:     'supabase-plan-only',
        expiresAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
      },
    };
  }

  function _getProfileInfo() {
    return new Promise(resolve =>
      chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, r => resolve(r || {}))
    );
  }

  function _extensionVersion() {
    try { return chrome.runtime.getManifest()?.version || ''; }
    catch { return ''; }
  }

  function _normalizePolicySession(policy, priorSession, profile) {
    const email = (profile?.email || priorSession?.user?.email || '').trim().toLowerCase();
    const fallbackName = email ? email.split('@')[0] : 'PostFlowX User';
    return {
      ok: true,
      status: policy?.status || priorSession?.status || 'active',
      request_status: policy?.request_status || priorSession?.request_status || 'approved',
      user: {
        email,
        name: priorSession?.user?.name || profile?.name || fallbackName,
      },
      role: policy?.role || priorSession?.role || 'viewer',
      permissions: {
        tabs: policy?.allowedTabs || priorSession?.permissions?.tabs || [],
        actions: policy?.allowedActions || priorSession?.permissions?.actions || [],
      },
      featureFlags: policy?.featureFlags || priorSession?.featureFlags || {},
      session: {
        token: priorSession?.session?.token || null,
        expiresAt: policy?.expiresAt || priorSession?.session?.expiresAt || new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    };
  }

  // ── Background remote validation (non-blocking) ───────────────────────────
  // Called after a cache-first boot. Refreshes the stored session silently.
  async function _validateInBackground(stored) {
    try {
      const profile = await _getProfileInfo();
      const email = (profile?.email || stored?.user?.email || '').trim().toLowerCase();
      if (!email) return;
      const policyFlow = window.pfxBootPolicyFlow;
      if (!policyFlow?.run) return;
      const result = await policyFlow.run({
        email,
        name: stored?.user?.name || profile?.name || email.split('@')[0],
        pfxToken: stored?.session?.token || '',
        version: _extensionVersion(),
      });
      if (result?.ok && result.policy) {
        const fresh = _normalizePolicySession(result.policy, stored, profile);
        await _save(fresh);
      } else if (result?.policy?.status === 'disabled' || result?.policy?.status === 'pending') {
        // Account status changed — clear so next refresh shows correct state.
        await _clear();
      }
    } catch {}
  }

  // ── Main guard logic ─────────────────────────────────────────────────────
  async function _guard() {
    // ── Electron desktop app: bypass remote auth entirely ────────────────
    // No awaits here — any IPC call (_load/_save) can hang if the storage
    // handler isn't ready yet, which freezes the entire boot sequence.
    // __PFX_IS_ELECTRON is set by preload.js via contextBridge.
    // __PFX_TARGET__ === 'desktop' is injected directly into index.html by
    // build-renderer.js and serves as a belt-and-suspenders fallback if
    // the contextBridge call is late or fails.
    if (window.__PFX_IS_ELECTRON || window.__PFX_TARGET__ === 'desktop') {
      // Check for a stored authenticated session (saved to localStorage after Google sign-in)
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem('pfx_desktop_session.v1') || 'null'); } catch {}
      if (stored?.user?.email && stored?.session?.expiresAt && new Date(stored.session.expiresAt) > new Date()) {
        return { status: 'ok', session: stored };
      }

      // Dev bypass: auto-create a synthetic session so the login screen is never shown.
      // window.pfxPlatform.devBypass is set synchronously by preload.js (ipcRenderer.sendSync)
      // so it's available here without any async call.
      if (window.pfxPlatform?.devBypass) {
        const devSession = {
          ok: true, role: 'admin',
          user: { email: 'local-dev@postflowx.local', name: 'Local Dev' },
          permissions: { tabs: ['*'], actions: ['*'] },
          featureFlags: {},
          session: {
            token: 'dev-bypass',
            expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
          },
        };
        try { localStorage.setItem('pfx_desktop_session.v1', JSON.stringify(devSession)); } catch {}
        return { status: 'ok', session: devSession };
      }

      // No real Google session yet — boot with a temporary synthetic session so the app
      // renders (bootModules runs, no black screen), then show the sign-in overlay on top.
      // The _needsSignIn flag tells ui.js NOT to hide the overlay after boot.
      return {
        status: 'ok',
        _needsSignIn: true,
        session: {
          ok: true, role: 'admin',
          user: { email: '', name: 'PostFlowX Desktop' },
          permissions: { tabs: ['*'], actions: ['*'] },
          featureFlags: {},
          session: { token: 'awaiting-google-signin', expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString() },
        },
      };
    }

    // ── No backend configured ─────────────────────────────────────────────
    if (!BACKEND_CONFIGURED) {
      const stored = await _load();
      if (stored?.session?.token) return { status: 'ok', session: stored };
      if (window.PFX_AUTH?.isSignedIn?.()) {
        const synth = _syntheticSession();
        await _save(synth);
        return { status: 'ok', session: synth };
      }
      return { status: 'login', reason: 'no_session' };
    }

    // ── Cache-first: valid stored session → boot instantly ────────────────
    // Remote validation happens in the background so the UI isn't blocked.
    const stored = await _load();
    if (stored?.session?.token) {
      _validateInBackground(stored); // fire-and-forget
      return { status: 'ok', session: stored };
    }

    // ── Cold start: no cache — must fetch from remote ─────────────────────
    const profile = await _getProfileInfo();
    const email = (profile?.email || '').trim().toLowerCase();

    if (!email) {
      return { status: 'login', reason: 'no_chrome_account' };
    }

    const policyFlow = window.pfxBootPolicyFlow;
    if (!policyFlow?.run) {
      console.warn('[PFX Boot] Policy flow unavailable');
      return { status: 'login', reason: 'policy_flow_unavailable' };
    }

    const result = await policyFlow.run({
      email,
      name: profile?.name || email.split('@')[0],
      pfxToken: '',
      version: _extensionVersion(),
    });

    if (!result?.ok) {
      if (result?.policy?.status === 'pending' || result?.policy?.status === 'disabled') {
        return { status: 'denied', reason: result.policy.status };
      }
      return { status: 'login', reason: 'policy_unavailable' };
    }
    if (!result.policy) {
      return { status: 'login', reason: 'policy_unavailable' };
    }

    const session = _normalizePolicySession(result.policy, stored || {}, profile);
    await _save(session);
    return { status: 'ok', session };
  }

  // Run guard and store the promise globally
  const guardPromise = _guard().catch(e => {
    console.error('[PFX Boot] Guard error:', e);
    return { status: 'login', reason: 'guard_error' };
  });

  // Show appropriate overlay based on guard outcome.
  // Must defer until document.body exists — on Electron the Electron path resolves
  // synchronously (no awaits), so this .then() fires as a microtask before the HTML
  // parser creates <body>, causing document.body.prepend() to throw in login-ui.js.
  function _showAuthUI(result) {
    if (result.status === 'ok') {
      if (result._needsSignIn) window.PFX_LOGIN_UI?.showLogin?.();
      return;
    }
    if (result.status === 'denied') {
      const message = result.reason === 'pending'
        ? 'Your account is registered, but access is still pending approval.'
        : result.reason === 'disabled'
          ? 'Your PostFlowX access is currently disabled.'
          : 'We could not verify your PostFlowX access. Please try again or contact your administrator.';
      window.PFX_LOGIN_UI?.showDenied?.({ message });
    } else {
      const extraMsg = result.reason === 'no_chrome_account'
        ? 'Sign into Chrome with the Google account that should access PostFlowX.'
        : result.reason === 'policy_flow_unavailable' || result.reason === 'policy_unavailable'
          ? 'We could not reach the PostFlowX access policy service. Sign in again to retry in a moment.'
        : null;
      window.PFX_LOGIN_UI?.showLogin?.({ message: extraMsg });
    }
  }

  guardPromise.then(result => {
    if (document.body) {
      _showAuthUI(result);
    } else if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => _showAuthUI(result), { once: true });
    } else {
      // DOM is ready but body reference was missed; use a frame to let the parser finish.
      requestAnimationFrame(() => _showAuthUI(result));
    }
  });

  window.__pfxBootGuard = guardPromise;
})();
