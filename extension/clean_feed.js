// PostFlowX — Clean Feed (2nd monitor)
// Receives sync packets from the main Visual QC (Reviews) tab via BroadcastChannel.
// Mirrors V1 (program) plus V2 overlay + QC modes (Diff/Wipe/Blink/Gamma/RGB/Gain).

(() => {
  const viewer = document.getElementById('cfViewer');
  const videoA = document.getElementById('cfVideoA');
  const videoV2 = document.getElementById('cfVideoV2');
  const wipeLine = document.getElementById('cfWipeLine');
  const wmTextEl = document.getElementById('cfWmText');

  const elLabel = document.getElementById('cfLabel');
  const elTc = document.getElementById('cfTc');
  const elAudio = document.getElementById('cfAudio');
  const elEmpty = document.getElementById('cfEmpty');

  const state = {
    a: { lastSrc: '', lastT: -999, lastPlaying: null },
    v2: { lastSrc: '', lastT: -999, lastPlaying: null },
    userMuted: false,
    readySent: false,
    wmText: '',
  };

  // Watermark (email from Chrome profile)
  const drawWatermark = () => {
    const text = (state.wmText || '').trim();
    if (!wmTextEl) return;
    wmTextEl.textContent = text;
    try { wmTextEl.classList.toggle('is-hidden', !text); } catch {}
  };

  const setWatermarkText = (t) => {
    state.wmText = String(t || '').trim();
    drawWatermark();
  };

  const initWatermark = () => {
    // Best-effort: may be blank if user isn't signed in / permission blocked.
    try {
      const hasChrome = typeof chrome !== 'undefined';
      const fn = hasChrome && chrome?.identity?.getProfileUserInfo;
      if (typeof fn === 'function') {
        fn((info) => {
          const email = (info && info.email) ? String(info.email) : '';
          const id = (info && info.id) ? String(info.id) : '';
          // Prefer email; fall back to id so we never show a blank watermark unintentionally.
          setWatermarkText(email || id || '');
          // Redraw once on next tick.
          try { requestAnimationFrame(() => drawWatermark()); } catch {}
        });
        return;
      }
    } catch {}
    setWatermarkText('');
  };

  const setEmpty = (on) => {
    try { elEmpty.style.display = on ? 'flex' : 'none'; } catch {}
  };

  const setAudioPill = () => {
    const on = !videoA.muted && (videoA.volume || 0) > 0;
    elAudio.textContent = on ? 'AUDIO' : 'MUTED';
    elAudio.style.opacity = on ? '1' : '0.7';
  };

  const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

  const applyQc = (qc = {}) => {
    const diff = !!qc.diff;
    const wipe = !!qc.wipe;
    const blink = !!qc.blink;
    const blinkOn = !!qc.blinkOn;
    const gamma = !!qc.gamma;

    try {
      viewer.classList.toggle('is-diff', diff);
      viewer.classList.toggle('is-wipe', wipe);
      viewer.classList.toggle('is-blink', blink);
      viewer.classList.toggle('is-blink-on', blinkOn);
      viewer.classList.toggle('is-gamma', gamma);
    } catch {}

    // CSS vars
    try {
      const wipePos = (qc.wipePos != null) ? qc.wipePos : (qc.wipe != null ? qc.wipe : 0.5);
      const w = clamp01(wipePos);
      viewer.style.setProperty('--wipe', String(w));
      wipeLine.style.left = `${w * 100}%`;
    } catch {}

    try {
      const gain = (qc.gain != null) ? String(qc.gain) : '1';
      viewer.style.setProperty('--pfx-qc-gain', gain || '1');
    } catch {}

    try {
      const rgb = (qc.rgb != null) ? String(qc.rgb) : '';
      viewer.style.setProperty('--pfx-qc-rgb', rgb || '');
    } catch {}
  };

  const onKey = (e) => {
    const k = (e.key || '').toLowerCase();
    if (k === 'f') {
      e.preventDefault();
      try {
        if (!document.fullscreenElement) document.documentElement.requestFullscreen();
        else document.exitFullscreen();
      } catch {}
      return;
    }
    if (k === 'm') {
      e.preventDefault();
      state.userMuted = !state.userMuted;
      try {
        videoA.muted = state.userMuted;
        videoA.volume = state.userMuted ? 0 : 1;
      } catch {}
      setAudioPill();
      return;
    }
  };
  window.addEventListener('keydown', onKey, { passive: false });

  // Keep watermark crisp on resize / fullscreen.
  window.addEventListener('resize', () => drawWatermark(), { passive: true });
  document.addEventListener('fullscreenchange', () => drawWatermark(), { passive: true });

  initWatermark();

  const safePlay = async (v) => {
    try {
      if (v.paused) await v.play();
    } catch {
      // Autoplay may be blocked until user clicks.
    }
  };

  const waitMeta = async (v) => {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      };
      const cleanup = () => {
        try { v.removeEventListener('loadedmetadata', finish); } catch {}
        try { v.removeEventListener('error', finish); } catch {}
        try { clearTimeout(to); } catch {}
      };
      try { v.addEventListener('loadedmetadata', finish, { once: true }); } catch {}
      try { v.addEventListener('error', finish, { once: true }); } catch {}
      const to = setTimeout(finish, 1200);
    });
  };

  const applyOne = async (v, st, src, t, playing, rate, { forceMute = false } = {}) => {
    if (!src) return;

    // Ensure mute state
    try {
      if (forceMute) {
        v.muted = true;
        v.volume = 0;
      }
    } catch {}

    const srcChanged = (src !== st.lastSrc);
    if (srcChanged) {
      st.lastSrc = src;
      st.lastT = -999;
      st.lastPlaying = null;
      try {
        v.src = src;
        v.preload = 'auto';
        v.playsInline = true;
        v.load();
      } catch {}
      await waitMeta(v);

      // Metadata changes the displayed rect for object-fit: contain;
      // redraw watermark so it stays aligned under the burn-in line.
      try { drawWatermark(); } catch {}
    }

    try { v.playbackRate = rate; } catch {}

    // Drift correction — avoid constant seeks.
    try {
      const cur = Number(v.currentTime) || 0;
      const drift = Math.abs(cur - t);
      if (drift > 0.12) v.currentTime = t;
    } catch {}

    try {
      if (playing) await safePlay(v);
      else if (!v.paused) v.pause();
    } catch {}

    st.lastT = t;
    st.lastPlaying = playing;
  };

  const applySync = async (p) => {
    if (!p) return;

    const src = p.src || '';
    const t = Number(p.t) || 0;
    const playing = !!p.playing;
    const rate = Number(p.rate) || 1;
    const tc = p.tc || '00:00:00:00';
    const label = p.label || 'Clean Feed';

    const v2 = p.v2 || {};
    const v2src = p.v2Src || v2.src || '';
    const v2t = Number((p.v2T != null) ? p.v2T : v2.t) || 0;
    const v2Show = (typeof v2.show === 'boolean') ? v2.show : (typeof p.v2Show === 'boolean' ? p.v2Show : true);

    const qc = p.qc || {};

    try { document.title = label; } catch {}
    try { elLabel.textContent = label; } catch {}
    try { elTc.textContent = tc; } catch {}

    // Audio is local + only on base video
    try {
      videoA.muted = !!state.userMuted;
      videoA.volume = state.userMuted ? 0 : 1;
    } catch {}
    try { videoV2.muted = true; videoV2.volume = 0; } catch {}
    setAudioPill();

    if (!src && !v2src) {
      setEmpty(true);
      try { videoV2.style.display = 'none'; } catch {}
      return;
    }
    setEmpty(false);

    // Apply QC state (classes + vars)
    applyQc(qc);

    // Overlay visibility
    const showOverlay = !!v2src && !!v2Show;
    try { videoV2.style.display = showOverlay ? 'block' : 'none'; } catch {}

    // Sync base + overlay
    await applyOne(videoA, state.a, src, t, playing, rate, { forceMute: false });
    if (showOverlay) {
      await applyOne(videoV2, state.v2, v2src, v2t, playing, rate, { forceMute: true });
    } else {
      try { if (!videoV2.paused) videoV2.pause(); } catch {}
    }
  };

  // Channel
  let ch = null;
  try {
    ch = new BroadcastChannel('pfx_cleanfeed');
    ch.onmessage = (ev) => {
      const d = ev?.data;
      if (!d) return;
      if (d.type === 'sync') applySync(d);
      if (d.type === 'shutdown') {
        try { window.close(); } catch {}
      }
    };
  } catch {}

  // Let the opener know we are alive.
  const sendReady = () => {
    if (state.readySent) return;
    state.readySent = true;
    try { ch?.postMessage({ type: 'ready' }); } catch {}
  };
  sendReady();

  window.addEventListener('beforeunload', () => {
    try { ch?.postMessage({ type: 'closing' }); } catch {}
  });

  // If user clicks once, autoplay restrictions usually lift.
  window.addEventListener('pointerdown', () => {
    try { safePlay(videoA); } catch {}
    try { safePlay(videoV2); } catch {}
  }, { passive: true });
})();
