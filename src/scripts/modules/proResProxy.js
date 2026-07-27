/**
 * proResProxy.js — Shared ProRes / MXF native-host proxy utility.
 *
 * Routes proxy requests through the background bridge to com.postflowx.companion.
 * Exposes two helpers used by every tab that plays local video files:
 *
 *   getProxyStreamUrl(file)              → Promise<{url, sessionId, startTimecode?}>
 *   loadVideoWithProxyFallback(el, file, blobUrl, callbacks)
 */

import { friendlyError, translate } from '../core/friendlyError.js';

// Cache the HTTP port and auth token so concurrent restore calls only ping once.
let _httpPortCached = null;
let _httpTokenCached = null; // shared secret — included in every companion HTTP request
const _HTTP_PORT_TTL = 30000; // ms — re-ping if host hasn't been reached in 30 s
let _httpPortCachedAt = 0;

// Tracks whether the one-time startup cache migration has been triggered.
let _migrationStarted = false;

/** Return the proxy output dir.
 *  Priority: Media Root full path → Project Folder full path → '' (configured but path unknown) → null.
 *
 *  Returns null ONLY when the user has never configured a Media Root/Project Folder at all —
 *  this is the only case that should trigger the "please set Media Root" warning.
 *
 *  Returns '' when Media Root IS configured (via browser FileSystemHandle, pfx_media_root_configured
 *  flag, or previous companion path that was cleared) but no full OS path is available.  The
 *  companion will then store the proxy in its default cache dir rather than blocking the user.
 */
function _explicitOutDir() {
  if (typeof localStorage === 'undefined') return null;
  const mediaRoot = (localStorage.getItem('pfx_media_root_path') || '').trim().replace(/\/+$/, '');
  if (mediaRoot) return `${mediaRoot}/PROXY`;
  const projDir = (localStorage.getItem('pfx_project_dir_path') || '').trim().replace(/\/+$/, '');
  if (projDir) return `${projDir}/PROXY`;
  // Media Root was configured via browser handle (FileSystemDirectoryHandle in IndexedDB)
  // but no native path is available — return '' to suppress the warning and let the
  // companion use its default output directory.
  if (localStorage.getItem('pfx_media_root_configured') === '1') return '';
  return null;
}

/** True when a proxy output directory is configured (full path OR handle-only). */
export function hasProxyOutputDir() {
  return _explicitOutDir() !== null;
}

/**
 * Register every valid proxy in the cache index as a fresh /stream/ session and
 * warm _sharedState.cache.  Skips keys already cached in this context.
 */
async function _warmFromCacheIndex(httpPort, outDir) {
  try {
    const resp = await fetch(`http://127.0.0.1:${httpPort}/cache/list?dir=${encodeURIComponent(outDir)}`, { headers: _tokenHeaders() });
    if (!resp.ok) return;
    const data = await resp.json().catch(() => ({}));
    const entries = Object.entries(data.entries || {});
    for (const [cacheKey, entry] of entries) {
      if (!cacheKey || !entry?.path) continue;
      // Skip legacy pfx_*.mp4 paths — they will be renamed by migration and
      // re-registered by _runStartupMigration._warmFromCacheIndex afterwards.
      // Pre-warming a legacy session and then having migration move the file
      // results in a stale stream URL that silently fails on playback.
      if (_isLegacyProxyPath(entry.path)) continue;
      if (_sharedState.cache.has(cacheKey)) continue; // already warm in this context
      const sessionId = Math.random().toString(36).slice(2, 18);
      try {
        const params = new URLSearchParams({ path: String(entry.path || '') });
        if (entry.startTimecode) params.set('start_timecode', String(entry.startTimecode));
        const r = await fetch(`http://127.0.0.1:${httpPort}/register/${sessionId}?${params.toString()}`, { headers: _tokenHeaders() });
        if (!r.ok) continue;
        const d = await r.json().catch(() => ({}));
        if (d.status !== 'ok') continue;
        _sharedState.cache.set(cacheKey, {
          url: `http://127.0.0.1:${httpPort}/stream/${sessionId}`,
          sessionId,
          cachedAt: Date.now(),
          name: String(entry.name || ''),
          startTimecode: String(entry.startTimecode || ''),
        });
        _persistProxy(
          cacheKey,
          entry.path,
          outDir,
          String(entry.name || ''),
          String(entry.startTimecode || '')
        );
      } catch {}
    }
  } catch {}
}

/** One-shot startup: rename legacy files then warm the in-memory proxy cache. */
async function _runStartupMigration(httpPort) {
  if (_migrationStarted) return;
  _migrationStarted = true;
  try {
    const outDir = (() => {
      return _explicitOutDir();
    })();
    if (!outDir) return;
    await fetch(`http://127.0.0.1:${httpPort}/cache/migrate?dir=${encodeURIComponent(outDir)}`, { headers: _tokenHeaders() });
    // Warm cache after migration so all tabs see proxies immediately on next load.
    await _warmFromCacheIndex(httpPort, outDir);
  } catch {}
}

/**
 * Proactively warm the in-memory proxy cache from the disk cache index.
 * Call this once on page load so proxy URLs are available before video elements
 * are created (avoids the 2-second probe delay on restore).
 */
export async function warmProxyCacheFromStorage() {
  try {
    const outDir = (() => {
      return _explicitOutDir();
    })();
    if (!outDir) return;
    const httpPort = await _getPingPort();
    if (!httpPort) return;
    await _warmFromCacheIndex(httpPort, outDir);
  } catch {}
}

/** Quick HTTP probe — returns true if the companion's HTTP server responds. */
async function _httpAlive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/ping`,
      { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

/**
 * Fetch the shared HTTP auth token from the service worker if we don't have it.
 * The SW holds the token received via the secure native messaging channel.
 * Paths 1 and 2 in _getPingPort skip the SW message so the token can be missing
 * even when the companion is already running — this ensures it's always populated.
 */
async function _ensureToken() {
  if (_httpTokenCached) return;
  try {
    const globalToken = globalThis.__pfxCompanionHttpToken || globalThis.__pfxCompanionHttp?.token || '';
    if (globalToken) {
      _httpTokenCached = String(globalToken);
      return;
    }
  } catch {}
  try {
    await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'PRORES_GET_HTTP_PORT' }, resp => {
        void chrome.runtime.lastError;
        if (resp?.token) {
          _httpTokenCached = resp.token;
          try { globalThis.__pfxCompanionHttpToken = resp.token; } catch {}
        }
        resolve();
      });
    });
  } catch {}
}

async function _getPingPort() {
  const now = Date.now();

  // 1. Validate cached port with a live HTTP check before trusting it.
  //    The companion can restart on a different port; stale caches cause upload 404s.
  if (_httpPortCached && (now - _httpPortCachedAt) < _HTTP_PORT_TTL) {
    if (await _httpAlive(_httpPortCached)) {
      // Token may be absent if companion was already running on page load (path 2
      // was taken on first call and never reached path 3 which sets the token).
      await _ensureToken();
      return _httpPortCached;
    }
    _httpPortCached = null; // stale — companion restarted on a different port
  }

  // 2. Fast path: try the well-known fixed port directly from the page context.
  //    Avoids native messaging round-trip when a companion is already running.
  if (await _httpAlive(47125)) {
    _httpPortCached = 47125;
    _httpPortCachedAt = now;
    if (!_migrationStarted) _runStartupMigration(47125);
    // Token is not fetched by this fast path — request it from the SW now so
    // subsequent authenticated requests (upload, register, cache lookup) don't 403.
    await _ensureToken();
    return 47125;
  }

  // 3. Companion not running yet — ask the SW to start it via native messaging,
  //    then verify the returned port is actually reachable before returning it.
  //    The SW also returns the shared HTTP token (received via the secure native
  //    messaging channel) which we cache and include in all subsequent HTTP requests.
  const { port, token } = await new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ type: 'PRORES_GET_HTTP_PORT' }, resp => {
        void chrome.runtime.lastError;
        resolve({ port: resp?.port ?? null, token: resp?.token ?? null });
      });
    } catch { resolve({ port: null, token: null }); }
  });
  if (token) _httpTokenCached = token;
  if (port && await _httpAlive(port)) {
    _httpPortCached = port;
    _httpPortCachedAt = now;
    if (!_migrationStarted) _runStartupMigration(port);
    return port;
  }
  return null;
}

/** Return fetch init headers containing the shared HTTP token (if known). */
function _tokenHeaders() {
  const token = _httpTokenCached || globalThis.__pfxCompanionHttpToken || globalThis.__pfxCompanionHttp?.token || '';
  if (token && !_httpTokenCached) _httpTokenCached = String(token);
  return token ? { 'X-PFX-Token': String(token) } : {};
}

const _sharedState = (() => {
  try {
    if (globalThis.__PFX_SHARED_PROXY_CACHE_V1) return globalThis.__PFX_SHARED_PROXY_CACHE_V1;
    const seed = {
      cache: new Map(),    // key -> { url, sessionId, cachedAt, name }
      inflight: new Map(), // key -> Promise<{ url, sessionId }>
    };
    globalThis.__PFX_SHARED_PROXY_CACHE_V1 = seed;
    return seed;
  } catch {
    return {
      cache: new Map(),
      inflight: new Map(),
    };
  }
})();

// Cross-tab sync: when another tab persists a new proxy, warm this tab's cache.
if (typeof chrome !== 'undefined' && chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'local') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (!key.startsWith('pfx_proxy_v1:') || !newValue?.outputPath) continue;
      const cacheKey = key.slice('pfx_proxy_v1:'.length);
      if (_sharedState.cache.has(cacheKey)) continue; // already warm in this tab
      _getPingPort().then(port => {
        if (!port) return;
        const sessionId = Math.random().toString(36).slice(2, 18);
        return fetch(`http://127.0.0.1:${port}/register/${sessionId}?path=${encodeURIComponent(newValue.outputPath)}`)
          .then(r => r.ok ? r.json() : null)
          .then(d => {
            if (d?.status !== 'ok') return;
            _sharedState.cache.set(cacheKey, {
              url: `http://127.0.0.1:${port}/stream/${sessionId}`,
              sessionId,
              cachedAt: Date.now(),
              name: String(newValue.name || ''),
            });
          });
      }).catch(() => {});
    }
  });
}

function _proxyMetaOf(fileOrMeta) {
  if (!fileOrMeta || typeof fileOrMeta !== 'object') return null;
  const name = String(fileOrMeta.name || fileOrMeta.fileName || '').trim();
  const size = Number(fileOrMeta.size || 0) || 0;
  const lastModified = Number(fileOrMeta.lastModified || 0) || 0;
  const type = String(fileOrMeta.type || '').trim();
  if (!name && !size && !lastModified && !type) return null;
  return { name, size, lastModified, type };
}

export function getProxyCacheKey(fileOrMeta) {
  const meta = _proxyMetaOf(fileOrMeta);
  if (!meta) return '';
  // MIME type is excluded — it's unreliable (empty on some platforms, "video/quicktime"
  // on others for the same .mov file) and would break cache lookups across sessions.
  // The trailing | is intentional to match existing .pfx_cache.json key format.
  return [
    meta.name.toLowerCase(),
    meta.size,
    meta.lastModified,
    '',
  ].join('|');
}

export function getCachedProxyForFile(fileOrMeta) {
  const key = getProxyCacheKey(fileOrMeta);
  if (!key) return null;
  const hit = _sharedState.cache.get(key);
  return hit?.url ? { ...hit } : null;
}

// ── Persistent disk cache (chrome.storage.local) ──────────────────────────
// Survives extension reload and native host restart when outDir is configured.


function _isLegacyProxyPath(path) {
  try {
    const base = String(path || '').split(/[\/]/).pop() || '';
    return /^pfx(?:_imf)?_[^\\/]+\.mp4$/i.test(base);
  } catch { return false; }
}

function _persistProxy(cacheKey, outputPath, outDir, name = '', startTimecode = '') {
  try {
    chrome.storage.local.set({
      [`pfx_proxy_v1:${cacheKey}`]: {
        outputPath,
        outDir,
        name,
        startTimecode: String(startTimecode || ''),
        savedAt: Date.now(),
      },
    });
  } catch {}
}

async function _tryRestoreFromDisk(cacheKey, outDir, httpPort) {
  const storageKey = `pfx_proxy_v1:${cacheKey}`;
  try {
    const stored = await new Promise(res =>
      chrome.storage.local.get(storageKey, data => res(data || {}))
    );
    const entry = stored?.[storageKey];
    if (!entry?.outputPath || entry.outDir !== outDir) return null;
    if (_isLegacyProxyPath(entry.outputPath)) {
      try { chrome.storage.local.remove(storageKey); } catch {}
      return null;
    }

    const sessionId = Math.random().toString(36).slice(2, 18);
    const params = new URLSearchParams({ path: String(entry.outputPath || '') });
    if (entry.startTimecode) params.set('start_timecode', String(entry.startTimecode));
    const resp = await fetch(
      `http://127.0.0.1:${httpPort}/register/${sessionId}?${params.toString()}`,
      { headers: _tokenHeaders() }
    );
    if (!resp.ok) {
      // File gone — prune stale chrome.storage entry.
      try { chrome.storage.local.remove(storageKey); } catch {}
      return null;
    }
    const data = await resp.json().catch(() => ({}));
    if (data.status !== 'ok') return null;
    return {
      url: `http://127.0.0.1:${httpPort}/stream/${sessionId}`,
      sessionId,
      startTimecode: String(entry.startTimecode || ''),
    };
  } catch { return null; }
}

/** Look up an already-transcoded proxy in the JSON index kept inside outDir.
 *  Returns { url, sessionId, outputPath } on success, or null. */
async function _tryRestoreFromIndex(cacheKey, outDir, httpPort, fileMeta = null) {
  try {
    const sessionId = Math.random().toString(36).slice(2, 18);
    let url = `http://127.0.0.1:${httpPort}/cache/lookup/${sessionId}` +
      `?key=${encodeURIComponent(cacheKey)}&dir=${encodeURIComponent(outDir)}`;
    const origName = String(fileMeta?.name || '').trim();
    if (origName) url += `&orig_name=${encodeURIComponent(origName)}`;
    const resp = await fetch(url, { headers: _tokenHeaders() });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => ({}));
    if (!data.found) return null;
    const outputPath = String(data.outputPath || '');
    if (_isLegacyProxyPath(outputPath)) return null;
    return {
      url: `http://127.0.0.1:${httpPort}/stream/${sessionId}`,
      sessionId,
      outputPath,
      name: String(data.name || ''),
      startTimecode: String(data.startTimecode || ''),
    };
  } catch { return null; }
}

function _setCachedProxyForFile(fileOrMeta, payload) {
  const key = getProxyCacheKey(fileOrMeta);
  if (!key || !payload?.url) return null;
  const next = {
    url: String(payload.url || ''),
    sessionId: String(payload.sessionId || ''),
    cachedAt: Date.now(),
    name: String(fileOrMeta?.name || payload?.name || ''),
    startTimecode: String(payload?.startTimecode || ''),
  };
  _sharedState.cache.set(key, next);
  return { ...next };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Upload a File to the native host's local HTTP server and get a streamable
 * H.264 URL back. The server transcodes asynchronously; progress is polled
 * via /progress/:sessionId and reported via the onProgress callback.
 *
 * @param {File} file
 * @param {object} [options]
 *   onProgress(pct)  Called with 0-100 as transcode progresses
 * @returns {Promise<{url: string, sessionId: string, startTimecode?: string}>}
 */
export async function getProxyStreamUrl(file, { onProgress } = {}) {
  const cached = getCachedProxyForFile(file);
  if (cached?.url) {
    onProgress?.(100);
    return { ...cached, cached: true };
  }

  const cacheKey = getProxyCacheKey(file);
  if (cacheKey && _sharedState.inflight.has(cacheKey)) {
    return _sharedState.inflight.get(cacheKey);
  }

  const run = (async () => {
    // Port comes from the background bridge — no direct connectNative from page.
    const httpPort = await _getPingPort();
    if (!httpPort) throw new Error('host_unavailable');

    const outDir = (() => {
      return _explicitOutDir();
    })();

    // Try to restore an already-transcoded proxy (JSON index → chrome.storage fallback).
    if (outDir && cacheKey) {
      const fromIndex = await _tryRestoreFromIndex(cacheKey, outDir, httpPort, file);
      if (fromIndex?.url) {
        onProgress?.(100);
        if (fromIndex.outputPath) {
          _persistProxy(
            cacheKey,
            fromIndex.outputPath,
            outDir,
            String(fromIndex.name || ''),
            String(fromIndex.startTimecode || '')
          );
        }
        const r = _setCachedProxyForFile(file, fromIndex) || fromIndex;
        return { ...r, cached: true };
      }
      const fromDisk = await _tryRestoreFromDisk(cacheKey, outDir, httpPort);
      if (fromDisk?.url) {
        onProgress?.(100);
        const r = _setCachedProxyForFile(file, fromDisk) || fromDisk;
        return { ...r, cached: true };
      }
    }

    const sessionId = Math.random().toString(36).slice(2, 18);
    const _up = new URLSearchParams();
    if (outDir)    _up.set('out_dir',   outDir);
    if (cacheKey)  _up.set('cache_key', cacheKey);
    if (file?.name) _up.set('orig_name', file.name);
    const uploadUrl = `http://127.0.0.1:${httpPort}/upload/${sessionId}` +
      (_up.toString() ? `?${_up.toString()}` : '');

    const uploadResp = await fetch(uploadUrl, {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': file?.type || 'video/quicktime', ..._tokenHeaders() },
    });
    if (!uploadResp.ok) throw new Error(`upload_failed_${uploadResp.status}`);
    const uploadData = await uploadResp.json().catch(() => ({}));
    const outputPath = String(uploadData?.outputPath || '');

    // Poll progress endpoint until transcode is done.
    // If /progress/ returns 404 the host is an older build that blocks on upload —
    // the stream is already ready, so resolve immediately and skip polling.
    const progressUrl = `http://127.0.0.1:${httpPort}/progress/${sessionId}`;
    let startTimecode = '';
    await new Promise((resolve, reject) => {
      // Hard cap: reject if transcode hasn't finished within 30 minutes.
      const totalTimer = setTimeout(() => reject(new Error('transcode_timeout')), 30 * 60 * 1000);
      const poll = async () => {
        // Per-fetch timeout: if the companion stops responding (hangs without crashing),
        // fetch() never rejects and the loop runs forever. 10 s is generous for a status check.
        const ctrl = new AbortController();
        // Abort with a *named* TimeoutError rather than a bare abort(). A bare
        // one rejects with "The user aborted a request." — the same text the DOM
        // gives when someone dismisses a file picker — so nothing downstream can
        // tell a hung companion from a user who changed their mind.
        const fetchTimer = setTimeout(
          () => ctrl.abort(new DOMException('the media helper timed out', 'TimeoutError')),
          10_000,
        );
        try {
          const r = await fetch(progressUrl, { signal: ctrl.signal, headers: _tokenHeaders() });
          clearTimeout(fetchTimer);
          if (r.status === 404) { clearTimeout(totalTimer); resolve(); return; }   // old host — already done
          if (!r.ok) { clearTimeout(totalTimer); reject(new Error('progress_fetch_failed')); return; }
          const data = await r.json();
          if (data.error) { clearTimeout(totalTimer); reject(new Error(data.error)); return; }
          if (data.startTimecode) startTimecode = String(data.startTimecode || '');
          onProgress?.(Math.max(0, Math.min(100, data.pct || 0)));
          if (data.done) { clearTimeout(totalTimer); resolve(); return; }
          setTimeout(poll, 400);
        } catch (e) { clearTimeout(fetchTimer); clearTimeout(totalTimer); reject(e); }
      };
      poll();
    });

    const result = {
      url: `http://127.0.0.1:${httpPort}/stream/${sessionId}`,
      sessionId,
      startTimecode,
    };
    // Persist to disk cache so the proxy survives extension reload / host restart.
    if (outDir && outputPath && cacheKey) {
      _persistProxy(cacheKey, outputPath, outDir, String(file?.name || ''), startTimecode);
    }
    return _setCachedProxyForFile(file, result) || result;
  })();

  if (cacheKey) _sharedState.inflight.set(cacheKey, run);
  try {
    return await run;
  } finally {
    if (cacheKey) _sharedState.inflight.delete(cacheKey);
  }
}

/**
 * Attempt to restore an already-transcoded proxy from the proxy output folder
 * without uploading/re-transcoding the source file.  Accepts either a real File
 * object or a plain metadata object { name, size, lastModified, type }.
 * Returns { url, sessionId } on success, or null if not recoverable.
 *
 * @param {File|{name,size,lastModified,type}} fileOrMeta
 * @returns {Promise<{url:string,sessionId:string}|null>}
 */
export async function tryRestoreProxyForMeta(fileOrMeta) {
  const cached = getCachedProxyForFile(fileOrMeta);
  if (cached?.url) return cached;

  const cacheKey = getProxyCacheKey(fileOrMeta);
  if (!cacheKey) return null;

  const outDir = _explicitOutDir();
  if (!outDir) return null;

  try {
    const httpPort = await _getPingPort();
    if (!httpPort) return null;
    // JSON index first (fast, self-contained in output folder)
    const fromIndex = await _tryRestoreFromIndex(cacheKey, outDir, httpPort, fileOrMeta);
    if (fromIndex?.url) {
      if (fromIndex.outputPath) {
        _persistProxy(
          cacheKey,
          fromIndex.outputPath,
          outDir,
          String(fromIndex.name || ''),
          String(fromIndex.startTimecode || '')
        );
      }
      return _setCachedProxyForFile(fileOrMeta, fromIndex) || fromIndex;
    }
    // Fallback: chrome.storage.local + /register
    const fromDisk = await _tryRestoreFromDisk(cacheKey, outDir, httpPort);
    if (!fromDisk?.url) return null;
    return _setCachedProxyForFile(fileOrMeta, fromDisk) || fromDisk;
  } catch { return null; }
}

// ── Why a proxy build failed, in words that are true ─────────────────────────
//
// This was a three-branch ternary whose default asserted "unsupported codec".
// Measured against every way getProxyStreamUrl can reject, that default was
// wrong five times out of six: the 30-minute cap (transcode_timeout), a
// companion that stops answering mid-poll (the 10 s per-fetch abort above), a
// non-OK progress response (progress_fetch_failed), a failed upload
// (upload_failed_NNN), and whatever ffmpeg itself reported (data.error) are
// every one of them something other than the codec. "Unsupported codec" sends a
// colourist off to re-transcode a plate that was never the problem — an hour of
// wasted work in answer to a companion that needed restarting.
//
// Each pattern below is a rejection thrown by name in this file or handed over
// by the companion in data.error; proResProxyFailure.test.mjs reads both sets
// of tokens back out of the source, so a token that starts being thrown
// without a rule fails the build rather than reaching a user as a guess.
// input_missing is the one worth naming: it means the plate moved after the
// job was queued, which is a thing the user can actually fix in ten seconds.
//
// The strings are thunks, not values: translate() reads the language the user
// has chosen *now*, and this table is built at module load, before there is one.
const _PROXY_FAIL_REASONS = [
  [/ffmpeg_missing/,                () => translate('ffmpeg not found on this machine')],
  [/input_missing|file_not_found/,  () => translate('the source file could not be found — it may have moved')],
  [/host_unavailable|host_timeout/, () => translate('native helper not available (Browser Mode only)')],
  [/transcode_timeout/,             () => translate('the conversion took too long and was stopped')],
  [/progress_fetch_failed|timed out|\bTimeoutError\b/i,
                                    () => translate('the media helper stopped responding')],
  [/upload_failed_/,                () => translate('the file could not be handed to the media helper')],
];

/**
 * One line, never two. Every onProxyFail consumer writes this into a one-line
 * status element whose CSS this module does not own, so friendlyStatus — which
 * puts its hint on a second line — is the wrong tool here and friendlyError,
 * which hands back the parts separately, is the right one.
 *
 * Exported only so tests-js/proResProxyFailure.test.mjs can hand it the real
 * rejections instead of standing up a <video> and a companion to reach them.
 *
 * @param {unknown} err  Whatever getProxyStreamUrl rejected with.
 * @returns {string} A clause that can follow "<filename> — ".
 */
export function _proxyFailReason(err) {
  // Name first, the way friendlyError's corpus is written ("TimeoutError: signal
  // timed out"). A DOMException carries the useful half of its identity in .name
  // — reading only .message throws that away and leaves a TimeoutError looking
  // like any other string.
  const name = err?.name && err.name !== 'Error' ? `${err.name}: ` : '';
  const msg = `${name}${err?.message || err || ''}`.trim();
  for (const [re, say] of _PROXY_FAIL_REASONS) {
    if (re.test(msg)) return say();
  }
  // Whatever the companion or the browser said for itself. friendlyError knows
  // the disk-full, permission and network cases and will say them plainly; when
  // it recognises nothing it answers with an empty title, and then the only
  // honest thing left to report is that the conversion did not happen.
  const f = friendlyError(msg);
  return f.title ? f.message : translate('this file could not be converted for preview');
}

/**
 * Wire a <video> element so that if the direct blob URL fails to decode
 * (ProRes, MXF, DNxHD…) the file is automatically proxied through the
 * native helper and the element's src is replaced with a playable H.264 URL.
 *
 * @param {HTMLVideoElement} videoEl
 * @param {File} file           The original File object
 * @param {string} blobUrl      The blob: URL already set on videoEl.src
 * @param {object} callbacks
 *   onProxying()               Called when proxy attempt starts
 *   onProxySuccess(streamUrl)  Called when stream URL is ready
 *   onProxyFail(hint)          Called with user-readable error string
 */
export function loadVideoWithProxyFallback(videoEl, file, blobUrl, {
  onProxying = null,
  onProgress = null,
  onProxySuccess = null,
  onProxyFail = null,
  onNoOutputDir = null,   // fired when Media Root / Project Folder is not configured
} = {}) {
  if (!videoEl || !file) return;

  // Browser-native formats never need a proxy — Chrome decodes them directly.
  if (/\.(mp4|m4v|webm|mkv|avi|ogv)$/i.test(file.name || '')) return;

  // _pfxLoadToken may already have been bumped by attachPlayableVideo; only increment
  // if it hasn't changed since the last call so we don't double-count.
  const loadToken = (videoEl._pfxLoadToken = (videoEl._pfxLoadToken || 0) + 1);
  videoEl._pfxProxyAttempted = false;
  const cached = getCachedProxyForFile(file);
  if (cached?.url) {
    onProgress?.(100);
    videoEl.src = cached.url;
    videoEl.load();
    videoEl._pfxProxySessionId = cached.sessionId || '';
    onProxySuccess?.(cached.url);
    return;
  }

  const tryProxy = async () => {
    if (videoEl._pfxLoadToken !== loadToken || videoEl._pfxProxyAttempted) return;
    videoEl._pfxProxyAttempted = true;
    // Warn only when Media Root has NEVER been configured (null).
    // An empty string means "configured but path unknown" — proceed without blocking.
    if (_explicitOutDir() === null) {
      onNoOutputDir?.();
      return;
    }
    onProxying?.();
    try {
      const { url: streamUrl, sessionId } = await getProxyStreamUrl(file, { onProgress });
      if (videoEl._pfxLoadToken !== loadToken) {
        // Load was superseded — clean up orphaned session
        chrome.runtime.sendMessage({ type: 'IMF_COMPANION_CALL', payload: { action: 'stopPlayback', sessionId }, timeoutMs: 5000 }).catch(() => {});
        return;
      }
      videoEl.src = streamUrl;
      videoEl.load();
      videoEl._pfxProxySessionId = sessionId;
      onProxySuccess?.(streamUrl);
    } catch (e) {
      const label = file?.name || 'Clip';
      onProxyFail?.(`${label} — ${_proxyFailReason(e)}`);
    }
  };

  // Trigger on hard error (e.g. container not recognised at all)
  videoEl.addEventListener('error', () => {
    if (videoEl._pfxLoadToken !== loadToken) return;
    tryProxy();
  }, { once: true });

  // Probe for all file types — Chrome often shows black without an error event
  // for ProRes (.mov) and MXF. Check after 2 s if we still have no video.
  let probeTimer = setTimeout(() => {
    if (videoEl._pfxLoadToken !== loadToken) return;
    const isBlindMov = (videoEl.videoWidth || 0) === 0 && /\.mov$/i.test(file?.name || '');
    const noMeta = !Number.isFinite(videoEl.duration) || videoEl.readyState === 0;
    if (noMeta || isBlindMov) tryProxy();
  }, 2000);

  // Track the timer on the element so _teardownElement or a subsequent
  // attachPlayableVideo call can cancel it even if loadedmetadata never fires.
  if (!videoEl._pfxProbeTimers) videoEl._pfxProbeTimers = [];
  videoEl._pfxProbeTimers.push(probeTimer);

  videoEl.addEventListener('loadedmetadata', () => {
    if (videoEl._pfxLoadToken !== loadToken) { clearTimeout(probeTimer); return; }
    clearTimeout(probeTimer);
    // Still check for ProRes playing audio-only (videoWidth 0 with valid duration)
    const isBlindMov = (videoEl.videoWidth || 0) === 0 && /\.mov$/i.test(file?.name || '');
    if (isBlindMov) tryProxy();
  }, { once: true });
}
