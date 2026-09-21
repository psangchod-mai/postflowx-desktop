// scripts/auth/login-ui.js — PostFlowX Auth Overlay UI
// Manages login, access-denied, and session-expired screens.
// Exposed as window.PFX_LOGIN_UI (loaded before ui.js via index.html)

window.PFX_LOGIN_UI = (() => {
  'use strict';

  const OVERLAY_ID  = 'pfx-auth-overlay';
  const LANG_KEY    = 'pfxLang';
  let _signingIn    = false;
  let _focusBeforeOverlay = null;

  // ── Magic-link poll state ────────────────────────────────────────────────
  const POLL_INTERVAL_MS = 4000;        // poll every 4s
  const POLL_TIMEOUT_MS  = 5 * 60 * 1000; // give up after 5 min → offer Resend
  let _pollTimer    = null;
  let _pollDeadline = 0;
  let _pollInFlight = false;
  let _deniedPollTimer = null;
  let _recheckInFlight = false;

  function _stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    if (_deniedPollTimer) { clearInterval(_deniedPollTimer); _deniedPollTimer = null; }
    _pollInFlight = false;
    _recheckInFlight = false;
  }

  // Escape untrusted text (the user's email) before it lands in innerHTML.
  function _escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ── i18n ────────────────────────────────────────────────────────────────
  const LANGS = [
    { code: 'eng', label: 'ENG', name: 'English' },
    { code: 'th',  label: 'TH',  name: 'ไทย' },
    { code: 'id',  label: 'ID',  name: 'Bahasa Indonesia' },
    { code: 'ph',  label: 'PH',  name: 'Filipino' },
    { code: 'tw',  label: 'TW',  name: '繁體中文' },
    { code: 'kr',  label: 'KR',  name: '한국어' },
    { code: 'jp',  label: 'JP',  name: '日本語' },
  ];

  const HTML_LANG = Object.freeze({
    eng: 'en',
    th: 'th',
    id: 'id',
    ph: 'fil',
    tw: 'zh-Hant',
    kr: 'ko',
    jp: 'ja',
  });

  const I18N = {
    eng: {
      sub:               'Professional Post-Production Tools',
      signinBtn:         'Continue with Google',
      signingIn:         'Signing in…',
      enterpriseSigninBtn: 'Continue with Netflix',
      enterpriseMethod:  'Netflix / Partner',
      enterpriseIntro:   'Netflix employees and approved partners sign in securely through Meechum.',
      // Email magic-link (primary sign-in). Other languages fall back to eng via _t().
      chooseMethod:      'Choose how to sign in',
      methodEmail:       'Email link',
      methodGoogle:      'Google',
      recommended:       'Recommended',
      emailIntro:        "We'll email you a secure sign-in link — no password needed.",
      step1:             'Enter your work email and request a link.',
      step2:             'Open the link from that email on this device.',
      step3:             'Type the 6-digit code it shows to finish.',
      emailLabel:        'Email address',
      enterEmail:        'Please enter your email address.',
      emailPlaceholder:  'you@studio.com',
      emailLinkBtn:      'Email me a sign-in link',
      sendingLink:       'Sending…',
      googleIntro:       'Use your managed Google account. Requires an approved OAuth client.',
      advancedToggle:    'Advanced sign-in options',
      checkEmailTitle:   'Check your email',
      checkEmailBody:    'We sent a sign-in link to',
      checkEmailBody2:   'Open it on this device, then return here — you will be signed in automatically.',
      waitingHint:       'Check your email and click the link…',
      codePrompt:        'Enter the code shown on the confirmation page',
      codePlaceholder:   '123456',
      verifyBtn:         'Verify',
      verifyingBtn:      'Verifying…',
      badCodeMsg:        'Incorrect code, try again.',
      enterCode:         'Enter the 6-digit code shown on the confirmation page.',
      tooManyAttempts:   'Too many incorrect attempts. Request a new link below.',
      resendBtn:         'Resend link',
      cancelBtn:         'Cancel',
      linkExpired:       'That sign-in link expired. Request a new one below.',
      linkTimeout:       'Still waiting. If you did not get the email, request a new link.',
      pendingMsg:        'Your account is registered, but access is still pending approval.',
      disabledMsg:       'Your PostFlowX access is currently disabled.',
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
      checkAgain:        'Check access again',
      checkingAccess:    'Checking access…',
      accessRestored:    'Access approved. Opening PostFlowX…',
      accessUnchanged:   'Access is not approved yet. PostFlowX will keep checking.',
      recheckFailed:     'Could not check access right now. PostFlowX will try again.',
      requestAccess:     'Request Access',
      signOut:           'Sign out',
      signinFail:        'Sign-in failed. Try again.',
      authUnavailable:   'The sign-in service is unavailable. Restart PostFlowX and try again.',
      authNotConfigured: 'Netflix sign-in is not configured for this build.',
      requestSent:       'Access request sent. Your administrator will review it shortly.',
      requestFailed:     'Could not send the request. Please contact your administrator directly.',
      languageLabel:     'Language',
    },
    th: {
      sub:               'เครื่องมือ Post-Production มืออาชีพ',
      signinBtn:         'ดำเนินการต่อด้วย Google',
      signingIn:         'กำลังลงชื่อเข้าใช้…',
      enterpriseSigninBtn: 'ดำเนินการต่อด้วย Netflix',
      enterpriseMethod:  'Netflix / พาร์ทเนอร์',
      enterpriseIntro:   'พนักงาน Netflix และพาร์ทเนอร์ที่ได้รับอนุมัติลงชื่อเข้าใช้อย่างปลอดภัยผ่าน Meechum',
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
      checkAgain:        'ตรวจสอบสิทธิ์อีกครั้ง',
      checkingAccess:    'กำลังตรวจสอบสิทธิ์…',
      accessRestored:    'อนุมัติสิทธิ์แล้ว กำลังเปิด PostFlowX…',
      accessUnchanged:   'ยังไม่ได้รับการอนุมัติ PostFlowX จะตรวจสอบให้อัตโนมัติ',
      recheckFailed:     'ตรวจสอบสิทธิ์ไม่ได้ในขณะนี้ PostFlowX จะลองใหม่อีกครั้ง',
      requestAccess:     'ขอสิทธิ์เข้าใช้งาน',
      signOut:           'ออกจากระบบ',
      signinFail:        'ลงชื่อเข้าใช้ไม่สำเร็จ กรุณาลองอีกครั้ง',
      authUnavailable:   'บริการลงชื่อเข้าใช้ยังไม่พร้อม กรุณาเปิด PostFlowX ใหม่แล้วลองอีกครั้ง',
      authNotConfigured: 'ยังไม่ได้ตั้งค่าการลงชื่อเข้าใช้ Netflix สำหรับ build นี้',
      requestSent:       'ส่งคำขอสิทธิ์แล้ว ผู้ดูแลระบบจะตรวจสอบในเร็วๆ นี้',
      requestFailed:     'ส่งคำขอไม่ได้ กรุณาติดต่อผู้ดูแลระบบโดยตรง',
      languageLabel:     'ภาษา',
    },
    id: {
      sub:               'Alat Post-Produksi Profesional',
      signinBtn:         'Lanjutkan dengan Google',
      signingIn:         'Masuk…',
      enterpriseSigninBtn: 'Lanjutkan dengan Netflix',
      enterpriseMethod:  'Netflix / Mitra',
      enterpriseIntro:   'Karyawan Netflix dan mitra yang disetujui masuk dengan aman melalui Meechum.',
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
      checkAgain:        'Periksa akses lagi',
      checkingAccess:    'Memeriksa akses…',
      accessRestored:    'Akses disetujui. Membuka PostFlowX…',
      accessUnchanged:   'Akses belum disetujui. PostFlowX akan terus memeriksa.',
      recheckFailed:     'Akses belum dapat diperiksa. PostFlowX akan mencoba lagi.',
      requestAccess:     'Minta Akses',
      signOut:           'Keluar',
      signinFail:        'Masuk gagal. Coba lagi.',
      authUnavailable:   'Layanan masuk belum tersedia. Mulai ulang PostFlowX lalu coba lagi.',
      authNotConfigured: 'Masuk dengan Netflix belum dikonfigurasi untuk build ini.',
      requestSent:       'Permintaan akses terkirim. Administrator Anda akan segera meninjaunya.',
      requestFailed:     'Permintaan tidak dapat dikirim. Hubungi administrator Anda secara langsung.',
      languageLabel:     'Bahasa',
    },
    ph: {
      sub:               'Propesyonal na Mga Kasangkapan sa Post-Production',
      signinBtn:         'Magpatuloy gamit ang Google',
      signingIn:         'Nagsa-sign in…',
      enterpriseSigninBtn: 'Magpatuloy gamit ang Netflix',
      enterpriseMethod:  'Netflix / Partner',
      enterpriseIntro:   'Ligtas na mag-sign in sa Meechum ang mga empleyado ng Netflix at aprubadong partner.',
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
      checkAgain:        'Suriin muli ang access',
      checkingAccess:    'Sinusuri ang access…',
      accessRestored:    'Naaprubahan ang access. Binubuksan ang PostFlowX…',
      accessUnchanged:   'Hindi pa aprubado ang access. Patuloy itong susuriin ng PostFlowX.',
      recheckFailed:     'Hindi masuri ang access ngayon. Susubukan muli ng PostFlowX.',
      requestAccess:     'Humiling ng Access',
      signOut:           'Mag-sign out',
      signinFail:        'Nabigo ang pag-sign in. Subukan muli.',
      authUnavailable:   'Hindi available ang sign-in service. I-restart ang PostFlowX at subukan muli.',
      authNotConfigured: 'Hindi pa naka-configure ang Netflix sign-in para sa build na ito.',
      requestSent:       'Naipadala ang access request. Susuriin ito ng administrator sa lalong madaling panahon.',
      requestFailed:     'Hindi maipadala ang request. Direktang makipag-ugnayan sa administrator.',
      languageLabel:     'Wika',
    },
    tw: {
      sub:               '專業後期製作工具',
      signinBtn:         '使用 Google 繼續',
      signingIn:         '登入中…',
      enterpriseSigninBtn: '使用 Netflix 繼續',
      enterpriseMethod:  'Netflix / 合作夥伴',
      enterpriseIntro:   'Netflix 員工與獲准合作夥伴可透過 Meechum 安全登入。',
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
      checkAgain:        '重新檢查存取權限',
      checkingAccess:    '正在檢查存取權限…',
      accessRestored:    '存取已核准，正在開啟 PostFlowX…',
      accessUnchanged:   '存取尚未核准，PostFlowX 將持續自動檢查。',
      recheckFailed:     '目前無法檢查存取權限，PostFlowX 將再試一次。',
      requestAccess:     '申請存取',
      signOut:           '登出',
      signinFail:        '登入失敗，請再試一次。',
      authUnavailable:   '登入服務目前無法使用。請重新啟動 PostFlowX 後再試。',
      authNotConfigured: '此 build 尚未設定 Netflix 登入。',
      requestSent:       '存取申請已送出，管理員將儘快審核。',
      requestFailed:     '無法送出申請，請直接聯絡管理員。',
      languageLabel:     '語言',
    },
    kr: {
      sub:               '전문 후반 제작 도구',
      signinBtn:         'Google로 계속하기',
      signingIn:         '로그인 중…',
      enterpriseSigninBtn: 'Netflix로 계속하기',
      enterpriseMethod:  'Netflix / 파트너',
      enterpriseIntro:   'Netflix 직원과 승인된 파트너는 Meechum을 통해 안전하게 로그인합니다.',
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
      checkAgain:        '액세스 다시 확인',
      checkingAccess:    '액세스 확인 중…',
      accessRestored:    '액세스가 승인되었습니다. PostFlowX를 여는 중…',
      accessUnchanged:   '아직 승인되지 않았습니다. PostFlowX가 계속 확인합니다.',
      recheckFailed:     '지금 액세스를 확인할 수 없습니다. PostFlowX가 다시 시도합니다.',
      requestAccess:     '액세스 요청',
      signOut:           '로그아웃',
      signinFail:        '로그인 실패. 다시 시도해주세요.',
      authUnavailable:   '로그인 서비스를 사용할 수 없습니다. PostFlowX를 다시 시작한 후 재시도하세요.',
      authNotConfigured: '이 build에 Netflix 로그인이 설정되지 않았습니다.',
      requestSent:       '액세스 요청을 보냈습니다. 관리자가 곧 검토합니다.',
      requestFailed:     '요청을 보낼 수 없습니다. 관리자에게 직접 문의하세요.',
      languageLabel:     '언어',
    },
    jp: {
      sub:               'プロフェッショナル・ポストプロダクション・ツール',
      signinBtn:         'Google で続行',
      signingIn:         'サインイン中…',
      enterpriseSigninBtn: 'Netflix で続行',
      enterpriseMethod:  'Netflix / パートナー',
      enterpriseIntro:   'Netflix 社員および承認済みパートナーは Meechum を通じて安全にサインインします。',
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
      checkAgain:        'アクセスを再確認',
      checkingAccess:    'アクセスを確認中…',
      accessRestored:    'アクセスが承認されました。PostFlowX を開いています…',
      accessUnchanged:   'まだ承認されていません。PostFlowX が引き続き確認します。',
      recheckFailed:     '現在アクセスを確認できません。PostFlowX が再試行します。',
      requestAccess:     'アクセスを申請',
      signOut:           'サインアウト',
      signinFail:        'サインインに失敗しました。再試行してください。',
      authUnavailable:   'サインインサービスを利用できません。PostFlowX を再起動して再試行してください。',
      authNotConfigured: 'この build には Netflix サインインが設定されていません。',
      requestSent:       'アクセス申請を送信しました。管理者がまもなく確認します。',
      requestFailed:     '申請を送信できません。管理者に直接お問い合わせください。',
      languageLabel:     '言語',
    },
  };

  // ── Language helpers ─────────────────────────────────────────────────────
  function _getLang() {
    try { return localStorage.getItem(LANG_KEY) || 'eng'; } catch { return 'eng'; }
  }
  function _syncDocumentLang(lang = _getLang()) {
    const root = document.documentElement;
    if (root) root.lang = HTML_LANG[lang] || HTML_LANG.eng;
  }
  function _setLang(l) {
    try { localStorage.setItem(LANG_KEY, l); } catch {}
    _syncDocumentLang(l);
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

  const ENTERPRISE_SVG = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="1" y="1" width="16" height="16" rx="4" fill="#E50914"/>
    <path d="M5.25 3.5h2.7l4.8 11H10.1l-4.85-11Zm0 0H7.9v11H5.25v-11Zm4.8 0h2.7v11h-2.7v-11Z" fill="#fff"/>
  </svg>`;

  // ── DOM helpers ──────────────────────────────────────────────────────────
  function _setAuthState(state) {
    const root = document.documentElement;
    if (root) {
      root.dataset.pfxAuthState = state;
      _syncDocumentLang();
    }
  }

  function _getOrCreate() {
    let el = document.getElementById(OVERLAY_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = OVERLAY_ID;
      el.className = 'pfx-auth-overlay';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.addEventListener('keydown', _trapOverlayFocus);
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
      `<button type="button" class="pfx-lang-pill${l.code === cur ? ' is-active' : ''}" data-lang="${l.code}" aria-label="${l.name}" aria-pressed="${l.code === cur ? 'true' : 'false'}">${l.label}</button>`
    ).join('');
    return `<div class="pfx-lang-picker" role="group" aria-label="${_t('languageLabel')}">${pills}</div>`;
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
    const active = document.activeElement;
    if (active && active !== document.body && !el.contains(active)) _focusBeforeOverlay = active;
    el.innerHTML = `<div class="pfx-auth-card">${html}</div>`;
    el.removeAttribute('hidden');
    const heading = el.querySelector('h1');
    if (heading) {
      heading.id = 'pfx-auth-heading';
      heading.tabIndex = -1;
      el.setAttribute('aria-labelledby', heading.id);
      setTimeout(() => heading.focus({ preventScroll: true }), 0);
    }
  }

  function _trapOverlayFocus(ev) {
    if (ev.key !== 'Tab') return;
    const el = ev.currentTarget;
    const focusable = Array.from(el.querySelectorAll(
      'button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), [href], [tabindex]:not([tabindex="-1"])'
    )).filter(node => node.getAttribute('aria-hidden') !== 'true');
    if (!focusable.length) { ev.preventDefault(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!el.contains(document.activeElement)) {
      ev.preventDefault();
      (ev.shiftKey ? last : first).focus();
    } else if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  }

  // ── Boot policy check ───────────────────────────────────────────────────
  // Keep the protected workspace closed while giving the user immediate,
  // honest feedback during a slow Apps Script / enterprise policy check.
  function showChecking() {
    _stopPolling();
    _setAuthState('checking');
    const el = _getOrCreate();
    _setCard(el, `
      ${_langPickerHtml()}
      ${_logo()}
      <div class="pfx-auth-spinner" aria-hidden="true"></div>
      <h1 class="pfx-auth-title">PostFlowX</h1>
      <p class="pfx-auth-sub" role="status" aria-live="polite">${_t('checkingAccess')}</p>
    `);
    _wireLangPicker(el, showChecking);
  }

  // ── Login screen ─────────────────────────────────────────────────────────
  function showLogin(opts = {}) {
    _stopPolling();
    _setAuthState('login');
    const el = _getOrCreate();
    const extraMsg = opts.message
      ? `<p class="pfx-auth-note pfx-auth-note--warn">${_escHtml(opts.message)}</p>` : '';

    // On Electron the enterprise button starts disabled and is only enabled after
    // the IPC config check confirms an Edward/Meechum client is present.
    const isElectronBuild = !!(window.__PFX_IS_ELECTRON || window.__PFX_TARGET__ === 'desktop');
    const btnDisabled = isElectronBuild ? ' disabled style="opacity:0.4;cursor:not-allowed"' : '';
    const federatedMethod = isElectronBuild ? _t('enterpriseMethod') : _t('methodGoogle');
    const federatedIntro = isElectronBuild ? _t('enterpriseIntro') : _t('googleIntro');
    const federatedButton = isElectronBuild ? _t('enterpriseSigninBtn') : _t('signinBtn');
    const federatedIcon = isElectronBuild ? ENTERPRISE_SVG : GOOGLE_SVG;

    _setCard(el, `
      ${_langPickerHtml()}
      ${_logo()}
      <h1 class="pfx-auth-title">PostFlowX</h1>
      <p class="pfx-auth-sub">${_t('sub')}</p>
      ${extraMsg}

      <div id="pfx-panel-google" class="pfx-auth-panel pfx-auth-panel--solo">
        <p class="pfx-auth-sub pfx-auth-panel-intro">${federatedIntro}</p>
        <button id="pfx-signin-btn" class="pfx-auth-btn pfx-auth-btn--google"${btnDisabled}>
          ${federatedIcon}
          <span>${federatedButton}</span>
        </button>
        <p id="pfx-signin-err" class="pfx-auth-note pfx-auth-note--error" hidden></p>
      </div>

      <!-- Always-visible slot for the Local Dev Mode entry (populated when dev bypass is enabled). -->
      <div id="pfx-devmode-slot" style="width:100%"></div>

      <div class="pfx-auth-divider"></div>

      <div class="pfx-auth-explainer">
        <div class="pfx-auth-explainer-title">${_t('managedTitle')}</div>
        <p class="pfx-auth-explainer-body">${_t('managedBody')}</p>
        <p class="pfx-auth-explainer-body">${_t('contactHint')}</p>
      </div>

      <p class="pfx-auth-footer">${_t('terms')}</p>
    `);

    _wireLangPicker(el, () => showLogin(opts));

    // Sign-in is Netflix / Partner (Meechum) only — no email-link or method toggle.

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
              ? `<br><span style="font-size:10px;opacity:0.6;font-family:monospace">source: ${_escHtml(source)}</span>`
              : '';
            errEl.innerHTML = _t('authNotConfigured') + devHint;
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
            `<span style="color:${configured   ? '#5af' : '#f88'}">● Meechum OAuth client: ${configured   ? 'configured' : 'not set'}</span>`,
            `<span style="color:${apiConfigured ? '#5af' : '#f88'}">● Backend API URL: ${apiConfigured ? 'configured' : 'not set'}</span>`,
            `<span style="color:${health?.reachable ? '#5af' : health == null ? '#aaa' : '#f88'}">● Backend health: ${_escHtml(healthStr)}</span>`,
          ].join('<br>');
        }

        // Local Dev Mode entry — shown whenever dev auth bypass is enabled in the
        // runtime config. This is config-gated server-side (the pfx:dev-auth-bypass
        // IPC returns DEV_AUTH_BYPASS_DISABLED unless enabled, and CI writes
        // devAuthBypass:false into packaged builds), so surfacing it regardless of
        // isPackaged cannot unlock production — it just guarantees a working sign-in
        // on machines where an admin has explicitly enabled it.
        const slot = el.querySelector('#pfx-devmode-slot');
        if (devBypass && slot && !slot.querySelector('#pfx-devbypass-btn')) {
          const bypassBtn = document.createElement('button');
          bypassBtn.id        = 'pfx-devbypass-btn';
          bypassBtn.className = 'pfx-auth-btn pfx-auth-btn--devbypass';
          bypassBtn.textContent = 'Continue in Local Dev Mode';
          bypassBtn.style.cssText = [
            'margin-top:12px',
            'background:rgba(255,200,0,0.10)',
            'border:1px dashed rgba(255,200,0,0.35)',
            'color:rgba(255,200,0,0.90)',
            'font-size:13px',
            'font-weight:600',
            'cursor:pointer',
          ].join(';');
          const bypassErr = document.createElement('p');
          bypassErr.id = 'pfx-devbypass-err';
          bypassErr.className = 'pfx-auth-note pfx-auth-note--error';
          bypassErr.hidden = true;
          slot.appendChild(bypassBtn);
          slot.appendChild(bypassErr);

          bypassBtn.addEventListener('click', async () => {
            bypassBtn.disabled = true;
            bypassBtn.textContent = 'Entering dev mode…';
            bypassErr.hidden = true;
            _signingIn = true;
            try {
              const result = await window.pfxPlatform?.devAuthBypass?.();
              if (result?.ok) {
                // Route through signInWithGoogle so auth.js sets up the session.
                // pfx:google-oauth also returns the dev bypass user when devAuthBypass=true.
                await _doSignIn();
                window.location.reload();
              } else {
                _signingIn = false;
                bypassBtn.disabled   = false;
                bypassBtn.textContent = 'Continue in Local Dev Mode';
                bypassErr.textContent = result?.error === 'DEV_AUTH_BYPASS_DISABLED'
                  ? 'Local Dev Mode is disabled in this build.'
                  : (result?.error || 'Dev bypass unavailable.');
                bypassErr.hidden = false;
              }
            } catch (e) {
              _signingIn = false;
              bypassBtn.disabled   = false;
              bypassBtn.textContent = 'Continue in Local Dev Mode';
              bypassErr.textContent = e.message || 'Dev bypass failed.';
              bypassErr.hidden = false;
            }
          });
        }
      };

      const debugPromise = window.pfxPlatform?.enterpriseAuthDebug?.()
        || window.pfxPlatform?.googleAuthDebug?.()
        || Promise.reject(new Error('Auth debug unavailable'));
      debugPromise
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
          const configuredPromise = window.pfxPlatform?.isEnterpriseAuthConfigured?.()
            || window.pfxPlatform?.isGoogleAuthConfigured?.()
            || Promise.reject(new Error('Auth configuration unavailable'));
          configuredPromise
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
        if (btn) { btn.disabled = false; const s = btn.querySelector('span'); if (s) s.textContent = federatedButton; }
        if (errEl) { errEl.textContent = e.message || _t('signinFail'); errEl.hidden = false; }
      }
    });
  }

  // Reveal the 6-digit code entry once the clicker has confirmed the link
  // (checkLink → needsCode). Idempotent: safe to call on every poll tick.
  function _enterCodeMode(el) {
    if (!el) return;
    const block = el.querySelector('#pfx-code-block');
    const hint  = el.querySelector('#pfx-wait-hint');
    if (hint) hint.textContent = _t('codePrompt');
    if (block && block.hidden) {
      block.hidden = false;
      const inp = el.querySelector('#pfx-code-input');
      if (inp) { try { inp.focus(); } catch {} }
    }
  }

  // ── Magic-link "check your email" waiting screen ──────────────────────────
  function _showEmailWaiting(email, pollId, note = '') {
    _stopPolling();
    const el = _getOrCreate();
    const noteHtml = note
      ? `<p class="pfx-auth-note pfx-auth-note--warn">${note}</p>` : '';
    _setCard(el, `
      ${_langPickerHtml()}
      ${_logo()}
      <h1 class="pfx-auth-title">${_t('checkEmailTitle')}</h1>
      <p class="pfx-auth-sub">${_t('checkEmailBody')} <strong>${_escHtml(email)}</strong>.</p>
      <p class="pfx-auth-note">${_t('checkEmailBody2')}</p>
      ${noteHtml}
      <p id="pfx-wait-hint" class="pfx-auth-note pfx-auth-note--waiting">${_t('waitingHint')}</p>
      <div id="pfx-code-block" hidden style="margin:6px 0 4px">
        <input id="pfx-code-input" type="text" inputmode="numeric" autocomplete="one-time-code"
          maxlength="6" pattern="[0-9]*" placeholder="${_t('codePlaceholder')}"
          style="width:100%;box-sizing:border-box;padding:11px 12px;margin-bottom:10px;text-align:center;letter-spacing:0.35em;font-size:20px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.05);color:inherit" />
        <button id="pfx-verify-btn" class="pfx-auth-btn pfx-auth-btn--google"><span>${_t('verifyBtn')}</span></button>
      </div>
      <button id="pfx-resend-link-btn" class="pfx-auth-btn pfx-auth-btn--secondary">${_t('resendBtn')}</button>
      <button id="pfx-cancel-link-btn" class="pfx-auth-btn pfx-auth-btn--ghost">${_t('cancelBtn')}</button>
      <p id="pfx-email-err" class="pfx-auth-note pfx-auth-note--error" hidden></p>
    `);
    _wireLangPicker(el, () => _showEmailWaiting(email, pollId, note));

    // ── Verify (submit the 6-digit code) ────────────────────────────────────
    // The background poll runs WITHOUT a code (so it never burns the 5-attempt
    // budget); the code is only submitted here, on an explicit Verify.
    // Client-side attempt cap: defense-in-depth alongside whatever the backend
    // enforces server-side (unauditable from here) — stops unlimited retries
    // even if the server-side cap is ever loosened or missed.
    const MAX_CODE_ATTEMPTS = 5;
    let _codeAttempts = 0;
    const _lockOutCode = () => {
      const codeInput = el.querySelector('#pfx-code-input');
      const vbtn      = el.querySelector('#pfx-verify-btn');
      const errEl     = el.querySelector('#pfx-email-err');
      if (codeInput) codeInput.disabled = true;
      if (vbtn) vbtn.disabled = true;
      if (errEl) { errEl.textContent = _t('tooManyAttempts'); errEl.hidden = false; }
    };
    const _submitCode = async () => {
      const codeInput = el.querySelector('#pfx-code-input');
      const vbtn      = el.querySelector('#pfx-verify-btn');
      const errEl     = el.querySelector('#pfx-email-err');
      if (_codeAttempts >= MAX_CODE_ATTEMPTS) { _lockOutCode(); return; }
      const code = String(codeInput?.value || '').trim();
      if (errEl) errEl.hidden = true;
      if (!/^\d{6}$/.test(code)) {
        if (errEl) { errEl.textContent = _t('enterCode'); errEl.hidden = false; }
        codeInput?.focus();
        return;
      }
      if (vbtn) { vbtn.disabled = true; const s = vbtn.querySelector('span'); if (s) s.textContent = _t('verifyingBtn'); }
      let r;
      try { r = await window.PFX_AUTH?.pollEmailLink?.(pollId, email, code); }
      catch { r = { state: 'error' }; }
      if (vbtn) { vbtn.disabled = false; const s = vbtn.querySelector('span'); if (s) s.textContent = _t('verifyBtn'); }
      switch (r?.state) {
        case 'active':
          _stopPolling();
          window.location.reload();
          break;
        case 'needsCode':
          _codeAttempts += 1;
          if (_codeAttempts >= MAX_CODE_ATTEMPTS) { _lockOutCode(); break; }
          if (errEl) { errEl.textContent = r.badCode ? _t('badCodeMsg') : _t('enterCode'); errEl.hidden = false; }
          codeInput?.select?.();
          break;
        case 'pending':
          _stopPolling();
          showDenied({ message: _t('pendingMsg') });
          break;
        case 'disabled':
          _stopPolling();
          showDenied({ message: _t('disabledMsg') });
          break;
        case 'expired':
          _stopPolling();
          _showEmailWaiting(email, pollId, _t('linkExpired'));
          break;
        default: // transient/network — let the user retry
          if (errEl) { errEl.textContent = _t('signinFail'); errEl.hidden = false; }
          break;
      }
    };
    el.querySelector('#pfx-verify-btn')?.addEventListener('click', _submitCode);
    el.querySelector('#pfx-code-input')?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); _submitCode(); }
    });

    el.querySelector('#pfx-resend-link-btn')?.addEventListener('click', async () => {
      _stopPolling();
      const rb    = el.querySelector('#pfx-resend-link-btn');
      const errEl = el.querySelector('#pfx-email-err');
      if (errEl) errEl.hidden = true;
      if (rb) { rb.disabled = true; rb.textContent = _t('sendingLink'); }
      try {
        const r = await window.PFX_AUTH?.signInWithEmailLink?.(email);
        if (!r?.ok || !r.pollId) throw new Error(_t('signinFail'));
        _showEmailWaiting(r.email, r.pollId);
      } catch (e) {
        if (rb) { rb.disabled = false; rb.textContent = _t('resendBtn'); }
        if (errEl) { errEl.textContent = e.message || _t('signinFail'); errEl.hidden = false; }
      }
    });
    el.querySelector('#pfx-cancel-link-btn')?.addEventListener('click', () => {
      _stopPolling();
      showLogin();
    });

    _startPolling(email, pollId);
  }

  // Drive the confirmation poll. The caller owns nothing — this manages the
  // interval, the 5-minute timeout, overlap guarding, and transient failures.
  function _startPolling(email, pollId) {
    _stopPolling();
    _pollDeadline = Date.now() + POLL_TIMEOUT_MS;

    const tick = async () => {
      if (_pollInFlight) return;             // don't overlap a slow poll
      if (Date.now() > _pollDeadline) {
        _stopPolling();
        _showEmailWaiting(email, pollId, _t('linkTimeout'));
        return;
      }
      _pollInFlight = true;
      let r;
      // Background poll carries NO code — it only detects the confirmed→needsCode
      // transition. The code is submitted separately via the Verify button so a
      // wrong code never burns the server-side attempt budget on autopilot.
      try { r = await window.PFX_AUTH?.pollEmailLink?.(pollId, email); }
      catch { r = { state: 'error' }; }
      _pollInFlight = false;
      if (!_pollTimer) return;               // cancelled while awaiting

      switch (r?.state) {
        case 'active':
          _stopPolling();
          window.location.reload();
          break;
        case 'needsCode':
          // Clicker confirmed the link — reveal the code entry, keep polling for
          // expiry. (Session is only minted once the user submits the code.)
          _enterCodeMode(document.getElementById(OVERLAY_ID));
          break;
        case 'pending':
          _stopPolling();
          showDenied({ message: _t('pendingMsg') });
          break;
        case 'disabled':
          _stopPolling();
          showDenied({ message: _t('disabledMsg') });
          break;
        case 'expired':
          _stopPolling();
          _showEmailWaiting(email, pollId, _t('linkExpired'));
          break;
        // 'waiting' and 'error' → keep polling (network blips must not lock out)
        default:
          break;
      }
    };

    _pollTimer = setInterval(tick, POLL_INTERVAL_MS);
    tick(); // fire an immediate first poll
  }

  async function _checkAccessAgain(silent = false) {
    if (_recheckInFlight) return;
    _recheckInFlight = true;
    const button = document.getElementById('pfx-recheck-btn');
    const originalLabel = button?.textContent || _t('checkAgain');
    if (button) {
      button.disabled = true;
      button.textContent = _t('checkingAccess');
    }

    try {
      const result = await window.PFX_AUTH?.recheckAccess?.();
      if (result?.state === 'active') {
        _stopPolling();
        _showToast(_t('accessRestored'), 'success');
        setTimeout(() => window.location.reload(), 350);
        return;
      }
      if (!silent) {
        _showToast(
          result?.state === 'needs_sign_in' || result?.state === 'expired'
            ? _t('sessionBody')
            : result?.state === 'pending' || result?.state === 'disabled'
              ? _t('accessUnchanged')
              : _t('recheckFailed'),
          result?.state === 'pending' || result?.state === 'disabled' ? 'info' : 'error'
        );
      }
    } catch {
      if (!silent) _showToast(_t('recheckFailed'), 'error');
    } finally {
      _recheckInFlight = false;
      const currentButton = document.getElementById('pfx-recheck-btn');
      if (currentButton) {
        currentButton.disabled = false;
        currentButton.textContent = originalLabel;
      }
    }
  }

  function _startDeniedRecheckPolling() {
    if (_deniedPollTimer) clearInterval(_deniedPollTimer);
    _deniedPollTimer = setInterval(() => _checkAccessAgain(true), 20 * 1000);
  }

  // ── Access denied screen ─────────────────────────────────────────────────
  function showDenied(opts = {}) {
    _stopPolling();
    _setAuthState('denied');
    const el = _getOrCreate();
    _setCard(el, `
      ${_langPickerHtml()}
      ${_logo()}
      <h1 class="pfx-auth-title pfx-auth-title--deny">${_t('deniedTitle')}</h1>
      <p class="pfx-auth-sub">${_escHtml(opts.message || _t('deniedBody'))}</p>
      <p class="pfx-auth-note pfx-auth-note--warn">${_t('deniedNote')}</p>
      <button id="pfx-recheck-btn" class="pfx-auth-btn pfx-auth-btn--primary">${_t('checkAgain')}</button>
      <button id="pfx-request-btn" class="pfx-auth-btn pfx-auth-btn--secondary">${_t('requestAccess')}</button>
      <button id="pfx-signout-btn" class="pfx-auth-btn pfx-auth-btn--ghost">${_t('signOut')}</button>
    `);
    _wireLangPicker(el, () => showDenied(opts));
    el.querySelector('#pfx-recheck-btn')?.addEventListener('click', () => _checkAccessAgain(false));
    el.querySelector('#pfx-request-btn')?.addEventListener('click', _sendAccessRequest);
    el.querySelector('#pfx-signout-btn')?.addEventListener('click', async () => {
      await window.PFX_AUTH?.signOut?.();
      window.location.reload();
    });
    _startDeniedRecheckPolling();
  }

  // ── Session expired screen ───────────────────────────────────────────────
  function showExpired() {
    _stopPolling();
    _setAuthState('expired');
    const el = _getOrCreate();
    _setCard(el, `
      ${_langPickerHtml()}
      ${_logo()}
      <h1 class="pfx-auth-title">${_t('sessionTitle')}</h1>
      <p class="pfx-auth-sub">${_t('sessionBody')}</p>
      <button id="pfx-resign-btn" class="pfx-auth-btn pfx-auth-btn--google">
        ${(window.__PFX_IS_ELECTRON || window.__PFX_TARGET__ === 'desktop') ? ENTERPRISE_SVG : GOOGLE_SVG}
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
    _stopPolling();
    _setAuthState('granted');
    const el = document.getElementById(OVERLAY_ID);
    if (el) el.hidden = true;
    if (_focusBeforeOverlay?.isConnected) {
      try { _focusBeforeOverlay.focus({ preventScroll: true }); } catch {}
    }
    _focusBeforeOverlay = null;
  }

  // Non-blocking toast — shows briefly at bottom of card, no alert() needed
  function _showToast(msg, type = 'info') {
    if (msg && /err|error|warn|danger|fail/i.test(String(type || ''))) {
      try { msg = window.pfxFriendlyText ? window.pfxFriendlyText(msg) : msg; } catch (_) {}
    }
    const card = document.querySelector('.pfx-auth-card');
    if (!card) return;
    let toast = card.querySelector('.pfx-auth-toast');
    if (!toast) {
      toast = document.createElement('p');
      toast.className = 'pfx-auth-toast';
      toast.setAttribute('aria-live', 'polite');
      card.appendChild(toast);
    }
    toast.textContent = msg;
    toast.dataset.type = type;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.hidden = false;
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => { toast.hidden = true; }, 4000);
  }

  // ── Sign-in flow ─────────────────────────────────────────────────────────
  async function _doSignIn() {
    try { await window.PFX_AUTH?.ready?.(); } catch {}
    const isDesktop = window.__PFX_IS_ELECTRON || window.__PFX_TARGET__ === 'desktop';
    const signIn = isDesktop
      ? window.PFX_AUTH?.signInWithEnterprise
      : window.PFX_AUTH?.signInWithGoogle;
    if (typeof signIn !== 'function') {
      throw new Error(_t('authUnavailable'));
    }
    return await signIn();
  }

  async function _sendAccessRequest() {
    const backendUrl = window.__PFX_BACKEND_URL || 'https://api.postflowx.com';
    const requestUrl = backendUrl.includes('script.google.com')
      ? `${backendUrl}?path=request`
      : `${backendUrl}/request`;
    const user = window.PFX_AUTH?.getUser?.();
    const info = await new Promise(resolve => {
      if (typeof chrome !== 'undefined' && chrome.identity?.getProfileUserInfo) {
        chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, r => resolve(r || {}));
      } else {
        resolve({});
      }
    });
    try {
      const payload = {
        email: user?.email || info?.email || '',
        name:  user?.user_metadata?.full_name || user?.name || '',
      };
      const direct = await window.pfxPolicyApi?.submitAccessRequest?.(payload);
      if (!direct?.ok) {
        const response = await fetch(requestUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      }
      _showToast(_t('requestSent'), 'success');
    } catch {
      _showToast(_t('requestFailed'), 'error');
    }
  }

  return { showChecking, showLogin, showDenied, showExpired, hide };
})();
