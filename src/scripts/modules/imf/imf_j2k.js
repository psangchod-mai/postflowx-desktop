// scripts/modules/imf/imf_j2k.js
// MV3-safe J2K bridge using a sandboxed iframe page.
'use strict';

import { sniffCodestream } from './j2kCodestream.js';

let _sandboxPoolReadyPromise = null;
const _sandboxPool = [];
const _sandboxMap = new WeakMap();
let _sandboxListenerInstalled = false;
let _nextReqId = 1;
let _configuredLaneCount = 0;
let _directHTModulePromise = null;
let _directHTModule = null;
let _lastDirectHTError = '';
// Chrome MV3 extension pages reject eval/new Function — use sandbox iframe path.
// Electron desktop app has no such restriction; direct WASM init is safe.
const _isDesktopApp = typeof window !== 'undefined' && window.pfxPlatform != null;
let _directHTDisabled = !_isDesktopApp;

function _sandboxLaneCount() {
  try {
    const hc = Math.max(1, Number(navigator.hardwareConcurrency || 4) || 4);
    if (hc >= 16) return 4;
    if (hc >= 10) return 3;
    if (hc >= 6) return 2;
  } catch (_) {}
  return 1;
}

export function getDecoderPoolInfo() {
  let hardware = 0;
  try { hardware = Math.max(1, Number(navigator.hardwareConcurrency || 0) || 0); } catch (_) {}
  const configured = Math.max(1, _configuredLaneCount || _sandboxLaneCount());
  return {
    configured,
    ready: _sandboxPool.length,
    hardware,
  };
}

// ── Which backend actually served each frame (C-RT2) ────────────────────────
// The decode ladder has four rungs (direct OpenJPH → sandbox OpenJPH → sandbox
// OpenJPEG → pure JS) and, until now, nothing outside a console.log said which
// one you were on. A silently-degraded rung looks exactly like a fast one, just
// slower — the same blind spot that let classic streams pound the HT decoder
// once per frame for however long that has been shipping. Count it, and let the
// HUD show it.
const _routeStats = { byBackend: Object.create(null), total: 0, directFailures: 0, failed: 0, rejected: 0, last: null };

function _noteRoute(backend) {
  _routeStats.byBackend[backend] = (_routeStats.byBackend[backend] || 0) + 1;
  _routeStats.total++;
  _routeStats.last = backend;
}

/**
 * Frame counts per decode backend since load. `last` is the backend that served
 * the most recent frame — the value a HUD wants. Returns a copy; callers cannot
 * mutate the counters.
 */
export function getDecodeRouteStats() {
  return {
    byBackend: { ..._routeStats.byBackend },
    total: _routeStats.total,
    directFailures: _routeStats.directFailures,
    failed: _routeStats.failed,
    rejected: _routeStats.rejected,
    last: _routeStats.last,
  };
}

export function resetDecodeRouteStats() {
  for (const k of Object.keys(_routeStats.byBackend)) delete _routeStats.byBackend[k];
  _routeStats.total = 0;
  _routeStats.directFailures = 0;
  _routeStats.failed = 0;
  _routeStats.rejected = 0;
  _routeStats.last = null;
}

export function prewarmJ2KDecoders() {
  return _ensureSandboxPool().then(() => getDecoderPoolInfo()).catch(() => getDecoderPoolInfo());
}

function _typedArrayFrom(type, buffer) {
  if (type === 'u16') return new Uint16Array(buffer);
  if (type === 'i16') return new Int16Array(buffer);
  return new Uint8Array(buffer);
}




function _loadDirectHTModule() {
  if (_directHTModulePromise) return _directHTModulePromise;
  _directHTModulePromise = new Promise((resolve) => {
    try {
      const finish = (mod, tag) => {
        if (!mod || typeof mod.HTJ2KDecoder !== 'function') {
          _lastDirectHTError = `direct module missing HTJ2KDecoder (${tag || 'unknown'})`;
          console.warn('[J2K] direct HT module invalid', tag, mod ? Object.keys(mod).slice(0, 20) : null);
          resolve(null);
          return;
        }
        _directHTModule = mod;
        console.log('[J2K] direct HT module ready', tag || 'module');
        resolve(mod);
      };

      const prevModule = window.Module;
      const src = new URL('../../../assets/imf/openjphjs_mv3safe.js?v=2026-04-07-v63', import.meta.url).href;
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => {
        try {
          const exported = window.Module;
          window.Module = prevModule;
          if (!exported) {
            _lastDirectHTError = 'window.Module missing after direct HT load';
            resolve(null);
            return;
          }
          if (typeof exported === 'function') {
            Promise.resolve(exported({
              locateFile: (path) => path.endsWith('.wasm')
                ? new URL('../../../assets/imf/openjphjs.wasm', import.meta.url).href
                : path,
            })).then((m) => finish(m, 'factory')).catch((e) => {
              _lastDirectHTError = String(e && e.message ? e.message : e);
              console.warn('[J2K] direct HT factory init failed', e);
              resolve(null);
            });
            return;
          }
          if (exported && typeof exported.then === 'function') {
            Promise.resolve(exported).then((m) => finish(m, 'promise')).catch((e) => {
              _lastDirectHTError = String(e && e.message ? e.message : e);
              console.warn('[J2K] direct HT promise init failed', e);
              resolve(null);
            });
            return;
          }
          if (exported && exported.ready && typeof exported.ready.then === 'function') {
            Promise.resolve(exported.ready).then(() => finish(exported, 'ready')).catch((e) => {
              _lastDirectHTError = String(e && e.message ? e.message : e);
              console.warn('[J2K] direct HT ready init failed', e);
              resolve(null);
            });
            return;
          }
          finish(exported, 'object');
        } catch (e) {
          _lastDirectHTError = String(e && e.message ? e.message : e);
          console.warn('[J2K] direct HT onload failed', e);
          resolve(null);
        }
      };
      s.onerror = (e) => {
        _lastDirectHTError = 'direct HT script load failed';
        console.warn('[J2K] direct HT script load failed', e);
        resolve(null);
      };
      document.head.appendChild(s);
    } catch (e) {
      _lastDirectHTError = String(e && e.message ? e.message : e);
      console.warn('[J2K] direct HT load error', e);
      resolve(null);
    }
  });
  return _directHTModulePromise;
}

function _reduceLevelFromScale(scale) {
  if (!(typeof scale === 'number' && isFinite(scale) && scale > 0 && scale < 1)) return 0;
  if (scale <= 0.25) return 2;
  return 1;
}

function _decodeHTBytesWithModule(mod, bytes, scale = 1) {
  let reduceLevel = _reduceLevelFromScale(scale);
  const decoder = new mod.HTJ2KDecoder();
  try {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const enc = decoder.getEncodedBuffer(src.length);
  enc.set(src);
  decoder.readHeader();
  // decodeSubResolution(N) THROWS if N >= the codestream's decomposition levels,
  // so clamp to the available count (a clip with few resolution levels can't be
  // reduced as far as requested).
  const numDecomp = (typeof decoder.getNumDecompositions === 'function')
    ? (decoder.getNumDecompositions() | 0) : 0;
  if (numDecomp > 0 && reduceLevel > numDecomp) reduceLevel = numDecomp;
  decoder.decodeSubResolution(reduceLevel);
  const info = decoder.getFrameInfo();
  const raw = decoder.getDecodedBuffer();
  // CRITICAL: at a reduced level the decoded BUFFER is the reduced size, but
  // getFrameInfo() still reports the FULL frame dimensions. Returning the full
  // width/height with a reduced buffer makes the renderer read a small buffer as
  // a large image → garbage / dark / oscillating frames (the old C-RT1b bug that
  // forced scale:1). Use the actual decoded dimensions for the reduced level.
  let width = info.width, height = info.height;
  if (reduceLevel > 0 && typeof decoder.calculateSizeAtDecompositionLevel === 'function') {
    const dims = decoder.calculateSizeAtDecompositionLevel(reduceLevel);
    if (dims && dims.width > 0 && dims.height > 0) { width = dims.width; height = dims.height; }
  }
  let pixels;
  let pixelsType = 'u8';
  if (info.bitsPerSample > 8) {
    const src16 = new (info.isSigned ? Int16Array : Uint16Array)(raw.buffer, raw.byteOffset, raw.byteLength / 2);
    pixels = new (info.isSigned ? Int16Array : Uint16Array)(src16);
    pixelsType = info.isSigned ? 'i16' : 'u16';
  } else {
    const src8 = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    pixels = new Uint8Array(src8);
  }
  return {
    width,
    height,
    fullWidth: info.width,
    fullHeight: info.height,
    componentCount: info.componentCount,
    bitsPerSample: info.bitsPerSample,
    isSigned: !!info.isSigned,
    isUsingColorTransform: !!info.isUsingColorTransform,
    decoderKind: 'htj2k-openjph-direct',
    sampleLayout: 'interleaved',
    pixelsType,
    pixels,
    nativeReduced: reduceLevel > 0,
    nativeReduceLevel: reduceLevel,
  };
  } finally { try { decoder.delete(); } catch (_) {} }
}

function _installSandboxListener() {
  if (_sandboxListenerInstalled) return;
  _sandboxListenerInstalled = true;
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== 'PFX_J2K_SANDBOX') return;
    const sb = _sandboxMap.get(event.source);
    if (!sb) return;

    if (data.type === 'PFX_J2K_SANDBOX_READY' || data.type === 'PFX_J2K_PONG') {
      sb.ready = true;
      sb.readyResolve?.(true);
      sb.readyResolve = null;
      return;
    }

    if (data.type === 'PFX_J2K_SANDBOX_ERROR') {
      sb.ready = false;
      sb.readyResolve?.(false);
      sb.readyResolve = null;
      return;
    }

    if (data.type === 'PFX_J2K_DECODE_RESULT') {
      const pending = sb.pending.get(data.id);
      if (!pending) return;
      sb.pending.delete(data.id);
      sb.inflight = Math.max(0, (sb.inflight | 0) - 1);
      if (!data.ok) {
        pending.reject(new Error(data.error || 'Sandbox decode failed'));
        return;
      }
      try {
        const frame = data.frame || {};
        pending.resolve({
          width: frame.width,
          height: frame.height,
          componentCount: frame.componentCount,
          bitsPerSample: frame.bitsPerSample,
          isSigned: frame.isSigned,
          isUsingColorTransform: frame.isUsingColorTransform,
          decoderKind: frame.decoderKind,
          pixels: _typedArrayFrom(frame.pixelsType, frame.pixelsBuffer),
          sampleLayout: frame.sampleLayout || 'interleaved',
        });
      } catch (e) {
        pending.reject(e);
      }
    }
  });
}

function _createSandbox(index) {
  return new Promise((resolve) => {
    const base = new URL('.', import.meta.url).href;
    const iframeUrl = new URL(`../../../sandbox/j2k_decoder.html?v=2026-04-07-v29&lane=${index}`, base).href;
    const iframe = document.createElement('iframe');
    iframe.src = iframeUrl;
    iframe.style.cssText = 'position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
    iframe.setAttribute('aria-hidden', 'true');
    document.documentElement.appendChild(iframe);

    const sb = {
      index,
      iframe,
      win: iframe.contentWindow || null,
      pending: new Map(),
      inflight: 0,
      ready: false,
      readyResolve: null,
    };
    const readyPromise = new Promise((readyResolve) => {
      sb.readyResolve = readyResolve;
      setTimeout(() => {
        if (sb.readyResolve) {
          sb.readyResolve(false);
          sb.readyResolve = null;
        }
      }, 15000);
    });

    if (sb.win) _sandboxMap.set(sb.win, sb);

    iframe.addEventListener('load', () => {
      sb.win = iframe.contentWindow || sb.win;
      if (sb.win) {
        _sandboxMap.set(sb.win, sb);
        try {
          sb.win.postMessage({ source: 'PFX_IMF_J2K_BRIDGE', type: 'PFX_J2K_PING' }, '*');
        } catch (_) {}
      }
    }, { once: true });

    readyPromise.then((ok) => {
      if (ok) console.log(`[J2K] decoder lane ${index + 1} ready`);
      else console.warn(`[J2K] decoder lane ${index + 1} unavailable`);
      resolve(sb);
    });
  });
}

async function _ensureSandboxPool() {
  if (_sandboxPoolReadyPromise) return _sandboxPoolReadyPromise;
  _installSandboxListener();
  _sandboxPoolReadyPromise = (async () => {
    const laneCount = _sandboxLaneCount();
    _configuredLaneCount = laneCount;
    const sandboxes = await Promise.all(Array.from({ length: laneCount }, (_, i) => _createSandbox(i)));
    _sandboxPool.length = 0;
    for (const sb of sandboxes) {
      if (sb?.ready && sb.win) _sandboxPool.push(sb);
    }
    if (_sandboxPool.length) {
      console.log(`[J2K] Smart decoder pool ready (${_sandboxPool.length} lane${_sandboxPool.length > 1 ? 's' : ''})`);
      return true;
    }
    console.warn('[J2K] sandbox pool unavailable');
    return false;
  })();
  return _sandboxPoolReadyPromise;
}

function _pickSandbox() {
  if (!_sandboxPool.length) return null;
  let best = _sandboxPool[0];
  for (const sb of _sandboxPool) {
    if ((sb.inflight | 0) < (best.inflight | 0)) best = sb;
  }
  return best;
}

export async function decodeHTJ2K(bytes, opts = {}) {
  if (!bytes || bytes.length < 6) return null;

  // Classify before choosing a decoder. The previous check here accepted a
  // codestream starting 0xFF4F *or* 0xFF50 on the belief that 0xFF50 was an
  // "HTJ2K SOC" — there is no such thing. Every JPEG 2000 codestream, Part 1
  // and Part 15 alike, starts 0xFF4F; 0xFF50 is CAP, a main-header segment that
  // never appears at offset 0. So that branch was unreachable, and worse, the
  // absence of a real sniff meant classic Part 1 streams were handed to the
  // direct OpenJPH decoder below — the HT-only decoder the sandbox deliberately
  // reserves for kind === 'htj2k'.
  const sniff = sniffCodestream(bytes);
  if (sniff.kind === 'unknown') {
    console.warn('[J2K] No SOC marker — not a J2K codestream');
    _routeStats.rejected++;
    return null;
  }

  // MV3 extension pages allow wasm-unsafe-eval for WebAssembly, but still reject
  // unsafe-eval/new Function. The packaged HT JS wrapper currently trips that path,
  // so prefer the sandbox decoder path here and avoid noisy CSP errors on index.html.
  //
  // Desktop additionally gates on the sniff: OpenJPH decodes HT block coding
  // only. Sending it a Part 1 stream cost a full copy of the codestream into the
  // WASM heap plus a thrown exception *per frame*, then fell through to the
  // sandbox that would have decoded it correctly in the first place.
  if (!_directHTDisabled && sniff.kind === 'htj2k') {
    try {
      const mod = await _loadDirectHTModule();
      if (mod) {
        const frame = _decodeHTBytesWithModule(mod, bytes, typeof opts.scale === 'number' ? opts.scale : 1);
        _noteRoute('direct-openjph');
        if (typeof window !== 'undefined' && window.PFX_DEBUG_IMF) console.log(`[J2K] direct decode ok via ${frame.decoderKind} ${frame.width}x${frame.height} ${frame.componentCount}ch ${frame.bitsPerSample}bpp`);
        return frame;
      }
    } catch (e) {
      _lastDirectHTError = String(e && e.message ? e.message : e);
      _routeStats.directFailures++;
      console.warn('[J2K] direct HT decode failed, falling back to sandbox', e);
    }
  }

  const ready = await _ensureSandboxPool();
  const sandbox = ready ? _pickSandbox() : null;
  if (!sandbox?.win) {
    if (!_directHTDisabled && _lastDirectHTError) console.warn('[J2K] no sandbox fallback available after direct HT failure:', _lastDirectHTError);
    return null;
  }

  const id = _nextReqId++;
  const reqPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending = sandbox.pending.get(id);
      if (!pending) return;
      sandbox.pending.delete(id);
      sandbox.inflight = Math.max(0, (sandbox.inflight | 0) - 1);
      reject(new Error('Sandbox decode timeout'));
    }, 60000);
    sandbox.pending.set(id, {
      resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
    sandbox.inflight = (sandbox.inflight | 0) + 1;
  });

  const buffer = new Uint8Array(bytes).buffer;
  try {
    sandbox.win.postMessage({
      source: 'PFX_IMF_J2K_BRIDGE',
      type: 'PFX_J2K_DECODE',
      id,
      buffer,
      scale: (typeof opts.scale === 'number' ? opts.scale : 1),
      fastMode: !!opts.fastMode,
    }, '*', [buffer]);
  } catch (postErr) {
    // Sandbox iframe was closed/killed before we could send — reject via the pending
    // wrapper so the 60-second timeout is cleared and inflight is decremented immediately.
    const pend = sandbox.pending.get(id);
    if (pend) {
      sandbox.pending.delete(id);
      sandbox.inflight = Math.max(0, (sandbox.inflight | 0) - 1);
      pend.reject(postErr);
    }
    return null;
  }

  try {
    const frame = await reqPromise;
    // decoderKind is what the sandbox *actually* used, which is the answer worth
    // recording — the sandbox has its own OpenJPEG→pure-JS fallback inside it.
    _noteRoute(frame.decoderKind ? `sandbox:${frame.decoderKind}` : 'sandbox:unknown');
    if (typeof window !== 'undefined' && window.PFX_DEBUG_IMF) console.log(`[J2K] sandbox decode ok via ${frame.decoderKind || 'unknown'} ${frame.width}x${frame.height} ${frame.componentCount}ch ${frame.bitsPerSample}bpp`);
    return frame;
  } catch (e) {
    _routeStats.failed++;
    console.warn('[J2K] sandbox decode error', e);
    return null;
  }
}



function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function isPQTransfer(transfer) {
  const t = String(transfer || '').toUpperCase();
  return t.includes('PQ') || t.includes('ST 2084') || t.includes('ST2084');
}

function pqToLinear01(v) {
  const x = clamp01(v);
  const m1 = 2610 / 16384;
  const m2 = 2523 / 32;
  const c1 = 3424 / 4096;
  const c2 = 2413 / 128;
  const c3 = 2392 / 128;
  const p = Math.pow(x, 1 / m2);
  const num = Math.max(p - c1, 0);
  const den = c2 - c3 * p;
  if (den <= 0) return 0;
  return Math.pow(num / den, 1 / m1);
}

function toneMapHdrLinear01(v) {
  const nits = Math.max(0, v) * 10000;
  const hdrRefWhite = 203;
  const x = Math.max(0, nits / hdrRefWhite) * 1.35;
  const mapped = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  return clamp01(mapped);
}

function linearToSrgb01(v) {
  const x = clamp01(v);
  if (x <= 0.0031308) return 12.92 * x;
  return 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function convertPrimariesLinear(rgb, primaries) {
  const p = String(primaries || '').toUpperCase();
  const r = rgb[0], g = rgb[1], b = rgb[2];
  if (p.includes('P3-D65') || p.includes('DISPLAY P3') || p.includes('DISPLAY-P3')) {
    return [
      1.22474526 * r - 0.22490436 * g + 0.00000002 * b,
      -0.04205792 * r + 1.04208101 * g - 0.00000002 * b,
      -0.01964228 * r - 0.07865492 * g + 1.09853719 * b,
    ];
  }
  if (p.includes('2020') || p.includes('BT.2020') || p.includes('REC.2020')) {
    return [
      1.6605 * r - 0.5876 * g - 0.0728 * b,
      -0.1246 * r + 1.1329 * g - 0.0083 * b,
      -0.0182 * r - 0.1006 * g + 1.1187 * b,
    ];
  }
  return [r, g, b];
}

function previewEncodeRgbPrime(rgbPrime, transfer, primaries) {
  if (!isPQTransfer(transfer)) {
    return [
      Math.max(0, Math.min(255, Math.round(rgbPrime[0] * 255))),
      Math.max(0, Math.min(255, Math.round(rgbPrime[1] * 255))),
      Math.max(0, Math.min(255, Math.round(rgbPrime[2] * 255))),
    ];
  }
  let lin = [pqToLinear01(rgbPrime[0]), pqToLinear01(rgbPrime[1]), pqToLinear01(rgbPrime[2])];
  lin = convertPrimariesLinear(lin, primaries);
  const enc = [
    linearToSrgb01(toneMapHdrLinear01(lin[0])),
    linearToSrgb01(toneMapHdrLinear01(lin[1])),
    linearToSrgb01(toneMapHdrLinear01(lin[2])),
  ];
  return [
    Math.max(0, Math.min(255, Math.round(enc[0] * 255))),
    Math.max(0, Math.min(255, Math.round(enc[1] * 255))),
    Math.max(0, Math.min(255, Math.round(enc[2] * 255))),
  ];
}

function yuvToRgbPixel(y, u, v, transfer = '', primaries = '') {
  const yf = clamp01((y - 16) / 219);
  const uf = (u - 128) / 224;
  const vf = (v - 128) / 224;
  const rP = clamp01(yf + 1.5748 * vf);
  const gP = clamp01(yf - 0.1873 * uf - 0.4681 * vf);
  const bP = clamp01(yf + 1.8556 * uf);
  return previewEncodeRgbPrime([rP, gP, bP], transfer, primaries);
}

export function frameToImageData(frame, scale = 1, colorInfo = {}) {
  const { width, height, componentCount, bitsPerSample, isSigned, pixels, sampleLayout = 'interleaved' } = frame;
  const useScale = (typeof scale === 'number' && isFinite(scale) && scale > 0 && scale < 1) ? scale : 1;
  const step = useScale < 1 ? Math.max(1, Math.round(1 / useScale)) : 1;
  const outW = Math.max(1, Math.floor(width / step));
  const outH = Math.max(1, Math.floor(height / step));
  const imageData = new ImageData(outW, outH);
  const out = imageData.data;

  let pixelData;
  if (bitsPerSample > 8) {
    pixelData = isSigned
      ? new Int16Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 2)
      : new Uint16Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 2);
  } else {
    pixelData = pixels;
  }

  const plane = width * height;
  const shift = bitsPerSample > 8 ? Math.max(0, bitsPerSample - 8) : 0;
  const px = (v) => {
    const n = bitsPerSample > 8 ? (v >> shift) : v;
    return Math.max(0, Math.min(255, n & 0xff));
  };

  if (sampleLayout === 'yuv420p') {
    const yPlane = plane;
    const cW = Math.max(1, Math.floor(width / 2));
    const cH = Math.max(1, Math.floor(height / 2));
    const uvPlane = cW * cH;
    const uOff = yPlane;
    const vOff = yPlane + uvPlane;
    for (let y = 0; y < outH; y++) {
      const sy = Math.min(height - 1, y * step);
      const cy = Math.min(cH - 1, Math.floor(sy / 2));
      for (let x = 0; x < outW; x++) {
        const sx = Math.min(width - 1, x * step);
        const cx = Math.min(cW - 1, Math.floor(sx / 2));
        const yi = sy * width + sx;
        const ci = cy * cW + cx;
        const o = (y * outW + x) * 4;
        const [r,g,b] = yuvToRgbPixel(pixelData[yi] ?? 0, pixelData[uOff + ci] ?? 128, pixelData[vOff + ci] ?? 128, colorInfo.transfer, colorInfo.primaries);
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
      }
    }
    return imageData;
  }

  if (sampleLayout === 'yuv422p') {
    const yPlane = plane;
    const cW = Math.max(1, Math.floor(width / 2));
    const uvPlane = cW * height;
    const uOff = yPlane;
    const vOff = yPlane + uvPlane;
    for (let y = 0; y < outH; y++) {
      const sy = Math.min(height - 1, y * step);
      for (let x = 0; x < outW; x++) {
        const sx = Math.min(width - 1, x * step);
        const cx = Math.min(cW - 1, Math.floor(sx / 2));
        const yi = sy * width + sx;
        const ci = sy * cW + cx;
        const o = (y * outW + x) * 4;
        const [r,g,b] = yuvToRgbPixel(pixelData[yi] ?? 0, pixelData[uOff + ci] ?? 128, pixelData[vOff + ci] ?? 128, colorInfo.transfer, colorInfo.primaries);
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
      }
    }
    return imageData;
  }

  if (sampleLayout === 'planar') {
    const p0 = 0;
    const p1 = plane;
    const p2 = plane * 2;
    const p3 = plane * 3;
    for (let y = 0; y < outH; y++) {
      const sy = Math.min(height - 1, y * step);
      for (let x = 0; x < outW; x++) {
        const sx = Math.min(width - 1, x * step);
        const i = sy * width + sx;
        const o = (y * outW + x) * 4;
        if (componentCount >= 3) {
          out[o] = px(pixelData[p0 + i]);
          out[o + 1] = px(pixelData[p1 + i]);
          out[o + 2] = px(pixelData[p2 + i]);
          out[o + 3] = componentCount >= 4 ? px(pixelData[p3 + i]) : 255;
        } else if (componentCount === 2) {
          const v = px(pixelData[i]);
          out[o] = out[o + 1] = out[o + 2] = v;
          out[o + 3] = px(pixelData[plane + i]);
        } else {
          const v = px(pixelData[i]);
          out[o] = out[o + 1] = out[o + 2] = v;
          out[o + 3] = 255;
        }
      }
    }
    return imageData;
  }

  if (componentCount >= 3) {
    const comps = componentCount;
    for (let y = 0; y < outH; y++) {
      const sy = Math.min(height - 1, y * step);
      for (let x = 0; x < outW; x++) {
        const sx = Math.min(width - 1, x * step);
        const si = (sy * width + sx) * comps;
        const o = (y * outW + x) * 4;
        out[o] = px(pixelData[si]);
        out[o + 1] = px(pixelData[si + 1]);
        out[o + 2] = px(pixelData[si + 2]);
        out[o + 3] = componentCount >= 4 ? px(pixelData[si + 3]) : 255;
      }
    }
    return imageData;
  }

  if (componentCount === 2) {
    for (let y = 0; y < outH; y++) {
      const sy = Math.min(height - 1, y * step);
      for (let x = 0; x < outW; x++) {
        const sx = Math.min(width - 1, x * step);
        const si = (sy * width + sx) * 2;
        const o = (y * outW + x) * 4;
        const v = px(pixelData[si]);
        out[o] = out[o + 1] = out[o + 2] = v;
        out[o + 3] = px(pixelData[si + 1]);
      }
    }
    return imageData;
  }

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pixelData.length; i++) {
    const v = pixelData[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = Math.max(1, max - min);
  const monoShift = bitsPerSample <= 8 ? 0 : Math.max(0, Math.ceil(Math.log2(range + 1)) - 8);
  const offset = -min;
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(height - 1, y * step);
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(width - 1, x * step);
      const i = sy * width + sx;
      let v = bitsPerSample <= 8 ? (pixelData[i] & 0xff) : ((pixelData[i] + offset) >> monoShift);
      v = Math.max(0, Math.min(255, v));
      const o = (y * outW + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = v;
      out[o + 3] = 255;
    }
  }
  return imageData;
}
