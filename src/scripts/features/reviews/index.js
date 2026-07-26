// PostFlowX – VFX Reviews Tab (H.264-only)
// Virtual Timeline: multi-clip playback + scrub + markers on a single combined timeline.

import { ReviewsStore, secondsToClock } from './store.js';
import { ReviewPlayer } from './player.js';
import { createTimeline } from './timeline.js';
import { analyzeClipForSceneCutDetect } from './autoCut.js';
import { createZoomModeControl, ZOOM_MODE } from '../../core/zoomModeMenu.js';
import { buildImportedTimelineFromEvents, getSeqBaseFrames } from '../../core/timelineModel.js';
import { getProxyStreamUrl, tryRestoreProxyForMeta } from '../../modules/proResProxy.js';
import { sharedMediaOpen, sharedMediaGetFrame } from '../../modules/native_helper_client.js';

const AUTO_CUT_IGNORE_PRESETS = {
  none: [],
  watermark_top: [
    { x: 0.28, y: 0.08, w: 0.44, h: 0.12, enabled: true },
  ],
  burnin_ll: [
    { x: 0.00, y: 0.82, w: 0.34, h: 0.18, enabled: true },
  ],
  bottom_wide: [
    { x: 0.00, y: 0.82, w: 1.00, h: 0.18, enabled: true },
  ],
  common_overlays: [
    { x: 0.28, y: 0.08, w: 0.44, h: 0.12, enabled: true },
    { x: 0.00, y: 0.82, w: 0.34, h: 0.18, enabled: true },
    { x: 0.68, y: 0.82, w: 0.32, h: 0.18, enabled: true },
  ],
};

const normalizeIgnorePresetRegions = (regions = []) => (Array.isArray(regions) ? regions : []).map((r) => ({
  x: Number(r?.x) || 0,
  y: Number(r?.y) || 0,
  w: Number(r?.w) || 0,
  h: Number(r?.h) || 0,
  enabled: r?.enabled !== false,
})).filter((r) => r.enabled !== false && r.w > 0 && r.h > 0);

const detectAutoCutIgnorePreset = (regions = []) => {
  const current = JSON.stringify(normalizeIgnorePresetRegions(regions));
  for (const [key, value] of Object.entries(AUTO_CUT_IGNORE_PRESETS)) {
    if (JSON.stringify(normalizeIgnorePresetRegions(value)) === current) return key;
  }
  return current === '[]' ? 'none' : 'custom';
};

const SCENE_CUT_SENS_KEY = 'pfx.reviews.sceneCutSensitivity';
const clampSceneCutSensitivity = (value) => Math.max(0, Math.min(100, parseInt(String(value ?? 60), 10) || 60));
const readSceneCutSensitivity = () => {
  try { return clampSceneCutSensitivity(localStorage.getItem(SCENE_CUT_SENS_KEY)); } catch { return 60; }
};
const writeSceneCutSensitivity = (value) => {
  const next = clampSceneCutSensitivity(value);
  try { localStorage.setItem(SCENE_CUT_SENS_KEY, String(next)); } catch {}
  return next;
};

import { getStoredMediaRootDir, pickMediaRootDirByUser, clearMediaRootDir, kvSet, kvGet } from '../../core/projectFile.js';
import { createRadialMenu, RadialIcons } from '../../components/radialMenu/index.js';
import { openAnnotateModal as openPfxAnnotateModal } from '../../components/annotateModal/index.js';
import { openBurninSetupModal } from '../../components/burninSetupModal/index.js';
import { openVisualQcModal } from '../../components/visualQcModal/index.js';
import { iconSvg, setIconButton, setLabeledIcon, setPlayPauseIconButton, setTimelineFitToggleButton } from '../../core/iconButtons.js';
import { resolveShortcutAction, getShortcutsConfig } from '../../core/shortcuts.js';
import { SAVED, CANCELLED, UNAVAILABLE, isUserCancel, runSaveCascade } from '../../core/saveOutcome.js';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function downloadText(filename, text, mime = 'text/plain') {
  // Legacy fallback (works in most browsers), but can be blocked in some
  // enterprise Chrome setups or lose user-activation depending on timing.
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadTextViaChromeDownloads(filename, text, mime='text/plain'){
  // Most reliable path for extensions (manifest already has "downloads").
  // Uses Save As to avoid silent failures / blocked auto-download.
  try{
    const dl = (globalThis.chrome && chrome.downloads && chrome.downloads.download) ? chrome.downloads : null;
    if (!dl) return UNAVAILABLE;

    // Use a data URL (small payload) to avoid blob URL lifetime issues.
    const charset = 'utf-8';
    const url = `data:${mime};charset=${charset},${encodeURIComponent(String(text ?? ''))}`;

    const downloadId = await new Promise((resolve, reject) => {
      dl.download({
        url,
        filename,
        saveAs: true,
        conflictAction: 'uniquify',
      }, (id) => {
        const err = chrome.runtime?.lastError;
        if (err) return reject(err);
        resolve(id);
      });
    });

    return downloadId ? SAVED : UNAVAILABLE;
  }catch(err){
    // chrome.runtime.lastError is "USER_CANCELED" when the Save As dialog is
    // dismissed — in real Chrome and, since the download shim was made
    // faithful to it, in the desktop app too.
    return isUserCancel(err) ? CANCELLED : UNAVAILABLE;
  }
}

// Prefer a real "Save As…" dialog when available (more reliable than auto-download
// in some Chrome setups, and lets users choose location).
async function saveTextViaPicker(filename, text, mime = 'text/plain'){
  try{
    if (typeof window.showSaveFilePicker !== 'function') return UNAVAILABLE;
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const picker = await window.showSaveFilePicker({
      suggestedName: filename,
      types: [{
        description: ext.toUpperCase() || 'File',
        accept: { [mime]: [ext ? `.${ext}` : ''] },
      }],
    });
    const w = await picker.createWritable();
    await w.write(new Blob([text], { type: mime }));
    await w.close();
    return SAVED;
  }catch(err){
    // Dismissing the picker rejects with AbortError. That is the user saying
    // no, not this route being unusable.
    return isUserCancel(err) ? CANCELLED : UNAVAILABLE;
  }
}

async function downloadOrSaveText(filename, text, mime='text/plain'){
  // Must be called from a user gesture (click) for best reliability.
  //
  // Tier 3 has no dialog: it drops the file into Downloads and says nothing.
  // That is a fine last resort when no other route exists, and completely wrong
  // as a response to someone pressing Cancel — which is what it used to be,
  // because every tier reported cancel and unavailable as the same `false`.
  // runSaveCascade stops on a cancel; only an unavailable route falls through.
  return runSaveCascade([
    // 1) Chrome downloads API (extension-reliable, supports Save As).
    () => downloadTextViaChromeDownloads(filename, text, mime),
    // 2) File System Access picker (also user-controlled).
    () => saveTextViaPicker(filename, text, mime),
    // 3) Anchor download — always available, so the cascade ends here.
    () => { downloadText(filename, text, mime); return SAVED; },
  ]);
}

function clampTcInput(v) {
  const s = String(v || '').trim();
  if (/^\d{2}:\d{2}:\d{2}:\d{2}$/.test(s)) return s;
  return '00:00:00:00';
}

/**
 * Mount VFX Reviews Tab
 * @param {HTMLElement} mount
 * @returns {{destroy:()=>void, store: ReviewsStore}}
 */
export function mountVfxReviewsTab(mount) {
  const store = new ReviewsStore();

  // Prevent a blank tab if init throws before we append DOM.
  // Render a lightweight boot/error panel immediately, then remove it once mounted.
  try { mount.textContent = ''; } catch {}
  const __boot = el('div', 'pfx-reviews-boot');
  __boot.innerHTML = `
    <div class="pfx-reviews-bootCard">
      <div class="t">VISUAL QC</div>
      <div class="s">Loading…</div>
      <div class="h">If this hangs, open <b>chrome://extensions</b> → <b>Errors</b> for details.</div>
      <div class="a">
        <button class="btn theme-q2" type="button" data-act="retry"><span class="bar"></span>Retry</button>
        <button class="btn theme-amf" type="button" data-act="reset"><span class="bar"></span>Reset Visual QC</button>
      </div>
      <pre class="pfx-reviews-bootErr" style="display:none"></pre>
    </div>
  `;
  try { mount.appendChild(__boot); } catch {}

  const __setBootError = (err) => {
    try{
      const s = __boot.querySelector('.s');
      if (s) s.textContent = 'Failed to initialize.';
      const pre = __boot.querySelector('.pfx-reviews-bootErr');
      if (pre) {
        pre.style.display = 'block';
        pre.textContent = String(err?.stack || err?.message || err || 'Unknown error');
      }
    }catch{}
  };

  const __resetVisualQc = async () => {
    // Clear only Reviews/VisualQC-related persisted keys (best-effort).
    // This fixes cases where a corrupted autosave snapshot prevents boot.
    try{
      // LocalStorage autosave keys
      const keys = [];
      try{
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k) continue;
          if (k.startsWith('pfx.reviews.autosave.v1.')) keys.push(k);
        }
      }catch{}
      keys.forEach(k => { try{ localStorage.removeItem(k); }catch{} });
      try{ localStorage.removeItem('pfx.reviews.autosave.lastKey.v1'); }catch{}
      try{ localStorage.removeItem('pfx.reviews.autosave.lastSnapshot.v1'); }catch{}

      // IndexedDB KV autosave keys (kvSet sets null; kvDel isn't a hard delete)
      try{ await kvSet('reviews.autosave.lastKey.v1', null); }catch{}
      try{ await kvSet('reviews.autosave.lastSnapshot.v1', null); }catch{}
      try{
        const pn = (document.getElementById('projectNameGlobal')?.value || '').trim() || 'Project';
        const safe = pn.replace(/\s+/g,'_').replace(/[^a-zA-Z0-9._-]/g,'_').replace(/_+/g,'_').replace(/^_+|_+$/g,'') || 'Project';
        await kvSet(`reviews.autosave.v1.${safe}`, null);
      }catch{}

      // Media handle snapshots
      try{ await kvSet('reviews.mediaHandles.lastKey.v1', null); }catch{}
      try{ await kvSet('reviews.mediaHandles.lastSnapshot.v1', null); }catch{}
      try{
        const pn2 = (document.getElementById('projectNameGlobal')?.value || '').trim() || 'Project';
        const safe2 = pn2.replace(/\s+/g,'_').replace(/[^a-zA-Z0-9._-]/g,'_').replace(/_+/g,'_').replace(/^_+|_+$/g,'') || 'Project';
        await kvSet(`reviews.mediaHandles.v1.${safe2}`, null);
      }catch{}
    }catch{}
    try{ location.reload(); }catch{}
  };

  try{
    __boot.addEventListener('click', (e) => {
      const btn = e?.target?.closest?.('button[data-act]');
      const act = btn?.getAttribute?.('data-act');
      if (!act) return;
      e.preventDefault();
      e.stopPropagation();
      if (act === 'reset') { __resetVisualQc(); return; }
      if (act === 'retry') { try{ location.reload(); }catch{} return; }
    });
  }catch{}

  // Declared here so it's accessible throughout mountVfxReviewsTab.
  // The implementation is assigned inside the try block below where buildIndexIfNeeded is in scope.
  let tryRelinkFromMediaRoot = async () => ({ ok:false, reason:'not_ready' });

  try{

  // ---------- Media relink (after refresh / project load) ----------
  const buildIndexIfNeeded = async (dir) => {
    try{
      const existing = window.__PFX_MEDIA_INDEX;
      // Prefer Settings→Media Manager scan, if present for this root.
      if (existing && existing.rootName === (dir?.name || '') && (existing.exact || existing.stem)) return existing;
    }catch{}

    // Fallback: build a smaller smart index locally (same structure as Settings).
    const scan = window.__PFX_MEDIA_SCAN;
    if (typeof scan === 'function'){
      const out = await scan(dir, { maxFiles: 6000 }).catch(()=>null);
      if (!out) return null;
      const idx = { exact: out.exact, stem: out.stem, norm: out.norm, count: out.count, at: Date.now(), rootName: dir?.name || '' };
      try{ window.__PFX_MEDIA_INDEX = idx; }catch{}
      try{ window.__PFX_MEDIA_FIND = window.__PFX_MEDIA_FIND || ((n)=>{
        try{
          const q = String(n||'').toLowerCase();
          return idx.exact?.get?.(q) || idx.stem?.get?.(q) || idx.norm?.get?.(q) || null;
        }catch{ return null; }
      }); }catch{}
      return idx;
    }

    // Last resort: minimal exact-name + stem + prefix map (video files only).
    // Only video files are indexed so large media folders with thousands of non-video
    // files don't exhaust the limit before reaching the subfolder that contains clips.
    const VIDEO_EXTS = new Set(['.mp4','.mov','.mxf','.m4v','.avi','.mkv','.webm','.mpg','.mpeg','.ts','.mts','.m2ts']);
    const isVideoName = (n) => { const d = n.lastIndexOf('.'); return d >= 0 && VIDEO_EXTS.has(n.slice(d).toLowerCase()); };
    const exact = new Map();
    const stem = new Map();
    // prefix: each file stem maps back from any prefix of length ≥ 8
    // so clip "LMP_001_030" matches file "LMP_001_030_v082_HDCAM.mp4"
    const pfx = new Map();
    let count = 0;
    const maxFiles = 20000; // count only video files, so this is safe
    const walk = async (d, prefix='') => {
      // eslint-disable-next-line no-undef
      for await (const [name, h] of d.entries()){
        if (!h) continue;
        if (h.kind === 'directory'){
          if (count < maxFiles) await walk(h, prefix + name + '/');
          continue;
        }
        if (h.kind === 'file'){
          // Skip non-video files entirely — don't count them against the limit
          if (!isVideoName(name)) continue;
          if (count >= maxFiles) continue;
          count++;
          const k = String(name || '').toLowerCase();
          const entry = { handle: h, path: prefix + name, lastModified: 0, size: 0 };
          if (k && !exact.has(k)) exact.set(k, entry);
          // stem: strip extension
          const s = k.replace(/\.[^.]+$/, '');
          if (s && s !== k && !stem.has(s)) stem.set(s, entry);
          // prefix map: any prefix of stem length ≥ 8 → this file
          // allows "LMP_001_030" (clip name) to match "LMP_001_030_v082_extra.mp4" (filename)
          if (s && s.length >= 8) {
            for (let i = 8; i <= s.length; i++) {
              const p = s.slice(0, i);
              if (!pfx.has(p)) pfx.set(p, entry);
            }
          }
        }
      }
    };
    try{ await walk(dir, ''); }catch{}
    console.log('[PFX RELINK] buildIndex: scanned', count, 'video files, exact=', exact.size, 'stem=', stem.size, 'pfx=', pfx.size);
    const idx = { exact, stem, pfx, norm: new Map(), count, at: Date.now(), rootName: dir?.name || '' };
    try{ window.__PFX_MEDIA_INDEX = idx; }catch{}
    return idx;
  };

  tryRelinkFromMediaRoot = async () => {
    try{
      const dir = await getStoredMediaRootDir();
      console.log('[PFX RELINK] tryRelinkFromMediaRoot: dir=', dir?.name ?? null);
      if (!dir) return { ok:false, reason:'no_root' };
      const idx = await buildIndexIfNeeded(dir);
      console.log('[PFX RELINK] tryRelinkFromMediaRoot: idx.count=', idx?.count, 'exact.size=', idx?.exact?.size);
      if (!idx) return { ok:false, reason:'no_index' };
      const finder = window.__PFX_MEDIA_FIND;

      const clips = store.state.clips || [];
      console.log('[PFX RELINK] tryRelinkFromMediaRoot: clips.length=', clips.length);
      let relinked = 0;
      for (const c of clips){
        if (!c) continue;
        const _u = String(c?.url || '');
        const _needsRelink = (!_u) || (_u.startsWith('blob:') && !c?.file) || (c?.canPlay === false);
        const key = String(c?.fileMeta?.name || c?.name || '').trim();
        console.log('[PFX RELINK]   clip', c.id, 'needsRelink=', _needsRelink, 'key=', key);
        if (!_needsRelink) continue;
        if (!key) continue;
        const keyLow = key.toLowerCase();
        const keyStem = keyLow.replace(/\.[^.]+$/, '');
        const hit = (typeof finder === 'function')
          ? finder(key)
          : (idx.exact?.get?.(keyLow)
             || idx.stem?.get?.(keyLow)
             || idx.stem?.get?.(keyStem)
             // prefix fallback: clip name "LNR_DL1_001" matches file "LNR_DL1_001_2K_extra.mp4"
             || (keyStem.length >= 8 ? (idx.pfx?.get?.(keyStem) || null) : null)
             || null);
        console.log('[PFX RELINK]   hit=', hit ? hit.path : null, 'keyLow=', keyLow, 'keyStem=', keyStem);
        if (!hit?.handle) continue;

        try{
          const f = await hit.handle.getFile();
          try{ if (c.url) { try{ URL.revokeObjectURL(c.url); }catch(_){} } }catch(_){}
          const url = URL.createObjectURL(f);
          store.updateClip(c.id, {
            file: f,
            url,
            canPlay: true,
            fileMeta: {
              name: f.name || c?.name || 'Untitled',
              size: Number(f.size) || 0,
              lastModified: Number(f.lastModified) || 0,
              type: String(f.type || ''),
            }
          });
          relinked++;
          console.log('[PFX RELINK]   RELINKED', c.id, f.name);
        }catch(e){ console.warn('[PFX RELINK]   getFile FAILED', c.id, e?.message); }
      }
      console.log('[PFX RELINK] tryRelinkFromMediaRoot: done relinked=', relinked);
      if (relinked > 0) {
        // Propagate fresh URLs into any overlay that references a just-relinked clip.
        // overlay.url is a stale blob from creation time; syncOverlayToState now resolves
        // from live clip, but updating overlay.url ensures getPlaybackAtTime also returns fresh.
        try{
          const clips = store.state.clips || [];
          const urlByClipId = new Map(clips.filter(c => c?.url).map(c => [c.id, c.url]));
          let ovlUpdated = false;
          const nextOverlays = (store.state.overlays || []).map(o => {
            if (!o?.clipId) return o;
            const freshUrl = urlByClipId.get(o.clipId);
            if (freshUrl && freshUrl !== o.url) { ovlUpdated = true; return { ...o, url: freshUrl, canPlay: true }; }
            return o;
          });
          if (ovlUpdated) store.set({ overlays: nextOverlays }, 'overlays');
        }catch{}
        try{ store.emit('clips'); }catch{}
        try{ refreshClipsList(); }catch{}
        try{ syncOverlayToState('relink'); }catch{}
        try{
          const first = (store.state.clips||[]).find(c => c.canPlay !== false && c.url);
          if (first) {
            loadSourceClip({ clipId: first.id, name: first.name, url: first.url, startTC: first.startTC||'00:00:00:00' }, 0, { pin: true });
          }
        }catch{}
        try{
          status.textContent = `Relinked ${relinked} clip${relinked===1?'':'s'}`;
        }catch{}
      }
      return { ok:true, relinked, scanned: idx.count || 0 };
    }catch(err){
      // NotFoundError means the stored directory handle is stale (folder moved/deleted).
      // Clear it so we stop triggering this error on every load.
      if (err?.name === 'NotFoundError' || String(err?.message || '').toLowerCase().includes('not found')){
        try{ await clearMediaRootDir(); }catch{}
      }
      console.log('[PFX RELINK] tryRelinkFromMediaRoot:', err?.name || 'error', err?.message);
      return { ok:false, reason:'error', error:String(err?.message || err) };
    }
  };

  // Expose project save/load hooks (Project Storage v4)
  try{
    window.PFX_exportReviewsState = () => {
      const ui = {
        // best-effort UI flags (panels/view modes)
        oneView: !!document.body.classList.contains('pfx-reviews-oneView'),
        panelsHidden: !!document.body.classList.contains('pfx-reviews-panelsHidden'),
        layout: {
          // Persist viewer layout across refresh/project load
          splitRatio: (()=>{ try{ const v = parseFloat(localStorage.getItem('pfx.reviews.splitRatio')||''); return isFinite(v) ? v : null; }catch{ return null; } })(),
          viewersFrac: (()=>{ try{ const v = parseFloat(localStorage.getItem('pfx.reviews.viewersHeightFrac')||''); return isFinite(v) ? v : null; }catch{ return null; } })(),
          binW: (()=>{ try{ const v = parseInt(localStorage.getItem('pfx.reviews.binWidth')||'', 10); return isFinite(v) ? v : null; }catch{ return null; } })(),
        },
      };
      return {
        schema: 'pfx_reviews',
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        state: store.exportState(),
        ui,
      };
    };
    window.PFX_applyReviewsState = (saved) => {
      // If the project has no review data (null/undefined), reset to an empty state so
      // clips and video from a previously-loaded project are cleared rather than left stale.
      const payload = (saved && saved.state) ? saved.state : (saved && typeof saved === 'object' ? saved : {});
      store.importState(payload);
      // UI flags best-effort
      try{
        const ui = saved?.ui || null;
        if (ui && typeof ui === 'object'){
          document.body.classList.toggle('pfx-reviews-oneView', !!ui.oneView);
          document.body.classList.toggle('pfx-reviews-panelsHidden', !!ui.panelsHidden);
          // Restore viewer layout (bin width + source/timeline split)
          try{
            const layout = ui.layout || null;
            if (layout && typeof layout === 'object'){
              if (isFinite(layout.binW)) try{ localStorage.setItem('pfx.reviews.binWidth', String(layout.binW)); }catch{}
              if (isFinite(layout.splitRatio)) try{ localStorage.setItem('pfx.reviews.splitRatio', String(layout.splitRatio)); }catch{}
              if (isFinite(layout.viewersFrac)) try{ localStorage.setItem('pfx.reviews.viewersHeightFrac', String(layout.viewersFrac)); }catch{}
              try{ window.__PFX_REVIEWS_APPLY_LAYOUT?.(layout); }catch{}
            }
          }catch{}
        }
      }catch{}
    };
  }catch{}


// --- Lightweight autosave (per-project) ---
// Goal: keep the Review tab remembering imported clips (and notes/overlays) across refresh,
// even if the user didn't explicitly Save Project yet.
// Note: media URLs (blob:) will not survive refresh; we restore metadata and then rely on
// Media Root relink or drag&drop to relink.
const __PFX_REV_AUTOSAVE_PREFIX = 'pfx.reviews.autosave.v1.';
const __PFX_REV_AUTOSAVE_LAST = 'pfx.reviews.autosave.lastKey.v1';
	// Always-available fallback snapshot (not keyed). Used when project key changes or lastKey is missing.
	const __PFX_REV_AUTOSAVE_LAST_SNAP = 'pfx.reviews.autosave.lastSnapshot.v1';
// IndexedDB-backed autosave (avoids localStorage quota issues)
const __PFX_REV_AUTOSAVE_IDB_PREFIX = 'reviews.autosave.v1.';
const __PFX_REV_AUTOSAVE_IDB_LAST = 'reviews.autosave.lastKey.v1';
	const __PFX_REV_AUTOSAVE_IDB_LAST_SNAP = 'reviews.autosave.lastSnapshot.v1';
const __pfxSanitizeKey = (s) => String(s || 'Project')
  .trim()
  .replace(/\s+/g, '_')
  .replace(/[^a-zA-Z0-9._-]/g, '_')
  .replace(/_+/g, '_')
  .replace(/^_+|_+$/g, '') || 'Project';
const __pfxGetProjectKey = () => {
  try{
    const pn = (document.getElementById('projectNameGlobal')?.value || '').trim();
    return __pfxSanitizeKey(pn || 'Project');
  }catch{ return 'Project'; }
};
const __pfxAutosaveKey = () => `${__PFX_REV_AUTOSAVE_PREFIX}${__pfxGetProjectKey()}`;
const __pfxAutosaveKeyIdb = () => `${__PFX_REV_AUTOSAVE_IDB_PREFIX}${__pfxGetProjectKey()}`;


// --- Thumbnail persistence (Visual QC) ---
// Store thumbnails in IndexedDB (kvSet/kvGet) keyed by markerId so refresh does not
// lose evidence images, while localStorage autosave remains small.
const __PFX_REV_THUMB_IDB_PREFIX = 'reviews.thumb.v1.';          // final / display thumb
const __PFX_REV_THUMB_BASE_IDB_PREFIX = 'reviews.thumbBase.v1.'; // un-annotated base
const __PFX_REV_THUMB_ANNO_IDB_PREFIX = 'reviews.thumbAnno.v1.'; // optional annotated layer
const __pfxThumbScopeId = (clipId) => String(clipId || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_');
const __pfxThumbScopeSuffix = (clipId) => {
  const scope = __pfxThumbScopeId(clipId);
  return scope ? `.${scope}` : '';
};
const __pfxThumbKey = (markerId, clipId = '') => `${__PFX_REV_THUMB_IDB_PREFIX}${String(markerId || '').trim()}${__pfxThumbScopeSuffix(clipId)}`;
const __pfxThumbBaseKey = (markerId, clipId = '') => `${__PFX_REV_THUMB_BASE_IDB_PREFIX}${String(markerId || '').trim()}${__pfxThumbScopeSuffix(clipId)}`;
const __pfxThumbAnnoKey = (markerId, clipId = '') => `${__PFX_REV_THUMB_ANNO_IDB_PREFIX}${String(markerId || '').trim()}${__pfxThumbScopeSuffix(clipId)}`;
const __pfxGetMarkerThumbScope = (marker) => {
  if (!marker) return '';
  return String(marker.layer || '').toUpperCase() === 'V2' ? String(marker.clipId || '').trim() : '';
};
const __pfxResolveMarkerThumbKey = (marker, kind = 'thumb') => {
  const markerId = String(marker?.id || '').trim();
  if (!markerId) return null;
  const scope = __pfxGetMarkerThumbScope(marker);
  if (kind === 'base') return __pfxThumbBaseKey(markerId, scope);
  if (kind === 'anno') return __pfxThumbAnnoKey(markerId, scope);
  return __pfxThumbKey(markerId, scope);
};
const __pfxCloneAnnoShapes = (shapes) => {
  if (!Array.isArray(shapes)) return [];
  try { return JSON.parse(JSON.stringify(shapes)); } catch { return shapes.slice(); }
};
const __pfxSanitizeMarkerVersionEntry = (entry = {}, markerId = '', clipId = '') => {
  const scope = String(clipId || '').trim();
  const hasThumb = !!(entry?.thumbDataUrl || entry?.thumbKey);
  const hasBase = !!(entry?.thumbBaseDataUrl || entry?.thumbBaseKey);
  const hasAnno = !!(entry?.thumbAnnoDataUrl || entry?.thumbAnnoKey);
  return {
    status: entry?.status || '',
    issueType: entry?.issueType || 'General',
    severity: entry?.severity || 'S2',
    note: entry?.note || '',
    noteTypeGroup: entry?.noteTypeGroup || '',
    noteType: entry?.noteType || '',
    scopeOfWorkList: Array.isArray(entry?.scopeOfWorkList) ? entry.scopeOfWorkList : [],
    scopeOfWork: entry?.scopeOfWork || '',
    thumbKey: (entry?.thumbKey || (hasThumb && markerId ? __pfxThumbKey(markerId, scope) : null)) || null,
    thumbBaseKey: (entry?.thumbBaseKey || (hasBase && markerId ? __pfxThumbBaseKey(markerId, scope) : null)) || null,
    thumbAnnoKey: (entry?.thumbAnnoKey || (hasAnno && markerId ? __pfxThumbAnnoKey(markerId, scope) : null)) || null,
    thumbDataUrl: null,
    thumbBaseDataUrl: null,
    thumbAnnoDataUrl: null,
    thumbAnnotated: !!entry?.thumbAnnotated,
    annoShapes: __pfxCloneAnnoShapes(entry?.annoShapes),
  };
};
const __pfxSanitizeMarkerReviewByClipId = (marker = {}, markerId = '') => {
  const src = (marker && typeof marker.reviewByClipId === 'object' && !Array.isArray(marker.reviewByClipId)) ? marker.reviewByClipId : {};
  const out = {};
  for (const [clipId, entry] of Object.entries(src)) {
    const key = String(clipId || '').trim();
    if (!key) continue;
    out[key] = __pfxSanitizeMarkerVersionEntry(entry, markerId, key);
  }
  return out;
};

let __pfxHydrateThumbsBusy = false;
let __pfxHydrateThumbsTimer = null;
const __PFX_REV_THUMB_RAM_MAX = 18;
const __PFX_REV_THUMB_VIEW_MARGIN = 140;

const __pfxCollectThumbKeepIds = (opts = {}) => {
  const markers = Array.isArray(store?.state?.markers) ? store.state.markers : [];
  const keep = new Set();
  if (!markers.length) return keep;

  if (opts?.all) {
    for (const m of markers) {
      const id = String(m?.id || '').trim();
      if (id) keep.add(id);
    }
    return keep;
  }

  const explicit = opts?.markerIds instanceof Set
    ? Array.from(opts.markerIds)
    : (Array.isArray(opts?.markerIds) ? opts.markerIds : null);
  if (explicit && explicit.length) {
    for (const id0 of explicit) {
      const id = String(id0 || '').trim();
      if (id) keep.add(id);
    }
    return keep;
  }

  const selId = String(store?.state?.selectedMarkerId || '').trim();
  if (selId) keep.add(selId);

  try {
    const scroller = markersBody?.querySelector?.('.pfx-reviews-markerList') || null;
    if (scroller) {
      const sr = scroller.getBoundingClientRect();
      const marginX = Math.max(__PFX_REV_THUMB_VIEW_MARGIN, (sr.width || 0) * 0.35);
      const marginY = 64;
      const rows = Array.from(scroller.querySelectorAll('.pfx-reviews-markerRow[data-marker-id]'));
      for (const row of rows) {
        const rr = row.getBoundingClientRect();
        if (rr.right < (sr.left - marginX) || rr.left > (sr.right + marginX)) continue;
        if (rr.bottom < (sr.top - marginY) || rr.top > (sr.bottom + marginY)) continue;
        const id = String(row.dataset.markerId || '').trim();
        if (id) keep.add(id);
        if (keep.size >= __PFX_REV_THUMB_RAM_MAX) break;
      }
    }
  } catch {}

  const ordered = (Array.isArray(notesVisibleIds) && notesVisibleIds.length)
    ? notesVisibleIds.map((id) => String(id || '').trim()).filter(Boolean)
    : markers.map((m) => String(m?.id || '').trim()).filter(Boolean);
  if (!ordered.length) return keep;

  let pivot = selId ? ordered.indexOf(selId) : 0;
  if (pivot < 0) pivot = 0;
  const limit = Math.min(__PFX_REV_THUMB_RAM_MAX, ordered.length);
  let step = 0;
  while (keep.size < limit) {
    let added = false;
    const left = pivot - step;
    const right = pivot + step;
    if (left >= 0) {
      keep.add(ordered[left]);
      added = true;
    }
    if (keep.size >= limit) break;
    if (right < ordered.length) {
      keep.add(ordered[right]);
      added = true;
    }
    if (!added) break;
    step += 1;
  }
  return keep;
};

const __pfxTrimThumbMemory = (keepIds = new Set()) => {
  const markers = Array.isArray(store?.state?.markers) ? store.state.markers : [];
  let changed = false;
  for (const m of markers) {
    const id = String(m?.id || '').trim();
    if (!id || keepIds.has(id)) continue;
    try {
      if (m.thumbDataUrl && m.thumbKey) { m.thumbDataUrl = null; changed = true; }
      if (m.thumbBaseDataUrl && m.thumbBaseKey) { m.thumbBaseDataUrl = null; changed = true; }
      if (m.thumbAnnoDataUrl && m.thumbAnnoKey) { m.thumbAnnoDataUrl = null; changed = true; }
    } catch {}
  }
  return changed;
};

const __pfxScheduleHydrateThumbs = (delay = 80, opts = null) => {
  let wait = delay;
  let conf = opts;
  if (delay && typeof delay === 'object') {
    conf = delay;
    wait = Number(delay.delay);
  }
  try { if (__pfxHydrateThumbsTimer) clearTimeout(__pfxHydrateThumbsTimer); } catch {}
  __pfxHydrateThumbsTimer = setTimeout(() => {
    try { __pfxHydrateThumbs(conf || {}).catch(() => {}); } catch {}
  }, Math.max(0, Number(wait) || 0));
};

async function __pfxHydrateThumbs(opts = {}) {
  if (__pfxHydrateThumbsBusy) return false;
  __pfxHydrateThumbsBusy = true;
  try {
    const markers = Array.isArray(store?.state?.markers) ? store.state.markers : [];
    if (!markers.length) return false;

    const keepIds = __pfxCollectThumbKeepIds(opts);
    if (!keepIds.size && !opts?.all) return false;

    let changed = false;
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i];
      if (!m || !m.id) continue;
      const id = String(m.id);

      try {
        if (m.thumbDataUrl && !m.thumbKey) {
          const k = __pfxResolveMarkerThumbKey(m, 'thumb') || __pfxThumbKey(id);
          m.thumbKey = k;
          kvSet(k, m.thumbDataUrl).catch(() => {});
          changed = true;
        }
        if (m.thumbBaseDataUrl && !m.thumbBaseKey) {
          const kb = __pfxResolveMarkerThumbKey(m, 'base') || __pfxThumbBaseKey(id);
          m.thumbBaseKey = kb;
          kvSet(kb, m.thumbBaseDataUrl).catch(() => {});
          changed = true;
        }
        if (m.thumbAnnoDataUrl && !m.thumbAnnoKey) {
          const ka = __pfxResolveMarkerThumbKey(m, 'anno') || __pfxThumbAnnoKey(id);
          m.thumbAnnoKey = ka;
          kvSet(ka, m.thumbAnnoDataUrl).catch(() => {});
          changed = true;
        }
      } catch {}

      if (keepIds.has(id)) {
        try {
          if (!m.thumbDataUrl && m.thumbKey) {
            const v = await kvGet(String(m.thumbKey));
            if (typeof v === 'string' && v) { m.thumbDataUrl = v; changed = true; }
          }
          if (!m.thumbBaseDataUrl && m.thumbBaseKey) {
            const v = await kvGet(String(m.thumbBaseKey));
            if (typeof v === 'string' && v) { m.thumbBaseDataUrl = v; changed = true; }
          }
          if (!m.thumbAnnoDataUrl && m.thumbAnnoKey) {
            const v = await kvGet(String(m.thumbAnnoKey));
            if (typeof v === 'string' && v) { m.thumbAnnoDataUrl = v; changed = true; }
          }
        } catch {}
      }

      if (i % 6 === 5) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    const shouldTrim = opts?.trim !== false && !opts?.all && !(opts?.markerIds instanceof Set) && !Array.isArray(opts?.markerIds);
    if (shouldTrim) {
      changed = __pfxTrimThumbMemory(keepIds) || changed;
    }

    if (changed && opts?.emit !== false) {
      try { store.emit('markers'); } catch {}
    }
    return changed;
  } catch {
    return false;
  } finally {
    __pfxHydrateThumbsBusy = false;
  }
}

async function __pfxEnsureMarkerThumbLoaded(markerId) {
  const id = String(markerId || '').trim();
  if (!id) return null;
  const markers = Array.isArray(store?.state?.markers) ? store.state.markers : [];
  const cur = markers.find((m) => String(m?.id || '') === id) || null;
  if (!cur) return null;
  if (cur.thumbDataUrl) return cur.thumbDataUrl;
  await __pfxHydrateThumbs({ markerIds: [id], trim: false, emit: false });
  return (markers.find((m) => String(m?.id || '') === id) || cur)?.thumbDataUrl || null;
}

// Persist thumbs immediately when markers are updated (avoids race on refresh).
try{
  const __pfxOrigUpdateMarker = store.updateMarker.bind(store);
  store.updateMarker = (markerId, patch) => {
    const id = String(markerId || '').trim();
    const p = (patch && typeof patch === 'object') ? { ...patch } : {};
    try{
      const cur = id ? ((store?.state?.markers || []).find((m) => String(m?.id || '').trim() === id) || null) : null;
      const nextMarker = { ...(cur || {}), ...p, id };
      if (id) {
        if (typeof p.thumbDataUrl === 'string' && p.thumbDataUrl) {
          const k = __pfxResolveMarkerThumbKey(nextMarker, 'thumb') || __pfxThumbKey(id);
          p.thumbKey = k;
          kvSet(k, p.thumbDataUrl).catch(()=>{});
        }
        if (typeof p.thumbBaseDataUrl === 'string' && p.thumbBaseDataUrl) {
          const kb = __pfxResolveMarkerThumbKey(nextMarker, 'base') || __pfxThumbBaseKey(id);
          p.thumbBaseKey = kb;
          kvSet(kb, p.thumbBaseDataUrl).catch(()=>{});
        }
        if (typeof p.thumbAnnoDataUrl === 'string' && p.thumbAnnoDataUrl) {
          const ka = __pfxResolveMarkerThumbKey(nextMarker, 'anno') || __pfxThumbAnnoKey(id);
          p.thumbAnnoKey = ka;
          kvSet(ka, p.thumbAnnoDataUrl).catch(()=>{});
        }
      }
    }catch{}
    return __pfxOrigUpdateMarker(markerId, p);
  };
}catch{}


// --- Notes-only persistence (Visual QC) ---
// Goal: ensure Notes survive refresh even when the full autosave snapshot is too large
// or when another boot path restores clips before autosave restore runs.
const __PFX_REV_NOTES_PREFIX = 'pfx.reviews.notes.v1.';
const __PFX_REV_NOTES_LAST = 'pfx.reviews.notes.lastKey.v1';
const __PFX_REV_NOTES_LAST_SNAP = 'pfx.reviews.notes.lastSnapshot.v1';
// IndexedDB-backed notes snapshot (preferred)
const __PFX_REV_NOTES_IDB_PREFIX = 'reviews.notes.v1.';
const __PFX_REV_NOTES_IDB_LAST = 'reviews.notes.lastKey.v1';
const __PFX_REV_NOTES_IDB_LAST_SNAP = 'reviews.notes.lastSnapshot.v1';
const __pfxNotesKey = () => `${__PFX_REV_NOTES_PREFIX}${__pfxGetProjectKey()}`;
const __pfxNotesKeyIdb = () => `${__PFX_REV_NOTES_IDB_PREFIX}${__pfxGetProjectKey()}`;


// --- Media handle persistence (Visual QC) ---
// Goal: remember imported media across refresh WITHOUT re-drop.
// We store FileSystemFileHandle objects in IndexedDB (structured-cloneable in Chrome).
const __PFX_REV_MEDIA_HANDLES_IDB_PREFIX = 'reviews.mediaHandles.v1.';
const __PFX_REV_MEDIA_HANDLES_IDB_LAST = 'reviews.mediaHandles.lastKey.v1';
const __PFX_REV_MEDIA_HANDLES_IDB_LAST_SNAP = 'reviews.mediaHandles.lastSnapshot.v1';
const __pfxMediaHandlesKeyIdb = () => `${__PFX_REV_MEDIA_HANDLES_IDB_PREFIX}${__pfxGetProjectKey()}`;

let __pfxMediaHandlesCache = null; // last loaded payload
let __pfxMediaPending = []; // items that need permission
let __pfxMediaPendingCount = 0;
let __pfxBtnRelink = null; // assigned after toolbar is built

const __pfxPersistKeyFromMeta = (m) => {
  try{
    const name = String(m?.name || '').trim();
    const size = Number(m?.size || 0) || 0;
    const lm = Number(m?.lastModified || 0) || 0;
    return `${name}|${size}|${lm}`;
  }catch{ return ''; }
};

const __pfxSetPendingCount = (n) => {
  __pfxMediaPendingCount = Math.max(0, Number(n) || 0);
  try{
    if (__pfxBtnRelink) {
      // Always visible — toggle attention glow and label when clips are awaiting permission.
      __pfxBtnRelink.classList.toggle('is-attn', __pfxMediaPendingCount > 0);
      const label = __pfxMediaPendingCount > 0 ? `Relink (${__pfxMediaPendingCount})` : 'Relink';
      const title = __pfxMediaPendingCount > 0 ? `Relink media (${__pfxMediaPendingCount} pending)` : 'Relink media';
      // Update the visible text span inserted by setLabeledIcon; fallback to textContent.
      const span = __pfxBtnRelink.querySelector('.pfx-lbl-txt');
      if (span) span.textContent = label; else { try{ __pfxBtnRelink.textContent = label; }catch{} }
      __pfxBtnRelink.title = title;
      __pfxBtnRelink.setAttribute('aria-label', title);
    }
  }catch{}
};

const __pfxMarkClipsHandleState = (clipIds, patch = {}) => {
  try{
    const ids = Array.isArray(clipIds) ? clipIds.map((v) => String(v || '')).filter(Boolean) : [String(clipIds || '')].filter(Boolean);
    if (!ids.length) return;
    const stamp = Date.now();
    const nextPatch = { ...patch };
    if (nextPatch.handleSaved === true && !Number.isFinite(Number(nextPatch.handleSavedAt))) nextPatch.handleSavedAt = stamp;
    if (nextPatch.autoRelinked === true && !Number.isFinite(Number(nextPatch.autoRelinkedAt))) nextPatch.autoRelinkedAt = stamp;
    for (const id of ids) {
      try{ store.updateClip(id, nextPatch); }catch{}
    }
  }catch{}
};


function __pfxExtractDropFiles(dt){
  try{
    const out = [];
    try{
      if (dt?.files && dt.files.length) out.push(...Array.from(dt.files));
    }catch{}
    if (out.length) return out;

    // Fallback: some drags expose files only via items/getAsFile()
    const items = Array.from(dt?.items || []);
    for (const it of items){
      try{
        if (!it || it.kind !== 'file') continue;
        const f = (typeof it.getAsFile === 'function') ? it.getAsFile() : null;
        if (f) out.push(f);
      }catch{}
    }
    return out;
  }catch{ return []; }
}

async function __pfxExtractDropFileHandles(dt){
  try{
    const items = Array.from(dt?.items || []);
    const out = [];
    for (const it of items){
      try{
        if (!it || it.kind !== 'file') continue;
        if (typeof it.getAsFileSystemHandle === 'function') {
          const h = await it.getAsFileSystemHandle();
          if (h && h.kind === 'file') out.push(h);
        }
      }catch{}
    }
    return out;
  }catch{ return []; }
}

async function __pfxAttachHandlesToAddedClips(addedClips, handles){
  try{
    const added = Array.isArray(addedClips) ? addedClips : [];
    const hs = Array.isArray(handles) ? handles : [];
    if (!added.length || !hs.length) return 0;

    // Build meta list from handles (permission is granted at time of drop).
    const metas = [];
    for (const h of hs) {
      try{
        const f = await h.getFile();
        metas.push({ handle: h, meta: { name: f.name, size: f.size, lastModified: f.lastModified, type: f.type } });
      }catch{}
    }
    if (!metas.length) return 0;

    let count = 0;
    for (const c of added) {
      try{
        const fm = c?.fileMeta || { name: c?.name || '' };
        const k = __pfxPersistKeyFromMeta(fm);
        const m = metas.find(x => __pfxPersistKeyFromMeta(x?.meta) === k) || null;
        if (!m?.handle) continue;
        count++;
        // Attach handle to the clip in-memory (used for relink) and persistKey for stable matching.
        store.updateClip(c.id, { fsHandle: m.handle, persistKey: k, handleSaved: true, handleSavedAt: Date.now() });
      }catch{}
    }
    return count;
  }catch{ return 0; }
}

const __pfxSaveMediaHandlesSnapshot = async () => {
  try{
    const clips = Array.isArray(store.state?.clips) ? store.state.clips : [];
    const items = [];
    for (const c of clips) {
      // Guard: only save real FileSystemFileHandle instances.
      // After autosave restore, importState() sets fsHandle: null (was {} before the fix).
      // A {} with no getFile() method would overwrite the real handle saved on drop.
      if (!c?.fsHandle || typeof c.fsHandle.getFile !== 'function') continue;
      items.push({
        clipId: c.id,
        bin: c.bin || 'shots',
        name: c.name || (c.fileMeta?.name || 'Untitled'),
        fileMeta: c.fileMeta || null,
        persistKey: c.persistKey || __pfxPersistKeyFromMeta(c.fileMeta),
        handle: c.fsHandle,
        createdAt: Number(c.createdAt) || Date.now(),
      });
    }
    const payload = {
      schema: 'pfx_media_handles',
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      items,
    };
    const keyIdb = __pfxMediaHandlesKeyIdb();
    await kvSet(keyIdb, payload);
    await kvSet(__PFX_REV_MEDIA_HANDLES_IDB_LAST, keyIdb);
    await kvSet(__PFX_REV_MEDIA_HANDLES_IDB_LAST_SNAP, payload);
    __pfxMediaHandlesCache = payload;
  }catch{}
};

const __pfxLoadMediaHandlesSnapshot = async () => {
  try{
    const k1 = __pfxMediaHandlesKeyIdb();
    let saved = await kvGet(k1);
    if (!saved) {
      const last = await kvGet(__PFX_REV_MEDIA_HANDLES_IDB_LAST);
      if (last) saved = await kvGet(last);
    }
    // Only use the unkeyed last-snapshot fallback when no real project name is set
    // (e.g. page refresh before project name is established). For named projects this
    // fallback is skipped to prevent cross-project media handle bleed.
    const _hasNamedProject = !!(document.getElementById('projectNameGlobal')?.value || '').trim();
    if (!saved && !_hasNamedProject) {
      saved = await kvGet(__PFX_REV_MEDIA_HANDLES_IDB_LAST_SNAP);
    }
    __pfxMediaHandlesCache = saved || null;
    return saved || null;
  }catch{
    __pfxMediaHandlesCache = null;
    return null;
  }
};

async function __pfxTryRelinkFromStoredHandles(opts = {}){
  const request = !!opts.request; // must be called from a user gesture if true
  try{
    const payload = __pfxMediaHandlesCache || await __pfxLoadMediaHandlesSnapshot();
    const items = Array.isArray(payload?.items) ? payload.items : [];
    console.log('[PFX RELINK] __pfxTryRelinkFromStoredHandles: request=', request, 'items=', items.length, 'cache=', !!__pfxMediaHandlesCache);
    if (!items.length) { __pfxMediaPending = []; __pfxSetPendingCount(0); return false; }

    // Detect corrupted snapshot: every item has a broken handle ({}  instead of FileSystemFileHandle).
    // This can happen if a previous session saved JSON-serialized handles. Clear it so the user
    // gets a clean slate and can re-drop files — better than silently failing every time.
    const validItems = items.filter(it => typeof it?.handle?.getFile === 'function');
    if (validItems.length === 0 && items.length > 0) {
      console.warn('[PFX RELINK] All handles in IDB snapshot are invalid (corrupted). Clearing snapshot.');
      try{ __pfxClearMediaHandlesSnapshot().catch(()=>{}); }catch{}
      __pfxMediaPending = [];
      __pfxSetPendingCount(0);
      return false;
    }

    // Fast map clips by ID and by filename (for fallback when IDs changed after EDL re-import)
    const clips = Array.isArray(store.state?.clips) ? store.state.clips : [];
    const byId = new Map(clips.map(c => [c.id, c]));
    // Fallback: match by fileMeta.name or clip.name (case-insensitive, unlinked clips only)
    const byName = new Map();
    const stemOf = (n) => String(n||'').toLowerCase().replace(/\.[^.]+$/, '');
    for (const c of clips) {
      if (c?.url && !String(c.url).startsWith('blob:') && c.canPlay !== false) continue; // already linked
      const fname = String(c?.fileMeta?.name || c?.name || '').toLowerCase();
      if (fname && !byName.has(fname)) byName.set(fname, c);
      const fstem = stemOf(fname);
      if (fstem && !byName.has(fstem)) byName.set(fstem, c);
    }
    console.log('[PFX RELINK] __pfxTryRelinkFromStoredHandles: clips=', clips.length, 'byId=', byId.size, 'byName=', byName.size);

    let relinked = 0;
    const pending = [];

    for (const it of items) {
      // Primary: match by clip ID; fallback: match by filename (handles EDL re-imports with new IDs)
      let clip = byId.get(it?.clipId);
      if (!clip) {
        const itName = String(it?.fileMeta?.name || it?.name || '').toLowerCase();
        const itStem = stemOf(itName);
        clip = byName.get(itName) || byName.get(itStem) || null;
        if (clip) console.log('[PFX RELINK]   ID miss for', it?.clipId, '— matched by name:', itName, '→ clip', clip.id);
      }
      const h = it?.handle;
      // Validate handle is a real FileSystemFileHandle — old IDB snapshots may contain {} from
      // before the importState fix (when JSON-ized handles were accidentally re-saved).
      const hValid = !!h && typeof h.getFile === 'function';
      console.log('[PFX RELINK]   handle item clipId=', it?.clipId, 'name=', it?.name, 'clip found=', !!clip, 'h valid=', hValid);
      if (!clip || !hValid) continue;

      // Ensure state has handle attached for later use.
      if (!clip.fsHandle) {
        try{ store.updateClip(clip.id, { fsHandle: h, persistKey: it.persistKey || __pfxPersistKeyFromMeta(clip.fileMeta || it.fileMeta) }); }catch{}
      }

      let perm = 'granted';
      try{
        if (h.queryPermission) perm = await h.queryPermission({ mode: 'read' });
      }catch{ perm = 'prompt'; }
      console.log('[PFX RELINK]   perm=', perm, 'for clip', it?.clipId);

      let restored = false;
      const tryRestoreFromHandle = async () => {
        const f = await h.getFile();
        const url = URL.createObjectURL(f);
        // Revoke previous blob url (if any)
        try{
          const prev = (store.state?.clips || []).find(x => x && x.id === clip.id) || null;
          if (prev?.url && String(prev.url).startsWith('blob:')) { try{ URL.revokeObjectURL(prev.url); }catch{} }
        }catch{}
        store.updateClip(clip.id, {
          file: f,
          url,
          canPlay: true,
          durationSec: clip.durationSec || 0,
          handleSaved: true,
          handleSavedAt: Number(clip.handleSavedAt) || Date.now(),
          autoRelinked: true,
          autoRelinkedAt: Date.now(),
          // Write the real handle back — importState() clears fsHandle to null, so the clip's
          // fsHandle would be null after restore. Restoring it here means __pfxSaveMediaHandlesSnapshot
          // will re-save a real handle (not a broken {}) when the session ends.
          fsHandle: h,
          fileMeta: { name: f.name, size: Number(f.size) || 0, lastModified: Number(f.lastModified) || 0, type: String(f.type || '') }
        });
        restored = true;
        relinked++;
      };

      // Chrome can report "prompt" after refresh even when a persisted handle is still usable.
      // Try reading first before we give up or wait for an explicit user-gesture relink.
      try{
        await tryRestoreFromHandle();
        console.log('[PFX RELINK]   RELINKED from handle:', it?.clipId);
      }catch(_readErr){
        console.warn('[PFX RELINK]   first read failed:', it?.clipId, _readErr?.message);
        if (perm !== 'granted' && request && h.requestPermission) {
          try{ perm = await h.requestPermission({ mode: 'read' }); }catch{}
          console.log('[PFX RELINK]   after requestPermission perm=', perm);
        }
        if (!restored && perm === 'granted') {
          try{
            await tryRestoreFromHandle();
            console.log('[PFX RELINK]   RELINKED (2nd try) from handle:', it?.clipId);
          }catch(e2){
            console.warn('[PFX RELINK]   2nd read also failed:', it?.clipId, e2?.message);
            pending.push(it);
          }
        } else if (!restored) {
          console.log('[PFX RELINK]   PENDING (no permission):', it?.clipId, 'perm=', perm);
          pending.push(it);
        }
      }
    }

    __pfxMediaPending = pending;
    __pfxSetPendingCount(pending.length);

    if (relinked) {
      // Propagate fresh clip URLs into overlays (overlay.url is stale after refresh).
      try{
        const clips = Array.isArray(store.state?.clips) ? store.state.clips : [];
        const urlByClipId = new Map(clips.filter(c => c?.url).map(c => [c.id, c.url]));
        let ovlUpdated = false;
        const nextOverlays = (store.state.overlays || []).map(o => {
          if (!o?.clipId) return o;
          const freshUrl = urlByClipId.get(o.clipId);
          if (freshUrl && freshUrl !== o.url) { ovlUpdated = true; return { ...o, url: freshUrl, canPlay: true }; }
          return o;
        });
        if (ovlUpdated) store.set({ overlays: nextOverlays }, 'overlays');
      }catch{}
      try{ refreshClipsList(); }catch{}
      try{ syncSourceHandleState(); }catch{}
      try{ syncOverlayToState('relink'); }catch{}
      // Re-save handles snapshot under the current project key so the next load finds them immediately.
      try{ __pfxSaveMediaHandlesSnapshot().catch(()=>{}); }catch{}
      // Probe metadata for relinked clips (async, best-effort)
      try{
        const relinkedIds = new Set(items.filter(it => !pending.includes(it)).map(it => it.clipId));
        for (const c of (store.state?.clips || [])) {
          if (!relinkedIds.has(c.id)) continue;
          try{ await player.ensureClipMetadata(c.id); }catch{}
        }
      }catch{}
    }

    return relinked > 0;
  }catch{
    __pfxMediaPending = [];
    __pfxSetPendingCount(0);
    return false;
  }
}

const __pfxClearMediaHandlesSnapshot = async () => {
  try{
    const k = __pfxMediaHandlesKeyIdb();
    await kvSet(k, null);
    await kvSet(__PFX_REV_MEDIA_HANDLES_IDB_LAST, null);
    await kvSet(__PFX_REV_MEDIA_HANDLES_IDB_LAST_SNAP, null);
    __pfxMediaHandlesCache = null;
    __pfxMediaPending = [];
    __pfxSetPendingCount(0);
  }catch{}
};

let __pfxAutosaveTimer = null;
let __pfxAutosaveBusy = false;
let __pfxAutosaveEnabled = true;
let __pfxBootRestoreDone = false;

const __pfxSaveAutosaveNow = async (opts = {}) => {
  const allowEmpty = !!opts.allowEmpty;
  const force = !!opts.force;
  // Prevent startup from overwriting a valid autosave with an empty state (common on reload).
  if (!force && !__pfxAutosaveEnabled) return;
  if (__pfxAutosaveBusy) return;
  __pfxAutosaveBusy = true;
  try{
    const s0 = (store.exportState?.() || store.state || {});
    const hasClips0 = Array.isArray(s0.clips) && s0.clips.length;
    if (!hasClips0 && !allowEmpty) { return; }

    const key = __pfxAutosaveKey();
    const keyIdb = __pfxAutosaveKeyIdb();

	    // Keep autosave small: store clips + timeline + notes (without thumbnails).
    const snap = (() => {
      try{
        const s = s0 || {};
        const clips = Array.isArray(s.clips) ? s.clips.map((c)=>{
          const cc = { ...(c||{}) };
          try{ delete cc.file; }catch{}
          // Do NOT store file handles in the autosave snapshot (localStorage fallback can't serialize them).
          try{ delete cc.fsHandle; }catch{}
          try{ delete cc.persistKey; }catch{}
          try{ delete cc.handle; }catch{}
          return cc;
        }) : [];
	        // Persist Visual QC notes, but strip heavy thumbnail payloads to avoid localStorage quota issues.
	        const markers = Array.isArray(s.markers) ? s.markers.map((m)=>{
	          try{
	            if (!m || typeof m !== 'object') return null;
	            const mid = String(m.id || '').trim();
	            const hasThumb = !!(m.thumbDataUrl || m.thumbKey);
	            const hasBase = !!(m.thumbBaseDataUrl || m.thumbBaseKey);
	            const hasAnno = !!(m.thumbAnnoDataUrl || m.thumbAnnoKey);
	            return {
	              id: m.id,
	              createdAt: m.createdAt,
	              status: m.status || '',
	              issueType: m.issueType || 'General',
	              severity: m.severity || 'S2',
	              layer: m.layer || 'V1',
	              clipId: m.clipId || null,
	              clipIndex: Number.isFinite(m.clipIndex) ? m.clipIndex : -1,
	              clipName: m.clipName || '',
	              globalTimeSec: Number(m.globalTimeSec) || 0,
	              globalFrame: Number.isFinite(m.globalFrame)
	                ? m.globalFrame
	                : Math.round((Number(m.globalTimeSec) || 0) * (Number(s.fps) || 24)),
	              localTimeSec: Number(m.localTimeSec) || 0,
	              localFrame: Number.isFinite(m.localFrame) ? m.localFrame : 0,
	              srcTC: m.srcTC || '',
	              note: m.note || '',
	              noteTypeGroup: m.noteTypeGroup || '',
	              noteType: m.noteType || '',
	              scopeOfWorkList: Array.isArray(m.scopeOfWorkList) ? m.scopeOfWorkList : [],
	              scopeOfWork: m.scopeOfWork || '',
	              // Thumbnails are stored separately in IndexedDB (by key) to keep autosave small.
	              thumbKey: (m.thumbKey || (hasThumb && mid ? (__pfxResolveMarkerThumbKey(m, 'thumb') || __pfxThumbKey(mid, __pfxGetMarkerThumbScope(m))) : null)) || null,
	              thumbBaseKey: (m.thumbBaseKey || (hasBase && mid ? (__pfxResolveMarkerThumbKey(m, 'base') || __pfxThumbBaseKey(mid, __pfxGetMarkerThumbScope(m))) : null)) || null,
	              thumbAnnoKey: (m.thumbAnnoKey || (hasAnno && mid ? (__pfxResolveMarkerThumbKey(m, 'anno') || __pfxThumbAnnoKey(mid, __pfxGetMarkerThumbScope(m))) : null)) || null,
	              thumbDataUrl: null,
	              thumbBaseDataUrl: null,
	              thumbAnnoDataUrl: null,
	              thumbAnnotated: !!m.thumbAnnotated,
	              annoShapes: Array.isArray(m.annoShapes) ? m.annoShapes : [],
              reviewByClipId: __pfxSanitizeMarkerReviewByClipId(m, mid),
	            };
	          }catch{ return null; }
	        }).filter(Boolean) : [];
	        const selectedMarkerId = (s.selectedMarkerId && markers.find(x => x && x.id === s.selectedMarkerId))
	          ? s.selectedMarkerId
	          : (markers.length ? markers[0].id : null);
        return {
          schema: "pfx_reviews_autosave",
          schemaVersion: 1,
          updatedAt: new Date().toISOString(),
          state: {
            fps: Number(s.fps) || 24,
            pxPerSec: Number(s.pxPerSec) || 80,
            clips,
            timelineClipIds: Array.isArray(s.timelineClipIds) ? s.timelineClipIds : [],
            autoCutSettings: (s.autoCutSettings && typeof s.autoCutSettings === 'object') ? s.autoCutSettings : { mode: 'shot', preset: 'standard', ignoreRegions: [], thresholds: null },
            v1CutsByClip: (s.v1CutsByClip && typeof s.v1CutsByClip === 'object') ? s.v1CutsByClip : {},
            v1CutStatsByClip: (s.v1CutStatsByClip && typeof s.v1CutStatsByClip === 'object') ? s.v1CutStatsByClip : {},
            selectedV1Cut: (s.selectedV1Cut && typeof s.selectedV1Cut === 'object') ? s.selectedV1Cut : null,
            v1CutViewMode: String(s.v1CutViewMode || 'all'),
            overlays: Array.isArray(s.overlays) ? s.overlays : [],
	            markers,
	            selectedMarkerId
          },
          ui: {
            oneView: !!document.body.classList.contains("pfx-reviews-oneView"),
            panelsHidden: !!document.body.classList.contains("pfx-reviews-panelsHidden"),
            layout: {
              splitRatio: (()=>{ try{ const v = parseFloat(localStorage.getItem('pfx.reviews.splitRatio')||''); return isFinite(v) ? v : null; }catch{ return null; } })(),
              viewersFrac: (()=>{ try{ const v = parseFloat(localStorage.getItem('pfx.reviews.viewersHeightFrac')||''); return isFinite(v) ? v : null; }catch{ return null; } })(),
              binW: (()=>{ try{ const v = parseInt(localStorage.getItem('pfx.reviews.binWidth')||'', 10); return isFinite(v) ? v : null; }catch{ return null; } })(),
            },
          }
        };
      }catch{ return null; }
    })();

    if (snap) {
      // IMPORTANT: write localStorage FIRST (sync).
      // On page refresh/unload, async IndexedDB writes may be interrupted; localStorage
      // gives us a reliable baseline so the Bin/Timeline doesn't disappear.
      try{
        const s = JSON.stringify(snap);
        localStorage.setItem(key, s);
        localStorage.setItem(__PFX_REV_AUTOSAVE_LAST, key);
        localStorage.setItem(__PFX_REV_AUTOSAVE_LAST_SNAP, s);
      }catch{}

      // Notes-only snapshot (small + robust). Even if the full autosave is too big,
      // Notes should still survive refresh.
      try{
        const st = snap?.state || {};
        const notesSnap = {
          schema: 'pfx_reviews_notes',
          schemaVersion: 1,
          updatedAt: snap.updatedAt,
          state: {
            fps: Number(st.fps) || 24,
            autoCutSettings: (st.autoCutSettings && typeof st.autoCutSettings === 'object') ? st.autoCutSettings : { mode: 'shot', preset: 'standard', ignoreRegions: [], thresholds: null },
            v1CutsByClip: (st.v1CutsByClip && typeof st.v1CutsByClip === 'object') ? st.v1CutsByClip : {},
            v1CutStatsByClip: (st.v1CutStatsByClip && typeof st.v1CutStatsByClip === 'object') ? st.v1CutStatsByClip : {},
            selectedV1Cut: (st.selectedV1Cut && typeof st.selectedV1Cut === 'object') ? st.selectedV1Cut : null,
            v1CutViewMode: String(st.v1CutViewMode || 'all'),
            markers: Array.isArray(st.markers) ? st.markers : [],
            selectedMarkerId: st.selectedMarkerId || null,
          },
        };
        const nk = __pfxNotesKey();
        const ns = JSON.stringify(notesSnap);
        localStorage.setItem(nk, ns);
        localStorage.setItem(__PFX_REV_NOTES_LAST, nk);
        localStorage.setItem(__PFX_REV_NOTES_LAST_SNAP, ns);
      }catch{}

      // Then write IndexedDB (preferred for large snapshots, best-effort).
	      try{ await kvSet(keyIdb, snap); await kvSet(__PFX_REV_AUTOSAVE_IDB_LAST, keyIdb); await kvSet(__PFX_REV_AUTOSAVE_IDB_LAST_SNAP, snap); }catch{}

      // Notes-only snapshot to IndexedDB (preferred, reliable across quota constraints).
      try{
        const nkIdb = __pfxNotesKeyIdb();
        const st = snap?.state || {};
        const notesSnap = {
          schema: 'pfx_reviews_notes',
          schemaVersion: 1,
          updatedAt: snap.updatedAt,
          state: {
            fps: Number(st.fps) || 24,
            autoCutSettings: (st.autoCutSettings && typeof st.autoCutSettings === 'object') ? st.autoCutSettings : { mode: 'shot', preset: 'standard', ignoreRegions: [], thresholds: null },
            v1CutsByClip: (st.v1CutsByClip && typeof st.v1CutsByClip === 'object') ? st.v1CutsByClip : {},
            v1CutStatsByClip: (st.v1CutStatsByClip && typeof st.v1CutStatsByClip === 'object') ? st.v1CutStatsByClip : {},
            selectedV1Cut: (st.selectedV1Cut && typeof st.selectedV1Cut === 'object') ? st.selectedV1Cut : null,
            v1CutViewMode: String(st.v1CutViewMode || 'all'),
            markers: Array.isArray(st.markers) ? st.markers : [],
            selectedMarkerId: st.selectedMarkerId || null,
          },
        };
        await kvSet(nkIdb, notesSnap);
        await kvSet(__PFX_REV_NOTES_IDB_LAST, nkIdb);
        await kvSet(__PFX_REV_NOTES_IDB_LAST_SNAP, notesSnap);
      }catch{}
    }
	}catch{}finally{ __pfxAutosaveBusy = false; }
};

const __pfxScheduleAutosave = (opts = {}) => {
  if (!__pfxAutosaveEnabled && !opts.force) return;
  try{ if (__pfxAutosaveTimer) clearTimeout(__pfxAutosaveTimer); }catch{}
  __pfxAutosaveTimer = setTimeout(() => { try{ __pfxSaveAutosaveNow(opts).catch(()=>{}); }catch{} }, 650);
};

const __pfxTryRestoreAutosave = async () => {
  try{
    // Prefer full restore into an empty store. However, Notes can be restored even when
    // clips are already present (some boot paths rehydrate clips before autosave runs).
    const hasClips = Array.isArray(store.state?.clips) && store.state.clips.length;
    const hasMarkers = Array.isArray(store.state?.markers) && store.state.markers.length;
    if (hasClips && hasMarkers) return false;

    const applyFromSaved = (saved) => {
      try{
        if (!saved) return false;
        if (!hasClips) {
          window.PFX_applyReviewsState?.(saved);
          return true;
        }
        // Partial restore: markers only (avoid stomping already-loaded clips/timeline).
        if (Array.isArray(store.state?.markers) && store.state.markers.length) return false;
        const payload = (saved && saved.state && typeof saved.state === 'object') ? saved.state : saved;
        // Restore V1 auto-cut map too (so Prev/Next + shot-sized segments persist).
        try{
          const cuts = payload?.v1CutsByClip;
          const cutStats = payload?.v1CutStatsByClip;
          const selectedV1Cut = payload?.selectedV1Cut;
          const autoCutSettings = payload?.autoCutSettings;
          const v1CutViewMode = payload?.v1CutViewMode;
          const hasCuts = !!(store.state?.v1CutsByClip && Object.keys(store.state.v1CutsByClip || {}).length);
          let restoredCuts = false;
          if (cuts && typeof cuts === 'object' && !hasCuts) {
            store.state.v1CutsByClip = cuts;
            restoredCuts = true;
          }
          if (cutStats && typeof cutStats === 'object' && !(store.state?.v1CutStatsByClip && Object.keys(store.state.v1CutStatsByClip || {}).length)) {
            store.state.v1CutStatsByClip = cutStats;
          }
          if (autoCutSettings && typeof autoCutSettings === 'object') {
            store.state.autoCutSettings = { ...(store.state.autoCutSettings || {}), ...autoCutSettings };
          }
          if (selectedV1Cut && typeof selectedV1Cut === 'object') {
            store.state.selectedV1Cut = selectedV1Cut;
          }
          if (v1CutViewMode != null) {
            try { store.state.v1CutViewMode = String(v1CutViewMode || 'all'); } catch {}
          }
          if (restoredCuts) store.rebuildSegments('cuts');
        }catch{}
        const markers = Array.isArray(payload?.markers) ? payload.markers : [];
        if (!markers.length) return false;
        const sel = payload?.selectedMarkerId || null;
        const selOk = !!(sel && markers.some(m => m && m.id === sel));
        store.state.markers = markers;
        store.state.selectedMarkerId = selOk ? sel : (markers[0]?.id || null);
        store.emit('markers');
        try{ __pfxScheduleHydrateThumbs(120); }catch{}
        return true;
      }catch{ return false; }
    };

    // Unkeyed LAST_SNAP fallbacks are only safe when no real project name is set
    // (e.g. fresh page load before user opens a project). Skip them for named projects
    // to prevent cross-project autosave bleed.
    const _autosaveHasNamedProject = !!(document.getElementById('projectNameGlobal')?.value || '').trim();

    // 1) Try IndexedDB first (preferred).
    try{
      const k1 = __pfxAutosaveKeyIdb();
      let saved = await kvGet(k1);
      if (!saved) {
        const last = await kvGet(__PFX_REV_AUTOSAVE_IDB_LAST);
        if (last) saved = await kvGet(last);
      }
      // Last-resort fallback (not keyed) — skipped for named projects.
      if (!saved && !_autosaveHasNamedProject) {
        saved = await kvGet(__PFX_REV_AUTOSAVE_IDB_LAST_SNAP);
      }
      if (saved) {
        if (applyFromSaved(saved)) return true;
      }
    }catch{}

    // 2) Fallback to localStorage (best-effort).
    try{
      const key = (() => {
        const k1 = __pfxAutosaveKey();
        if (localStorage.getItem(k1)) return k1;
        const last = localStorage.getItem(__PFX_REV_AUTOSAVE_LAST);
        return last || k1;
      })();
      const raw = localStorage.getItem(key);
      const raw2 = raw || (!_autosaveHasNamedProject ? localStorage.getItem(__PFX_REV_AUTOSAVE_LAST_SNAP) : null);
      if (!raw2) return false;
      const saved = JSON.parse(raw2);
      if (!saved) return false;
      if (applyFromSaved(saved)) return true;
      return false;
    }catch{}

    return false;
  }catch{ return false; }
};

// Notes-only restore (Visual QC)
// Use when the store already has clips but Notes are missing after refresh.
const __pfxTryRestoreNotesOnly = async () => {
  try{
    const hasMarkers = Array.isArray(store.state?.markers) && store.state.markers.length;
    if (hasMarkers) return false;

    const apply = (saved) => {
      try{
        if (!saved) return false;
        const payload = (saved && saved.state && typeof saved.state === 'object') ? saved.state : saved;
        // Restore V1 cut map if present (notes-only snapshot also stores it).
        try{
          const cuts = payload?.v1CutsByClip;
          const cutStats = payload?.v1CutStatsByClip;
          const selectedV1Cut = payload?.selectedV1Cut;
          const autoCutSettings = payload?.autoCutSettings;
          const v1CutViewMode = payload?.v1CutViewMode;
          const hasCuts = !!(store.state?.v1CutsByClip && Object.keys(store.state.v1CutsByClip || {}).length);
          let restoredCuts = false;
          if (cuts && typeof cuts === 'object' && !hasCuts) {
            store.state.v1CutsByClip = cuts;
            restoredCuts = true;
          }
          if (cutStats && typeof cutStats === 'object' && !(store.state?.v1CutStatsByClip && Object.keys(store.state.v1CutStatsByClip || {}).length)) {
            store.state.v1CutStatsByClip = cutStats;
          }
          if (autoCutSettings && typeof autoCutSettings === 'object') {
            store.state.autoCutSettings = { ...(store.state.autoCutSettings || {}), ...autoCutSettings };
          }
          if (selectedV1Cut && typeof selectedV1Cut === 'object') {
            store.state.selectedV1Cut = selectedV1Cut;
          }
          if (v1CutViewMode != null) {
            try { store.state.v1CutViewMode = String(v1CutViewMode || 'all'); } catch {}
          }
          if (restoredCuts) store.rebuildSegments('cuts');
        }catch{}
        const markers = Array.isArray(payload?.markers) ? payload.markers : [];
        const sel = payload?.selectedMarkerId || null;
        if (!markers.length) return false;
        const selOk = !!(sel && markers.some(m => m && m.id === sel));
        store.state.markers = markers;
        store.state.selectedMarkerId = selOk ? sel : (markers[0]?.id || null);
        store.emit('markers');
        return true;
      }catch{ return false; }
    };

    // 1) IndexedDB first
    try{
      const k1 = __pfxNotesKeyIdb();
      let saved = await kvGet(k1);
      if (!saved) {
        const last = await kvGet(__PFX_REV_NOTES_IDB_LAST);
        if (last) saved = await kvGet(last);
      }
      if (!saved) saved = await kvGet(__PFX_REV_NOTES_IDB_LAST_SNAP);
      if (saved && apply(saved)) return true;
    }catch{}

    // 2) localStorage fallback
    try{
      const key = (() => {
        const k1 = __pfxNotesKey();
        if (localStorage.getItem(k1)) return k1;
        const last = localStorage.getItem(__PFX_REV_NOTES_LAST);
        return last || k1;
      })();
      const raw = localStorage.getItem(key);
      const raw2 = raw || localStorage.getItem(__PFX_REV_NOTES_LAST_SNAP);
      if (!raw2) return false;
      const saved = JSON.parse(raw2);
      if (saved && apply(saved)) return true;
    }catch{}

    return false;
  }catch{ return false; }
};

  // ---------- RelinkManager: unified, event-driven media relink ----------
  // Single source of truth for all relink triggers. Uses store.subscribe('import')
  // so relink runs AFTER clips are in the store — eliminates all timer races.
  const relinkMgr = (() => {
    let _busy = false;
    let _pendingRun = false; // re-run needed after current run finishes

    const run = async ({ request = false } = {}) => {
      console.log('[PFX RELINK] relinkMgr.run request=', request, '_busy=', _busy, 'clips=', store.state?.clips?.length ?? 'n/a');
      // For request:true (user gesture), always run immediately — permission dialog needs
      // the browser's user-activation token, which disappears after any microtask delay.
      if (request) {
        try{ __pfxMediaHandlesCache = null; }catch{}
        try{ await tryRelinkFromMediaRoot(); }catch{}
        try{ await __pfxTryRelinkFromStoredHandles({ request: true }); }catch{}
        return;
      }
      // For automatic (non-user-gesture) runs, debounce: skip if already in flight,
      // but set a flag so we re-run once the current run finishes (catches project switches).
      if (_busy) { _pendingRun = true; console.log('[PFX RELINK] relinkMgr.run: deferred (busy)'); return; }
      _busy = true;
      try{
        do {
          _pendingRun = false;
          try{ __pfxMediaHandlesCache = null; }catch{}
          try{ await tryRelinkFromMediaRoot(); }catch{}
          try{ await __pfxTryRelinkFromStoredHandles({ request: false }); }catch{}
        } while (_pendingRun); // re-run if a new import arrived while we were busy
      }finally{
        _busy = false;
      }
    };

    // store 'import' fires AFTER clips are written to state — no race condition.
    // Covers: autosave restore, notes restore, project load (PFX_applyReviewsState).
    let _unsubStore = () => {};
    try{
      _unsubStore = store.subscribe((_, action) => {
        if (action !== 'import') return;
        const clipSummary = (store.state?.clips||[]).slice(0,5).map(c=>({id:c.id,name:c?.name,fmeta:c?.fileMeta?.name,url:!!c?.url,fsHandle:!!c?.fsHandle}));
        console.log('[PFX RELINK] store import event fired, clips=', store.state?.clips?.length, 'sample:', clipSummary);
        try{ run({ request: false }); }catch{}
      });
    }catch{}

    // Project loaded while tab is already mounted (pfx:project-tab-applied fires after
    // PFX_applyReviewsState → store.importState → 'import', so this is a belt-and-suspenders
    // trigger for cases where the project state has no clips to import but handles still exist).
    try{
      window.addEventListener('pfx:project-tab-applied', (e) => {
        if (e?.detail?.tab !== 'review') return;
        try{ run({ request: false }); }catch{}
      }, { passive: true });
    }catch{}

    // Media root changed or rescanned from Settings panel.
    try{
      document.addEventListener('pfx:mediaRootChanged', () => {
        try{ run({ request: false }); }catch{}
      }, { passive: true });
      document.addEventListener('pfx:mediaRescanned', () => {
        try{ run({ request: false }); }catch{}
      }, { passive: true });
    }catch{}

    return {
      run,
      destroy: () => { try{ _unsubStore(); }catch{} },
    };
  })();

  // Restore any previously loaded project snapshot (if project was loaded before tab mounted)
  try{
    if (window.__PFX_REVIEWS_STATE) {
      const s = window.__PFX_REVIEWS_STATE;
      // Clear stale handle cache — project may differ from last session's cached handles.
      try{ __pfxMediaHandlesCache = null; }catch{}
      window.PFX_applyReviewsState?.(s);
      // If the loaded snapshot is empty (or Notes are missing), fall back to autosave / notes-only.
      try{
        const hasClips = Array.isArray(store.state?.clips) && store.state.clips.length;
        const hasMarkers = Array.isArray(store.state?.markers) && store.state.markers.length;
        if (!hasClips || !hasMarkers) (async()=>{
          try{ await __pfxTryRestoreAutosave(); }catch{}
          try{ await __pfxTryRestoreNotesOnly(); }catch{}
        })();
      }catch{}
    } else {
      // No project snapshot: fall back to local autosave so clips don't disappear after refresh.
      try{ (async()=>{
        try{ await __pfxTryRestoreAutosave(); }catch{}
        try{ await __pfxTryRestoreNotesOnly(); }catch{}
        // Relink is handled by relinkMgr via store.subscribe('import') — no explicit call needed.
      })(); }catch{}
    }
  }catch{}

  // Extra-safe restore (race guard): on some reloads, early restore can occur before
  // the tab UI + store subscribers are fully ready, causing the bin to appear empty.
  // We re-try restore shortly after mount, only if the store is still empty.
  try{
    const retryRestore = async () => {
      try{
        const hasClips = Array.isArray(store.state?.clips) && store.state.clips.length;
        const hasMarkers = Array.isArray(store.state?.markers) && store.state.markers.length;
        if (hasClips && hasMarkers) return;
        const ok = await __pfxTryRestoreAutosave();
        const ok2 = await __pfxTryRestoreNotesOnly();
        if (ok || ok2) {
          try{ refreshClipsList(); }catch{}
          try{ refreshMarkersList(); }catch{}
          // Relink triggered automatically via store.subscribe('import') in relinkMgr.
        }
      }catch{}
    };
    setTimeout(() => { try{ retryRestore(); }catch{} }, 260);
    setTimeout(() => { try{ retryRestore(); }catch{} }, 1200);
  }catch{}

  // Autosave when project name changes (re-key)
  try{
    const pn = document.getElementById('projectNameGlobal');
    if (pn) {
      pn.addEventListener('input', () => { try{ __pfxScheduleAutosave(); }catch{} }, { passive:true });
      pn.addEventListener('change', () => { try{ __pfxScheduleAutosave(); }catch{} }, { passive:true });
      // If project key changed on boot (common), try restore again using the new key.
      pn.addEventListener('change', () => { try{ setTimeout(() => {
        try{
          const hasClips = Array.isArray(store.state?.clips) && store.state.clips.length;
          const hasMarkers = Array.isArray(store.state?.markers) && store.state.markers.length;
          if (!hasClips || !hasMarkers) __pfxTryRestoreAutosave();
          if (!hasMarkers) __pfxTryRestoreNotesOnly();
        }catch{}
      }, 80); }catch{} }, { passive:true });
    }
  }catch{}

  // Flush autosave + media handles on refresh/reload (destroy() isn't guaranteed to run on page reload)
  try{
    const flush = () => {
      try{ __pfxSaveAutosaveNow({ force:true }).catch(()=>{}); }catch{}
      try{ __pfxSaveMediaHandlesSnapshot().catch(()=>{}); }catch{}
    };
    window.addEventListener('pagehide', flush, { passive:true });
    window.addEventListener('beforeunload', flush, { passive:true });
    try{ document.addEventListener('visibilitychange', () => { try{ if (document.visibilityState === 'hidden') flush(); }catch{} }, { passive:true }); }catch{}
  }catch{}

  // Auto-relink is now handled by relinkMgr (store 'import' subscription) — no boot timers needed.
  // Proxy-only restore pass: for clips with fileMeta but no url/file after handle+media-root attempts
  try{ setTimeout(() => {
    try{
      const clips = store.state?.clips || [];
      for (const c of clips){
        if (!c?.fileMeta?.name || !c.fileMeta.size || !c.fileMeta.lastModified) continue;
        if (c.url || c.file) continue;
        tryRestoreProxyForMeta(c.fileMeta).then(proxy => {
          if (!proxy?.url) return;
          store.updateClip(c.id, { url: proxy.url, canPlay: true });
        }).catch(()=>{});
      }
    }catch{}
  }, 150); }catch{}

  // Media root / project-load event listeners are now registered inside relinkMgr above.

  const root = el('div', 'pfx-reviews');

  // UI Lock: freeze layout (splitters / panel toggles) to prevent accidental UI changes.
// Visual QC request: lock UI by default (prevents layout drifting after refresh).
// Fullscreen is still allowed while locked.
  const UI_LOCK_KEY = 'pfx.reviews.uiLock';
  let uiLocked = true;
  try { localStorage.setItem(UI_LOCK_KEY, '1'); } catch {}
  root.classList.add('is-ui-locked');
  const setUiLocked = (on) => {
    uiLocked = !!on;
    root.classList.toggle('is-ui-locked', uiLocked);
    try { localStorage.setItem(UI_LOCK_KEY, uiLocked ? '1' : '0'); } catch {}
  };
  const isUiLocked = () => !!uiLocked;


  // ===== Toolbar =====
  const toolbar = el('div', 'pfx-reviews-toolbar');

  const fileInput = el('input', '');
  fileInput.type = 'file';
  fileInput.accept = 'video/mp4,video/quicktime,.mp4,.mov';
  fileInput.multiple = true;
  fileInput.style.display = 'none';

  const refVideoInput = el('input', '');
  refVideoInput.type = 'file';
  refVideoInput.accept = 'video/mp4,video/quicktime,.mp4,.mov';
  refVideoInput.multiple = true;
  refVideoInput.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';

  const refTimelineInput = el('input', '');
  refTimelineInput.type = 'file';
  refTimelineInput.accept = '.edl,.xml,.otio,.otioz,.fcpxml,.fcpxmld,.xmld,.json';
  refTimelineInput.multiple = true;
  refTimelineInput.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';

  // Relink input (per-clip manual relink)
  const relinkInput = el('input', '');
  relinkInput.type = 'file';
  relinkInput.accept = 'video/mp4,video/quicktime,.mp4,.mov';
  relinkInput.multiple = false;
  relinkInput.style.display = 'none';
  let __pendingRelinkClipId = null;
  let __qcAfterRelinkFn = null;
  relinkInput.addEventListener('change', async () => {
    const f = relinkInput.files && relinkInput.files[0];
    relinkInput.value = '';
    const clipId = __pendingRelinkClipId;
    __pendingRelinkClipId = null;
    const qcFn = __qcAfterRelinkFn;
    __qcAfterRelinkFn = null;
    if (!f || !clipId) return;
    try{
      const prev = (store.state.clips || []).find(c => c && c.id === clipId) || null;
      if (prev && prev.url) { try{ URL.revokeObjectURL(prev.url); }catch(_){} }
      const url = URL.createObjectURL(f);
      store.updateClip(clipId, {
        file: f,
        url,
        canPlay: true,
        durationSec: 0,
        autoRelinked: false,
        fileMeta: {
          name: f.name || prev?.name || 'Untitled',
          size: Number(f.size) || 0,
          lastModified: Number(f.lastModified) || 0,
          type: String(f.type || ''),
        }
      });
      try{ status.textContent = 'Relinked.'; }catch(_){}
      // Best-effort: if this clip is active, reload it so playback works immediately.
      try{
        const activeSeg = store.state.segments?.[store.state.activeIndex] || null;
        if (activeSeg && activeSeg.clipId === clipId) {
          await player.loadAtGlobalTime(store.state.globalTimeSec, { autoplay: false });
        }
      }catch(_){}
      try{ refreshClipsList(); }catch(_){}
      // If relink was triggered from QC, open QC now with the freshly linked clip.
      if (typeof qcFn === 'function'){ try{ qcFn(); }catch(_){} }
    }catch(err){
      try{ status.textContent = 'Relink failed.'; }catch(_){}
    }
  });

  // Import target bin for new media (keeps V1/V2 bins truly separate)
  //  - 'ref'   => V1 (Ref) bin
  //  - 'shots' => V2 (Shots) bin
  let importTarget = 'shots';
  const __pfxOpenMediaPickerForBin = async (target) => {
    const t = String(target || '').toLowerCase();
    const targetBin = (t === 'ref' || t === 'v1') ? 'ref' : 'shots';
    importTarget = targetBin;
    const canUseSystemPicker = (typeof window.showOpenFilePicker === 'function');
    if (canUseSystemPicker) {
      try {
        const handles = await window.showOpenFilePicker({
          multiple: true,
          excludeAcceptAllOption: false,
          types: [{
            description: 'Video files',
            accept: {
              'video/mp4': ['.mp4'],
              'video/quicktime': ['.mov'],
              'video/*': ['.mp4', '.mov', '.m4v', '.mxf', '.avi', '.mkv', '.webm']
            }
          }]
        });
        const hs = Array.isArray(handles) ? handles.filter((h) => h && h.kind === 'file') : [];
        if (hs.length) {
          const files = [];
          for (const h of hs) {
            try {
              if (h.requestPermission) await h.requestPermission({ mode: 'read' });
            } catch {}
            try {
              const f = await h.getFile();
              if (f && __pfxIsVideoFile(f)) files.push(f);
            } catch {}
          }
          if (files.length) {
            await onDropFiles(files, targetBin, hs);
            try { if (targetBin === 'ref' && __pfxGetCurrentTimelineCutModel()) await __pfxApplyTimelineAsV1Reference(); } catch {}
            return;
          }
        }
        return;
      } catch (err) {
        if (String(err?.name || '') === 'AbortError') return;
      }
    }
    try { fileInput.value = ''; } catch {}
    try {
      if (typeof fileInput.showPicker === 'function') fileInput.showPicker();
      else fileInput.click();
    } catch {
      try { fileInput.click(); } catch {}
    }
  };
  const openImport = (target) => {
    void __pfxOpenMediaPickerForBin(target);
  };

  // Import button (moved into the Bin header to keep the red-box area compact)
  const btnAdd = el('button', 'pfx-btn pfx-btn-add', 'Add Clips');
  btnAdd.addEventListener('click', () => openImport('shots'));

  const btnClear = el('button', 'pfx-btn pfx-btn-ghost pfx-btn-clear', 'Clear');

  const fpsSelect = el('select', 'pfx-select');
  for (const v of [23.976, 24, 25, 29.97, 30]) {
    const opt = el('option');
    opt.value = String(v);
    opt.textContent = `FPS ${v}`;
    if (v === 24) opt.selected = true;
    fpsSelect.appendChild(opt);
  }

  const zoomWrap = el('div', 'pfx-reviews-zoomWrap');
  const zoomLabel = el('div', 'pfx-reviews-zoomLabel', 'Zoom');
  const zoom = el('input', 'pfx-reviews-zoom');
  zoom.type = 'range';
  // Wide zoom range so Fit can truly show the whole timeline (even for long cuts)
  // and users can still zoom in deeply when needed.
  zoom.min = '0.01';
  zoom.max = '800';
  // Small step so Fit can land on an exact value (avoids rounding that could hide the true end)
  zoom.step = '0.01';
  zoom.value = String(store.state.pxPerSec);
  zoomWrap.appendChild(zoomLabel);
  zoomWrap.appendChild(zoom);

  const sceneCutDetect = el('div', 'pfx-reviews-sceneCut');
  const btnSceneCutDetect = el('button', 'pfx-btn pfx-btn-ghost pfx-btn-icon pfx-reviews-sceneCutBtn', '');
  btnSceneCutDetect.type = 'button';
  try{ setIconButton(btnSceneCutDetect, 'sceneDetect', 'Scene Cut Detection'); }catch{
    btnSceneCutDetect.title = 'Scene Cut Detection';
    btnSceneCutDetect.setAttribute('aria-label', 'Scene Cut Detection');
    btnSceneCutDetect.innerHTML = iconSvg('sceneDetect');
  }
  const sceneCutSensitivity = el('input', 'pfx-reviews-sceneCutSlider');
  sceneCutSensitivity.type = 'range';
  sceneCutSensitivity.min = '0';
  sceneCutSensitivity.max = '100';
  sceneCutSensitivity.step = '1';
  sceneCutSensitivity.value = String(readSceneCutSensitivity());
  sceneCutSensitivity.title = 'Scene Cut Detect sensitivity';
  const sceneCutSensitivityVal = el('span', 'pfx-reviews-sceneCutVal', String(sceneCutSensitivity.value || '60'));
  const sceneCutMeta = el('span', 'pfx-reviews-sceneCutMeta', 'Cut Detect: —');
  sceneCutDetect.append(btnSceneCutDetect, sceneCutSensitivity, sceneCutSensitivityVal, sceneCutMeta);

  // Program (timeline) transport lives inside the Timeline viewer.

  // Icon glyphs (inline SVG) for compact toolbar buttons
  const ICON_VIEW_1 = iconSvg('oneView');
  const ICON_VIEW_2 = iconSvg('twoView');
  const ICON_FS = iconSvg('fullscreen');
  const ICON_LINK = iconSvg('chain');

  const ICON_EXITFS = iconSvg('fit');

  // Full screen / focus mode (icon-only)
  const btnFull = el('button', 'pfx-btn pfx-btn-ghost pfx-btn-full pfx-btn-icon', '');
  try{ setIconButton(btnFull, 'fullscreen', 'Fullscreen'); }catch{
    btnFull.title = 'Fullscreen';
    btnFull.setAttribute('aria-label', 'Fullscreen');
    btnFull.innerHTML = ICON_FS;
  }

  // Clean Feed (2nd monitor) – Resolve-style output (icon-only)
  const btnClean = el('button', 'pfx-btn pfx-btn-ghost pfx-btn-clean pfx-btn-icon', '');
  try{ setIconButton(btnClean, 'monitor', 'Clean Feed'); }catch{}

  // Relink media — always visible with text label; glows when clips are pending
  const btnRelink = el('button', 'pfx-btn pfx-btn-ghost pfx-btn-relink', '');
  try{ setLabeledIcon(btnRelink, 'chain', 'Relink', { variant:'button', size:'sm' }); }catch{
    btnRelink.title = 'Relink media';
    btnRelink.setAttribute('aria-label', 'Relink media');
    btnRelink.textContent = 'Relink';
  }
  // Wire to shared relink state (always visible — no display:none)
  try{ __pfxBtnRelink = btnRelink; __pfxSetPendingCount(__pfxMediaPendingCount || 0); }catch{}
  // Request permission (user gesture) and relink from all sources
  try{
    btnRelink.addEventListener('click', () => {
      try{ relinkMgr.run({ request: true }); }catch{}
    });
  }catch{}

  // Set Media Folder button — lets user point to a directory once; auto-relinks on every refresh
  const btnMediaFolder = el('button', 'pfx-btn pfx-btn-ghost pfx-btn-mediaFolder', '');
  try{ setLabeledIcon(btnMediaFolder, 'folder', 'Media Folder', { variant:'button', size:'sm' }); }catch{
    btnMediaFolder.title = 'Set Media Folder';
    btnMediaFolder.setAttribute('aria-label', 'Set Media Folder');
    btnMediaFolder.textContent = 'Media Folder';
  }
  // Async: check if a folder is already stored and update tooltip
  (async () => {
    try{
      const stored = await getStoredMediaRootDir();
      if (stored?.name) {
        btnMediaFolder.title = `Media Folder: ${stored.name} (click to change)`;
        btnMediaFolder.setAttribute('aria-label', `Media Folder: ${stored.name}`);
        btnMediaFolder.classList.add('is-active');
      }
    }catch{}
  })();
  btnMediaFolder.addEventListener('click', async () => {
    try{
      status.textContent = 'Picking media folder…';
      const result = await pickMediaRootDirByUser();
      if (!result?.ok) {
        status.textContent = result?.reason === 'cancel' ? '' : 'Media folder: permission denied';
        return;
      }
      const folderName = result.name || 'folder';
      btnMediaFolder.title = `Media Folder: ${folderName} (click to change)`;
      btnMediaFolder.setAttribute('aria-label', `Media Folder: ${folderName}`);
      btnMediaFolder.classList.add('is-active');
      status.textContent = `Media folder set: ${folderName} — relinking…`;
      // Invalidate cached index so a fresh scan runs
      try{ window.__PFX_MEDIA_INDEX = null; }catch{}
      try{ relinkMgr.run({ request: true }); }catch{}
    }catch(err){
      status.textContent = 'Media folder error';
      console.warn('[PFX MEDIA FOLDER]', err?.message);
    }
  });

  // 1 View / 2 View toggle (icon-only; icon indicates the action)
  const btnView = el('button', 'pfx-btn pfx-btn-ghost pfx-btn-view pfx-btn-icon', '');
  try{ setIconButton(btnView, 'oneView', 'Switch to 1 View'); }catch{
    btnView.title = '1 View';
    btnView.setAttribute('aria-label', 'Switch to 1 View');
    btnView.innerHTML = ICON_VIEW_1;
  }

  const applyViewBtn = (m) => {
    // When currently dual -> button action is "switch to 1 view"
    const isDual = (m === 'dual');
    try{ setIconButton(btnView, isDual ? 'oneView' : 'twoView', isDual ? 'Switch to 1 View' : 'Switch to 2 View'); }catch{
      btnView.innerHTML = isDual ? ICON_VIEW_1 : ICON_VIEW_2;
      btnView.title = isDual ? '1 View' : '2 View';
      btnView.setAttribute('aria-label', isDual ? 'Switch to 1 View' : 'Switch to 2 View');
    }
  };

  const applyFullBtn = (isExit) => {
    try{ setIconButton(btnFull, isExit ? 'fit' : 'fullscreen', isExit ? 'Exit Fullscreen' : 'Fullscreen'); }catch{
      btnFull.innerHTML = isExit ? ICON_EXITFS : ICON_FS;
      btnFull.title = isExit ? 'Exit Fullscreen' : 'Fullscreen';
      btnFull.setAttribute('aria-label', isExit ? 'Exit Fullscreen' : 'Fullscreen');
    }
  };
  // Drawer toggles (Resolve-style)
  const btnBin = el('button', 'pfx-btn pfx-btn-ghost pfx-btn-bin', 'Bin');
  const btnNotes = el('button', 'pfx-btn pfx-btn-ghost pfx-btn-notes', 'Notes');

  const btnExportJSON = el('button', 'pfx-btn pfx-btn-ghost pfx-btn-export', 'Export JSON');
  const btnExportCSV = el('button', 'pfx-btn pfx-btn-ghost pfx-btn-export', 'Export CSV');

  // Compact export menu (keeps the toolbar clean)
  const btnExport = el('button', 'pfx-btn pfx-btn-ghost pfx-btn-export pfx-btn-exportMenu', 'Export ▾');
  const exportMenu = el('div', 'pfx-reviews-menu');
  const miJSON = el('button', 'pfx-reviews-menuItem', 'Export Notes (JSON)');
  const miCSV = el('button', 'pfx-reviews-menuItem', 'Export Notes (CSV)');
  const miPDF = el('button', 'pfx-reviews-menuItem', 'Export Report (PDF)');
  exportMenu.append(miJSON, miCSV, miPDF);

  // Status line — shown in the toolbar midSlot for codec / transcode feedback.
  const status = el('div', 'pfx-reviews-status', '');

  const rightGroup = el('div', 'pfx-reviews-toolbarGroup');
  // Export moved to toolbar right group (top controls bar) per UX request.
  // Wrap btnExport + exportMenu so position:absolute menu anchors to the button.
  const exportWrap = el('div', 'pfx-reviews-exportWrap');
  exportWrap.append(btnExport, exportMenu);
  rightGroup.append(btnRelink, btnView, btnClean, btnFull, exportWrap);

  // Mid slot (green box): reserved space between left tools and right actions.
  // We'll mount the timeline zoom bar (Fit / - / + / % / Home / End) here.
  const midSlot = el('div', 'pfx-reviews-midSlot');

  // Keep the main toolbar minimal (no Add/FPS in the red box).
  // Requested: remove the Clear + Zoom block from the lower source bar.
  // Keep both controls alive off-DOM so existing logic/state sync continues to work.
  midSlot.append(status);
  toolbar.append(
    sceneCutDetect,
    midSlot,
    rightGroup,
  );

  try{ setLabeledIcon(btnClear, 'clear', 'Clear', { variant:'button', size:'sm' }); }catch{}
  try{ setLabeledIcon(btnExport, 'exportEdl', 'Export', { variant:'button', trailingHtml:' <span class="otio-caret" aria-hidden="true"></span>' }); }catch{}
  // Icon setup moved below — srcOpen, srcStepBack, srcPrev, srcPlay, srcNext, srcStepFwd, btnPrev, btnPlay, btnNext, pgFull are declared later in this scope.

  // Hide legacy export buttons (now inside the compact menu)
  btnExportJSON.style.display = 'none';
  btnExportCSV.style.display = 'none';

  const __pfxSetSceneCutMeta = (text, isBusy = false) => {
    try { sceneCutMeta.textContent = text || 'Cut Detect: —'; } catch {}
    try { sceneCutDetect.classList.toggle('is-busy', !!isBusy); } catch {}
    try { sceneCutMeta.classList.toggle('is-busy', !!isBusy); } catch {}
  };

  const __pfxSyncSceneCutToolbar = () => {
    try { sceneCutSensitivityVal.textContent = String(clampSceneCutSensitivity(sceneCutSensitivity.value)); } catch {}
    try { btnSceneCutDetect.disabled = __pfxV1CutsBusy; } catch {}
    try { sceneCutSensitivity.disabled = __pfxV1CutsBusy; } catch {}
    if (!__pfxV1CutsBusy) {
      try {
        const summary = __pfxGetV1CutsAggregate();
        __pfxSetSceneCutMeta(summary.segments ? `Cut Detect: ${summary.segments} seg` : 'Cut Detect: —', false);
      } catch {
        __pfxSetSceneCutMeta('Cut Detect: —', false);
      }
    }
  };

  // ===== Main layout (NLE-style) =====
  const layout = el("div", "pfx-reviews-layout pfx-reviews-nle");

  // Left: Bin (clips list)
  const bin = el("div", "pfx-reviews-bin");

  // V1 / V2 split bin (Ref vs Shots)
  const refCard = el("div", "pfx-reviews-card pfx-reviews-card--ref");
  const refHeader = el("div", "pfx-reviews-cardHeader pfx-reviews-cardHeader--v1AutoCut");
  const refTitleWrap = el('div', 'pfx-reviews-cardTitleWrap');
  const refTitle = el("div", "pfx-reviews-cardTitle", "");
  refTitle.innerHTML = `<span class="pfx-card-title-ico" aria-hidden="true">${iconSvg('oneView')}</span><span class="pfx-card-title-txt">V1 (Ref)</span>`;
  const refAutoCutSummary = el('div', 'pfx-reviews-autoCutSummary', '—');
  refTitleWrap.append(refTitle, refAutoCutSummary);
  const refHeaderMediaState = el('div', 'pfx-reviews-headerMediaState pfx-reviews-headerMediaState--ref');
  // V1 tools: Auto Cut Detect (splits V1 into shot-sized segments so Prev/Next works like a shot nav).
  const refActions = el('div', 'pfx-reviews-binHeaderActions pfx-reviews-autoCutControls');
  const refActionsPrimary = el('div', 'pfx-reviews-autoCutRow pfx-reviews-autoCutRow--primary');
  const refActionsSecondary = el('div', 'pfx-reviews-autoCutRow pfx-reviews-autoCutRow--secondary');
  const autoCutMode = el('select', 'pfx-reviews-binSort pfx-reviews-autoCutSelect');
  autoCutMode.title = 'Auto Cut mode';
  [['shot', 'Shot'], ['detailed', 'Detailed']].forEach(([value, label]) => {
    const opt = el('option');
    opt.value = value;
    opt.textContent = label;
    autoCutMode.append(opt);
  });
  const autoCutPreset = el('select', 'pfx-reviews-binSort pfx-reviews-autoCutSelect');
  autoCutPreset.title = 'Auto Cut preset';
  [['rough', 'Rough'], ['standard', 'Standard'], ['fine', 'Fine']].forEach(([value, label]) => {
    const opt = el('option');
    opt.value = value;
    opt.textContent = label;
    autoCutPreset.append(opt);
  });
  const autoCutIgnore = el('select', 'pfx-reviews-binSort pfx-reviews-autoCutSelect pfx-reviews-autoCutIgnore');
  autoCutIgnore.title = 'Ignore overlays / burn-ins while detecting cuts';
  [['none', 'Ignore: Off'], ['watermark_top', 'Ignore: Top WM'], ['burnin_ll', 'Ignore: LL Burn-in'], ['bottom_wide', 'Ignore: Bottom Bar'], ['common_overlays', 'Ignore: Common'], ['custom', 'Ignore: Custom']].forEach(([value, label]) => {
    const opt = el('option');
    opt.value = value;
    opt.textContent = label;
    autoCutIgnore.append(opt);
  });
  const btnV1AutoCuts = el('button', 'pfx-reviews-binToggle', 'Cut Detect');
  btnV1AutoCuts.title = 'Scene Cut Detection on the V1 timeline';
  const btnV1ClearCuts = el('button', 'pfx-reviews-binToggle', 'Clear');
  btnV1ClearCuts.title = 'Clear V1 cut segments (merge back to full clip)';
  const btnV1EditROI = el('button', 'pfx-reviews-binToggle', 'ROI…');
  btnV1EditROI.title = 'Edit custom Auto Cut ignore regions';
  const btnV1DrawROI = el('button', 'pfx-reviews-binToggle', 'Draw ROI');
  btnV1DrawROI.title = 'Draw custom Auto Cut ignore regions directly on the Program viewer';
  const btnV1ClearROI = el('button', 'pfx-reviews-binToggle', 'Clear ROI');
  btnV1ClearROI.title = 'Clear all custom Auto Cut ignore regions';
  const btnV1CopyROI = el('button', 'pfx-reviews-binToggle', 'Copy ROI');
  btnV1CopyROI.title = 'Copy current custom ROI regions';
  const btnV1PasteROI = el('button', 'pfx-reviews-binToggle', 'Paste ROI');
  btnV1PasteROI.title = 'Paste ROI regions from clipboard or JSON';
  autoCutMode.addEventListener('change', () => {
    try { store.setAutoCutSettings({ mode: autoCutMode.value }); } catch {}
    try { __pfxScheduleAutosave({ force: true }); } catch {}
  });
  autoCutPreset.addEventListener('change', () => {
    try { store.setAutoCutSettings({ preset: autoCutPreset.value }); } catch {}
    try { __pfxScheduleAutosave({ force: true }); } catch {}
  });
  autoCutIgnore.addEventListener('change', () => {
    try {
      const key = String(autoCutIgnore.value || 'none');
      if (key === 'custom') return;
      const nextRegions = AUTO_CUT_IGNORE_PRESETS[key] || [];
      store.setAutoCutSettings({ ignoreRegions: normalizeIgnorePresetRegions(nextRegions) });
    } catch {}
    try { __pfxScheduleAutosave({ force: true }); } catch {}
  });
  refActionsPrimary.append(autoCutMode, autoCutPreset, btnV1AutoCuts, btnV1ClearCuts);
  refActionsSecondary.append(autoCutIgnore, btnV1EditROI, btnV1DrawROI, btnV1ClearROI, btnV1CopyROI, btnV1PasteROI);
  const PFX_V1_HEADER_ROI_VISIBLE = false;
  refActions.append(refActionsPrimary);
  if (PFX_V1_HEADER_ROI_VISIBLE) refActions.append(refActionsSecondary);
  const PFX_V1_CUT_TOOLS_VISIBLE = false;
  const refCutDock = el('div', 'pfx-reviews-cutDock pfx-reviews-cutDock--merged');
  if (!PFX_V1_CUT_TOOLS_VISIBLE) refCutDock.classList.add('pfx-reviews-cutDock--infoOnly');
  const refCutInspector = el('div', 'pfx-reviews-cutInspector');
  const refCutInspectorTop = el('div', 'pfx-reviews-cutInspectorTop');
  const refCutInspectorBody = el('div', 'pfx-reviews-cutInspectorBody');
  const refCutInspectorMain = el('div', 'pfx-reviews-cutInspectorMain', 'No active segment');
  const refCutInspectorSub = el('div', 'pfx-reviews-cutInspectorSub', 'No cut selected');
  const refCutInspectorMeta = el('div', 'pfx-reviews-cutInspectorMeta');
  const btnV1AutoCutsDock = el('button', 'pfx-reviews-binToggle pfx-reviews-cutInspectorAction', 'Scene Detect');
  btnV1AutoCutsDock.title = 'Scene Cut Detection on the V1 timeline';
  const btnV1LoadTimelineCuts = el('button', 'pfx-reviews-binToggle pfx-reviews-cutInspectorAction', 'Load TL');
  btnV1LoadTimelineCuts.title = 'Load the current project timeline as cut reference for V1';

  const refImportDock = el('div', 'pfx-reviews-refImportDock');

  const refVideoImportRow = el('div', 'pfx-reviews-refImportRow sm-importdock-row');
  refVideoImportRow.dataset.importKind = 'video';
  const refVideoImportBtn = el('label', 'pfx-reviews-refImportBtn sm-importdock-btn');
  refVideoImportBtn.title = 'Load V1 video ref';
  refVideoImportBtn.setAttribute('for', 'pfx-ref-video-input');
  refVideoImportBtn.innerHTML = `
    <span class="sm-importdock-ico" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="4" y="5" width="12" height="14" rx="2"></rect>
        <path d="M16 10l4-2v8l-4-2z"></path>
      </svg>
    </span>
    <span class="sm-importdock-copy">
      <span class="sm-importdock-label">Video</span>
      <span class="sm-importdock-meta">Click or drop file</span>
    </span>`;
  const refVideoImportMeta = refVideoImportBtn.querySelector('.sm-importdock-meta');
  refVideoInput.className = 'pfx-native-file-input';
  refVideoInput.style.cssText = '';
  refVideoInput.id = 'pfx-ref-video-input';
  refVideoInput.setAttribute('aria-label', 'Load V1 video ref');
  refVideoInput.title = 'Load V1 video ref';
  refVideoImportBtn.appendChild(refVideoInput);
  const refVideoImportRemove = el('button', 'pfx-reviews-refImportRemove sm-importdock-remove btn ghost');
  refVideoImportRemove.type = 'button';
  refVideoImportRemove.title = 'Remove V1 video ref';
  refVideoImportRemove.setAttribute('aria-label', 'Remove V1 video ref');
  refVideoImportRemove.disabled = true;
  try { setIconButton(refVideoImportRemove, 'trash', 'Remove V1 video ref'); } catch {}
  refVideoImportRow.append(refVideoImportBtn, refVideoImportRemove);

  const refTimelineImportRow = el('div', 'pfx-reviews-refImportRow sm-importdock-row');
  refTimelineImportRow.dataset.importKind = 'timeline';
  const refTimelineImportBtn = el('label', 'pfx-reviews-refImportBtn sm-importdock-btn');
  refTimelineImportBtn.title = 'Load timeline as V1 cut reference';
  refTimelineImportBtn.setAttribute('for', 'pfx-ref-timeline-input');
  refTimelineImportBtn.innerHTML = `
    <span class="sm-importdock-ico" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 6.5h16"></path>
        <path d="M4 12h16"></path>
        <path d="M4 17.5h16"></path>
        <rect x="6" y="5" width="4" height="3" rx="1"></rect>
        <rect x="12" y="10.5" width="5" height="3" rx="1"></rect>
        <rect x="9" y="16" width="6" height="3" rx="1"></rect>
      </svg>
    </span>
    <span class="sm-importdock-copy">
      <span class="sm-importdock-label">Timeline</span>
      <span class="sm-importdock-meta">Click or drop file</span>
    </span>`;
  const refTimelineImportMeta = refTimelineImportBtn.querySelector('.sm-importdock-meta');
  refTimelineInput.className = 'pfx-native-file-input';
  refTimelineInput.style.cssText = '';
  refTimelineInput.id = 'pfx-ref-timeline-input';
  refTimelineInput.setAttribute('aria-label', 'Load timeline as V1 cut reference');
  refTimelineInput.title = 'Load timeline as V1 cut reference';
  refTimelineImportBtn.appendChild(refTimelineInput);
  const refTimelineImportRemove = el('button', 'pfx-reviews-refImportRemove sm-importdock-remove btn ghost');
  refTimelineImportRemove.type = 'button';
  refTimelineImportRemove.title = 'Remove timeline cut reference';
  refTimelineImportRemove.setAttribute('aria-label', 'Remove timeline cut reference');
  refTimelineImportRemove.disabled = true;
  try { setIconButton(refTimelineImportRemove, 'trash', 'Remove timeline cut reference'); } catch {}
  refTimelineImportRow.append(refTimelineImportBtn, refTimelineImportRemove);
  refImportDock.append(refVideoImportRow, refTimelineImportRow);

  refCutInspectorTop.append(refCutInspectorMain, btnV1AutoCutsDock);
  refCutInspectorBody.append(refCutInspectorSub, refCutInspectorMeta);
  refCutInspector.append(refCutInspectorTop, refCutInspectorBody);
  const refCutBtns = el('div', 'pfx-reviews-cutButtons');
  const refCutRowPrimary = el('div', 'pfx-reviews-cutButtonRow pfx-reviews-cutButtonRow--4');
  const refCutRowReviewNav = el('div', 'pfx-reviews-cutButtonRow pfx-reviews-cutButtonRow--4');
  const refCutRowReviewMode = el('div', 'pfx-reviews-cutButtonRow pfx-reviews-cutButtonRow--3');
  const refCutRowNudge = el('div', 'pfx-reviews-cutButtonRow pfx-reviews-cutButtonRow--4');
  const __pfxRoiFieldMap = Object.create(null);
  const makeRoiField = (labelText, key) => {
    const wrap = el('label', 'pfx-reviews-roiField');
    const label = el('span', 'pfx-reviews-roiFieldLabel', labelText);
    const input = el('input', 'pfx-reviews-roiFieldInput');
    input.type = 'number';
    input.min = '0';
    input.max = '100';
    input.step = '0.1';
    input.inputMode = 'decimal';
    input.dataset.key = key;
    wrap.append(label, input);
    __pfxRoiFieldMap[key] = input;
    return wrap;
  };
  const btnV1Split = el('button', 'pfx-reviews-binToggle pfx-reviews-cutTool', 'Split');
  btnV1Split.title = 'Split the active V1 segment at the playhead';
  const btnV1MergePrev = el('button', 'pfx-reviews-binToggle pfx-reviews-cutTool', 'M←');
  btnV1MergePrev.title = 'Merge the active segment with the previous one';
  const btnV1MergeNext = el('button', 'pfx-reviews-binToggle pfx-reviews-cutTool', 'M→');
  btnV1MergeNext.title = 'Merge the active segment with the next one';
  const btnV1ToggleUncertain = el('button', 'pfx-reviews-binToggle pfx-reviews-cutTool', 'Unsure');
  btnV1ToggleUncertain.title = 'Toggle uncertain flag on the selected / nearest cut';
  const btnV1PrevUnsure = el('button', 'pfx-reviews-binToggle pfx-reviews-cutTool pfx-reviews-cutTool--review', '?←');
  btnV1PrevUnsure.title = 'Jump to previous uncertain cut';
  const btnV1NextUnsure = el('button', 'pfx-reviews-binToggle pfx-reviews-cutTool pfx-reviews-cutTool--review', '?→');
  btnV1NextUnsure.title = 'Jump to next uncertain cut';
  const btnV1UnsureOnly = el('button', 'pfx-reviews-binToggle pfx-reviews-cutTool pfx-reviews-cutTool--review', 'Only?');
  btnV1UnsureOnly.title = 'Show only uncertain markers on the timeline';
  const btnV1AcceptUnsure = el('button', 'pfx-reviews-binToggle pfx-reviews-cutTool pfx-reviews-cutTool--review', 'Acc ?');
  btnV1AcceptUnsure.title = 'Accept all uncertain cuts on the V1 timeline';
  const btnV1RejectUnsure = el('button', 'pfx-reviews-binToggle pfx-reviews-cutTool pfx-reviews-cutTool--review', 'Rej ?');
  btnV1RejectUnsure.title = 'Remove all uncertain cuts on the V1 timeline';
  const btnV1AcceptClipUnsure = el('button', 'pfx-reviews-binToggle pfx-reviews-cutTool pfx-reviews-cutTool--review', 'Acc clip');
  btnV1AcceptClipUnsure.title = 'Accept uncertain cuts only for the selected V1 clip';
  const btnV1RejectClipUnsure = el('button', 'pfx-reviews-binToggle pfx-reviews-cutTool pfx-reviews-cutTool--review', 'Rej clip');
  btnV1RejectClipUnsure.title = 'Remove uncertain cuts only for the selected V1 clip';
  btnV1Split.classList.add('is-accent');
  btnV1ToggleUncertain.classList.add('is-accent');
  btnV1AcceptClipUnsure.classList.add('is-wide');
  btnV1RejectClipUnsure.classList.add('is-wide');
  const btnV1NudgeMinus5 = el('button', 'pfx-reviews-binToggle pfx-reviews-cutTool', '-5f');
  btnV1NudgeMinus5.title = 'Nudge selected / nearest cut earlier by 5 frames';
  const btnV1NudgeMinus1 = el('button', 'pfx-reviews-binToggle pfx-reviews-cutTool', '-1f');
  btnV1NudgeMinus1.title = 'Nudge selected / nearest cut earlier by 1 frame';
  const btnV1NudgePlus1 = el('button', 'pfx-reviews-binToggle pfx-reviews-cutTool', '+1f');
  btnV1NudgePlus1.title = 'Nudge selected / nearest cut later by 1 frame';
  const btnV1NudgePlus5 = el('button', 'pfx-reviews-binToggle pfx-reviews-cutTool', '+5f');
  btnV1NudgePlus5.title = 'Nudge selected / nearest cut later by 5 frames';
  refCutRowPrimary.append(btnV1Split, btnV1ToggleUncertain, btnV1MergePrev, btnV1MergeNext);
  refCutRowReviewNav.append(btnV1PrevUnsure, btnV1NextUnsure, btnV1UnsureOnly, btnV1AcceptUnsure);
  refCutRowReviewMode.append(btnV1RejectUnsure, btnV1AcceptClipUnsure, btnV1RejectClipUnsure);
  refCutRowNudge.append(btnV1NudgeMinus5, btnV1NudgeMinus1, btnV1NudgePlus1, btnV1NudgePlus5);
  refCutBtns.append(refCutRowPrimary, refCutRowReviewNav, refCutRowReviewMode, refCutRowNudge);
  refCutDock.append(refImportDock, refCutInspector);
  if (PFX_V1_CUT_TOOLS_VISIBLE) refCutDock.append(refCutBtns);
  const refRoiDock = el('div', 'pfx-reviews-roiDock');
  const refRoiInspector = el('div', 'pfx-reviews-roiInspector', 'ROI: none');
  const refRoiPills = el('div', 'pfx-reviews-roiPills');
  const refRoiFields = el('div', 'pfx-reviews-roiFields');
  refRoiFields.append(makeRoiField('X', 'x'), makeRoiField('Y', 'y'), makeRoiField('W', 'w'), makeRoiField('H', 'h'));
  const refRoiTools = el('div', 'pfx-reviews-roiButtons');
  const roiSnapSelect = el('select', 'pfx-reviews-binSort pfx-reviews-autoCutSelect pfx-reviews-roiSnapSelect');
  [['0', 'Snap Off'], ['0.005', 'Snap 0.5%'], ['0.01', 'Snap 1%'], ['0.02', 'Snap 2%'], ['0.05', 'Snap 5%'], ['0.1', 'Snap 10%']].forEach(([value, label]) => {
    const opt = el('option');
    opt.value = value;
    opt.textContent = label;
    roiSnapSelect.append(opt);
  });
  roiSnapSelect.title = 'Snap ROI edits to a grid';
  const btnV1RoiPrev = el('button', 'pfx-reviews-binToggle pfx-reviews-cutTool', '←ROI');
  btnV1RoiPrev.title = 'Select previous ROI';
  const btnV1RoiNext = el('button', 'pfx-reviews-binToggle pfx-reviews-cutTool', 'ROI→');
  btnV1RoiNext.title = 'Select next ROI';
  const btnV1RoiDuplicate = el('button', 'pfx-reviews-binToggle pfx-reviews-cutTool', 'Dup');
  btnV1RoiDuplicate.title = 'Duplicate selected ROI';
  const btnV1RoiSnapNow = el('button', 'pfx-reviews-binToggle pfx-reviews-cutTool', 'Snap');
  btnV1RoiSnapNow.title = 'Snap the selected ROI to the current grid';
  const btnV1RoiApply = el('button', 'pfx-reviews-binToggle pfx-reviews-cutTool', 'Apply');
  btnV1RoiApply.title = 'Apply numeric ROI values';
  refRoiTools.append(roiSnapSelect, btnV1RoiPrev, btnV1RoiNext, btnV1RoiDuplicate, btnV1RoiSnapNow, btnV1RoiApply);
  refRoiDock.append(refRoiInspector, refRoiPills, refRoiFields, refRoiTools);
  // Remove Auto Cut controls from the left red box. Scene Cut Detection lives in the center toolbar.
  refHeader.append(refTitleWrap, refHeaderMediaState);
  const refBody = el("div", "pfx-reviews-cardBody pfx-reviews-refBody");
  refCutDock.append(refBody);
  refCard.append(refHeader, refCutDock);

  const clipsCard = el("div", "pfx-reviews-card pfx-reviews-card--shots");
  // V2 header: clean 2-row layout (title/actions on top, search/sort below)
  const clipsHeader = el("div", "pfx-reviews-cardHeader pfx-reviews-cardHeader--shotsTools");
  const clipsHeaderTop = el('div', 'pfx-reviews-binHeaderTop');
  const clipsHeaderActions = el('div', 'pfx-reviews-binHeaderActions');
  const clipsHeaderBottom = el('div', 'pfx-reviews-binHeaderBottom');
  const clipsTitleWrap = el('div', 'pfx-reviews-cardTitleWrap pfx-reviews-cardTitleWrap--shots');
  const clipsTitle = el("div", "pfx-reviews-cardTitle", "");
  clipsTitle.innerHTML = `<span class="pfx-card-title-ico" aria-hidden="true">${iconSvg('events')}</span><span class="pfx-card-title-txt">V2 (Shots)</span>`;
  const clipsHeaderMediaState = el('div', 'pfx-reviews-headerMediaState pfx-reviews-headerMediaState--shots');
  clipsTitleWrap.append(clipsTitle, clipsHeaderMediaState);

  // Quick action: remove all clips (requested in the red box)
  const btnRemoveAllClips = el('button', 'pfx-reviews-binToggle pfx-reviews-binDanger', 'Clear');
  btnRemoveAllClips.title = 'Remove all clips (clears Bin, Timeline, overlays and Notes)';
  btnRemoveAllClips.addEventListener('click', () => {
    const n = (store.state.clips || []).length;
    if (!n) return;
    const ok = confirm(`Remove all ${n} clips? This will also clear timeline/overlays and notes.`);
    if (!ok) return;
    store.clearAll();
    status.textContent = 'Cleared';
    // Persist explicit clear (empty snapshot) so old clips don't resurrect after refresh.
    try{ void __pfxSaveAutosaveNow({ allowEmpty:true, force:true }).catch(()=>{}); }catch{}
  });

  const clipsSearch = el('input', 'pfx-reviews-binSearch');
  clipsSearch.type = 'search';
  clipsSearch.placeholder = 'Search…';
  clipsSearch.autocomplete = 'off';

  const clipsSort = el('select', 'pfx-reviews-binSort');
  const so1 = el('option'); so1.value = 'timeline'; so1.textContent = 'Timeline';
  const so2 = el('option'); so2.value = 'name_asc'; so2.textContent = 'Name A→Z';
  const so3 = el('option'); so3.value = 'name_desc'; so3.textContent = 'Name Z→A';
  const so4 = el('option'); so4.value = 'recent'; so4.textContent = 'Recent';
  clipsSort.append(so1, so2, so3, so4);

  const clipsCount = el('div', 'pfx-reviews-binCount', '0');
  const btnBinCompact = el('button', 'pfx-reviews-binToggle', '▦');
  btnBinCompact.title = 'Compact Bin';
  btnBinCompact.addEventListener('click', () => {
    if (isUiLocked()) return;
    bin.classList.toggle('is-compact');
  });

  // Remove import (+) button from the red box (drag&drop is the primary ingest).

  // FPS selector is still available but hidden by default (advanced use).
  fpsSelect.classList.add('pfx-reviews-fpsHidden');

  // Top row: Title + quick actions (count / compact / clear)
  clipsHeaderActions.append(clipsCount, btnBinCompact, btnRemoveAllClips);
  clipsHeaderTop.append(clipsTitleWrap, clipsHeaderActions);
  // Bottom row: Search + Sort
  clipsHeaderBottom.append(clipsSearch, clipsSort);

  clipsHeader.append(clipsHeaderTop, clipsHeaderBottom);
  const clipsBody = el("div", "pfx-reviews-cardBody");
  // Keyboard focus + navigation
  //  - bin: left bin list
  //  - source: source viewer
  //  - timeline: timeline + viewer
  //  - notes: notes list + editor
  let keyFocus = 'timeline'; // 'bin' | 'source' | 'timeline' | 'notes'
  let binVisibleIds = [];
  let notesVisibleIds = [];

  // ===== Smart compact bin (100+ shots, many versions) =====
  // We keep the list space-efficient by grouping items by shot name and
  // collapsing versions by default (Resolve/Premiere style list organization).
  const BIN_OPEN_GROUPS_KEY = 'pfx.reviews.bin.openGroups';
  /** @type {Set<string>} */
  let binOpenGroups = new Set();
  /** @type {Map<string,string>} clipId -> groupKey */
  let binClipToGroup = new Map();
  try {
    const raw = localStorage.getItem(BIN_OPEN_GROUPS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) binOpenGroups = new Set(arr.map(x => String(x)));
  } catch {}

  const saveBinOpenGroups = () => {
    try { localStorage.setItem(BIN_OPEN_GROUPS_KEY, JSON.stringify(Array.from(binOpenGroups))); } catch {}
  };

  const setGroupOpen = (groupKey, open) => {
    if (!groupKey) return;
    const k = String(groupKey);
    if (open) binOpenGroups.add(k);
    else binOpenGroups.delete(k);
    saveBinOpenGroups();
    // Keep current selection
    const keep = pinnedBinClipId;
    refreshClipsList();
    if (keep) {
      try { clipsBody.querySelector(`[data-clip-id="${keep}"]`)?.scrollIntoView?.({ block: 'nearest' }); } catch {}
    }
  };

  const toggleGroupOpen = (groupKey) => {
    const k = String(groupKey);
    setGroupOpen(k, !binOpenGroups.has(k));
  };
  clipsCard.append(clipsHeader, clipsBody);
  bin.appendChild(refCard);
  bin.appendChild(clipsCard);

  // Right: Notes
  const notes = el("div", "pfx-reviews-notes");
  // Resolve-style filmstrip docked under the timeline.
  notes.classList.add('is-filmstrip');
  const markersCard = el("div", "pfx-reviews-card");
  const markersBody = el("div", "pfx-reviews-cardBody");
  markersCard.append(markersBody);
  notes.appendChild(markersCard);

  // Selected marker editor
  const markerEditor = el("div", "pfx-reviews-markerEditor");
  const markerTc = el("div", "pfx-reviews-markerMeta", "");

  // Approve system (smart for large reviews)
  const markerStatusRow = el('div', 'pfx-reviews-markerStatusRow');
  const stOk = el('button', 'pfx-pill pfx-pill-status', 'APPROVED');
  const stFix = el('button', 'pfx-pill pfx-pill-status', 'NEED FIX');
  stOk.dataset.status = 'APPROVED';
  stFix.dataset.status = 'NEED_FIX';
  const statusBtns = [stOk, stFix];
  markerStatusRow.append(stOk, stFix);

  const __normalizeMarkerStatus = (status) => {
    const s = String(status || '').trim().toUpperCase();
    if (s === 'APPROVED') return 'APPROVED';
    if (s === 'NEED_FIX' || s === 'NEED FIX') return 'NEED_FIX';
    if (s === 'HOLD') return 'HOLD';
    return '';
  };

  const __markerStatusLabel = (status) => {
    const s = __normalizeMarkerStatus(status);
    if (s === 'NEED_FIX') return 'NEED FIX';
    return s;
  };


  // QC tags (Issue Type + Severity)
  const markerTagsRow = el('div', 'pfx-reviews-markerTagsRow');
  const issueSel = el('select', 'pfx-reviews-markerSelect');
  issueSel.title = 'Issue Type';
  const __issues = ['General','Edge/Matte','Grain/Noise','Tracking','Stabilize','Reformat/Crop','Integration','Continuity','Other'];
  for (const v of __issues) {
    const o = el('option');
    o.value = v;
    o.textContent = v;
    issueSel.appendChild(o);
  }
  const sevSel = el('select', 'pfx-reviews-markerSelect');
  sevSel.title = 'Severity';
  const __sevs = [['S1','S1 Critical'],['S2','S2 Major'],['S3','S3 Minor']];
  for (const pair of __sevs) {
    const o = el('option');
    o.value = pair[0];
    o.textContent = pair[1];
    sevSel.appendChild(o);
  }
  // NOTE: noteTypeSel is declared below (after options builder). Avoid TDZ by appending it later.
  markerTagsRow.append(issueSel, sevSel);

  // Spot-On style Note Type (Add/Remove/Change)
  const noteTypeSel = el('select', 'pfx-reviews-markerSelect');
  noteTypeSel.title = 'Scope / Note Type';

  const buildNoteTypeOptions = () => {
    const cfg = (typeof window.PFX_getNoteTypesConfig === 'function') ? window.PFX_getNoteTypesConfig() : null;
    const def = cfg || { add: [], remove: [], change: [] };

    noteTypeSel.innerHTML = '';
    const o0 = el('option');
    o0.value = '';
    o0.textContent = '— Note Type —';
    noteTypeSel.appendChild(o0);

    const groups = [ ['add','Add'], ['remove','Remove'], ['change','Change'] ];
    for (const [key, label] of groups) {
      const og = document.createElement('optgroup');
      og.label = label;
      const arr = Array.isArray(def[key]) ? def[key] : [];
      for (const v of arr) {
        const o = el('option');
        o.value = `${key}|${v}`;
        o.textContent = v;
        og.appendChild(o);
      }
      noteTypeSel.appendChild(og);
    }
  };

  buildNoteTypeOptions();
  try{ window.addEventListener('pfx:notetypes-changed', buildNoteTypeOptions); }catch{}

  // Now safe to append (noteTypeSel is initialized)
  markerTagsRow.append(noteTypeSel);



  // Thumbnail + annotate (draw/circle)
  const markerThumbWrap = el('div', 'pfx-reviews-markerThumbWrap');
  const markerThumb = el('img', 'pfx-reviews-markerThumb');
  // Prevent browsers from showing alt-text in the panel when the img has no src.
  markerThumb.alt = '';
  markerThumbWrap.append(markerThumb);

  const markerNote = el("textarea", "pfx-reviews-markerNote");
  markerNote.placeholder = "Note / Scope of Work";
  const markerActions = el("div", "pfx-reviews-markerActions");
  // UI cleanup: no footer actions in the Notes panel (keep it compact)
  try{ markerActions.style.display = "none"; }catch{}
  const btnDelMarker = el("button", "pfx-btn pfx-btn-ghost pfx-btn-danger", "Delete");
  // UI cleanup: hide Delete button (use Delete/Backspace or context actions)
  try{ btnDelMarker.style.display = "none"; }catch{}
  markerActions.append(btnDelMarker);
  // NOTE: Scope of Work is edited via the main note field + Annotate modal.
  // Keep a single field here to avoid duplicated UI.
  // Note is appended directly to inspectorDock (not inside markerEditor) so it
  // naturally sits at the bottom of the flex-column dock without any grid fighting.
  markerEditor.append(markerTc, markerStatusRow, markerTagsRow, markerThumbWrap, markerActions);

  const inspectorDock = el("div", "pfx-reviews-inspectorDock");
  inspectorDock.append(markerEditor, markerNote);

  // Center: dual viewers + timeline
  const center = el("div", "pfx-reviews-center");
  const viewers = el("div", "pfx-reviews-viewers");
  // Splitters for pro resizing (Resolve-style)
  const splitX = el('div', 'pfx-reviews-splitter pfx-reviews-splitter-x');
  const splitY = el('div', 'pfx-reviews-splitter pfx-reviews-splitter-y');

  // Source viewer (selected clip)
  const sourceWrap = el("div", "pfx-reviews-viewerWrap");
  const sourceTitle = el("div", "pfx-reviews-viewerTitle", "");
  sourceTitle.innerHTML = `<span class="pfx-card-title-ico" aria-hidden="true">${iconSvg('input')}</span><span class="pfx-card-title-txt">Source</span>`;
  // Pro transport bar (Resolve-like)
  const sourceControls = el('div', 'pfx-reviews-proControls pfx-reviews-proControls-sourceCompact');
  const srcLeft = el('div', 'pc-left');
  const srcBtns = el('div', 'pc-btnGroup');
  const srcOpen = el('button', 'pc-btn pc-open', '📁');
  const srcStepBack = el('button', 'pc-btn', '⟸');
  const srcPrev = el('button', 'pc-btn', '⏮');
  const srcPlay = el('button', 'pc-btn pc-play', '▶');
  const srcNext = el('button', 'pc-btn', '⏭');
  const srcStepFwd = el('button', 'pc-btn', '⟹');
  // Compact source transport: keep only prev / play / next in the visible bar.
  srcBtns.append(srcStepBack, srcPrev, srcPlay, srcNext, srcStepFwd);

  const srcIO = el('div', 'pc-io');
  const srcIn = el('button', 'pc-pill', 'I');
  const srcOut = el('button', 'pc-pill', 'O');
  const srcClearIO = el('button', 'pc-pill', '✕');
  const srcToV1 = el('button', 'pc-pill', 'To V1');
  srcToV1.title = 'Append to V1 Timeline';
  const srcToV2 = el('button', 'pc-pill pc-pill-accent', 'To V2');
  srcToV2.title = 'Add as V2 overlay at playhead';
  // Hide I / O / Clear from the compact source bar to save space.
  srcIO.append(srcToV1, srcToV2);
  srcLeft.append(srcBtns, srcIO);

  const srcScrub = el('input', 'pc-scrub');
  srcScrub.type = 'range';
  srcScrub.min = '0';
  srcScrub.max = '1';
  srcScrub.step = '0.001';
  srcScrub.value = '0';

  const srcDots = el('div', 'pc-dots');
  srcDots.innerHTML = '<span></span><span></span><span></span>';

  const srcRight = el('div', 'pc-right');
  const srcMediaState = el('div', 'pc-mediaState');
  const srcCount = el('div', 'pc-count', '1 / 1');
  const srcRec = el('div', 'pc-rec', 'SRC 00:00:00:00');
  srcRight.append(srcMediaState, srcCount, srcRec);

  const sourceViewer = el("div", "pfx-reviews-viewer pfx-reviews-viewer-source");
  const videoSrc = document.createElement("video");
  videoSrc.className = "pfx-reviews-video pfx-reviews-video-src";
  sourceViewer.appendChild(videoSrc);

  // Keep source transport visible while dragging the scrubber.
  const showSrcOverlay = () => sourceViewer.classList.add('is-scrub-overlay');
  const hideSrcOverlay = () => sourceViewer.classList.remove('is-scrub-overlay');
  srcScrub.addEventListener('pointerdown', showSrcOverlay);
  window.addEventListener('pointerup', hideSrcOverlay);

  const sourceHint = el("div", "pfx-reviews-viewerHint", "Select a clip in the bin or drop files");
  sourceViewer.appendChild(sourceHint);

  // Compact source controls: keep a single bottom overlay bar, QuickTime-style.
  // Mount inside the Source viewer so it sits in the lower letterbox area, not above it.
  sourceControls.append(srcBtns, srcScrub, srcIO, srcRight);
  sourceViewer.appendChild(sourceControls);
  sourceWrap.append(sourceTitle, sourceViewer);

  // Program viewer (timeline playback)
  const programWrap = el("div", "pfx-reviews-viewerWrap");
  const programTitle = el("div", "pfx-reviews-viewerTitle", "");
  programTitle.innerHTML = `<span class="pfx-card-title-ico" aria-hidden="true">${iconSvg('timeline')}</span><span class="pfx-card-title-txt">Timeline</span>`;
  const programControls = el('div', 'pfx-reviews-proControls pfx-reviews-proControls-programUnified');
  const pgLeft = el('div', 'pc-left');
  const pgBtns = el('div', 'pc-btnGroup');
  const btnPrev = el('button', 'pc-btn', '⏮');
  const btnPlay = el('button', 'pc-btn pc-play', '▶');
  const btnNext = el('button', 'pc-btn', '⏭');
  // Marker system removed: notes are auto-created when adding V2 overlays.
  const pgFull = el('button', 'pc-pill', 'Full');

  // Icon setup for all transport/playback buttons (moved here from above to avoid TDZ on const declarations)
  try{ setIconButton(srcOpen, 'folder', 'Open media'); }catch{}
  try{ setIconButton(srcStepBack, 'prevFrame', 'Step backward'); }catch{}
  try{ setIconButton(srcPrev, 'prev', 'Previous clip'); }catch{}
  try{ setPlayPauseIconButton(srcPlay, 'Play / Pause'); }catch{}
  try{ setIconButton(srcNext, 'next', 'Next clip'); }catch{}
  try{ setIconButton(srcStepFwd, 'nextFrame', 'Step forward'); }catch{}
  try{ setIconButton(btnPrev, 'prev', 'Previous clip'); }catch{}
  try{ setPlayPauseIconButton(btnPlay, 'Play / Pause'); }catch{}
  try{ setIconButton(btnNext, 'next', 'Next clip'); }catch{}
  try{ setLabeledIcon(pgFull, 'fullscreen', 'Full', { variant:'chip', size:'sm' }); }catch{}

  // ===== QC Review Tools (inspired by VFX QC checklists) =====
  // - Diff: Difference matte between V1 and V2 overlay (quick integration check)
  // - Wipe: Split wipe compare between V1 and V2 overlay
  // - Blink: Rapid A/B toggle (V1 <-> V2 overlay)
  // - Gamma: High-contrast luma view for spotting edges/illegal values
  const qcWrap = el('div', 'pc-qc pfx-reviews-qcTop');
  const btnDiff = el('button', 'pc-pill pc-pill-sm', 'Diff');
  const btnWipe = el('button', 'pc-pill pc-pill-sm', 'Wipe');
  const wipeSlider = el('input', 'pc-wipe');
  wipeSlider.type = 'range';
  wipeSlider.min = '0';
  wipeSlider.max = '1';
  wipeSlider.step = '0.01';
  wipeSlider.value = '0.5';
  wipeSlider.title = 'Wipe position';
  wipeSlider.style.display = 'none';
  const btnBlink = el('button', 'pc-pill pc-pill-sm', 'Blink');
  const btnGamma = el('button', 'pc-pill pc-pill-sm', 'Gamma');
  // RGB isolate: cycle RGB → R → G → B (QC)
  const btnRGB = el('button', 'pc-pill pc-pill-sm', 'RGB');
  // Gain: brightness multiplier (QC), with reset
  const btnGain = el('button', 'pc-pill pc-pill-sm', 'Gain');
  const gainSlider = el('input', 'pc-wipe pc-gain');
  gainSlider.type = 'range';
  gainSlider.min = '0.50';
  gainSlider.max = '2.50';
  gainSlider.step = '0.01';
  gainSlider.value = '1.00';
  gainSlider.title = 'Gain';
  gainSlider.style.display = 'none';
  const btnGainReset = el('button', 'pc-pill pc-pill-sm', '↺');
  btnGainReset.title = 'Reset gain';
  btnGainReset.style.display = 'none';
  // UI Lock (layout freeze) – stays in the top red-box overlay.
  const btnUiLock = el('button', 'pc-pill pc-pill-sm', '🔓');
  btnUiLock.title = 'UI Lock: lock layout (splitters/panels). Fullscreen still works.';
  btnDiff.title = 'Difference matte (V1 vs V2)';
  btnWipe.title = 'Wipe compare (V1 vs V2)';
  btnBlink.title = 'Blink compare (V1 <-> V2)';
  btnGamma.title = 'High-contrast luma view';
  btnRGB.title = 'RGB isolate (cycle): RGB → R → G → B';
  btnGain.title = 'Gain (brightness)';
  qcWrap.append(btnDiff, btnWipe, wipeSlider, btnBlink, btnGamma, btnRGB, btnGain, gainSlider, btnGainReset, btnUiLock);

  const syncUiLockBtn = () => {
    const on = isUiLocked();
    btnUiLock.textContent = on ? '🔒' : '🔓';
    try { btnUiLock.classList.toggle('is-active', on); } catch {}
    try { btnUiLock.setAttribute('aria-pressed', on ? 'true' : 'false'); } catch {}
  };
  btnUiLock.addEventListener('click', () => {
    setUiLocked(!isUiLocked());
    syncUiLockBtn();
  });
  syncUiLockBtn();

  const btnKbHelp = el('button', 'pc-btn', '?');
  btnKbHelp.title = 'Keyboard shortcuts (?)';
  btnKbHelp.style.cssText = 'font-weight:700;font-size:12px;';

  pgBtns.append(btnPrev, btnPlay, btnNext);
  pgLeft.append(pgBtns, pgFull, btnKbHelp);

  const pgScrub = el('input', 'pc-scrub');
  pgScrub.type = 'range';
  pgScrub.min = '0';
  pgScrub.max = '1';
  pgScrub.step = '0.001';
  pgScrub.value = '0';

  const pgRight = el('div', 'pc-right');
  const pgCount = el('div', 'pc-count', '0 / 0');
  const pgRec = el('div', 'pc-rec', 'REC 00:00:00:00');
  pgRight.append(pgCount, pgRec);

  // Unified Timeline controls: keep transport + scrub + counters in one compact bar.
  programControls.append(pgLeft, pgScrub, pgRight);
  const viewer = el("div", "pfx-reviews-viewer pfx-reviews-viewer-program");
  const roiOverlay = el('div', 'pfx-reviews-roiOverlay');
  const roiBoxes = el('div', 'pfx-reviews-roiBoxes');
  const roiGuide = el('div', 'pfx-reviews-roiGuide', 'Draw ROI: drag on the viewer · click a box to remove · Esc to exit');
  roiOverlay.append(roiBoxes, roiGuide);

  const videoA = document.createElement("video");
  const videoB = document.createElement("video");
  const videoV2 = document.createElement("video");
  videoA.className = "pfx-reviews-video";
  videoB.className = "pfx-reviews-video";
  videoV2.className = "pfx-reviews-video pfx-reviews-video-overlay";
  viewer.appendChild(videoA);
  viewer.appendChild(videoB);
  viewer.appendChild(videoV2);

  // Wipe compare line (used by QC Wipe mode)
  const wipeLine = el('div', 'pfx-reviews-wipeLine');
  viewer.appendChild(wipeLine);
  viewer.appendChild(roiOverlay);
  
  // Mount QC tools as a top overlay inside the Program viewer
  viewer.appendChild(qcWrap);

  // SVG filter defs for RGB isolate (used by btnRGB)
  const ensureRgbFilters = () => {
    if (document.getElementById('pfxRGB_R')) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.position = 'absolute';
    svg.style.width = '0';
    svg.style.height = '0';
    svg.style.overflow = 'hidden';
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const mk = (id, values) => {
      const f = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
      f.setAttribute('id', id);
      const m = document.createElementNS('http://www.w3.org/2000/svg', 'feColorMatrix');
      m.setAttribute('type', 'matrix');
      m.setAttribute('values', values);
      f.appendChild(m);
      return f;
    };
    // Keep alpha. Output only a single channel (tinted).
    defs.appendChild(mk('pfxRGB_R', '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'));
    defs.appendChild(mk('pfxRGB_G', '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0'));
    defs.appendChild(mk('pfxRGB_B', '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'));
    svg.appendChild(defs);
    document.body.appendChild(svg);
  };
  ensureRgbFilters();

  // Keep controls visible while dragging the scrubber.
  const showOverlay = () => viewer.classList.add('is-scrub-overlay');
  const hideOverlay = () => viewer.classList.remove('is-scrub-overlay');
  pgScrub.addEventListener('pointerdown', showOverlay);
  window.addEventListener('pointerup', hideOverlay);

  const viewerHint = el("div", "pfx-reviews-viewerHint", "Drop MP4/MOV (H.264) to build a Review Timeline");
  viewer.appendChild(viewerHint);

  // QC toggles (apply as viewer CSS classes)
  const setBtnActive = (b, on) => {
    try { b.classList.toggle('is-active', !!on); } catch {}
    try { b.setAttribute('aria-pressed', on ? 'true' : 'false'); } catch {}
  };
  const toggleViewerClass = (cls, force) => {
    const cur = viewer.classList.contains(cls);
    const on = (typeof force === 'boolean') ? force : !cur;
    viewer.classList.toggle(cls, on);
    return on;
  };

  const hasAnyV2 = () => {
    try {
      const ovs = store?.state?.overlays;
      if (Array.isArray(ovs) && ovs.length) return true;
    } catch {}
    try {
      const v2 = store?.state?.v2;
      if (Array.isArray(v2) && v2.length) return true;
    } catch {}
    return false;
  };

  // Compare modes are mutually exclusive: Diff / Wipe / Blink
  let blinkTimer = 0;
  let blinkOn = false;

  const stopBlink = () => {
    if (blinkTimer) {
      try { clearInterval(blinkTimer); } catch {}
      blinkTimer = 0;
    }
    blinkOn = false;
    try { viewer.classList.remove('is-blink', 'is-blink-on'); } catch {}
    setBtnActive(btnBlink, false);
  };

  const stopWipe = () => {
    try { viewer.classList.remove('is-wipe'); } catch {}
    setBtnActive(btnWipe, false);
    try { wipeSlider.style.display = 'none'; } catch {}
  };

  const stopDiff = () => {
    try { viewer.classList.remove('is-diff'); } catch {}
    setBtnActive(btnDiff, false);
  };

  const setWipePos = (v) => {
    const n = Math.max(0, Math.min(1, Number(v) || 0.5));
    try { viewer.style.setProperty('--wipe', String(n)); } catch {}
    try { wipeLine.style.left = `${n * 100}%`; } catch {}
  };

  // Initialize wipe line position
  try { setWipePos(wipeSlider.value); } catch {}

  btnDiff.addEventListener('click', () => {
    if (!hasAnyV2()) {
      status.textContent = 'Diff needs a V2 overlay on the timeline';
      stopDiff();
      return;
    }
    stopWipe();
    stopBlink();
    const on = toggleViewerClass('is-diff');
    setBtnActive(btnDiff, on);
  });

  btnWipe.addEventListener('click', () => {
    if (!hasAnyV2()) {
      status.textContent = 'Wipe needs a V2 overlay on the timeline';
      stopWipe();
      return;
    }
    stopDiff();
    stopBlink();
    const on = toggleViewerClass('is-wipe');
    setBtnActive(btnWipe, on);
    try { wipeSlider.style.display = on ? 'block' : 'none'; } catch {}
    if (on) setWipePos(wipeSlider.value);
  });

  wipeSlider.addEventListener('input', () => {
    setWipePos(wipeSlider.value);
  });

  btnBlink.addEventListener('click', () => {
    if (!hasAnyV2()) {
      status.textContent = 'Blink needs a V2 overlay on the timeline';
      stopBlink();
      return;
    }
    stopDiff();
    stopWipe();
    if (viewer.classList.contains('is-blink')) {
      stopBlink();
      return;
    }
    stopBlink();
    try { viewer.classList.add('is-blink'); } catch {}
    setBtnActive(btnBlink, true);
    blinkOn = true;
    try { viewer.classList.toggle('is-blink-on', blinkOn); } catch {}
    blinkTimer = setInterval(() => {
      blinkOn = !blinkOn;
      try { viewer.classList.toggle('is-blink-on', blinkOn); } catch {}
    }, 250);
  });

  btnGamma.addEventListener('click', () => {
    const on = toggleViewerClass('is-gamma');
    setBtnActive(btnGamma, on);
  });

  // ===== RGB isolate + Gain (brightness) =====
  let rgbMode = 'rgb'; // rgb | r | g | b
  let gainOn = false;
  let gainVal = 1.0;

  const applyRgb = () => {
    if (rgbMode === 'rgb') {
      try { viewer.style.setProperty('--pfx-qc-rgb', ''); } catch {}
      try { btnRGB.textContent = 'RGB'; } catch {}
      setBtnActive(btnRGB, false);
      return;
    }
    const id = (rgbMode === 'r') ? 'pfxRGB_R' : ((rgbMode === 'g') ? 'pfxRGB_G' : 'pfxRGB_B');
    try { viewer.style.setProperty('--pfx-qc-rgb', `url(#${id})`); } catch {}
    try { btnRGB.textContent = rgbMode.toUpperCase(); } catch {}
    setBtnActive(btnRGB, true);
  };

  const applyGain = () => {
    const v = gainOn ? (Number(gainVal) || 1) : 1;
    try { viewer.style.setProperty('--pfx-qc-gain', String(v)); } catch {}
    setBtnActive(btnGain, gainOn);
    try { gainSlider.style.display = gainOn ? 'block' : 'none'; } catch {}
    try { btnGainReset.style.display = gainOn ? 'inline-flex' : 'none'; } catch {}
  };

  // Restore lightweight session prefs
  try {
    const s = localStorage.getItem('pfx.reviews.qc.rgb');
    if (s && ['rgb','r','g','b'].includes(s)) rgbMode = s;
  } catch {}
  try {
    const sOn = localStorage.getItem('pfx.reviews.qc.gainOn');
    gainOn = (sOn === '1');
  } catch {}
  try {
    const sV = localStorage.getItem('pfx.reviews.qc.gain');
    const n = Number(sV);
    if (isFinite(n) && n > 0) gainVal = n;
  } catch {}
  try { gainSlider.value = String(gainVal); } catch {}

  applyRgb();
  applyGain();

  btnRGB.addEventListener('click', () => {
    rgbMode = (rgbMode === 'rgb') ? 'r' : (rgbMode === 'r' ? 'g' : (rgbMode === 'g' ? 'b' : 'rgb'));
    try { localStorage.setItem('pfx.reviews.qc.rgb', rgbMode); } catch {}
    applyRgb();
  });

  btnGain.addEventListener('click', () => {
    gainOn = !gainOn;
    if (!gainOn) {
      gainVal = 1.0;
      try { gainSlider.value = '1.00'; } catch {}
    }
    try { localStorage.setItem('pfx.reviews.qc.gainOn', gainOn ? '1' : '0'); } catch {}
    try { localStorage.setItem('pfx.reviews.qc.gain', String(gainVal)); } catch {}
    applyGain();
  });

  gainSlider.addEventListener('input', () => {
    gainOn = true;
    gainVal = Number(gainSlider.value) || 1.0;
    try { localStorage.setItem('pfx.reviews.qc.gainOn', '1'); } catch {}
    try { localStorage.setItem('pfx.reviews.qc.gain', String(gainVal)); } catch {}
    applyGain();
  });

  btnGainReset.addEventListener('click', () => {
    gainOn = true;
    gainVal = 1.0;
    try { gainSlider.value = '1.00'; } catch {}
    try { localStorage.setItem('pfx.reviews.qc.gainOn', '1'); } catch {}
    try { localStorage.setItem('pfx.reviews.qc.gain', '1'); } catch {}
    applyGain();
  });

  // Remove fullscreen hint (was shown in the red box). Double-click still works.

  // Mount the compact Program controls inside the Timeline viewer so they sit in
  // the lower subtitle / red-box area instead of floating above it.
  viewer.appendChild(programControls);
  programWrap.append(programTitle, viewer);
  viewers.append(sourceWrap, splitX, programWrap);

  // Timeline
  const timeline = createTimeline({
    store,
    onScrub: async (globalTimeSec) => {
      await scrubTo(globalTimeSec);
    },
    onAddOverlay: async (clipId, t) => {
      await addOverlayWithAutoNote(clipId, t, {}, 'v2_drop');
      try { timeline.jumpToTime(t); } catch {}
    },
    onSelectV1Cut: (cut) => {
      try { store.selectV1Cut(cut); } catch {}
      try { setKeyFocus('timeline'); } catch {}
    }
  });

  const timelineWrap = el("div", "pfx-reviews-timelineWrap");
  timelineWrap.appendChild(timeline.el);

  // ===== Timeline nav (Ref-style): Zoom Mode / - / slider / + / % / Home / End =====
  const tlNav = el('div', 'pfx-reviews-tlNav');
  const btnFitTL = el('button', 'pfx-reviews-tlBtn', '');
  const btnZoomOut = el('button', 'pfx-reviews-tlBtn', '–');
  const tlZoomRange = el('input', 'pfx-reviews-tlZoomRange');
  tlZoomRange.type = 'range';
  tlZoomRange.min = '0';
  tlZoomRange.max = '1000';
  tlZoomRange.step = '1';
  tlZoomRange.value = '0';
  tlZoomRange.setAttribute('aria-label', 'Timeline zoom');
  tlZoomRange.title = 'Timeline zoom';
  const btnZoomIn = el('button', 'pfx-reviews-tlBtn', '+');
  const tlPct = el('div', 'pfx-reviews-tlPct', '100%');
  const tlMediaState = el('div', 'pfx-reviews-tlMediaState');
  const tlSep = el('div', 'pfx-reviews-tlSep');
  const btnHomeTL = el('button', 'pfx-reviews-tlBtn', '');
  const btnEndTL = el('button', 'pfx-reviews-tlBtn', '');
  tlNav.append(btnFitTL, btnZoomOut, tlZoomRange, btnZoomIn, tlPct, tlMediaState, tlSep, btnHomeTL, btnEndTL);

  const tlFitRestore = { pxPerSec: null, timeSec: null };
  let timelineZoomMode = ZOOM_MODE.CUSTOM;
  let tlZoomModeControl = null;

  const syncTimelineZoomModeMenu = () => {
    try{ tlZoomModeControl?.sync(); }catch(_e){}
  };

  // Icon-only: Fit / Home / End (red-box compact spec)
  try{
    setTimelineFitToggleButton(btnFitTL, false, { fitLabel:'Fit timeline to view', unfitLabel:'Unfit timeline' });
    setIconButton(btnHomeTL, 'home', 'Go to start');
    setIconButton(btnEndTL, 'end', 'Go to end');
  }catch(e){}

  const computeFitPx = () => {
    const dur = Math.max(0.001, Number(store.totalDurationSec()) || 0.001);
    const w = Math.max(1, Number(timeline.scrollEl?.clientWidth) || 1);
    // keep a tiny margin so the end isn't flush to the edge
    const margin = 24;
    const MIN_PX = 0.01;
    const MAX_PX = 800;
    return Math.max(MIN_PX, Math.min(MAX_PX, (w - margin) / dur));
  };

  const isTimelineZoomFit = () => {
    const fitPx = computeFitPx();
    const curPx = Number(store.state.pxPerSec) || 80;
    return Math.abs(curPx - fitPx) <= Math.max(0.05, fitPx * 0.02);
  };

  const syncTimelineFitBtn = () => {
    try{
      setTimelineFitToggleButton(btnFitTL, isTimelineZoomFit(), {
        fitLabel: 'Fit timeline to view',
        unfitLabel: 'Unfit timeline'
      });
    }catch{}
  };

  const getTimelineZoomBounds = () => {
    const min = Math.max(0.01, Math.min(800, computeFitPx()));
    const max = Math.max(min + 0.01, 800);
    return { min, max };
  };

  const timelinePxToSlider = (px) => {
    const { min, max } = getTimelineZoomBounds();
    if (!(max > min)) return 0;
    const cur = Math.max(min, Math.min(max, Number(px) || min));
    const denom = Math.log(max) - Math.log(min);
    if (!(denom > 0)) return 0;
    const t = (Math.log(cur) - Math.log(min)) / denom;
    return Math.max(0, Math.min(1000, Math.round(t * 1000)));
  };

  const timelineSliderToPx = (val) => {
    const { min, max } = getTimelineZoomBounds();
    if (!(max > min)) return min;
    const t = Math.max(0, Math.min(1, (Number(val) || 0) / 1000));
    return Math.exp(Math.log(min) + ((Math.log(max) - Math.log(min)) * t));
  };

  const syncTimelineZoomRange = () => {
    if (!tlZoomRange) return;
    const cur = Number(store.state.pxPerSec) || computeFitPx();
    tlZoomRange.value = String(timelinePxToSlider(cur));
  };

  const updateZoomPct = () => {
    const fitPx = computeFitPx();
    const pct = Math.max(1, Math.round((Number(store.state.pxPerSec) || 80) / fitPx * 100));
    tlPct.textContent = `${pct}%`;
    syncTimelineFitBtn();
    syncTimelineZoomRange();
    syncTimelineZoomModeMenu();
  };

  const zoomBy = (factor) => {
    timelineZoomMode = ZOOM_MODE.CUSTOM;
    const cur = Number(store.state.pxPerSec) || 80;
    timeline.setZoom(cur * factor);
  };

  const zoomFit = () => {
    timelineZoomMode = ZOOM_MODE.FULL;
    timeline.setZoom(computeFitPx());
  };

  const rememberTimelineView = () => {
    if (isTimelineZoomFit()) return;
    tlFitRestore.pxPerSec = Number(store.state.pxPerSec) || 80;
    tlFitRestore.timeSec = Number(store.state.timeSec) || 0;
  };

  const zoomUnfit = () => {
    timelineZoomMode = ZOOM_MODE.CUSTOM;
    const fitPx = computeFitPx();
    const savedPx = Number(tlFitRestore.pxPerSec);
    const nextPx = (Number.isFinite(savedPx) && savedPx > (fitPx * 1.02))
      ? savedPx
      : Math.min(800, Math.max(fitPx + 12, fitPx * 1.5));
    timeline.setZoom(nextPx);
    const t = Number.isFinite(Number(tlFitRestore.timeSec)) ? Number(tlFitRestore.timeSec) : (Number(store.state.timeSec) || 0);
    try { timeline.jumpToTime(t); } catch {}
  };

  const toggleZoomFit = () => {
    if (isTimelineZoomFit()) zoomUnfit();
    else {
      rememberTimelineView();
      zoomFit();
    }
    syncTimelineFitBtn();
  };

  try{
    tlZoomModeControl = createZoomModeControl({
      className: 'pfx-reviews-zoommode',
      title: 'Timeline Zoom Mode',
      getMode: () => (isTimelineZoomFit() ? ZOOM_MODE.FULL : (timelineZoomMode || ZOOM_MODE.CUSTOM)),
      onSelect: (mode) => {
        if (mode === ZOOM_MODE.FULL){
          zoomFit();
          return;
        }
        if (mode === ZOOM_MODE.DETAIL){
          try{ if (!isTimelineZoomFit()) rememberTimelineView(); }catch(_e){}
          timelineZoomMode = ZOOM_MODE.DETAIL;
          const fitPx = computeFitPx();
          timeline.setZoom(Math.min(800, Math.max(fitPx + 24, fitPx * 2.0)));
          return;
        }
        timelineZoomMode = ZOOM_MODE.CUSTOM;
        if (isTimelineZoomFit()) zoomUnfit();
        else {
          const fitPx = computeFitPx();
          const savedPx = Number(tlFitRestore.pxPerSec);
          if (Number.isFinite(savedPx) && savedPx > (fitPx * 1.02) && Math.abs(savedPx - (Number(store.state.pxPerSec) || 80)) > 0.01){
            timeline.setZoom(savedPx);
            const t = Number.isFinite(Number(tlFitRestore.timeSec)) ? Number(tlFitRestore.timeSec) : (Number(store.state.timeSec) || 0);
            try { timeline.jumpToTime(t); } catch {}
          } else {
            updateZoomPct();
          }
        }
      }
    });
    tlZoomModeControl.root.id = 'reviewsTlZoomModeCtl';
    tlZoomModeControl.root.style.marginLeft = '0';
    tlZoomModeControl.root.style.marginRight = '0';
    btnFitTL.hidden = true;
    btnFitTL.classList.add('is-zoommode-hidden');
    btnZoomOut.insertAdjacentElement('beforebegin', tlZoomModeControl.root);
    syncTimelineZoomModeMenu();
  }catch(_e){}

  // Fit ONLY the active clip/overlay range into the visible timeline viewport.
  // Used by Notes list dblclick: jump to the note time and zoom-fit that clip for fast selection.
  const computeFitPxForRange = (startSec, endSec) => {
    const s = Math.max(0, Number(startSec) || 0);
    const e = Math.max(s + 0.001, Number(endSec) || 0);
    const dur = Math.max(0.001, e - s);
    const w = Math.max(1, Number(timeline.scrollEl?.clientWidth) || 1);
    // slightly larger margin than full-fit so labels/edges are not flush
    const margin = 64;
    const MIN_PX = 0.01;
    const MAX_PX = 800;
    return Math.max(MIN_PX, Math.min(MAX_PX, (w - margin) / dur));
  };

  const zoomFitRange = (startSec, endSec) => {
    const s = Math.max(0, Number(startSec) || 0);
    const e = Math.max(s + 0.001, Number(endSec) || 0);
    timeline.setZoom(computeFitPxForRange(s, e));
    // Center the viewport on the clip range.
    const center = (s + e) / 2;
    try { timeline.jumpToTime(center); } catch {}
  };

  const goHome = async () => {
    await scrubTo(0);
    try { timeline.jumpToTime(0); } catch {}
  };

  const goEnd = async () => {
    const fps = Math.max(1, Number(store.state.fps) || 24);
    const total = Math.max(0, Number(store.totalDurationSec()) || 0);
    const t = Math.max(0, total - (1 / fps));
    await scrubTo(t);
    try { timeline.jumpToTime(t); } catch {}
  };

  btnFitTL.addEventListener('click', toggleZoomFit);
  tlPct.addEventListener('click', zoomFit);
  btnZoomOut.addEventListener('click', () => zoomBy(1 / 1.25));
  tlZoomRange.addEventListener('input', () => {
    const raw = Number(tlZoomRange.value) || 0;
    if (raw <= 0) {
      zoomFit();
      return;
    }
    timelineZoomMode = ZOOM_MODE.CUSTOM;
    timeline.setZoom(timelineSliderToPx(raw));
  });
  btnZoomIn.addEventListener('click', () => zoomBy(1.25));
  btnHomeTL.addEventListener('click', goHome);
  btnEndTL.addEventListener('click', goEnd);

  window.addEventListener('resize', () => {
    const keepFit = btnFitTL?.dataset?.fitState === 'fitted';
    if (keepFit) {
      try { zoomFit(); } catch {}
    }
    // Keep % readout accurate as the viewport changes.
    updateZoomPct();
  });

  // ===== Keyboard focus (Bin / Source / Timeline) =====
  const setKeyFocus = (mode) => {
    keyFocus = mode;
    try {
      root.classList.toggle('is-kf-bin', mode === 'bin');
      root.classList.toggle('is-kf-source', mode === 'source');
      root.classList.toggle('is-kf-timeline', mode === 'timeline');
      root.classList.toggle('is-kf-notes', mode === 'notes');
    } catch {}
  };

  // Click-to-focus
  try { refCard.addEventListener('mousedown', () => setKeyFocus('bin')); } catch {}
  try { clipsCard.addEventListener('mousedown', () => setKeyFocus('bin')); } catch {}
  try { sourceViewer.addEventListener('mousedown', () => setKeyFocus('source')); } catch {}
  try { viewer.addEventListener('mousedown', () => setKeyFocus('timeline')); } catch {}
  try { timeline.el.addEventListener('mousedown', () => setKeyFocus('timeline')); } catch {}
  try { notes.addEventListener('mousedown', () => setKeyFocus('notes')); } catch {}
  try { inspectorDock.addEventListener('mousedown', () => setKeyFocus('notes')); } catch {}

  const selectBinClipId = (clipId, { pin = true, scroll = true } = {}) => {
    if (!clipId) return;
    const c = store.state.clips.find(x => x.id === clipId);
    if (!c) return;
    loadSourceClip({ clipId: c.id, name: c.name, url: c.url, startTC: c.startTC || '00:00:00:00', canPlay: c.canPlay !== false }, 0, { pin });
    refreshClipsList();
    if (scroll) {
      const row = clipsBody.querySelector(`[data-clip-id="${clipId}"]`) || refBody.querySelector(`[data-clip-id="${clipId}"]`);
      try { row?.scrollIntoView?.({ block: 'nearest' }); } catch {}
      try { row?.focus?.(); } catch {}
    }
  };

  const stepBinSelection = (dir) => {
    if (!binVisibleIds.length) return;
    const cur = pinnedBinClipId && binVisibleIds.includes(pinnedBinClipId) ? pinnedBinClipId : binVisibleIds[0];
    let i = Math.max(0, binVisibleIds.indexOf(cur));
    i = (i + dir + binVisibleIds.length) % binVisibleIds.length;
    selectBinClipId(binVisibleIds[i], { pin: true, scroll: true });
  };

  // Notes list keyboard helpers
  const selectNoteId = async (markerId, { jump = false, scroll = true } = {}) => {
    if (!markerId) return;
    try { setKeyFocus('notes'); } catch {}
    store.selectMarker(markerId);
    refreshMarkersList();
    if (scroll) {
      try { markersBody.querySelector(`.pfx-reviews-markerRow[data-marker-id="${markerId}"]`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } catch {}
      try { markersBody.querySelector(`.pfx-reviews-markerRow[data-marker-id="${markerId}"]`)?.focus?.(); } catch {}
    }
    if (jump) {
      const sel = store.getSelectedMarker();
      if (sel) {
        await scrubTo(sel.globalTimeSec);
        try { timeline.jumpToTime(sel.globalTimeSec); } catch {}
      }
    }
  };

  const jumpToNotesBoundary = async (which) => {
    if (!notesVisibleIds.length) return;
    const targetId = (which === 'end') ? notesVisibleIds[notesVisibleIds.length - 1] : notesVisibleIds[0];
    await selectNoteId(targetId, { jump: true, scroll: true });
  };

  const stepNotesSelection = async (dir, { jump = false } = {}) => {
    if (!notesVisibleIds.length) return;
    const cur = store.state.selectedMarkerId && notesVisibleIds.includes(store.state.selectedMarkerId)
      ? store.state.selectedMarkerId
      : notesVisibleIds[0];
    let i = Math.max(0, notesVisibleIds.indexOf(cur));
    i = (i + dir + notesVisibleIds.length) % notesVisibleIds.length;
    await selectNoteId(notesVisibleIds[i], { jump, scroll: true });
  };

  // Tools dock: keep the toolbar compact (no extra status line in the red box)
  const toolsDock = el('div', 'pfx-reviews-toolsDock');
  toolsDock.append(toolbar);

  // Move timeline zoom bar into the mid-slot (green box) for a compact, pro layout.
  try { midSlot.appendChild(tlNav); } catch {}

  // Insert horizontal splitter between viewers and the lower area.
  // Notes are now a Resolve-style filmstrip docked below the timeline.
  center.append(viewers, splitY, toolsDock, timelineWrap, notes, inspectorDock);

  layout.append(bin, center);

  // ===== Bin Resizer (width) =====
  // User request: Bin can be resized horizontally.
  const BIN_W_KEY = 'pfx.reviews.binWidth';
  const BIN_W_MIGRATION_KEY = 'pfx.reviews.binWidth.visualQcFullWidth.v2';
  const BIN_W_MIN = 220;
  const BIN_W_MAX_HARD = 820;
  const BIN_W_LEGACY_DEFAULT = 300;
  const BIN_W_OLD_WIDE_MAX = 360;
  const getPreferredBinWDefault = () => {
    try {
      const ww = window.innerWidth || document.documentElement?.clientWidth || 0;
      if (ww >= 1500) return 380;
      if (ww >= 1320) return 360;
      if (ww >= 1180) return 340;
      return 320;
    } catch {
      return 390;
    }
  };
  const BIN_W_DEFAULT = getPreferredBinWDefault();
  let binW = BIN_W_DEFAULT;
  try {
    const raw = localStorage.getItem(BIN_W_KEY) || '';
    const v = parseInt(raw || String(BIN_W_DEFAULT), 10);
    const migrated = localStorage.getItem(BIN_W_MIGRATION_KEY) === '1';
    if (isFinite(v)) {
      binW = Math.min(BIN_W_MAX_HARD, Math.max(BIN_W_MIN, v));
      const shouldUpsizeLegacy = (!migrated) && (v === BIN_W_LEGACY_DEFAULT || v <= BIN_W_OLD_WIDE_MAX) && BIN_W_DEFAULT > v;
      if (shouldUpsizeLegacy) {
        binW = BIN_W_DEFAULT;
        try { localStorage.setItem(BIN_W_KEY, String(binW)); } catch {}
      }
    }
    if (!migrated) {
      try { localStorage.setItem(BIN_W_MIGRATION_KEY, '1'); } catch {}
    }
  } catch {}

  const maxBinW = () => {
    // Keep the center usable. Notes now live inside the center column as a filmstrip.
    try {
      const rect = layout.getBoundingClientRect();
      const gaps = 10; // Bin | Center seam only
      const minCenter = 420;
      const max = Math.floor(rect.width - gaps - minCenter);
      return Math.max(BIN_W_MIN, Math.min(BIN_W_MAX_HARD, max));
    } catch {
      return BIN_W_MAX_HARD;
    }
  };

  const applyBinW = () => {
    root.style.setProperty('--pfx-reviews-binW', `${binW}px`);
  };

  const setBinW = (next, { save = false } = {}) => {
    const max = maxBinW();
    binW = Math.round(Math.min(max, Math.max(BIN_W_MIN, next)));
    applyBinW();
    if (save) {
      try { localStorage.setItem(BIN_W_KEY, String(binW)); } catch {}
    }
  };

  // Apply saved width on boot
  applyBinW();

  // Two drag affordances:
  //  1) a wide invisible splitter in the layout gap
  //  2) an always-grabbable edge handle attached to the Bin itself (most reliable)
  const binSplit = el('div', 'pfx-reviews-splitter pfx-reviews-splitter-x pfx-reviews-binSplitter');
  layout.appendChild(binSplit);

  const binEdge = el('div', 'pfx-reviews-binEdgeHandle');
  bin.appendChild(binEdge);

  const isResizeAllowed = () => {
    // Allow resizing in desktop/tablet layouts; disable only on very small widths.
    try { return !window.matchMedia('(max-width: 520px)').matches; } catch { return true; }
  };

  const startBinResize = (startClientX, pointerId = null, captureEl = null) => {
    if (isUiLocked()) return;
    if (!root.classList.contains('is-bin-open')) return;
    if (!isResizeAllowed()) return;
    document.body.classList.add('pfx-is-resizing');
    const startX = startClientX;
    const startW = binW;

    const onMove = (ev) => {
      const x = (ev && typeof ev.clientX === 'number') ? ev.clientX : startX;
      const dx = x - startX;
      setBinW(startW + dx);
    };

    const onUp = () => {
      document.body.classList.remove('pfx-is-resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      try { if (captureEl && pointerId != null) captureEl.releasePointerCapture(pointerId); } catch {}
      setBinW(binW, { save: true });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });

    // Mouse fallback (some environments dispatch mouse but not pointer for chrome-extension pages)
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp, { once: true });
  };

  const onSplitDown = (e) => {
    if (!root.classList.contains('is-bin-open')) return;
    if (!isResizeAllowed()) return;
    e.preventDefault();
    e.stopPropagation();
    try { binSplit.setPointerCapture(e.pointerId); } catch {}
    startBinResize(e.clientX, e.pointerId, binSplit);
  };

  const onEdgeDown = (e) => {
    if (!root.classList.contains('is-bin-open')) return;
    if (!isResizeAllowed()) return;
    e.preventDefault();
    e.stopPropagation();
    try { binEdge.setPointerCapture(e.pointerId); } catch {}
    startBinResize(e.clientX, e.pointerId, binEdge);
  };

  // Pointer events
  binSplit.addEventListener('pointerdown', onSplitDown);
  binEdge.addEventListener('pointerdown', onEdgeDown);

  // Mouse fallback
  binSplit.addEventListener('mousedown', (e) => {
    if (!root.classList.contains('is-bin-open')) return;
    if (!isResizeAllowed()) return;
    e.preventDefault();
    startBinResize(e.clientX);
  });

  binEdge.addEventListener('mousedown', (e) => {
    if (!root.classList.contains('is-bin-open')) return;
    if (!isResizeAllowed()) return;
    e.preventDefault();
    startBinResize(e.clientX);
  });

  const resetBinW = () => {
    if (isUiLocked()) return;
    setBinW(BIN_W_DEFAULT, { save: true });
  };
  binSplit.addEventListener('dblclick', resetBinW);
  binEdge.addEventListener('dblclick', resetBinW);

// Toolbar/status are docked under the viewer controls inside `center`.
  root.append(layout);
  mount.appendChild(root);
  try{ __boot.remove(); }catch{}
  mount.appendChild(fileInput);
  mount.appendChild(relinkInput);

  // (Docked panels) – no drawer handles. Bin is a dedicated card/panel in the red box.

  // ===== Pro Resizers (viewer size + split) =====
  // NOTE: This tab is implemented on top of the Reviews feature.
  // Persist the Source/Timeline split using the same keys as Reviews autosave/project export
  // (pfx.reviews.*). Earlier builds wrote to pfx.visualqc.* which caused autosave/restore
  // to keep snapping back to the legacy default (often 0.5 / 50-50).
  const SPLIT_KEY_MAIN = 'pfx.reviews.splitRatio';
  const SPLIT_KEY_ALIAS = 'pfx.visualqc.splitRatio';
  const VIEW_H_KEY_MAIN = 'pfx.reviews.viewersHeightFrac';
  const VIEW_H_KEY_ALIAS = 'pfx.visualqc.viewersHeightFrac';
  const SPLIT_KEY = SPLIT_KEY_MAIN;
  const VIEW_H_KEY = VIEW_H_KEY_MAIN;
  let splitRatio = 0.5;
  let viewersFrac = 0.56;
  try {
    const readFloat = (k) => {
      try{ const v = parseFloat(localStorage.getItem(k) || ''); return isFinite(v) ? v : null; }catch{ return null; }
    };
    // Prefer the alias keys if present (from previous builds), otherwise use the canonical Reviews keys.
    const rawVAlias = readFloat(SPLIT_KEY_ALIAS);
    const rawVMain  = readFloat(SPLIT_KEY_MAIN);
    const rawV = (rawVAlias != null) ? rawVAlias : rawVMain;
    // Legacy default was often saved as 0.5 (50/50). Treat near-0.5 as unset and use our default.
    if (rawV != null && Math.abs(rawV - 0.5) > 0.015) {
      splitRatio = Math.min(0.8, Math.max(0.2, rawV));
    }

    const rawHAlias = readFloat(VIEW_H_KEY_ALIAS);
    const rawHMain  = readFloat(VIEW_H_KEY_MAIN);
    const rawH = (rawHAlias != null) ? rawHAlias : rawHMain;
    if (rawH != null) {
      viewersFrac = Math.min(0.85, Math.max(0.35, rawH));
    }

    // Force Source/Timeline viewer split to 50/50 (requested).
    splitRatio = 0.5;
    // Force viewer height to a stable value so the Note Inspector dock is always visible after refresh.
    viewersFrac = 0.46;
    try { localStorage.setItem(SPLIT_KEY_MAIN, String(splitRatio)); } catch {}
    try { localStorage.setItem(SPLIT_KEY_ALIAS, String(splitRatio)); } catch {}
    try { localStorage.setItem(VIEW_H_KEY_MAIN, String(viewersFrac)); } catch {}
    try { localStorage.setItem(VIEW_H_KEY_ALIAS, String(viewersFrac)); } catch {}
  } catch {}

  const applySplit = () => {
    // Mobile/stacked: let CSS handle 1-column layout.
    if (window.matchMedia('(max-width: 1100px)').matches) {
      viewers.style.removeProperty('grid-template-columns');
      return;
    }
    const s = Math.min(0.8, Math.max(0.2, splitRatio));
    const r = Math.max(0.2, 1 - s);
    // Use fr units so the split remains stable across resizes and restores.
    viewers.style.gridTemplateColumns = `minmax(0,${s}fr) 12px minmax(0,${r}fr)`;
  };

  const applyViewerHeight = () => {
    const rect = center.getBoundingClientRect();
    const minH = 160;           // viewers min — reduced so inspector has room
    const timelineLock = 92;
    const notesLock = 129;      // filmstrip (no header): pad(12)+row(6+82+6)+gap(6)+time(14)+pad(3)=129
    const inspectorMinH = 130;  // inspector minimum — infoRow(26)+tagsRow(30)+note(50)+border(4)+pad(20)

    try {
      timelineWrap.style.flex = '0 0 auto';
      timelineWrap.style.minHeight = `${timelineLock}px`;
      timelineWrap.style.maxHeight = `${timelineLock}px`;
      notes.style.flex = '0 0 auto';
      notes.style.minHeight = `${notesLock}px`;
      notes.style.maxHeight = `${notesLock}px`;
      // Inspector dock: flex to fill remaining space above inspectorMinH
      inspectorDock.style.flex = '1 1 auto';
      inspectorDock.style.minHeight = `${inspectorMinH}px`;
      inspectorDock.style.maxHeight = 'none';
    } catch {}

    let gapH = 0;
    let toolsH = 0;
    let splitYH = 0;
    try {
      const csC = window.getComputedStyle(center);
      const g = parseFloat((csC.rowGap || csC.gap || '0') + '');
      if (isFinite(g)) gapH = g;
    } catch {}
    try { toolsH = toolsDock.getBoundingClientRect().height || 0; } catch {}
    try { splitYH = splitY.getBoundingClientRect().height || 0; } catch {}

    // Reserve includes inspector minimum so viewers are capped to leave room for it
    const reserve = Math.round(timelineLock + notesLock + inspectorMinH + toolsH + splitYH + (gapH * 5) + 28);
    const maxH = Math.max(minH, rect.height - reserve);
    const want = rect.height * viewersFrac;
    const h = Math.round(Math.min(maxH, Math.max(minH, want)));
    viewers.style.flex = `0 0 ${h}px`;

    try {
      requestAnimationFrame(() => {
        try {
          const c = center.getBoundingClientRect();
          const t = timelineWrap.getBoundingClientRect();
          const n = notes.getBoundingClientRect();
          const bottom = Math.max(t.bottom, n.bottom);
          const over = bottom - c.bottom;
          if (over > 1) {
            const cur = viewers.getBoundingClientRect().height || h;
            const adj = Math.round(Math.max(minH, cur - Math.ceil(over) - 16));
            viewers.style.flex = `0 0 ${adj}px`;
          }
        } catch {}
      });
    } catch {}
  };

  const applyAllResizers = () => {
    // Clamp bin width to the current viewport before applying other resizers.
    setBinW(binW);
    applySplit();
    applyViewerHeight();
  };

  // Allow project loads / autosave restore to re-apply viewer layout immediately (prevents Source/Timeline becoming 50/50 after refresh).
  try{
    window.__PFX_REVIEWS_APPLY_LAYOUT = (layout) => {
      try{
        if (!layout || typeof layout !== 'object') return;
        if (isFinite(layout.binW)) {
          const next = Math.round(Number(layout.binW));
          let normalized = next;
          if ((next === BIN_W_LEGACY_DEFAULT || next <= BIN_W_OLD_WIDE_MAX) && BIN_W_DEFAULT > next) normalized = BIN_W_DEFAULT;
          if (isFinite(normalized)) binW = Math.min(maxBinW(), Math.max(BIN_W_MIN, normalized));
          try{ localStorage.setItem(BIN_W_KEY, String(binW)); }catch{}
          try{ localStorage.setItem(BIN_W_MIGRATION_KEY, '1'); }catch{}
        }
        // Locked layout (Visual QC): always enforce the stable split + viewer height.
        splitRatio = 0.5;
        viewersFrac = 0.46;
        try{ localStorage.setItem(SPLIT_KEY_MAIN, String(splitRatio)); }catch{}
        try{ localStorage.setItem(SPLIT_KEY_ALIAS, String(splitRatio)); }catch{}
        try{ localStorage.setItem(VIEW_H_KEY_MAIN, String(viewersFrac)); }catch{}
        try{ localStorage.setItem(VIEW_H_KEY_ALIAS, String(viewersFrac)); }catch{}
        applyAllResizers();
        // Race guard: re-force view/panels on the next tick (project load/autosave restore can run early).
        try{ setTimeout(() => {
          try{ setViewMode('dual'); }catch{}
          try{ setBinOpen(true); setNotesOpen(true); setPanelsHidden(false); }catch{}
        }, 0); }catch{}
      }catch{}
    };
  }catch{}

  // Initial apply + on resize
  applyAllResizers();
  // Some environments compute sizes a tick later; re-apply to avoid fallback 50/50 after refresh.
  try { requestAnimationFrame(applyAllResizers); } catch {}
  setTimeout(applyAllResizers, 120);
  setTimeout(applyAllResizers, 520);
  let resizeT = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(applyAllResizers, 80);
  });

	  // Keep the Visual QC lower dock locked to a stable arrangement.
  // Do not live-resize the viewer on every async thumbnail/content change.

  // Drag: horizontal split (Source vs Timeline)
  splitX.addEventListener('pointerdown', (e) => {
    if (isUiLocked()) return;
    if (window.matchMedia('(max-width: 1100px)').matches) return;
    e.preventDefault();
    splitX.setPointerCapture(e.pointerId);
    document.body.classList.add('pfx-is-resizing');
    const rect = viewers.getBoundingClientRect();
    const startX = e.clientX;
    const startRatio = splitRatio;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const next = (startRatio * rect.width + dx) / rect.width;
      splitRatio = Math.min(0.8, Math.max(0.2, next));
      applySplit();
    };

    const onUp = () => {
      document.body.classList.remove('pfx-is-resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try { localStorage.setItem(SPLIT_KEY_MAIN, String(splitRatio)); } catch {}
      try { localStorage.setItem(SPLIT_KEY_ALIAS, String(splitRatio)); } catch {}
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  });

  splitX.addEventListener('dblclick', () => {
    if (isUiLocked()) return;
    splitRatio = 0.5;
    try { localStorage.setItem(SPLIT_KEY_MAIN, String(splitRatio)); } catch {}
    try { localStorage.setItem(SPLIT_KEY_ALIAS, String(splitRatio)); } catch {}
    applySplit();
  });

  // Drag: vertical split (viewer height vs timeline)
  splitY.addEventListener('pointerdown', (e) => {
    if (isUiLocked()) return;
    e.preventDefault();
    splitY.setPointerCapture(e.pointerId);
    document.body.classList.add('pfx-is-resizing');
    const rect = center.getBoundingClientRect();
    const startY = e.clientY;
    const startH = viewers.getBoundingClientRect().height;

    const onMove = (ev) => {
      const dy = ev.clientY - startY;
      const minH = 220;
      const maxH = Math.max(minH, rect.height - 180);
      const nextH = Math.round(Math.min(maxH, Math.max(minH, startH + dy)));
      viewersFrac = Math.min(0.85, Math.max(0.35, nextH / rect.height));
      applyViewerHeight();
    };

    const onUp = () => {
      document.body.classList.remove('pfx-is-resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try { localStorage.setItem(VIEW_H_KEY, String(viewersFrac)); } catch {}
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  });

  splitY.addEventListener('dblclick', () => {
    if (isUiLocked()) return;
    viewersFrac = 0.56;
    try { localStorage.setItem(VIEW_H_KEY, String(viewersFrac)); } catch {}
    applyViewerHeight();
  });

  // ===== Player =====
  // ===== Native Messaging Host — ProRes proxy ================================
  // Connects to com.postflowx.host (pfx_host.py) which runs a local HTTP
  // server that transcodes ProRes .mov files to H.264 via ffmpeg in real-time.
  const PFX_NM_HOST = 'com.postflowx.host';
  let _nmPort = null;          // chrome.runtime.Port
  let _nmReady = false;        // host replied to ping
  let _nmForbidden = false;    // host manifest has wrong extension ID
  let _nmPending = new Map();  // requestId → { resolve, reject, timer }
  let _nmRequestId = 0;

  const _nmSend = (msg) => new Promise((resolve, reject) => {
    if (!_nmPort) { reject(new Error('Host not connected')); return; }
    const id = ++_nmRequestId;
    const timer = setTimeout(() => {
      _nmPending.delete(id);
      reject(new Error('Native host timeout'));
    }, 15000);
    _nmPending.set(id, { resolve, reject, timer });
    try { _nmPort.postMessage({ ...msg, _id: id }); } catch (e) { reject(e); }
  });

  const _nmConnect = () => {
    try {
      _nmPort = chrome.runtime.connectNative(PFX_NM_HOST);
      _nmPort.onMessage.addListener((msg) => {
        const id = msg._id;
        if (id !== undefined && _nmPending.has(id)) {
          const { resolve, reject, timer } = _nmPending.get(id);
          clearTimeout(timer);
          _nmPending.delete(id);
          if (msg.status === 'error') reject(new Error(msg.error || 'Host error'));
          else resolve(msg);
        }
      });
      _nmPort.onDisconnect.addListener(() => {
        const errMsg = chrome.runtime.lastError?.message || '';
        _nmPort = null;
        _nmReady = false;
        if (errMsg.toLowerCase().includes('forbidden')) {
          _nmForbidden = true;
        }
        // Reject all pending
        const reason = _nmForbidden ? 'host_forbidden' : 'Host disconnected';
        for (const [, { reject, timer }] of _nmPending) {
          clearTimeout(timer);
          reject(new Error(reason));
        }
        _nmPending.clear();
      });
      // Ping to confirm host is up
      _nmSend({ action: 'ping' }).then((r) => {
        _nmReady = true;
        _nmForbidden = false; // clear forbidden if a new connection succeeds
      }).catch(() => { _nmReady = false; });
    } catch (e) {
      _nmPort = null;
      _nmReady = false;
    }
  };

  // Try to connect on load; retry once if first attempt fails
  const _nmInit = () => {
    _nmConnect();
    setTimeout(() => { if (!_nmPort) _nmConnect(); }, 1500);
  };
  _nmInit();

  /**
   * Request a streaming URL for a ProRes file from the native host.
   * Streams the blob URL content via HTTP POST to the local proxy server
   * (avoids needing an OS file path, which the Web File API doesn't expose).
   * @param {string} blobUrl  - object URL created from the File (clip.url)
   * @returns {Promise<string>} streaming HTTP URL ready for video.src
   */
  const __pfxProResStreamUrl = async (blobUrl, { onProgress } = {}) => {
    if (!_nmPort) _nmConnect();
    let port;
    try {
      const chk = await _nmSend({ action: 'check_ffmpeg' });
      if (chk.status === 'missing') throw new Error('ffmpeg_missing');
      const ping = await _nmSend({ action: 'ping' });
      port = ping.port;
      if (!port) throw new Error('host_unavailable');
    } catch (e) {
      if (String(e.message).includes('ffmpeg_missing')) throw e;
      throw new Error('host_unavailable');
    }

    const sessionId = Math.random().toString(36).slice(2, 18);
    const uploadUrl = `http://127.0.0.1:${port}/upload/${sessionId}`;

    const fileResp = await fetch(blobUrl);
    if (!fileResp.ok) throw new Error('blob_fetch_failed');
    const uploadResp = await fetch(uploadUrl, {
      method: 'POST',
      body: fileResp.body,
      headers: { 'Content-Type': 'video/quicktime' },
      duplex: 'half',
    });
    if (!uploadResp.ok) throw new Error('upload_failed');

    // Poll /progress/ until transcode is done.
    // 404 = older host that blocks on upload (already done) — skip polling.
    const progressUrl = `http://127.0.0.1:${port}/progress/${sessionId}`;
    await new Promise((resolve, reject) => {
      const poll = async () => {
        try {
          const r = await fetch(progressUrl);
          if (r.status === 404) { resolve(); return; }   // old host — already done
          if (!r.ok) { reject(new Error('progress_fetch_failed')); return; }
          const data = await r.json();
          if (data.error) { reject(new Error(data.error)); return; }
          onProgress?.(Math.max(0, Math.min(100, data.pct || 0)));
          if (data.done) { resolve(); return; }
          setTimeout(poll, 400);
        } catch (e) { reject(e); }
      };
      poll();
    });

    return `http://127.0.0.1:${port}/stream/${sessionId}`;
  };

  // ===== WASM-based ProRes transcoder (zero-install fallback via @ffmpeg/ffmpeg) =====
  let _wasm = null;
  let _wasmInit = null;

  const _loadFFmpegWasm = () => {
    if (_wasmInit) return _wasmInit;
    _wasmInit = (async () => {
      if (!window.FFmpegWASM) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = chrome.runtime.getURL('assets/ffmpeg/ffmpeg.umd.js');
          s.onload = resolve;
          s.onerror = () => reject(new Error('wasm_script_load_failed'));
          document.head.appendChild(s);
        });
      }
      const { FFmpeg } = window.FFmpegWASM || {};
      if (!FFmpeg) throw new Error('wasm_api_unavailable');
      _wasm = new FFmpeg();
      _wasm.on('progress', ({ progress }) => {
        try {
          const pct = Math.round((Number(progress) || 0) * 100);
          status.textContent = `ProRes → H.264  ${pct}%…`;
        } catch {}
      });
      await _wasm.load({
        coreURL: chrome.runtime.getURL('assets/ffmpeg/ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('assets/ffmpeg/ffmpeg-core.wasm'),
      });
      return _wasm;
    })().catch((e) => { _wasmInit = null; throw e; });
    return _wasmInit;
  };

  /**
   * Transcode a ProRes (or any unsupported codec) .mov blob URL to H.264 MP4
   * entirely in-browser using ffmpeg.wasm. Returns a blob: URL for the output.
   */
  const _transcodeProResWasm = async (blobUrl) => {
    const ffmpeg = await _loadFFmpegWasm();
    const resp = await fetch(blobUrl);
    if (!resp.ok) throw new Error('blob_fetch_failed');
    const buf = await resp.arrayBuffer();
    await ffmpeg.writeFile('input.mov', new Uint8Array(buf));
    const ret = await ffmpeg.exec([
      '-i', 'input.mov',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', 'faststart',
      '-f', 'mp4', 'output.mp4',
    ]);
    if (ret !== 0) { try { await ffmpeg.deleteFile('input.mov'); } catch {} throw new Error(`ffmpeg exit ${ret}`); }
    const data = await ffmpeg.readFile('output.mp4');
    try { await ffmpeg.deleteFile('input.mov'); } catch {}
    try { await ffmpeg.deleteFile('output.mp4'); } catch {}
    // data is Uint8Array; slice to exact bytes in case it's a subview of a larger buffer
    const outBuf = data instanceof Uint8Array
      ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      : data;
    const blob = new Blob([outBuf], { type: 'video/mp4' });
    return URL.createObjectURL(blob);
  };

  // ===== ProRes Setup Modal =====
  let _proResModal = null;

  /** Build the self-contained .command installer script content. */
  const __pfxSetupScriptContent = () => {
    // pfx_host.py embedded verbatim — no backticks in the Python source so safe to template.
    const pyContent = `#!/usr/bin/env python3
"""
PostFlowX Native Messaging Host + Local HTTP Proxy Server
Transcodes Apple ProRes (and other unsupported codecs) to H.264
so Chrome can play them via a local HTTP stream.
"""
import sys, json, struct, os, threading, subprocess, uuid, time, shutil, tempfile, socketserver
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

HOST_NAME = "com.postflowx.host"
HTTP_HOST = "127.0.0.1"
HTTP_PORT = 0
CHUNK = 65536
MAX_SESSIONS = 20

_http_port = None
_sessions = {}
_sessions_lock = threading.Lock()

def _find_ffmpeg():
    """Locate ffmpeg, checking Homebrew paths that Chrome's stripped PATH omits."""
    ff = shutil.which("ffmpeg")
    if ff: return ff
    for p in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg",
              "/opt/local/bin/ffmpeg", "/usr/bin/ffmpeg"]:
        if os.path.isfile(p) and os.access(p, os.X_OK): return p
    return None

def _read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4: return None
    length = struct.unpack("<I", raw)[0]
    data = sys.stdin.buffer.read(length)
    if len(data) < length: return None
    return json.loads(data.decode("utf-8"))

def _send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()

class _ThreadedHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True

def _transcode_bg(sid, src_tmp, ff):
    """Run ffmpeg in background thread; update session progress via _sessions."""
    out_tmp = src_tmp[:-4] + ".mp4"
    total_ms = [0]

    SCALE = "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,setsar=1"

    def _run(extra_args):
        cmd = [ff,"-y","-i",src_tmp] + extra_args + \
              ["-c:a","aac","-b:a","128k","-movflags","faststart",
               "-progress","pipe:2","-nostats","-f","mp4",out_tmp]
        proc = subprocess.Popen(cmd, stderr=subprocess.PIPE,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
        for raw in proc.stderr:
            ln = raw.decode("utf-8", errors="ignore").strip()
            if not total_ms[0] and "Duration:" in ln:
                try:
                    ds = ln.split("Duration:")[1].split(",")[0].strip()
                    h,m,s = ds.split(":"); total_ms[0] = int((int(h)*3600+int(m)*60+float(s))*1000)
                except: pass
            elif ln.startswith("out_time_ms="):
                try:
                    ms = int(ln.split("=")[1])
                    pct = min(99, int(ms/max(1,total_ms[0])*100)) if total_ms[0] else 1
                    with _sessions_lock:
                        if sid in _sessions: _sessions[sid]["pct"] = pct
                except: pass
        proc.wait(); return proc.returncode

    ok = False
    try:
        rc = _run(["-threads","0","-vf",SCALE,"-c:v","h264_videotoolbox","-b:v","4M","-realtime","1","-allow_sw","1"])
        if rc != 0 or not os.path.isfile(out_tmp):
            try: os.unlink(out_tmp)
            except: pass
            rc = _run(["-threads","0","-vf",SCALE,"-c:v","libx264","-preset","ultrafast","-crf","23"])
        ok = (rc == 0 and os.path.isfile(out_tmp))
    except: pass
    try: os.unlink(src_tmp)
    except: pass
    with _sessions_lock:
        if sid in _sessions:
            _sessions[sid].update({"done": True, "pct": 100 if ok else -1,
                                   "path": out_tmp if ok else None,
                                   "error": None if ok else "transcode failed"})

class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, fmt, *args): pass

    def _send_simple(self, code, body=b"", ctype="text/plain"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin","*")
        self.end_headers()
        if body: self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        p = parsed.path
        if p == "/ping":
            self._send_simple(200, b"pong"); return
        if p.startswith("/progress/"):
            sid = p[len("/progress/"):]
            with _sessions_lock: s = dict(_sessions.get(sid) or {})
            if not s: self._send_simple(404, b"not found"); return
            resp = json.dumps({"pct": s.get("pct",0), "done": s.get("done",False),
                               "error": s.get("error")}).encode()
            self._send_simple(200, resp, "application/json"); return
        if p.startswith("/stream/"):
            sid = p[len("/stream/"):]
            deadline = time.time() + 600
            while True:
                with _sessions_lock: s = dict(_sessions.get(sid) or {})
                if not s: self._send_simple(404, b"not found"); return
                if s.get("done"): break
                if time.time() > deadline: self._send_simple(503, b"timeout"); return
                time.sleep(0.3)
            if s.get("error") or not s.get("path"):
                self._send_simple(503, (s.get("error") or "transcode failed").encode()); return
            self._serve_file(s); return
        self._send_simple(404, b"not found")

    def do_POST(self):
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/upload/"):
            self._send_simple(404, b"not found"); return
        sid = parsed.path[len("/upload/"):]
        content_length = int(self.headers.get("Content-Length", 0) or 0)
        # Receive uploaded .mov into a temp file
        src_tmp = None
        try:
            tmp = tempfile.NamedTemporaryFile(suffix=".mov", delete=False)
            remaining = content_length if content_length > 0 else None
            while True:
                to_read = CHUNK if remaining is None else min(CHUNK, remaining)
                chunk = self.rfile.read(to_read)
                if not chunk: break
                tmp.write(chunk)
                if remaining is not None:
                    remaining -= len(chunk)
                    if remaining <= 0: break
            tmp.flush(); src_tmp = tmp.name; tmp.close()
        except Exception as e:
            self._send_simple(500, str(e).encode()); return
        # Kick off async transcode — returns immediately; client polls /progress/
        ffmpeg = _find_ffmpeg()
        if not ffmpeg:
            try: os.unlink(src_tmp)
            except: pass
            self._send_simple(503, b"ffmpeg not found"); return
        with _sessions_lock:
            if len(_sessions) >= MAX_SESSIONS:
                old_id = next(iter(_sessions)); old = _sessions.pop(old_id, None)
                if old and old.get("_tmp") and old.get("path"):
                    try: os.unlink(old["path"])
                    except: pass
            _sessions[sid] = {"path": None, "_tmp": True, "done": False, "pct": 0, "error": None}
        threading.Thread(target=_transcode_bg, args=(sid, src_tmp, ffmpeg), daemon=True).start()
        resp = json.dumps({"status":"ok","sessionId":sid}).encode()
        self._send_simple(200, resp, "application/json")

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin","*")
        self.send_header("Access-Control-Allow-Methods","GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers","Content-Type, Content-Length")
        self.send_header("Content-Length","0")
        self.end_headers()

    def _serve_file(self, session):
        path = session["path"]
        if not os.path.isfile(path):
            self._send_simple(404, b"not found"); return
        size = os.path.getsize(path)
        range_hdr = self.headers.get("Range","")
        try:
            if range_hdr.startswith("bytes="):
                r = range_hdr[6:].split("-")
                start = int(r[0]) if r[0] else 0
                end = int(r[1]) if len(r) > 1 and r[1] else size - 1
                end = min(end, size - 1); length = end - start + 1
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.send_header("Content-Length", str(length))
                self.send_header("Content-Type","video/mp4")
                self.send_header("Accept-Ranges","bytes")
                self.send_header("Access-Control-Allow-Origin","*")
                self.end_headers()
                with open(path,"rb") as f:
                    f.seek(start); rem = length
                    while rem > 0:
                        chunk = f.read(min(CHUNK, rem))
                        if not chunk: break
                        self.wfile.write(chunk); rem -= len(chunk)
            else:
                self.send_response(200)
                self.send_header("Content-Length", str(size))
                self.send_header("Content-Type","video/mp4")
                self.send_header("Accept-Ranges","bytes")
                self.send_header("Access-Control-Allow-Origin","*")
                self.end_headers()
                with open(path,"rb") as f:
                    while True:
                        chunk = f.read(CHUNK)
                        if not chunk: break
                        self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError): pass

def _start_http_server():
    global _http_port
    server = _ThreadedHTTPServer((HTTP_HOST, HTTP_PORT), ProxyHandler)
    _http_port = server.server_address[1]
    server.serve_forever()

def _stop_session(sid):
    with _sessions_lock: session = _sessions.pop(sid, None)
    if session:
        if session.get("proc"):
            try: session["proc"].kill()
            except: pass
        if session.get("_tmp") and session.get("path"):
            try: os.unlink(session["path"])
            except: pass

def _handle(msg):
    # Echo _id back so the JS _nmSend promise can match the response.
    _rid = msg.get("_id")
    def _reply(obj):
        if _rid is not None: obj["_id"] = _rid
        _send_message(obj)
    action = msg.get("action","")
    if action == "ping":
        _reply({"status":"pong","port":_http_port})
    elif action == "serve":
        path = str(msg.get("path","")).strip()
        if not path or not os.path.isfile(path):
            _reply({"status":"error","error":f"File not found: {path}"}); return
        if not _find_ffmpeg():
            _reply({"status":"error","error":"ffmpeg not installed","hint":"brew install ffmpeg"}); return
        from uuid import uuid4
        sid = str(uuid4()).replace("-","")[:16]
        with _sessions_lock: _sessions[sid] = {"path": path}
        _reply({"status":"ready","url":f"http://{HTTP_HOST}:{_http_port}/stream/{sid}","sessionId":sid})
    elif action == "stop":
        _stop_session(str(msg.get("sessionId",""))); _reply({"status":"stopped"})
    elif action == "check_ffmpeg":
        p = _find_ffmpeg()
        _reply({"status":"ok" if p else "missing","path":p or "","hint":"" if p else "brew install ffmpeg"})
    else:
        _reply({"status":"error","error":f"Unknown action: {action}"})

def main():
    t = threading.Thread(target=_start_http_server, daemon=True); t.start()
    for _ in range(50):
        if _http_port is not None: break
        time.sleep(0.05)
    while True:
        try:
            msg = _read_message()
            if msg is None: break
            _handle(msg)
        except Exception as e:
            try: _send_message({"status":"error","error":str(e)})
            except: break

if __name__ == "__main__":
    main()
`;

    return `#!/bin/bash
# PostFlowX ProRes Setup — Double-click this file in Finder to run
# It will open Terminal and install everything needed to play ProRes files.

GREEN='\\033[0;32m'; YELLOW='\\033[1;33m'; RED='\\033[0;31m'; BLUE='\\033[0;34m'; NC='\\033[0m'

clear
echo ""
echo -e "\${BLUE}╔══════════════════════════════════════════╗\${NC}"
echo -e "\${BLUE}║   PostFlowX  —  ProRes Playback Setup    ║\${NC}"
echo -e "\${BLUE}╚══════════════════════════════════════════╝\${NC}"
echo ""
echo "  This will install two things:"
echo "  • ffmpeg  — open-source video converter"
echo "  • PostFlowX helper — lets the extension talk to ffmpeg"
echo ""
echo "  You may be asked for your Mac login password."
echo "  Nothing is sent to the internet except to install ffmpeg."
echo ""
read -p "  Press Enter to begin (or Ctrl-C to cancel)..."
echo ""

# ── Step 1: Homebrew ─────────────────────────────────────────────────────────
echo -e "\${BLUE}[1/3] Checking Homebrew...\${NC}"
if ! command -v brew &>/dev/null; then
  if [ -f /opt/homebrew/bin/brew ]; then
    eval "\$(/opt/homebrew/bin/brew shellenv)"
  elif [ -f /usr/local/bin/brew ]; then
    eval "\$(/usr/local/bin/brew shellenv)"
  fi
fi
if ! command -v brew &>/dev/null; then
  echo -e "\${YELLOW}  Homebrew not found — installing it now...\${NC}"
  echo "  (This may take a couple of minutes on a new Mac)"
  /bin/bash -c "\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  [ -f /opt/homebrew/bin/brew ] && eval "\$(/opt/homebrew/bin/brew shellenv)"
  [ -f /usr/local/bin/brew ]    && eval "\$(/usr/local/bin/brew shellenv)"
else
  echo -e "\${GREEN}  ✓ Homebrew is already installed\${NC}"
fi

# ── Step 2: ffmpeg ────────────────────────────────────────────────────────────
echo ""
echo -e "\${BLUE}[2/3] Checking ffmpeg...\${NC}"
if ! command -v ffmpeg &>/dev/null; then
  echo -e "\${YELLOW}  Installing ffmpeg (may take a few minutes)...\${NC}"
  brew install ffmpeg
  if ! command -v ffmpeg &>/dev/null; then
    echo -e "\${RED}  ✗ ffmpeg install failed. Try:  brew install ffmpeg\${NC}"
    read -p "  Press Enter to close..."; exit 1
  fi
else
  echo -e "\${GREEN}  ✓ ffmpeg is already installed\${NC}"
fi

# ── Step 3: PostFlowX helper ─────────────────────────────────────────────────
echo ""
echo -e "\${BLUE}[3/3] Installing PostFlowX helper...\${NC}"
INSTALL_DIR="/usr/local/lib/postflowx"

# Prefer the pre-installed production binary; fall back to installing pfx_host
COMPANION_BIN="/Library/Application Support/PostFlowX Companion/postflowx-companion"
if [ ! -x "\$COMPANION_BIN" ]; then
  sudo mkdir -p "\$INSTALL_DIR"
  sudo tee "\$INSTALL_DIR/pfx_host.py" > /dev/null << 'PYEOF'
${pyContent}
PYEOF
  sudo tee "\$INSTALL_DIR/pfx_host" > /dev/null << 'WEOF'
#!/bin/bash
exec /usr/bin/env python3 /usr/local/lib/postflowx/pfx_host.py "\$@"
WEOF
  sudo chmod +x "\$INSTALL_DIR/pfx_host.py" "\$INSTALL_DIR/pfx_host"
  COMPANION_BIN="\$INSTALL_DIR/pfx_host"
fi
echo -e "\${GREEN}  ✓ Companion binary: \$COMPANION_BIN\${NC}"

NM_DIR="\$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "\$NM_DIR"
cat > "\$NM_DIR/com.postflowx.companion.json" << MANIFEST
{
  "name": "com.postflowx.companion",
  "description": "PostFlowX Companion",
  "path": "\$COMPANION_BIN",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://${chrome.runtime.id}/"]
}
MANIFEST
# Install system-wide so every user on this Mac works without re-running setup
SYS_NM="/Library/Google/Chrome/NativeMessagingHosts"
sudo mkdir -p "\$SYS_NM" && sudo cp "\$NM_DIR/com.postflowx.companion.json" "\$SYS_NM/" && echo "System-wide manifest installed (all users)"
for BROWSER in "Google/Chrome Canary" "Chromium" "Google/Chrome Beta" "Google/Chrome Dev"; do
  ALT="\$HOME/Library/Application Support/\$BROWSER/NativeMessagingHosts"
  [ -d "\$(dirname "\$ALT")" ] && mkdir -p "\$ALT" && cp "\$NM_DIR/com.postflowx.companion.json" "\$ALT/"
  SYS_ALT="/Library/Application Support/\$BROWSER/NativeMessagingHosts"
  sudo mkdir -p "\$SYS_ALT" && sudo cp "\$NM_DIR/com.postflowx.companion.json" "\$SYS_ALT/" 2>/dev/null || true
done

echo ""
echo -e "\${GREEN}╔══════════════════════════════════════════╗\${NC}"
echo -e "\${GREEN}║   Setup complete!                        ║\${NC}"
echo -e "\${GREEN}╚══════════════════════════════════════════╝\${NC}"
echo ""
echo "  Go back to PostFlowX and click 'Check Setup'."
echo "  Then drop your ProRes file again — it will play."
echo ""
read -p "  Press Enter to close..."
`;
  };

  /** Show the friendly ProRes setup modal (non-technical 3-step flow). */
  const __pfxShowProResWarning = (fileName) => {
    // Only one modal at a time
    if (_proResModal) { try { _proResModal.remove(); } catch {} }

    const overlay = document.createElement('div');
    overlay.className = 'pfx-prores-overlay';
    overlay.innerHTML = `
      <div class="pfx-prores-modal" role="dialog" aria-modal="true" aria-label="ProRes Setup">
        <div class="pfx-prores-modal-hd">
          <span class="pfx-prores-modal-icon">&#127925;</span>
          <span class="pfx-prores-modal-title">ProRes Playback Setup</span>
          <button class="pfx-prores-modal-x" aria-label="Close">&times;</button>
        </div>
        <div class="pfx-prores-modal-sub">
          PostFlowX needs a one-time helper to play Apple ProRes files.
          <span class="pfx-prores-modal-fname">${String(fileName || '').replace(/</g,'&lt;')}</span>
        </div>
        <div class="pfx-prores-steps">

          <div class="pfx-prores-step">
            <div class="pfx-prores-step-n">1</div>
            <div class="pfx-prores-step-bd">
              <div class="pfx-prores-step-title">Download the setup script</div>
              <button class="pfx-prores-dl-btn" type="button">&#11015; Download PostFlowX_Setup.command</button>
            </div>
          </div>

          <div class="pfx-prores-step">
            <div class="pfx-prores-step-n">2</div>
            <div class="pfx-prores-step-bd">
              <div class="pfx-prores-step-title">Double-click it in your Downloads folder</div>
              <div class="pfx-prores-step-desc">
                Terminal will open and install everything automatically.<br>
                Enter your Mac password if asked &mdash; it&rsquo;s needed once to install the helper.
              </div>
            </div>
          </div>

          <div class="pfx-prores-step">
            <div class="pfx-prores-step-n">3</div>
            <div class="pfx-prores-step-bd">
              <div class="pfx-prores-step-title">Come back here and click Check Setup</div>
              <button class="pfx-prores-check-btn" type="button">&#10003; Check Setup</button>
              <div class="pfx-prores-check-status"></div>
            </div>
          </div>

        </div>
        <div class="pfx-prores-modal-ft">
          <button class="pfx-prores-close-btn" type="button">Close</button>
        </div>
      </div>`;

    // Download .command file
    overlay.querySelector('.pfx-prores-dl-btn').addEventListener('click', () => {
      try {
        const content = __pfxSetupScriptContent();
        const blob = new Blob([content], { type: 'application/octet-stream' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'PostFlowX_Setup.command';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        const btn = overlay.querySelector('.pfx-prores-dl-btn');
        btn.textContent = 'Downloaded ✓  —  find it in your Downloads folder';
        btn.classList.add('is-done');
      } catch (e) {}
    });

    // Check Setup — ping the native host
    overlay.querySelector('.pfx-prores-check-btn').addEventListener('click', async () => {
      const checkBtn = overlay.querySelector('.pfx-prores-check-btn');
      const checkStatus = overlay.querySelector('.pfx-prores-check-status');
      checkBtn.disabled = true;
      checkBtn.textContent = 'Checking…';
      checkStatus.textContent = '';
      checkStatus.className = 'pfx-prores-check-status';
      if (!_nmPort) _nmConnect();
      try {
        await new Promise(r => setTimeout(r, 600)); // give connect a moment
        const result = await _nmSend({ action: 'ping' });
        if (result && result.status === 'pong') {
          checkStatus.textContent = '✓ Setup complete! Close this and drop your file again.';
          checkStatus.classList.add('is-ok');
          checkBtn.textContent = '✓ Ready';
        } else {
          throw new Error('unexpected');
        }
      } catch (e) {
        const forbidden = _nmForbidden || String(e.message).includes('host_forbidden');
        checkStatus.textContent = forbidden
          ? 'ID mismatch — re-download the setup script (Step 1) and run it again to update the helper.'
          : 'Helper not found yet. Make sure the Terminal script finished, then try again.';
        checkStatus.classList.add('is-err');
        checkBtn.disabled = false;
        checkBtn.textContent = '✓ Check Setup';
      }
    });

    const close = () => { try { overlay.remove(); } catch {} _proResModal = null; };
    overlay.querySelector('.pfx-prores-modal-x').addEventListener('click', close);
    overlay.querySelector('.pfx-prores-close-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    try { document.body.appendChild(overlay); } catch {}
    _proResModal = overlay;
  };

  const player = new ReviewPlayer({
    videoA,
    videoB,
    store,
    onError: (msg) => {
      if (String(msg).startsWith('PRORES:')) {
        const fileName = String(msg).slice(7);
        const clip = (store.state.clips || []).find(c => c.name === fileName);
        const blobUrl = clip?.url || null;
        if (!blobUrl) { __pfxShowProResWarning(fileName); return; }

        const _applyTranscoded = async (streamUrl) => {
          if (!clip) return;
          // 1. Update URL in store (canPlay/durationSec still 0 — will be fixed by ensureClipMetadata)
          store.updateClip(clip.id, { url: streamUrl, codecHint: 'prores_proxied' });
          // 2. Probe the transcoded H.264 to get real duration and set canPlay:true.
          //    This also rebuilds segments with the correct duration (required — zero-dur segments are dropped).
          try { await player.ensureClipMetadata(clip.id); } catch {}
          // 3. Now segments have duration > 0 and canPlay:true — load into program viewer.
          try { await player.loadAtGlobalTime(0, { autoplay: false }); } catch {}
          // 4. Force source viewer to reload (clear cached clipId to bypass the sameclip skip).
          try { if (videoSrc) videoSrc.dataset.clipId = ''; } catch {}
          try { loadSourceClip({ clipId: clip.id, name: clip.name, url: streamUrl }, 0); } catch {}
          status.textContent = 'ProRes → H.264 ▶';
          setTimeout(() => { status.textContent = ''; }, 3000);
        };

        const _runWasm = () => {
          status.textContent = 'ProRes — transcoding via WASM…';
          _transcodeProResWasm(blobUrl).then(_applyTranscoded).catch((e) => {
            status.textContent = `ProRes transcode failed: ${String(e.message).slice(0, 60)}`;
            status.classList.add('is-warn');
            setTimeout(() => status.classList.remove('is-warn'), 5000);
          });
        };

        // ── Shared media runtime path (ProRes direct-read via VideoToolbox) ──
        // When the clip has a native OS path AND the companion is available,
        // use the shared runtime which routes to prores_native_backend on macOS.
        const nativePath = clip?._nativePath || clip?.file?._nativePath || null;

        const _trySharedRuntime = async () => {
          if (!nativePath) throw new Error('no_native_path');
          const openResp = await sharedMediaOpen(nativePath);
          const d = openResp?.data || {};
          if (!d.canPlay || !d.streamUrl) throw new Error('not_directly_playable');
          // File can be played directly — no transcode needed
          status.textContent = 'ProRes — direct read ▶';
          return d.streamUrl;
        };

        const _tryNativeProxy = async () => {
          // Legacy path: blob upload → proxy transcode
          _nmForbidden = false;
          if (!_nmPort) _nmConnect();
          status.textContent = 'ProRes → H.264  0%…';
          if (clip?.file instanceof File) {
            const res = await getProxyStreamUrl(clip.file, {
              onProgress: (pct) => { status.textContent = `ProRes → H.264  ${pct}%…`; },
            });
            return res?.url || '';
          }
          return __pfxProResStreamUrl(blobUrl, {
            onProgress: (pct) => { status.textContent = `ProRes → H.264  ${pct}%…`; },
          });
        };

        // Strategy: shared runtime → native proxy → WASM fallback
        _trySharedRuntime()
          .then(_applyTranscoded)
          .catch(() => _tryNativeProxy().then(_applyTranscoded).catch(() => _runWasm()));
      } else {
        status.textContent = msg;
        status.classList.add('is-warn');
        setTimeout(() => status.classList.remove('is-warn'), 1200);
      }
    }
  });

  // ===== Clean Feed (second display) =====
  // Opens a dedicated window that mirrors the Program viewer (videoA) with audio.
  // Users can drag that window to monitor #2 and press F for fullscreen.
  const cleanFeed = (() => {
    let win = null;
    let ch = null;
    let timer = null;
    let lastSent = { src: '', t: -999, playing: null, v2src: '', v2t: -999, qcKey: '' };
    let mainMuteState = null;
    let remoteOpen = false;

    // The program viewer swaps between A/B for seamless playback.
    // Always mirror the active element, not a fixed node.
    const getProgramVideo = () => {
      try { return player?.active || videoA; } catch { return videoA; }
    };

    const getOverlayVideo = () => videoV2;

    const isOpen = () => {
      try { return !!(win && !win.closed); } catch { return false; }
    };

    const syncBtn = () => {
      const on = isOpen() || remoteOpen;
      try {
        btnClean?.classList?.toggle('is-active', on);
        btnClean?.setAttribute?.('aria-pressed', on ? 'true' : 'false');
        btnClean && (btnClean.title = on ? 'Clean Feed on (click to close)' : 'Clean Feed off (click to open)');
      } catch {}
    };

    const stopPump = () => {
      if (!timer) return;
      try { clearInterval(timer); } catch {}
      timer = null;
    };

    const resetState = () => {
      stopPump();
      win = null;
      remoteOpen = false;
      lastSent = { src: '', t: -999, playing: null, v2src: '', v2t: -999, qcKey: '' };
      muteMainForCleanFeed(false);
      syncBtn();
    };

    const getLabel = () => {
      try {
        const clipId = getProgramVideo()?.dataset?.clipId;
        const clip = clipId ? store?.state?.clips?.find?.(c => c?.id === clipId) : null;
        const nm = clip?.name || clip?.filename || '';
        return nm ? `Clean Feed · ${nm}` : 'Clean Feed';
      } catch { return 'Clean Feed'; }
    };

    const getTc = () => {
      try {
        const t = (typeof pgRec !== 'undefined' && pgRec?.textContent) ? pgRec.textContent : '';
        const m = String(t || '').match(/\b\d{2}:\d{2}:\d{2}:\d{2}\b/);
        return m ? m[0] : '00:00:00:00';
      } catch { return '00:00:00:00'; }
    };

    const ensureChannel = () => {
      if (ch) return ch;
      try {
        ch = new BroadcastChannel('pfx_cleanfeed');
        ch.onmessage = (ev) => {
          const d = ev?.data;
          if (!d) return;
          if (d.type === 'ready') {
            remoteOpen = true;
            syncBtn();
            push(true);
          } else if (d.type === 'closing') {
            remoteOpen = false;
            if (!isOpen()) win = null;
            lastSent = { src: '', t: -999, playing: null, v2src: '', v2t: -999, qcKey: '' };
            muteMainForCleanFeed(false);
            syncBtn();
          }
        };
      } catch {}
      return ch;
    };

    const muteMainForCleanFeed = (on) => {
      const vids = [videoA, videoB].filter(Boolean);
      if (!vids.length) return;
      try {
        if (on) {
          // Capture and then force mute both A/B (active can swap).
          mainMuteState = vids.map(v => ({ v, muted: !!v.muted, volume: (typeof v.volume === 'number' ? v.volume : 1) }));
          for (const v of vids) {
            try { v.muted = true; v.volume = 0; } catch {}
          }
        } else {
          if (!mainMuteState) return;
          for (const s of mainMuteState) {
            try {
              s.v.muted = !!s.muted;
              s.v.volume = (typeof s.volume === 'number') ? s.volume : 1;
            } catch {}
          }
          mainMuteState = null;
        }
      } catch {}
    };

    const open = () => {
      try {
        if (isOpen()) {
          remoteOpen = true;
          try { win.focus(); } catch {}
          push(true);
          syncBtn();
          return true;
        }
      } catch {}

      const url = (chrome?.runtime?.getURL) ? chrome.runtime.getURL('clean_feed.html') : 'clean_feed.html';
      const w = 1280;
      const h = 720;
      const features = `popup=yes,width=${w},height=${h},resizable=yes,scrollbars=no`;
      try { win = window.open(url, 'pfx_cleanfeed', features); } catch { win = null; }
      ensureChannel();
      try { ch?.postMessage({ type: 'hello' }); } catch {}
      if (!win) {
        remoteOpen = false;
        muteMainForCleanFeed(false);
        syncBtn();
        return false;
      }
      remoteOpen = true;
      muteMainForCleanFeed(true);
      syncBtn();

      stopPump();
      timer = setInterval(() => {
        try {
          if (!win || win.closed) {
            resetState();
            return;
          }
        } catch {}
        push(false);
      }, 250);

      push(true);
      return true;
    };

    const close = () => {
      const wasOn = isOpen() || remoteOpen;
      stopPump();
      try { ensureChannel(); ch?.postMessage({ type: 'shutdown' }); } catch {}
      try { if (win && !win.closed) win.close(); } catch {}
      win = null;
      remoteOpen = false;
      lastSent = { src: '', t: -999, playing: null, v2src: '', v2t: -999, qcKey: '' };
      muteMainForCleanFeed(false);
      syncBtn();
      return wasOn;
    };

    const toggle = () => {
      if (isOpen() || remoteOpen) return close();
      return open();
    };

    const push = (force) => {
      try {
        const v = getProgramVideo();
        if (!v || !isOpen()) return;
        const src = v.currentSrc || v.src || '';
        const t = Number(v.currentTime) || 0;
        const playing = !v.paused;
        const rate = Number(v.playbackRate) || 1;

        const v2 = getOverlayVideo();
        const v2Visible = !!(v2 && getComputedStyle(v2).display !== 'none');
        const v2src = v2Visible ? (v2.currentSrc || v2.src || '') : '';
        const v2t = v2Visible ? (Number(v2.currentTime) || 0) : 0;

        const qc = store?.state?.qc || {};
        const qcKey = JSON.stringify({
          titleSafe: !!qc.titleSafe,
          centerCut: !!qc.centerCut,
          shotbox: !!qc.shotbox,
          showMask: !!qc.showMask,
          matte: Number(qc.matte || 0),
          maskOpacity: Number(qc.maskOpacity ?? 0.8),
          titleSafePct: Number(qc.titleSafePct || 0.9),
          centerCutPct: Number(qc.centerCutPct || 0.75),
          notesOpacity: Number(qc.notesOpacity ?? 0.7),
          notesSize: Number(qc.notesSize || 16),
          notesPos: String(qc.notesPos || 'bottom-center'),
          heat: !!qc.heat,
          heatOpacity: Number(qc.heatOpacity ?? 0.55),
          roi: Array.isArray(qc.roi) ? qc.roi : [],
          noteText: String(qc.noteText || ''),
          noteColor: String(qc.noteColor || '#ffffff'),
        });

        if (!force) {
          const drift = Math.abs(t - (lastSent.t || 0));
          const v2Drift = Math.abs(v2t - (lastSent.v2t || 0));
          if (src === lastSent.src && playing === lastSent.playing && drift < 0.08 && v2src === lastSent.v2src && v2Drift < 0.08 && qcKey === lastSent.qcKey) return;
        }

        lastSent = { src, t, playing, v2src, v2t, qcKey };
        ensureChannel();
        ch?.postMessage({
          type: 'sync',
          src,
          t,
          playing,
          rate,
          tc: getTc(),
          label: getLabel(),
          v2src,
          v2t,
          v2Show: v2Visible,
          qc,
        });
      } catch {}
    };

    return { open, close, toggle, push, isOpen, syncBtn };
  })();

  // ===== V2 Overlay (always muted) =====
  const forceMuteOverlay = (v) => {
    if (!v) return;
    // Avoid stacking listeners when called repeatedly
    if (v.__pfxMuteHooked) {
      try { v.muted = true; v.defaultMuted = true; v.volume = 0; } catch {}
      return;
    }
    v.__pfxMuteHooked = true;
    try {
      v.muted = true;
      v.defaultMuted = true;
      v.volume = 0;
      v.playsInline = true;
      v.preload = 'auto';
    } catch {}
    const reMute = () => {
      try {
        if (!v.muted) v.muted = true;
        if (v.volume != 0) v.volume = 0;
      } catch {}
    };
    try { v.addEventListener('volumechange', reMute); } catch {}
    try { v.addEventListener('loadedmetadata', reMute); } catch {}
    try { v.addEventListener('play', reMute); } catch {}
    reMute();
  };

  forceMuteOverlay(videoV2);
  videoV2.style.display = 'none';

  const _clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const _nowMs = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  // Overlay controller: stable playback with drift-correction (rate) + rare hard-seeks.
  const overlayCtl = (() => {
    let desiredUrl = '';
    let activeUrl = '';
    let desiredTime = 0;
    let desiredPlaying = false;

    let isHidden = true;
    let loaded = false;
    let lastPlayState = null;

    let taskToken = 0;     // cancels async url load/seek chains
    let seekToken = 0;     // cancels a specific seek

    let lastTickMs = 0;
    let lastHardSeekMs = 0;
    let lastRate = 1;

    let rafScrub = 0;

    const show = () => {
      if (!isHidden) return;
      isHidden = false;
      videoV2.style.display = 'block';
      forceMuteOverlay(videoV2);
      // Theme CSS sets videos to opacity:0 by default; ensure overlay becomes visible when ready.
      try { if ((videoV2.readyState || 0) >= 1 && videoV2.style.opacity === '0') videoV2.style.opacity = '1'; } catch {}
    };

    const hide = () => {
      if (isHidden) return;
      isHidden = true;
      loaded = false;
      lastPlayState = null;
      try { videoV2.pause(); } catch {}
      try { videoV2.playbackRate = 1; } catch {}
      lastRate = 1;
      // Force a reload next time we show the overlay (prevents "invisible V2" when a load was interrupted).
      activeUrl = '';
      try { videoV2.style.opacity = '0'; } catch {}
      videoV2.style.display = 'none';
    };

    const waitOnce = (ev, timeoutMs = 1500) => {
      return new Promise((resolve) => {
        let done = false;
        const on = () => {
          if (done) return;
          done = true;
          cleanup();
          resolve(true);
        };
        const cleanup = () => {
          try { videoV2.removeEventListener(ev, on); } catch {}
          try { videoV2.removeEventListener('error', on); } catch {}
        };
        try { videoV2.addEventListener(ev, on, { once: true }); } catch {}
        try { videoV2.addEventListener('error', on, { once: true }); } catch {}
        setTimeout(() => {
          if (done) return;
          done = true;
          cleanup();
          resolve(false);
        }, timeoutMs);
      });
    };

    const safePause = () => { try { videoV2.pause(); } catch {} };

    const safePlay = async () => {
      // play() returns a promise and may reject; ignore if it fails.
      try {
        if (!videoV2.paused && !videoV2.ended) return;
        const p = videoV2.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {}
    };

    const getSeekTarget = (t) => {
      let target = Math.max(0, Number(t) || 0);
      const dur = Number(videoV2.duration);
      if (Number.isFinite(dur) && dur > 0) {
        // keep within range; stay slightly under duration to avoid edge-case stalls
        target = _clamp(target, 0, Math.max(0, dur - 0.033));
      }
      return target;
    };

    const hardSeek = async (t, shouldPlay) => {
      if (!loaded) return;
      const token = ++seekToken;
      const target = getSeekTarget(t);

      // Avoid play-while-seeking stalls: pause -> seek -> resume on seeked.
      if (!videoV2.paused && !videoV2.ended) safePause();

      try { videoV2.currentTime = target; } catch {}

      // Wait until seek completes (or timeout)
      await waitOnce('seeked', 650);
      if (token !== seekToken) return;

      lastHardSeekMs = _nowMs();
      if (shouldPlay) await safePlay();
    };

    const scheduleScrubSeek = (t) => {
      if (rafScrub) cancelAnimationFrame(rafScrub);
      rafScrub = requestAnimationFrame(() => {
        rafScrub = 0;
        if (isHidden || !loaded) return;
        if (videoV2.seeking) return;
        const want = getSeekTarget(t);
        const cur = Number(videoV2.currentTime) || 0;
        const fps = Math.max(1, Number(store.state.fps) || 24);
        const frame = 1 / fps;
        const dt = Math.abs(cur - want);
        if (dt >= frame * 1.25) {
          try { videoV2.currentTime = want; } catch {}
        }
      });
    };

    const loadUrl = async (url, token) => {
      loaded = false;
      activeUrl = url;

      // Hide while switching sources to avoid flash.
      try { videoV2.style.opacity = '0'; } catch {}
      try { videoV2.src = url; } catch {}
      try { videoV2.load(); } catch {}

      const waitReady = (minState, ev, timeoutMs = 10000) => new Promise((resolve) => {
        if ((videoV2.readyState || 0) >= minState) return resolve(true);
        let done = false;
        let iv = null;
        let to = null;
        const on = () => check();
        const onErr = () => finish(false);
        const cleanup = () => {
          try { if (iv) clearInterval(iv); } catch {}
          try { if (to) clearTimeout(to); } catch {}
          try { videoV2.removeEventListener(ev, on); } catch {}
          try { videoV2.removeEventListener('error', onErr); } catch {}
        };
        const finish = (ok) => {
          if (done) return;
          done = true;
          cleanup();
          resolve(ok);
        };
        const check = () => {
          if ((videoV2.readyState || 0) >= minState) finish(true);
        };
        try { videoV2.addEventListener(ev, on, { once: true }); } catch {}
        try { videoV2.addEventListener('error', onErr, { once: true }); } catch {}
        iv = setInterval(check, 60);
        to = setTimeout(() => finish((videoV2.readyState || 0) >= minState), timeoutMs);
      });

      // 1) Wait for metadata so duration/seek range exist.
      await waitReady(1, 'loadedmetadata', 12000);
      if (token !== taskToken) return;
      loaded = (videoV2.readyState >= 1);

      // 2) Wait for first frame; if it is slow, still unhide to avoid "invisible overlay".
      await waitReady(2, 'loadeddata', 12000);
      if (token !== taskToken) return;

      if (videoV2.readyState >= 2) {
        try { videoV2.style.opacity = '1'; } catch {}
      }
    };
    const setTarget = async ({ url, time, playing }) => {
      desiredUrl = url || '';
      desiredTime = Math.max(0, Number(time) || 0);
      desiredPlaying = !!playing;

      if (!desiredUrl) {
        hide();
        return;
      }

      show();

      const token = ++taskToken;

      // URL switch (or re-show after hide)
      if (activeUrl !== desiredUrl || !loaded || (videoV2.readyState || 0) < 1) {
        await loadUrl(desiredUrl, token);
        if (token !== taskToken) return;
        // Align immediately after load (single hard seek)
        await hardSeek(desiredTime, desiredPlaying);
        if (token !== taskToken) return;
      } else {
        // Ensure it's not stuck invisible due to theme opacity.
        try { if (videoV2.style.opacity === '0') videoV2.style.opacity = '1'; } catch {}
      }

      // Play / pause state
      if (!desiredPlaying) {
        if (lastPlayState !== false) {
          lastPlayState = false;
          safePause();
          try { videoV2.playbackRate = 1; } catch {}
          lastRate = 1;
        }
        scheduleScrubSeek(desiredTime);
      } else {
        // When playing, tick() keeps it synced without frequent seeks.
        if (lastPlayState !== true) {
          lastPlayState = true;
          await safePlay();
        }
      }
    };

    const tick = async () => {
      if (isHidden || !loaded) return;
      if (!desiredPlaying) return;

      const ms = _nowMs();
      if (ms - lastTickMs < 100) return; // 10 Hz
      lastTickMs = ms;

      // If overlay got paused by the browser, try to resume.
      if (videoV2.paused && !videoV2.ended) safePlay();

      // Drift correction
      const want = getSeekTarget(desiredTime);
      const cur = Number(videoV2.currentTime) || 0;
      const err = cur - want;
      const abs = Math.abs(err);
      if (!Number.isFinite(abs)) return;

      // Small drift: keep rate = 1
      if (abs < 0.040) {
        if (lastRate !== 1) {
          try { videoV2.playbackRate = 1; } catch {}
          lastRate = 1;
        }
        return;
      }

      // Medium drift: nudge playbackRate (smooth, avoids stalls)
      if (abs < 0.25) {
        const k = 0.35; // correction gain
        const rate = _clamp(1 - err * k, 0.90, 1.10);
        if (Math.abs(rate - lastRate) > 0.01) {
          try { videoV2.playbackRate = rate; } catch {}
          lastRate = rate;
        }
        return;
      }

      // Large drift: rare hard seek (pause -> seek -> resume)
      if (!videoV2.seeking && (ms - lastHardSeekMs) > 900) {
        if (lastRate != 1) {
          try { videoV2.playbackRate = 1; } catch {}
          lastRate = 1;
        }
        await hardSeek(want, true);
      }
    };

    const dispose = () => {
      try { if (rafScrub) cancelAnimationFrame(rafScrub); } catch {}
      rafScrub = 0;
      seekToken++;
      taskToken++;
    };

    return {
      setTarget,
      tick,
      dispose,
    };
  })();

  // Drive overlay drift-correction on a simple timer.
  // RVFC can stall when the hidden standby video element is not producing compositor frames.
  let overlayTickStop = null;
  const __pfxReviewsCanTickOverlay = () => {
    try {
      if (document.hidden) return false;
      if (document.body?.dataset?.main !== 'reviews') return false;
      return !!(store.state.isPlaying || videoV2.currentSrc || videoV2.src);
    } catch {
      return false;
    }
  };
  {
    const id = setInterval(() => {
      if (!__pfxReviewsCanTickOverlay()) return;
      try { overlayCtl.tick(); } catch {}
    }, 120);
    overlayTickStop = () => clearInterval(id);
  }

  let overlayLoadedUrl = '';
  const syncOverlayToState = (reason = '') => {
    const pb = store.getPlaybackAtTime(store.state.globalTimeSec);
    const seg = pb?.layer === 'V2' ? pb.seg : null;
    // Always resolve URL from the live clip state, not the overlay's stored url field.
    // overlay.url is captured at addOverlay() time and becomes a stale blob URL after
    // page refresh — the clip gets a fresh blob URL on relink but overlay.url is never updated.
    const liveClip = seg?.clipId ? (store.state.clips || []).find(c => c.id === seg.clipId) : null;
    const url = liveClip?.url || seg?.url || '';
    const want = Math.max(0, Number(pb?.localTimeSec) || 0);

    // Only update controller's desired URL/time. Heavy work happens inside controller.
    const _p = overlayCtl.setTarget({
      url,
      time: want,
      playing: !!store.state.isPlaying,
    });
    try { if (_p && typeof _p.catch === 'function') _p.catch(() => {}); } catch {}

    // Keep this for any other code expecting the variable to exist.
    overlayLoadedUrl = url;
  };

  // Smart action: when adding a V2 overlay, auto-create a marker/note on the right instantly
  // with approve status + thumbnail for fast reviewing many shots.
  async function addOverlayWithAutoNote(clipId, t, { inSec = 0, durationSec = null } = {}, reason = 'v2_add') {
    try {
      store.addOverlay(clipId, t, { inSec, durationSec });
    } catch {}

    try { await scrubTo(t); } catch {}
    try { syncOverlayToState(reason); } catch {}

    // Create marker (note) right away
    let marker = null;
    try {
      marker = store.addMarker({ note: '' });
    } catch {}

    // Capture thumbnail from V2 (overlay) ONLY (best-effort, async).
    // We retry briefly because the hidden V2 video may need a moment to load/seek.
    try {
      if (marker) captureV2ThumbAsync(marker.id, t);
    } catch {}

    // Open Notes + focus editor
    try { setNotesOpen(true); } catch {}
    try { refreshMarkersList(); } catch {}
    try { markerNote?.focus?.(); } catch {}
  }

// ===== Actions =====
  let cinemaFallback = false;
  // IMPORTANT: Fullscreen should NOT mutate Bin/Notes open/hidden state.
  // We only hide panels visually while fullscreen is active, and restore automatically on exit.
  let fsTempHidePanels = false;
  const PANELS_KEY = 'pfx.reviews.panelsHidden';
  const BIN_KEY = 'pfx.reviews.binOpen';
  const NOTES_KEY = 'pfx.reviews.notesOpen';
  const VIEW_KEY = 'pfx.reviews.viewMode'; // dual | timeline | source

  // Default to 1-view (Timeline-only). If the user previously chose a mode, we restore it.
  let viewMode = 'timeline';
  const setViewMode = (mode) => {
    const m = (mode === 'timeline' || mode === 'source') ? mode : 'dual';
    viewMode = m;
    root.classList.toggle('is-oneview', m !== 'dual');
    root.classList.toggle('oneview-timeline', m === 'timeline');
    root.classList.toggle('oneview-source', m === 'source');
    // Button icon (action)
    try { applyViewBtn(m); } catch {}
    try { localStorage.setItem(VIEW_KEY, m); } catch {}
  };

  // Remember panel states when temporarily hiding panels
  let prevBinOpen = true;
  let prevNotesOpen = false;

  // Docked panels by default
  // Bin = visible as a dedicated card in the red box

  const setBinOpen = (_open) => {
    const v = true; // locked: always open
    root.classList.toggle('is-bin-open', v);
    try { if (btnBin && btnBin.isConnected) btnBin.textContent = 'Bin ▾'; } catch {}
    try { localStorage.setItem(BIN_KEY, '1'); } catch {}
  };

  const setNotesOpen = (_open) => {
    const v = true; // locked: always open
    root.classList.toggle('is-notes-open', v);
    try { if (btnNotes && btnNotes.isConnected) btnNotes.textContent = 'Notes ▾'; } catch {}
    try { localStorage.setItem(NOTES_KEY, '1'); } catch {}
  };

  const setPanelsHidden = (_hidden) => {
    // Panel hiding disabled in Visual QC (Bin/Notes are always visible).
    root.classList.remove('is-panels-hidden');
    try{ localStorage.setItem(PANELS_KEY, '0'); }catch{}
  };

  const _isFullscreen = () => {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  };

  const _requestFullscreen = async (el) => {
    const fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!fn) throw new Error('Fullscreen not supported');
    return fn.call(el);
  };

  const _exitFullscreen = async () => {
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (!fn) return;
    return fn.call(document);
  };

  const applyFsState = () => {
    const fsEl = (document.fullscreenElement || document.webkitFullscreenElement);
    const isFs = !!fsEl;
    const isViewerFs = fsEl === viewer;
    root.classList.toggle('is-fs', isFs);
    root.classList.toggle('is-viewer-fs', isViewerFs);

    // Visual-only hide for side panels while fullscreen/cinema is active.
    // This avoids the bug where exiting fullscreen leaves Bin/Notes permanently hidden.
    const shouldHide = isFs || cinemaFallback;
    fsTempHidePanels = shouldHide;
    root.classList.toggle('is-fs-hide-panels', shouldHide);

    if (isFs) {
      cinemaFallback = false;
      root.classList.remove('is-cinema-viewer');
      try { applyFullBtn(true); } catch {}
    } else {
      try { applyFullBtn(!!cinemaFallback); } catch {}
    }

    // NOTE: We do not call setPanelsHidden() here; fullscreen must not change user panel state.
  };

  const toggleFullscreen = async () => {
    // If real fullscreen is active, exit it.
    if (_isFullscreen()) {
      await _exitFullscreen();
      // Fullscreenchange will also call applyFsState, but we run it once for responsiveness.
      applyFsState();
      // Safety: ensure panels re-appear even if browser delays fullscreenchange.
      setTimeout(() => { try { applyFsState(); } catch (_) {} }, 120);
      return;
    }

    // If we are in CSS "cinema" fallback, exit it.
    if (cinemaFallback) {
      cinemaFallback = false;
      root.classList.remove('is-cinema-viewer');
      applyFsState();
      return;
    }

    // Prefer real fullscreen for the QuickTime viewer ONLY (true "QuickTime" full screen)
    try {
      // Hide panels visually immediately (no state changes) for a clean fullscreen.
      root.classList.add('is-fs-hide-panels');
      fsTempHidePanels = true;
      await _requestFullscreen(viewer);
      applyFsState();
    } catch (e) {
      // Fallback: full-bleed viewer overlay inside the extension window
      cinemaFallback = true;
      root.classList.add('is-cinema-viewer');
      root.classList.add('is-fs-hide-panels');
      fsTempHidePanels = true;
      applyFsState();
    }
  };

  async function scrubTo(globalTimeSec) {
    const { index, localTimeSec } = store.globalToSegment(globalTimeSec);
    const seg = store.state.segments[index];
    if (!seg) {
      store.setTime(0, 'time');
      return;
    }

    // If the same source file is already loaded, just seek.
    const activeSrc = String(player.getActiveSrc?.() || '');
    const same = !!(activeSrc && seg.url && (activeSrc === seg.url || activeSrc.includes(seg.url) || String(seg.url).includes(activeSrc)));
    const wasPlaying = store.state.isPlaying;

    if (same) {
      player.seekActive(localTimeSec, globalTimeSec, { indexOverride: index, segOverride: seg });
      if (wasPlaying) player.play();
      return;
    }

    await player.loadAtGlobalTime(globalTimeSec, { autoplay: wasPlaying });
  }

  // ===== V1 Auto Cut Detect (shot split) =====
  // Splits V1 timeline clips into shot-sized segments so Prev/Next works like shot navigation.
  let __pfxV1CutsBusy = false;
  let __pfxV1CutsAbort = false;

  const __pfxHasAnyV1Cuts = () => {
    try{
      const m = store.state?.v1CutsByClip;
      if (!m || typeof m !== 'object') return false;
      return Object.values(m).some(arr => Array.isArray(arr) && arr.length);
    }catch{ return false; }
  };

  const __pfxGetV1CutsAggregate = () => {
    try {
      const order = Array.isArray(store.state?.timelineClipIds) ? store.state.timelineClipIds : [];
      const ids = Array.from(new Set(order.map((x) => String(x || '')).filter(Boolean)));
      const cutsMap = (store.state?.v1CutsByClip && typeof store.state.v1CutsByClip === 'object') ? store.state.v1CutsByClip : {};
      const statsMap = (store.state?.v1CutStatsByClip && typeof store.state.v1CutStatsByClip === 'object') ? store.state.v1CutStatsByClip : {};
      let segments = 0;
      let uncertain = 0;
      let tinyMerged = 0;
      let sampledFrames = 0;
      let clipsWithCuts = 0;
      const sourceIds = ids.length ? ids : Object.keys(cutsMap);
      for (const clipId of sourceIds) {
        const cuts = Array.isArray(cutsMap?.[clipId]) ? cutsMap[clipId] : [];
        const stats = statsMap?.[clipId] || null;
        if (cuts.length) clipsWithCuts++;
        segments += Math.max(0, Number(stats?.segments) || (cuts.length ? cuts.length + 1 : 0));
        uncertain += Math.max(0, Number(stats?.uncertain) || cuts.filter((cut) => cut?.uncertain).length);
        tinyMerged += Math.max(0, Number(stats?.tinyMerged) || 0);
        sampledFrames += Math.max(0, Number(stats?.sampledFrames) || 0);
      }
      return { segments, uncertain, tinyMerged, sampledFrames, clipsWithCuts };
    } catch {
      return { segments: 0, uncertain: 0, tinyMerged: 0, sampledFrames: 0, clipsWithCuts: 0 };
    }
  };

  const __pfxSyncAutoCutControlsFromState = () => {
    try {
      const settings = store.state?.autoCutSettings || {};
      if (autoCutMode && String(autoCutMode.value || '') !== String(settings.mode || 'shot')) autoCutMode.value = String(settings.mode || 'shot');
      if (autoCutPreset && String(autoCutPreset.value || '') !== String(settings.preset || 'standard')) autoCutPreset.value = String(settings.preset || 'standard');
      if (autoCutIgnore) autoCutIgnore.value = detectAutoCutIgnorePreset(settings.ignoreRegions);
      if (roiSnapSelect && String(roiSnapSelect.value || '0') !== String(Number(settings.roiSnapStep) || 0)) roiSnapSelect.value = String(Number(settings.roiSnapStep) || 0);
    } catch {}
  };

  const __pfxRenderV1CutSummary = () => {
    try {
      const summary = __pfxGetV1CutsAggregate();
      if (!summary.segments) {
        refAutoCutSummary.textContent = '—';
        refAutoCutSummary.title = 'Cut Detect: —';
        return;
      }
      const sens = clampSceneCutSensitivity(sceneCutSensitivity?.value || readSceneCutSensitivity());
      const parts = [`${summary.segments} seg`];
      if (summary.uncertain) parts.push(`?${summary.uncertain}`);
      parts.push(`S${sens}`);
      if (String(store.state?.v1CutViewMode || 'all') === 'uncertain') parts.push('only ?');
      const summaryText = parts.join(' · ');
      refAutoCutSummary.textContent = summaryText;
      refAutoCutSummary.title = summaryText;
    } catch {
      try {
        refAutoCutSummary.textContent = '—';
        refAutoCutSummary.title = 'Cut Detect: —';
      } catch {}
    }
  };


  const __pfxOpenCustomRoiEditor = () => {
    try {
      const current = normalizeIgnorePresetRegions(store.state?.autoCutSettings?.ignoreRegions || []);
      const seed = JSON.stringify(current.length ? current : [{ x: 0.28, y: 0.08, w: 0.44, h: 0.12, enabled: true }], null, 2);
      const raw = window.prompt('Custom ROI JSON for Auto Cut ignore regions. Use normalized values 0..1. Example: [{"x":0.28,"y":0.08,"w":0.44,"h":0.12,"enabled":true}]', seed);
      if (raw == null) return;
      const parsed = JSON.parse(raw);
      const nextRegions = normalizeIgnorePresetRegions(parsed).map((roi) => __pfxSnapViewerRoi(roi));
      __pfxCommitViewerRoiRegions(nextRegions, `Custom ROI saved ({n} region${nextRegions.length === 1 ? '' : 's'}).`);
      try { autoCutIgnore.value = detectAutoCutIgnorePreset(nextRegions); } catch {}
      __pfxSyncV1CutsButtons();
    } catch (e) {
      try { status.textContent = `ROI parse failed: ${String(e?.message || e)}`; } catch {}
    }
  };


  let __pfxRoiDrawMode = false;
  let __pfxRoiDraft = null;
  let __pfxRoiPointerId = null;
  let __pfxRoiEditSession = null;
  let __pfxSelectedRoiIndex = -1;

  const __pfxClamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  const __pfxNormalizeViewerRoi = (rect = {}) => {
    const x1 = __pfxClamp01(Math.min(Number(rect?.x) || 0, (Number(rect?.x) || 0) + (Number(rect?.w) || 0)));
    const y1 = __pfxClamp01(Math.min(Number(rect?.y) || 0, (Number(rect?.y) || 0) + (Number(rect?.h) || 0)));
    const x2 = __pfxClamp01(Math.max(Number(rect?.x) || 0, (Number(rect?.x) || 0) + (Number(rect?.w) || 0)));
    const y2 = __pfxClamp01(Math.max(Number(rect?.y) || 0, (Number(rect?.y) || 0) + (Number(rect?.h) || 0)));
    return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1), enabled: rect?.enabled !== false };
  };

  const __pfxNormalizeRoiSnapStep = (value) => {
    const raw = Number(value);
    const allowed = [0, 0.005, 0.01, 0.02, 0.05, 0.1];
    if (!Number.isFinite(raw)) return 0;
    let best = allowed[0];
    let bestDiff = Math.abs(raw - best);
    for (const step of allowed) {
      const diff = Math.abs(raw - step);
      if (diff < bestDiff) { best = step; bestDiff = diff; }
    }
    return best;
  };

  const __pfxGetRoiSnapStep = () => __pfxNormalizeRoiSnapStep(store.state?.autoCutSettings?.roiSnapStep);
  const __pfxQuantizeRoiValue = (value, step = __pfxGetRoiSnapStep()) => {
    const v = __pfxClamp01(value);
    const s = Number(step) || 0;
    if (!(s > 0)) return v;
    return __pfxClamp01(Math.round(v / s) * s);
  };
  const __pfxSnapViewerRoi = (rect = {}, step = __pfxGetRoiSnapStep()) => {
    const base = __pfxNormalizeViewerRoi(rect);
    const s = Number(step) || 0;
    if (!(s > 0)) return base;
    const x = __pfxQuantizeRoiValue(base.x, s);
    const y = __pfxQuantizeRoiValue(base.y, s);
    const w = Math.max(s, __pfxQuantizeRoiValue(base.w, s));
    const h = Math.max(s, __pfxQuantizeRoiValue(base.h, s));
    const next = __pfxNormalizeViewerRoi({ x, y, w, h, enabled: base?.enabled !== false });
    next.x = __pfxQuantizeRoiValue(Math.min(next.x, 1 - next.w), s);
    next.y = __pfxQuantizeRoiValue(Math.min(next.y, 1 - next.h), s);
    next.w = Math.max(s, __pfxQuantizeRoiValue(Math.min(next.w, 1 - next.x), s));
    next.h = Math.max(s, __pfxQuantizeRoiValue(Math.min(next.h, 1 - next.y), s));
    return __pfxNormalizeViewerRoi(next);
  };
  const __pfxRoiValueToPct = (value) => Math.round((Number(value) || 0) * 1000) / 10;

  const __pfxGetCurrentRoiRegions = () => normalizeIgnorePresetRegions(store.state?.autoCutSettings?.ignoreRegions || []);

  const __pfxGetSelectedRoiIndex = () => {
    if (__pfxRoiEditSession && Number.isFinite(Number(__pfxRoiEditSession.index))) return Number(__pfxRoiEditSession.index);
    return Number.isFinite(Number(__pfxSelectedRoiIndex)) ? Number(__pfxSelectedRoiIndex) : -1;
  };

  const __pfxSelectViewerRoi = (index = -1) => {
    const regions = __pfxGetCurrentRoiRegions();
    const idx = Number(index);
    __pfxSelectedRoiIndex = (idx >= 0 && idx < regions.length) ? idx : -1;
    try { __pfxRenderRoiDock(); } catch {}
    __pfxRenderViewerRoiOverlay();
  };

  const __pfxSelectAdjacentViewerRoi = (delta = 0) => {
    const regions = __pfxGetCurrentRoiRegions();
    if (!regions.length) return false;
    const cur = __pfxGetSelectedRoiIndex();
    const next = (cur >= 0 ? cur : 0) + Number(delta || 0);
    const idx = Math.max(0, Math.min(regions.length - 1, next));
    __pfxSelectViewerRoi(idx);
    return true;
  };

  const __pfxApplyRoiInspectorValues = () => {
    const idx = __pfxGetSelectedRoiIndex();
    const cur = __pfxGetCurrentRoiRegions();
    if (idx < 0 || idx >= cur.length) return false;
    const src = cur[idx] || {};
    const next = __pfxSnapViewerRoi({
      x: ((Number(__pfxRoiFieldMap.x?.value) || 0) / 100),
      y: ((Number(__pfxRoiFieldMap.y?.value) || 0) / 100),
      w: Math.max(0.003, (Number(__pfxRoiFieldMap.w?.value) || 0) / 100),
      h: Math.max(0.003, (Number(__pfxRoiFieldMap.h?.value) || 0) / 100),
      enabled: src?.enabled !== false,
    });
    cur[idx] = next;
    __pfxSelectedRoiIndex = idx;
    __pfxCommitViewerRoiRegions(cur, `Custom ROI updated ({n} region${cur.length === 1 ? '' : 's'}).`);
    __pfxRenderViewerRoiOverlay();
    return true;
  };

  const __pfxDuplicateSelectedViewerRoi = () => {
    const idx = __pfxGetSelectedRoiIndex();
    const cur = __pfxGetCurrentRoiRegions();
    if (idx < 0 || idx >= cur.length) return false;
    const roi = cur[idx] || {};
    const step = __pfxGetRoiSnapStep() || 0.01;
    const dup = __pfxSnapViewerRoi({
      x: Math.min(1, (Number(roi.x) || 0) + step),
      y: Math.min(1, (Number(roi.y) || 0) + step),
      w: Number(roi.w) || 0,
      h: Number(roi.h) || 0,
      enabled: roi?.enabled !== false,
    });
    cur.splice(idx + 1, 0, dup);
    __pfxSelectedRoiIndex = idx + 1;
    __pfxCommitViewerRoiRegions(cur, `Custom ROI updated ({n} region${cur.length === 1 ? '' : 's'}).`);
    __pfxRenderViewerRoiOverlay();
    return true;
  };

  const __pfxSnapSelectedViewerRoiNow = () => {
    const idx = __pfxGetSelectedRoiIndex();
    const cur = __pfxGetCurrentRoiRegions();
    if (idx < 0 || idx >= cur.length) return false;
    cur[idx] = __pfxSnapViewerRoi(cur[idx] || {});
    __pfxSelectedRoiIndex = idx;
    __pfxCommitViewerRoiRegions(cur, `Custom ROI updated ({n} region${cur.length === 1 ? '' : 's'}).`);
    __pfxRenderViewerRoiOverlay();
    return true;
  };

  const __pfxRenderRoiDock = () => {
    try {
      const regions = __pfxGetCurrentRoiRegions();
      let idx = __pfxGetSelectedRoiIndex();
      if (idx < 0 || idx >= regions.length) idx = regions.length ? 0 : -1;
      __pfxSelectedRoiIndex = idx;
      const selected = (idx >= 0 && idx < regions.length)
        ? ((__pfxRoiEditSession && Number(__pfxRoiEditSession.index) === idx && __pfxRoiEditSession.previewRect)
            ? __pfxSnapViewerRoi(__pfxRoiEditSession.previewRect)
            : regions[idx])
        : null;
      const snapStep = __pfxGetRoiSnapStep();
      const snapLabel = !(snapStep > 0) ? 'snap off' : `snap ${__pfxRoiValueToPct(snapStep)}%`;
      refRoiInspector.textContent = selected
        ? `ROI ${idx + 1}/${regions.length} · x ${__pfxRoiValueToPct(selected.x)} · y ${__pfxRoiValueToPct(selected.y)} · w ${__pfxRoiValueToPct(selected.w)} · h ${__pfxRoiValueToPct(selected.h)} · ${snapLabel}`
        : `ROI: none · ${snapLabel}`;
      refRoiPills.innerHTML = '';
      regions.forEach((roi, regionIdx) => {
        const pill = el('button', 'pfx-reviews-roiPill', `ROI ${regionIdx + 1}`);
        pill.type = 'button';
        pill.title = `ROI ${regionIdx + 1} · x ${__pfxRoiValueToPct(roi.x)} y ${__pfxRoiValueToPct(roi.y)} w ${__pfxRoiValueToPct(roi.w)} h ${__pfxRoiValueToPct(roi.h)}`;
        if (regionIdx === idx) pill.classList.add('is-active');
        pill.addEventListener('click', () => { __pfxSelectViewerRoi(regionIdx); });
        refRoiPills.appendChild(pill);
      });
      Object.entries(__pfxRoiFieldMap).forEach(([key, input]) => {
        const value = selected ? __pfxRoiValueToPct(selected[key]) : '';
        input.value = selected ? String(value) : '';
        input.disabled = !selected;
      });
      try { roiSnapSelect.value = String(snapStep || 0); } catch {}
      refRoiDock.classList.toggle('is-empty', !regions.length);
      btnV1RoiPrev.disabled = regions.length < 2;
      btnV1RoiNext.disabled = regions.length < 2;
      btnV1RoiDuplicate.disabled = !selected;
      btnV1RoiSnapNow.disabled = !selected || !(snapStep > 0);
      btnV1RoiApply.disabled = !selected;
    } catch {}
  };

  const __pfxNudgeViewerRoi = (dx = 0, dy = 0, dw = 0, dh = 0) => {
    const idx = __pfxGetSelectedRoiIndex();
    const cur = __pfxGetCurrentRoiRegions();
    if (idx < 0 || idx >= cur.length) return false;
    const roi = cur[idx] || {};
    let next = __pfxSnapViewerRoi({
      x: (Number(roi.x) || 0) + Number(dx || 0),
      y: (Number(roi.y) || 0) + Number(dy || 0),
      w: Math.max(0.003, (Number(roi.w) || 0) + Number(dw || 0)),
      h: Math.max(0.003, (Number(roi.h) || 0) + Number(dh || 0)),
      enabled: roi?.enabled !== false,
    });
    next.x = __pfxClamp01(Math.min(next.x, 1 - next.w));
    next.y = __pfxClamp01(Math.min(next.y, 1 - next.h));
    cur[idx] = next;
    __pfxSelectedRoiIndex = idx;
    __pfxCommitViewerRoiRegions(cur, `Custom ROI updated ({n} region${cur.length === 1 ? '' : 's'}).`);
    __pfxRenderViewerRoiOverlay();
    return true;
  };

  const __pfxCopyViewerRoi = async () => {
    const regions = __pfxGetCurrentRoiRegions();
    const text = JSON.stringify(regions, null, 2);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        try { status.textContent = `Copied ${regions.length} ROI region${regions.length === 1 ? '' : 's'}.`; } catch {}
        return true;
      }
    } catch {}
    try { window.prompt('Copy ROI JSON', text); } catch {}
    return true;
  };

  const __pfxPasteViewerRoi = async () => {
    let raw = '';
    try {
      if (navigator.clipboard?.readText) raw = await navigator.clipboard.readText();
    } catch {}
    const seed = String(raw || JSON.stringify(__pfxGetCurrentRoiRegions(), null, 2) || '[]');
    const input = window.prompt('Paste ROI JSON (normalized values 0..1).', seed);
    if (input == null) return false;
    let parsed;
    try { parsed = JSON.parse(input); } catch (e) {
      try { status.textContent = `ROI parse failed: ${String(e?.message || e)}`; } catch {}
      return false;
    }
    const next = normalizeIgnorePresetRegions(parsed).map((roi) => __pfxSnapViewerRoi(roi));
    __pfxSelectedRoiIndex = next.length ? Math.min(Math.max(0, __pfxGetSelectedRoiIndex()), next.length - 1) : -1;
    __pfxCommitViewerRoiRegions(next, `Custom ROI updated ({n} region${next.length === 1 ? '' : 's'}).`);
    __pfxRenderViewerRoiOverlay();
    try { status.textContent = `Pasted ${next.length} ROI region${next.length === 1 ? '' : 's'}.`; } catch {}
    return true;
  };

  const __pfxCommitViewerRoiRegions = (regions = [], msg = 'Custom ROI updated.') => {
    const nextRegions = normalizeIgnorePresetRegions(regions)
      .map((roi) => __pfxSnapViewerRoi(roi))
      .filter((r) => Number(r?.w) > 0.003 && Number(r?.h) > 0.003);
    try { store.setAutoCutSettings({ ignoreRegions: nextRegions }); } catch {}
    try { autoCutIgnore.value = detectAutoCutIgnorePreset(nextRegions); } catch {}
    try { __pfxScheduleAutosave({ force: true }); } catch {}
    try { status.textContent = msg.replace('{n}', String(nextRegions.length)); } catch {}
    try { __pfxSyncV1CutsButtons(); } catch {}
    try { __pfxRenderRoiDock(); } catch {}
  };

  const __pfxCommitSingleViewerRoi = (index, rect, msg = 'Custom ROI updated.') => {
    const cur = __pfxGetCurrentRoiRegions();
    if (index < 0 || index >= cur.length) return;
    cur[index] = __pfxSnapViewerRoi(rect || cur[index] || {});
    __pfxCommitViewerRoiRegions(cur, msg);
  };

  const __pfxRenderViewerRoiOverlay = () => {
    try {
      const regions = __pfxGetCurrentRoiRegions();
      roiBoxes.innerHTML = '';
      regions.forEach((region, idx) => {
        const box = el('button', 'pfx-reviews-roiBox');
        const boxRect = (__pfxRoiEditSession && Number(__pfxRoiEditSession.index) === idx && __pfxRoiEditSession.previewRect)
          ? __pfxSnapViewerRoi(__pfxRoiEditSession.previewRect)
          : region;
        box.type = 'button';
        box.style.left = `${(__pfxClamp01(boxRect.x) * 100).toFixed(4)}%`;
        box.style.top = `${(__pfxClamp01(boxRect.y) * 100).toFixed(4)}%`;
        box.style.width = `${(__pfxClamp01(boxRect.w) * 100).toFixed(4)}%`;
        box.style.height = `${(__pfxClamp01(boxRect.h) * 100).toFixed(4)}%`;
        box.title = `ROI ${idx + 1} · drag to move · handles resize · double-click remove`;
        box.dataset.index = String(idx);
        if ((__pfxRoiEditSession && Number(__pfxRoiEditSession.index) === idx) || __pfxGetSelectedRoiIndex() === idx) box.classList.add('is-selected');
        const label = el('span', 'pfx-reviews-roiBoxLabel', `ROI ${idx + 1}`);
        box.appendChild(label);
        ['nw','n','ne','e','se','s','sw','w'].forEach((dir) => {
          const handle = el('span', `pfx-reviews-roiHandle is-${dir}`);
          handle.dataset.dir = dir;
          box.appendChild(handle);
        });
        box.addEventListener('dblclick', (ev) => {
          if (!__pfxRoiDrawMode) return;
          ev.preventDefault();
          ev.stopPropagation();
          const cur = __pfxGetCurrentRoiRegions();
          cur.splice(idx, 1);
          __pfxRoiEditSession = null;
          __pfxCommitViewerRoiRegions(cur, `Custom ROI updated ({n} region${cur.length === 1 ? '' : 's'}).`);
          __pfxRenderViewerRoiOverlay();
        });
        box.addEventListener('pointerdown', (ev) => {
          __pfxSelectedRoiIndex = idx;
          if (!__pfxRoiDrawMode) { __pfxRenderViewerRoiOverlay(); return; }
          if (ev.button != null && ev.button !== 0) return;
          ev.preventDefault();
          ev.stopPropagation();
          const handleEl = ev.target && ev.target.closest ? ev.target.closest('.pfx-reviews-roiHandle') : null;
          const dir = handleEl ? String(handleEl.dataset.dir || '') : '';
          const current = __pfxGetCurrentRoiRegions()[idx] || region;
          __pfxRoiEditSession = {
            index: idx,
            pointerId: ev.pointerId,
            mode: dir ? 'resize' : 'move',
            handle: dir || '',
            startPoint: __pfxViewerPointToNorm(ev.clientX, ev.clientY),
            startRect: { x: Number(current.x) || 0, y: Number(current.y) || 0, w: Number(current.w) || 0, h: Number(current.h) || 0, enabled: current?.enabled !== false },
          };
          try { roiOverlay.setPointerCapture(ev.pointerId); } catch {}
          __pfxRenderViewerRoiOverlay();
        });
        roiBoxes.appendChild(box);
      });
      if (__pfxRoiDraft && Number(__pfxRoiDraft.w) > 0 && Number(__pfxRoiDraft.h) > 0) {
        const draft = el('div', 'pfx-reviews-roiBox is-draft');
        draft.style.left = `${(__pfxClamp01(__pfxRoiDraft.x) * 100).toFixed(4)}%`;
        draft.style.top = `${(__pfxClamp01(__pfxRoiDraft.y) * 100).toFixed(4)}%`;
        draft.style.width = `${(__pfxClamp01(__pfxRoiDraft.w) * 100).toFixed(4)}%`;
        draft.style.height = `${(__pfxClamp01(__pfxRoiDraft.h) * 100).toFixed(4)}%`;
        roiBoxes.appendChild(draft);
      }
      viewer.classList.toggle('is-roi-edit', !!__pfxRoiDrawMode);
      roiOverlay.classList.toggle('is-active', !!__pfxRoiDrawMode || regions.length > 0);
      const selectedIdx = __pfxGetSelectedRoiIndex();
      const selectedRoi = (selectedIdx >= 0 && selectedIdx < regions.length) ? regions[selectedIdx] : null;
      const selectedInfo = selectedRoi
        ? ` · ROI ${selectedIdx + 1} x${__pfxRoiValueToPct(selectedRoi.x)} y${__pfxRoiValueToPct(selectedRoi.y)} w${__pfxRoiValueToPct(selectedRoi.w)} h${__pfxRoiValueToPct(selectedRoi.h)}`
        : '';
      const snapInfo = (__pfxGetRoiSnapStep() > 0) ? ` · snap ${__pfxRoiValueToPct(__pfxGetRoiSnapStep())}%` : '';
      roiGuide.textContent = __pfxRoiDrawMode
        ? `Draw ROI: drag to add · drag box to move · drag handles to resize · arrows nudge · Alt+arrows resize · Del remove · Esc exit${selectedInfo}${snapInfo}`
        : (regions.length ? `Custom ROI active · ${regions.length} region${regions.length === 1 ? '' : 's'}${selectedInfo}${snapInfo}` : '');
      roiGuide.style.display = (__pfxRoiDrawMode || regions.length) ? 'block' : 'none';
      try { btnV1DrawROI.classList.toggle('is-active', !!__pfxRoiDrawMode); } catch {}
      try { btnV1ClearROI.disabled = !regions.length; } catch {}
      try { btnV1EditROI.classList.toggle('is-active', detectAutoCutIgnorePreset(regions) === 'custom'); } catch {}
      try { __pfxRenderRoiDock(); } catch {}
    } catch {}
  };

  const __pfxSetRoiDrawMode = (on) => {
    __pfxRoiDrawMode = !!on;
    if (!__pfxRoiDrawMode) {
      __pfxRoiDraft = null;
      __pfxRoiPointerId = null;
      __pfxRoiEditSession = null;
    }
    __pfxRenderViewerRoiOverlay();
  };

  const __pfxViewerPointToNorm = (clientX, clientY) => {
    const rect = viewer.getBoundingClientRect();
    const w = Math.max(1, rect.width || 1);
    const h = Math.max(1, rect.height || 1);
    return {
      x: __pfxClamp01((Number(clientX) - rect.left) / w),
      y: __pfxClamp01((Number(clientY) - rect.top) / h),
    };
  };

  const __pfxApplyViewerRoiEdit = (clientX, clientY) => {
    if (!__pfxRoiEditSession) return;
    const pt = __pfxViewerPointToNorm(clientX, clientY);
    const start = __pfxRoiEditSession.startRect || { x: 0, y: 0, w: 0, h: 0 };
    const anchor = {
      left: Number(start.x) || 0,
      top: Number(start.y) || 0,
      right: (Number(start.x) || 0) + (Number(start.w) || 0),
      bottom: (Number(start.y) || 0) + (Number(start.h) || 0),
    };
    const dx = (Number(pt.x) || 0) - (Number(__pfxRoiEditSession.startPoint?.x) || 0);
    const dy = (Number(pt.y) || 0) - (Number(__pfxRoiEditSession.startPoint?.y) || 0);
    let next = null;
    if (__pfxRoiEditSession.mode === 'move') {
      next = __pfxSnapViewerRoi({
        x: anchor.left + dx,
        y: anchor.top + dy,
        w: Number(start.w) || 0,
        h: Number(start.h) || 0,
        enabled: start?.enabled !== false,
      });
      next.x = __pfxClamp01(Math.min(next.x, 1 - next.w));
      next.y = __pfxClamp01(Math.min(next.y, 1 - next.h));
    } else {
      let left = anchor.left;
      let top = anchor.top;
      let right = anchor.right;
      let bottom = anchor.bottom;
      const dir = String(__pfxRoiEditSession.handle || '');
      if (dir.includes('w')) left = pt.x;
      if (dir.includes('e')) right = pt.x;
      if (dir.includes('n')) top = pt.y;
      if (dir.includes('s')) bottom = pt.y;
      next = __pfxSnapViewerRoi({ x: left, y: top, w: right - left, h: bottom - top, enabled: start?.enabled !== false });
    }
    __pfxRoiEditSession.previewRect = next;
    __pfxRenderViewerRoiOverlay();
  };

  const __pfxFinishViewerRoiEdit = (commit = true) => {
    if (!__pfxRoiEditSession) return;
    const sess = __pfxRoiEditSession;
    __pfxRoiEditSession = null;
    try { if (sess?.pointerId != null) roiOverlay.releasePointerCapture(sess.pointerId); } catch {};
    if (commit && sess.previewRect && Number(sess.previewRect.w) > 0.01 && Number(sess.previewRect.h) > 0.01) {
      __pfxCommitSingleViewerRoi(Number(sess.index), sess.previewRect, 'Custom ROI updated ({n} regions).');
    }
    __pfxRenderViewerRoiOverlay();
  };

  const __pfxBeginViewerRoiDraw = (ev) => {
    if (!__pfxRoiDrawMode) return;
    if (ev.button != null && ev.button !== 0) return;
    if (ev.target && ev.target.closest && ev.target.closest('.pfx-reviews-roiBox')) return;
    ev.preventDefault();
    ev.stopPropagation();
    const pt = __pfxViewerPointToNorm(ev.clientX, ev.clientY);
    __pfxRoiEditSession = null;
    __pfxRoiDraft = { x: pt.x, y: pt.y, w: 0, h: 0, enabled: true, x0: pt.x, y0: pt.y };
    __pfxRoiPointerId = ev.pointerId;
    try { roiOverlay.setPointerCapture(ev.pointerId); } catch {}
    __pfxRenderViewerRoiOverlay();
  };

  const __pfxMoveViewerRoiDraw = (ev) => {
    if (!__pfxRoiDrawMode) return;
    if (__pfxRoiEditSession) {
      if (__pfxRoiEditSession.pointerId != null && ev.pointerId != null && ev.pointerId !== __pfxRoiEditSession.pointerId) return;
      __pfxApplyViewerRoiEdit(ev.clientX, ev.clientY);
      return;
    }
    if (!__pfxRoiDraft) return;
    if (__pfxRoiPointerId != null && ev.pointerId != null && ev.pointerId !== __pfxRoiPointerId) return;
    const pt = __pfxViewerPointToNorm(ev.clientX, ev.clientY);
    const _roiX0 = __pfxRoiDraft.x0;
    const _roiY0 = __pfxRoiDraft.y0;
    __pfxRoiDraft = __pfxSnapViewerRoi({ x: _roiX0, y: _roiY0, w: pt.x - _roiX0, h: pt.y - _roiY0, enabled: true });
    __pfxRoiDraft.x0 = _roiX0;
    __pfxRoiDraft.y0 = _roiY0;
    __pfxRenderViewerRoiOverlay();
  };

  const __pfxEndViewerRoiDraw = (ev) => {
    if (!__pfxRoiDrawMode) return;
    if (__pfxRoiEditSession) {
      if (__pfxRoiEditSession.pointerId != null && ev.pointerId != null && ev.pointerId !== __pfxRoiEditSession.pointerId) return;
      __pfxFinishViewerRoiEdit(true);
      return;
    }
    if (!__pfxRoiDraft) return;
    if (__pfxRoiPointerId != null && ev.pointerId != null && ev.pointerId !== __pfxRoiPointerId) return;
    const draft = __pfxSnapViewerRoi(__pfxRoiDraft);
    __pfxRoiDraft = null;
    __pfxRoiPointerId = null;
    try { roiOverlay.releasePointerCapture(ev.pointerId); } catch {}
    if (draft.w > 0.01 && draft.h > 0.01) {
      const next = __pfxGetCurrentRoiRegions();
      next.push(draft);
      __pfxSelectedRoiIndex = next.length - 1;
      __pfxCommitViewerRoiRegions(next, `Custom ROI updated ({n} region${next.length === 1 ? '' : 's'}).`);
    }
    __pfxRenderViewerRoiOverlay();
  };

  roiOverlay.addEventListener('pointerdown', __pfxBeginViewerRoiDraw);
  roiOverlay.addEventListener('pointermove', __pfxMoveViewerRoiDraw);
  roiOverlay.addEventListener('pointerup', __pfxEndViewerRoiDraw);
  roiOverlay.addEventListener('pointercancel', __pfxEndViewerRoiDraw);

  const __pfxGetSelectedV1CutMeta = () => {
    try {
      const sel = store.getSelectedV1Cut?.() || store.state?.selectedV1Cut || null;
      if (!sel) return null;
      const fps = Math.max(1, Number(store.state?.fps) || 24);
      const markers = store.getV1CutMarkers?.() || [];
      return markers.find((cut) => String(cut.clipId || '') === String(sel.clipId || '') && Math.abs((Number(cut.timeSec) || 0) - (Number(sel.timeSec) || 0)) <= (0.75 / fps)) || null;
    } catch { return null; }
  };

  const __pfxResolveEditableV1Cut = () => {
    const selected = __pfxGetSelectedV1CutMeta();
    if (selected) return selected;
    try {
      const info = store.getSegmentBoundaryInfo?.(store.state?.activeIndex) || null;
      if (!info) return null;
      const candidates = [info.leading, info.trailing].filter(Boolean);
      if (!candidates.length) return null;
      const gt = Math.max(0, Number(store.state?.globalTimeSec) || 0);
      candidates.sort((a, b) => Math.abs((Number(a?.globalTimeSec) || 0) - gt) - Math.abs((Number(b?.globalTimeSec) || 0) - gt));
      return candidates[0] || null;
    } catch { return null; }
  };

  const __pfxRenderV1CutDock = () => {
    try {
      const seg = store.state?.segments?.[store.state?.activeIndex] || null;
      const info = store.getSegmentBoundaryInfo?.(store.state?.activeIndex) || null;
      const editCut = __pfxResolveEditableV1Cut();
      const hasSeg = !!seg;
      const hasCut = !!editCut;
      const selectedClipId = String(editCut?.clipId || seg?.clipId || '');
      const allCutMarkers = store.getV1CutMarkers?.() || [];
      const hasAnyCuts = allCutMarkers.length > 0;
      const hasUncertain = !!allCutMarkers.some((cut) => cut?.uncertain);
      const clipUncertainCount = selectedClipId ? allCutMarkers.filter((cut) => String(cut?.clipId || '') === selectedClipId && cut?.uncertain).length : 0;
      const segLabel = seg
        ? `Seg ${Math.max(0, Number(store.state?.activeIndex) || 0) + 1}/${Math.max(0, Number(store.state?.segments?.length) || 0)} · ${String(seg.baseName || seg.name || 'V1')}`
        : 'No active segment';
      const segLabelCompact = seg
        ? `Seg ${Math.max(0, Number(store.state?.activeIndex) || 0) + 1}/${Math.max(0, Number(store.state?.segments?.length) || 0)}`
        : 'No active';
      const cutTypeLabel = String(editCut?.type || 'hard_cut').replace(/_/g, ' ');
      const cutLabel = editCut
        ? `${secondsToClock(Number(editCut.globalTimeSec) || 0)} · ${cutTypeLabel}`
        : '';
      const stats = (editCut && store.state?.v1CutStatsByClip && store.state.v1CutStatsByClip[editCut.clipId]) ? store.state.v1CutStatsByClip[editCut.clipId] : null;
      const confidencePct = editCut?.confidence == null ? '' : `${Math.round(Math.max(0, Math.min(1, Number(editCut.confidence) || 0)) * 100)}%`;
      const thresholdPct = (stats && Number.isFinite(Number(stats.threshold))) ? `${Math.round(Math.max(0, Math.min(1, Number(stats.threshold) || 0)) * 100)}%` : '';
      refCutInspectorMain.textContent = segLabelCompact;
      refCutInspectorMain.title = segLabel;
      refCutInspectorSub.textContent = cutLabel;
      refCutInspectorSub.title = cutLabel || 'No cut selected';
      refCutInspectorMeta.textContent = '';
      const metaBits = [];
      if (confidencePct) metaBits.push({ label: confidencePct, cls: 'is-strong' });
      if (editCut?.uncertain) metaBits.push({ label: '?', cls: 'is-warn' });
      if (thresholdPct) metaBits.push({ label: `S${thresholdPct}`, cls: '' });
      if (clipUncertainCount > 0) metaBits.push({ label: `?${clipUncertainCount}`, cls: 'is-warn' });
      metaBits.forEach((bit) => {
        const chip = el('span', `pfx-reviews-cutInspectorBadge${bit.cls ? ` ${bit.cls}` : ''}`, String(bit.label || ''));
        refCutInspectorMeta.append(chip);
      });
      if (!metaBits.length) {
        const chip = el('span', 'pfx-reviews-cutInspectorBadge', hasAnyCuts ? 'Select cut' : 'No cuts');
        refCutInspectorMeta.append(chip);
      }
      btnV1AutoCutsDock.textContent = __pfxV1CutsBusy ? 'Detecting…' : (hasAnyCuts ? 'Re-detect' : 'Detect');
      btnV1AutoCutsDock.disabled = __pfxV1CutsBusy;

      btnV1Split.disabled = __pfxV1CutsBusy || !hasSeg;
      btnV1MergePrev.disabled = __pfxV1CutsBusy || !info?.leading;
      btnV1MergeNext.disabled = __pfxV1CutsBusy || !info?.trailing;
      btnV1ToggleUncertain.disabled = __pfxV1CutsBusy || !hasCut;
      btnV1PrevUnsure.disabled = __pfxV1CutsBusy || !hasUncertain;
      btnV1NextUnsure.disabled = __pfxV1CutsBusy || !hasUncertain;
      btnV1NudgeMinus5.disabled = __pfxV1CutsBusy || !hasCut;
      btnV1NudgeMinus1.disabled = __pfxV1CutsBusy || !hasCut;
      btnV1NudgePlus1.disabled = __pfxV1CutsBusy || !hasCut;
      btnV1NudgePlus5.disabled = __pfxV1CutsBusy || !hasCut;
      btnV1AcceptUnsure.disabled = __pfxV1CutsBusy || !hasUncertain;
      btnV1RejectUnsure.disabled = __pfxV1CutsBusy || !hasUncertain;
      btnV1AcceptClipUnsure.disabled = __pfxV1CutsBusy || clipUncertainCount <= 0;
      btnV1RejectClipUnsure.disabled = __pfxV1CutsBusy || clipUncertainCount <= 0;
      btnV1UnsureOnly.disabled = __pfxV1CutsBusy || !hasAnyCuts;
      btnV1UnsureOnly.classList.toggle('is-active', String(store.state?.v1CutViewMode || 'all') === 'uncertain');
      btnV1EditROI.classList.toggle('is-active', detectAutoCutIgnorePreset(store.state?.autoCutSettings?.ignoreRegions || []) === 'custom');
      btnV1CopyROI.disabled = !(__pfxGetCurrentRoiRegions().length);
      btnV1PasteROI.disabled = false;
      btnV1ToggleUncertain.classList.toggle('is-active', !!editCut?.uncertain);
    } catch {}
  };

  const __pfxDoV1Split = async () => {
    try {
      const result = store.splitSegmentAtGlobalTime?.(store.state?.globalTimeSec);
      if (!result) { try { status.textContent = 'Cannot split here.'; } catch {} return; }
      try { store.selectV1Cut(result); } catch {}
      const gt = Number(result?.globalTimeSec) || Math.max(0, Number(store.state?.globalTimeSec) || 0);
      try { await scrubTo(gt); } catch {}
      try { timeline.jumpToTime(gt); } catch {}
      try { status.textContent = 'Split added.'; } catch {}
    } catch (e) { try { status.textContent = String(e?.message || e); } catch {} }
  };

  const __pfxDoV1MergePrev = async () => {
    try {
      const info = store.getSegmentBoundaryInfo?.(store.state?.activeIndex) || null;
      if (!info?.leading) { try { status.textContent = 'No previous boundary to merge.'; } catch {} return; }
      const gt = Math.max(0, Number(info.leading.globalTimeSec) || 0);
      const ok = store.mergeSegmentWithPrevious?.(store.state?.activeIndex);
      if (!ok) { try { status.textContent = 'Merge previous failed.'; } catch {} return; }
      try { await scrubTo(Math.max(0, gt - (0.5 / Math.max(1, Number(store.state?.fps) || 24)))); } catch {}
      try { timeline.jumpToTime(gt); } catch {}
      try { status.textContent = 'Merged with previous.'; } catch {}
    } catch (e) { try { status.textContent = String(e?.message || e); } catch {} }
  };

  const __pfxDoV1MergeNext = async () => {
    try {
      const info = store.getSegmentBoundaryInfo?.(store.state?.activeIndex) || null;
      if (!info?.trailing) { try { status.textContent = 'No next boundary to merge.'; } catch {} return; }
      const gt = Math.max(0, Number(info.trailing.globalTimeSec) || 0);
      const ok = store.mergeSegmentWithNext?.(store.state?.activeIndex);
      if (!ok) { try { status.textContent = 'Merge next failed.'; } catch {} return; }
      try { await scrubTo(Math.max(0, gt - (0.5 / Math.max(1, Number(store.state?.fps) || 24)))); } catch {}
      try { timeline.jumpToTime(gt); } catch {}
      try { status.textContent = 'Merged with next.'; } catch {}
    } catch (e) { try { status.textContent = String(e?.message || e); } catch {} }
  };

  const __pfxDoV1Nudge = async (frames) => {
    try {
      const cut = __pfxResolveEditableV1Cut();
      if (!cut) { try { status.textContent = 'Select a cut first.'; } catch {} return; }
      const result = store.nudgeV1Cut?.(cut.clipId, cut.timeSec, frames);
      if (!result) { try { status.textContent = 'Nudge blocked by adjacent boundary.'; } catch {} return; }
      try { store.selectV1Cut(result); } catch {}
      const gt = Number(result?.globalTimeSec) || Math.max(0, Number(store.state?.globalTimeSec) || 0);
      try { await scrubTo(gt); } catch {}
      try { timeline.jumpToTime(gt); } catch {}
      try { status.textContent = `Cut nudged ${(Number(frames) || 0) > 0 ? '+' : ''}${Number(frames) || 0}f.`; } catch {}
    } catch (e) { try { status.textContent = String(e?.message || e); } catch {} }
  };

  const __pfxDoV1ToggleUncertain = () => {
    try {
      const cut = __pfxResolveEditableV1Cut();
      if (!cut) { try { status.textContent = 'Select a cut first.'; } catch {} return; }
      store.toggleV1CutUncertain?.(cut.clipId, cut.timeSec);
      try { store.selectV1Cut(cut); } catch {}
      try { status.textContent = 'Cut uncertain flag updated.'; } catch {}
    } catch (e) { try { status.textContent = String(e?.message || e); } catch {} }
  };

  const __pfxJumpUnsure = async (dir = 1) => {
    try {
      const next = store.selectAdjacentV1Cut?.(dir, { uncertainOnly: true, anchorGlobalTimeSec: store.state?.globalTimeSec });
      if (!next) { try { status.textContent = 'No uncertain cuts.'; } catch {} return; }
      const markers = store.getV1CutMarkers?.() || [];
      const fps = Math.max(1, Number(store.state?.fps) || 24);
      const marker = markers.find((cut) => String(cut.clipId||'') === String(next.clipId||'') && Math.abs((Number(cut.timeSec)||0) - (Number(next.timeSec)||0)) <= (0.75 / fps)) || null;
      const gt = Number(marker?.globalTimeSec);
      if (Number.isFinite(gt)) {
        try { await scrubTo(gt); } catch {}
        try { timeline.jumpToTime(gt); } catch {}
      }
      try { status.textContent = 'Jumped to uncertain cut.'; } catch {}
    } catch (e) { try { status.textContent = String(e?.message || e); } catch {} }
  };


  const __pfxToggleUnsureOnly = () => {
    try {
      const next = store.setV1CutViewMode?.(String(store.state?.v1CutViewMode || 'all') === 'uncertain' ? 'all' : 'uncertain');
      try { status.textContent = (next === 'uncertain') ? 'Timeline showing only uncertain cuts.' : 'Timeline showing all cuts.'; } catch {}
      __pfxSyncV1CutsButtons();
      try { __pfxScheduleAutosave({ force: true }); } catch {}
    } catch (e) { try { status.textContent = String(e?.message || e); } catch {} }
  };


  const __pfxBatchAcceptClipUnsure = () => {
    try {
      const editCut = __pfxResolveEditableV1Cut();
      const clipId = String(editCut?.clipId || store.state?.segments?.[store.state?.activeIndex]?.clipId || '');
      if (!clipId) { try { status.textContent = 'No V1 clip selected.'; } catch {} return; }
      const count = store.acceptUncertainV1CutsForClip?.(clipId) || 0;
      try { status.textContent = count > 0 ? `Accepted ${count} uncertain cut${count === 1 ? '' : 's'} on clip.` : 'No uncertain cuts on this clip.'; } catch {}
      try { __pfxScheduleAutosave({ force: true }); } catch {}
      __pfxSyncV1CutsButtons();
    } catch (e) { try { status.textContent = String(e?.message || e); } catch {} }
  };

  const __pfxBatchRejectClipUnsure = () => {
    try {
      const editCut = __pfxResolveEditableV1Cut();
      const clipId = String(editCut?.clipId || store.state?.segments?.[store.state?.activeIndex]?.clipId || '');
      if (!clipId) { try { status.textContent = 'No V1 clip selected.'; } catch {} return; }
      const count = store.rejectUncertainV1CutsForClip?.(clipId) || 0;
      try { status.textContent = count > 0 ? `Rejected ${count} uncertain cut${count === 1 ? '' : 's'} on clip.` : 'No uncertain cuts on this clip.'; } catch {}
      try { __pfxScheduleAutosave({ force: true }); } catch {}
      __pfxSyncV1CutsButtons();
    } catch (e) { try { status.textContent = String(e?.message || e); } catch {} }
  };

  const __pfxBatchAcceptUnsure = () => {
    try {
      const changed = Number(store.acceptAllUncertainV1Cuts?.('timeline')) || 0;
      if (!changed) { try { status.textContent = 'No uncertain cuts to accept.'; } catch {} return; }
      try { status.textContent = `Accepted ${changed} uncertain cut${changed === 1 ? '' : 's'}.`; } catch {}
      __pfxSyncV1CutsButtons();
      try { __pfxScheduleAutosave({ force: true }); } catch {}
    } catch (e) { try { status.textContent = String(e?.message || e); } catch {} }
  };

  const __pfxBatchRejectUnsure = () => {
    try {
      const changed = Number(store.rejectAllUncertainV1Cuts?.('timeline')) || 0;
      if (!changed) { try { status.textContent = 'No uncertain cuts to reject.'; } catch {} return; }
      try { status.textContent = `Rejected ${changed} uncertain cut${changed === 1 ? '' : 's'}.`; } catch {}
      __pfxSyncV1CutsButtons();
      try { __pfxScheduleAutosave({ force: true }); } catch {}
    } catch (e) { try { status.textContent = String(e?.message || e); } catch {} }
  };


  const __pfxGetCurrentTimelineCutModel = () => {
    try{
      const model = window.__MPS_EDL_TL_MODEL;
      if (model && Array.isArray(model.tracks) && model.tracks.some((t) => Array.isArray(t?.items) && t.items.length)) return model;
    }catch{}
    try{
      const model = window.__PFX_IMPORTED_TIMELINE_MODEL;
      if (model && Array.isArray(model.tracks) && model.tracks.some((t) => Array.isArray(t?.items) && t.items.length)) return model;
    }catch{}
    try{
      const snap = window.__MPS_SM_SNAPSHOT;
      const model = snap?.state?.importedTimeline;
      if (model && Array.isArray(model.tracks) && model.tracks.some((t) => Array.isArray(t?.items) && t.items.length)) return model;
    }catch{}
    return null;
  };

  const __pfxPickTimelineCutTrack = (model) => {
    try{
      const tracks = Array.isArray(model?.tracks) ? model.tracks : [];
      const usable = tracks
        .map((track, idx) => ({
          track,
          idx,
          trackIndex: Number.isFinite(Number(track?.trackIndex)) ? Number(track.trackIndex) : idx,
          items: (Array.isArray(track?.items) ? track.items : [])
            .filter((item) => Number.isFinite(Number(item?.inF)) && Number.isFinite(Number(item?.outF)) && (Number(item?.outF) > Number(item?.inF)))
            .slice()
            .sort((a, b) => (Number(a?.inF) || 0) - (Number(b?.inF) || 0)),
        }))
        .filter((entry) => entry.items.length);
      if (!usable.length) return null;

      // Prefer the editorial spine / main track first.
      // In the shared timeline model, trackIndex 0 is the primary track the user sees as V1.
      // Picking “the track with the most items” can accidentally choose connected / overlay lanes,
      // which does not represent the real editorial cut pattern for V1 reference splitting.
      const spine = usable.find((entry) => Number(entry.trackIndex) === 0 && entry.items.length > 1);
      if (spine) return spine;

      // Next best: the lowest track index that already contains multiple clips.
      const multi = usable
        .filter((entry) => entry.items.length > 1)
        .sort((a, b) => {
          if (a.trackIndex !== b.trackIndex) return a.trackIndex - b.trackIndex;
          return b.items.length - a.items.length;
        });
      if (multi.length) return multi[0];

      // Last resort: still return the lowest visible track so fallback logic can inspect all tracks.
      usable.sort((a, b) => {
        if (a.trackIndex !== b.trackIndex) return a.trackIndex - b.trackIndex;
        return b.items.length - a.items.length;
      });
      return usable[0];
    }catch{}
    return null;
  };

  const __pfxGetPreferredV1ClipId = () => {
    try{
      const order = Array.isArray(store.state?.timelineClipIds) ? store.state.timelineClipIds.filter(Boolean) : [];
      if (order.length) return String(order[0]);
      const clips = Array.isArray(store.state?.clips) ? store.state.clips : [];
      const firstRef = clips.find((clip) => String(clip?.bin || '').toLowerCase() === 'ref');
      if (firstRef?.id) return String(firstRef.id);
      const srcId = String(videoSrc?.dataset?.clipId || '').trim();
      if (srcId) return srcId;
    }catch{}
    return '';
  };

  const __pfxBuildTimelineCutsForClip = async (clipId) => {
    const model = __pfxGetCurrentTimelineCutModel();
    if (!model) throw new Error('No project timeline loaded. Import a timeline first.');
    const picked = __pfxPickTimelineCutTrack(model);
    if (!picked || !picked.items.length) throw new Error('Timeline has no usable cut events.');

    const fpsFromTimeline = Math.max(1, Number(model?.fps) || Number(store.state?.fps) || 24);
    try{
      if (Math.abs((Number(store.state?.fps) || 24) - fpsFromTimeline) > 0.001) {
        store.set({ fps: fpsFromTimeline }, 'fps');
        try { fpsSelect.value = String(fpsFromTimeline); } catch {}
      }
    }catch{}

    const order = Array.isArray(store.state?.timelineClipIds) ? store.state.timelineClipIds.map(String) : [];
    if (!order.includes(String(clipId || ''))) {
      try { store.appendToTimeline(String(clipId)); } catch {}
    }

    try { await player.ensureClipMetadata(String(clipId)); } catch {}
    const clip = (store.state?.clips || []).find((entry) => String(entry?.id || '') === String(clipId || '')) || null;

    const __pfxResolveClipDurationSec = () => {
      const values = [];
      try { values.push(Number(clip?.durationSec) || 0); } catch {}
      try {
        const activeSeg = (store.state?.segments || []).find((seg) => String(seg?.clipId || '') === String(clipId || '')) || null;
        values.push(Number(activeSeg?.durationSec) || 0);
      } catch {}
      try {
        if (String(videoSrc?.dataset?.clipId || '') === String(clipId || '')) {
          values.push(Number(videoSrc?.duration) || 0);
        }
      } catch {}
      try {
        const tlClip = (store.state?.timelineClipIds || [])
          .map((id) => (store.state?.clips || []).find((entry) => String(entry?.id || '') === String(id || '')) || null)
          .find((entry) => String(entry?.id || '') === String(clipId || ''));
        values.push(Number(tlClip?.durationSec) || 0);
      } catch {}
      const best = values.find((value) => Number.isFinite(value) && value > 0.25);
      return Number.isFinite(best) && best > 0 ? best : 0;
    };

    const clipDurSec = Math.max(0, __pfxResolveClipDurationSec());
    const clipDurFrames = Math.max(1, Math.round((clipDurSec > 0 ? clipDurSec : ((Number(model?.durationFrames) || 1) / fpsFromTimeline)) * fpsFromTimeline));

    // Timeline cuts must survive even when clip metadata has not finished probing yet.
    // Store.rebuildSegments() filters cuts against clip.durationSec, so if durationSec stays 0
    // every imported cut gets dropped and Visual QC remains stuck on "Seg 1/1 · No cuts".
    // As soon as we have any reliable duration from the loaded player / active segment / model,
    // push it back into the clip store before setting cuts.
    try {
      const knownClipDur = Number(clip?.durationSec) || 0;
      const fallbackDurSec = (clipDurSec > 0)
        ? clipDurSec
        : Math.max(0, (Number(model?.durationFrames) || 0) / fpsFromTimeline);
      if (fallbackDurSec > 0.25 && Math.abs(knownClipDur - fallbackDurSec) > (1 / fpsFromTimeline)) {
        store.updateClip(String(clipId), { durationSec: fallbackDurSec });
      }
    } catch {}

    const rawTrackStarts = (picked.items || [])
      .map((item) => Math.round(Number(item?.inF) || 0))
      .filter((frame) => Number.isFinite(frame));
    const firstTrackStart = rawTrackStarts.length ? Math.min(...rawTrackStarts) : 0;
    const modelBaseFrame = Number.isFinite(Number(model?.baseFrames)) ? Math.round(Number(model.baseFrames)) : null;

    const allTrackItems = (Array.isArray(model?.tracks) ? model.tracks : [])
      .flatMap((track, idx) => {
        const trackIndex = Number.isFinite(Number(track?.trackIndex)) ? Number(track.trackIndex) : idx;
        return (Array.isArray(track?.items) ? track.items : [])
          .filter((item) => Number.isFinite(Number(item?.inF)) && Number.isFinite(Number(item?.outF)) && (Number(item?.outF) > Number(item?.inF)))
          .map((item) => ({
            trackIndex,
            inF: Math.round(Number(item?.inF) || 0),
            outF: Math.round(Number(item?.outF) || 0),
          }));
      })
      .filter((item) => Number.isFinite(item.inF) && Number.isFinite(item.outF));

    const globalTrackStarts = allTrackItems
      .map((item) => item.inF)
      .filter((frame) => Number.isFinite(frame));
    const firstGlobalStart = globalTrackStarts.length ? Math.min(...globalTrackStarts) : firstTrackStart;

    const baseCandidates = [];
    const seenBases = new Set();
    const pushBase = (value) => {
      const v = Math.round(Number(value) || 0);
      if (!Number.isFinite(v)) return;
      if (seenBases.has(v)) return;
      seenBases.add(v);
      baseCandidates.push(v);
    };
    pushBase(0);
    if (modelBaseFrame != null) pushBase(modelBaseFrame);
    pushBase(firstTrackStart);
    pushBase(firstGlobalStart);

    let bestCutFrames = [];
    let bestBase = 0;
    for (const baseFrame of baseCandidates) {
      const cutFrames = [];
      const seen = new Set();
      for (const item of picked.items) {
        const absFrame = Math.round(Number(item?.inF) || 0);
        const relFrame = absFrame - baseFrame;
        if (!Number.isFinite(relFrame) || relFrame <= 0) continue;
        if (relFrame >= clipDurFrames) continue;
        if (seen.has(relFrame)) continue;
        seen.add(relFrame);
        cutFrames.push(relFrame);
      }
      cutFrames.sort((a, b) => a - b);
      if (cutFrames.length > bestCutFrames.length) {
        bestCutFrames = cutFrames;
        bestBase = baseFrame;
      }
    }

    // Fallback 1: search all visible track boundaries in case the preferred track is not the real editorial spine.
    if (!bestCutFrames.length && allTrackItems.length > 1) {
      for (const baseFrame of baseCandidates) {
        const cutFrames = [];
        const seen = new Set();
        for (const item of allTrackItems) {
          const relFrame = Math.round(Number(item?.inF) || 0) - baseFrame;
          if (!Number.isFinite(relFrame) || relFrame <= 0) continue;
          if (relFrame >= clipDurFrames) continue;
          if (seen.has(relFrame)) continue;
          seen.add(relFrame);
          cutFrames.push(relFrame);
        }
        cutFrames.sort((a, b) => a - b);
        if (cutFrames.length > bestCutFrames.length) {
          bestCutFrames = cutFrames;
          bestBase = baseFrame;
        }
      }
    }

    // Fallback 2: if record positions do not line up with the loaded V1 clip, fit the imported boundaries
    // proportionally across the V1 duration instead of leaving the clip as a single "No cuts" segment.
    // This also protects cases where clip metadata has not populated yet, but the loaded viewer duration is valid.
    if (!bestCutFrames.length && clipDurFrames > 1) {
      const itemsForFit = (((picked.items?.length || 0) > 1) ? picked.items : allTrackItems)
        .filter((item) => Number.isFinite(Number(item?.inF)) && Number.isFinite(Number(item?.outF)) && (Number(item?.outF) > Number(item?.inF)))
        .slice()
        .sort((a, b) => (Number(a?.inF) || 0) - (Number(b?.inF) || 0));

      if (itemsForFit.length > 1) {
        const fitStart = Math.min(...itemsForFit.map((item) => Math.round(Number(item?.inF) || 0)));
        const fitEnd = Math.max(...itemsForFit.map((item) => Math.round(Number(item?.outF) || 0)));
        const fitSpan = Math.max(1, fitEnd - fitStart);
        const cutFrames = [];
        const seen = new Set();
        for (const item of itemsForFit) {
          const absStart = Math.round(Number(item?.inF) || 0);
          const relRatio = (absStart - fitStart) / fitSpan;
          const relFrame = Math.round(relRatio * clipDurFrames);
          if (!Number.isFinite(relFrame) || relFrame <= 0) continue;
          if (relFrame >= clipDurFrames) continue;
          if (seen.has(relFrame)) continue;
          seen.add(relFrame);
          cutFrames.push(relFrame);
        }
        cutFrames.sort((a, b) => a - b);
        if (cutFrames.length) {
          bestCutFrames = cutFrames;
          bestBase = fitStart;
        }
      }
    }

    const cuts = bestCutFrames.map((frame) => ({
      frame,
      timeSec: frame / fpsFromTimeline,
      type: 'timeline_cut',
      reason: 'timeline_reference',
      confidence: 1,
      uncertain: false,
      score: 1,
    }));

    return {
      cuts,
      fps: fpsFromTimeline,
      baseFrameUsed: bestBase,
      firstTrackStart,
      modelBaseFrame,
      trackIndex: Number.isFinite(Number(picked.track?.trackIndex)) ? Number(picked.track.trackIndex) : picked.idx,
      items: picked.items.length,
    };
  };

  const __pfxApplyTimelineAsV1Reference = async () => {
    if (__pfxV1CutsBusy) return;
    const clipId = __pfxGetPreferredV1ClipId();
    if (!clipId) {
      try { status.textContent = 'Add a V1 ref clip first, then load timeline cuts.'; } catch {}
      return;
    }
    try{
      const result = await __pfxBuildTimelineCutsForClip(clipId);
      try { console.info('[PostFlowX] apply timeline cuts', { clipId, cuts: result.cuts?.length || 0, fpsFromTimeline: result.fps, baseFrameUsed: result.baseFrameUsed, items: result.items, trackIndex: result.trackIndex }); } catch {}
      store.setV1CutsForClip(clipId, result.cuts, {
        segments: (result.cuts?.length || 0) + 1,
        uncertain: 0,
        tinyMerged: 0,
        sampledFrames: result.items || 0,
        threshold: null,
        mode: 'shot',
        preset: 'timeline',
      });
      try { status.textContent = `Loaded timeline cuts to V1 · ${(result.cuts?.length || 0) + 1} segments`; } catch {}
      try { __pfxSaveAutosaveNow({ force: true }).catch(()=>{}); } catch {}
      try { __pfxSyncV1CutsButtons(); } catch {}
      try {
        const firstSeg = (store.state?.segments || []).find((seg) => String(seg?.clipId || '') === String(clipId));
        if (firstSeg) {
          player.loadAtGlobalTime(firstSeg.globalStartSec, { autoplay: false }).catch(()=>{});
          timeline.jumpToTime(firstSeg.globalStartSec);
        }
      } catch {}
    }catch(err){
      const msg = String(err?.message || err || 'Unable to load timeline cuts');
      try { status.textContent = msg; } catch {}
      try { console.warn('[PostFlowX] Load TL failed', { msg, hasPullPrepModel: !!window.__MPS_EDL_TL_MODEL, hasImportedModel: !!window.__PFX_IMPORTED_TIMELINE_MODEL, hasShotMarkerSnapshot: !!window.__MPS_SM_SNAPSHOT?.state?.importedTimeline }); } catch {}
    }
  };

  const __pfxSyncV1CutsButtons = () => {
    const has = __pfxHasAnyV1Cuts();
    __pfxSyncAutoCutControlsFromState();
    __pfxRenderV1CutSummary();
    __pfxRenderV1CutDock();
    try { btnV1ClearCuts.disabled = !has || __pfxV1CutsBusy; } catch {}
    const hasTimelineModel = !!__pfxGetCurrentTimelineCutModel();
    try { btnV1AutoCuts.disabled = __pfxV1CutsBusy; } catch {}
    try { btnV1AutoCutsDock.disabled = __pfxV1CutsBusy; } catch {}
    try { btnV1LoadTimelineCuts.disabled = __pfxV1CutsBusy || !hasTimelineModel; } catch {}
    try { btnV1LoadTimelineCuts.style.opacity = hasTimelineModel ? '' : '0.45'; } catch {}
    try { autoCutMode.disabled = __pfxV1CutsBusy; } catch {}
    try { autoCutPreset.disabled = __pfxV1CutsBusy; } catch {}
    try { btnV1DrawROI.disabled = __pfxV1CutsBusy; } catch {}
    try { btnV1ClearROI.disabled = __pfxV1CutsBusy || !__pfxGetCurrentRoiRegions().length; } catch {}
    try {
      btnV1AutoCuts.textContent = __pfxV1CutsBusy ? 'Detecting…' : 'Cut Detect';
    } catch {}
    try {
      btnV1AutoCutsDock.textContent = __pfxV1CutsBusy ? 'Detecting…' : (__pfxHasAnyV1Cuts() ? 'Re-run Detect' : 'Scene Detect');
    } catch {}
    try { __pfxRenderViewerRoiOverlay(); } catch {}
    try { __pfxSyncSceneCutToolbar(); } catch {}
    try {
      btnV1ClearCuts.style.opacity = has ? '' : '0.45';
    } catch {}
  };

  async function __pfxDetectSceneCutsForClip(clip, onProgress) {
    return analyzeClipForSceneCutDetect({
      clip,
      fps: Number(store.state?.fps) || 24,
      sensitivity: clampSceneCutSensitivity(sceneCutSensitivity?.value || readSceneCutSensitivity()),
      onProgress,
      shouldAbort: () => __pfxV1CutsAbort,
    });
  }

  async function __pfxRunV1AutoCuts() {
    if (__pfxV1CutsBusy) {
      __pfxV1CutsAbort = true;
      return;
    }
    const order = Array.isArray(store.state?.timelineClipIds) ? store.state.timelineClipIds.slice() : [];
    const ids = Array.from(new Set(order.map(x => String(x)).filter(Boolean)));
    if (!ids.length) {
      try { status.textContent = 'Add a V1 clip to the timeline first.'; } catch {}
      return;
    }

    __pfxV1CutsBusy = true;
    __pfxV1CutsAbort = false;
    __pfxSyncV1CutsButtons();

    try {
      let done = 0;
      for (const clipId of ids) {
        if (__pfxV1CutsAbort) break;
        const c = (store.state.clips || []).find(x => x && x.id === clipId) || null;
        if (!c) continue;
        // Ensure duration exists (best-effort)
        try { await player.ensureClipMetadata(clipId); } catch {}

        try {
          const result = await __pfxDetectSceneCutsForClip(c, (p, meta) => {
            try {
              const pct = Math.round(((done + Math.max(0, Math.min(1, Number(p) || 0))) / Math.max(1, ids.length)) * 100);
              btnV1AutoCuts.textContent = `Detecting… ${pct}%`;
              __pfxSetSceneCutMeta(`Cut Detect: ${pct}%${meta?.cuts != null ? ` · cuts ${meta.cuts}` : ''}`, true);
            } catch {}
          });
          if (__pfxV1CutsAbort) break;
          store.setV1CutsForClip(clipId, result?.cuts || [], {
            ...(result?.stats || {}),
            mode: result?.meta?.mode || 'shot',
            preset: result?.meta?.preset || 'standard',
          });
        } catch (e) {
          try { status.textContent = `Scene Cut Detect failed: ${String(e?.message || e)}`; __pfxSetSceneCutMeta('Cut Detect: failed', false); } catch {}
        }
        done++;
      }

      if (__pfxV1CutsAbort) {
        try { status.textContent = 'Scene Cut Detection cancelled.'; __pfxSetSceneCutMeta('Cut Detect: cancelled', false); } catch {}
      } else {
        const summary = __pfxGetV1CutsAggregate();
        try { status.textContent = `Scene Cut Detect ready · ${summary.segments || 0} segments`; __pfxSetSceneCutMeta(`Cut Detect: ${summary.segments || 0} seg`, false); } catch {}
      }
    } finally {
      __pfxV1CutsBusy = false;
      __pfxV1CutsAbort = false;
      __pfxSyncV1CutsButtons();
      // Persist immediately (cuts can be many, ensure they survive refresh)
      try { __pfxSaveAutosaveNow({ force: true }).catch(()=>{}); } catch {}
    }
  }

  // ===== Source Viewer (bin preview) =====
  let pinnedBinClipId = null;
  let sourceInSec = null;
  let sourceOutSec = null;

  const tcFromSeconds = (sec, fps) => {
    const f = Math.max(0, Math.round((Number(sec) || 0) * (Number(fps) || 24)));
    const ff = f % (Number(fps) || 24);
    const totalSec = Math.floor(f / (Number(fps) || 24));
    const ss = totalSec % 60;
    const mm = Math.floor(totalSec / 60) % 60;
    const hh = Math.floor(totalSec / 3600);
    const pad2 = (n) => String(n).padStart(2, '0');
    return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
  };

  const frameStep = () => {
    const fps = Number(store.state.fps) || 24;
    return 1 / fps;
  };

  const fmtSec = (sec) => {
    const s = Math.max(0, Number(sec) || 0);
    // HH:MM:SS.mmm (simple and readable)
    const hh = Math.floor(s / 3600);
    const mm = Math.floor(s / 60) % 60;
    const ss = Math.floor(s) % 60;
    const ms = Math.floor((s - Math.floor(s)) * 1000);
    const pad2 = (n) => String(n).padStart(2, '0');
    const pad3 = (n) => String(n).padStart(3, '0');
    return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.${pad3(ms)}`;
  };

  const syncSourceReadout = () => {
    const fps = Number(store.state.fps) || 24;
    const t = Math.max(0, Number(videoSrc.currentTime) || 0);
    srcRec.textContent = `SRC ${tcFromSeconds(t, fps)}`;
    try {
      const clipId = videoSrc?.dataset?.clipId;
      const idx = clipId ? store.state.clips.findIndex(c => c.id === clipId) : -1;
      const total = store.state.clips.length || 0;
      srcCount.textContent = `${idx >= 0 ? idx + 1 : 0} / ${total}`;
    } catch {}
    const a = sourceInSec == null ? '—' : fmtSec(sourceInSec);
    const b = sourceOutSec == null ? '—' : fmtSec(sourceOutSec);
    // Show I/O state under the bar via title tooltip
    srcToV2.title = `IN ${a}  OUT ${b}`;
    try { syncSourceHandleState(); } catch {}
  };

  const describeClipMediaBadges = (clip, opts = {}) => {
    const variant = String(opts?.variant || 'full');
    if (!clip) return [];
    const badges = [];
    if (clip.handleSaved || clip.fsHandle) {
      const at = Number(clip.handleSavedAt) || 0;
      badges.push({
        cls: 'is-handle',
        label: variant === 'compact' ? 'Handle ✓' : 'Handle saved ✓',
        title: at ? `Stored for relink · ${new Date(at).toLocaleString()}` : 'Stored for relink'
      });
    }
    if (clip.autoRelinked) {
      const at = Number(clip.autoRelinkedAt) || 0;
      badges.push({
        cls: 'is-relinked',
        label: variant === 'compact' ? 'Auto ✓' : 'Auto relinked ✓',
        title: at ? `Recovered after refresh · ${new Date(at).toLocaleString()}` : 'Recovered after refresh'
      });
    }
    if ((!clip.url || clip.canPlay === false) && !clip.autoRelinked) {
      badges.push({
        cls: 'is-warning',
        label: 'Need relink',
        title: 'Clip is missing or not playable right now'
      });
    }
    return badges;
  };

  const appendClipMediaBadges = (container, clip, opts = {}) => {
    try { if (container) container.textContent = ''; } catch {}
    if (!container || !clip) return;
    const variant = String(opts?.variant || 'full');
    const badgeClass = String(opts?.badgeClass || 'pfx-reviews-mediaBadge');
    const extraClass = String(opts?.extraClass || '').trim();
    for (const badge of describeClipMediaBadges(clip, { variant })) {
      const classes = [badgeClass, 'pfx-reviews-mediaBadge', badge.cls, extraClass].filter(Boolean).join(' ');
      const node = el('div', classes, badge.label);
      if (badge.title) node.title = badge.title;
      container.appendChild(node);
    }
  };

  const appendHeaderMediaSummary = (container, clips = [], opts = {}) => {
    try { if (container) container.textContent = ''; } catch {}
    if (!container) return;
    const list = Array.isArray(clips) ? clips.filter(Boolean) : [];
    const total = list.length;
    const handles = list.filter((clip) => !!(clip?.handleSaved || clip?.fsHandle)).length;
    const autoRelinked = list.filter((clip) => !!clip?.autoRelinked).length;
    const needRelink = list.filter((clip) => ((!clip?.url || clip?.canPlay === false) && !clip?.autoRelinked)).length;

    const makeBadge = (label, cls = '', title = '') => {
      const node = el('div', 'pfx-reviews-mediaBadge pfx-reviews-mediaBadge--header ' + String(cls || '').trim(), label);
      if (title) node.title = title;
      container.appendChild(node);
    };

    if (!total) {
      makeBadge('Empty', 'is-empty', 'No clips in this bin yet');
      return;
    }

    if (needRelink > 0) makeBadge(`Need ${needRelink}`, 'is-warning', `${needRelink} clip${needRelink === 1 ? '' : 's'} still need relink`);
    if (handles > 0) makeBadge(`Handle ${handles}`, 'is-handle', `${handles}/${total} clip${total === 1 ? '' : 's'} have saved handles`);
    if (autoRelinked > 0) makeBadge(`Auto ${autoRelinked}`, 'is-relinked', `${autoRelinked}/${total} clip${total === 1 ? '' : 's'} auto relinked after refresh`);
    if (needRelink === 0) makeBadge(`Ready ${total}`, 'is-ready', `${total}/${total} clip${total === 1 ? '' : 's'} currently playable`);
  };

  const syncSourceHandleState = () => {
    try{
      const clipId = String(videoSrc?.dataset?.clipId || '');
      if (!clipId) { srcMediaState.textContent = ''; return; }
      const clip = (store.state?.clips || []).find((c) => c && c.id === clipId) || null;
      appendClipMediaBadges(srcMediaState, clip, { variant: 'full', badgeClass: 'pc-mediaBadge' });
    }catch{}
  };

  const syncTimelineHandleState = () => {
    try{
      const activeClipId = String(store.state?.segments?.[store.state?.activeIndex]?.clipId || '');
      if (!activeClipId) { tlMediaState.textContent = ''; return; }
      const clip = (store.state?.clips || []).find((c) => c && c.id === activeClipId) || null;
      appendClipMediaBadges(tlMediaState, clip, { variant: 'compact' });
    }catch{}
  };

  const clearSourceIO = () => {
    sourceInSec = null;
    sourceOutSec = null;
    syncSourceReadout();
  };

  const loadSourceClip = (seg, localTimeSec = 0, opts = {}) => {
    const { pin = false } = opts || {};

    if (!seg) {
      if (pin) pinnedBinClipId = null;
      try { videoSrc.removeAttribute("src"); } catch {}
      try { delete videoSrc.dataset.clipId; } catch {}
      sourceHint.style.display = "block";
      try { syncSourceHandleState(); } catch {}
      return;
    }

    if (pin) pinnedBinClipId = seg.clipId;
    sourceHint.style.display = "none";

    // Load clip if needed
    if (videoSrc.dataset.clipId !== seg.clipId) {
      videoSrc.dataset.clipId = seg.clipId;
      clearSourceIO();
      // Hide until first frame is ready (then show).
      try { videoSrc.style.opacity = '0'; } catch {}
      videoSrc.src = seg.url;
      videoSrc.muted = true;
      videoSrc.playsInline = true;
      videoSrc.preload = "auto";
      // Theme CSS may set videos to opacity:0 by default.
      // Force source viewer to be visible once a frame is available.
      try {
        videoSrc.addEventListener('loadeddata', () => {
          try { videoSrc.style.opacity = '1'; } catch {}
        }, { once: true });
        videoSrc.addEventListener('loadedmetadata', () => {
          try {
            const d = Math.max(0, Number(videoSrc.duration) || 0);
            srcScrub.max = String(Math.max(0.001, d));
          } catch {}
        }, { once: true });
        videoSrc.addEventListener('error', () => {
          // Show broken-media state rather than staying invisible
          try { videoSrc.style.opacity = '1'; } catch {}
        }, { once: true });
      } catch {}
      try { videoSrc.load(); } catch {}
    }

    // Update scrub range bounds (uses existing duration when clip hasn't changed)
    try {
      const dur = Math.max(0, Number(videoSrc.duration) || 0);
      srcScrub.max = String(Math.max(0.001, dur));
    } catch {}

    // Seek (best-effort)
    try {
      videoSrc.currentTime = Math.max(0, Number(localTimeSec) || 0);
    } catch {}

    try { srcScrub.value = String(Math.max(0, Number(videoSrc.currentTime) || 0)); } catch {}
    syncSourceReadout();
    try { syncSourceHandleState(); } catch {}
  };

  // Source transport controls
  const updateSrcPlayLabel = () => {
    try { srcPlay.textContent = videoSrc.paused ? '▶' : '❚❚'; } catch { srcPlay.textContent = '▶'; }
  };

  const srcSeek = (delta) => {
    const d = Number(delta) || 0;
    try { videoSrc.pause(); } catch {}
    try {
      videoSrc.currentTime = Math.max(0, (Number(videoSrc.currentTime) || 0) + d);
    } catch {}
    updateSrcPlayLabel();
  };

  // Source pro controls
  srcOpen.addEventListener('click', () => { try { openImport('shots'); } catch {} });
  srcStepBack.addEventListener('click', () => srcSeek(-frameStep()));
  srcStepFwd.addEventListener('click', () => srcSeek(frameStep()));
  srcPrev.addEventListener('click', () => srcSeek(-1));
  srcNext.addEventListener('click', () => srcSeek(1));
  srcPlay.addEventListener('click', () => {
    try {
      if (videoSrc.paused) videoSrc.play().catch(() => {});
      else videoSrc.pause();
    } catch {}
    updateSrcPlayLabel();
  });
  videoSrc.addEventListener('play', updateSrcPlayLabel);
  videoSrc.addEventListener('pause', updateSrcPlayLabel);
  videoSrc.addEventListener('timeupdate', () => {
    try { srcScrub.value = String(Math.max(0, Number(videoSrc.currentTime) || 0)); } catch {}
    syncSourceReadout();
  });

  srcScrub.addEventListener('input', () => {
    try {
      videoSrc.currentTime = Math.max(0, Number(srcScrub.value) || 0);
      syncSourceReadout();
    } catch {}
  });

  srcIn.addEventListener('click', () => {
    sourceInSec = Math.max(0, Number(videoSrc.currentTime) || 0);
    if (sourceOutSec != null && sourceOutSec < sourceInSec) {
      const tmp = sourceOutSec;
      sourceOutSec = sourceInSec;
      sourceInSec = tmp;
    }
    syncSourceReadout();
  });

  srcOut.addEventListener('click', () => {
    sourceOutSec = Math.max(0, Number(videoSrc.currentTime) || 0);
    if (sourceInSec != null && sourceOutSec < sourceInSec) {
      const tmp = sourceInSec;
      sourceInSec = sourceOutSec;
      sourceOutSec = tmp;
    }
    syncSourceReadout();
  });

  srcClearIO.addEventListener('click', () => clearSourceIO());

  srcToV1.addEventListener('click', async () => {
    const clipId = videoSrc?.dataset?.clipId;
    if (!clipId) return;
    // V1 is a traditional edit: append the selected clip to the end of the V1 timeline
    store.appendToTimeline(clipId);
    const last = store.state.segments[store.state.segments.length - 1];
    if (last) {
      try { await player.loadAtGlobalTime(last.globalStartSec, { autoplay: false }); } catch {}
      try { timeline.jumpToTime(last.globalStartSec); } catch {}
    }
  });

  srcToV2.addEventListener('click', async () => {
    const clipId = videoSrc?.dataset?.clipId;
    if (!clipId) return;
    const t = Math.max(0, Number(store.state.globalTimeSec) || 0);
    const fps = Number(store.state.fps) || 24;
    const minDur = 1 / fps;
    const inSec = Math.max(0, Number(sourceInSec) || 0);
    let outSec = sourceOutSec == null ? null : Math.max(0, Number(sourceOutSec) || 0);
    let dur = null;
    if (outSec != null) dur = Math.max(minDur, outSec - inSec);

    // If OUT is not set, use "full duration from IN" but still respect inSec.
    await addOverlayWithAutoNote(clipId, t, { inSec, durationSec: dur }, 'v2_from_io');
  });

  // Initialize IO readout
  syncSourceReadout();

  const syncSourceToTimeline = () => {
    const seg = store.state.segments[store.state.activeIndex];

    // If V1 timeline is empty, fall back to the first Bin clip.
    if (!seg) {
      if (pinnedBinClipId) return;
      const all = Array.isArray(store.state.clips) ? store.state.clips : [];
      const firstRef = all.find(c => String(c?.bin || '').toLowerCase() === 'ref') || null;
      const firstShot = all.find(c => String(c?.bin || '').toLowerCase() !== 'ref') || null;
      const first = firstRef || firstShot;
      if (!first) return;
      loadSourceClip({ clipId: first.id, name: first.name, url: first.url, startTC: first.startTC || '00:00:00:00', canPlay: first.canPlay !== false }, 0, { pin: false });
      return;
    }

    // If user pinned a specific clip in the bin, don't override.
    if (pinnedBinClipId && pinnedBinClipId !== seg.clipId) return;

    const gt = store.state.globalTimeSec || 0;
    const { localTimeSec } = store.globalToSegment(gt);
    loadSourceClip(seg, localTimeSec, { pin: false });
  };


  function syncClipsListActiveState() {
    const activeClipId = store.state.segments?.[store.state.activeIndex]?.clipId || null;
    try {
      root.querySelectorAll('.pfx-reviews-clipRow[data-clip-id]').forEach((row) => {
        row.classList.toggle('is-active', !!activeClipId && String(row.dataset.clipId || '') === String(activeClipId));
      });
    } catch {}
  }

  function refreshClipsList() {
    clipsBody.innerHTML = '';
    try { refBody.innerHTML = ''; } catch {}
    const allClips = Array.isArray(store.state.clips) ? store.state.clips : [];
    const tlIds = Array.isArray(store.state.timelineClipIds) ? store.state.timelineClipIds : [];
    const getBin = (c) => {
      const b = String(c?.bin || '').toLowerCase();
      if (b === 'ref' || b === 'v1') return 'ref';
      if (b === 'shots' || b === 'v2') return 'shots';
      // Legacy fallback: if edited into V1 timeline, treat as Ref.
      if (tlIds.includes(c?.id)) return 'ref';
      return 'shots';
    };
    const clipsRef = allClips.filter(c => getBin(c) === 'ref');
    const clipsShots = allClips.filter(c => getBin(c) === 'shots');
    const segs = store.state.segments; // V1 timeline segments (may be empty)
    try { __pfxSyncRefImportRows(); } catch {}
    try { appendHeaderMediaSummary(refHeaderMediaState, clipsRef); } catch {}
    try { appendHeaderMediaSummary(clipsHeaderMediaState, clipsShots); } catch {}

    if (!allClips.length) {
      refBody.append(el('div', 'pfx-reviews-empty', 'No refs yet. Add MP4/MOV to V1 (Ref). Then use Load TL for timeline cuts.'));
      clipsBody.append(el('div', 'pfx-reviews-empty', 'No shots yet. Add MP4/MOV (H.264).'));
      viewerHint.style.display = 'block';
      pinnedBinClipId = null;
      loadSourceClip(null);
      try { clipsCount.textContent = '0'; } catch {}
      return;
    }

    viewerHint.style.display = 'none';

    // If the currently loaded clip no longer belongs to this project's clip list (e.g. after
    // switching projects), reset the source viewer so the condition below can load the first
    // clip from the new project. Without this, `videoSrc.dataset.clipId` from the previous
    // project keeps the condition false and the new video ref never loads.
    const _curSrcId = String(videoSrc?.dataset?.clipId || '');
    if (_curSrcId && !allClips.some(c => String(c?.id || '') === _curSrcId)) {
      try { videoSrc.removeAttribute('src'); } catch {}
      try { delete videoSrc.dataset.clipId; } catch {}
      if (pinnedBinClipId === _curSrcId) pinnedBinClipId = null;
    }
    if (pinnedBinClipId && !allClips.some(c => String(c?.id || '') === pinnedBinClipId)) {
      pinnedBinClipId = null;
    }

    // Source viewer must remain independent from the Program (Timeline) viewer.
    // If nothing is loaded in Source yet, load the first available clip from the bins.
    if (!videoSrc?.dataset?.clipId && !pinnedBinClipId) {
      const firstRef = clipsRef[0] || null;
      const firstShot = clipsShots[0] || null;
      const first = firstRef || firstShot;
      if (first && first.url) {
        loadSourceClip({
          clipId: first.id,
          name: first.name,
          url: first.url,
          startTC: first.startTC || '00:00:00:00',
          canPlay: first.canPlay !== false,
        }, 0, { pin: false });
      }
    }

    // ===== Helpers: group shots + parse versions =====
    const stripExt = (n) => String(n || '').replace(/\.[^./\\]+$/, '');
    const parseVersionNum = (n) => {
      const s = stripExt(n);
      const m = s.match(/(?:^|[._-])(v|ver|version)\s*0*(\d+)$/i);
      if (!m) return 0;
      const v = parseInt(m[2], 10);
      return Number.isFinite(v) ? v : 0;
    };
    const parseShotKey = (n) => {
      const s = stripExt(n);
      // Remove trailing version token (_v01, -V002, .ver3, etc.)
      return s.replace(/(?:^|[._-])(v|ver|version)\s*0*\d+$/i, '');
    };

    // Total shots in the whole bin (for the count pill)
    const allShotCount = new Set(clipsShots.map(c => parseShotKey(c?.name))).size;

    // Filter + sort (smart compact bin)
    const q = String(clipsSearch.value || '').trim().toLowerCase();
    const sortKey = String(clipsSort.value || 'timeline');

    // Bin list is based on imported clips (not the V1 timeline).
    let list = clipsShots.slice();
    if (q) list = list.filter(c => String(c.name || '').toLowerCase().includes(q));

    if (sortKey === 'name_asc') {
      list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' }));
    } else if (sortKey === 'name_desc') {
      list.sort((a, b) => String(b.name || '').localeCompare(String(a.name || ''), undefined, { numeric: true, sensitivity: 'base' }));
    } else if (sortKey === 'recent') {
      list.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    } else {
      // timeline: clips that already exist in V1 come first (in first-occurrence order)
      const order = Array.isArray(store.state.timelineClipIds) ? store.state.timelineClipIds : [];
      const rank = (id) => {
        const i = order.indexOf(id);
        return i < 0 ? 1e9 : i;
      };
      list.sort((a, b) => {
        const ra = rank(a.id);
        const rb = rank(b.id);
        if (ra !== rb) return ra - rb;
        return String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' });
      });
    }

    // ===== Group by shot (collapsible versions) =====
    /** @type {Map<string, any[]>} */
    const groups = new Map();
    for (const c of list) {
      const g = parseShotKey(c?.name);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }

    const order = Array.isArray(store.state.timelineClipIds) ? store.state.timelineClipIds : [];
    const rank = (id) => {
      const i = order.indexOf(id);
      return i < 0 ? 1e9 : i;
    };

    const groupList = Array.from(groups.entries()).map(([key, items]) => {
      const sorted = items.slice().sort((a, b) => {
        const va = parseVersionNum(a?.name);
        const vb = parseVersionNum(b?.name);
        if (va !== vb) return vb - va; // latest version first
        const ra = Number(a?.createdAt) || 0;
        const rb = Number(b?.createdAt) || 0;
        if (ra !== rb) return rb - ra;
        return String(a?.name || '').localeCompare(String(b?.name || ''), undefined, { numeric: true, sensitivity: 'base' });
      });
      const latest = sorted[0];
      const groupRank = Math.min(...sorted.map(x => rank(x.id)));
      return { key, items: sorted, latest, groupRank };
    });

    if (sortKey === 'name_asc') {
      groupList.sort((a, b) => String(a.key).localeCompare(String(b.key), undefined, { numeric: true, sensitivity: 'base' }));
    } else if (sortKey === 'name_desc') {
      groupList.sort((a, b) => String(b.key).localeCompare(String(a.key), undefined, { numeric: true, sensitivity: 'base' }));
    } else if (sortKey === 'recent') {
      groupList.sort((a, b) => (Number(b.latest?.createdAt) || 0) - (Number(a.latest?.createdAt) || 0));
    } else {
      groupList.sort((a, b) => {
        if (a.groupRank !== b.groupRank) return a.groupRank - b.groupRank;
        return String(a.key).localeCompare(String(b.key), undefined, { numeric: true, sensitivity: 'base' });
      });
    }

    // Count readout: shots + clips
    try {
      const visShots = groupList.length;
      const visClips = list.length;
      const shotsText = q ? `${visShots}/${allShotCount}` : `${allShotCount}`;
      const clipsText = q ? `${visClips}/${clipsShots.length}` : `${clipsShots.length}`;
      clipsCount.textContent = `${shotsText} · ${clipsText}`;
    } catch {}

    if (!groupList.length) {
      clipsBody.append(el('div', 'pfx-reviews-empty', q ? 'No matching shots.' : 'No shots yet.'));
    }

    const activeClipId = store.state.segments?.[store.state.activeIndex]?.clipId || null;
    const segForClip = (c) => ({
      clipId: c.id,
      name: c.name,
      url: c.url,
      startTC: c.startTC || '00:00:00:00',
      canPlay: c.canPlay !== false,
    });

    // Snapshot for keyboard navigation (visible rows only)
    binVisibleIds = [];
    binClipToGroup = new Map();

    const makeRow = (clipObj, { groupKey = '', isGroup = false, badge = '', ver = 0, indent = false, mode = 'shots' } = {}) => {
      const s = segForClip(clipObj);
      const row = el('div', 'pfx-reviews-clipRow');
      row.dataset.clipId = s.clipId;
      row.tabIndex = 0;
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        try {
          e.dataTransfer.setData('text/pfx-clip-id', s.clipId);
          e.dataTransfer.effectAllowed = 'copy';
        } catch {}
      });
      if (!s.canPlay) row.classList.add('is-disabled');
      if (activeClipId && s.clipId === activeClipId) row.classList.add('is-active');
      if (s.clipId === pinnedBinClipId) row.classList.add('is-selected');
      try { if ((store.getSelectedV1Cut?.() || null)?.clipId === s.clipId) row.classList.add('is-cutSelected'); } catch {}
      if (isGroup) row.classList.add('is-group');
      if (indent) row.classList.add('is-version');
      row.dataset.groupKey = groupKey;

      const left = el('div', 'pfx-reviews-clipLeft');
      if (isGroup) {
        const open = binOpenGroups.has(groupKey);
        const arrow = el('div', 'pfx-reviews-groupArrow', open ? '▾' : '▸');
        arrow.title = open ? 'Collapse versions' : 'Expand versions';
        arrow.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleGroupOpen(groupKey);
        });
        left.appendChild(arrow);
      } else {
        left.appendChild(el('div', 'pfx-reviews-groupArrow pfx-reviews-groupArrow--spacer', ''));
      }

      const name = el('div', 'pfx-reviews-clipName', isGroup ? groupKey : s.name);
      left.appendChild(name);

      const right = el('div', 'pfx-reviews-clipRight');
      if (badge) right.appendChild(el('div', 'pfx-reviews-groupBadge', badge));
      if (ver > 0) right.appendChild(el('div', 'pfx-reviews-verBadge', `v${String(ver).padStart(2, '0')}`));
      if (!isGroup) {
        const cState = clipObj || null;
        appendClipMediaBadges(right, cState, { variant: 'compact', badgeClass: 'pfx-reviews-stateBadge' });
      }

      const meta = el('div', 'pfx-reviews-clipMeta');
      if (mode === 'ref') {
        const cutStats = (store.state?.v1CutStatsByClip && typeof store.state.v1CutStatsByClip === 'object') ? store.state.v1CutStatsByClip[s.clipId] : null;
        if (cutStats && Number(cutStats.segments) > 1) {
          const cutMeta = el('div', 'pfx-reviews-cutRowSummary');
          cutMeta.append(el('div', 'pfx-reviews-cutMiniBadge', `${Math.max(1, Number(cutStats.segments) || 1)} seg`));
          if (Number(cutStats.uncertain) > 0) cutMeta.append(el('div', 'pfx-reviews-cutMiniBadge is-uncertain', `${Math.max(0, Number(cutStats.uncertain) || 0)} unsure`));
          right.appendChild(cutMeta);
        }
      }

      const btnJump = el('button', 'pfx-reviews-miniBtn pfx-reviews-miniBtn--icon', '↗');
      btnJump.title = 'Load in Source / Jump to first timeline occurrence';
      btnJump.addEventListener('click', async (e) => {
        e.stopPropagation();
        const firstSeg = store.state.segments.find(x => x.clipId === s.clipId);
        if (firstSeg) {
          status.textContent = 'Jump…';
          await scrubTo(firstSeg.globalStartSec);
          timeline.jumpToTime(firstSeg.globalStartSec);
        } else {
          loadSourceClip(s, 0, { pin: true });
          refreshClipsList();
        }
      });

      // ProRes badge: show when codec is detected as ProRes
      if (clipObj?.codecHint === 'prores') {
        const proresBadge = el('div', 'pfx-reviews-proresBadge', 'ProRes');
        proresBadge.title = 'Apple ProRes — Chrome cannot play this codec. Convert to H.264 proxy first.';
        proresBadge.addEventListener('click', (e) => { e.stopPropagation(); try { __pfxShowProResWarning(clipObj.name || s.name || ''); } catch {} });
        right.appendChild(proresBadge);
      }

      // Manual relink: show when clip URL is missing/broken or only a stale blob URL after refresh.
      const _url = String(clipObj?.url || '');
      const needsRelink = (!clipObj?.file && _url.startsWith('blob:')) || (!_url) || (clipObj?.canPlay === false);
      const btnRelink = el('button', 'pfx-reviews-miniBtn pfx-reviews-miniBtn--icon', '⟲');
      btnRelink.title = 'Relink (pick file for this clip)';
      if (!needsRelink) btnRelink.style.display = 'none';
      btnRelink.addEventListener('click', (e) => {
        e.stopPropagation();
        try{ __pendingRelinkClipId = s.clipId; }catch(_){}
        try{ relinkInput.click(); }catch(_){}
      });

      const hasBurninOv = !!(clipObj?.burninOverride && clipObj.burninOverride.preset);
      const btnBurnin = el('button', 'pfx-reviews-miniBtn pfx-reviews-miniBtn--icon', '⌖');
      btnBurnin.title = hasBurninOv ? 'Burn-in Override (this clip)' : 'Burn-in Setup (override this clip)';
      if (hasBurninOv) btnBurnin.classList.add('is-burninOverride');
      btnBurnin.addEventListener('click', async (e) => {
        e.stopPropagation();
        try{
          setKeyFocus('bin');
          selectBinClipId(s.clipId, { pin: true, scroll: false });
        }catch{}
        try{ loadSourceClip(s, 0, { pin: true }); }catch{}
        try{
          await openBurninSetupModal({
            scope: 'clip',
            clip: { id: s.clipId, name: s.name },
            getOverride: () => {
              try{
                const c0 = store.state.clips.find(c => c.id === s.clipId);
                return c0?.burninOverride || null;
              }catch{ return null; }
            },
            applyOverride: async (ov) => {
              store.updateClip(s.clipId, { burninOverride: ov || null });
              try{ refreshClipsList(); }catch{}
            }
          });
        }catch(err){
          try{ status.textContent = err?.message || String(err); }catch{}
        }
      });

      const hasQc = !!(clipObj?.visualQc && Array.isArray(clipObj.visualQc.events) && clipObj.visualQc.events.length);
      const btnQC = el('button', 'pfx-reviews-miniBtn pfx-reviews-miniBtn--icon', 'QC');
      btnQC.title = hasQc ? 'Visual QC (view results / rescan)' : 'Visual QC (scan clip)';
      if (hasQc) btnQC.classList.add('is-qcReady');
      btnQC.addEventListener('click', async (e) => {
        e.stopPropagation();
        try{
          setKeyFocus('bin');
          selectBinClipId(s.clipId, { pin: true, scroll: false });
        }catch{}
        try{ loadSourceClip(s, 0, { pin: true }); }catch{}
        const __openQc = async () => {
          const freshClip = store.state.clips.find(c => c.id === s.clipId) || clipObj;
          await openVisualQcModal({
            clip: freshClip,
            store,
            jumpToSec: async (t)=>{
              try{ status.textContent = 'Jump…'; }catch{}
              await scrubTo(Math.max(0, Number(t) || 0));
              try{ timeline.jumpToTime(Math.max(0, Number(t) || 0)); }catch{}
            },
            onStatus: (msg)=>{ try{ status.textContent = String(msg||''); }catch{} }
          });
          try{ refreshClipsList(); }catch{}
        };
        try{
          const freshClip = store.state.clips.find(c => c.id === s.clipId) || clipObj;
          if (!freshClip.url || !freshClip.file){
            try{ status.textContent = 'File not linked — pick file to relink and open QC…'; }catch{}
            __qcAfterRelinkFn = __openQc;
            __pendingRelinkClipId = s.clipId;
            try{ relinkInput.click(); }catch{}
            return;
          }
          await __openQc();
        }catch(err){
          try{ status.textContent = err?.message || String(err); }catch{}
        }
      });

      const btnV1 = el('button', 'pfx-reviews-miniBtn pfx-reviews-miniBtn--icon', '1');
      btnV1.title = 'Add to V1 Timeline (append)';
      btnV1.addEventListener('click', async (e) => {
        e.stopPropagation();
        store.appendToTimeline(s.clipId);
        const last = store.state.segments[store.state.segments.length - 1];
        if (last) {
          await player.loadAtGlobalTime(last.globalStartSec, { autoplay: false });
          timeline.jumpToTime(last.globalStartSec);
        }
      });

      const btnV2 = el('button', 'pfx-reviews-miniBtn pfx-reviews-miniBtn--icon', '2');
      btnV2.title = 'Add as V2 Overlay at Playhead (V2 is always muted)';
      btnV2.addEventListener('click', async (e) => {
        e.stopPropagation();
        const t = Math.max(0, Number(store.state.globalTimeSec) || 0);
        await addOverlayWithAutoNote(s.clipId, t, {}, 'v2_add');
      });

      const btnRemove = el('button', 'pfx-reviews-miniBtn pfx-reviews-miniBtn--icon', '✕');
      btnRemove.title = 'Remove clip';
      btnRemove.addEventListener('click', (e) => {
        e.stopPropagation();
        store.removeClip(s.clipId);
      });

      if (mode === 'ref') meta.append(btnJump, btnRelink, btnBurnin, btnQC, btnV1, btnRemove);
      else if (mode === 'shots') meta.append(btnJump, btnRelink, btnBurnin, btnQC, btnV2, btnRemove);
      else meta.append(btnJump, btnRelink, btnBurnin, btnQC, btnV1, btnV2, btnRemove);
      right.appendChild(meta);

      row.append(left, right);

      // Hover preview (smart): update Source viewer without pinning
      row.addEventListener('mouseenter', () => {
        if (pinnedBinClipId) return;
        loadSourceClip(s, 0, { pin: false });
      });

      // Click behavior differs per bin:
      //  - Ref (V1): click appends to V1 timeline
      //  - Shots (V2): click ONLY previews in Source viewer (no add)
      //     * Double‑click adds into V2 overlay at playhead
      // Use ⌥/Alt or ⌘/Ctrl to only select without any action.
      row.addEventListener('click', async (e) => {
        if (e.target?.closest?.('button')) return;
        setKeyFocus('bin');
        const onlySelect = !!(e.altKey || e.metaKey || e.ctrlKey);
        selectBinClipId(s.clipId, { pin: true, scroll: false });
        if (onlySelect) return;
        if (mode === 'ref') {
          store.appendToTimeline(s.clipId);
          const last = store.state.segments[store.state.segments.length - 1];
          if (last) {
            try { await player.loadAtGlobalTime(last.globalStartSec, { autoplay: false }); } catch {}
            try { timeline.jumpToTime(last.globalStartSec); } catch {}
          }
        } else if (mode === 'shots') {
          // Single click = preview in Source view (pin)
          try { loadSourceClip(s, 0, { pin: true }); } catch {}
          try { refreshClipsList(); } catch {}
        }
      });

      row.addEventListener('dblclick', (e) => {
        if (e.target?.closest?.('button')) return;
        // Group row: expand/collapse versions
        if (isGroup) {
          toggleGroupOpen(groupKey);
          return;
        }
        // Shot/version row: double click adds into V2 overlay at playhead
        if (mode === 'shots') {
          try {
            const t0 = Math.max(0, Number(store.state.globalTimeSec) || 0);
            addOverlayWithAutoNote(s.clipId, t0, {}, 'v2_add');
          } catch {}
        }
      });

      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          setKeyFocus('bin');
          selectBinClipId(s.clipId, { pin: true, scroll: false });
        }
      });

      // Track for keyboard navigation + group actions
      binVisibleIds.push(s.clipId);
      if (groupKey) binClipToGroup.set(s.clipId, groupKey);

      return row;
    };

    // ===== V1 (Ref) bin: show ONLY Ref clips (separate from Shots) =====
    try { refBody.innerHTML = ''; } catch {}
    const refList = clipsRef.slice().sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), undefined, { numeric: true, sensitivity: 'base' }));
    if (!refList.length) {
      try { refBody.append(el('div', 'pfx-reviews-empty', 'No refs yet.')); } catch {}
    } else {
      for (const c of refList) {
        const groupKey = parseShotKey(c?.name);
        const verLatest = parseVersionNum(c?.name);
        refBody.appendChild(makeRow(c, { groupKey, isGroup: false, badge: '', ver: verLatest, mode: 'ref' }));
      }
    }

    // ===== V2 (Shots) bin: groups + versions (existing behavior) =====
    for (const g of groupList) {
      const groupKey = String(g.key);
      const items = g.items;
      const latest = g.latest;
      if (!latest) continue;

      const verLatest = parseVersionNum(latest?.name);
      const badge = items.length > 1 ? `×${items.length}` : '';
      clipsBody.appendChild(makeRow(latest, { groupKey, isGroup: true, badge, ver: verLatest, mode: 'shots' }));

      if (items.length > 1 && binOpenGroups.has(groupKey)) {
        // Show versions (excluding latest) in compact indented rows
        for (const v of items) {
          if (v.id === latest.id) continue;
          const ver = parseVersionNum(v?.name);
          clipsBody.appendChild(makeRow(v, { groupKey, isGroup: false, badge: '', ver, indent: true, mode: 'shots' }));
        }
      }
    }
  }

  // Smart bin controls
  clipsSearch.addEventListener('input', () => refreshClipsList());
  clipsSort.addEventListener('change', () => refreshClipsList());
  clipsSearch.addEventListener('keydown', (e) => {
    // Quick keyboard navigation while searching
    if (e.key === 'Escape') {
      clipsSearch.value = '';
      clipsSearch.blur();
      refreshClipsList();
    }
  });

  // ===== Thumbnails + Annotate =====
  const captureProgramThumb = () => {
    try {
      // Composite what the user sees in the program viewer (V1 + optional V2 overlay)
      const base = player?.active || null;
      if (!base || !base.videoWidth || !base.videoHeight) return null;
      const w0 = base.videoWidth;
      const h0 = base.videoHeight;
      // Keep thumbs light: downscale + JPEG (better persistence + faster UI).
      const MAX_W = 520;
      const MAX_H = 520;
      const s = Math.min(1, MAX_W / w0, MAX_H / h0);
      const w = Math.max(2, Math.round(w0 * s));
      const h = Math.max(2, Math.round(h0 * s));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(base, 0, 0, w, h);

      const pb = store.getPlaybackAtTime(store.state.globalTimeSec || 0);
      const ovlActive = pb?.layer === 'V2';
      if (ovlActive && videoV2 && videoV2.videoWidth && videoV2.videoHeight) {
        // Draw overlay on top (same frame size assumptions)
        try { ctx.drawImage(videoV2, 0, 0, w, h); } catch {}
      }
      return canvas.toDataURL('image/jpeg', 0.86);
    } catch {
      return null;
    }
  };


  const captureVideoThumb = (vid) => {
    try {
      if (!vid || !vid.videoWidth || !vid.videoHeight) return null;
      const w0 = vid.videoWidth;
      const h0 = vid.videoHeight;
      const MAX_W = 520;
      const MAX_H = 520;
      const s = Math.min(1, MAX_W / w0, MAX_H / h0);
      const w = Math.max(2, Math.round(w0 * s));
      const h = Math.max(2, Math.round(h0 * s));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(vid, 0, 0, w, h);
      return canvas.toDataURL('image/jpeg', 0.86);
    } catch {
      return null;
    }
  };

  const waitForVideoReady = (vid, timeoutMs = 450) => new Promise((resolve) => {
    try {
      if (!vid) return resolve(false);
      const start = _nowMs();
      const tick = () => {
        const ok = (vid.readyState || 0) >= 2 && (vid.videoWidth || 0) > 0 && (vid.videoHeight || 0) > 0 && !vid.seeking;
        if (ok) return resolve(true);
        if ((_nowMs() - start) > timeoutMs) return resolve(false);
        requestAnimationFrame(tick);
      };
      tick();
    } catch {
      resolve(false);
    }
  });

  const waitForVideoFrame = (vid, timeoutMs = 250) => new Promise((resolve) => {
    try {
      if (!vid) return resolve(false);
      const fn = vid.requestVideoFrameCallback;
      if (typeof fn !== 'function') return resolve(true);
      let done = false;
      const to = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(false);
      }, timeoutMs);
      fn.call(vid, () => {
        if (done) return;
        done = true;
        clearTimeout(to);
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });

  // Capture thumbnail from V2 overlay ONLY and update the marker when ready.
  // IMPORTANT: We must capture deterministically per-marker. Using the shared V2 overlay video
  // element can race when users add/mark multiple shots quickly, causing the wrong note/event
  // to receive another clip's thumbnail. We therefore capture via a dedicated hidden video + queue.
  let __thumbCapDestroyed = false;
  let __thumbCapRunning = false;
  let __thumbCapQueue = [];
  let __thumbCapVid = null;

  const ensureThumbCapVideo = () => {
    if (__thumbCapVid) return __thumbCapVid;
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.controls = false;
    // Keep it off-screen but not display:none (some browsers won't decode frames when hidden).
    v.style.position = 'fixed';
    v.style.left = '-10000px';
    v.style.top = '0';
    v.style.width = '2px';
    v.style.height = '2px';
    v.style.opacity = '0';
    v.style.pointerEvents = 'none';
    try { document.body.appendChild(v); } catch {}
    __thumbCapVid = v;
    return v;
  };

  const waitForMetadata = (vid, timeoutMs = 1200) => new Promise((resolve) => {
    try {
      if (!vid) return resolve(false);
      if ((vid.readyState || 0) >= 1) return resolve(true);

      const onMeta = () => { cleanup(); resolve(true); };
      const onErr = () => { cleanup(); resolve(false); };
      const to = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
      const cleanup = () => {
        clearTimeout(to);
        try { vid.removeEventListener('loadedmetadata', onMeta); } catch {}
        try { vid.removeEventListener('error', onErr); } catch {}
      };

      vid.addEventListener('loadedmetadata', onMeta);
      vid.addEventListener('error', onErr);
    } catch {
      resolve(false);
    }
  });

  const seekVideo = (vid, tSec, timeoutMs = 1200) => new Promise((resolve) => {
    try {
      if (!vid) return resolve(false);
      const t = Math.max(0, Number(tSec) || 0);
      const cur = Number(vid.currentTime) || 0;
      if (!vid.seeking && Math.abs(cur - t) < 0.001 && (vid.readyState || 0) >= 2) return resolve(true);

      const onSeek = () => { cleanup(); resolve(true); };
      const onErr = () => { cleanup(); resolve(false); };
      const to = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
      const cleanup = () => {
        clearTimeout(to);
        try { vid.removeEventListener('seeked', onSeek); } catch {}
        try { vid.removeEventListener('error', onErr); } catch {}
      };

      vid.addEventListener('seeked', onSeek, { once: true });
      vid.addEventListener('error', onErr, { once: true });
      try { vid.currentTime = t; } catch { cleanup(); resolve(false); }
    } catch {
      resolve(false);
    }
  });

  const runThumbQueue = async () => {
    if (__thumbCapRunning) return;
    __thumbCapRunning = true;

    try {
    while (!__thumbCapDestroyed && (__thumbCapQueue?.length || 0) > 0) {
      const req = __thumbCapQueue.shift();
      const markerId = req?.markerId;
      if (!markerId) continue;

      // Marker might have been removed
      const m0 = store.state.markers?.find(x => x.id === markerId);
      if (!m0) continue;

      // Don't override user-annotated thumbs.
      if (m0.thumbAnnotated) continue;

      // V2-only capture.
      if (String(m0.layer || '') !== 'V2') continue;

      // Resolve clip URL + local time deterministically from marker data (avoids race).
      let url = '';
      let want = Math.max(0, Number(m0.localTimeSec) || 0);
      try {
        const c = store.state.clips?.find(c => c.id === m0.clipId);
        url = c?.url || '';
      } catch {}

      // Fallback: if clip missing, try playback-at-time lookup.
      if (!url) {
        try {
          const pb = store.getPlaybackAtTime(Number(m0.globalTimeSec) || 0);
          if (pb?.layer === 'V2') {
            url = pb?.seg?.url || '';
            want = Math.max(0, Number(pb?.localTimeSec) || want);
          }
        } catch {}
      }

      if (!url) continue;

      const vid = ensureThumbCapVideo();
      if (!vid) continue;

      try {
        // Load URL if needed
        if (vid.src !== url) {
          try { vid.pause(); } catch {}
          try { vid.removeAttribute('src'); } catch {}
          try { vid.load(); } catch {}
          vid.src = url;
          try { vid.load(); } catch {}
          await waitForMetadata(vid, 1600);
        }

        // Clamp seek target if duration known
        try {
          const dur = Number(vid.duration);
          if (Number.isFinite(dur) && dur > 0) {
            want = Math.min(want, Math.max(0, dur - 0.001));
          }
        } catch {}

        await seekVideo(vid, want, 1800);
        await waitForVideoReady(vid, 900);
        await waitForVideoFrame(vid, 350);

        const thumb = captureVideoThumb(vid);
        if (thumb) {
          // Ensure marker still exists and hasn't been annotated since enqueue.
          const m1 = store.state.markers?.find(x => x.id === markerId);
          if (m1 && !m1.thumbAnnotated) {
            store.updateMarker(markerId, { thumbDataUrl: thumb });
          }
        }
      } catch {}
    }
    } finally {
      // Guarantee reset even if an uncaught exception exits the while body early
      // (e.g. ensureThumbCapVideo() throws). Without this, __thumbCapRunning stays
      // true permanently and every future captureV2ThumbAsync call is a no-op.
      __thumbCapRunning = false;
    }
  };

  // Public helper: enqueue V2 thumbnail capture (signature kept for existing call-sites).
  const captureV2ThumbAsync = (markerId, _globalSec) => {
    if (!markerId) return;
    // Dedup: keep newest request per markerId
    __thumbCapQueue = (__thumbCapQueue || []).filter(r => r?.markerId !== markerId);
    __thumbCapQueue.push({ markerId });
    try { runThumbQueue(); } catch {}
  };




  const __pfxParseSowList = (s)=>{
    const raw = String(s||'').replace(/\r/g,'\n');
    const parts = raw.split(/[\n,;]+/).map(v=>String(v||'').trim()).filter(Boolean);
    const out=[];
    const seen=new Set();
    for (const v of parts){
      const k=v.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(v);
    }
    return out;
  };
  const __pfxJoinSow = (list, fallback='')=>{
    const arr = Array.isArray(list)?list.filter(Boolean).map(v=>String(v).trim()).filter(Boolean):[];
    return arr.length ? arr.join('; ') : String(fallback||'').trim();
  };

  const openAnnotateModal = (markerId, opts = {}) => {
    const m = store.state.markers.find(x => x.id === markerId);
    if (!m) return;

    const src = m.thumbBaseDataUrl || m.thumbDataUrl || null;
    if (!src) return;

    openPfxAnnotateModal({
      srcDataUrl: src,
      initialShapes: Array.isArray(m.annoShapes) ? m.annoShapes : [],
      title: (m.shotName || m.name || m.tc || ''),
      initialTool: (opts && opts.tool) ? String(opts.tool) : 'pen',
      noteTypeGroup: m.noteTypeGroup || '',
      noteType: m.noteType || '',
      scopeOfWork: m.scopeOfWork || '',
      noteText: m.note || '',
      onMetaChange: (meta)=>{
        try{
          const cur = store.state.markers.find(x => x.id === markerId) || m;
          const sowList = Array.isArray(meta?.sowList) ? meta.sowList : __pfxParseSowList(meta?.sow);
          const sow = __pfxJoinSow(sowList, meta?.sow);
          let note = (typeof meta?.note === 'string') ? String(meta.note) : '';
          // Reviews uses a single field in the editor (Note / Scope of Work).
          // If the user only sets Scope of Work in Annotate, mirror it into the note field
          // when the current note is empty.
          if (!note.trim() && (!String(cur?.note || '').trim()) && sow.trim()) note = sow;

          store.updateMarker(markerId, {
            noteTypeGroup: meta.g || '',
            noteType: meta.t || '',
            scopeOfWorkList: sowList,
            scopeOfWork: sow,
            note: note
          });

          // If the edited marker is selected, update UI immediately.
          try{
            if (store.state.selectedMarkerId === markerId){
              markerNote.value = note || '';
              const g = String(meta.g || '').toLowerCase();
              const t = String(meta.t || '').trim();
              noteTypeSel.value = (g && t) ? `${g}|${t}` : '';
            }
          }catch{}
        }catch{}
      },
      onDone: ({ meta, thumbBaseDataUrl, thumbAnnoDataUrl, thumbDataUrl, shapes })=>{
        try{
          const baseList = Array.isArray(meta?.sowList) ? meta.sowList : __pfxParseSowList(meta?.sow);
          const all=[]; const seen=new Set();
          const add=(v)=>{ const s=String(v||'').trim(); if(!s) return; const k=s.toLowerCase(); if(seen.has(k)) return; seen.add(k); all.push(s); };
          baseList.forEach(add);
          (Array.isArray(shapes)?shapes:[]).forEach(o=>{
            try{
              const sl = Array.isArray(o?.meta?.sowList) ? o.meta.sowList : __pfxParseSowList(o?.meta?.sow);
              sl.forEach(add);
            }catch{}
          });
          const sowList = all.length ? all : baseList;
          const sow = __pfxJoinSow(sowList, meta?.sow);
          let note = (typeof meta?.note === 'string') ? String(meta.note) : '';
          if (!note.trim() && (!String(m.note || '').trim()) && sow.trim()) note = sow;

          store.updateMarker(markerId, {
            noteTypeGroup: meta?.g || '',
            noteType: meta?.t || '',
            scopeOfWorkList: sowList,
            scopeOfWork: sow,
            note: note || (m.note || ''),
            thumbBaseDataUrl,
            thumbAnnoDataUrl,
            thumbDataUrl,
            annoShapes: Array.isArray(shapes) ? shapes : (m.annoShapes || []),
            thumbAnnotated: true,
          });
          refreshMarkersList();
        }catch{}
      }
    });
  };

  // ===== Right-click floating tools (Spot On style) =====
  // - Right-click on Program Viewer / Source Viewer / Timeline to pop a radial tool menu near the cursor.
  // - Shift+Right-click keeps the browser context menu.

  let __pfxCtxTools = null;

  const __rvEnsureMarkerWithThumb = () => {
    // Ensure a marker exists at the current playhead position.
    // If a marker already exists at this exact frame (and clip), reuse it.
    // Otherwise create a new one at playhead.

    let m = null;
    const fps = Number(store?.state?.fps) || 24;
    const globalSec = Number(store?.state?.globalTimeSec) || 0;
    const curFrame = Math.round(globalSec * fps);

    let curClipId = null;
    try{
      const pb = store.getPlaybackAtTime(globalSec);
      curClipId = pb?.seg?.clipId || null;
    }catch{}

    // Reuse existing marker at playhead if present
    try{
      const list = store?.state?.markers || [];
      m = list.find(x => (Math.round(Number(x?.globalFrame || 0)) === curFrame) && (!curClipId || x?.clipId === curClipId)) || null;
      if (m) {
        try { store.selectMarker(m.id); } catch {}
      }
    }catch{}

    // Otherwise create a new marker at playhead
    if (!m){
      try { m = store.addMarker({ note: '' }); } catch {}
    }
    if (!m) return null;

    // Ensure a frame exists for annotate (use what user sees in Program)
    try {
      const cur = store.state.markers?.find(x => x.id === m.id) || m;
      if (!cur.thumbDataUrl) {
        const thumb = captureProgramThumb();
        if (thumb) store.updateMarker(m.id, { thumbDataUrl: thumb, thumbAnnotated: false });
      }
    } catch {}

    try { setNotesOpen(true); } catch {}
    try { refreshMarkersList(); } catch {}
    return store.state.markers?.find(x => x.id === m.id) || m;
  };

  const __rvDoAddNote = () => {
    __rvEnsureMarkerWithThumb();
    try { markerNote?.focus?.(); } catch {}
  };

  // If the thumbnail isn't ready yet, wait briefly for a usable video frame, then capture.
  const __rvTryCaptureProgramThumbAsync = async () => {
    let thumb = null;
    try { thumb = captureProgramThumb(); } catch {}
    if (thumb) return thumb;

    const base = (player && player.active) ? player.active : null;
    try { await waitForVideoReady(base, 900); } catch {}
    try { await waitForVideoFrame(base, 350); } catch {}

    // If V2 is the active playback layer at this time, try to ensure its frame is ready too.
    try {
      const pb = store.getPlaybackAtTime(store.state.globalTimeSec || 0);
      if (pb && pb.layer === 'V2') {
        try { await waitForVideoReady(videoV2, 900); } catch {}
        try { await waitForVideoFrame(videoV2, 350); } catch {}
      }
    } catch {}

    try { thumb = captureProgramThumb(); } catch {}
    if (thumb) return thumb;

    // Fallback: base-only capture
    try { thumb = captureVideoThumb(base); } catch {}
    return thumb || null;
  };

  const __rvEnsureMarkerWithThumbAsync = async () => {
    const m0 = __rvEnsureMarkerWithThumb();
    if (!m0) return null;

    let m = null;
    try { m = (store.state.markers || []).find(x => x.id === m0.id) || m0; } catch { m = m0; }

    if (!m.thumbDataUrl) {
      const thumb = await __rvTryCaptureProgramThumbAsync();
      if (thumb) {
        try { store.updateMarker(m.id, { thumbDataUrl: thumb, thumbAnnotated: false }); } catch {}
        try { m = (store.state.markers || []).find(x => x.id === m.id) || m; } catch {}
      }
    }
    return m;
  };

  const __rvDoAnnotate = async (tool) => {
    const m = await __rvEnsureMarkerWithThumbAsync();
    if (!m || !m.thumbDataUrl) return;
    try { openAnnotateModal(m.id, { tool }); } catch {}
  };

  const __rvDoFit = () => {
    try { zoomFit?.(); } catch {}
    try { timeline?.jumpToTime?.(store.state.globalTimeSec); } catch {}
  };

  const __rvDoPlay = () => { try { player.toggle(); } catch {} };

  const __rvDoFull = () => {
    Promise.resolve((async () => {
      try { await toggleFullscreen(); } catch {}
      try { timeline.jumpToTime(store.state.globalTimeSec); } catch {}
    })()).catch(()=>{});
  };

  const __rvDoQcAtPlayhead = async () => {
    // Quick Visual QC around the current playhead position (small window)
    try { player.pause?.(); } catch {}
    let gt = Math.max(0, Number(store.state.globalTimeSec) || 0);
    let map = null;
    let segIdx = store.state.activeIndex ?? 0;
    let localT = 0;
    try { map = store.globalToSegment(gt); } catch {}
    try {
      if (map && typeof map === 'object') {
        if (Number.isFinite(Number(map.index))) segIdx = Number(map.index);
        localT = Math.max(0, Number(map.localTimeSec) || 0);
      }
    } catch {}

    // Prefer active V1 segment under playhead; fallback to pinned source clip.
    let clipId = null;
    try { clipId = store.state.segments?.[segIdx]?.clipId || null; } catch {}
    if (!clipId) {
      try { clipId = pinnedBinClipId || null; } catch {}
      try { localT = Math.max(0, Number(videoSrc?.currentTime) || 0); } catch {}
    }
    const clip = clipId ? (store.state.clips || []).find(c => c && c.id === clipId) : null;
    if (!clip) {
      try { status.textContent = 'No active clip to QC.'; } catch {}
      return;
    }
    // Snapshot localT now so the QC window is centred on the current playhead
    // even if the user waits a moment before picking the file.
    const capturedLocalT = localT;
    const capturedSegIdx = segIdx;

    const __openPlayheadQc = async () => {
      const freshClip = (store.state.clips || []).find(c => c && c.id === clipId) || clip;
      const win = 1.2;
      const rangeSec = {
        start: Math.max(0, capturedLocalT - win * 0.5),
        end: Math.max(0, capturedLocalT + win * 0.5),
      };
      const jumpLocalToGlobal = async (tLocal) => {
        const t = Math.max(0, Number(tLocal) || 0);
        if (!store?.state?.segments || !store.state.segments.length) {
          try { videoSrc.currentTime = t; } catch {}
          return;
        }
        let g = t;
        try {
          if (store && typeof store.segmentToGlobal === 'function') {
            g = store.segmentToGlobal(capturedSegIdx, t);
          }
        } catch {}
        try { await scrubTo(g); } catch {}
        try { timeline?.jumpToTime?.(g); } catch {}
      };
      await openVisualQcModal({
        clip: freshClip,
        store,
        rangeSec,
        autoRun: true,
        initialMode: 'dense',
        jumpToSec: jumpLocalToGlobal,
        onStatus: (msg) => { try { status.textContent = String(msg || ''); } catch {} },
      });
      try { refreshClipsList(); } catch {}
    };

    if (!clip.url || !clip.file) {
      try { status.textContent = 'File not linked — pick file to relink and open QC…'; } catch {}
      __qcAfterRelinkFn = __openPlayheadQc;
      __pendingRelinkClipId = clipId;
      try { relinkInput.click(); } catch {}
      return;
    }

    try {
      await __openPlayheadQc();
    } catch (err) {
      try { status.textContent = err?.message || String(err); } catch {}
    }
  };


  __pfxCtxTools = createRadialMenu({
    ariaLabel: 'Review quick tools',
    radius: 70,
    pad: 110,
    getHost: () => (document.fullscreenElement || document.webkitFullscreenElement || document.body),
    actions: [
      { id: 'note',   title: 'Add Note (marker) at current frame', icon: RadialIcons.note,   onSelect: async()=>{ __rvDoAddNote(); } },
      { id: 'qc',     title: 'QC at Playhead (Visible Crew/Equipment [096] + Framing Error)', icon: RadialIcons.qc,     onSelect: async()=>{ await __rvDoQcAtPlayhead(); }, isEnabled: ()=>{ try{ return !!((store.state.segments && store.state.segments.length) || pinnedBinClipId); }catch{ return true; } } },
      { id: 'pen',    title: 'Annotate: Pen',                      icon: RadialIcons.pen,    onSelect: async()=>{ await __rvDoAnnotate('pen'); } },
      { id: 'arrow',  title: 'Annotate: Arrow',                    icon: RadialIcons.arrow,  onSelect: async()=>{ await __rvDoAnnotate('arrow'); } },
      { id: 'circle', title: 'Annotate: Circle',                   icon: RadialIcons.circle, onSelect: async()=>{ await __rvDoAnnotate('circle'); } },
      { id: 'rect',   title: 'Annotate: Square / Rectangle',       icon: RadialIcons.rect,   onSelect: async()=>{ await __rvDoAnnotate('rect'); } },
      { id: 'text',   title: 'Annotate: Text',                     icon: RadialIcons.text,   onSelect: async()=>{ await __rvDoAnnotate('text'); } },
      { id: 'play',   title: 'Play / Pause',                       icon: () => (store.state.isPlaying ? RadialIcons.pause : RadialIcons.play), onSelect: async()=>{ __rvDoPlay(); } },
      { id: 'fit',    title: 'Fit Viewer',                         icon: RadialIcons.fit,    onSelect: async()=>{ __rvDoFit(); } },
      { id: 'full',   title: 'Fullscreen',                         icon: RadialIcons.full,   onSelect: async()=>{ __rvDoFull(); } },
    ],
  });

  // Robust target/path helpers (timeline can produce Text nodes as targets, especially on macOS/trackpads)
const __rvEvtPath = (e) => {
  try { return (e && typeof e.composedPath === 'function') ? (e.composedPath() || []) : []; } catch { return []; }
};
const __rvPathHas = (path, cls) => {
  try {
    for (const n of (path || [])) {
      if (n && n.classList && n.classList.contains(cls)) return true;
    }
  } catch {}
  return false;
};
const __rvCtxEventOk = (e) => {
  const path = __rvEvtPath(e);

  // Preferred: composedPath (works even when target is a Text node)
  if (path && path.length) {
    // Root container class in Reviews is `pfx-reviews` (older builds may have used `pfx-reviews-root`).
    if (!(__rvPathHas(path, 'pfx-reviews') || __rvPathHas(path, 'pfx-reviews-root'))) return false;
    if (__rvPathHas(path, 'sm-anno-modal')) return false;
    // Let the timeline version picker keep its own right-click menu.
    if (__rvPathHas(path, 'pfx-reviews-segVer') || __rvPathHas(path, 'pfx-reviews-verMenu')) return false;
    return (
      __rvPathHas(path, 'pfx-reviews-viewer') ||
      __rvPathHas(path, 'pfx-reviews-timelineWrap') ||
      __rvPathHas(path, 'pfx-reviews-sourceViewer') ||
      __rvPathHas(path, 'pfx-reviews-timeline')
    );
  }

  // Fallback: element target
  try {
    let t = e?.target || null;
    if (t && t.nodeType === 3) t = t.parentElement; // Text node
    if (!t || !t.closest) return false;
    if (!(t.closest('.pfx-reviews') || t.closest('.pfx-reviews-root'))) return false;
    if (t.closest('.sm-anno-modal')) return false;
    if (t.closest('.pfx-reviews-segVer') || t.closest('.pfx-reviews-verMenu')) return false;
    return !!(
      t.closest('.pfx-reviews-viewer') ||
      t.closest('.pfx-reviews-timelineWrap') ||
      t.closest('.pfx-reviews-sourceViewer') ||
      t.closest('.pfx-reviews-timeline')
    );
  } catch {
    return false;
  }
};

const onViewerContextTools = (e) => {
  if (!e) return;
  if (e.shiftKey) return;

  // If pointerdown already opened the menu, suppress the follow-up native context menu.
  try {
    const now = (performance && performance.now) ? performance.now() : Date.now();
    if (__rvCtxJustOpenedAt && (now - __rvCtxJustOpenedAt) < 350) {
      if (e.cancelable) e.preventDefault();
      try { e.stopPropagation(); } catch {}
      return;
    }
  } catch {}

  if (!__rvCtxEventOk(e)) return;

  try { if (e.cancelable) e.preventDefault(); } catch {}
  try { e.stopPropagation(); } catch {}
  try { __pfxCtxTools.openAt(e.clientX, e.clientY); } catch {}
};

try { document.addEventListener('contextmenu', onViewerContextTools, true); } catch {}
  try { window.addEventListener('contextmenu', onViewerContextTools, true); } catch {}
  try { document.documentElement?.addEventListener?.('contextmenu', onViewerContextTools, true); } catch {}  try { viewer.addEventListener('contextmenu', onViewerContextTools, true); } catch {}
  try { videoA.addEventListener('contextmenu', onViewerContextTools, true); } catch {}
  try { videoB.addEventListener('contextmenu', onViewerContextTools, true); } catch {}
  try { videoV2.addEventListener('contextmenu', onViewerContextTools, true); } catch {}
  try { sourceViewer.addEventListener('contextmenu', onViewerContextTools, true); } catch {}
  try { timelineWrap?.addEventListener?.('contextmenu', onViewerContextTools, true); } catch {}

  // Also support right-click flows that may not emit a reliable 'contextmenu' event on the timeline
  // (e.g. some trackpads / ctrl-click variations). We open the radial menu on pointerdown for:
  // - Right click (button=2)
  // - Ctrl+left click (button=0 + ctrlKey) on macOS
  // Only inside Reviews viewer/timeline, and we avoid stealing the V2 version picker menu.
  let __rvCtxJustOpenedAt = 0;
// Back-compat helper: some callers still pass target only.
// NOTE: Target-only checks can miss Text nodes; __rvCtxEventOk(e) is the primary gate.
const __rvCtxTargetOk = (target) => {
  try {
    const e = { target };
    return __rvCtxEventOk(e);
  } catch {
    return false;
  }
};

  const onViewerContextToolsPointer = (e) => {
    if (e.shiftKey) return;
    const isRight = (e.button === 2);
    const isCtrlClick = (e.button === 0 && !!e.ctrlKey && !e.metaKey);
    if (!isRight && !isCtrlClick) return;
    if (!__rvCtxEventOk(e)) return;

    // Avoid double-open when both pointerdown + contextmenu fire.
    try { __rvCtxJustOpenedAt = (performance && performance.now) ? performance.now() : Date.now(); } catch { __rvCtxJustOpenedAt = Date.now(); }

    try { if (e.cancelable) e.preventDefault(); } catch {}
    try { e.stopPropagation(); } catch {}
    try { __pfxCtxTools.openAt(e.clientX, e.clientY); } catch {}
  };

  try { document.addEventListener('pointerdown', onViewerContextToolsPointer, true); } catch {}
  try { window.addEventListener('pointerdown', onViewerContextToolsPointer, true); } catch {}


  const setSelectedMarkerStatus = (status) => {
    const sel = store.getSelectedMarker();
    if (!sel) return;
    store.updateMarker(sel.id, { status });
    refreshMarkersList();
  };

  // Notes list: right‑click context menu (Delete)
  let __pfxMarkerCtxMenuEl = null;
  let __pfxMarkerCtxMarkerId = null;
  let __pfxMarkerCtxOnDocDown = null;
  let __pfxMarkerCtxOnKeyDown = null;
  let __pfxMarkerCtxJustOpenedAt = 0;

  const __pfxMarkerCtxClose = () => {
    try {
      if (!__pfxMarkerCtxMenuEl) return;
      __pfxMarkerCtxMenuEl.classList.remove('is-open');
      __pfxMarkerCtxMenuEl.style.left = '-9999px';
      __pfxMarkerCtxMenuEl.style.top = '-9999px';
      __pfxMarkerCtxMarkerId = null;
    } catch {}
  };

  const __pfxMarkerCtxEnsure = () => {
    if (__pfxMarkerCtxMenuEl) return;
    const menu = el('div', 'pfx-markerCtxMenu');
    menu.style.left = '-9999px';
    menu.style.top = '-9999px';

    const btnEditAnnotate = el('button', 'pfx-markerCtxItem', 'Edit Annotate');
    btnEditAnnotate.type = 'button';
    btnEditAnnotate.addEventListener('click', () => {
      const id = __pfxMarkerCtxMarkerId;
      if (!id) return;
      Promise.resolve((async () => {
        try { await selectNoteId(id, { jump: false, scroll: false }); } catch {}
        try {
          const thumb = await __pfxEnsureMarkerThumbLoaded(id);
          if (!thumb) return;
          openAnnotateModal(id);
        } catch {}
      })()).finally(() => { __pfxMarkerCtxClose(); });
    });

    const btnDelete = el('button', 'pfx-markerCtxItem pfx-markerCtxItem--danger', 'Remove');
    btnDelete.type = 'button';
    btnDelete.addEventListener('click', () => {
      const id = __pfxMarkerCtxMarkerId;
      if (!id) return;
      // Best-effort: delete persisted thumbs for this note to avoid orphaned blobs.
      try{
        const m0 = (store?.state?.markers || []).find(x => String(x?.id||'') === String(id));
        const keys = [m0?.thumbKey, m0?.thumbBaseKey, m0?.thumbAnnoKey].filter(Boolean);
        try {
          const byClip = (m0 && typeof m0.reviewByClipId === 'object' && !Array.isArray(m0.reviewByClipId)) ? m0.reviewByClipId : {};
          Object.values(byClip).forEach((entry) => {
            if (entry?.thumbKey) keys.push(entry.thumbKey);
            if (entry?.thumbBaseKey) keys.push(entry.thumbBaseKey);
            if (entry?.thumbAnnoKey) keys.push(entry.thumbAnnoKey);
          });
        } catch {}
        [...new Set(keys.filter(Boolean))].forEach(k => { try{ kvSet(String(k), null).catch(()=>{}); }catch{} });
        // Also clear default keys in case the marker never stored explicit key fields.
        try{ kvSet(__pfxThumbKey(id), null).catch(()=>{}); }catch{}
        try{ kvSet(__pfxThumbBaseKey(id), null).catch(()=>{}); }catch{}
        try{ kvSet(__pfxThumbAnnoKey(id), null).catch(()=>{}); }catch{}
      }catch{}
      // Purge annotation shapes (tcKey → shapes) from the PULLS PREP annotation map.
      try{ if (typeof window._pmDeleteAnnotForMarker === 'function') window._pmDeleteAnnotForMarker(m0); }catch{}
      try { store.removeMarker(id); } catch {}
      // Flush immediately so a quick refresh won't lose the delete.
      try { __pfxSaveAutosaveNow({ force: true }).catch(()=>{}); } catch {}
      __pfxMarkerCtxClose();
    });

    menu.append(btnEditAnnotate, btnDelete);
    document.body.appendChild(menu);
    __pfxMarkerCtxMenuEl = menu;

    // Close on outside click / escape
    __pfxMarkerCtxOnDocDown = (e) => {
      try {
        if (!__pfxMarkerCtxMenuEl?.classList?.contains('is-open')) return;
        const t = e?.target;
        if (t && __pfxMarkerCtxMenuEl.contains(t)) return;
        __pfxMarkerCtxClose();
      } catch {}
    };
    __pfxMarkerCtxOnKeyDown = (e) => {
      if (e.key === 'Escape') __pfxMarkerCtxClose();
    };
    try { document.addEventListener('pointerdown', __pfxMarkerCtxOnDocDown, true); } catch {}
    try { document.addEventListener('mousedown', __pfxMarkerCtxOnDocDown, true); } catch {}
    try { window.addEventListener('keydown', __pfxMarkerCtxOnKeyDown, true); } catch {}
    try { window.addEventListener('blur', __pfxMarkerCtxClose); } catch {}
    try { window.addEventListener('resize', __pfxMarkerCtxClose); } catch {}
  };

  const __pfxMarkerCtxOpen = (x, y, markerId) => {
    try {
      __pfxMarkerCtxEnsure();
      if (!__pfxMarkerCtxMenuEl) return;
      __pfxMarkerCtxMarkerId = String(markerId || '');

      const pad = 8;
      __pfxMarkerCtxMenuEl.classList.add('is-open');
      __pfxMarkerCtxMenuEl.style.left = `${Math.max(pad, Number(x) || 0)}px`;
      __pfxMarkerCtxMenuEl.style.top = `${Math.max(pad, Number(y) || 0)}px`;

      // Clamp into viewport after layout
      requestAnimationFrame(() => {
        try {
          const r = __pfxMarkerCtxMenuEl.getBoundingClientRect();
          const vw = window.innerWidth || 0;
          const vh = window.innerHeight || 0;
          let lx = (Number(x) || 0);
          let ty = (Number(y) || 0);
          if (lx + r.width + pad > vw) lx = Math.max(pad, vw - r.width - pad);
          if (ty + r.height + pad > vh) ty = Math.max(pad, vh - r.height - pad);
          __pfxMarkerCtxMenuEl.style.left = `${Math.max(pad, lx)}px`;
          __pfxMarkerCtxMenuEl.style.top = `${Math.max(pad, ty)}px`;
        } catch {}
      });
    } catch {}
  };

  const __pfxMarkerCtxDestroy = () => {
    try { __pfxMarkerCtxClose(); } catch {}
    try { if (__pfxMarkerCtxOnDocDown) document.removeEventListener('pointerdown', __pfxMarkerCtxOnDocDown, true); } catch {}
    try { if (__pfxMarkerCtxOnDocDown) document.removeEventListener('mousedown', __pfxMarkerCtxOnDocDown, true); } catch {}
    try { if (__pfxMarkerCtxOnKeyDown) window.removeEventListener('keydown', __pfxMarkerCtxOnKeyDown, true); } catch {}
    try { window.removeEventListener('blur', __pfxMarkerCtxClose); } catch {}
    try { window.removeEventListener('resize', __pfxMarkerCtxClose); } catch {}
    try { __pfxMarkerCtxMenuEl?.remove?.(); } catch {}
    __pfxMarkerCtxMenuEl = null;
    __pfxMarkerCtxMarkerId = null;
    __pfxMarkerCtxOnDocDown = null;
    __pfxMarkerCtxOnKeyDown = null;
  };

  let __pfxMarkerListScrollTimer = null;
  const __pfxOnMarkerListScroll = () => {
    try { if (__pfxMarkerListScrollTimer) clearTimeout(__pfxMarkerListScrollTimer); } catch {}
    __pfxMarkerListScrollTimer = setTimeout(() => {
      try { __pfxScheduleHydrateThumbs({ delay: 40 }); } catch {}
    }, 70);
  };

  function syncSelectedMarkerUI({ scrollIntoView = false, focus = false } = {}) {
    const sid = String(store.state.selectedMarkerId || '').trim();
    try {
      markersBody.querySelectorAll('.pfx-reviews-markerRow[data-marker-id]').forEach((row) => {
        row.classList.toggle('is-active', !!sid && String(row.dataset.markerId || '') === sid);
      });
    } catch {}

    const activeRow = sid ? markersBody.querySelector(`.pfx-reviews-markerRow[data-marker-id="${sid}"]`) : null;
    if (scrollIntoView && activeRow) {
      try { activeRow.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } catch {}
    }
    if (focus && activeRow) {
      try { activeRow.focus?.(); } catch {}
    }

    const sel = store.getSelectedMarker();
    if (!sel) {
      markerTc.textContent = 'No note selected';
      markerNote.value = '';
      markerNote.disabled = true;
      btnDelMarker.disabled = true;
      try { issueSel.disabled = true; sevSel.disabled = true; } catch {}
      try { issueSel.value = 'General'; sevSel.value = 'S2'; } catch {}
      try { noteTypeSel.disabled = true; noteTypeSel.value = ''; } catch {}
      for (const b of statusBtns) b.classList.remove('is-active');
      markerThumb.removeAttribute('src');
      markerThumb.style.opacity = '0.2';
      markerThumb.style.cursor = 'default';
      markerThumb.title = '';
      return;
    }

    markerTc.textContent = `${sel.srcTC} · ${sel.clipName}`;
    markerNote.value = sel.note || '';
    markerNote.disabled = false;
    btnDelMarker.disabled = false;
    try { issueSel.disabled = false; sevSel.disabled = false; } catch {}
    try { issueSel.value = sel.issueType || 'General'; sevSel.value = sel.severity || 'S2'; } catch {}
    try {
      noteTypeSel.disabled = false;
      const g = (sel.noteTypeGroup || '').toLowerCase();
      const t = (sel.noteType || '').trim();
      noteTypeSel.value = (g && t) ? `${g}|${t}` : '';
    } catch {}

    const curSt = __normalizeMarkerStatus(sel.status);
    for (const b of statusBtns) {
      b.classList.toggle('is-active', (b.dataset.status || '') === curSt);
    }

    if (sel.thumbDataUrl) {
      markerThumb.src = sel.thumbDataUrl;
      markerThumb.style.opacity = '1';
      markerThumb.style.cursor = 'pointer';
      markerThumb.title = 'Click to annotate';
    } else {
      markerThumb.removeAttribute('src');
      markerThumb.style.opacity = '0.2';
      markerThumb.style.cursor = 'default';
      markerThumb.title = '';
      if (sel.thumbKey || sel.thumbBaseKey || sel.thumbAnnoKey) {
        try {
          __pfxEnsureMarkerThumbLoaded(sel.id).then((src) => {
            if (!src) return;
            if (String(store.state.selectedMarkerId || '') !== String(sel.id || '')) return;
            markerThumb.src = src;
            markerThumb.style.opacity = '1';
            markerThumb.style.cursor = 'pointer';
            markerThumb.title = 'Click to annotate';
            try {
              const rowImg = markersBody.querySelector(`.pfx-reviews-markerRow[data-marker-id="${String(sel.id || '')}"] .pfx-reviews-markerMiniThumb`);
              if (rowImg && !rowImg.getAttribute('src')) rowImg.setAttribute('src', src);
            } catch {}
          }).catch(() => {});
        } catch {}
      }
    }
  }

  function refreshMarkersList() {
    // Keep editor on top, list below
    const list = el('div', 'pfx-reviews-markerList');

    const markers = Array.isArray(store.state.markers) ? store.state.markers : [];
    notesVisibleIds = markers.map(m => m.id);
    for (const m of markers) {
      const row = el('div', 'pfx-reviews-markerRow');
      row.tabIndex = 0;
      row.dataset.markerId = m.id;
      if (m.id === store.state.selectedMarkerId) row.classList.add('is-active');

      const left = el('div', 'pfx-reviews-markerLeft');
      const th = el('img', 'pfx-reviews-markerMiniThumb');
      th.alt = 'thumb';
      try { th.loading = 'lazy'; } catch {}
      try { th.decoding = 'async'; } catch {}
      if (m.thumbDataUrl) {
        th.src = m.thumbDataUrl;
      } else {
        th.style.opacity = '0.15';
      }
      left.appendChild(th);

      const mid = el('div', 'pfx-reviews-markerMid');
      const t = el('div', 'pfx-reviews-markerTime', `${m.srcTC}`);
      const n = el('div', 'pfx-reviews-markerText', m.note || '(no note)');
      // Note type badge (Spot-On)
      const g = String(m.noteTypeGroup || '').toLowerCase();
      const t2 = String(m.noteType || '').trim();
      const sow = String(m.scopeOfWork || '').trim();
      const typeLabel = (g && t2) ? `${g.toUpperCase()}: ${t2}` : '';
      const badge = typeLabel ? el('div', 'pfx-reviews-markerType', typeLabel) : null;
      if (badge) badge.dataset.ntg = g;
      const sowLine = sow ? el('div', 'pfx-reviews-markerSub', `SOW: ${sow}`) : null;
      const issue = (m.issueType && m.issueType !== 'General') ? ` · ${m.issueType}` : '';
      const sub = el('div', 'pfx-reviews-markerSub', `${m.clipName}${issue}`);
      if (badge) mid.append(t, badge, n); else mid.append(t, n);
      if (sowLine) mid.append(sowLine);
      mid.append(sub);

      const right = el('div', 'pfx-reviews-markerRight');
      const stLabel = __markerStatusLabel(m.status);
      const stStatus = __normalizeMarkerStatus(m.status);
      if (stLabel) {
        const st = el('div', 'pfx-reviews-markerBadge', stLabel);
        st.dataset.status = stStatus;
        right.appendChild(st);
      }

      row.append(left, mid, right);
      row.addEventListener('click', async () => {
        store.selectMarker(m.id);
        await scrubTo(m.globalTimeSec);
        timeline.jumpToTime(m.globalTimeSec);
      });

      const __pfxRowCtxOpen = (e) => {
        try { if (e.cancelable) e.preventDefault(); } catch {}
        try { e.stopPropagation(); } catch {}
        try { store.selectMarker(m.id); } catch {}
        try { refreshMarkersList(); } catch {}
        try { __pfxMarkerCtxJustOpenedAt = (performance && performance.now) ? performance.now() : Date.now(); } catch { __pfxMarkerCtxJustOpenedAt = Date.now(); }
        __pfxMarkerCtxOpen(e.clientX, e.clientY, m.id);
      };

      // Right-click / ctrl-click: context menu on the Visual QC filmstrip card.
      row.addEventListener('contextmenu', (e) => {
        try {
          const now = (performance && performance.now) ? performance.now() : Date.now();
          if ((now - Number(__pfxMarkerCtxJustOpenedAt || 0)) < 220) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        } catch {}
        __pfxRowCtxOpen(e);
      });
      row.addEventListener('pointerdown', (e) => {
        const isRight = (e.button === 2);
        const isCtrlClick = (e.button === 0 && !!e.ctrlKey && !e.metaKey);
        if (!isRight && !isCtrlClick) return;
        __pfxRowCtxOpen(e);
      }, true);
      row.addEventListener('mousedown', (e) => {
        const isRight = (e.button === 2);
        const isCtrlClick = (e.button === 0 && !!e.ctrlKey && !e.metaKey);
        if (!isRight && !isCtrlClick) return;
        __pfxRowCtxOpen(e);
      }, true);

      // UX: dblclick on a note row jumps to that note AND zoom-fits the full clip range.
      // This makes it much easier to pick/select the clip in the timeline (requested).
      // dblclick fires after two click events per spec.
      row.addEventListener('dblclick', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        store.selectMarker(m.id);
        await scrubTo(m.globalTimeSec);

        // Prefer the actual playback layer at that time (V2 overlay has priority).
        let start = null;
        let end = null;
        try {
          const pb = store.getPlaybackAtTime(m.globalTimeSec);
          if (pb?.seg) {
            start = Number(pb.seg.globalStartSec);
            end = Number(pb.seg.globalEndSec);
          }
        } catch {}

        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
          zoomFitRange(start, end);
        } else {
          // Fallback: at least center on the note time.
          try { timeline.jumpToTime(m.globalTimeSec); } catch {}
        }
      });

      // Keyboard: real-time filmstrip navigation keeps the playhead synced.
      row.addEventListener('keydown', async (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          await stepNotesSelection(-1, { jump: true });
          return;
        }
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          await stepNotesSelection(1, { jump: true });
          return;
        }
        if (e.key === 'Home') {
          e.preventDefault();
          await jumpToNotesBoundary('start');
          return;
        }
        if (e.key === 'End') {
          e.preventDefault();
          await jumpToNotesBoundary('end');
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          await selectNoteId(m.id, { jump: true, scroll: true });
          return;
        }
        if (e.code === 'Space') {
          e.preventDefault();
          await selectNoteId(m.id, { jump: true, scroll: true });
        }
      });

      list.appendChild(row);
    }

    // Replace list section
    const existing = markersBody.querySelector('.pfx-reviews-markerList');
    const prevScrollLeft = existing ? Number(existing.scrollLeft || 0) : 0;
    const prevScrollTop = existing ? Number(existing.scrollTop || 0) : 0;
    if (existing) existing.remove();
    markersBody.appendChild(list);
    try { list.scrollLeft = prevScrollLeft; list.scrollTop = prevScrollTop; } catch {}
    try { list.addEventListener('scroll', __pfxOnMarkerListScroll, { passive: true }); } catch {}
    syncSelectedMarkerUI({ scrollIntoView: true });
    try { __pfxScheduleHydrateThumbs({ delay: 24 }); } catch {}
  }

  // Marker editor actions
  for (const b of statusBtns) {
    b.addEventListener('click', () => {
      const s = b.dataset.status || '';
      setSelectedMarkerStatus(s);
    });
  }
  // Click thumbnail to annotate (Marker-like behavior)
  markerThumb.addEventListener('click', async () => {
    const sel = store.getSelectedMarker();
    if (!sel) return;
    const thumb = sel.thumbDataUrl || await __pfxEnsureMarkerThumbLoaded(sel.id);
    if (!thumb) return;
    openAnnotateModal(sel.id);
  });
  // Keyboard support
  markerThumb.tabIndex = 0;
  markerThumb.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const sel = store.getSelectedMarker();
    if (!sel) return;
    e.preventDefault();
    const thumb = sel.thumbDataUrl || await __pfxEnsureMarkerThumbLoaded(sel.id);
    if (!thumb) return;
    openAnnotateModal(sel.id);
  });

  // ===== Wire UI =====
  btnClear.addEventListener('click', () => {
    store.clearAll();
    status.textContent = 'Cleared';
    try{ void __pfxSaveAutosaveNow({ allowEmpty:true, force:true }).catch(()=>{}); }catch{}
    try{ __pfxClearMediaHandlesSnapshot?.(); }catch{}
  });

  // V1 Auto Cut Detect
  try {
    __pfxSyncV1CutsButtons();
    btnV1AutoCuts.addEventListener('click', () => { __pfxRunV1AutoCuts(); });
    btnV1AutoCutsDock.addEventListener('click', () => { __pfxRunV1AutoCuts(); });
    btnSceneCutDetect.addEventListener('click', () => { __pfxRunV1AutoCuts(); });
    btnV1LoadTimelineCuts.addEventListener('click', () => { void __pfxApplyTimelineAsV1Reference(); });
    sceneCutSensitivity.addEventListener('input', () => {
      const next = writeSceneCutSensitivity(sceneCutSensitivity.value);
      sceneCutSensitivity.value = String(next);
      sceneCutSensitivityVal.textContent = String(next);
      try { __pfxRenderV1CutSummary(); } catch {}
      try { __pfxSyncSceneCutToolbar(); } catch {}
    });
    btnV1EditROI.addEventListener('click', () => { __pfxOpenCustomRoiEditor(); });
    btnV1DrawROI.addEventListener('click', () => {
      try {
        const current = __pfxGetCurrentRoiRegions();
        if (!current.length) {
          __pfxCommitViewerRoiRegions(current, 'Draw ROI mode ready. Drag to add ROI, drag boxes to move, drag handles to resize.');
        }
        try { autoCutIgnore.value = 'custom'; } catch {}
        __pfxSetRoiDrawMode(!__pfxRoiDrawMode);
        try { status.textContent = __pfxRoiDrawMode ? 'Draw ROI enabled. Drag to add, drag boxes to move, drag handles to resize.' : 'Draw ROI closed.'; } catch {}
      } catch {}
    });
    btnV1ClearROI.addEventListener('click', () => {
      try {
        __pfxSelectedRoiIndex = -1;
        __pfxCommitViewerRoiRegions([], 'Custom ROI cleared ({n} regions).');
        try { autoCutIgnore.value = 'none'; } catch {}
        if (__pfxRoiDrawMode) __pfxSetRoiDrawMode(false);
      } catch {}
    });
    btnV1CopyROI.addEventListener('click', async () => {
      try { await __pfxCopyViewerRoi(); } catch (e) { try { status.textContent = String(e?.message || e); } catch {} }
    });
    btnV1PasteROI.addEventListener('click', async () => {
      try { await __pfxPasteViewerRoi(); } catch (e) { try { status.textContent = `ROI paste failed: ${String(e?.message || e)}`; } catch {} }
    });
    roiSnapSelect.addEventListener('change', () => {
      try { store.setAutoCutSettings({ roiSnapStep: Number(roiSnapSelect.value) || 0 }); } catch {}
      try { __pfxScheduleAutosave({ force: true }); } catch {}
      try { __pfxSyncV1CutsButtons(); } catch {}
      try { status.textContent = `ROI snap ${(Number(roiSnapSelect.value) || 0) > 0 ? `${__pfxRoiValueToPct(Number(roiSnapSelect.value) || 0)}%` : 'off'}.`; } catch {}
    });
    btnV1RoiPrev.addEventListener('click', () => { if (__pfxSelectAdjacentViewerRoi(-1)) { try { status.textContent = 'Selected previous ROI.'; } catch {} } });
    btnV1RoiNext.addEventListener('click', () => { if (__pfxSelectAdjacentViewerRoi(1)) { try { status.textContent = 'Selected next ROI.'; } catch {} } });
    btnV1RoiDuplicate.addEventListener('click', () => { if (__pfxDuplicateSelectedViewerRoi()) { try { status.textContent = 'ROI duplicated.'; } catch {} } });
    btnV1RoiSnapNow.addEventListener('click', () => { if (__pfxSnapSelectedViewerRoiNow()) { try { status.textContent = 'ROI snapped to grid.'; } catch {} } });
    btnV1RoiApply.addEventListener('click', () => { if (__pfxApplyRoiInspectorValues()) { try { status.textContent = 'ROI values applied.'; } catch {} } });
    Object.values(__pfxRoiFieldMap).forEach((input) => {
      input.addEventListener('change', () => { if (__pfxApplyRoiInspectorValues()) { try { status.textContent = 'ROI values applied.'; } catch {} } });
      input.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        if (__pfxApplyRoiInspectorValues()) { try { status.textContent = 'ROI values applied.'; } catch {} }
      });
    });
    if (PFX_V1_CUT_TOOLS_VISIBLE) {
      btnV1Split.addEventListener('click', () => { __pfxDoV1Split(); });
      btnV1MergePrev.addEventListener('click', () => { __pfxDoV1MergePrev(); });
      btnV1MergeNext.addEventListener('click', () => { __pfxDoV1MergeNext(); });
      btnV1ToggleUncertain.addEventListener('click', () => { __pfxDoV1ToggleUncertain(); });
      btnV1PrevUnsure.addEventListener('click', () => { __pfxJumpUnsure(-1); });
      btnV1NextUnsure.addEventListener('click', () => { __pfxJumpUnsure(1); });
      btnV1UnsureOnly.addEventListener('click', () => { __pfxToggleUnsureOnly(); });
      btnV1AcceptUnsure.addEventListener('click', () => { __pfxBatchAcceptUnsure(); });
      btnV1RejectUnsure.addEventListener('click', () => { __pfxBatchRejectUnsure(); });
      btnV1AcceptClipUnsure.addEventListener('click', () => { __pfxBatchAcceptClipUnsure(); });
      btnV1RejectClipUnsure.addEventListener('click', () => { __pfxBatchRejectClipUnsure(); });
      btnV1NudgeMinus5.addEventListener('click', () => { __pfxDoV1Nudge(-5); });
      btnV1NudgeMinus1.addEventListener('click', () => { __pfxDoV1Nudge(-1); });
      btnV1NudgePlus1.addEventListener('click', () => { __pfxDoV1Nudge(1); });
      btnV1NudgePlus5.addEventListener('click', () => { __pfxDoV1Nudge(5); });
    }
    btnV1ClearCuts.addEventListener('click', () => {
      if (__pfxV1CutsBusy) { __pfxV1CutsAbort = true; return; }
      const has = __pfxHasAnyV1Cuts();
      if (!has) return;
      const ok = confirm('Clear V1 Scene Cut segments? (V1 will merge back to full clips)');
      if (!ok) return;
      try { store.clearAllV1Cuts(); } catch { try { store.state.v1CutsByClip = {}; store.state.v1CutStatsByClip = {}; store.state.selectedV1Cut = null; store.state.v1CutViewMode = 'all'; store.rebuildSegments('cuts'); } catch {} }
      try { status.textContent = 'Cleared V1 cuts.'; } catch {}
      try { __pfxSaveAutosaveNow({ force: true }).catch(()=>{}); } catch {}
      __pfxSyncV1CutsButtons();
    });
  } catch {}

  try { __pfxSyncSceneCutToolbar(); } catch {}
  try { __pfxSyncV1CutsButtons(); } catch {}
  try { window.addEventListener('mps:edl-timeline-updated', () => { try { __pfxSyncV1CutsButtons(); } catch {} }); } catch {}

  fpsSelect.addEventListener('change', () => {
    const fps = Number(fpsSelect.value);
    store.set({ fps }, 'fps');
    status.textContent = `FPS = ${fps}`;
  });

  zoom.addEventListener('input', () => {
    timeline.setZoom(Number(zoom.value));
  });

  // Program scrub (global timeline)
  const syncProgramReadout = () => {
    const fps = Number(store.state.fps) || 24;
    pgRec.textContent = `REC ${tcFromSeconds(store.state.globalTimeSec || 0, fps)}`;
    const total = store.state.segments.length || 0;
    const idx = store.state.activeIndex >= 0 ? (store.state.activeIndex + 1) : 0;
    pgCount.textContent = `${idx} / ${total}`;
    try {
      const dur = Math.max(0.001, Number(store.totalDurationSec()) || 0.001);
      pgScrub.max = String(dur);
      pgScrub.value = String(Math.max(0, Number(store.state.globalTimeSec) || 0));
    } catch {}

    // Keep Clean Feed timecode/playback in sync if it is open.
    try { cleanFeed && cleanFeed.push && cleanFeed.push(false); } catch {}
  };

  pgScrub.addEventListener('input', async () => {
    const t = Math.max(0, Number(pgScrub.value) || 0);
    await scrubTo(t);
    try { timeline.jumpToTime(t); } catch {}
    syncProgramReadout();
  });

  btnPlay.addEventListener('click', () => player.toggle());
  btnPrev.addEventListener('click', () => player.prevClip());
  btnNext.addEventListener('click', () => player.nextClip());

  pgFull.addEventListener('click', async () => {
    await toggleFullscreen();
    try { timeline.jumpToTime(store.state.globalTimeSec); } catch {}
  });

  btnFull.addEventListener('click', async () => {
    await toggleFullscreen();
    try { timeline.jumpToTime(store.state.globalTimeSec); } catch {}
  });

  btnClean.addEventListener('click', () => {
    try { cleanFeed.toggle(); } catch {}
  });
  try { cleanFeed.syncBtn(); } catch {}
  // 1 View / 2 View toggle (default: Timeline-only)
  // Click: Dual <-> Timeline-only
  // Shift+Click: Dual <-> Source-only
  btnView.addEventListener('click', (e) => {
    if (isUiLocked()) return;
    const wantSource = !!e.shiftKey;
    if (wantSource) {
      setViewMode(viewMode === 'source' ? 'dual' : 'source');
    } else {
      setViewMode(viewMode === 'timeline' ? 'dual' : 'timeline');
    }
  });

  btnBin.addEventListener('click', () => {
    if (isUiLocked()) return;
    setPanelsHidden(false);
    setBinOpen(!root.classList.contains('is-bin-open'));
  });

  btnNotes.addEventListener('click', () => {
    if (isUiLocked()) return;
    setPanelsHidden(false);
    setNotesOpen(!root.classList.contains('is-notes-open'));
  });

  // no drawer handles in docked mode

  // Double-click viewer: toggle full screen
  viewer.addEventListener('dblclick', async (e) => {
    e.preventDefault();
    await toggleFullscreen();
    try { timeline.jumpToTime(store.state.globalTimeSec); } catch {}
  });

  // Safety: also bind dblclick on the videos (some browsers intercept on <video>)
  for (const v of [videoA, videoB]) {
    v.addEventListener('dblclick', async (e) => {
      e.preventDefault();
      await toggleFullscreen();
    });
  }

  // Marker system removed: no manual marker creation.

  btnDelMarker.addEventListener('click', () => {
    const sel = store.getSelectedMarker();
    if (!sel) return;
    try{ if (typeof window._pmDeleteAnnotForMarker === 'function') window._pmDeleteAnnotForMarker(sel); }catch{}
    store.removeMarker(sel.id);
  });

  markerNote.addEventListener('input', () => {
    const sel = store.getSelectedMarker();
    if (!sel) return;
    store.updateMarker(sel.id, { note: markerNote.value });
  });

  noteTypeSel.addEventListener('change', () => {
    const sel = store.getSelectedMarker();
    if (!sel) return;
    const v = String(noteTypeSel.value || '');
    if (!v || !v.includes('|')) {
      store.updateMarker(sel.id, { noteTypeGroup: '', noteType: '' });
      refreshMarkersList();
      return;
    }
    const [g, ...rest] = v.split('|');
    const t = rest.join('|');
    store.updateMarker(sel.id, { noteTypeGroup: g, noteType: t });
    refreshMarkersList();
  });

  // Scope of Work is edited via Annotate modal (and optionally embedded in note text).


  issueSel.addEventListener('change', () => {
    const sel = store.getSelectedMarker();
    if (!sel) return;
    store.updateMarker(sel.id, { issueType: issueSel.value || 'General' });
    refreshMarkersList();
  });

  sevSel.addEventListener('change', () => {
    const sel = store.getSelectedMarker();
    if (!sel) return;
    store.updateMarker(sel.id, { severity: sevSel.value || 'S2' });
    refreshMarkersList();
  });

  // Compact Export menu — portal: attach to body so overflow:hidden ancestors don't clip it
  document.body.appendChild(exportMenu);
  let exportOpen = false;
  const setExportOpen = (open) => {
    exportOpen = !!open;
    if (exportOpen) {
      try {
        const r = btnExport.getBoundingClientRect();
        exportMenu.style.position = 'fixed';
        exportMenu.style.top = `${r.bottom + 6}px`;
        exportMenu.style.left = 'auto';
        exportMenu.style.right = `${window.innerWidth - r.right}px`;
        exportMenu.style.zIndex = '2147483647';
      } catch {}
    }
    exportMenu.style.display = exportOpen ? 'block' : 'none';
    btnExport.classList.toggle('is-open', exportOpen);
  };

  btnExport.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setExportOpen(!exportOpen);
  });

  miJSON.addEventListener('click', (e) => {
    e.preventDefault();
    setExportOpen(false);
    if (typeof window.__rqAddJob === 'function') {
      const pn   = (document.getElementById('projectNameGlobal')?.value || '').trim() || 'VFXReviews';
      const stem = pn.replace(/\s+/g,'_').replace(/[^a-zA-Z0-9._-]/g,'_').replace(/_+/g,'_').replace(/^_+|_+$/g,'') || 'VFXReviews';
      window.__rqAddJob('rvw_json', `Reviews JSON — ${stem}`, { fmt: 'rvw_json', stem, module: 'reviews' });
      try { window.setMainTab('renderq'); } catch {}
    } else {
      downloadOrSaveText('PostFlowX_VFXReviews_Notes.json', store.exportMarkersJSON(), 'application/json').catch(err => alert(err?.message || String(err)));
    }
  });

  miCSV.addEventListener('click', (e) => {
    e.preventDefault();
    setExportOpen(false);
    if (typeof window.__rqAddJob === 'function') {
      const pn   = (document.getElementById('projectNameGlobal')?.value || '').trim() || 'VFXReviews';
      const stem = pn.replace(/\s+/g,'_').replace(/[^a-zA-Z0-9._-]/g,'_').replace(/_+/g,'_').replace(/^_+|_+$/g,'') || 'VFXReviews';
      window.__rqAddJob('rvw_csv', `Reviews CSV — ${stem}`, { fmt: 'rvw_csv', stem, module: 'reviews' });
      try { window.setMainTab('renderq'); } catch {}
    } else {
      downloadOrSaveText('PostFlowX_VFXReviews_Notes.csv', store.exportMarkersCSV(), 'text/csv').catch(err => alert(err?.message || String(err)));
    }
  });

  // Register with Render Queue (store is in scope here)
  window.__rqExportHandlers = window.__rqExportHandlers || {};
  window.__rqExportHandlers['reviews'] = async (fmt) => {
    if (fmt === 'rvw_json') {
      const blob = new Blob([store.exportMarkersJSON()], { type: 'application/json' });
      await window.__pfxSaveBlob('PostFlowX_VFXReviews_Notes.json', blob);
    } else if (fmt === 'rvw_csv') {
      const blob = new Blob([store.exportMarkersCSV()], { type: 'text/csv' });
      await window.__pfxSaveBlob('PostFlowX_VFXReviews_Notes.csv', blob);
    }
  };

  miPDF.addEventListener('click', async (e) => {
    e.preventDefault();
    setExportOpen(false);
    try {
      await __pfxHydrateThumbs({ all: true, trim: false, emit: false });
      exportNotesPDF();
    } catch (err) {
      alert(err?.message || String(err));
    } finally {
      try { __pfxScheduleHydrateThumbs({ delay: 260 }); } catch {}
    }
  });

  exportMenu.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  document.addEventListener('click', () => setExportOpen(false));
  document.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') setExportOpen(false);
  });

  btnExportJSON.addEventListener('click', async () => {
    const json = store.exportMarkersJSON();
    await downloadOrSaveText('PostFlowX_VFXReviews_Notes.json', json, 'application/json');
  });

  btnExportCSV.addEventListener('click', async () => {
    const csv = store.exportMarkersCSV();
    await downloadOrSaveText('PostFlowX_VFXReviews_Notes.csv', csv, 'text/csv');
  });

  const exportNotesPDF = () => {
    const fps = Math.max(1, Number(store.state.fps) || 24);
    const markersRaw = Array.isArray(store.state.markers) ? store.state.markers.slice() : [];
    // Stable sort by global time
    const markers = markersRaw.slice().sort((a,b)=> (Number(a?.globalTimeSec)||0) - (Number(b?.globalTimeSec)||0));

    const projectName = (document.getElementById('projectNameGlobal')?.value || '').trim();
    const baseName = projectName || 'PostFlowX';
    const stamp = new Date().toISOString().replace('T',' ').replace('Z',' UTC');
    const reportTitle = `${baseName} — VFX Reviews Report`;

    const escH = (s) => {
      const v = (s == null) ? '' : String(s);
      return v
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;')
        .replace(/'/g,'&#39;');
    };
    const escNote = (s) => escH(s).replace(/\r?\n/g, '<br/>');

    const secondsToClock = (t) => {
      const s = Math.max(0, Number(t) || 0);
      const hh = Math.floor(s / 3600);
      const mm = Math.floor(s / 60) % 60;
      const ss = Math.floor(s) % 60;
      const ms = Math.floor((s - Math.floor(s)) * 1000);
      const pad2 = (n) => String(n).padStart(2, '0');
      const pad3 = (n) => String(n).padStart(3, '0');
      return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.${pad3(ms)}`;
    };

    const statusLabel = (st) => {
      const s = String(st || 'WIP').toUpperCase();
      if (s === 'NEED_FIX' || s === 'NEED FIX') return 'NEED FIX';
      if (s === 'APPROVED') return 'APPROVED';
      if (s === 'HOLD') return 'HOLD';
      return 'WIP';
    };

    const normSeverity = (sev) => {
      const s = String(sev || 'S2').trim();
      // Allow values like "S2 Major", "S2", "S3 Critical"
      const m = s.match(/S\s*([0-9])/i);
      if (m) return `S${m[1]}`;
      return s || 'S2';
    };

    // ===== Smart aggregates =====
    const counts = { WIP:0, APPROVED:0, NEED_FIX:0, HOLD:0 };
    const byIssue = new Map();      // issueType -> count
    const bySev = new Map();        // S1/S2/S3 -> count
    const byClip = new Map();       // clipName -> {total, worstScore, worstStatus}
    let withAnnotate = 0;
    let missingNote = 0;

    const riskScore = (m) => {
      const st = statusLabel(m?.status);
      const sev = normSeverity(m?.severity);
      let score = 0;
      if (st === 'NEED FIX') score += 3;
      else if (st === 'HOLD') score += 2;
      else if (st === 'WIP') score += 1;

      if (sev === 'S1') score += 3;
      else if (sev === 'S2') score += 2;
      else if (sev === 'S3') score += 1;

      if (m?.thumbDataUrl) score += 1; // has evidence
      const note = String(m?.note || '').trim();
      if (note.length >= 120) score += 1;
      return score;
    };

    for (const m of markers){
      const st = statusLabel(m?.status);
      if (st === 'NEED FIX') counts.NEED_FIX++;
      else if (st === 'APPROVED') counts.APPROVED++;
      else if (st === 'HOLD') counts.HOLD++;
      else counts.WIP++;

      const issue = String(m?.issueType || 'General').trim() || 'General';
      byIssue.set(issue, (byIssue.get(issue) || 0) + 1);

      const sev = normSeverity(m?.severity);
      bySev.set(sev, (bySev.get(sev) || 0) + 1);

      if (m?.thumbDataUrl) withAnnotate++;
      if (!String(m?.note || '').trim()) missingNote++;

      const clip = String(m?.clipName || '').trim() || '—';
      const score = riskScore(m);
      const cur = byClip.get(clip) || { total:0, worstScore:-1, worstStatus:'WIP' };
      cur.total++;
      if (score > cur.worstScore) {
        cur.worstScore = score;
        cur.worstStatus = st;
      }
      byClip.set(clip, cur);
    }

    const total = markers.length;

    const topFromMap = (mp, n=5) => Array.from(mp.entries())
      .sort((a,b)=> b[1]-a[1])
      .slice(0,n);

    const topIssues = topFromMap(byIssue, 4);
    const topSev = topFromMap(bySev, 4);

    // Attention list: top 10 by risk score, tie-break by time
    const attention = markers
      .map(m => ({ m, score: riskScore(m) }))
      .sort((a,b)=> (b.score - a.score) || ((Number(a.m?.globalTimeSec)||0) - (Number(b.m?.globalTimeSec)||0)))
      .slice(0, 10);

    // Delta since last export (lightweight)
    const SNAP_KEY = 'pfx.reviews.report.lastSnapshot.v1';
    const makeSnapshot = () => {
      const rows = markers.map(m => ({
        id: String(m?.id || ''),
        clip: String(m?.clipName || ''),
        t: Number(m?.globalTimeSec) || 0,
        st: statusLabel(m?.status),
        sev: normSeverity(m?.severity),
        issue: String(m?.issueType || 'General')
      }));
      return {
        at: Date.now(),
        counts: { ...counts },
        total,
        rows
      };
    };

    const computeDelta = (prev) => {
      if (!prev || !prev.rows) return null;
      const prevMap = new Map();
      for (const r of prev.rows) prevMap.set(String(r.id || `${r.clip}|${r.t}`), r);

      let newNotes = 0;
      let statusChanged = 0;
      let escalated = 0; // e.g., approved -> needfix/hold
      let newS2Plus = 0;

      const sevRank = (s) => (s === 'S1') ? 3 : (s === 'S2') ? 2 : (s === 'S3') ? 1 : 0;
      const stRank = (st) => (st === 'NEED FIX') ? 3 : (st === 'HOLD') ? 2 : (st === 'WIP') ? 1 : 0;

      for (const m of markers){
        const key = String(m?.id || `${String(m?.clipName||'')}|${Number(m?.globalTimeSec)||0}`);
        const nowRow = { st: statusLabel(m?.status), sev: normSeverity(m?.severity) };
        const old = prevMap.get(key);
        if (!old) {
          newNotes++;
          if (sevRank(nowRow.sev) >= 2) newS2Plus++;
          continue;
        }
        if (old.st !== nowRow.st || String(old.sev||'') !== String(nowRow.sev||'')) {
          statusChanged++;
          if (stRank(nowRow.st) > stRank(old.st)) escalated++;
          if (sevRank(nowRow.sev) >= 2 && sevRank(String(old.sev||'')) < 2) newS2Plus++;
        }
      }
      return { newNotes, statusChanged, escalated, newS2Plus, prevAt: prev.at || 0 };
    };

    let delta = null;
    try{
      const raw = localStorage.getItem(SNAP_KEY);
      if (raw) delta = computeDelta(JSON.parse(raw));
    }catch{}
    try{
      localStorage.setItem(SNAP_KEY, JSON.stringify(makeSnapshot()));
    }catch{}

    const pct = (n) => total ? Math.round((Number(n)||0) * 1000 / total) / 10 : 0;

    const renderLegend = () => `
      <div class="legend">
        <span class="pill st st-WIP">WIP</span>
        <span class="pill st st-APPROVED">APPROVED</span>
        <span class="pill st st-NEEDFIX">NEED FIX</span>
        <span class="pill st st-HOLD">HOLD</span>
      </div>`;

    const renderKPI = () => `
      <div class="kpiRow">
        <div class="kpi"><div class="k">Total Notes</div><div class="v">${escH(total)}</div></div>
        <div class="kpi"><div class="k">WIP</div><div class="v">${escH(counts.WIP)}</div><div class="s">${escH(pct(counts.WIP))}%</div></div>
        <div class="kpi"><div class="k">Approved</div><div class="v">${escH(counts.APPROVED)}</div><div class="s">${escH(pct(counts.APPROVED))}%</div></div>
        <div class="kpi"><div class="k">Need Fix</div><div class="v">${escH(counts.NEED_FIX)}</div><div class="s">${escH(pct(counts.NEED_FIX))}%</div></div>
        <div class="kpi"><div class="k">Hold</div><div class="v">${escH(counts.HOLD)}</div><div class="s">${escH(pct(counts.HOLD))}%</div></div>
      </div>`;

    const renderSmartInfo = () => {
      const issueLines = topIssues.map(([k,v]) => `<div class="kv"><span class="kk">${escH(k)}</span><span class="vv">${escH(v)}</span></div>`).join('');
      const sevLines = topSev.map(([k,v]) => `<div class="kv"><span class="kk">${escH(k)}</span><span class="vv">${escH(v)}</span></div>`).join('');

      const att = attention.map(({m, score}) => {
        const st = statusLabel(m?.status);
        const sev = String(m?.severity || 'S2');
        const issue = String(m?.issueType || 'General');
        const clip = String(m?.clipName || '—');
        const t = secondsToClock(m?.globalTimeSec);
        return `<div class="attRow">
          <span class="pill st st-${escH(st.replace(/\s/g,''))}">${escH(st)}</span>
          <span class="pill sev">${escH(sev)}</span>
          <span class="pill issue">${escH(issue)}</span>
          <span class="attMain">${escH(clip)} <span class="muted">@ ${escH(t)}</span></span>
          <span class="attScore">R${escH(score)}</span>
        </div>`;
      }).join('') || `<div class="muted">No notes.</div>`;

      const deltaBox = delta ? `
        <div class="box">
          <div class="boxTitle">Change since last export</div>
          <div class="deltaGrid">
            <div class="deltaItem"><div class="k">New notes</div><div class="v">${escH(delta.newNotes)}</div></div>
            <div class="deltaItem"><div class="k">Status/severity changed</div><div class="v">${escH(delta.statusChanged)}</div></div>
            <div class="deltaItem"><div class="k">Escalations</div><div class="v">${escH(delta.escalated)}</div></div>
            <div class="deltaItem"><div class="k">New S2+</div><div class="v">${escH(delta.newS2Plus)}</div></div>
          </div>
          <div class="muted small">Previous export: ${escH(new Date(delta.prevAt||0).toLocaleString())}</div>
        </div>` : `
        <div class="box">
          <div class="boxTitle">Change since last export</div>
          <div class="muted">First export for this project on this machine.</div>
        </div>`;

      const dq = `
        <div class="box">
          <div class="boxTitle">Data quality</div>
          <div class="dqRow"><span class="dqK">Has thumbnail</span><span class="dqV">${escH(withAnnotate)} / ${escH(total)} (${escH(pct(withAnnotate))}%)</span></div>
          <div class="dqRow"><span class="dqK">Missing note text</span><span class="dqV">${escH(missingNote)} / ${escH(total)} (${escH(pct(missingNote))}%)</span></div>
        </div>`;

      const glossary = `
        <div class="box glossary">
          <div class="boxTitle">Glossary (quick)</div>
          <div class="glGrid">
            <div class="glRow"><span class="term">R4</span><span class="def"><b>Risk score</b> = 4 (auto). Higher = needs more attention. Calculated from <b>Status</b> + <b>Severity</b> + evidence (thumbnail) + note length. (Typical range 0–8)</span></div>
            <div class="glRow"><span class="term">S2</span><span class="def"><b>Severity level</b>. <b>S2 Major</b> = significant issue that likely requires fixes before approval. S1 = Minor, S3 = Critical.</span></div>
            <div class="glRow"><span class="term">WIP</span><span class="def">Work in progress. Still being worked on / under review.</span></div>
            <div class="glRow"><span class="term">NEED FIX</span><span class="def">Changes required. Must address note(s) before approval.</span></div>
            <div class="glRow"><span class="term">HOLD</span><span class="def">Paused / waiting on dependency (plate, edit lock, client decision, etc.).</span></div>
            <div class="glRow"><span class="term">Category</span><span class="def">Issue type (e.g., Continuity, Color, Tech). Used for grouping & stats.</span></div>
          </div>
        </div>`;

      return `
        <div class="smartGrid">
          <div class="box">
            <div class="boxTitle">Top categories</div>
            ${issueLines || '<div class="muted">—</div>'}
          </div>
          <div class="box">
            <div class="boxTitle">Severity mix</div>
            ${sevLines || '<div class="muted">—</div>'}
          </div>
          ${dq}
          ${deltaBox}
        </div>
        <div class="box">
          <div class="boxTitle">Attention (auto)</div>
          <div class="attList">${att}</div>
        </div>
        ${glossary}`;
    };

    const renderStatusBoard = () => {
      if (!markers.length) return `<div class="muted">No notes.</div>`;
      const rows = markers.map((m) => {
        const st = statusLabel(m?.status);
        const sev = String(m?.severity || 'S2');
        const issue = String(m?.issueType || 'General');
        const clip = String(m?.clipName || '—');
        const t = secondsToClock(m?.globalTimeSec);
        const note = String(m?.note || '').trim().replace(/\s+/g,' ');
        const noteShort = note.length > 120 ? (note.slice(0, 117) + '…') : note;
        const has = m?.thumbDataUrl ? '✓' : '—';
        return `<tr>
          <td class="mono">${escH(t)}</td>
          <td class="clip">${escH(clip)}</td>
          <td><span class="pill st st-${escH(st.replace(/\s/g,''))}">${escH(st)}</span></td>
          <td>${escH(issue)}</td>
          <td>${escH(sev)}</td>
          <td class="noteCell">${noteShort ? escH(noteShort) : '<span class="muted">—</span>'}</td>
          <td class="center">${has}</td>
        </tr>`;
      }).join('');

      return `
        <div class="section">
          <div class="sectionTitle">Status board</div>
          <table class="board">
            <thead>
              <tr>
                <th>Time</th>
                <th>Shot/Clip</th>
                <th>Status</th>
                <th>Category</th>
                <th>Severity</th>
                <th>Note</th>
                <th>Annot</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    };

    const renderDetailCards = () => {
      if (!markers.length) return '';
      // sort by risk descending
      const sorted = markers.slice().sort((a,b)=> (riskScore(b)-riskScore(a)) || ((Number(a?.globalTimeSec)||0)-(Number(b?.globalTimeSec)||0)));
      const cards = sorted.map((m) => {
        const st = statusLabel(m?.status);
        const issue = String(m?.issueType || 'General');
        const sev = String(m?.severity || 'S2');
        const layer = String(m?.layer || 'V1');
        const clip = String(m?.clipName || '');
        const srcTC = String(m?.srcTC || '');
        const g = secondsToClock(m?.globalTimeSec);
        const note = (m?.note || '').trim();
        const thumb = m?.thumbDataUrl ? `<img src="${m.thumbDataUrl}"/>` : `<div class="noThumb">No thumbnail</div>`;
        const score = riskScore(m);

        return `
          <div class="dcard">
            <div class="dthumb">${thumb}</div>
            <div class="dinfo">
              <div class="dtop">
                <div class="dshot">${escH(clip) || '—'}</div>
                <div class="dbadges">
                  <span class="pill st st-${escH(st.replace(/\s/g,''))}">${escH(st)}</span>
                  <span class="pill">${escH(issue)}</span>
                  <span class="pill">${escH(sev)}</span>
                  <span class="pill">${escH(layer)}</span>
                  <span class="pill risk">R${escH(score)}</span>
                </div>
              </div>
              <div class="dmeta">
                <span class="mono">Global: ${escH(g)}</span>
                ${srcTC ? `<span class="mono">SRC: ${escH(srcTC)}</span>` : ''}
              </div>
              <div class="dnote">${note ? escNote(note) : '<span class="muted">(No note)</span>'}</div>
            </div>
          </div>`;
      }).join('');

      return `
        <div class="section">
          <div class="sectionTitle">Details</div>
          <div class="detailGrid">${cards}</div>
        </div>`;
    };

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escH(reportTitle)}</title>
  <style>
    :root { color-scheme: light; }
    @page { size: A4 landscape; margin: 12mm; }
    body{ font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 20px; }
    h1{ font-size: 18px; margin: 0 0 6px; }
    .metaTop{ font-size: 12px; color:#444; margin-bottom: 10px; display:flex; align-items:center; justify-content:space-between; gap: 10px; }
    .legend{ display:flex; gap: 8px; flex-wrap:wrap; justify-content:flex-end; }
    .mono{ font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
    .muted{ color:#666; }
    .small{ font-size: 11px; }

    .pill{ display:inline-flex; align-items:center; gap:6px; border:1px solid #ddd; border-radius: 999px; padding: 2px 8px; font-size: 11px; white-space: nowrap; }
    .pill.st{ font-weight: 800; }
    .st-WIP{ background:#fff7e6; border-color:#f4d27a; }
    .st-APPROVED{ background:#e9f9ef; border-color:#8fe0a8; }
    .st-NEEDFIX{ background:#ffecec; border-color:#ff9a9a; }
    .st-HOLD{ background:#eef2ff; border-color:#b9c6ff; }
    .pill.risk{ background:#f7f7f7; border-color:#d7d7d7; font-weight:800; }

    .kpiRow{ display:grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin: 10px 0 10px; }
    .kpi{ border: 1px solid #ddd; border-radius: 12px; padding: 10px; }
    .kpi .k{ font-size: 11px; color:#666; }
    .kpi .v{ font-size: 20px; font-weight: 900; margin-top: 2px; }
    .kpi .s{ font-size: 11px; color:#777; margin-top: 2px; }

    .smartGrid{ display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 10px 0 10px; }
    .box{ border:1px solid #ddd; border-radius: 12px; padding: 10px; }
    .boxTitle{ font-size: 12px; font-weight: 900; margin-bottom: 8px; }
    .kv{ display:flex; align-items:center; justify-content:space-between; gap: 8px; padding: 4px 0; border-top: 1px dashed #eee; }
    .kv:first-of-type{ border-top: 0; }
    .kk{ color:#333; font-size: 11px; }
    .vv{ font-weight: 900; font-size: 12px; }
    .dqRow{ display:flex; justify-content:space-between; gap: 10px; padding: 4px 0; border-top: 1px dashed #eee; }
    .dqRow:first-of-type{ border-top:0; }
    .dqK{ font-size: 11px; color:#333; }
    .dqV{ font-size: 12px; font-weight: 900; }
    .deltaGrid{ display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 6px 0 0; }
    .deltaItem{ border:1px solid #eee; border-radius: 10px; padding: 8px; }
    .deltaItem .k{ font-size: 10px; color:#666; }
    .deltaItem .v{ font-size: 16px; font-weight: 900; margin-top: 2px; }

    .attList{ display:flex; flex-direction:column; gap: 6px; }
    .attRow{ display:grid; grid-template-columns: auto auto auto 1fr auto; gap: 8px; align-items:center; border-top: 1px dashed #eee; padding-top: 6px; }
    .attRow:first-child{ border-top:0; padding-top:0; }
    .attMain{ font-size: 11px; color:#111; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .attScore{ font-size: 11px; font-weight: 900; color:#111; }

    .glossary .boxTitle{ margin-bottom: 6px; }
    .glGrid{ display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .glRow{ border:1px solid #eee; border-radius: 10px; padding: 8px; }
    .term{ display:inline-block; min-width: 44px; font-weight: 900; font-size: 12px; margin-right: 6px; }
    .def{ font-size: 11px; color:#222; line-height: 1.25; }
    .def b{ font-weight: 900; }

    .section{ margin-top: 14px; }
    .sectionTitle{ font-size: 13px; font-weight: 900; margin: 0 0 8px; }

    table.board{ width:100%; border-collapse: collapse; font-size: 11px; }
    table.board th, table.board td{ border-bottom: 1px solid #eee; padding: 6px 6px; vertical-align: top; }
    table.board thead th{ border-bottom: 2px solid #ddd; text-align:left; color:#333; }
    table.board td.center, table.board th.center{ text-align:center; }
    table.board td.clip{ font-weight: 800; }
    table.board td.noteCell{ color:#111; }

    /* Detail cards: 6 per page feel (2 columns x 3 rows) */
    .detailGrid{ display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .dcard{ border:1px solid #e6e6e6; border-radius: 12px; overflow:hidden; display:grid; grid-template-columns: 190px 1fr; gap: 10px; padding: 10px; break-inside: avoid; page-break-inside: avoid; }
    .dthumb img{ width:100%; height:auto; display:block; border-radius: 10px; border:1px solid #eee; }
    .noThumb{ width:100%; height: 120px; border-radius:10px; border:1px dashed #ccc; display:flex; align-items:center; justify-content:center; color:#777; font-size:12px; }
    .dtop{ display:flex; align-items:flex-start; justify-content:space-between; gap: 10px; }
    .dshot{ font-size: 13px; font-weight: 900; }
    .dbadges{ display:flex; gap: 6px; flex-wrap:wrap; justify-content:flex-end; }
    .dmeta{ font-size: 10px; color:#555; margin-top: 6px; display:flex; flex-wrap:wrap; gap: 8px; }
    .dnote{ margin-top: 8px; font-size: 11px; line-height: 1.35; color:#111; }

    @media print{
      body{ margin: 0; }
    }
  </style>
</head>
<body>
  <h1>${escH(reportTitle)}</h1>
  <div class="metaTop">
    <div>Generated: ${escH(stamp)} &nbsp;•&nbsp; FPS: ${escH(String(fps))}</div>
    ${renderLegend()}
  </div>

  ${renderKPI()}
  ${renderSmartInfo()}
  ${renderStatusBoard()}
  ${renderDetailCards()}
</body>
</html>`;

    try{
      const iframe = document.createElement('iframe');
      iframe.style.position = 'fixed';
      iframe.style.right = '0';
      iframe.style.bottom = '0';
      iframe.style.width = '1px';
      iframe.style.height = '1px';
      iframe.style.opacity = '0';
      iframe.style.pointerEvents = 'none';
      iframe.setAttribute('aria-hidden', 'true');
      iframe.srcdoc = html;
      document.body.appendChild(iframe);

      const cleanup = () => { try{ iframe.remove(); }catch{} };

      iframe.onload = () => {
        try{
          const w = iframe.contentWindow;
          if (!w) throw new Error('Print frame unavailable');
          w.focus();
          setTimeout(() => {
            try{ w.print(); }catch{}
            setTimeout(cleanup, 900);
          }, 250);
        }catch{
          cleanup();
          alert('Unable to open print dialog for PDF export.');
        }
      };
    }catch(err){
      alert(err?.message || String(err));
    }
  };

  // File input
  fileInput.addEventListener('change', async () => {
    const files = fileInput.files;
    fileInput.value = '';
    const added = await store.addClips(files, { bin: importTarget });

    // Persist immediately so a quick refresh doesn't lose the Bin/Timeline.
    // (Media URLs are blob: and won't survive refresh, but clip metadata will.)
    try{ await __pfxSaveAutosaveNow({ force:true }); }catch{}

    // Probe durations & codec support (only newly added clips)
    const probe = Array.isArray(added) && added.length ? added : [];
    for (const c of probe) {
      try { await player.ensureClipMetadata(c.id); } catch {}
    }

    const firstAdded = Array.isArray(added) ? added.find(c => c.canPlay !== false) : null;
    const firstAny = store.state.clips.find(c => c.canPlay !== false) || null;
    const first = firstAdded || firstAny;
    if (first) {
      loadSourceClip({ clipId: first.id, name: first.name, url: first.url, startTC: first.startTC || '00:00:00:00' }, 0, { pin: true });
    }

    const label = (importTarget === 'ref') ? 'V1 (Ref)' : 'V2 (Shots)';
    status.textContent = `Added ${Array.isArray(added) ? added.length : 0} clip(s) to ${label}`;
  });

  // Drag & drop
  const onDropFiles = async (files, targetBin = 'shots', dropHandles = null) => {
    const hs = Array.isArray(dropHandles) ? dropHandles : [];

    // Build handle-by-name map (permission is granted at drop time).
    const handleByName = new Map(); // lowercase filename -> FileSystemFileHandle
    for (const h of hs) {
      try {
        const f = await h.getFile();
        handleByName.set((f.name || '').toLowerCase(), h);
      } catch {}
    }

    // --- Smart relink-or-add ---
    // If dropped files match existing unlinked clips by filename, relink them rather than
    // creating duplicate clips. Only files with no match become new clips.
    const isVideo = (f) => {
      const lower = (f?.name || '').toLowerCase();
      return (f?.type || '').startsWith('video/') || lower.endsWith('.mp4') || lower.endsWith('.mov');
    };
    const stemName = (n) => String(n || '').toLowerCase().replace(/\.[^.]+$/, '');

    const fileArr = Array.from(files || []).filter(isVideo);
    const unlinkedClips = (store.state.clips || []).filter(c => !c?.url || c?.canPlay === false);
    console.log('[PFX DROP] dropped files:', fileArr.map(f=>f.name), 'handles:', handleByName.size, 'unlinked clips:', unlinkedClips.length, unlinkedClips.map(c=>({id:c.id, fmeta:c?.fileMeta?.name, name:c?.name})));

    const relinkPairs = []; // { file: File, clip: clipObj, handle: FileSystemFileHandle|null }
    const toAdd = [];       // File objects that have no unlinked clip match

    // Take a mutable copy so we can mark clips as "claimed" (avoid double-matching).
    const available = [...unlinkedClips];
    for (const f of fileArr) {
      const fname = (f.name || '').toLowerCase();
      const fstem = stemName(f.name);
      const idx = available.findIndex(c => {
        const cname = String(c?.fileMeta?.name || c?.name || '').toLowerCase();
        return cname === fname || stemName(cname) === fstem;
      });
      if (idx !== -1) {
        const h = handleByName.get(fname) || null;
        console.log('[PFX DROP]   MATCH', f.name, '→ clip', available[idx]?.id, '| handle=', !!h);
        relinkPairs.push({ file: f, clip: available[idx], handle: h });
        available.splice(idx, 1); // claimed
      } else {
        console.log('[PFX DROP]   NO MATCH for', f.name, '→ will add as new clip');
        toAdd.push(f);
      }
    }

    // Relink matched existing clips in-place (no new clipId).
    const relinkedClips = [];
    for (const { file: f, clip, handle: h } of relinkPairs) {
      try {
        // Revoke stale blob if any.
        try{ if (clip.url && clip.url.startsWith('blob:')) URL.revokeObjectURL(clip.url); }catch{}
        const url = URL.createObjectURL(f);
        const patch = {
          file: f, url, canPlay: true,
          fileMeta: { name: f.name, size: Number(f.size)||0, lastModified: Number(f.lastModified)||0, type: String(f.type||'') },
          autoRelinked: true, autoRelinkedAt: Date.now(),
        };
        if (h) {
          patch.fsHandle = h;
          patch.handleSaved = true;
          patch.handleSavedAt = Date.now();
          patch.persistKey = __pfxPersistKeyFromMeta({ name: f.name, size: f.size, lastModified: f.lastModified });
        }
        store.updateClip(clip.id, patch);
        relinkedClips.push(clip);
      } catch {}
    }
    if (relinkedClips.length) {
      try{ store.emit('clips'); }catch{}
      try{ refreshClipsList(); }catch{}
    }

    // Add files that have no existing unlinked match as brand-new clips.
    const added = toAdd.length ? (await store.addClips(toAdd, { bin: targetBin }) || []) : [];

    // Attach handles to newly added clips.
    if (hs.length && added.length) {
      try{
        const n = await __pfxAttachHandlesToAddedClips(added, hs);
        if (n > 0) await __pfxSaveMediaHandlesSnapshot();
      }catch{}
    }

    // If any relinks happened with handles, persist the updated snapshot.
    if (relinkedClips.length && handleByName.size > 0) {
      try{ await __pfxSaveMediaHandlesSnapshot(); }catch{}
    }

    // Persist clip metadata immediately.
    try{ await __pfxSaveAutosaveNow({ force:true }); }catch{}

    const allTouched = [...relinkedClips, ...(Array.isArray(added) ? added : [])];
    for (const c of allTouched) {
      try { await player.ensureClipMetadata(c.id); } catch {}
    }

    const firstLinked = allTouched.find(c => c.canPlay !== false)
      || store.state.clips.find(c => c.canPlay !== false) || null;
    if (firstLinked) {
      loadSourceClip({ clipId: firstLinked.id, name: firstLinked.name, url: firstLinked.url, startTC: firstLinked.startTC || '00:00:00:00' }, 0, { pin: true });
    }

    const relinkMsg = relinkedClips.length ? `Relinked ${relinkedClips.length}` : '';
    const addMsg = added.length ? `Added ${added.length} to ${targetBin === 'ref' ? 'V1 (Ref)' : 'V2 (Shots)'}` : '';
    status.textContent = [relinkMsg, addMsg].filter(Boolean).join(', ') || 'No video files dropped';
  };

  const __pfxIsVideoFile = (file) => /\.(mp4|mov)$/i.test(String(file?.name || ''));
  const __pfxIsTimelineFile = (file) => /\.(edl|xml|otio|otioz|fcpxml|xmld|json)$/i.test(String(file?.name || ''));
  const __pfxBuildDataTransferFiles = (files) => {
    const dt = new DataTransfer();
    (Array.isArray(files) ? files : []).forEach((file) => { try { if (file) dt.items.add(file); } catch {} });
    return dt.files;
  };
  const __pfxWaitForTimelineUpdate = (timeoutMs = 4000) => new Promise((resolve) => {
    let done = false;
    let timer = 0;
    const cleanup = () => {
      try { window.removeEventListener('mps:edl-timeline-updated', onOk); } catch {}
      try { window.removeEventListener('pfx:imported-timeline-model-updated', onImported); } catch {}
      try { if (timer) clearTimeout(timer); } catch {}
      timer = 0;
    };
    const finish = (detail = null) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(detail);
    };
    const onOk = (e) => finish(e?.detail || { ok: true, source: 'pullprep' });
    const onImported = (e) => finish(e?.detail || { ok: !!window.__PFX_IMPORTED_TIMELINE_MODEL, source: 'markers' });
    try {
      if (__pfxGetCurrentTimelineCutModel()) {
        finish({ ok: true, source: 'existing' });
        return;
      }
    } catch {}
    try { window.addEventListener('mps:edl-timeline-updated', onOk); } catch {}
    try { window.addEventListener('pfx:imported-timeline-model-updated', onImported); } catch {}
    timer = setTimeout(() => finish({ ok: !!__pfxGetCurrentTimelineCutModel(), source: 'timeout' }), Math.max(400, Number(timeoutMs) || 4000));
  });

  const __pfxRatToFrames = (val, fps) => {
    if (val == null) return 0;
    let s = String(val).trim();
    if (!s) return 0;
    let isSeconds = false;
    if (s.endsWith('s')) {
      isSeconds = true;
      s = s.slice(0, -1);
    }
    if (s.includes('/')) {
      const [a, b] = s.split('/');
      const num = Number(a);
      const den = Number(b);
      if (!Number.isFinite(num) || !Number.isFinite(den) || !den) return 0;
      const n = num / den;
      return Math.round(isSeconds ? (n * fps) : n);
    }
    const n = Number(s);
    if (!Number.isFinite(n)) return 0;
    return Math.round(isSeconds ? (n * fps) : n);
  };
  const __pfxFramesToTC = (fr, fps) => {
    const frames = Math.max(0, Math.round(Number(fr) || 0));
    const rate = Math.max(1, Math.round(Number(fps) || 24));
    const s = Math.floor(frames / rate);
    const ff = frames % rate;
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return [hh, mm, ss, ff].map((n) => String(n).padStart(2, '0')).join(':');
  };
  const __pfxManualFCPXMLSpineEvents = (xmlText) => {
    const xml = String(xmlText || '');
    if (!xml) return [];
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const root = doc && doc.documentElement;
    if (!root || String(root.tagName || '').toLowerCase() !== 'fcpxml') return [];
    try {
      const pe = doc.getElementsByTagName('parsererror');
      if (pe && pe.length) return [];
    } catch {}

    const childEls = (node) => Array.from((node?.childNodes || [])).filter((el) => el && el.nodeType === 1);

    let fps = 24;
    try {
      const formats = doc.getElementsByTagName('format');
      for (const fmt of Array.from(formats || [])) {
        const fdRaw = String(fmt.getAttribute('frameDuration') || '').trim();
        if (!fdRaw) continue;
        const fd = fdRaw.endsWith('s') ? fdRaw.slice(0, -1) : fdRaw;
        const parts = fd.split('/');
        if (parts.length !== 2) continue;
        const num = Number(parts[0]);
        const den = Number(parts[1]);
        if (Number.isFinite(num) && Number.isFinite(den) && num > 0 && den > 0) {
          fps = Math.max(1, Math.round(den / num));
          break;
        }
      }
    } catch {}

    const assets = {};
    try {
      const assetEls = doc.getElementsByTagName('asset');
      for (const asset of Array.from(assetEls || [])) {
        const id = asset.getAttribute('id');
        if (!id) continue;
        assets[id] = { name: asset.getAttribute('name') || '' };
      }
    } catch {}

    let mainSeq = null;
    try {
      const sequences = doc.getElementsByTagName('sequence');
      if (sequences && sequences.length) mainSeq = sequences[0];
    } catch {}
    if (!mainSeq) return [];

    const seqStartF = __pfxRatToFrames(mainSeq.getAttribute('tcStart') || mainSeq.getAttribute('start') || '0s', fps);
    let topSpine = null;
    for (const ch of childEls(mainSeq)) {
      if (String(ch.tagName || '').toLowerCase() === 'spine') {
        topSpine = ch;
        break;
      }
    }
    const kids = childEls(topSpine || mainSeq);
    if (!kids.length) return [];

    let seqOriginF = 0;
    try {
      const offsets = kids
        .map((el) => __pfxRatToFrames(el.getAttribute && el.getAttribute('offset'), fps))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (offsets.length) {
        const minOff = Math.min(...offsets);
        const pad = Math.round(fps * 2);
        if (seqStartF > 0 && minOff >= (seqStartF - pad)) seqOriginF = seqStartF;
      }
    } catch {}

    const out = [];
    const seen = new Set();
    const clipTags = new Set(['sync-clip', 'mc-clip', 'asset-clip', 'clip', 'video']);
    for (const node of kids) {
      const tag = String(node.tagName || '').toLowerCase();
      if (!clipTags.has(tag)) continue;
      const offF = __pfxRatToFrames(node.getAttribute('offset'), fps);
      const durF = __pfxRatToFrames(node.getAttribute('duration'), fps);
      if (!Number.isFinite(offF) || !Number.isFinite(durF) || durF <= 0) continue;
      const recInF = seqStartF + (offF - (seqOriginF || 0));
      const recOutF = recInF + durF;
      if (!Number.isFinite(recInF) || !Number.isFinite(recOutF) || recOutF <= recInF) continue;
      const ref = node.getAttribute('ref') || '';
      const assetName = (ref && assets[ref] && assets[ref].name) ? assets[ref].name : '';
      const clipName = node.getAttribute('name') || assetName || 'CLIP';
      const key = [tag, recInF, recOutF, clipName].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        clipName,
        srcFile: assetName || clipName,
        reel: (assetName || clipName || 'REEL').replace(/\.[^.]+$/, ''),
        srcIn: __pfxFramesToTC(0, fps),
        srcOut: __pfxFramesToTC(durF, fps),
        recIn: __pfxFramesToTC(recInF, fps),
        recOut: __pfxFramesToTC(recOutF, fps),
        fps,
        role: 'video',
        type: tag,
        markers: [],
        _markers: [],
        disabled: false,
        trackIndex: 0
      });
    }
    return out;
  };
  const __pfxReadTimelineFileToModel = async (file) => {
    const f = file;
    if (!f) throw new Error('No timeline file');
    const name = String(f.name || '').toLowerCase();
    let preText = null;
    let preU8 = null;
    try{
      if (/(\.edl|\.xml|\.otio|\.fcpxml)$/i.test(name)) preText = await f.text();
      else {
        const ab = await f.arrayBuffer();
        preU8 = new Uint8Array(ab);
      }
    }catch(err){
      throw new Error(err?.message || 'Failed to read timeline file');
    }

    let parseOTIO, parseXMEML, parseFCPXML, parseEDL;
    try{ ({ parseOTIO } = await import('../../parsers/otio.js')); }catch{}
    try{ ({ parseXMEML } = await import('../../parsers/xml.js')); }catch{}
    try{ ({ parseFCPXML } = await import('../../parsers/fcpxml.js')); }catch{}
    try{ ({ parseEDL } = await import('../../parsers/edl.js')); }catch{}

    let parsed = null;
    try{
      if (name.endsWith('.otio')){
        const obj = JSON.parse(preText ?? (await f.text()));
        parsed = parseOTIO ? parseOTIO(obj) : null;
      } else if (name.endsWith('.otioz')){
        const { loadOTIOZ } = await import('../../fflate-bridge.js');
        const obj = await loadOTIOZ(preU8 || f);
        parsed = parseOTIO ? parseOTIO(obj) : null;
      } else if (name.endsWith('.fcpxml')){
        parsed = parseFCPXML ? parseFCPXML(preText ?? (await f.text())) : null;
      } else if (name.endsWith('.fcpxmld')){
        const { loadFCPXMLD } = await import('../../fflate-bridge.js');
        const xml = await loadFCPXMLD(preU8 || f);
        parsed = parseFCPXML ? parseFCPXML(xml) : null;
      } else if (name.endsWith('.xmld')){
        const { loadXMLD } = await import('../../fflate-bridge.js');
        const xml = await loadXMLD(preU8 || f);
        const isFCP = String(xml || '').toLowerCase().includes('<fcpxml');
        parsed = isFCP ? (parseFCPXML ? parseFCPXML(xml) : null) : (parseXMEML ? parseXMEML(xml) : null);
      } else if (name.endsWith('.xml')){
        const xmlText = preText ?? (await f.text());
        const isFCP = /<\s*fcpxml\b/i.test(String(xmlText || ''));
        parsed = isFCP ? (parseFCPXML ? parseFCPXML(xmlText) : null) : (parseXMEML ? parseXMEML(xmlText) : null);
      } else if (name.endsWith('.edl')){
        parsed = parseEDL ? parseEDL(preText ?? (await f.text())) : null;
      } else if (name.endsWith('.json')){
        const obj = JSON.parse(preText ?? (await f.text()));
        if (obj && Array.isArray(obj.tracks) && Number.isFinite(Number(obj.fps))) {
          return obj;
        }
      }
    }catch(err){
      throw new Error(err?.message || 'Failed to parse timeline');
    }

    let events = Array.isArray(parsed?.events) ? parsed.events : [];
    if (!events.length && name.endsWith('.fcpxml')) {
      try {
        const manualEvents = __pfxManualFCPXMLSpineEvents(preText ?? (await f.text()));
        if (manualEvents.length) {
          parsed = { ...(parsed || {}), events: manualEvents, fps: Math.round(parsed?.fps || manualEvents[0]?.fps || Number(store.state?.fps) || 24), videoTrackCount: 1, __pfxManualFallback: true };
          events = manualEvents;
        } else {
          try { console.warn('[PostFlowX] FCPXML manual fallback found 0 top-level events'); } catch {}
        }
      } catch (err) {
        try { console.warn('[PostFlowX] FCPXML manual fallback failed', err); } catch {}
      }
    }
    if (!events.length) throw new Error('No video events found in this file.');
    const fps = Math.round(parsed?.fps || events[0]?.fps || Number(store.state?.fps) || 24);
    const seqBase = getSeqBaseFrames(parsed, fps);
    return buildImportedTimelineFromEvents(events, fps, {
      seqBaseFrames: seqBase,
      videoTrackCountHint: parsed?.videoTrackCount,
      hideDisabled: false,
      explodeOverlaps: true
    });
  };

  const __pfxImportTimelineFilesForV1 = async (files) => {
    const picked = (Array.isArray(files) ? files : []).filter(__pfxIsTimelineFile);
    if (!picked.length) {
      try { status.textContent = 'Drop .edl / .xml / .otio / .fcpxml to Timeline'; } catch {}
      return;
    }

    let importedViaShotMarker = false;
    const tlInput = document.getElementById('smImportTimeline');
    if (tlInput) {
      try { tlInput.files = __pfxBuildDataTransferFiles(picked); } catch {}
      try { tlInput.dispatchEvent(new Event('change', { bubbles: true })); importedViaShotMarker = true; } catch {}
    }

    const waitDetail = await __pfxWaitForTimelineUpdate();
    if (!__pfxGetCurrentTimelineCutModel()) {
      try {
        const model = await __pfxReadTimelineFileToModel(picked[0]);
        window.__PFX_IMPORTED_TIMELINE_MODEL = model;
        try{
          window.dispatchEvent(new CustomEvent('pfx:imported-timeline-model-updated', {
            detail: {
              ok: true,
              reason: importedViaShotMarker ? 'reviews-direct-fallback' : 'reviews-direct',
              name: String(picked[0]?.name || '').trim(),
              tracks: Array.isArray(model?.tracks) ? model.tracks.length : 0,
              items: Array.isArray(model?.tracks) ? model.tracks.reduce((n, t) => n + ((Array.isArray(t?.items) ? t.items.length : 0)), 0) : 0
            }
          }));
        }catch{}
      } catch (err) {
        const msg = String(err?.message || err || 'Failed to import timeline');
        try { status.textContent = msg; } catch {}
        try { console.warn('[PostFlowX] Timeline import failed:', msg); } catch {}
        // don't re-throw — callers don't wrap in try/catch, causing unhandled rejection
        return;
      }
    }

    try { await __pfxApplyTimelineAsV1Reference(); } catch {}
  };

  for (const target of [viewer, root]) {
    target.addEventListener('dragover', (e) => {
      e.preventDefault();
      root.classList.add('is-drag');
    });
    target.addEventListener('dragleave', () => root.classList.remove('is-drag'));
    target.addEventListener('drop', async (e) => {
      e.preventDefault();
      root.classList.remove('is-drag');
      const dt = e.dataTransfer;
      const files = __pfxExtractDropFiles(dt);
      if (files?.length) {
        let hs = [];
        try{ hs = await __pfxExtractDropFileHandles(dt); }catch{}
        await onDropFiles(files, importTarget || 'shots', hs);
      }
    });
  }

  // Dedicated drop zones: keep Ref and Shots bins truly separate
  const bindDropZone = (elem, binName) => {
    if (!elem) return;
    elem.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      root.classList.add('is-drag');
      try { elem.classList.add('is-dropTarget'); } catch {}
    });
    elem.addEventListener('dragleave', () => {
      try { elem.classList.remove('is-dropTarget'); } catch {}
      root.classList.remove('is-drag');
    });
    elem.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { elem.classList.remove('is-dropTarget'); } catch {}
      root.classList.remove('is-drag');
      const dt = e.dataTransfer;
      const files = __pfxExtractDropFiles(dt);
      if (files?.length) {
        let hs = [];
        try{ hs = await __pfxExtractDropFileHandles(dt); }catch{}
        await onDropFiles(files, binName, hs);
      }
    });
  };
  bindDropZone(refCard, 'ref');
  bindDropZone(clipsCard, 'shots');

  const __pfxSyncRefImportRows = () => {
    try {
      const clips = Array.isArray(store.state?.clips) ? store.state.clips : [];
      const tlIds = Array.isArray(store.state?.timelineClipIds) ? store.state.timelineClipIds : [];
      const refs = clips.filter((c) => {
        const b = String(c?.bin || '').toLowerCase();
        if (b === 'ref' || b === 'v1') return true;
        return tlIds.includes(c?.id);
      });
      const firstRef = refs[0] || null;
      const refLabel = firstRef
        ? ((refs.length > 1) ? `${String(firstRef.name || firstRef.file?.name || 'Ref').trim()} +${refs.length - 1}` : String(firstRef.name || firstRef.file?.name || 'Ref').trim())
        : 'Click or drop file';
      if (refVideoImportMeta) refVideoImportMeta.textContent = refLabel;
      refVideoImportRow.classList.toggle('is-loaded', !!firstRef);
      refVideoImportBtn.classList.toggle('is-loaded', !!firstRef);
      refVideoImportRemove.disabled = !firstRef;

      const importedMeta = String(document.getElementById('smImportTimelineMeta')?.textContent || '').trim();
      const hasImportedName = !!(importedMeta && !/^Drop\s/i.test(importedMeta));
      const hasTimeline = !!__pfxGetCurrentTimelineCutModel();
      const timelineName = hasImportedName
        ? importedMeta
        : (hasTimeline ? (String(window.__MPS_PROJECT_NAME || document.getElementById('projectName')?.value || '').trim() || 'Timeline loaded') : 'Click or drop file');
      if (refTimelineImportMeta) refTimelineImportMeta.textContent = timelineName;
      refTimelineImportRow.classList.toggle('is-loaded', hasTimeline || hasImportedName);
      refTimelineImportBtn.classList.toggle('is-loaded', hasTimeline || hasImportedName);
      refTimelineImportRemove.disabled = !(hasTimeline || hasImportedName);
    } catch {}
  };

  const __pfxBindImportDropRow = (rowEl, kind) => {
    if (!rowEl) return;
    rowEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      rowEl.classList.add('is-dropover');
    });
    rowEl.addEventListener('dragleave', () => {
      rowEl.classList.remove('is-dropover');
    });
    rowEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      rowEl.classList.remove('is-dropover');
      const dt = e.dataTransfer;
      const files = __pfxExtractDropFiles(dt) || [];
      if (!files.length) return;
      if (kind === 'timeline') {
        await __pfxImportTimelineFilesForV1(files);
      } else {
        const vids = files.filter(__pfxIsVideoFile);
        if (!vids.length) {
          try { status.textContent = 'Drop MP4 / MOV to Video'; } catch {}
          return;
        }
        let hs = [];
        try { hs = await __pfxExtractDropFileHandles(dt); } catch {}
        await onDropFiles(vids, 'ref', hs);
        try { if (__pfxGetCurrentTimelineCutModel()) await __pfxApplyTimelineAsV1Reference(); } catch {}
      }
      __pfxSyncRefImportRows();
    });
  };

  const __pfxOpenRefPicker = async (kind) => {
    if (kind !== 'video' && kind !== 'timeline') return;
    // UI lock protects layout/splitters only; loading media and timelines must still work.
    try { if (kind === 'video') importTarget = 'ref'; } catch {}
    const canUseSystemPicker = (typeof window.showOpenFilePicker === 'function');
    if (canUseSystemPicker) {
      try {
        const handles = await window.showOpenFilePicker(kind === 'video' ? {
          multiple: true,
          excludeAcceptAllOption: false,
          types: [{
            description: 'Video files',
            accept: {
              'video/mp4': ['.mp4'],
              'video/quicktime': ['.mov'],
              'video/*': ['.mp4', '.mov', '.m4v', '.mxf', '.avi', '.mkv', '.webm']
            }
          }]
        } : {
          multiple: true,
          excludeAcceptAllOption: false,
          types: [{
            description: 'Timeline files',
            accept: {
              'application/xml': ['.xml', '.fcpxml', '.fcpxmld', '.xmld'],
              'application/json': ['.otio', '.otioz', '.json'],
              'text/plain': ['.edl']
            }
          }]
        });
        const hs = Array.isArray(handles) ? handles.filter((h) => h && h.kind === 'file') : [];
        if (hs.length) {
          const files = [];
          for (const h of hs) {
            try {
              if (h.requestPermission) await h.requestPermission({ mode: 'read' });
            } catch {}
            try {
              const f = await h.getFile();
              if (f) files.push(f);
            } catch {}
          }
          if (files.length) {
            if (kind === 'video') {
              await onDropFiles(files.filter(__pfxIsVideoFile), 'ref', hs);
              try { if (__pfxGetCurrentTimelineCutModel()) await __pfxApplyTimelineAsV1Reference(); } catch {}
            } else {
              await __pfxImportTimelineFilesForV1(files);
            }
            __pfxSyncRefImportRows();
            return;
          }
        }
        return;
      } catch (err) {
        if (String(err?.name || '') === 'AbortError') return;
      }
    }
    const input = (kind === 'video') ? refVideoInput : refTimelineInput;
    try { input.value = ''; } catch {}
    try {
      if (typeof input.showPicker === 'function') {
        input.showPicker();
      } else {
        input.click();
      }
    } catch {
      try { input.click(); } catch {}
    }
  };

  const __pfxBindRowPicker = (row, btn, kind) => {
    const onInvoke = (ev) => {
      try { if (ev && ev.target && ev.target.closest('.sm-importdock-remove')) return; } catch {}
      try { ev?.preventDefault?.(); } catch {}
      if (kind !== 'video' && kind !== 'timeline') return;
      void __pfxOpenRefPicker(kind);
    };
    try { btn.addEventListener('click', onInvoke); } catch {}
    try { row.addEventListener('click', onInvoke); } catch {}
    try { btn.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      try { if (ev.target && ev.target.closest('.sm-importdock-remove')) return; } catch {}
      // Help extension pages that sometimes swallow the first click.
      onInvoke(ev);
    }); } catch {}
    try { btn.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') onInvoke(ev);
    }); } catch {}
  };
  const __pfxOpenNativeInputFromUser = (input, ev) => {
    if (!input) return;
    try { if (ev && ev.target && ev.target.closest('.sm-importdock-remove')) return; } catch {}
    try { ev?.preventDefault?.(); } catch {}
    try { ev?.stopPropagation?.(); } catch {}
    try { input.value = ''; } catch {}
    try {
      if (typeof input.showPicker === 'function') {
        input.showPicker();
        return;
      }
    } catch {}
    try { input.click(); } catch {}
  };

  const __pfxBindNativeInputLabel = () => {};

  const __pfxBindDirectSyncPicker = (row, btn, input) => {
    if (!row || !btn || !input) return;
    const openNow = (ev) => {
      try { if (ev && ev.target && ev.target.closest('.sm-importdock-remove')) return; } catch {}
      try { if (ev && ev.target === input) return; } catch {}
      try { input.value = ''; } catch {}
      try { input.click(); } catch {}
    };
    try { row.addEventListener('click', openNow); } catch {}
    try { btn.addEventListener('click', openNow); } catch {}
    try { row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        openNow(ev);
      }
    }); } catch {}
    try { btn.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        openNow(ev);
      }
    }); } catch {}
  };

  // Use a direct synchronous input.click() from the user's click on the row/button.
  // This avoids extension-page issues where label/overlay wiring can fail to open the picker.

  refVideoImportRemove.addEventListener('click', () => {
    const clips = Array.isArray(store.state?.clips) ? store.state.clips : [];
    const tlIds = Array.isArray(store.state?.timelineClipIds) ? store.state.timelineClipIds : [];
    const refs = clips.filter((c) => {
      const b = String(c?.bin || '').toLowerCase();
      if (b === 'ref' || b === 'v1') return true;
      return tlIds.includes(c?.id);
    });
    refs.forEach((c) => { try { store.removeClip(c.id); } catch {} });
    try { store.clearAllV1Cuts(); } catch {}
    try { status.textContent = refs.length ? 'Removed V1 ref clip(s)' : 'No V1 ref clip'; } catch {}
    try { __pfxSaveAutosaveNow({ force: true }).catch(()=>{}); } catch {}
    __pfxSyncRefImportRows();
  });
  refTimelineImportRemove.addEventListener('click', () => {
    try { document.getElementById('smImportTimelineRemove')?.click(); } catch {}
    try { store.clearAllV1Cuts(); } catch {}
    try { status.textContent = 'Cleared timeline cut reference'; } catch {}
    __pfxSyncRefImportRows();
  });
  refVideoInput.addEventListener('change', async () => {
    const files = Array.from(refVideoInput.files || []).filter(__pfxIsVideoFile);
    refVideoInput.value = '';
    if (!files.length) return;
    await onDropFiles(files, 'ref');
    try { if (__pfxGetCurrentTimelineCutModel()) await __pfxApplyTimelineAsV1Reference(); } catch {}
    __pfxSyncRefImportRows();
  });
  refTimelineInput.addEventListener('change', async () => {
    const files = Array.from(refTimelineInput.files || []);
    refTimelineInput.value = '';
    if (!files.length) return;
    await __pfxImportTimelineFilesForV1(files);
    __pfxSyncRefImportRows();
  });
  __pfxBindImportDropRow(refVideoImportRow, 'video');
  __pfxBindImportDropRow(refTimelineImportRow, 'timeline');
  __pfxBindDirectSyncPicker(refVideoImportRow, refVideoImportBtn, refVideoInput);
  __pfxBindDirectSyncPicker(refTimelineImportRow, refTimelineImportBtn, refTimelineInput);
  try { window.addEventListener('mps:edl-timeline-updated', () => { try { __pfxSyncRefImportRows(); } catch {} try { __pfxSyncV1CutsButtons(); } catch {} }); } catch {}
  try { window.addEventListener('pfx:imported-timeline-model-updated', () => { try { __pfxSyncRefImportRows(); } catch {} try { __pfxSyncV1CutsButtons(); } catch {} }); } catch {}

  // ── VISUAL QC NLE keyboard state (JKL shuttle) ──────────────────────────
  let _rvKHeld      = false;
  let _rvRevActive  = false;
  let _rvRevRafId   = null;
  let _rvRevLastTs  = 0;
  let _rvRevSpeed   = 1;
  let _rvFwdSpeed   = 0;
  const _RV_SHUTTLE = [0.25, 0.5, 1, 2, 4, 8, 16];
  const _RV_MID     = 2;
  let _rvShuttleIdx = _RV_MID;

  function _rvGetFps() { try { return Number(store.state?.fps) || 24; } catch { return 24; } }

  function _rvUpdateHud(msg) {
    let el = document.getElementById('rvKbHint');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rvKbHint'; el.className = 'cd-kb-hint';
      document.body.appendChild(el);
    }
    if (msg) {
      el.textContent = msg;
      el.classList.add('cd-kb-hint-show');
      clearTimeout(el._t);
      el._t = setTimeout(() => el.classList.remove('cd-kb-hint-show'), 1100);
    }
  }

  function _rvStopReverse() {
    _rvRevActive = false;
    if (_rvRevRafId) { cancelAnimationFrame(_rvRevRafId); _rvRevRafId = null; }
  }

  function _rvRevTick(ts) {
    if (!_rvRevActive) return;
    const vid = player?.active;
    if (!vid) { _rvStopReverse(); return; }
    if (_rvRevLastTs) {
      const elapsed = ts - _rvRevLastTs;
      const fps     = _rvGetFps();
      const frames  = (elapsed / (1000 / fps)) * _rvRevSpeed;
      const newT    = Math.max(0, vid.currentTime - frames / fps);
      try { vid.currentTime = newT; } catch {}
      if (newT <= 0) { _rvStopReverse(); _rvUpdateHud(''); return; }
    }
    _rvRevLastTs = ts;
    _rvRevRafId  = requestAnimationFrame(_rvRevTick);
  }

  function _rvStartReverse(speed) {
    _rvStopReverse();
    try { player.pause(); } catch {}
    _rvRevSpeed = speed; _rvRevLastTs = 0; _rvRevActive = true;
    _rvRevRafId = requestAnimationFrame(_rvRevTick);
  }

  function _rvJklStop() {
    _rvStopReverse(); _rvFwdSpeed = 0; _rvShuttleIdx = _RV_MID;
    try { player.pause(); } catch {}
    try { if (player.active) player.active.playbackRate = 1; } catch {}   // clear leftover shuttle rate
    _rvUpdateHud('⏹ Stop');
  }

  function _rvJklL() {
    _rvStopReverse();
    if (_rvFwdSpeed === 0) { _rvShuttleIdx = _RV_MID; }
    else { _rvShuttleIdx = Math.min(_RV_SHUTTLE.length - 1, _rvShuttleIdx + 1); }
    _rvFwdSpeed = _RV_SHUTTLE[_rvShuttleIdx];
    const vid = player?.active;
    if (!vid) return;
    try { vid.playbackRate = _rvFwdSpeed; } catch {}
    try { vid.play(); } catch {}
    _rvUpdateHud(`▶ ×${_rvFwdSpeed < 1 ? _rvFwdSpeed.toFixed(2).replace(/\.?0+$/,'') : _rvFwdSpeed}`);
  }

  function _rvJklJ() {
    const vid = player?.active;
    if (!vid) return;
    if (_rvFwdSpeed > 0) {
      try { vid.playbackRate = 1; } catch {}
      try { player.pause(); } catch {}
      _rvFwdSpeed = 0; _rvShuttleIdx = _RV_MID;
      _rvStartReverse(1); _rvUpdateHud('◀ ×1');
    } else if (_rvRevActive) {
      _rvRevSpeed = Math.min(16, _rvRevSpeed * 2);
      _rvStopReverse(); _rvStartReverse(_rvRevSpeed);
      _rvUpdateHud(`◀ ×${_rvRevSpeed}`);
    } else {
      _rvStartReverse(1); _rvUpdateHud('◀ ×1');
    }
  }

  // Keyboard shortcuts
  const onKey = async (e) => {
    const tag = (e.target && e.target.tagName) ? String(e.target.tagName).toUpperCase() : '';
    const isForm = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    // Allow exiting text edit with Escape / Ctrl+Enter.
    if (isForm) {
      if (e.key === 'Escape') {
        e.preventDefault();
        try { e.target.blur(); } catch {}
        // If Notes panel is open, return focus to Notes; otherwise Timeline.
        try {
          if (root.classList.contains('is-notes-open')) setKeyFocus('notes');
          else setKeyFocus('timeline');
        } catch {}
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        try { e.target.blur(); } catch {}
        try { setKeyFocus('notes'); } catch {}
        return;
      }
      return;
    }

    // ===== Bin keyboard navigation (mouse-free) =====
    // Tab: cycle focus (Bin -> Source -> Timeline -> Notes)
    // / or Ctrl/Cmd+F: focus Bin search
    // Up/Down: select prev/next clip in Bin
    // Enter: load selected clip into Source
    // 1: append selected clip to V1 timeline
    // 2: add selected clip as V2 overlay at playhead (V2 is always muted)
    // Delete/Backspace: remove selected clip from Bin
    if (e.key === 'Tab') {
      e.preventDefault();
      const order = ['bin', 'source', 'timeline', 'notes'];
      const idx = Math.max(0, order.indexOf(keyFocus));
      setKeyFocus(order[(idx + 1) % order.length]);
      return;
    }

    if (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f')) {
      e.preventDefault();
      setKeyFocus('bin');
      try { setBinOpen(true); } catch {}
      try { clipsSearch.focus(); clipsSearch.select(); } catch {}
      return;
    }

    if (keyFocus === 'bin') {
      try { setBinOpen(true); } catch {}
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        stepBinSelection(-1);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        stepBinSelection(1);
        return;
      }

      // Smart groups: expand/collapse versions
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || (e.key || '').toLowerCase() === 'e') {
        const id = pinnedBinClipId || binVisibleIds[0];
        const gk = id ? binClipToGroup.get(id) : null;
        if (gk) {
          e.preventDefault();
          const wantToggle = (e.key || '').toLowerCase() === 'e' && !e.shiftKey;
          if (wantToggle) {
            toggleGroupOpen(gk);
            return;
          }
          // Shift+E: expand/collapse all visible groups
          if ((e.key || '').toLowerCase() === 'e' && e.shiftKey) {
            const keys = Array.from(clipsBody.querySelectorAll('.pfx-reviews-clipRow.is-group'))
              .map(r => r.dataset.groupKey)
              .filter(Boolean);
            const anyClosed = keys.some(k => !binOpenGroups.has(k));
            if (anyClosed) keys.forEach(k => binOpenGroups.add(k));
            else keys.forEach(k => binOpenGroups.delete(k));
            saveBinOpenGroups();
            refreshClipsList();
            return;
          }
          if (e.key === 'ArrowRight') {
            setGroupOpen(gk, true);
            return;
          }
          if (e.key === 'ArrowLeft') {
            setGroupOpen(gk, false);
            return;
          }
        }
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        const id = pinnedBinClipId || binVisibleIds[0];
        if (id) selectBinClipId(id, { pin: true, scroll: true });
        return;
      }
      if (e.key === '1') {
        e.preventDefault();
        const id = pinnedBinClipId || binVisibleIds[0];
        if (!id) return;
        store.appendToTimeline(id);
        return;
      }
      if (e.key === '2') {
        e.preventDefault();
        const id = pinnedBinClipId || binVisibleIds[0];
        if (!id) return;
        const t = Math.max(0, Number(store.state.globalTimeSec) || 0);
        await addOverlayWithAutoNote(id, t, {}, 'v2_add_kb');
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        const id = pinnedBinClipId || binVisibleIds[0];
        if (!id) return;
        store.removeClip(id);
        return;
      }
    }

    // ===== Notes keyboard navigation (mouse-free) =====
    // N: toggle Notes open/close (already)
    // Up/Down: select prev/next note
    // Enter: jump playhead to note time
    // E: edit note text (focus textarea)
    // A: annotate thumbnail (if available)
    // 1/2/3: set status (APPROVED / NEED FIX / clear)
    // Delete/Backspace: delete selected note
    if (keyFocus === 'notes') {
      try { setNotesOpen(true); } catch {}

      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        await stepNotesSelection(-1, { jump: true });
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        await stepNotesSelection(1, { jump: true });
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        await jumpToNotesBoundary('start');
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        await jumpToNotesBoundary('end');
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const sel = store.getSelectedMarker();
        if (sel) {
          await scrubTo(sel.globalTimeSec);
          try { timeline.jumpToTime(sel.globalTimeSec); } catch {}
        }
        return;
      }
      if ((e.key || '').toLowerCase() === 'e') {
        e.preventDefault();
        try { markerNote.focus(); markerNote.select(); } catch {}
        return;
      }
      if ((e.key || '').toLowerCase() === 'a') {
        e.preventDefault();
        const sel = store.getSelectedMarker();
        if (sel && sel.thumbDataUrl) openAnnotateModal(sel.id);
        return;
      }
      if (e.key === '1' || e.key === '2' || e.key === '3') {
        e.preventDefault();
        const map = { '1': 'APPROVED', '2': 'NEED_FIX', '3': '' };
        setSelectedMarkerStatus(map[e.key] || '');
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        const sel = store.getSelectedMarker();
        if (sel) {
          try{ if (typeof window._pmDeleteAnnotForMarker === 'function') window._pmDeleteAnnotForMarker(sel); }catch{}
          store.removeMarker(sel.id);
        }
        return;
      }
    }

    // Timeline focus: Delete removes clip from V1 timeline ONLY (keeps it in Bin)
    if (keyFocus === 'timeline' && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      store.removeTimelineSegment(store.state.activeIndex);
      return;
    }

    // Timeline focus: Home/End navigation + Zoom controls (Ref-style)
    if (keyFocus === 'timeline' && (e.key === 'Home' || e.key === 'End')) {
      e.preventDefault();
      if (e.key === 'Home') await goHome();
      else await goEnd();
      return;
    }

    // Zoom in/out: + / - , Fit: * (common in timeline editors)
    if (keyFocus === 'timeline' && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '*')) {
      e.preventDefault();
      if (e.key === '-' ) zoomBy(1 / 1.25);
      else if (e.key === '*') zoomFit();
      else zoomBy(1.25);
      return;
    }

    // Timeline focus: V1 Auto Cut edit shortcuts
    // Hidden/disabled when the V1 cut tool dock is removed from the UI.
    if (PFX_V1_CUT_TOOLS_VISIBLE && keyFocus === 'timeline' && (((e.key || '').toLowerCase() === 's') || ((e.key || '').toLowerCase() === 'm') || e.key === '[' || e.key === ']' || ((e.key || '').toLowerCase() === 'u'))) {
      const keyLower = (e.key || '').toLowerCase();
      const editableCut = __pfxResolveEditableV1Cut();
      const preferV1CutEdit = !!editableCut && (store.state.activeLayer !== 'V2' || !store.state.activeOverlayId);
      if (keyLower === 's') {
        e.preventDefault();
        await __pfxDoV1Split();
        return;
      }
      if (keyLower === 'm') {
        e.preventDefault();
        if (e.shiftKey) await __pfxDoV1MergeNext();
        else await __pfxDoV1MergePrev();
        return;
      }
      if (keyLower === 'u' && editableCut) {
        e.preventDefault();
        __pfxDoV1ToggleUncertain();
        return;
      }
      if (e.shiftKey && e.key === '<') {
        e.preventDefault();
        await __pfxJumpUnsure(-1);
        return;
      }
      if (e.shiftKey && e.key === '>') {
        e.preventDefault();
        await __pfxJumpUnsure(1);
        return;
      }
      if ((e.key === '[' || e.key === ']') && preferV1CutEdit) {
        e.preventDefault();
        const amt = e.shiftKey ? 5 : 1;
        await __pfxDoV1Nudge(e.key === '[' ? -amt : amt);
        return;
      }
    }

    // Timeline focus: V2 version cycling (smart replace)
    // [  = previous version, ] = next version (for active V2 overlay under playhead)
    if (keyFocus === 'timeline' && (e.key === '[' || e.key === ']')) {
      const ovlId = store.state.activeOverlayId;
      if (!ovlId) return;
      e.preventDefault();
      store.cycleOverlayVersion(ovlId, e.key === ']' ? 1 : -1);
      syncOverlayToState('v2_ver_kb');
      return;
    }

    // ? : toggle shortcut overlay
    if (e.key === '?' || (e.shiftKey && e.key === '/')) {
      e.preventDefault();
      _reviewsToggleKbOverlay();
      return;
    }

    // ===== Pro NLE-style shortcuts (Timeline as primary) =====
    // Space / K: Play-Pause
    // J / L: Step 1 frame (Shift = 10)
    // , / .  or  Up / Down: Previous/Next clip
    // I / O: Source IN/OUT
    // Enter: Push Source I/O range to V2 at playhead
    const k = (e.key || '').toLowerCase();

    if (k === 'k') {
      e.preventDefault();
      _rvKHeld = true;
      _rvJklStop();
      return;
    }

    if (k === 'j') {
      e.preventDefault();
      if (_rvKHeld) { await player.stepFrames(-1); _rvUpdateHud('◀ −1 fr'); }
      else _rvJklJ();
      return;
    }

    if (k === 'l') {
      e.preventDefault();
      if (_rvKHeld) { await player.stepFrames(1); _rvUpdateHud('▶ +1 fr'); }
      else _rvJklL();
      return;
    }

    if (e.key === ',') {
      e.preventDefault();
      await player.prevClip();
      try { timeline.jumpToTime(store.state.globalTimeSec); } catch {}
      return;
    }

    if (e.key === '.') {
      e.preventDefault();
      await player.nextClip();
      try { timeline.jumpToTime(store.state.globalTimeSec); } catch {}
      return;
    }
    // Timeline focus: Up/Down = previous/next V1 clip. Shift+Up/Down = previous/next V2 overlay clip (wraps).
    if (keyFocus === 'timeline' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      // Shift+Up/Down: V2 overlay navigation
      if (e.shiftKey) {
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? -1 : 1;
        const ovs = (store.state.overlays || []).slice().sort((a, b) => {
          const da = Number(a?.globalStartSec) || 0;
          const db = Number(b?.globalStartSec) || 0;
          if (da !== db) return da - db;
          return String(a?.id || '').localeCompare(String(b?.id || ''));
        });
        if (!ovs.length) return;

        const t = Math.max(0, Number(store.state.globalTimeSec) || 0);
        const curO = (typeof store.overlayAtTime === 'function') ? store.overlayAtTime(t) : null;
        const curStart = curO ? (Number(curO.globalStartSec) || 0) : t;
        const EPS = 1e-6;

        let target = null;
        if (dir < 0) {
          for (let i = ovs.length - 1; i >= 0; i--) {
            const s = Number(ovs[i]?.globalStartSec) || 0;
            if (s < (curStart - EPS)) { target = ovs[i]; break; }
          }
          if (!target) target = ovs[ovs.length - 1];
        } else {
          for (let i = 0; i < ovs.length; i++) {
            const s = Number(ovs[i]?.globalStartSec) || 0;
            if (s > (curStart + EPS)) { target = ovs[i]; break; }
          }
          if (!target) target = ovs[0];
        }

        const tt = Math.max(0, Number(target?.globalStartSec) || 0);
        await scrubTo(tt);
        try { timeline.jumpToTime(tt); } catch {}

        // Auto-select matching note (if exists)
        try {
          const fps = Math.max(1, Number(store.state.fps) || 24);
          const tol = 2 / fps;
          const m = (store.state.markers || []).find(mm => mm && mm.layer === 'V2' && mm.clipId === target.clipId && Math.abs((Number(mm.globalTimeSec) || 0) - tt) < tol);
          if (m) store.selectMarker(m.id);
        } catch {}
        return;
      }

      // Up/Down: V1 clip navigation
      e.preventDefault();
      if (e.key === 'ArrowUp') await player.prevClip();
      else await player.nextClip();
      try { timeline.jumpToTime(store.state.globalTimeSec); } catch {}
      return;
    }

    if (k === 'i') {
      e.preventDefault();
      sourceInSec = Math.max(0, Number(videoSrc?.currentTime) || 0);
      if (sourceOutSec != null && sourceOutSec < sourceInSec) {
        const tmp = sourceOutSec;
        sourceOutSec = sourceInSec;
        sourceInSec = tmp;
      }
      syncSourceReadout();
      return;
    }

    if (k === 'o') {
      e.preventDefault();
      sourceOutSec = Math.max(0, Number(videoSrc?.currentTime) || 0);
      if (sourceInSec != null && sourceOutSec < sourceInSec) {
        const tmp = sourceInSec;
        sourceInSec = sourceOutSec;
        sourceOutSec = tmp;
      }
      syncSourceReadout();
      return;
    }

    if (e.key === 'Enter') {
      const clipId = videoSrc?.dataset?.clipId;
      if (!clipId) return;
      e.preventDefault();
      const t = Math.max(0, Number(store.state.globalTimeSec) || 0);
      const fps = Number(store.state.fps) || 24;
      const minDur = 1 / fps;
      const inSec = Math.max(0, Number(sourceInSec) || 0);
      let outSec = sourceOutSec == null ? null : Math.max(0, Number(sourceOutSec) || 0);
      let dur = null;
      if (outSec != null) dur = Math.max(minDur, outSec - inSec);
      await addOverlayWithAutoNote(clipId, t, { inSec, durationSec: dur }, 'v2_from_io');
      return;
    }

    // User-configurable shortcuts (Settings → Keyboard Shortcuts)
    // Keep Reviews' richer NLE mapping below as fallback.
    try {
      const act = resolveShortcutAction(e, ['play_toggle','viewer_fullscreen'], { cfg: getShortcutsConfig() });
      if (act === 'play_toggle') {
        e.preventDefault();
        player.toggle();
        return;
      }
      if (act === 'viewer_fullscreen') {
        e.preventDefault();
        await toggleFullscreen();
        try { timeline.jumpToTime(store.state.globalTimeSec); } catch {}
        return;
      }
    } catch {}

    if (e.code === 'Space') {
      e.preventDefault();
      player.toggle();
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault(); _rvJklStop();
      if      (e.shiftKey && e.altKey) { await player.stepFrames(-_rvGetFps()*10); _rvUpdateHud('◀◀◀ −10s'); }
      else if (e.shiftKey)             { await player.stepFrames(-_rvGetFps());     _rvUpdateHud('◀◀ −1s');   }
      else if (e.altKey)               { await player.stepFrames(-_rvGetFps()*5);   _rvUpdateHud('◀◀◀ −5s');  }
      else                             { await player.stepFrames(-1);               _rvUpdateHud('◀ −1 fr');  }
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault(); _rvJklStop();
      if      (e.shiftKey && e.altKey) { await player.stepFrames(_rvGetFps()*10);  _rvUpdateHud('▶▶▶ +10s'); }
      else if (e.shiftKey)             { await player.stepFrames(_rvGetFps());      _rvUpdateHud('▶▶ +1s');   }
      else if (e.altKey)               { await player.stepFrames(_rvGetFps()*5);    _rvUpdateHud('▶▶▶ +5s');  }
      else                             { await player.stepFrames(1);                _rvUpdateHud('▶ +1 fr');  }
    }
    // Marker hotkey removed (notes are auto-created on V2 overlay add).


    // Single-letter QC shortcuts must NOT fire with Cmd/Ctrl/Alt held, or they
    // hijack OS/browser combos (Cmd+V paste, Cmd+N, Cmd+F, Cmd+W, Cmd+G…).
    const _qcPlain = !e.metaKey && !e.ctrlKey && !e.altKey;
    // QC tools: D=Diff, W=Wipe, X=Blink, G=Gamma
    if (_qcPlain && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      try { btnDiff.click(); } catch {}
      return;
    }
    if (_qcPlain && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      try { btnWipe.click(); } catch {}
      return;
    }
    if (_qcPlain && e.key.toLowerCase() === 'x') {
      e.preventDefault();
      try { btnBlink.click(); } catch {}
      return;
    }
    if (_qcPlain && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      try { btnGamma.click(); } catch {}
      return;
    }
    if (_qcPlain && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      await toggleFullscreen();
      try { timeline.jumpToTime(store.state.globalTimeSec); } catch {}
    }

    if (_qcPlain && e.key.toLowerCase() === 'p') {
      // Panel hiding disabled in Visual QC.
      e.preventDefault();
      return;
    }

    if (_qcPlain && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      setPanelsHidden(false);
      setBinOpen(true);
      setKeyFocus('bin');
      return;
    }

    if (_qcPlain && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      setPanelsHidden(false);
      setNotesOpen(true);
      setKeyFocus('notes');
      return;
    }

    // View toggle: v = Timeline-only, Shift+v = Source-only
    if (_qcPlain && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      if (isUiLocked()) return;
      if (e.shiftKey) {
        setViewMode(viewMode === 'source' ? 'dual' : 'source');
      } else {
        setViewMode(viewMode === 'timeline' ? 'dual' : 'timeline');
      }
    }

    if (e.key === 'Escape') {
      if (__pfxRoiDrawMode) {
        e.preventDefault();
        __pfxSetRoiDrawMode(false);
        try { status.textContent = 'Draw ROI closed.'; } catch {}
        return;
      }
      // Exit fullscreen / cinema
      if (_isFullscreen() || cinemaFallback) {
        e.preventDefault();
        await toggleFullscreen();
      }
    }

    if (__pfxRoiDrawMode && (e.key === 'Delete' || e.key === 'Backspace')) {
      const cur = __pfxGetCurrentRoiRegions();
      const idx = __pfxGetSelectedRoiIndex();
      if (idx >= 0 && idx < cur.length) {
        e.preventDefault();
        cur.splice(idx, 1);
        __pfxRoiEditSession = null;
        __pfxSelectedRoiIndex = cur.length ? Math.min(idx, cur.length - 1) : -1;
        __pfxCommitViewerRoiRegions(cur, `Custom ROI updated ({n} region${cur.length === 1 ? '' : 's'}).`);
        __pfxRenderViewerRoiOverlay();
        try { status.textContent = 'Selected ROI removed.'; } catch {}
        return;
      }
    }

    if (__pfxRoiDrawMode && !e.metaKey && !e.ctrlKey && !e.altKey && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
      const step = e.shiftKey ? 0.02 : 0.005;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (__pfxNudgeViewerRoi(dx, dy, 0, 0)) {
        e.preventDefault();
        try { status.textContent = 'ROI nudged.'; } catch {}
        return;
      }
    }

    if (__pfxRoiDrawMode && !e.metaKey && !e.ctrlKey && e.altKey && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
      const step = e.shiftKey ? 0.02 : 0.005;
      const dw = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dh = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (__pfxNudgeViewerRoi(0, 0, dw, dh)) {
        e.preventDefault();
        try { status.textContent = 'ROI resized.'; } catch {}
        return;
      }
    }
  };
  // ── VISUAL QC keyboard shortcut overlay ─────────────────────────────────
  function _reviewsToggleKbOverlay() {
    let ov = document.getElementById('reviewsKbOverlay');
    if (ov) { ov.remove(); return; }
    ov = document.createElement('div');
    ov.id = 'reviewsKbOverlay'; ov.className = 'tcf-kb-overlay';
    ov.innerHTML = `
      <div class="tcf-kb-overlay-box">
        <div class="tcf-kb-overlay-title">VISUAL QC Keyboard Shortcuts <span class="tcf-kb-overlay-close">✕</span></div>
        <div class="tcf-kb-overlay-grid">
          <div class="tcf-kb-section">Playback</div><div></div>
          <kbd>Space</kbd><span>Play / Pause</span>
          <kbd>K</kbd><span>Stop</span>
          <kbd>L</kbd><span>Play forward (press again = faster)</span>
          <kbd>J</kbd><span>Play reverse (press again = faster)</span>
          <kbd>K</kbd>+<kbd>L</kbd><span>Step +1 frame (hold K)</span>
          <kbd>K</kbd>+<kbd>J</kbd><span>Step −1 frame (hold K)</span>
          <div class="tcf-kb-section">Navigation</div><div></div>
          <kbd>,</kbd><span>Previous clip</span>
          <kbd>.</kbd><span>Next clip</span>
          <kbd>↑</kbd><span>Previous V1 clip</span>
          <kbd>↓</kbd><span>Next V1 clip</span>
          <kbd>Shift+↑</kbd><span>Previous V2 overlay</span>
          <kbd>Shift+↓</kbd><span>Next V2 overlay</span>
          <div class="tcf-kb-section">Markers / Edit</div><div></div>
          <kbd>I</kbd><span>Set Source In point</span>
          <kbd>O</kbd><span>Set Source Out point</span>
          <kbd>Enter</kbd><span>Push Source I/O range to V2 at playhead</span>
          <div class="tcf-kb-section">View</div><div></div>
          <kbd>F</kbd><span>Toggle fullscreen</span>
          <kbd>?</kbd><span>Toggle this overlay</span>
        </div>
      </div>`;
    ov.addEventListener('click', ev => {
      if (ev.target.closest('.tcf-kb-overlay-close') || ev.target === ov) ov.remove();
    });
    document.body.appendChild(ov);
  }
  btnKbHelp.addEventListener('click', _reviewsToggleKbOverlay);

  // Visual QC Tutorial close button (open is handled by global #btnTutorial)
  document.getElementById('btnReviewsTutorialClose')?.addEventListener('click', () => {
    const m = document.getElementById('reviewsTutorialModal');
    if (m) m.style.display = 'none';
  });

  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', e => { if (e.key === 'k' || e.key === 'K') _rvKHeld = false; });

  const onFsChange = () => applyFsState();
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  // React to store changes
  const unsub = store.subscribe((_, action) => {
    const needsAutosave = action === 'clips' || action === 'clips_added' || action === 'overlays' || action === 'markers' || action === 'import' || action === 'cuts';
    if (needsAutosave) {
      try { __pfxScheduleAutosave(); } catch {}
      try { window.MPS_markProjectDirty?.('reviews'); } catch {}
    }

    const needsFullClipsRefresh = action === 'clips' || action === 'clips_added' || action === 'overlays' || action === 'cuts' || action === 'import';
    if (needsFullClipsRefresh) {
      const keepFit = btnFitTL?.dataset?.fitState === 'fitted';
      refreshClipsList();
      syncOverlayToState(action);
      try { syncProgramReadout(); } catch {}
      if (keepFit) { try { zoomFit(); } catch {} }
      try { updateZoomPct(); } catch {}
      try { __pfxSyncV1CutsButtons(); } catch {}
      try { __pfxRenderV1CutDock(); } catch {}
      try { syncTimelineHandleState(); } catch {}

      if (action === 'overlays') {
        try {
          const sel = store.getSelectedMarker?.();
          if (sel && String(sel.layer || '') === 'V2') {
            captureV2ThumbAsync(sel.id, sel.globalTimeSec);
          }
        } catch {}
      }
    } else if (action === 'active') {
      syncClipsListActiveState();
      syncOverlayToState(action);
      try { syncProgramReadout(); } catch {}
      try { __pfxSyncV1CutsButtons(); } catch {}
      try { __pfxRenderV1CutDock(); } catch {}
      try { syncTimelineHandleState(); } catch {}
    }

    if (action === 'time') {
      syncOverlayToState('time');
      try { syncProgramReadout(); } catch {}
      try { syncTimelineHandleState(); } catch {}
    }

    if (action === 'markers' || action === 'import') {
      refreshMarkersList();
      try { __pfxScheduleHydrateThumbs({ delay: action === 'import' ? 80 : 40 }); } catch {}
    }

    if (action === 'marker_select') {
      syncSelectedMarkerUI({ scrollIntoView: true });
      try { __pfxScheduleHydrateThumbs({ delay: 20 }); } catch {}
    }

    if (action === 'play') {
      btnPlay.textContent = store.state.isPlaying ? '❚❚' : '▶';
      syncOverlayToState('play');
      try { syncProgramReadout(); } catch {}
    }

    if (action === 'fps') {
      status.textContent = `FPS = ${store.state.fps}`;
      try { syncProgramReadout(); } catch {}
      try { syncSourceReadout(); } catch {}
    }

    if (action === 'zoom') {
      try { zoom.value = String(store.state.pxPerSec); } catch {}
      try { updateZoomPct(); } catch {}
    }
  });

  // Initial render
  refreshClipsList();
  refreshMarkersList();
  try{ __pfxScheduleHydrateThumbs(120); }catch{}
  syncOverlayToState('init');
  try { btnPlay.textContent = store.state.isPlaying ? '❚❚' : '▶'; } catch {}
  try { syncProgramReadout(); } catch {}
  try { syncTimelineHandleState(); } catch {}
  try { updateZoomPct(); } catch {}

  // Visual QC: lock the layout on refresh/reload.
  // Always start in Dual view (Source + Timeline), regardless of any previously stored preference.
  try { setViewMode('dual'); } catch {}

  // Visual QC: panels are always visible (no hide/collapse).
  try {
    setBinOpen(true);
    setNotesOpen(true);
    setPanelsHidden(false);
  } catch {}

  // Autosave is enabled immediately; empty states are never saved (see __pfxSaveAutosaveNow).
  try{ __pfxAutosaveEnabled = true; }catch{}

// After UI is mounted, try a second-chance autosave restore.
  // This prevents a race where async restore completes before listeners/UI are ready (leaving the Bin visually empty).
  try{
    setTimeout(async () => {
      try{
        const hasClips = Array.isArray(store.state?.clips) && store.state.clips.length;
        const hasMarkers = Array.isArray(store.state?.markers) && store.state.markers.length;
        if (hasClips && hasMarkers) return;
        let ok = await __pfxTryRestoreAutosave();
        let ok2 = await __pfxTryRestoreNotesOnly();
        if (!ok && !ok2) {
          try{ await new Promise(r => setTimeout(r, 450)); }catch{}
          try{ ok = await __pfxTryRestoreAutosave(); }catch{}
          try{ ok2 = await __pfxTryRestoreNotesOnly(); }catch{}
        }
        if (ok || ok2) {
          try{ refreshClipsList(); }catch{}
          try{ refreshMarkersList(); }catch{}
          try{ syncOverlayToState('import'); }catch{}
          // Relink triggered automatically via relinkMgr store.subscribe('import').
        }
      }catch{}
    }, 120);
  }catch{}

  const onVisibilityPause = () => {
    if (!document.hidden) return;
    try { player.pause(); } catch (_) {}
    try { stopBlink(); } catch (_) {}
  };
  document.addEventListener('visibilitychange', onVisibilityPause, { passive: true });

  return {
    store,
    pause: () => { try{ player.pause(); }catch(_){} },
    /** Called from a user-gesture context (e.g. tab click) so requestPermission can show a dialog. */
    relinkWithPermission: () => {
      // Delegates to relinkMgr.run({ request:true }) — runs immediately so requestPermission
      // can fire within the browser's user-activation window.
      try{ relinkMgr.run({ request: true }); }catch{}
    },
    destroy: () => {
      // Stop any active reverse-playback RAF loop
      try{ _rvStopReverse(); }catch{}
      // Flush autosave on close
      try{ __pfxSaveAutosaveNow(); }catch{}
      window.removeEventListener('keydown', onKey);
      // Remove scrub-overlay pointerup safety listeners
      try{ window.removeEventListener('pointerup', hideSrcOverlay); }catch{}
      try{ window.removeEventListener('pointerup', hideOverlay); }catch{}
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
      document.removeEventListener('visibilitychange', onVisibilityPause);
      try { if (__pfxHydrateThumbsTimer) clearTimeout(__pfxHydrateThumbsTimer); } catch (_) {}
      try { if (__pfxMarkerListScrollTimer) clearTimeout(__pfxMarkerListScrollTimer); } catch (_) {}
      try{ relinkMgr.destroy(); }catch{}
      unsub();
      timeline.destroy();
      player.destroy();
      try { stopBlink(); } catch (_) {}
      try { overlayCtl.dispose(); } catch (_) {}
      try { if (overlayTickStop) overlayTickStop(); } catch (_) {}
      try { videoV2.pause(); } catch (_) {}

      // Stop any pending thumbnail capture jobs (prevents wrong-event updates after close)
      try { __thumbCapDestroyed = true; } catch (_) {}
      try { __thumbCapQueue = []; __thumbCapRunning = false; } catch (_) {}
      try {
        if (__thumbCapVid) {
          try { __thumbCapVid.pause(); } catch (_) {}
          try { __thumbCapVid.removeAttribute('src'); } catch (_) {}
          try { __thumbCapVid.load(); } catch (_) {}
          try { __thumbCapVid.remove(); } catch (_) {}
        }
      } catch (_) {}
      try { document.removeEventListener('contextmenu', onViewerContextTools, true); } catch (_) {}
      try { document.removeEventListener('pointerdown', onViewerContextToolsPointer, true); } catch (_) {}
      try { viewer.removeEventListener('contextmenu', onViewerContextTools, true); } catch (_) {}
      try { videoA.removeEventListener('contextmenu', onViewerContextTools, true); } catch (_) {}
      try { videoB.removeEventListener('contextmenu', onViewerContextTools, true); } catch (_) {}
      try { videoV2.removeEventListener('contextmenu', onViewerContextTools, true); } catch (_) {}
      try { sourceViewer.removeEventListener('contextmenu', onViewerContextTools, true); } catch (_) {}
      try { timelineWrap?.removeEventListener?.('contextmenu', onViewerContextTools, true); } catch (_) {}
      try { __pfxCtxTools.destroy(); } catch (_) {}

      // Notes list context menu
      try { __pfxMarkerCtxDestroy(); } catch (_) {}

      try { __thumbCapVid = null; } catch (_) {}

      root.remove();
      fileInput.remove();
      try { relinkInput.remove(); } catch (_) {}
    },
    __ok: true,
  };
  }catch(err){
    console.error('Visual QC (Reviews) mount failed', err);
    __setBootError(err);
    return {
      store,
      pause: () => {},
      destroy: () => { try{ __boot.remove(); }catch{} },
      __ok: false,
    };
  }
}
