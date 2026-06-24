// PostFlowX — Cut Diff Clean Feed (second monitor)
// Receives compare state from Cut Diff via BroadcastChannel and renders a clean compare output.

(() => {
  const canvas = document.getElementById('cfCanvas');
  const videoOld = document.getElementById('cfOld');
  const videoNew = document.getElementById('cfNew');
  const wipeLine = document.getElementById('cfWipeLine');
  const elLabel = document.getElementById('cfLabel');
  const elTc = document.getElementById('cfTc');
  const elAudio = document.getElementById('cfAudio');
  const elEmpty = document.getElementById('cfEmpty');
  const wmTextEl = document.getElementById('cfWmText');

  const state = {
    packet: null,
    old: { lastSrc: '', lastT: -999, lastPlaying: null },
    neu: { lastSrc: '', lastT: -999, lastPlaying: null },
    userMuted: false,
    wmText: '',
    raf: 0,
    offA: null,
    offB: null,
    offO: null,
  };

  const setEmpty = (on) => {
    try { elEmpty.style.display = on ? 'flex' : 'none'; } catch {}
  };

  const setWatermarkText = (t) => {
    state.wmText = String(t || '').trim();
    try {
      wmTextEl.textContent = state.wmText;
      wmTextEl.classList.toggle('is-hidden', !state.wmText);
    } catch {}
  };

  const initWatermark = () => {
    try {
      const hasChrome = typeof chrome !== 'undefined';
      const fn = hasChrome && chrome?.identity?.getProfileUserInfo;
      if (typeof fn === 'function') {
        fn((info) => {
          const email = (info && info.email) ? String(info.email) : '';
          const id = (info && info.id) ? String(info.id) : '';
          setWatermarkText(email || id || '');
        });
        return;
      }
    } catch {}
    setWatermarkText('');
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
      applyAudio();
    }
  };
  window.addEventListener('keydown', onKey, { passive: false });

  const safePlay = async (v) => {
    try { if (v.paused) await v.play(); } catch {}
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

  const applyOne = async (v, st, src, t, playing, rate, muted) => {
    if (!v) return;
    const srcChanged = src !== st.lastSrc;
    if (srcChanged) {
      st.lastSrc = src;
      st.lastT = -999;
      st.lastPlaying = null;
      try {
        v.src = src || '';
        v.preload = 'auto';
        v.playsInline = true;
        v.load();
      } catch {}
      await waitMeta(v);
    }

    try {
      v.muted = !!muted;
      v.volume = muted ? 0 : 1;
    } catch {}
    try { v.playbackRate = Number(rate) || 1; } catch {}

    try {
      const cur = Number(v.currentTime) || 0;
      const drift = Math.abs(cur - (Number(t) || 0));
      if (drift > 0.12) v.currentTime = Math.max(0, Number(t) || 0);
    } catch {}

    try {
      if (playing) await safePlay(v);
      else if (!v.paused) v.pause();
    } catch {}

    st.lastT = Number(t) || 0;
    st.lastPlaying = !!playing;
  };

  const resizeCanvas = () => {
    if (!canvas) return;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const w = Math.max(2, Math.floor(window.innerWidth * dpr));
    const h = Math.max(2, Math.floor(window.innerHeight * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  };

  const fitRect = (w, h, fit = 'contain') => {
    const ref = videoNew.videoWidth ? videoNew : videoOld;
    const vw = Number(ref?.videoWidth || 0);
    const vh = Number(ref?.videoHeight || 0);
    if (!vw || !vh) return { dx: 0, dy: 0, dw: w, dh: h };
    const vr = vw / vh;
    const cr = w / h;
    let dw, dh;
    if (fit === 'cover') {
      if (vr > cr) { dh = h; dw = h * vr; }
      else { dw = w; dh = w / vr; }
    } else {
      if (vr > cr) { dw = w; dh = w / vr; }
      else { dh = h; dw = h / (1 / vr); }
    }
    const dx = (w - dw) / 2;
    const dy = (h - dh) / 2;
    return { dx, dy, dw, dh };
  };

  const ensureOffscreens = (dw, dh) => {
    if (!state.offA) {
      state.offA = document.createElement('canvas');
      state.offB = document.createElement('canvas');
      state.offO = document.createElement('canvas');
    }
    for (const c of [state.offA, state.offB, state.offO]) {
      if (c.width !== dw) c.width = dw;
      if (c.height !== dh) c.height = dh;
    }
  };

  const computeDiff = (w, h, fit) => {
    const srcW = Math.max(2, Math.round(fit?.dw || w));
    const srcH = Math.max(2, Math.round(fit?.dh || h));
    const targetW = Math.min(720, srcW);
    const s = targetW / Math.max(1, srcW);
    const dw = Math.max(2, Math.floor(srcW * s));
    const dh = Math.max(2, Math.floor(srcH * s));
    ensureOffscreens(dw, dh);
    const aCtx = state.offA.getContext('2d', { willReadFrequently: true });
    const bCtx = state.offB.getContext('2d', { willReadFrequently: true });
    const oCtx = state.offO.getContext('2d', { willReadFrequently: true });
    if (!aCtx || !bCtx || !oCtx) return null;
    aCtx.clearRect(0, 0, dw, dh);
    bCtx.clearRect(0, 0, dw, dh);
    try { aCtx.drawImage(videoOld, 0, 0, dw, dh); } catch {}
    try { bCtx.drawImage(videoNew, 0, 0, dw, dh); } catch {}
    let aData, bData;
    try { aData = aCtx.getImageData(0, 0, dw, dh); } catch { return null; }
    try { bData = bCtx.getImageData(0, 0, dw, dh); } catch { return null; }
    const out = oCtx.createImageData(dw, dh);
    const A = aData.data; const B = bData.data; const O = out.data;
    const thr = 18;
    const span = Math.max(1, 255 - thr);
    for (let i = 0; i < A.length; i += 4) {
      const dr = Math.abs(A[i] - B[i]);
      const dg = Math.abs(A[i+1] - B[i+1]);
      const db = Math.abs(A[i+2] - B[i+2]);
      const d = (dr * 0.299) + (dg * 0.587) + (db * 0.114);
      const soft = Math.max(0, d - thr);
      const norm = soft / span;
      const boosted = soft > 0 ? Math.min(255, Math.round(Math.pow(norm, 0.65) * 255)) : 0;
      O[i] = boosted; O[i+1] = boosted; O[i+2] = boosted; O[i+3] = 255;
    }
    return { dw, dh, out, oCtx, oCanvas: state.offO, fit };
  };

  const render = () => {
    resizeCanvas();
    const p = state.packet;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width || 0;
    const h = canvas.height || 0;
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;

    if (!p || (!p.srcOld && !p.srcNew)) {
      setEmpty(true);
      try { wipeLine.classList.remove('is-on'); } catch {}
      stopLoop();
      return;
    }
    setEmpty(false);

    const hasOld = !!(videoOld.src && videoOld.readyState >= 2);
    const hasNew = !!(videoNew.src && videoNew.readyState >= 2);
    if (!hasOld && !hasNew) return;

    const fit = fitRect(w, h, p.fit || 'contain');
    const mode = String(p.mode || 'wipe');
    const wipe = Math.max(0, Math.min(1, Number(p.wipe) || 0.5));

    try {
      wipeLine.style.left = `${wipe * 100}%`;
      wipeLine.classList.toggle('is-on', mode === 'wipe');
    } catch {}

    if (mode === 'ab') {
      const v = p.showA ? videoOld : videoNew;
      try { ctx.drawImage(v, fit.dx, fit.dy, fit.dw, fit.dh); } catch {}
      return;
    }

    if (mode === 'sbs') {
      const half = w / 2;
      const fitHalf = fitRect(half, h, p.fit || 'contain');
      try { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, half, h); ctx.clip(); ctx.drawImage(videoOld, fitHalf.dx, fitHalf.dy, fitHalf.dw, fitHalf.dh); ctx.restore(); } catch {}
      try { ctx.save(); ctx.beginPath(); ctx.rect(half, 0, half, h); ctx.clip(); ctx.drawImage(videoNew, half + fitHalf.dx, fitHalf.dy, fitHalf.dw, fitHalf.dh); ctx.restore(); } catch {}
      return;
    }

    if (mode === 'split') {
      try { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w/2, h); ctx.clip(); ctx.drawImage(videoOld, fit.dx, fit.dy, fit.dw, fit.dh); ctx.restore(); } catch {}
      try { ctx.save(); ctx.beginPath(); ctx.rect(w/2, 0, w/2, h); ctx.clip(); ctx.drawImage(videoNew, fit.dx, fit.dy, fit.dw, fit.dh); ctx.restore(); } catch {}
      return;
    }

    if (mode === 'diff' || mode === 'heat') {
      const d = computeDiff(w, h, fit);
      if (!d) return;
      if (mode === 'diff') {
        try { ctx.fillStyle = 'rgba(0, 0, 0, 0.98)'; ctx.fillRect(0, 0, w, h); } catch {}
        try { d.oCtx.putImageData(d.out, 0, 0); } catch {}
        try { ctx.drawImage(d.oCanvas, 0, 0, d.dw, d.dh, d.fit.dx, d.fit.dy, d.fit.dw, d.fit.dh); } catch {}
      } else {
        try { ctx.drawImage(videoNew, fit.dx, fit.dy, fit.dw, fit.dh); } catch {}
        const O = d.out.data;
        for (let i = 0; i < O.length; i += 4) {
          const v = O[i];
          if (v <= 0) {
            O[i] = 0; O[i+1] = 0; O[i+2] = 0; O[i+3] = 0;
            continue;
          }
          const n = Math.max(0, Math.min(1, v / 255));
          let r = 255, g = 180, b = 0;
          if (n < 0.33) {
            const t2 = n / 0.33;
            r = 255;
            g = Math.round(240 - (40 * t2));
            b = Math.round(40 * (1 - t2));
          } else if (n < 0.66) {
            const t2 = (n - 0.33) / 0.33;
            r = 255;
            g = Math.round(200 - (120 * t2));
            b = 0;
          } else {
            const t2 = (n - 0.66) / 0.34;
            r = 255;
            g = Math.round(Math.max(0, 80 - (80 * t2)));
            b = 0;
          }
          O[i] = r;
          O[i+1] = g;
          O[i+2] = b;
          O[i+3] = Math.max(0, Math.min(235, Math.round(28 + (n * 190))));
        }
        try { d.oCtx.putImageData(d.out, 0, 0); } catch {}
        try { ctx.drawImage(d.oCanvas, 0, 0, d.dw, d.dh, d.fit.dx, d.fit.dy, d.fit.dw, d.fit.dh); } catch {}
      }
      return;
    }

    try { ctx.drawImage(videoOld, fit.dx, fit.dy, fit.dw, fit.dh); } catch {}
    try {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w * wipe, h);
      ctx.clip();
      ctx.drawImage(videoNew, fit.dx, fit.dy, fit.dw, fit.dh);
      ctx.restore();
    } catch {}
  };

  const loopTick = () => {
    render();
    if (state.packet?.playing) state.raf = requestAnimationFrame(loopTick);
    else state.raf = 0;
  };

  const startLoop = () => {
    if (state.raf) return;
    state.raf = requestAnimationFrame(loopTick);
  };

  const stopLoop = () => {
    if (!state.raf) return;
    try { cancelAnimationFrame(state.raf); } catch {}
    state.raf = 0;
  };

  const applyAudio = () => {
    const allowAudio = !!(state.packet?.audio) && !state.userMuted;
    try {
      videoNew.muted = !allowAudio;
      videoNew.volume = allowAudio ? 1 : 0;
      videoOld.muted = true;
      videoOld.volume = 0;
    } catch {}
    try {
      elAudio.textContent = allowAudio ? 'AUDIO' : 'MUTED';
      elAudio.style.opacity = allowAudio ? '1' : '0.7';
    } catch {}
  };

  const applySync = async (p) => {
    if (!p) return;
    state.packet = {
      label: p.label || 'Clean Feed',
      tc: p.tc || '00:00:00:00',
      srcOld: p.srcOld || '',
      srcNew: p.srcNew || '',
      oldT: Number(p.oldT) || 0,
      newT: Number(p.newT) || 0,
      playing: !!p.playing,
      rate: Number(p.rate) || 1,
      audio: !!p.audio,
      mode: p.mode || 'wipe',
      wipe: p.wipe != null ? p.wipe : 0.5,
      fit: p.fit || 'contain',
      showA: !!p.showA,
    };

    try { document.title = state.packet.label; } catch {}
    try { elLabel.textContent = state.packet.label; } catch {}
    try { elTc.textContent = state.packet.tc; } catch {}
    applyAudio();

    const haveAny = !!(state.packet.srcOld || state.packet.srcNew);
    setEmpty(!haveAny);

    await Promise.all([
      applyOne(videoOld, state.old, state.packet.srcOld, state.packet.oldT, state.packet.playing, state.packet.rate, true),
      applyOne(videoNew, state.neu, state.packet.srcNew, state.packet.newT, state.packet.playing, state.packet.rate, !state.packet.audio || state.userMuted),
    ]);

    render();
    if (state.packet.playing) startLoop();
    else stopLoop();
  };

  initWatermark();
  window.addEventListener('resize', render, { passive: true });
  document.addEventListener('fullscreenchange', render, { passive: true });

  let ch = null;
  try {
    ch = new BroadcastChannel('pfx_cleanfeed_cutdiff');
    ch.onmessage = (ev) => {
      if (!ev?.data) return;
      if (ev.data.type === 'sync') applySync(ev.data);
      if (ev.data.type === 'shutdown') {
        try { window.close(); } catch {}
      }
    };
    ch.postMessage({ type: 'ready' });
  } catch {}

  window.addEventListener('beforeunload', () => {
    try { ch?.postMessage({ type: 'closing' }); } catch {}
  });
})();
