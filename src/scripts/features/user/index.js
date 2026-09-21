// PostFlowX User UI — Login modal, Account modal, Header badge
// Depends on window.PFX_AUTH being loaded first (scripts/modules/auth.js)
(function () {
  'use strict';

  const auth = window.PFX_AUTH;
  if (!auth) { console.error('[PFX User] auth.js not loaded'); return; }

  // ── Google button SVG ─────────────────────────────────────────────────────
  const GOOGLE_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
  </svg>`;

  const USER_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
  </svg>`;

  // ── Avatar helper — generates colored SVG data URI from initials ──────────
  function _avatarDataUri(initials, email) {
    const COLORS = ['#e50914','#4f46e5','#0891b2','#16a34a','#d97706','#db2777','#7c3aed','#0284c7'];
    let hash = 0;
    for (let i = 0; i < (email || '').length; i++) hash = (hash * 31 + email.charCodeAt(i)) | 0;
    const bg  = COLORS[Math.abs(hash) % COLORS.length];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="${bg}"/><text x="48" y="62" font-family="system-ui,sans-serif" font-size="36" font-weight="700" fill="white" text-anchor="middle">${initials}</text></svg>`;
    return `data:image/svg+xml;base64,${btoa(svg)}`;
  }

  function _applyAvatar(imgEl, fallbackEl, avatarUrl, initials, email) {
    const dataUri = _avatarDataUri(initials || '?', email || '');
    if (fallbackEl) { fallbackEl.textContent = initials; }
    if (!imgEl) return;
    const usePhoto = !!avatarUrl;
    imgEl.style.display = 'block';
    if (fallbackEl) fallbackEl.style.display = 'none';
    imgEl.src = usePhoto ? avatarUrl : dataUri;
    if (usePhoto) {
      imgEl.onerror = () => { imgEl.src = dataUri; imgEl.onerror = null; };
    }
  }

  // ── Build: Header badge ───────────────────────────────────────────────────
  function _buildHeaderBadge() {
    if (document.getElementById('pfx-user-badge')) return;
    const badge = document.createElement('div');
    badge.id = 'pfx-user-badge';
    badge.className = 'pfx-user-badge';
    badge.innerHTML = `
      <button id="pfxUserBtn" class="pfx-user-btn" type="button" title="Account / Sign in">
        <span class="pfx-user-avatar-wrap">
          <img id="pfxUserAvatarImg" class="pfx-user-avatar-img" src="" alt="" />
          <span id="pfxUserIconWrap" class="pfx-user-icon-wrap">${USER_SVG}</span>
        </span>
        <span id="pfxUserPlanChip" class="pfx-user-plan-chip" hidden></span>
      </button>`;

    const langSwitch = document.querySelector('.lang-switch.lang-switch-tabs');
    if (langSwitch) {
      langSwitch.parentElement.insertBefore(badge, langSwitch);
    } else {
      document.querySelector('.tabs-right')?.append(badge);
    }

    document.getElementById('pfxUserBtn')?.addEventListener('click', () => {
      // In Electron desktop app, auth is always bypassed — go straight to account view
      if (window.__PFX_IS_ELECTRON) { showAccount(); return; }
      const pfxSigned = !!window.PFX_AUTH?.getPfxSession?.() || !!window.PFX_PERMISSIONS?.getSession?.();
      pfxSigned || auth.isSignedIn() ? showAccount() : showLogin();
    });
  }

  // ── Build: Login modal ────────────────────────────────────────────────────
  function _buildLoginModal() {
    if (document.getElementById('pfx-login-modal')) return;
    const el = document.createElement('div');
    el.id  = 'pfx-login-modal';
    el.className = 'pfx-modal-backdrop pfx-login-modal';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Sign in to PostFlowX');
    el.hidden = true;
    el.innerHTML = `
      <div class="pfx-modal-scrim" data-dismiss="login"></div>
      <div class="pfx-login-box" role="document">

        <button class="pfx-modal-close" data-dismiss="login" aria-label="Close">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/></svg>
        </button>

        <!-- Brand -->
        <div class="pfx-login-brand">
          <img src="assets/icons/pfx_logo.png" class="pfx-login-logo" alt="PostFlowX logo" />
          <div class="pfx-login-title">PostFlowX</div>
          <div class="pfx-login-tagline">Professional Post-Production Tools</div>
        </div>

        <!-- Google Sign-In -->
        <button id="pfxGoogleBtn" class="pfx-google-btn" type="button">
          ${GOOGLE_SVG}
          <span class="pfx-google-btn-label">Continue with Google</span>
        </button>
        <div id="pfxLoginError" class="pfx-login-error" hidden></div>

        <!-- Access info -->
        <div class="pfx-login-divider"><span>How to get access</span></div>
        <div class="pfx-access-notice">
          <div class="pfx-access-notice-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z" fill="currentColor"/>
            </svg>
          </div>
          <div class="pfx-access-notice-body">
            <div class="pfx-access-notice-title">Access is managed by Netflix</div>
            <div class="pfx-access-notice-desc">PostFlowX is not publicly available. Access is provisioned exclusively through Netflix Post Production &amp; Production Solutions.</div>
          </div>
        </div>
        <div class="pfx-contact-card">
          <div class="pfx-contact-card-label">To request access, contact your local</div>
          <div class="pfx-contact-card-team">Netflix Post Production<br><span>&amp; Production Solutions team</span></div>
          <div class="pfx-contact-card-hint">Your regional Netflix partner or vendor manager can submit an access request on your behalf.</div>
        </div>
        <p class="pfx-login-terms">By signing in you agree to our Terms of Service and Privacy Policy.</p>
      </div>`;

    document.body.appendChild(el);

    // Wire close buttons / scrim
    el.querySelectorAll('[data-dismiss="login"]').forEach(b =>
      b.addEventListener('click', hideLogin));

    // Google sign-in
    document.getElementById('pfxGoogleBtn')?.addEventListener('click', _handleGoogleSignIn);
  }

  // ── Desktop profile (localStorage) ───────────────────────────────────────
  const _PFX_DP_KEY = 'pfx_desktop_profile.v1';
  function _readDesktopProfile() {
    try {
      const p = JSON.parse(localStorage.getItem(_PFX_DP_KEY) || '{}');
      return (p?.name || p?.email) ? p : null;
    } catch { return null; }
  }

  // ── Build: Account modal ──────────────────────────────────────────────────
  function _buildAccountModal() {
    if (document.getElementById('pfx-account-modal')) return;
    const el = document.createElement('div');
    el.id = 'pfx-account-modal';
    el.className = 'pfx-modal-backdrop pfx-account-modal';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Account');
    el.hidden = true;
    el.innerHTML = `
      <div class="pfx-modal-scrim" data-dismiss="account"></div>
      <div class="pfx-account-box" role="document">

        <button class="pfx-modal-close" data-dismiss="account" aria-label="Close">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/></svg>
        </button>

        <!-- Profile header -->
        <div class="pfx-account-header">
          <div class="pfx-account-avatar-wrap">
            <img id="pfxAccAvatar" class="pfx-account-avatar" src="" alt="" />
            <span id="pfxAccAvatarFallback" class="pfx-account-avatar-fallback"></span>
          </div>
          <div class="pfx-account-meta">
            <div id="pfxAccName"  class="pfx-account-name"></div>
            <div id="pfxAccEmail" class="pfx-account-email"></div>
            <span id="pfxAccPlanBadge" class="pfx-account-plan-badge"></span>
          </div>
        </div>

        <!-- Plan detail -->
        <div class="pfx-account-section">
          <div class="pfx-account-section-title">Your plan includes</div>
          <div id="pfxAccFeats" class="pfx-account-feats"></div>
          <button id="pfxUpgradeBtn" class="pfx-upgrade-btn" type="button" hidden>
            Contact Netflix Post Production &amp; Production Solutions
          </button>
        </div>

        <!-- Session info -->
        <div class="pfx-account-section pfx-account-section-sm">
          <div class="pfx-account-section-title">Session</div>
          <div id="pfxAccSessionInfo" class="pfx-account-session-info"></div>
        </div>

        <!-- Desktop profile editor (shown only in Electron) -->
        <div id="pfxDesktopProfileSection" class="pfx-account-section pfx-desktop-profile-section" hidden>
          <div class="pfx-account-section-title">Edit profile</div>
          <div class="pfx-dp-field">
            <label class="pfx-dp-label" for="pfxDpName">Display name</label>
            <input id="pfxDpName" class="pfx-dp-input" type="text" placeholder="Your name" maxlength="60" autocomplete="off">
          </div>
          <div class="pfx-dp-field">
            <label class="pfx-dp-label" for="pfxDpEmail">Email</label>
            <input id="pfxDpEmail" class="pfx-dp-input" type="email" placeholder="you@studio.com" maxlength="120" autocomplete="off">
          </div>
          <div class="pfx-dp-row">
            <button id="pfxDpSaveBtn" class="pfx-dp-save-btn" type="button">Save</button>
            <span id="pfxDpStatus" class="pfx-dp-status" hidden></span>
          </div>
        </div>

        <div class="pfx-account-footer">
          <button id="pfxRefreshBtn" class="pfx-btn-ghost" type="button">↻ Refresh session</button>
          <button id="pfxSignOutBtn" class="pfx-signout-btn" type="button">Sign out</button>
        </div>
      </div>`;

    document.body.appendChild(el);

    const IS_DESKTOP = !!(window.__PFX_IS_ELECTRON || window.pfxPlatform?.isMacApp);

    el.querySelectorAll('[data-dismiss="account"]').forEach(b =>
      b.addEventListener('click', hideAccount));

    document.getElementById('pfxSignOutBtn')?.addEventListener('click', async () => {
      if (!confirm('Sign out of PostFlowX?')) return;
      if (IS_DESKTOP) {
        // Desktop: clear stored session and reload — shows login modal on next boot
        window.PFX_SESSION_STORE?.clear();
        hideAccount();
        window.location.reload();
        return;
      }
      await auth.signOut();
      hideAccount();
    });

    const refreshBtn = document.getElementById('pfxRefreshBtn');
    if (IS_DESKTOP) {
      // Refresh session makes no sense in desktop — remote auth is bypassed
      if (refreshBtn) refreshBtn.style.display = 'none';
    } else {
      refreshBtn?.addEventListener('click', async () => {
        const btn = document.getElementById('pfxRefreshBtn');
        btn.disabled = true; btn.textContent = '…';
        try {
          await auth.refreshSession();
          _populateAccount();
          btn.textContent = '✓ Refreshed';
        } catch (e) {
          btn.textContent = `Error: ${e.message}`;
        }
        setTimeout(() => { btn.disabled = false; btn.textContent = '↻ Refresh session'; }, 2000);
      });
    }

    if (IS_DESKTOP) {
      const sec = document.getElementById('pfxDesktopProfileSection');
      if (sec) sec.hidden = false;
      document.getElementById('pfxDpSaveBtn')?.addEventListener('click', () => {
        const nameVal   = document.getElementById('pfxDpName')?.value.trim()  || '';
        const emailInput = document.getElementById('pfxDpEmail');
        const emailVal   = emailInput?.value.trim() || '';
        const statusEl   = document.getElementById('pfxDpStatus');
        if (emailVal && emailInput && !emailInput.validity.valid) {
          if (statusEl) { statusEl.textContent = 'Invalid email address'; statusEl.hidden = false; }
          return;
        }
        try {
          localStorage.setItem(_PFX_DP_KEY, JSON.stringify({
            name:  nameVal  || 'PostFlowX Desktop',
            email: emailVal || 'desktop@postflowx.local',
          }));
          _populateAccount();
          _updateBadge();
          if (statusEl) { statusEl.textContent = 'Saved'; statusEl.hidden = false; setTimeout(() => { statusEl.hidden = true; }, 2000); }
        } catch {
          if (statusEl) { statusEl.textContent = 'Error saving'; statusEl.hidden = false; }
        }
      });
    }

    document.getElementById('pfxUpgradeBtn')?.addEventListener('click', () => {
      hideAccount();
      // Re-open login modal showing plan cards
      showLogin();
    });
  }

  // ── Google auth config check (Electron only) ─────────────────────────────
  // Checks whether a Google OAuth client ID is configured and updates the
  // login modal button/message accordingly. Runs async after the modal opens.
  async function _syncGoogleBtnState() {
    if (!window.__PFX_IS_ELECTRON && !window.pfxPlatform?.isMacApp) return;
    const btn   = document.getElementById('pfxGoogleBtn');
    const errEl = document.getElementById('pfxLoginError');
    if (!btn) return;
    try {
      const res = await window.pfxPlatform?.isGoogleAuthConfigured?.();
      if (res && !res.configured) {
        btn.disabled = true;
        btn.style.opacity = '0.4';
        btn.style.cursor  = 'not-allowed';
        if (errEl) {
          errEl.textContent = 'Google sign-in is not configured for this build. Contact your administrator.';
          errEl.hidden = false;
        }
      }
    } catch {}
  }

  // ── Google sign-in handler ────────────────────────────────────────────────
  async function _handleGoogleSignIn() {
    const btn = document.getElementById('pfxGoogleBtn');
    const errEl = document.getElementById('pfxLoginError');
    if (!btn) return;

    btn.disabled = true;
    btn.querySelector('.pfx-google-btn-label').textContent = 'Signing in…';
    if (errEl) errEl.hidden = true;

    try {
      if (window.__PFX_IS_ELECTRON || window.pfxPlatform?.isMacApp) {
        // Desktop: drive Google OAuth via BrowserWindow first, then call the
        // policy backend with the authenticated email.
        if (!window.pfxPlatform?.googleSignIn) {
          throw new Error('Google sign-in is not available in this build.');
        }
        btn.querySelector('.pfx-google-btn-label').textContent = 'Opening Google sign-in…';
        const oauthResult = await window.pfxPlatform.googleSignIn();
        if (!oauthResult?.ok) {
          const rawErr = oauthResult?.error || 'Google sign-in failed';
          throw new Error(rawErr === 'GOOGLE_DESKTOP_CLIENT_ID_MISSING'
            ? 'Google sign-in is not configured for this build. Contact your administrator.'
            : rawErr);
        }
        btn.querySelector('.pfx-google-btn-label').textContent = 'Verifying access…';
        // chrome.identity shim now returns the real email → auth.signInWithGoogle()
        // calls _signInWithBackendPolicy() which reads it and calls the PFX backend.
        const session = await auth.signInWithGoogle();
        // Persist session for boot-guard to read on next launch.
        if (session?.user?.email) {
          const toStore = session?.ok !== undefined ? session : {
            ok: true, role: session.role || 'admin',
            user: { email: oauthResult.email, name: oauthResult.name || oauthResult.email.split('@')[0], picture: oauthResult.picture || '' },
            permissions: session.permissions || { tabs: ['*'], actions: ['*'] },
            featureFlags: session.featureFlags || {},
            session: { token: session.session?.token || 'desktop-session', expiresAt: session.session?.expiresAt || new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString() },
          };
          window.PFX_SESSION_STORE?.save(toStore);
        }
        hideLogin();
        window.location.reload();
      } else {
        await auth.signInWithGoogle();
        hideLogin();
      }
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    } finally {
      btn.disabled = false;
      btn.querySelector('.pfx-google-btn-label').textContent = 'Continue with Google';
    }
  }

  // ── Update header badge ───────────────────────────────────────────────────
  function _updateBadge() {
    const _dp    = (window.__PFX_IS_ELECTRON || window.pfxPlatform?.isMacApp) ? (_readDesktopProfile() || {}) : null;
    const _osName = window.pfxPlatform?.osUser?.username || '';
    const pfxSess   = window.PFX_PERMISSIONS?.getSession?.() || window.PFX_AUTH?.getPfxSession?.()
      || (window.__PFX_IS_ELECTRON ? { role: 'admin', user: { name: _dp?.name || _osName || 'PostFlowX Desktop', email: _dp?.email || '' } } : null);
    const pfxUser   = pfxSess?.user || window.PFX_PERMISSIONS?.getUser?.() || null;
    const pfxRole   = pfxSess?.role || null;
    const user      = pfxUser || auth.getUser();

    // PFX role takes priority; fall back to Supabase plan display
    const ROLE_DISPLAY = {
      admin:  { label: 'ADMIN',  color: '#e50914', bg: 'rgba(229,9,20,0.12)' },
      editor: { label: 'EDITOR', color: '#22c55e', bg: 'rgba(34,197,94,0.12)' },
      qc:     { label: 'QC',     color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
      viewer: { label: 'VIEWER', color: '#6366f1', bg: 'rgba(99,102,241,0.12)' },
    };
    const display = pfxRole
      ? ROLE_DISPLAY[pfxRole] || ROLE_DISPLAY.viewer
      : auth.PLAN_DISPLAY?.[auth.getPlan()] || auth.PLAN_DISPLAY?.free || { label: 'FREE', color: '#888', bg: 'rgba(255,255,255,0.06)' };

    const avatarImg = document.getElementById('pfxUserAvatarImg');
    const iconWrap  = document.getElementById('pfxUserIconWrap');
    const chip      = document.getElementById('pfxUserPlanChip');
    const btn       = document.getElementById('pfxUserBtn');

    if (!btn) return;

    if (user) {
      const email     = pfxUser?.email || user.email || '';
      const avatarUrl = pfxUser?.picture || user.user_metadata?.avatar_url || user.user_metadata?.picture || '';
      const name      = pfxUser?.name || user.user_metadata?.full_name || email;
      const initials  = name.split(/[\s@]/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();
      if (iconWrap) iconWrap.style.display = 'none';
      _applyAvatar(avatarImg, null, avatarUrl, initials, email);
      if (chip) {
        chip.textContent      = display.label;
        chip.style.color      = display.color;
        chip.style.background = display.bg;
        chip.style.borderColor= display.color + '60';
        chip.hidden = false;
      }
      btn.title = `${email} · ${display.label}`;
    } else {
      if (avatarImg) avatarImg.style.display = 'none';
      if (iconWrap)  iconWrap.style.display = 'flex';
      if (chip)      chip.hidden = true;
      btn.title = 'Sign in';
    }
  }

  // ── Populate account modal ────────────────────────────────────────────────
  const PFX_ROLE_DISPLAY = {
    admin:  { label: 'ADMIN',  color: '#e50914', bg: 'rgba(229,9,20,0.12)' },
    editor: { label: 'EDITOR', color: '#22c55e', bg: 'rgba(34,197,94,0.12)' },
    qc:     { label: 'QC',     color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
    viewer: { label: 'VIEWER', color: '#6366f1', bg: 'rgba(99,102,241,0.12)' },
  };

  const PFX_ROLE_TABS = {
    admin:  ['Pull Prep', 'Cut Diff', 'Visual QC', 'Markers', 'Review', 'Settings'],
    editor: ['Pull Prep', 'Cut Diff', 'Visual QC', 'Markers', 'Review'],
    qc:     ['Pull Prep', 'Cut Diff', 'Visual QC'],
    viewer: ['Pull Prep', 'Cut Diff'],
  };

  function _populateAccount() {
    const _dp    = (window.__PFX_IS_ELECTRON || window.pfxPlatform?.isMacApp) ? (_readDesktopProfile() || {}) : null;
    const _osName = window.pfxPlatform?.osUser?.username || '';
    const pfxSess = window.PFX_PERMISSIONS?.getSession?.() || window.PFX_AUTH?.getPfxSession?.()
      || (window.__PFX_IS_ELECTRON ? {
          ok: true, role: 'admin',
          user: { email: _dp?.email || '', name: _dp?.name || _osName || 'PostFlowX Desktop' },
          permissions: { tabs: ['*'], actions: ['*'] },
          session: { token: 'electron-local', expiresAt: null },
        } : null);
    const pfxUser = pfxSess?.user || null;
    const pfxRole = pfxSess?.role || null;
    const user    = pfxUser || auth.getUser();
    const plan    = auth.getPlan();
    const session = auth.getSession();
    if (!user) return;

    const name     = pfxUser?.name || user.user_metadata?.full_name || user.user_metadata?.name || user.email || 'User';
    const email    = pfxUser?.email || user.email || '';
    const avatarUrl = pfxUser?.picture || user.user_metadata?.avatar_url || user.user_metadata?.picture || '';
    const initials = name.split(/[\s@]/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();

    const $ = id => document.getElementById(id);
    if ($('pfxAccName'))  $('pfxAccName').textContent  = name;
    if ($('pfxAccEmail')) $('pfxAccEmail').textContent = email;

    // Sync desktop profile editor inputs with current stored values
    if (window.__PFX_IS_ELECTRON || window.pfxPlatform?.isMacApp) {
      const dp = _readDesktopProfile() || {};
      const nameInput  = $('pfxDpName');
      const emailInput = $('pfxDpEmail');
      if (nameInput  && !nameInput.matches(':focus'))  nameInput.value  = dp.name  || window.pfxPlatform?.osUser?.username || '';
      if (emailInput && !emailInput.matches(':focus')) emailInput.value = dp.email || '';
    }

    _applyAvatar($('pfxAccAvatar'), $('pfxAccAvatarFallback'), avatarUrl, initials, email);

    // Badge — PFX role takes priority over Supabase plan
    const badge = $('pfxAccPlanBadge');
    if (badge) {
      const roleDisp = pfxRole ? PFX_ROLE_DISPLAY[pfxRole] : null;
      const planDisp = auth.PLAN_DISPLAY?.[plan] || auth.PLAN_DISPLAY?.free;
      const disp = roleDisp || planDisp || { label: plan?.toUpperCase() || 'FREE', color: '#888', bg: 'rgba(255,255,255,0.06)' };
      badge.textContent      = disp.label;
      badge.style.color      = disp.color;
      badge.style.background = disp.bg;
      badge.style.borderColor = disp.color + '80';
    }

    // Feature / access list — show PFX tabs when role is available
    const feats = $('pfxAccFeats');
    if (feats) {
      if (pfxRole) {
        const tabs = pfxSess?.permissions?.tabs;
        const tabList = (tabs && !tabs.includes('*'))
          ? tabs.map(t => t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))
          : PFX_ROLE_TABS[pfxRole] || PFX_ROLE_TABS.viewer;
        const actions = pfxSess?.permissions?.actions || [];
        const allActions = actions.includes('*');
        feats.innerHTML =
          `<div class="pfx-acc-feats-section-label">Accessible tabs</div>` +
          tabList.map(t => `<div class="pfx-acc-feat-item"><span class="pfx-acc-feat-check">✓</span>${t}</div>`).join('') +
          (allActions ? `<div class="pfx-acc-feat-item pfx-acc-feat-full"><span class="pfx-acc-feat-check">✓</span>Full access — all actions</div>` : '');
      } else {
        const FEAT_NAMES = {
          pulls_prep: 'Pulls Prep 2.0', cutdiff_basic: 'CUT DIFF (analyze)',
          cutdiff2_full: 'CUT DIFF 2.0 Full', plate_link: 'Plate Link 2.0',
          vfx_marker: 'VFX Marker Mode', smart_timeline: 'Smart Compare Timeline',
          edl_export: 'EDL / ALE export', ale_export: 'Advanced exports',
          imf_basic: 'IMF Validation', bwav_inspector: 'BWAV Inspector',
          preflight: 'Preflight', visual_qc: 'Visual QC',
        };
        const allowed = auth.PLAN_FEATURES?.[plan] || auth.PLAN_FEATURES?.free || [];
        const items = allowed.includes('*') ? Object.values(FEAT_NAMES) : allowed.map(k => FEAT_NAMES[k] || k);
        feats.innerHTML = items.map(f =>
          `<div class="pfx-acc-feat-item"><span class="pfx-acc-feat-check">✓</span>${f}</div>`
        ).join('');
      }
    }

    // Session expiry — support both Supabase (expires_at in seconds) and PFX (expiresAt ISO)
    const sessionInfo = $('pfxAccSessionInfo');
    if (sessionInfo) {
      if (window.__PFX_IS_ELECTRON || window.pfxPlatform?.isMacApp) {
        sessionInfo.textContent = 'Desktop session — permanent';
      } else {
        const pfxExp = pfxSess?.session?.expiresAt;
        const subExp = session?.expires_at;
        const exp = pfxExp ? new Date(pfxExp) : subExp ? new Date(subExp * 1000) : null;
        if (exp) {
          const diff = Math.max(0, Math.round((exp - Date.now()) / 60000));
          sessionInfo.textContent = diff > 60
            ? `Expires ${exp.toLocaleDateString()} ${exp.toLocaleTimeString()}`
            : diff > 0 ? `Expires in ${diff} min` : 'Session expired — click Refresh';
        } else {
          sessionInfo.textContent = 'Active session';
        }
      }
    }

    // Hide upgrade button entirely when user has a PFX session (access is managed by Netflix)
    const upBtn = $('pfxUpgradeBtn');
    if (upBtn) upBtn.hidden = true;
  }

  // ── Show / hide ───────────────────────────────────────────────────────────
  function _hasPfxSession() {
    return !!(window.PFX_AUTH?.getPfxSession?.() || window.PFX_PERMISSIONS?.getSession?.());
  }

  function showLogin() {
    // On Electron, if a PFX session already exists go straight to account view;
    // otherwise show the login modal so the user can sign in with Google.
    if (window.__PFX_IS_ELECTRON && _hasPfxSession()) { showAccount(); return; }
    // Suppress Supabase modal when PostFlowX RBAC session is active (non-desktop)
    if (!window.__PFX_IS_ELECTRON && _hasPfxSession()) { showAccount(); return; }
    // Reset button state in case it was disabled from a previous check.
    const btn = document.getElementById('pfxGoogleBtn');
    if (btn) { btn.disabled = false; btn.style.opacity = ''; btn.style.cursor = ''; }
    const errEl = document.getElementById('pfxLoginError');
    if (errEl) errEl.hidden = true;
    document.getElementById('pfx-login-modal').hidden = false;
    _syncGoogleBtnState();
  }
  function hideLogin()  { document.getElementById('pfx-login-modal').hidden = true; }
  function showAccount(){ _populateAccount(); document.getElementById('pfx-account-modal').hidden = false; }
  function hideAccount(){ document.getElementById('pfx-account-modal').hidden = true; }

  // ── Feature gate helper (global) ─────────────────────────────────────────
  // Other modules can call: window.pfxCanUse('cutdiff2_full') → true/false
  // Or: window.pfxRequirePlan('pro', 'CUT DIFF 2.0') — shows upgrade prompt
  window.pfxCanUse = feature => auth.canUse(feature);
  window.pfxRequirePlan = (minPlan, featureName) => {
    // When PostFlowX RBAC session is active, backend manages access — skip Supabase plan gate
    if (window.PFX_AUTH?.getPfxSession?.() || window.PFX_PERMISSIONS?.getSession?.()) return true;
    const ORDER = { free: 0, pro: 1, enterprise: 2 };
    const current = auth.getPlan();
    if ((ORDER[current] || 0) >= (ORDER[minPlan] || 0)) return true;
    showLogin();
    return false;
  };

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    _buildHeaderBadge();
    _buildLoginModal();
    _buildAccountModal();

    auth.onChange(({ event }) => {
      _updateBadge();
      if (event === 'signed_in')  hideLogin();
      if (event === 'signed_out') _updateBadge();
    });

    auth.init().then(() => _updateBadge());

    // Update badge from stored PFX session immediately (in case boot-guard already ran)
    chrome.storage.local.get('postflowxSession', (res) => {
      const s = res?.postflowxSession;
      if (s?.role && window.PFX_PERMISSIONS?.setSession) {
        window.PFX_PERMISSIONS.setSession(s);
      }
      if (s?.role) _updateBadge();
    });

    window.addEventListener('pfx:permissions-ready', () => _updateBadge(), { once: true });
  }

  // Auto-init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.PFX_USER_UI = { showLogin, hideLogin, showAccount, hideAccount };
})();
