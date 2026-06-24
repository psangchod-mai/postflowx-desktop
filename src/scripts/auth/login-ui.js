// scripts/auth/login-ui.js — PostFlowX Auth Overlay UI
// Manages login, access-denied, and session-expired screens.
// Exposed as window.PFX_LOGIN_UI (loaded before ui.js via index.html)

window.PFX_LOGIN_UI = (() => {
  'use strict';

  const OVERLAY_ID  = 'pfx-auth-overlay';
  const LANG_KEY    = 'pfxLang';
  let _signingIn    = false;

  // ── i18n ────────────────────────────────────────────────────────────────
  const LANGS = [
    { code: 'eng', label: 'ENG' },
    { code: 'th',  label: 'TH'  },
    { code: 'id',  label: 'ID'  },
    { code: 'ph',  label: 'PH'  },
    { code: 'tw',  label: 'TW'  },
    { code: 'kr',  label: 'KR'  },
    { code: 'jp',  label: 'JP'  },
  ];

  const I18N = {
    eng: {
      sub:               'Professional Post-Production Tools',
      signinBtn:         'Continue with Google',
      signingIn:         'Signing in…',
      howToGet:          'HOW TO GET ACCESS',
      managedTitle:      'Access is managed by Netflix',
      managedBody:       'PostFlowX is not publicly available. Access is provisioned exclusively through Netflix Post Production &amp; Production Solutions.',
      contactLocal:      'TO REQUEST ACCESS, CONTACT YOUR LOCAL',
      contactTeam1:      'Netflix Post Production',
      contactTeam2:      '&amp; Production Solutions team',
      contactHint:       'Your regional Netflix partner or vendor manager can submit an access request on your behalf.',
      terms:             'By signing in you agree to our <a href="#" class="pfx-auth-link">Terms of Service</a> and <a href="#" class="pfx-auth-link">Privacy Policy</a>.',
      sessionTitle:      'Session Expired',
      sessionBody:       'Your session has expired. Please sign in again.',
      signInAgain:       'Sign in again',
      deniedTitle:       'Access Denied',
      deniedBody:        'Your account does not have access to PostFlowX.',
      deniedNote:        'Contact your administrator to request access.',
      requestAccess:     'Request Access',
      signOut:           'Sign out',
      signinFail:        'Sign-in failed. Try again.',
    },
    th: {
      sub:               'เครื่องมือ Post-Production มืออาชีพ',
      signinBtn:         'ดำเนินการต่อด้วย Google',
      signingIn:         'กำลังลงชื่อเข้าใช้…',
      howToGet:          'วิธีขอสิทธิ์เข้าใช้งาน',
      managedTitle:      'สิทธิ์เข้าใช้จัดการโดย Netflix',
      managedBody:       'PostFlowX ไม่เปิดให้ใช้งานทั่วไป การเข้าถึงจัดสรรผ่าน Netflix Post Production &amp; Production Solutions เท่านั้น',
      contactLocal:      'ติดต่อทีมในพื้นที่ของคุณเพื่อขอสิทธิ์',
      contactTeam1:      'Netflix Post Production',
      contactTeam2:      '&amp; Production Solutions',
      contactHint:       'พาร์ทเนอร์หรือผู้จัดการ Vendor ของ Netflix ในภูมิภาคสามารถยื่นคำขอแทนคุณได้',
      terms:             'การลงชื่อเข้าใช้แสดงว่าคุณยอมรับ <a href="#" class="pfx-auth-link">ข้อกำหนดการให้บริการ</a> และ <a href="#" class="pfx-auth-link">นโยบายความเป็นส่วนตัว</a>',
      sessionTitle:      'เซสชันหมดอายุ',
      sessionBody:       'เซสชันของคุณหมดอายุแล้ว กรุณาลงชื่อเข้าใช้อีกครั้ง',
      signInAgain:       'ลงชื่อเข้าใช้อีกครั้ง',
      deniedTitle:       'ปฏิเสธการเข้าถึง',
      deniedBody:        'บัญชีของคุณไม่มีสิทธิ์เข้าใช้ PostFlowX',
      deniedNote:        'ติดต่อผู้ดูแลระบบเพื่อขอสิทธิ์เข้าถึง',
      requestAccess:     'ขอสิทธิ์เข้าใช้งาน',
      signOut:           'ออกจากระบบ',
      signinFail:        'ลงชื่อเข้าใช้ไม่สำเร็จ กรุณาลองอีกครั้ง',
    },
    id: {
      sub:               'Alat Post-Produksi Profesional',
      signinBtn:         'Lanjutkan dengan Google',
      signingIn:         'Masuk…',
      howToGet:          'CARA MENDAPATKAN AKSES',
      managedTitle:      'Akses dikelola oleh Netflix',
      managedBody:       'PostFlowX tidak tersedia untuk umum. Akses diberikan secara eksklusif melalui Netflix Post Production &amp; Production Solutions.',
      contactLocal:      'UNTUK MEMINTA AKSES, HUBUNGI TIM LOKAL ANDA',
      contactTeam1:      'Netflix Post Production',
      contactTeam2:      '&amp; tim Production Solutions',
      contactHint:       'Mitra atau manajer vendor Netflix regional Anda dapat mengajukan permintaan akses atas nama Anda.',
      terms:             'Dengan masuk, Anda menyetujui <a href="#" class="pfx-auth-link">Ketentuan Layanan</a> dan <a href="#" class="pfx-auth-link">Kebijakan Privasi</a> kami.',
      sessionTitle:      'Sesi Berakhir',
      sessionBody:       'Sesi Anda telah berakhir. Silakan masuk kembali.',
      signInAgain:       'Masuk kembali',
      deniedTitle:       'Akses Ditolak',
      deniedBody:        'Akun Anda tidak memiliki akses ke PostFlowX.',
      deniedNote:        'Hubungi administrator Anda untuk meminta akses.',
      requestAccess:     'Minta Akses',
      signOut:           'Keluar',
      signinFail:        'Masuk gagal. Coba lagi.',
    },
    ph: {
      sub:               'Propesyonal na Mga Kasangkapan sa Post-Production',
      signinBtn:         'Magpatuloy gamit ang Google',
      signingIn:         'Nagsa-sign in…',
      howToGet:          'PAANO MAKAKUHA NG ACCESS',
      managedTitle:      'Ang access ay pinamamahalaan ng Netflix',
      managedBody:       'Ang PostFlowX ay hindi available sa publiko. Ang access ay ibinibigay nang eksklusibo sa pamamagitan ng Netflix Post Production &amp; Production Solutions.',
      contactLocal:      'PARA HUMILING NG ACCESS, MAKIPAG-UGNAYAN SA INYONG LOKAL NA',
      contactTeam1:      'Netflix Post Production',
      contactTeam2:      '&amp; Production Solutions na Koponan',
      contactHint:       'Ang inyong rehiyonal na Netflix na kasosyo o vendor manager ay maaaring magsumite ng kahilingan para sa inyo.',
      terms:             'Sa pag-sign in, sumasang-ayon ka sa aming <a href="#" class="pfx-auth-link">Mga Tuntunin ng Serbisyo</a> at <a href="#" class="pfx-auth-link">Patakaran sa Privacy</a>.',
      sessionTitle:      'Nag-expire ang Session',
      sessionBody:       'Nag-expire na ang iyong session. Mangyaring mag-sign in muli.',
      signInAgain:       'Mag-sign in muli',
      deniedTitle:       'Tinanggihan ang Access',
      deniedBody:        'Ang iyong account ay walang access sa PostFlowX.',
      deniedNote:        'Makipag-ugnayan sa iyong administrator para humiling ng access.',
      requestAccess:     'Humiling ng Access',
      signOut:           'Mag-sign out',
      signinFail:        'Nabigo ang pag-sign in. Subukan muli.',
    },
    tw: {
      sub:               '專業後期製作工具',
      signinBtn:         '使用 Google 繼續',
      signingIn:         '登入中…',
      howToGet:          '如何取得存取權限',
      managedTitle:      '存取權限由 Netflix 管理',
      managedBody:       'PostFlowX 不對外公開。存取權限由 Netflix Post Production &amp; Production Solutions 統一分配。',
      contactLocal:      '如需申請存取，請聯絡您的當地',
      contactTeam1:      'Netflix Post Production',
      contactTeam2:      '&amp; Production Solutions 團隊',
      contactHint:       '您所在地區的 Netflix 合作夥伴或廠商經理可代您提交申請。',
      terms:             '登入即表示您同意我們的 <a href="#" class="pfx-auth-link">服務條款</a> 及 <a href="#" class="pfx-auth-link">隱私政策</a>。',
      sessionTitle:      '工作階段已到期',
      sessionBody:       '您的工作階段已到期，請重新登入。',
      signInAgain:       '重新登入',
      deniedTitle:       '存取遭拒',
      deniedBody:        '您的帳戶無權存取 PostFlowX。',
      deniedNote:        '請聯絡您的管理員申請存取權限。',
      requestAccess:     '申請存取',
      signOut:           '登出',
      signinFail:        '登入失敗，請再試一次。',
    },
    kr: {
      sub:               '전문 후반 제작 도구',
      signinBtn:         'Google로 계속하기',
      signingIn:         '로그인 중…',
      howToGet:          '액세스 방법',
      managedTitle:      '액세스는 Netflix에서 관리합니다',
      managedBody:       'PostFlowX는 일반에 공개되지 않습니다. 액세스는 Netflix Post Production &amp; Production Solutions을 통해서만 제공됩니다.',
      contactLocal:      '액세스 요청은 담당 지역 팀에 문의하세요',
      contactTeam1:      'Netflix Post Production',
      contactTeam2:      '&amp; Production Solutions 팀',
      contactHint:       '지역 Netflix 파트너 또는 벤더 매니저가 대신 요청서를 제출할 수 있습니다.',
      terms:             '로그인하면 <a href="#" class="pfx-auth-link">서비스 약관</a> 및 <a href="#" class="pfx-auth-link">개인정보 처리방침</a>에 동의하는 것입니다.',
      sessionTitle:      '세션 만료',
      sessionBody:       '세션이 만료되었습니다. 다시 로그인해 주세요.',
      signInAgain:       '다시 로그인',
      deniedTitle:       '액세스 거부',
      deniedBody:        '이 계정은 PostFlowX에 대한 액세스 권한이 없습니다.',
      deniedNote:        '관리자에게 문의하여 액세스를 요청하세요.',
      requestAccess:     '액세스 요청',
      signOut:           '로그아웃',
      signinFail:        '로그인 실패. 다시 시도해주세요.',
    },
    jp: {
      sub:               'プロフェッショナル・ポストプロダクション・ツール',
      signinBtn:         'Google で続行',
      signingIn:         'サインイン中…',
      howToGet:          'アクセス方法',
      managedTitle:      'アクセスは Netflix が管理しています',
      managedBody:       'PostFlowX は一般公開されていません。アクセスは Netflix Post Production &amp; Production Solutions を通じてのみ提供されます。',
      contactLocal:      'アクセスを申請するには、担当の地域チームに連絡してください',
      contactTeam1:      'Netflix Post Production',
      contactTeam2:      '&amp; Production Solutions チーム',
      contactHint:       '地域の Netflix パートナーまたはベンダー担当者が代わりにリクエストを提出できます。',
      terms:             'サインインすることで、<a href="#" class="pfx-auth-link">利用規約</a>および<a href="#" class="pfx-auth-link">プライバシーポリシー</a>に同意したことになります。',
      sessionTitle:      'セッション期限切れ',
      sessionBody:       'セッションの有効期限が切れました。再度サインインしてください。',
      signInAgain:       '再度サインイン',
      deniedTitle:       'アクセス拒否',
      deniedBody:        'このアカウントには PostFlowX へのアクセス権限がありません。',
      deniedNote:        'アクセスを申請するには管理者にお問い合わせください。',
      requestAccess:     'アクセスを申請',
      signOut:           'サインアウト',
      signinFail:        'サインインに失敗しました。再試行してください。',
    },
  };

  // ── Language helpers ─────────────────────────────────────────────────────
  function _getLang() {
    try { return localStorage.getItem(LANG_KEY) || 'eng'; } catch { return 'eng'; }
  }
  function _setLang(l) {
    try { localStorage.setItem(LANG_KEY, l); } catch {}
  }
  function _t(key) {
    const lang = _getLang();
    return (I18N[lang] || I18N.eng)[key] || I18N.eng[key] || '';
  }

  // ── Google SVG ───────────────────────────────────────────────────────────
  const GOOGLE_SVG = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4"/>
    <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/>
    <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z" fill="#FBBC05"/>
    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58Z" fill="#EA4335"/>
  </svg>`;

  // ── DOM helpers ──────────────────────────────────────────────────────────
  function _getOrCreate() {
    let el = document.getElementById(OVERLAY_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = OVERLAY_ID;
      el.className = 'pfx-auth-overlay';
      document.body.prepend(el);
    }
    return el;
  }

  function _logo() {
    const img = document.createElement('img');
    img.src   = 'assets/icons/pfx_logo.png';
    img.alt   = 'PostFlowX';
    img.className = 'pfx-auth-logo';
    img.onerror = () => { img.style.display = 'none'; };
    return img.outerHTML;
  }

  // ── Language picker ──────────────────────────────────────────────────────
  function _langPickerHtml() {
    const cur = _getLang();
    const pills = LANGS.map(l =>
      `<button type="button" class="pfx-lang-pill${l.code === cur ? ' is-active' : ''}" data-lang="${l.code}">${l.label}</button>`
    ).join('');
    return `<div class="pfx-lang-picker">${pills}</div>`;
  }

  function _wireLangPicker(el, reshow) {
    el.querySelectorAll('.pfx-lang-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        if (_signingIn) return;
        _setLang(btn.dataset.lang);
        reshow();
      });
    });
  }

  function _setCard(el, html) {
    el.innerHTML = `<div class="pfx-auth-card">${html}</div>`;
    el.removeAttribute('hidden');
  }

  // ── Login screen ─────────────────────────────────────────────────────────
  function showLogin(opts = {}) {
    const el = _getOrCreate();
    const extraMsg = opts.message
      ? `<p class="pfx-auth-note pfx-auth-note--warn">${opts.message}</p>` : '';

    // On Electron the button starts disabled and is only enabled after the IPC
    // config check confirms a client ID is present.  This prevents any race
    // where a fast click fires before the async check runs.
    const isElectronBuild = !!(window.__PFX_IS_ELECTRON || window.__PFX_TARGET__ === 'desktop');
    const btnDisabled = isElectronBuild ? ' disabled style="opacity:0.4;cursor:not-allowed"' : '';

    _setCard(el, `
      ${_langPickerHtml()}
      ${_logo()}
      <h1 class="pfx-auth-title">PostFlowX</h1>
      <p class="pfx-auth-sub">${_t('sub')}</p>
      ${extraMsg}
      <button id="pfx-signin-btn" class="pfx-auth-btn pfx-auth-btn--google"${btnDisabled}>
        ${GOOGLE_SVG}
        <span>${_t('signinBtn')}</span>
      </button>
      <p id="pfx-signin-err" class="pfx-auth-note pfx-auth-note--error" hidden></p>

      <div class="pfx-auth-divider"></div>
      <p class="pfx-auth-access-label">${_t('howToGet')}</p>

      <div class="pfx-auth-access-block pfx-auth-access-block--alert">
        <div class="pfx-auth-access-alert-icon">⚠</div>
        <div>
          <div class="pfx-auth-access-heading pfx-auth-access-heading--alert">${_t('managedTitle')}</div>
          <div class="pfx-auth-access-body">${_t('managedBody')}</div>
        </div>
      </div>

      <div class="pfx-auth-access-block">
        <div class="pfx-auth-access-heading">${_t('contactLocal')}</div>
        <div class="pfx-auth-access-team">
          <span>${_t('contactTeam1')}</span>
          <span class="pfx-auth-access-team-red">${_t('contactTeam2')}</span>
        </div>
        <div class="pfx-auth-access-hint">${_t('contactHint')}</div>
      </div>

      <p class="pfx-auth-footer">${_t('terms')}</p>
    `);

    _wireLangPicker(el, () => showLogin(opts));

    // On Electron: resolve config state, then either enable Google button or show
    // the "not configured" message. Also render the dev bypass button when enabled.
    if (isElectronBuild) {
      const _applyConfigState = (dbg) => {
        const configured    = !!(dbg?.configured);
        const source        = dbg?.source        || 'missing';
        const isPackaged    = !!(dbg?.isPackaged);
        const devBypass     = !!(dbg?.devBypassEnabled);
        const apiConfigured = !!(dbg?.postflowxApiConfigured);
        const health        = dbg?.backendHealth ?? null;

        const btn   = el.querySelector('#pfx-signin-btn');
        const errEl = el.querySelector('#pfx-signin-err');

        if (configured) {
          if (btn) { btn.disabled = false; btn.style.opacity = ''; btn.style.cursor = ''; }
        } else {
          if (btn) { btn.disabled = true; btn.style.opacity = '0.4'; btn.style.cursor = 'not-allowed'; }
          if (errEl) {
            const devHint = !isPackaged && source
              ? `<br><span style="font-size:10px;opacity:0.6;font-family:monospace">source: ${source}</span>`
              : '';
            errEl.innerHTML = 'Google sign-in is not configured for this build.' + devHint;
            errEl.hidden = false;
          }
        }

        // API config debug panel — only in unpackaged dev builds.
        if (!isPackaged) {
          let dbgEl = el.querySelector('#pfx-api-debug');
          if (!dbgEl) {
            dbgEl = document.createElement('div');
            dbgEl.id = 'pfx-api-debug';
            dbgEl.style.cssText = 'margin-top:6px;font-size:10px;font-family:monospace;opacity:0.6;line-height:1.7;text-align:left';
            const anchor = errEl || btn;
            if (anchor?.parentNode) anchor.parentNode.insertBefore(dbgEl, anchor.nextSibling);
          }
          const healthStr = !apiConfigured
            ? '—'
            : health == null
              ? 'checking…'
              : health.reachable
                ? `✓ HTTP ${health.status}`
                : `✗ ${health.error || 'unreachable'}`;
          dbgEl.innerHTML = [
            `<span style="color:${configured   ? '#5af' : '#f88'}">● Google OAuth client ID: ${configured   ? 'configured' : 'not set'}</span>`,
            `<span style="color:${apiConfigured ? '#5af' : '#f88'}">● Backend API URL: ${apiConfigured ? 'configured' : 'not set'}</span>`,
            `<span style="color:${health?.reachable ? '#5af' : health == null ? '#aaa' : '#f88'}">● Backend health: ${healthStr}</span>`,
          ].join('<br>');
        }

        // Dev bypass button — only shown in non-packaged builds when devAuthBypass=true.
        if (devBypass && !isPackaged) {
          const existing = el.querySelector('#pfx-devbypass-btn');
          if (!existing) {
            const bypassBtn = document.createElement('button');
            bypassBtn.id        = 'pfx-devbypass-btn';
            bypassBtn.className = 'pfx-auth-btn pfx-auth-btn--devbypass';
            bypassBtn.textContent = 'Continue in Local Dev Mode';
            bypassBtn.style.cssText = [
              'margin-top:8px',
              'background:rgba(255,200,0,0.10)',
              'border:1px dashed rgba(255,200,0,0.35)',
              'color:rgba(255,200,0,0.85)',
              'font-size:12px',
              'cursor:pointer',
            ].join(';');
            const dbgEl = el.querySelector('#pfx-api-debug');
            const anchor = dbgEl || errEl || btn;
            if (anchor?.parentNode) anchor.parentNode.insertBefore(bypassBtn, anchor.nextSibling);

            bypassBtn.addEventListener('click', async () => {
              bypassBtn.disabled = true;
              bypassBtn.textContent = 'Entering dev mode…';
              try {
                const result = await window.pfxPlatform?.devAuthBypass?.();
                if (result?.ok) {
                  // Route through signInWithGoogle so auth.js sets up the session.
                  // pfx:google-oauth also returns the dev bypass user when devAuthBypass=true.
                  await _doSignIn();
                  window.location.reload();
                } else {
                  bypassBtn.disabled   = false;
                  bypassBtn.textContent = 'Continue in Local Dev Mode';
                  if (errEl) { errEl.textContent = result?.error || 'Dev bypass unavailable.'; errEl.hidden = false; }
                }
              } catch (e) {
                bypassBtn.disabled   = false;
                bypassBtn.textContent = 'Continue in Local Dev Mode';
                if (errEl) { errEl.textContent = e.message || 'Dev bypass failed.'; errEl.hidden = false; }
              }
            });
          }
        }
      };

      window.pfxPlatform?.googleAuthDebug?.()
        .then(async dbg => {
          _applyConfigState(dbg);
          // Auto-bypass: if dev mode is active, skip user interaction entirely.
          // This is a failsafe in case boot-guard didn't catch it (e.g. packaged dir build).
          if (dbg?.devBypassEnabled && !dbg?.isPackaged) {
            try {
              await _doSignIn();
              window.location.reload();
            } catch { /* auto-bypass failed — button visible for manual click */ }
          }
        })
        .catch(() => {
          window.pfxPlatform?.isGoogleAuthConfigured?.()
            .then(res => _applyConfigState({ configured: !!(res?.configured), isPackaged: true }))
            .catch(() => { /* IPC not ready — button stays disabled, no error shown */ });
        });
    }

    el.querySelector('#pfx-signin-btn')?.addEventListener('click', async () => {
      const btn   = el.querySelector('#pfx-signin-btn');
      const errEl = el.querySelector('#pfx-signin-err');
      if (btn) { btn.disabled = true; const s = btn.querySelector('span'); if (s) s.textContent = _t('signingIn'); }
      if (errEl) errEl.hidden = true;
      _signingIn = true;
      try {
        await _doSignIn();
        window.location.reload();
      } catch (e) {
        _signingIn = false;
        if (btn) { btn.disabled = false; const s = btn.querySelector('span'); if (s) s.textContent = _t('signinBtn'); }
        if (errEl) { errEl.textContent = e.message || _t('signinFail'); errEl.hidden = false; }
      }
    });
  }

  // ── Access denied screen ─────────────────────────────────────────────────
  function showDenied(opts = {}) {
    const el = _getOrCreate();
    _setCard(el, `
      ${_langPickerHtml()}
      ${_logo()}
      <h1 class="pfx-auth-title pfx-auth-title--deny">${_t('deniedTitle')}</h1>
      <p class="pfx-auth-sub">${opts.message || _t('deniedBody')}</p>
      <p class="pfx-auth-note pfx-auth-note--warn">${_t('deniedNote')}</p>
      <button id="pfx-request-btn" class="pfx-auth-btn pfx-auth-btn--secondary">${_t('requestAccess')}</button>
      <button id="pfx-signout-btn" class="pfx-auth-btn pfx-auth-btn--ghost">${_t('signOut')}</button>
    `);
    _wireLangPicker(el, () => showDenied(opts));
    el.querySelector('#pfx-request-btn')?.addEventListener('click', _sendAccessRequest);
    el.querySelector('#pfx-signout-btn')?.addEventListener('click', async () => {
      await window.PFX_AUTH?.signOut?.();
      window.location.reload();
    });
  }

  // ── Session expired screen ───────────────────────────────────────────────
  function showExpired() {
    const el = _getOrCreate();
    _setCard(el, `
      ${_langPickerHtml()}
      ${_logo()}
      <h1 class="pfx-auth-title">${_t('sessionTitle')}</h1>
      <p class="pfx-auth-sub">${_t('sessionBody')}</p>
      <button id="pfx-resign-btn" class="pfx-auth-btn pfx-auth-btn--google">
        ${GOOGLE_SVG}
        <span>${_t('signInAgain')}</span>
      </button>
    `);
    _wireLangPicker(el, showExpired);
    el.querySelector('#pfx-resign-btn')?.addEventListener('click', async () => {
      await window.PFX_AUTH?.signOut?.();
      window.location.reload();
    });
  }

  function hide() {
    const el = document.getElementById(OVERLAY_ID);
    if (el) el.hidden = true;
  }

  // Non-blocking toast — shows briefly at bottom of card, no alert() needed
  function _showToast(msg, type = 'info') {
    const card = document.querySelector('.pfx-auth-card');
    if (!card) return;
    let toast = card.querySelector('.pfx-auth-toast');
    if (!toast) {
      toast = document.createElement('p');
      toast.className = 'pfx-auth-toast';
      card.appendChild(toast);
    }
    toast.textContent = msg;
    toast.dataset.type = type;
    toast.hidden = false;
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => { toast.hidden = true; }, 4000);
  }

  // ── Sign-in flow ─────────────────────────────────────────────────────────
  async function _doSignIn() {
    try { await window.PFX_AUTH?.ready?.(); } catch {}
    const signIn = window.PFX_AUTH?.signInWithGoogle;
    if (typeof signIn !== 'function') {
      throw new Error('Sign-in service is unavailable. Please reload PostFlowX and try again.');
    }
    return await signIn();
  }

  async function _sendAccessRequest() {
    const backendUrl = window.__PFX_BACKEND_URL || 'https://api.postflowx.com';
    const isAppsScript = backendUrl.includes('script.google.com');
    const requestUrl = isAppsScript ? `${backendUrl}?path=access/request` : `${backendUrl}/access/request`;
    const user = window.PFX_AUTH?.getUser?.();
    const info = await new Promise(resolve => {
      if (typeof chrome !== 'undefined' && chrome.identity?.getProfileUserInfo) {
        chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, r => resolve(r || {}));
      } else {
        resolve({});
      }
    });
    try {
      await fetch(requestUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: user?.email || info?.email || '',
          name:  user?.user_metadata?.full_name || user?.name || '',
        }),
      });
      _showToast('Access request sent. Your administrator will review it shortly.', 'success');
    } catch {
      _showToast('Could not send request. Please contact your administrator directly.', 'error');
    }
  }

  return { showLogin, showDenied, showExpired, hide };
})();
