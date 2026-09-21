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

  // Direct PostFlowX policy service. Google Sheets is not part of this path.
  const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbxhdc-5B2q-YYs_og7BU7fpJHz3VAcGKzDVu422XViMvZndXhy1ytGjTgJmNwKLSXgS/exec';
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
      } else if (result?.policy?.status === 'expired') {
        await _clear();
      } else if (result?.policy?.status === 'disabled' || result?.policy?.status === 'pending') {
        // Retain the verified identity so the denied screen can re-check after
        // approval, but remove every permission while access is blocked.
        await _save({
          ...stored,
          ok: false,
          status: result.policy.status,
          permissions: { tabs: [], actions: [] },
        });
      }
    } catch {}
  }

  // ── Desktop background re-validation (non-blocking) ────────────────────────
  // Mirrors _validateInBackground for the Electron path. The desktop guard boots
  // immediately from the stored localStorage session (responsive / offline-tolerant),
  // then re-hits the backend here. Only an EXPLICIT negative response (disabled /
  // pending) revokes the local session and surfaces the denied UI — transient
  // network failures fail OPEN so the user is never locked out.
  async function _revalidateDesktopInBackground(stored) {
    try {
      if (!BACKEND_CONFIGURED) return;
      const email = String(stored?.user?.email || '').trim().toLowerCase();
      if (!email) return;
      // Synthetic / dev / awaiting-sign-in sessions never re-validate remotely.
      const token = stored?.session?.token || '';
      if (token === 'dev-bypass' || token === 'awaiting-google-signin' ||
          token === 'supabase-plan-only') return;
      const policyFlow = window.pfxBootPolicyFlow;
      if (!policyFlow?.run) return;

      const result = await policyFlow.run({
        email,
        name: stored?.user?.name || email.split('@')[0],
        pfxToken: token,
        version: _extensionVersion(),
      });

      // Expiry is final for this session: remove it and require a fresh sign-in.
      // Unlike pending/disabled, there is no reusable identity state to retain.
      if (result && !result.ok && result.policy?.status === 'expired') {
        window.PFX_SESSION_STORE?.clear();
        if (window.PFX_PERMISSIONS?.setSession) window.PFX_PERMISSIONS.setSession(null);
        window.PFX_LOGIN_UI?.showExpired?.();
        return;
      }

      // Explicit negative from the backend → block every permission and show
      // denied UI. Keep the verified identity/token so approval can be detected
      // without another OAuth flow or accidental account switch.
      if (result && !result.ok &&
          (result.policy?.status === 'disabled' || result.policy?.status === 'pending')) {
        const status = result.policy.status;
        const blocked = {
          ...stored,
          ok: false,
          status,
          permissions: { tabs: [], actions: [] },
        };
        window.PFX_SESSION_STORE?.save(blocked);
        if (window.PFX_PERMISSIONS?.setSession) window.PFX_PERMISSIONS.setSession(blocked);
        window.PFX_LOGIN_UI?.showDenied?.({
          email,
          message: status === 'pending'
            ? 'Your account is registered, but access is still pending approval.'
            : 'Your PostFlowX access is currently disabled.',
        });
        return;
      }

      // Fresh valid policy → refresh the stored desktop session so a new
      // (possibly shorter) expiry / updated flags take effect on next launch.
      if (result?.ok && result.policy) {
        const fresh = _normalizePolicySession(result.policy, stored, { email, name: stored?.user?.name });
        window.PFX_SESSION_STORE?.save(fresh);
        if (window.PFX_PERMISSIONS?.setSession) window.PFX_PERMISSIONS.setSession(fresh);
      }
      // Any other case (network failure → policy null / cache source) → fail open.
    } catch { /* transient error — fail open, never lock the user out */ }
  }

  // ── Main guard logic ─────────────────────────────────────────────────────
  async function _guard() {
    // ── Electron desktop app: true boot gate ──────────────────────────────
    // The renderer never boots with a synthetic admin identity. A valid,
    // unexpired enterprise session must also pass the direct policy service.
    if (window.__PFX_IS_ELECTRON || window.__PFX_TARGET__ === 'desktop') {
      const stored = window.PFX_SESSION_STORE?.load() || null;
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
        window.PFX_SESSION_STORE?.save(devSession);
        return { status: 'ok', session: devSession };
      }

      // A development build may have persisted its synthetic admin session in
      // the same macOS user-data folder later used by a packaged build. Never
      // send that fake identity to the production access-control service: it
      // will (correctly) reject the non-enterprise domain and strand the user
      // on a deny screen with no way to choose their real Netflix account.
      const storedToken = String(stored?.session?.token || '');
      const storedEmail = String(stored?.user?.email || '').trim().toLowerCase();
      if (storedToken === 'dev-bypass' || storedEmail === 'local-dev@postflowx.local') {
        window.PFX_SESSION_STORE?.clear();
        await _clear();
        return { status: 'login', reason: 'development_session_removed' };
      }

      const email = String(stored?.user?.email || '').trim().toLowerCase();
      const expiry = new Date(stored?.session?.expiresAt || 0).getTime();
      if (!email || !expiry || expiry <= Date.now()) {
        window.PFX_SESSION_STORE?.clear();
        return { status: 'login', reason: 'no_session' };
      }
      const policyFlow = window.pfxBootPolicyFlow;
      if (!policyFlow?.run) return { status: 'login', reason: 'policy_flow_unavailable' };
      const result = await policyFlow.run({
        email,
        name: stored?.user?.name || email.split('@')[0],
        pfxToken: stored?.session?.token || '',
        version: _extensionVersion(),
      });
      if (!result?.ok || !result.policy || result.source !== 'remote') {
        if (result?.policy?.status === 'disabled' || result?.policy?.status === 'pending') {
          const blocked = {
            ...stored,
            ok: false,
            status: result.policy.status,
            permissions: { tabs: [], actions: [] },
          };
          window.PFX_SESSION_STORE?.save(blocked);
          await window.PFX_AUTH?.applyPolicySession?.(blocked);
          return { status: 'denied', reason: result.policy.status, email };
        }
        if (result?.policy?.status === 'expired') {
          window.PFX_SESSION_STORE?.clear();
          return { status: 'login', reason: 'session_expired' };
        }
        return { status: 'login', reason: 'policy_unavailable' };
      }
      const fresh = _normalizePolicySession(result.policy, stored, { email, name: stored?.user?.name });
      window.PFX_SESSION_STORE?.save(fresh);
      await window.PFX_AUTH?.applyPolicySession?.(fresh);
      return { status: 'ok', session: fresh };
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

    // A cached extension identity must still pass the live direct policy.
    const stored = await _load();
    if (stored?.session?.token) {
      const email = String(stored?.user?.email || '').trim().toLowerCase();
      const result = await window.pfxBootPolicyFlow?.run?.({ email, name: stored?.user?.name, pfxToken: stored.session.token, version: _extensionVersion() });
      if (result?.ok && result.policy) {
        const fresh = _normalizePolicySession(result.policy, stored, stored.user || {});
        await _save(fresh);
        return { status: 'ok', session: fresh };
      }
      if (result?.policy?.status === 'disabled' || result?.policy?.status === 'pending') {
        await _save({
          ...stored,
          ok: false,
          status: result.policy.status,
          permissions: { tabs: [], actions: [] },
        });
        return { status: 'denied', reason: result.policy.status, email };
      }
      if (result?.policy?.status === 'expired') {
        await _clear();
        return { status: 'login', reason: 'session_expired' };
      }
      await _clear();
      return { status: 'login', reason: 'policy_unavailable' };
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
        const blocked = {
          ..._normalizePolicySession(result.policy, {}, profile),
          ok: false,
          status: result.policy.status,
          permissions: { tabs: [], actions: [] },
        };
        await _save(blocked);
        return { status: 'denied', reason: result.policy.status, email };
      }
      if (result?.policy?.status === 'expired') {
        return { status: 'login', reason: 'session_expired' };
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
      window.PFX_LOGIN_UI?.showDenied?.({ message, email: result.email || '' });
    } else {
      const extraMsg = result.reason === 'no_chrome_account'
        ? 'Sign into Chrome with the Google account that should access PostFlowX.'
        : result.reason === 'policy_flow_unavailable' || result.reason === 'policy_unavailable'
          ? 'We could not reach the PostFlowX access policy service. Sign in again to retry in a moment.'
        : null;
      window.PFX_LOGIN_UI?.showLogin?.({ message: extraMsg });
    }
  }

  // The remote enterprise policy can take several seconds on a cold start.
  // Render a protected loading card as soon as <body> exists so the app never
  // presents an unexplained blank window while the guard remains fail-closed.
  function _showCheckingUI() {
    window.PFX_LOGIN_UI?.showChecking?.();
  }
  if (document.body) {
    _showCheckingUI();
  } else {
    document.addEventListener('DOMContentLoaded', _showCheckingUI, { once: true });
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
