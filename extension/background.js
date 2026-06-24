// background.js — MV3 service worker (module)
// ================================================================
// PostFlowX
// - Opens index.html in a new tab when clicking the extension icon
// - Option 2: Native Host bridge for exporting After Effects .aep
//   via Chrome Native Messaging (host: com.mps.ae_bridge)
// - AAF Import (Native Host): upload .aaf in chunks → host parses → returns
//   normalized events JSON for the EDL Converter + CUT DiFF.
//
// Expected host response examples:
//   { type:'AE_BUILD_START', requestId, message, step }
//   { type:'AE_BUILD_PROGRESS', requestId, pct, status, step }
//   { type:'AE_BUILD_LOG', requestId, line }
//   { type:'AE_BUILD_DONE', requestId, ok:true, bytesBase64:'...', fileName:'VFX_Project.aep' }
//   { type:'AE_BUILD_ERROR', requestId, ok:false, error:'...' }
// ================================================================

const UI_URL = chrome.runtime.getURL("index.html");
// Native Messaging Host for AE Project (.aep) export and related bridge tasks.
// Enabled in this build so the extension can request one-click .aep builds via the native AE bridge.
const NATIVE_HOST = "com.mps.ae_bridge";
const NATIVE_HOST_ENABLED = true;
const IMF_COMPANION_HOST = "com.postflowx.companion";
const imfCompanionState = { port: null, pending: new Map(), seq: 0 };
let imfOffscreenEnsurePromise = null;
const PFX_REOPEN_AFTER_CLEAR_KEY = "mps.reopenAfterClear.v1";

// ------------------------------
// Update Version (Google Drive)
// ------------------------------
// User-provided Google Drive update sources.
// - Update button opens the Current Version folder.
// - Latest version is read from the direct manifest.json Google Drive file link (with folder fallback).
const UPDATE_FOLDER_URL = "https://drive.google.com/drive/folders/1vBRSps03hPgijUhzP-39OpMu2tJ-zQOV?usp=drive_link";
const UPDATE_MANIFEST_FOLDER_URL = "https://drive.google.com/drive/folders/10SukU7ndaHa7f0qf33SSBYRDOdtd_N2l?usp=drive_link";
const UPDATE_MANIFEST_FILE_URL = "https://drive.google.com/file/d/1e5U7pvO_llQW-ooS2Fky-_pKIiRAkTFv/view?usp=sharing";
const UPDATE_MANIFEST_PATH = "manifest.json";
const UPDATE_MANIFEST_FILE_ID = "1e5U7pvO_llQW-ooS2Fky-_pKIiRAkTFv";

const UPDATE_PREVIEW_URL = (fileId) =>
  `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;

function extractDriveFileId(raw){
  const src = String(raw || "").trim();
  if (!src) return "";
  const direct = src.match(/^[A-Za-z0-9_-]{20,}$/);
  if (direct) return direct[0];
  const patterns = [
    /\/file\/d\/([A-Za-z0-9_-]{20,})/i,
    /[?&]id=([A-Za-z0-9_-]{20,})/i,
    /[?&]resourcekey=([A-Za-z0-9_-]{20,})/i
  ];
  for (const re of patterns){
    const m = src.match(re);
    if (m && m[1]) return m[1];
  }
  return "";
}


// ------------------------------
// Preflight Validator shared state helpers
// ------------------------------
const PFX_SETTINGS_DEFAULTS = {
  profile: "final_delivery",
  projectName: "",
  selectedCategories: null,
  locale: "en"
};

function pfxStorageGet(keys){
  return new Promise((resolve) => {
    try{ chrome.storage.local.get(keys, (res) => resolve(res || {})); }
    catch(_){ resolve({}); }
  });
}

function pfxStorageSet(obj){
  return new Promise((resolve) => {
    try{ chrome.storage.local.set(obj, () => resolve(true)); }
    catch(_){ resolve(false); }
  });
}

function pfxStorageRemove(keys){
  return new Promise((resolve) => {
    try{ chrome.storage.local.remove(keys, () => resolve(true)); }
    catch(_){ resolve(false); }
  });
}

async function pfxGetStateBundle(){
  const data = await pfxStorageGet(["pfx_settings", "pfx_runs", "pfx_last_run"]);
  const nextSettings = {
    ...PFX_SETTINGS_DEFAULTS,
    ...(data && data.pfx_settings && typeof data.pfx_settings === "object" ? data.pfx_settings : {})
  };
  const nextRuns = Array.isArray(data?.pfx_runs) ? data.pfx_runs : [];
  if (!data?.pfx_settings || !Array.isArray(data?.pfx_runs)) {
    await pfxStorageSet({ pfx_settings: nextSettings, pfx_runs: nextRuns });
  }
  return {
    ok: true,
    data: {
      pfx_settings: nextSettings,
      pfx_runs: nextRuns,
      pfx_last_run: data?.pfx_last_run || null
    }
  };
}

async function pfxSaveSettings(settings){
  const next = {
    ...PFX_SETTINGS_DEFAULTS,
    ...(settings && typeof settings === "object" ? settings : {})
  };
  await pfxStorageSet({ pfx_settings: next });
  return { ok: true };
}

async function pfxSaveRun(run){
  const data = await pfxStorageGet(["pfx_runs"]);
  const runs = Array.isArray(data?.pfx_runs) ? data.pfx_runs.slice() : [];
  runs.unshift(run || null);
  const trimmed = runs.slice(0, 30);
  await pfxStorageSet({ pfx_runs: trimmed, pfx_last_run: run || null });
  return { ok: true };
}

async function pfxClearAll(){
  await pfxStorageRemove(["pfx_runs", "pfx_last_run"]);
  await pfxStorageSet({ pfx_runs: [] });
  return { ok: true };
}

// ------------------------------
// Usage Tracking (Auto) → Google Sheet (Apps Script Web App)
// ------------------------------
// Logs: Chrome profile email (if available), first use, last use.
// Silent/background (no UI). Triggered when the extension UI opens.
//
// NOTE: Keep this pointing to the same Web App used by the Feedback form.
// The user provided this webhook URL.
// NOTE: User-provided Apps Script Web App endpoint
const UT_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbxJ7tMTcmNyjqii1eGBIapC7BtVMJ3x-1dHUP_jsy3G-mik3Hj1OIjvgjDwxgBv-5VxFg/exec";
const UT_TOKEN = ""; // optional shared secret (keep empty if not used)

// Optional overrides (stored from the About/Feedback config when available)
// so Usage Tracking can reuse the same Web App + token without showing UI.
const UT_CFG_KEY = "mps.usage.cfg.v1";

const UT_STATE_KEY = "mps.usage.state.v1";
const UT_SYNC_THROTTLE_MS = 1000 * 60 * 60 * 12; // max 2 sync/day per machine

// Enterprise Offline flag (set by UI). When true, block all outbound network features.
const ENT_OFFLINE_KEY = "mps_enterprise_offline";

function utNowISO(){
  return new Date().toISOString();
}

function _utCleanBrowser(ua){
  const s = String(ua || "");
  let m;
  if ((m = s.match(/Edg\/(\d+)/)))     return `Edge ${m[1]}`;
  if ((m = s.match(/Chrome\/(\d+)/)))   return `Chrome ${m[1]}`;
  if ((m = s.match(/Firefox\/(\d+)/)))  return `Firefox ${m[1]}`;
  if ((m = s.match(/Version\/(\d+).*Safari/))) return `Safari ${m[1]}`;
  return s.slice(0, 40);
}

function _utCleanOS(platform, ua){
  const s = String((platform || "") + " " + (ua || "")).toLowerCase();
  if (/mac/.test(s))                   return "macOS";
  if (/win/.test(s))                   return "Windows";
  if (/android/.test(s))               return "Android";
  if (/iphone|ipad|ios/.test(s))       return "iOS";
  if (/linux/.test(s))                 return "Linux";
  return String(platform || "").slice(0, 30) || "Unknown";
}

function utStorageGet(key){
  return new Promise((resolve) => {
    try{
      chrome.storage.local.get([key], (res) => resolve(res ? res[key] : undefined));
    } catch(_){
      resolve(undefined);
    }
  });
}

function utStorageSet(obj){
  return new Promise((resolve) => {
    try{ chrome.storage.local.set(obj, () => resolve(true)); }
    catch(_){ resolve(false); }
  });
}

function utGetProfile(){
  return new Promise((resolve) => {
    try{
      chrome.identity.getProfileUserInfo((info) => {
        const err = chrome.runtime.lastError?.message;
        if (err) return resolve({ email:"", id:"", error: err });
        resolve({ email: info?.email || "", id: info?.id || "" });
      });
    } catch(e){
      resolve({ email:"", id:"", error: e?.message || String(e) });
    }
  });
}

function utGetPlatformInfo(){
  return new Promise((resolve) => {
    try{
      chrome.runtime.getPlatformInfo((info) => {
        const err = chrome.runtime.lastError?.message;
        if (err) return resolve({ os:"", arch:"", nacl_arch:"" });
        resolve(info || { os:"", arch:"", nacl_arch:"" });
      });
    } catch(_){ resolve({ os:"", arch:"", nacl_arch:"" }); }
  });
}

function utMakeInstallId(){
  try{ return crypto.randomUUID(); }
  catch{ return (Math.random().toString(16).slice(2) + Date.now().toString(16)).slice(0, 36); }
}

async function utSyncToWebhook(url, payload){
  url = String(url || "").trim();
  if (!url) return { ok:false, skipped:"no_webhook" };

  try{
    const ctrl = new AbortController();
    const fetchTimer = setTimeout(() => ctrl.abort(), 30000);
    let res;
    try{
      res = await fetch(url, {
        method: "POST",
        // Use a 'simple' content-type to avoid CORS preflight in stricter environments.
        // Apps Script still provides the full string in e.postData.contents.
        headers: { "Content-Type": "text/plain;charset=utf-8", "Accept": "application/json,text/plain,*/*" },
        body: JSON.stringify(payload),
        // If the Web App is restricted (eg. "Anyone within domain"),
        // sending credentials can help. If deployed to "Anyone", this is harmless.
        credentials: "include",
        cache: "no-store",
        redirect: "follow",
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(fetchTimer);
    }

    const text = await res.text().catch(() => "");
    let data = null;
    try{ data = JSON.parse(text); }catch{ data = null; }

    if (!res.ok){
      const err = (data && typeof data === "object" && data.error)
        ? data.error
        : ((String(text||"").trim().slice(0, 220)) || `HTTP ${res.status}`);
      return { ok:false, status: res.status, error: err, data: data || text };
    }

    // Treat any 2xx response as success unless the JSON explicitly says ok:false
    if (data && typeof data === "object" && data.ok === false){
      return { ok:false, status: res.status, error: data.error || "Server returned ok:false", data };
    }

    return { ok:true, status: res.status, data: data || text };
  } catch(e){
    return { ok:false, error: e?.message || String(e) };
  }
}

async function utHandlePing(msg={}){
  try{
    const ent = await utStorageGet(ENT_OFFLINE_KEY);
    if (ent) return { ok:true, skipped:"enterprise_offline" };
  }catch(_){ }
  const nowIso = utNowISO();
  const nowMs = Date.now();

  let state = await utStorageGet(UT_STATE_KEY);
  if (!state || typeof state !== "object") state = {};
  if (!state.installId) state.installId = utMakeInstallId();
  if (!state.firstUsed) state.firstUsed = nowIso;
  state.lastUsed = nowIso;

  // Session + active-day counters
  state.sessions = (state.sessions || 0) + 1;
  const today = nowIso.slice(0, 10);
  if (!Array.isArray(state.activeDays)) state.activeDays = [];
  if (!state.activeDays.includes(today)) state.activeDays.push(today);
  if (state.activeDays.length > 365) state.activeDays = state.activeDays.slice(-365);

  const lastSyncedMs = state.lastSynced ? Date.parse(state.lastSynced) : 0;
  const shouldSync = !lastSyncedMs || (nowMs - lastSyncedMs > UT_SYNC_THROTTLE_MS);

  // Save state immediately so we never lose "firstUsed".
  await utStorageSet({ [UT_STATE_KEY]: state });

  if (!shouldSync){
    return { ok:true, skipped:"throttled", state };
  }

  // If the user configured Feedback (About tab), reuse that webhook/token for usage.
  let cfg = await utStorageGet(UT_CFG_KEY);
  if (!cfg || typeof cfg !== "object") cfg = {};
  const webhookUrl = String(cfg.webhookUrl || UT_WEBHOOK_URL || "").trim();
  const token = String(cfg.token || UT_TOKEN || "").trim();

  const profile = await utGetProfile();
  const plat = await utGetPlatformInfo();
  const version = chrome.runtime.getManifest()?.version || "";

  const ua  = self?.navigator?.userAgent || "";
  const fc  = (state.featureCounts && typeof state.featureCounts === "object") ? state.featureCounts : {};
  const tu  = (state.tabsUsed      && typeof state.tabsUsed      === "object") ? state.tabsUsed      : {};

  const payload = {
    kind: "usage",
    token,
    row: {
      "Email": String(profile.email || "").trim(),
      // Support multiple sheet header variants (some templates include "(ISO)")
      "First Used": state.firstUsed,
      "First Used (ISO)": state.firstUsed,
      "Last Used": state.lastUsed,
      "Last Used (ISO)": state.lastUsed,
      "App / Extension Version": version,
      "Extension Version": version,
      "Platform": [plat.os, plat.arch].filter(Boolean).join(" ") || "",
      "OS": _utCleanOS(plat.os, ua),
      "UA": ua,
      "Browser / User Agent": ua,
      "Browser": _utCleanBrowser(ua),
      "Install ID": state.installId,
      "Chrome Profile ID": String(profile.id || "").trim(),
      "Sessions": state.sessions || 1,
      "Days Active": (state.activeDays || []).length,
      "Last Tab": state.lastTab || "",
      "Tabs Used": Object.keys(tu).join(", "),
      "Parses": fc.parse || 0,
      "CutDiff Runs": fc.cutdiff || 0,
      "Exports": fc.export || 0,
      "Updated At": nowIso,
      "Updated At (ISO)": nowIso,
    },
    meta: {
      source: msg.source || msg.from || "ui",
      page: msg.page || "index.html",
    }
  };

  const sync = await utSyncToWebhook(webhookUrl, payload);
  try{ console.log("[UT] usage sync", sync); }catch(_){ }
  if (sync && sync.ok){
    state.lastSynced = nowIso;
    state.lastSyncError = "";
    await utStorageSet({ [UT_STATE_KEY]: state });
  } else {
    state.lastSyncError = sync?.error || (sync?.data && typeof sync.data === "string" ? sync.data : "sync_failed");
    await utStorageSet({ [UT_STATE_KEY]: state });
  }

  return { ok:true, sync, state };
}

function _cmpVersion(a, b){
  const pa = String(a || "").split(".").map(s => parseInt(s, 10)).map(n => Number.isFinite(n) ? n : 0);
  const pb = String(b || "").split(".").map(s => parseInt(s, 10)).map(n => Number.isFinite(n) ? n : 0);
  const len = Math.max(pa.length, pb.length);
  for (let i=0; i<len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

async function openUpdateFolder(folderUrl = UPDATE_FOLDER_URL){
  const url = String(folderUrl || UPDATE_FOLDER_URL || "").trim() || UPDATE_FOLDER_URL;
  try{
    await chrome.tabs.create({ url, active: true });
    return { ok:true, url };
  } catch (e){
    return { ok:false, error: e?.message || String(e) };
  }
}

async function _waitTabComplete(tabId, timeoutMs=20000){
  const t0 = Date.now();
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (t?.status === "complete") return true;

  return await new Promise((resolve, reject) => {
    let done = false;

    const timer = setTimeout(() => {
      finish(false, new Error("Drive tab load timeout"));
    }, Math.max(1000, timeoutMs|0));

    const finish = (ok, err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      ok ? resolve(true) : reject(err);
    };

    const onUpdated = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "complete") finish(true, null);
    };

    const onRemoved = (id) => {
      if (id === tabId) finish(false, new Error("Drive tab closed"));
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    // safety: if it already completed right after listener attach
    setTimeout(async () => {
      if (done) return;
      const tt = await chrome.tabs.get(tabId).catch(() => null);
      if (tt?.status === "complete") finish(true, null);
    }, Math.max(60, 180 - (Date.now() - t0)));
  });
}

async function _readDriveManifestVersionViaTab(fileId){
  const url = UPDATE_PREVIEW_URL(fileId);
  let tabId = null;

  try{
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab?.id;
    if (!tabId) throw new Error("Failed to create Drive tab");

    await _waitTabComplete(tabId, 20000);

    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const deadline = Date.now() + 8000;
        const re = /"version"\s*:\s*"([^"]+)"/;

        while (Date.now() < deadline) {
          const t = document?.body?.innerText || "";
          const m = t.match(re);
          if (m && m[1]) {
            return { ok:true, version: m[1] };
          }
          await new Promise(r => setTimeout(r, 250));
        }

        const sample = (document?.body?.innerText || "").slice(0, 200);
        return { ok:false, error:"Could not find \"version\" on Drive preview page.", sample };
      }
    });

    const res = injected?.[0]?.result;
    if (!res?.ok) throw new Error(res?.error || "Drive extract failed");
    return { ok:true, version: res.version };
  } finally {
    if (tabId) {
      try{ await chrome.tabs.remove(tabId); } catch(_e){}
    }
  }
}

async function _readDriveManifestFromFolderViaTab(folderUrl, manifestPath){
  let tabId = null;
  const url = String(folderUrl || UPDATE_FOLDER_URL || "").trim();
  const path = String(manifestPath || UPDATE_MANIFEST_PATH || "manifest.json").trim();
  if (!url) throw new Error("Missing Drive folder URL");

  try{
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab?.id;
    if (!tabId) throw new Error("Failed to create Drive folder tab");

    await _waitTabComplete(tabId, 25000);

    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      args: [path],
      func: async (manifestPath) => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
        const pathParts = String(manifestPath || "manifest.json").split("/").map(s => s.trim()).filter(Boolean);
        const fileName = pathParts[pathParts.length - 1] || "manifest.json";
        const folderParts = pathParts.slice(0, -1);
        const getText = () => String(document?.body?.innerText || "");

        const candidateText = (el) => {
          if (!el) return "";
          const bits = [
            el.getAttribute?.("aria-label"),
            el.getAttribute?.("title"),
            el.textContent
          ];
          return bits.filter(Boolean).join(" ");
        };

        const rankText = (txt, target) => {
          const t = norm(txt);
          const w = norm(target);
          if (!t || !w) return -1;
          if (t === w) return 100;
          if (t.startsWith(w + " ")) return 90;
          if (t.includes(" " + w + " ")) return 80;
          if (t.includes(w)) return 70;
          return -1;
        };

        const findNodeByText = (target) => {
          const all = Array.from(document.querySelectorAll('[aria-label],[title],[role="row"],a,button,div,span'));
          let best = null;
          let bestScore = -1;
          for (const el of all){
            const score = rankText(candidateText(el), target);
            if (score > bestScore){
              bestScore = score;
              best = el;
            }
          }
          return bestScore >= 70 ? best : null;
        };

        const clickEl = async (el, dbl=false) => {
          if (!el) return false;
          const target = el.closest?.('[role="row"]') || el.closest?.('a,button,[tabindex]') || el;
          try{ target.scrollIntoView({ block:"center", inline:"center" }); }catch{}
          const fire = (type, detail=1) => {
            try{ target.dispatchEvent(new MouseEvent(type, { bubbles:true, cancelable:true, composed:true, view:window, detail })); }catch{}
          };
          fire('pointerdown'); fire('mousedown'); fire('mouseup'); fire('click', 1);
          if (dbl){ fire('mousedown',2); fire('mouseup',2); fire('click',2); fire('dblclick',2); }
          await sleep(dbl ? 1400 : 700);
          return true;
        };

        const extractFileId = (raw) => {
          const src = String(raw || "");
          const patterns = [
            /\/file\/d\/([A-Za-z0-9_-]{20,})/g,
            /[?&]id=([A-Za-z0-9_-]{20,})/g,
            /data-id="([A-Za-z0-9_-]{20,})"/g,
            /"([A-Za-z0-9_-]{20,})","manifest\.json"/g,
            /"manifest\.json","([A-Za-z0-9_-]{20,})"/g
          ];
          for (const re of patterns){
            let m;
            while ((m = re.exec(src))){
              if (m && m[1]) return m[1];
            }
          }
          return "";
        };

        const findManifestFileId = (target) => {
          const want = norm(target);
          const nodes = Array.from(document.querySelectorAll('[aria-label],[title],[role="row"],a,button,div,span'));
          for (const el of nodes){
            const txt = candidateText(el);
            if (rankText(txt, want) < 70) continue;
            const row = el.closest?.('[role="row"]') || el.parentElement || el;
            const chunks = [
              el.outerHTML || "",
              row?.outerHTML || "",
              row?.getAttribute?.('data-id') || "",
              Array.from(row?.querySelectorAll?.('a[href]') || []).map(a => a.href).join(' ')
            ];
            const id = extractFileId(chunks.join(' '));
            if (id) return id;
          }
          const html = String(document.documentElement?.innerHTML || "");
          const idx = html.indexOf(target);
          if (idx >= 0){
            const slice = html.slice(Math.max(0, idx - 4000), idx + 4000);
            const id = extractFileId(slice);
            if (id) return id;
          }
          return "";
        };

        const waitForVersion = async (timeoutMs=12000) => {
          const deadline = Date.now() + timeoutMs;
          const re = /"version"\s*:\s*"([^"]+)"/;
          const reLoose = /\bversion\b\s*[:=]\s*"?([0-9][^"\n\r,}]*)"?/i;
          while (Date.now() < deadline){
            const t = getText();
            const m = t.match(re) || t.match(reLoose);
            if (m && m[1]) return String(m[1]).trim();
            await sleep(250);
          }
          return "";
        };

        await sleep(1200);

        for (const seg of folderParts){
          if (norm(getText()).includes(norm(fileName))) break;
          const node = findNodeByText(seg);
          if (!node) continue;
          await clickEl(node, true);
          await sleep(1600);
        }

        const fileId = findManifestFileId(fileName);
        if (fileId) return { ok:true, fileId };

        const fileNode = findNodeByText(fileName);
        if (fileNode){
          await clickEl(fileNode, true);
          const version = await waitForVersion(14000);
          if (version) return { ok:true, version };
        }

        const sample = getText().slice(0, 1200);
        return { ok:false, error:`Could not locate ${fileName} inside Drive folder.`, sample };
      }
    });

    const res = injected?.[0]?.result;
    if (!res?.ok) throw new Error(res?.error || "Drive folder extract failed");
    if (res.fileId){
      return await _readDriveManifestVersionViaTab(res.fileId);
    }
    if (res.version){
      return { ok:true, version: res.version };
    }
    throw new Error("Drive folder check returned no version.");
  } finally {
    if (tabId) {
      try{ await chrome.tabs.remove(tabId); } catch(_e){}
    }
  }
}

async function checkDriveUpdate(opts={}){
  const local = chrome.runtime.getManifest().version;
  const manifestFileUrl = (opts.manifestFileUrl && String(opts.manifestFileUrl).trim()) || UPDATE_MANIFEST_FILE_URL;
  const fileId = extractDriveFileId((opts.manifestFileId && String(opts.manifestFileId).trim()) || manifestFileUrl || UPDATE_MANIFEST_FILE_ID);
  const folderUrl = (opts.manifestFolderUrl && String(opts.manifestFolderUrl).trim()) || UPDATE_MANIFEST_FOLDER_URL || UPDATE_FOLDER_URL;
  const manifestPath = (opts.manifestPath && String(opts.manifestPath).trim()) || UPDATE_MANIFEST_PATH;

  try{
    const remoteRes = fileId
      ? await _readDriveManifestVersionViaTab(fileId)
      : await _readDriveManifestFromFolderViaTab(folderUrl, manifestPath);
    const remote = remoteRes.version;
    return {
      ok:true,
      local,
      remote,
      updateAvailable: _cmpVersion(remote, local) > 0,
      folderUrl
    };
  } catch (e){
    return {
      ok:false,
      local,
      remote: null,
      updateAvailable: false,
      folderUrl,
      error: e?.message || String(e)
    };
  }
}


// Active AAF upload/parse sessions (keyed by requestId)
const aafSessions = new Map();

// Active CSV export sessions (keyed by requestId)
const csvSessions = new Map();

// Active ProRes native streaming sessions (keyed by requestId)
const proResSessions = new Map();

// Active IMF proxy QC sessions (keyed by requestId)
const imfProxySessions = new Map();
let _prevCpuSample = null; // for GET_SYS_USAGE delta computation

async function openUI(){
  try{
    const tabs = await chrome.tabs.query({ url: UI_URL });
    if (tabs && tabs.length){
      await chrome.tabs.update(tabs[0].id, { active: true });
      return;
    }
  } catch (_){}

  try{ await chrome.tabs.create({ url: UI_URL }); } catch(_){}
}

chrome.action.onClicked.addListener(() => {
  // Also ping usage tracking when the extension UI is opened via the toolbar button.
  try{ utHandlePing({ source:"action", page:"toolbar" }); }catch(_){ }
  openUI();
});

(async function reopenUIAfterClearIfNeeded(){
  try{
    const data = await pfxStorageGet([PFX_REOPEN_AFTER_CLEAR_KEY]);
    if (!data || !data[PFX_REOPEN_AFTER_CLEAR_KEY]) return;
    await pfxStorageRemove([PFX_REOPEN_AFTER_CLEAR_KEY]);
    await openUI();
  }catch(_){ }
})();

function sendToUI(message){
  try{ chrome.runtime.sendMessage(message); } catch(_){}
}

// ── Resolve background job keepalive ─────────────────────────────────────────
// MV3 service workers die after ~30 s of inactivity. When a Resolve render job
// is in flight the SW must stay alive to forward progress events to the UI.
// Strategy: store active job IDs in chrome.storage.session (survives SW restart),
// arm a chained one-shot alarm every 25 s, poll each job on each tick, and
// broadcast RESOLVE_JOB_PROGRESS / RESOLVE_JOB_DONE to all content windows.

const RESOLVE_POLL_ALARM       = 'pfx.resolve.poll';
const RESOLVE_ACTIVE_JOBS_KEY  = 'pfx_resolve_active_jobs';
const RESOLVE_POLL_INTERVAL_MS = 25000;
// Jobs older than this are assumed orphaned (companion crashed) and auto-cleared.
const RESOLVE_MAX_JOB_AGE_MS   = 2 * 60 * 60 * 1000; // 2 hours

async function _resolveGetActiveJobs() {
  try {
    const r = await chrome.storage.session.get(RESOLVE_ACTIVE_JOBS_KEY);
    return r[RESOLVE_ACTIVE_JOBS_KEY] || {};
  } catch (_) { return {}; }
}

async function _resolveSetActiveJobs(jobs) {
  try {
    await chrome.storage.session.set({ [RESOLVE_ACTIVE_JOBS_KEY]: jobs });
  } catch (_) {}
}

async function _resolveTrackJob(sessionId, jobId) {
  const jobs = await _resolveGetActiveJobs();
  jobs[sessionId] = { jobId: jobId || sessionId, since: Date.now() };
  await _resolveSetActiveJobs(jobs);
  // Arm/re-arm poll alarm whenever we have work to do.
  chrome.alarms.create(RESOLVE_POLL_ALARM, { delayInMinutes: RESOLVE_POLL_INTERVAL_MS / 60000 });
}

async function _resolveUntrackJob(sessionId) {
  const jobs = await _resolveGetActiveJobs();
  delete jobs[sessionId];
  await _resolveSetActiveJobs(jobs);
  if (Object.keys(jobs).length === 0) {
    chrome.alarms.clear(RESOLVE_POLL_ALARM);
  }
}

async function _resolvePollAllJobs() {
  const jobs = await _resolveGetActiveJobs();
  const sessionIds = Object.keys(jobs);
  if (sessionIds.length === 0) return;

  const now = Date.now();
  for (const sessionId of sessionIds) {
    const meta = jobs[sessionId] || {};

    // Auto-expire orphaned jobs: companion may have crashed and will never
    // update this session. Clear it so storage doesn't accumulate forever.
    if (meta.since && (now - meta.since) > RESOLVE_MAX_JOB_AGE_MS) {
      await _resolveUntrackJob(sessionId);
      sendToUI({ type: 'RESOLVE_JOB_DONE', sessionId, status: 'expired',
                 data: { reason: 'Job exceeded maximum age — companion may have crashed.' } });
      continue;
    }

    try {
      const res = await sendImfCompanion({ action: 'resolve.jobStatus', sessionId }, 8000);
      const data = res?.data || res || {};
      const status   = data.status   || data.jobStatus || '';
      const progress = typeof data.progress === 'number' ? data.progress : null;
      const done = ['complete', 'success', 'failed', 'cancelled', 'error'].includes(
        status.toLowerCase()
      );

      sendToUI({ type: 'RESOLVE_JOB_PROGRESS', sessionId, status, progress, data });

      if (done) {
        await _resolveUntrackJob(sessionId);
        sendToUI({ type: 'RESOLVE_JOB_DONE', sessionId, status, data });
      }
    } catch (_) {
      // Companion unreachable — leave job tracked; will retry on next alarm tick.
    }
  }

  // Re-arm for next tick only if there are still active jobs.
  const remaining = await _resolveGetActiveJobs();
  if (Object.keys(remaining).length > 0) {
    chrome.alarms.create(RESOLVE_POLL_ALARM, { delayInMinutes: RESOLVE_POLL_INTERVAL_MS / 60000 });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RESOLVE_POLL_ALARM) {
    _resolvePollAllJobs().catch(() => {});
  }
});

// On SW restart, re-arm the poll alarm if tracked jobs were persisted in session storage.
(async () => {
  try {
    const jobs = await _resolveGetActiveJobs();
    if (Object.keys(jobs).length > 0) {
      chrome.alarms.create(RESOLVE_POLL_ALARM, { delayInMinutes: RESOLVE_POLL_INTERVAL_MS / 60000 });
    }
  } catch (_) {}
})();

function pingNativeHost(){
  if (!NATIVE_HOST_ENABLED){
    return Promise.resolve({ ok:false, error:"Native Host disabled" });
  }
  // NOTE:
  // Some existing installs of com.mps.ae_bridge exit when they receive unknown messages.
  // So we verify availability by opening a native port and observing that it stays alive
  // briefly (or sends any message), without posting a probe payload.
  return new Promise((resolve) => {
    let port;
    try{
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e){
      resolve({ ok:false, error: e?.message || String(e) });
      return;
    }

    const t0 = Date.now();
    let done = false;

    const finish = (ok, error=null) => {
      if (done) return;
      done = true;
      try{ port.disconnect(); } catch(_){}
      resolve(ok ? { ok:true, host: NATIVE_HOST } : { ok:false, error: error || "Native host not available" });
    };

    // If any message arrives, the host is alive.
    port.onMessage.addListener(() => finish(true, null));

    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // mark as handled before reading
      const err = chrome.runtime.lastError?.message;
      if (err){
        finish(false, err);
      } else {
        const dt = Date.now() - t0;
        // If host exits immediately with no error, treat as failure (likely crash).
        if (dt < 80) finish(false, "Native host exited immediately.");
        else finish(true, null);
      }
    });

    // If the host stays connected briefly, consider it OK.
    setTimeout(() => {
      if (done) return;
      void chrome.runtime.lastError; // mark as handled
      const err = chrome.runtime.lastError?.message;
      if (err) finish(false, err);
      else finish(true, null);
    }, 200);
  });
}


function queryNativeHostStatus(timeoutMs=900){
  if (!NATIVE_HOST_ENABLED){
    return Promise.resolve({ ok:false, error:"Native Host disabled" });
  }
  return new Promise((resolve) => {
    let port;
    try{
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e){
      resolve({ ok:false, error: e?.message || String(e) });
      return;
    }

    const t0 = Date.now();
    let done = false;

    const finish = (ok, resp=null, error=null) => {
      if (done) return;
      done = true;
      try{ port.disconnect(); } catch(_){}
      const out = { ok, ms: Date.now() - t0 };
      if (resp !== null && resp !== undefined) out.resp = resp;
      if (error) out.error = error;
      resolve(out);
    };

    const timer = setTimeout(() => {
      finish(false, null, "STATUS timeout");
    }, Math.max(150, timeoutMs|0));

    port.onMessage.addListener((m) => {
      clearTimeout(timer);
      finish(true, m, null);
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      const err = chrome.runtime.lastError?.message;
      finish(false, null, err || "Native host disconnected.");
    });

    try{
      port.postMessage({ type:"STATUS", requestId: `status_${Date.now()}` });
    } catch (e){
      clearTimeout(timer);
      finish(false, null, e?.message || String(e));
    }
  });
}

function startNativeBuild(req){
  if (!NATIVE_HOST_ENABLED){
    try{ sendToUI({ type:"AE_BUILD_ERROR", requestId:req?.requestId, ok:false, error:"Native Host disabled" }); }catch(_){ }
    return Promise.resolve({ ok:false, error:"Native Host disabled" });
  }
  return new Promise((resolve) => {
    let port;
    try{
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e){
      const err = e?.message || String(e);
      sendToUI({ type:"AE_BUILD_ERROR", requestId:req.requestId, ok:false, error: err });
      resolve({ ok:false, error: err });
      return;
    }

    let disconnected = false;

    // Safety timeout: if native host stalls and never sends DONE/ERROR,
    // disconnect after 5 minutes to prevent the service worker hanging indefinitely.
    const nativeTimeout = setTimeout(() => {
      if (disconnected) return;
      disconnected = true;
      const timeoutErr = "AE Build timed out (5 min). Native host may have stalled.";
      sendToUI({ type:"AE_BUILD_ERROR", requestId:req.requestId, ok:false, error: timeoutErr });
      try{ port.disconnect(); } catch(_){}
    }, 5 * 60 * 1000);

    port.onMessage.addListener((m) => {
      const msg = (m && typeof m === "object") ? m : { type:"AE_BUILD_LOG", line: String(m) };
      if (!msg.requestId) msg.requestId = req.requestId;
      sendToUI(msg);
      const t = msg.type || "";
      if (t === "AE_BUILD_DONE" || t === "AE_BUILD_ERROR"){
        clearTimeout(nativeTimeout);
      }
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(nativeTimeout);
      if (disconnected) return;
      disconnected = true;
      const err = chrome.runtime.lastError?.message;
      if (err){
        sendToUI({ type:"AE_BUILD_ERROR", requestId:req.requestId, ok:false, error: err });
      }
    });

    const payload = {
      type: "AE_BUILD",
      requestId: req.requestId,
      aepName: req.aepName || "VFX_Project.aep",
      vfxRoot: req.vfxRoot || "",
      mappingJson: req.mappingJson || ""
    };

    try{
      port.postMessage(payload);
    } catch (e){
      const err = e?.message || String(e);
      sendToUI({ type:"AE_BUILD_ERROR", requestId:req.requestId, ok:false, error: err });
      resolve({ ok:false, error: err });
      return;
    }

    resolve({ ok:true, host: NATIVE_HOST });
  });
}


function cleanupCSV(requestId){
  const s = csvSessions.get(requestId);
  if (!s) return;
  try{ s.port?.disconnect(); } catch(_){ }
  csvSessions.delete(requestId);
}

function startNativeCSVExport(req){
  if (!NATIVE_HOST_ENABLED){
    try{ sendToUI({ type:"CSV_EXPORT_ERROR", requestId:req?.requestId, ok:false, error:"Native Host disabled" }); }catch(_){ }
    return Promise.resolve({ ok:false, error:"Native Host disabled" });
  }
  return new Promise((resolve) => {
    let port;
    try{
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e){
      const err = e?.message || String(e);
      sendToUI({ type:"CSV_EXPORT_ERROR", requestId:req.requestId, ok:false, error: err });
      resolve({ ok:false, error: err });
      return;
    }

    // Keep a session reference so we can cleanup stale runs
    csvSessions.set(req.requestId, { port });

    let disconnected = false;

    // Safety timeout: if native host stalls and never sends DONE/ERROR,
    // disconnect after 5 minutes to prevent the service worker hanging indefinitely.
    const nativeCsvTimeout = setTimeout(() => {
      if (disconnected) return;
      disconnected = true;
      const timeoutErr = "CSV Export timed out (5 min). Native host may have stalled.";
      sendToUI({ type:"CSV_EXPORT_ERROR", requestId:req.requestId, ok:false, error: timeoutErr });
      cleanupCSV(req.requestId);
    }, 5 * 60 * 1000);

    port.onMessage.addListener((m) => {
      const msg = (m && typeof m === "object") ? m : { type:"CSV_EXPORT_LOG", line: String(m) };
      if (!msg.requestId) msg.requestId = req.requestId;

      sendToUI(msg);

      const t = msg.type || msg.event || msg.kind;
      if (t === "CSV_EXPORT_DONE" || t === "CSV_EXPORT_ERROR"){
        clearTimeout(nativeCsvTimeout);
        // Close port to avoid keeping MV3 service worker alive
        try{ port.disconnect(); } catch(_){}
        cleanupCSV(req.requestId);
      }
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(nativeCsvTimeout);
      if (disconnected) return;
      disconnected = true;
      const err = chrome.runtime.lastError?.message;
      if (err){
        sendToUI({ type:"CSV_EXPORT_ERROR", requestId:req.requestId, ok:false, error: err });
      }
      cleanupCSV(req.requestId);
    });

    const payload = {
      type: "CSV_EXPORT",
      requestId: req.requestId,
      vfxRoot: req.vfxRoot || "",
      mappingJson: req.mappingJson || "",
      csvName: req.csvName || "VFX_ShotList.csv",
      thumbsZipName: req.thumbsZipName || "VFX_Thumbnails.zip"
    };

    try{
      port.postMessage(payload);
    } catch (e){
      const err = e?.message || String(e);
      sendToUI({ type:"CSV_EXPORT_ERROR", requestId:req.requestId, ok:false, error: err });
      cleanupCSV(req.requestId);
      resolve({ ok:false, error: err });
      return;
    }

    resolve({ ok:true, host: NATIVE_HOST });
  });
}


function cleanupAAF(requestId){
  const s = aafSessions.get(requestId);
  if (!s) return;
  try{ s.port?.disconnect(); } catch(_){ }
  aafSessions.delete(requestId);
}

function startNativeAAFSession(req){
  if (!NATIVE_HOST_ENABLED){
    try{ sendToUI({ type:"AAF_PARSE_ERROR", requestId:req?.requestId, ok:false, error:"Native Host disabled" }); }catch(_){ }
    return Promise.resolve({ ok:false, error:"Native Host disabled" });
  }
  return new Promise((resolve) => {
    let port;
    try{
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e){
      const err = e?.message || String(e);
      sendToUI({ type:"AAF_PARSE_ERROR", requestId:req.requestId, ok:false, error: err });
      resolve({ ok:false, error: err });
      return;
    }

    aafSessions.set(req.requestId, { port });

    let disconnected = false;

    // Safety timeout: if native host stalls and never sends DONE/ERROR,
    // disconnect after 5 minutes to prevent the service worker hanging indefinitely.
    const nativeAafTimeout = setTimeout(() => {
      if (disconnected) return;
      disconnected = true;
      const timeoutErr = "AAF Parse timed out (5 min). Native host may have stalled.";
      sendToUI({ type:"AAF_PARSE_ERROR", requestId:req.requestId, ok:false, error: timeoutErr });
      cleanupAAF(req.requestId);
    }, 5 * 60 * 1000);

    port.onMessage.addListener((m) => {
      const msg = (m && typeof m === "object") ? m : { type:"AAF_PARSE_LOG", line: String(m) };
      if (!msg.requestId) msg.requestId = req.requestId;
      sendToUI(msg);

      // Auto-clean once done
      if (msg.type === "AAF_PARSE_DONE" || msg.type === "AAF_PARSE_ERROR"){
        clearTimeout(nativeAafTimeout);
        cleanupAAF(req.requestId);
      }
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(nativeAafTimeout);
      if (disconnected) return;
      disconnected = true;
      const err = chrome.runtime.lastError?.message;
      if (err){
        sendToUI({ type:"AAF_PARSE_ERROR", requestId:req.requestId, ok:false, error: err });
      }
      cleanupAAF(req.requestId);
    });

    const payload = {
      type: "AAF_PARSE_BEGIN",
      requestId: req.requestId,
      fileName: req.fileName || "timeline",
      totalBytes: req.totalBytes || 0,
      totalChunks: req.totalChunks || 0
    };

    try{
      port.postMessage(payload);
    } catch (e){
      const err = e?.message || String(e);
      sendToUI({ type:"AAF_PARSE_ERROR", requestId:req.requestId, ok:false, error: err });
      cleanupAAF(req.requestId);
      resolve({ ok:false, error: err });
      return;
    }

    resolve({ ok:true, host: NATIVE_HOST });
  });
}

// ── ProRes Native Streaming ───────────────────────────────────────────────────

function cleanupProRes(requestId) {
  const s = proResSessions.get(requestId);
  if (!s) return;
  try { s.port?.disconnect(); } catch(_) {}
  proResSessions.delete(requestId);
}

function startProResStream(req) {
  if (!NATIVE_HOST_ENABLED) {
    try { sendToUI({ type: "PRORES_STREAM_ERROR", requestId: req?.requestId, ok: false, error: "Native Host disabled" }); } catch(_) {}
    return Promise.resolve({ ok: false, error: "Native Host disabled" });
  }
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e) {
      const err = e?.message || String(e);
      sendToUI({ type: "PRORES_STREAM_ERROR", requestId: req.requestId, ok: false, error: err });
      resolve({ ok: false, error: err });
      return;
    }

    proResSessions.set(req.requestId, { port });
    let disconnected = false;

    const nativeTimeout = setTimeout(() => {
      if (disconnected) return;
      disconnected = true;
      const timeoutErr = "ProRes stream timed out (5 min). Native host may have stalled.";
      sendToUI({ type: "PRORES_STREAM_ERROR", requestId: req.requestId, ok: false, error: timeoutErr });
      cleanupProRes(req.requestId);
    }, 5 * 60 * 1000);

    port.onMessage.addListener((m) => {
      const msg = (m && typeof m === "object") ? m : { type: "PRORES_STREAM_ERROR", error: String(m) };
      if (!msg.requestId) msg.requestId = req.requestId;
      sendToUI(msg);
      const t = msg.type || "";
      if (t === "PRORES_STREAM_READY" || t === "PRORES_STREAM_ERROR") {
        clearTimeout(nativeTimeout);
        try { port.disconnect(); } catch(_) {}
        cleanupProRes(req.requestId);
      }
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(nativeTimeout);
      if (disconnected) return;
      disconnected = true;
      const err = chrome.runtime.lastError?.message;
      if (err) sendToUI({ type: "PRORES_STREAM_ERROR", requestId: req.requestId, ok: false, error: err });
      cleanupProRes(req.requestId);
    });

    try {
      port.postMessage({
        type: "PRORES_STREAM_BEGIN",
        requestId: req.requestId,
        filePath: req.filePath || "",
        streamPort: req.streamPort || 8080
      });
    } catch (e) {
      const err = e?.message || String(e);
      sendToUI({ type: "PRORES_STREAM_ERROR", requestId: req.requestId, ok: false, error: err });
      cleanupProRes(req.requestId);
      resolve({ ok: false, error: err });
      return;
    }

    resolve({ ok: true, host: NATIVE_HOST });
  });
}

// ── IMF Companion bridge (persistent via offscreen document when available) ──

const imfBridgeDebugState = {
  route: 'IDLE',
  lastEvent: 'IDLE',
  lastError: '',
  offscreenReady: false,
  offscreenConnected: false,
  directConnected: false,
  lastAction: '',
  lastUpdated: 0,
  events: [],
};

function recordImfBridgeDebug(event, extra = {}) {
  try {
    const stamp = new Date().toLocaleTimeString([], { hour12: false });
    imfBridgeDebugState.lastEvent = String(event || '');
    imfBridgeDebugState.lastUpdated = Date.now();
    if (extra.route) imfBridgeDebugState.route = String(extra.route || imfBridgeDebugState.route || '');
    if (typeof extra.offscreenReady === 'boolean') imfBridgeDebugState.offscreenReady = extra.offscreenReady;
    if (typeof extra.offscreenConnected === 'boolean') imfBridgeDebugState.offscreenConnected = extra.offscreenConnected;
    if (typeof extra.directConnected === 'boolean') imfBridgeDebugState.directConnected = extra.directConnected;
    if (typeof extra.lastAction === 'string') imfBridgeDebugState.lastAction = extra.lastAction;
    if (typeof extra.lastError === 'string') imfBridgeDebugState.lastError = extra.lastError;
    const detail = String(extra.detail || '').trim();
    const line = detail ? `${stamp} ${event} :: ${detail}` : `${stamp} ${event}`;
    imfBridgeDebugState.events = [line, ...(imfBridgeDebugState.events || [])].slice(0, 12);
  } catch (_) {}
}

function snapshotImfBridgeDebug() {
  return {
    ...imfBridgeDebugState,
    events: Array.isArray(imfBridgeDebugState.events) ? [...imfBridgeDebugState.events] : [],
  };
}

function connectImfCompanion() {
  if (imfCompanionState.port) return imfCompanionState.port;
  try {
    const port = chrome.runtime.connectNative(IMF_COMPANION_HOST);
    imfCompanionState.port = port;
    recordImfBridgeDebug('DIRECT_CONNECT_OK', { route: imfBridgeDebugState.route === 'OFFSCREEN' ? 'OFFSCREEN' : 'DIRECT', directConnected: true, detail: IMF_COMPANION_HOST });

    port.onMessage.addListener((msg) => {
      const id = msg && typeof msg === 'object' ? msg._id : undefined;
      if (id === undefined || !imfCompanionState.pending.has(id)) return;
      const job = imfCompanionState.pending.get(id);
      imfCompanionState.pending.delete(id);
      try { clearTimeout(job.timer); } catch(_) {}
      if (msg?.status === 'error') {
        const rawErr = msg?.error || {};
        const message = (typeof rawErr === 'string') ? rawErr : (rawErr.message || rawErr.error || 'Companion host error');
        const lower = String(message || '').toLowerCase();
        job.reject({
          code: (typeof rawErr === 'object' && rawErr.code) ? rawErr.code : (lower.includes('unknown action') ? 'PFX_HELPER_TOO_OLD' : ''),
          message,
          userMessage: (typeof rawErr === 'object' && rawErr.userMessage) ? rawErr.userMessage : '',
        });
      } else {
        recordImfBridgeDebug('DIRECT_CALL_OK', { route: 'DIRECT', lastAction: String(msg?.action || imfBridgeDebugState.lastAction || ''), detail: String(msg?.data?.sessionId || msg?.data?.streamUrl || msg?.status || 'ok') });
        job.resolve(msg);
      }
    });

    port.onDisconnect.addListener(() => {
      const lastErr = chrome.runtime.lastError?.message || '';
      const pending = Array.from(imfCompanionState.pending.values());
      imfCompanionState.pending.clear();
      imfCompanionState.port = null;
      recordImfBridgeDebug('DIRECT_DISCONNECT', { route: 'DIRECT', directConnected: false, lastError: lastErr || '' });
      for (const job of pending) {
        try { clearTimeout(job.timer); } catch(_) {}
        job.reject({
          code: 'HOST_DISCONNECTED',
          message: lastErr || 'Companion host disconnected',
          userMessage: lastErr || '',
        });
      }
    });

    return port;
  } catch (e) {
    imfCompanionState.port = null;
    recordImfBridgeDebug('DIRECT_CONNECT_FAIL', { route: 'DIRECT', directConnected: false, lastError: e?.message || String(e) });
    return null;
  }
}

async function ensureImfOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) {
    recordImfBridgeDebug('OFFSCREEN_API_MISSING', { offscreenReady: false, route: 'DIRECT' });
    return false;
  }
  const docUrl = chrome.runtime.getURL('offscreen.html');
  try {
    if (chrome.runtime.getContexts) {
      const existing = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [docUrl],
      });
      if (Array.isArray(existing) && existing.length) {
        recordImfBridgeDebug('OFFSCREEN_EXISTS', { offscreenReady: true, route: 'OFFSCREEN' });
        return true;
      }
    }
  } catch (_) {}

  if (!imfOffscreenEnsurePromise) {
    recordImfBridgeDebug('OFFSCREEN_CREATE_BEGIN', { offscreenReady: false, route: 'OFFSCREEN' });
    imfOffscreenEnsurePromise = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Keep the native companion connection alive for ProRes proxy and media streaming.',
    }).catch((err) => {
      const msg = String(err?.message || err || '');
      recordImfBridgeDebug('OFFSCREEN_CREATE_FAIL', { offscreenReady: false, route: 'DIRECT', lastError: msg });
      if (!/single offscreen document/i.test(msg) && !/already exists/i.test(msg)) throw err;
    }).finally(() => {
      imfOffscreenEnsurePromise = null;
    });
  }

  try {
    await imfOffscreenEnsurePromise;
  } catch (err) {
    recordImfBridgeDebug('OFFSCREEN_PING_ERROR', { route: 'DIRECT', offscreenReady: false, lastError: err?.message || String(err) });
    return false;
  }

  try {
    const pong = await chrome.runtime.sendMessage({ type: 'IMF_OFFSCREEN_PING' });
    const ok = !!pong?.ok;
    recordImfBridgeDebug(ok ? 'OFFSCREEN_PING_OK' : 'OFFSCREEN_PING_FAIL', { route: ok ? 'OFFSCREEN' : 'DIRECT', offscreenReady: ok, offscreenConnected: !!pong?.connected });
    return ok;
  } catch (_) {
    return false;
  }
}

function sendImfCompanionDirect(msg, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const port = connectImfCompanion();
    if (!port) {
      recordImfBridgeDebug('DIRECT_CALL_NO_PORT', { route: 'DIRECT', directConnected: false, detail: String(msg?.action || '') });
      reject({ code: 'host_unavailable', message: 'Companion host unavailable', userMessage: '' });
      return;
    }
    const id = ++imfCompanionState.seq;
    recordImfBridgeDebug('DIRECT_CALL_BEGIN', { route: 'DIRECT', directConnected: true, lastAction: String(msg?.action || ''), detail: String(msg?.action || '') });
    const timer = setTimeout(() => {
      imfCompanionState.pending.delete(id);
      recordImfBridgeDebug('DIRECT_CALL_TIMEOUT', { route: 'DIRECT', lastAction: String(msg?.action || ''), lastError: 'timeout' });
      reject({ code: 'host_timeout', message: 'Companion host timeout', userMessage: '' });
    }, Math.max(1000, Number(timeoutMs) || 20000));
    imfCompanionState.pending.set(id, { resolve, reject, timer });
    try {
      port.postMessage({ ...(msg || {}), _id: id });
    } catch (e) {
      imfCompanionState.pending.delete(id);
      try { clearTimeout(timer); } catch(_) {}
      recordImfBridgeDebug('DIRECT_CALL_POST_FAIL', { route: 'DIRECT', lastAction: String(msg?.action || ''), lastError: e?.message || String(e) });
      reject({ code: 'POST_FAILED', message: e?.message || String(e), userMessage: '' });
    }
  });
}

async function sendImfCompanion(msg, timeoutMs = 20000) {
  const action = String(msg?.action || '');
  const offscreenReady = await ensureImfOffscreenDocument().catch(() => false);
  if (offscreenReady) {
    try {
      recordImfBridgeDebug('OFFSCREEN_CALL_BEGIN', { route: 'OFFSCREEN', offscreenReady: true, lastAction: action, detail: action });
      const response = await chrome.runtime.sendMessage({
        type: 'IMF_OFFSCREEN_CALL',
        payload: msg || {},
        timeoutMs: Math.max(1000, Number(timeoutMs) || 20000),
      });
      if (response?.ok) {
        recordImfBridgeDebug('OFFSCREEN_CALL_OK', { route: 'OFFSCREEN', offscreenReady: true, offscreenConnected: true, lastAction: action, detail: String(response?.response?.data?.sessionId || response?.response?.data?.streamUrl || response?.response?.status || 'ok') });
        return response.response;
      }
      throw response?.error || { code: 'offscreen_error', message: 'Offscreen bridge failed', userMessage: '' };
    } catch (err) {
      recordImfBridgeDebug('OFFSCREEN_CALL_FAIL', { route: 'DIRECT', offscreenReady: false, offscreenConnected: false, lastAction: action, lastError: err?.message || String(err) });
      console.warn('[IMF] Offscreen companion bridge failed; falling back to service worker bridge.', err);
    }
  }
  recordImfBridgeDebug('SW_FALLBACK', { route: 'DIRECT', lastAction: action, detail: action });
  return sendImfCompanionDirect(msg, timeoutMs);
}

// ── IMF Proxy QC ─────────────────────────────────────────────────────────────

function cleanupIMFProxy(requestId) {
  const s = imfProxySessions.get(requestId);
  if (!s) return;
  try { s.port?.disconnect(); } catch(_) {}
  imfProxySessions.delete(requestId);
}

function startIMFProxyQC(req) {
  if (!NATIVE_HOST_ENABLED) {
    try { sendToUI({ type: "IMF_PROXY_ERROR", requestId: req?.requestId, ok: false, error: "Native Host disabled" }); } catch(_) {}
    return Promise.resolve({ ok: false, error: "Native Host disabled" });
  }
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e) {
      const err = e?.message || String(e);
      sendToUI({ type: "IMF_PROXY_ERROR", requestId: req.requestId, ok: false, error: err });
      resolve({ ok: false, error: err });
      return;
    }

    imfProxySessions.set(req.requestId, { port });
    let disconnected = false;

    const nativeTimeout = setTimeout(() => {
      if (disconnected) return;
      disconnected = true;
      const timeoutErr = "IMF Proxy generation timed out (5 min). Native host may have stalled.";
      sendToUI({ type: "IMF_PROXY_ERROR", requestId: req.requestId, ok: false, error: timeoutErr });
      cleanupIMFProxy(req.requestId);
    }, 5 * 60 * 1000);

    port.onMessage.addListener((m) => {
      const msg = (m && typeof m === "object") ? m : { type: "IMF_PROXY_ERROR", error: String(m) };
      if (!msg.requestId) msg.requestId = req.requestId;
      sendToUI(msg);
      const t = msg.type || "";
      if (t === "IMF_PROXY_COMPLETE" || t === "IMF_PROXY_ERROR") {
        clearTimeout(nativeTimeout);
        try { port.disconnect(); } catch(_) {}
        cleanupIMFProxy(req.requestId);
      }
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(nativeTimeout);
      if (disconnected) return;
      disconnected = true;
      const err = chrome.runtime.lastError?.message;
      if (err) sendToUI({ type: "IMF_PROXY_ERROR", requestId: req.requestId, ok: false, error: err });
      cleanupIMFProxy(req.requestId);
    });

    try {
      port.postMessage({
        type: "IMF_PROXY_BEGIN",
        requestId: req.requestId,
        cplPath: req.cplPath || "",
        streamPort: req.streamPort || 8080
      });
    } catch (e) {
      const err = e?.message || String(e);
      sendToUI({ type: "IMF_PROXY_ERROR", requestId: req.requestId, ok: false, error: err });
      cleanupIMFProxy(req.requestId);
      resolve({ ok: false, error: err });
      return;
    }

    resolve({ ok: true, host: NATIVE_HOST });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  // ---- Usage Tracking (auto background) ----
  if (msg.type === "USAGE_CFG_SET"){
    (async () => {
      try{
        const ent = await utStorageGet(ENT_OFFLINE_KEY);
        if (ent){ sendResponse({ ok:true, skipped:true, reason:"enterprise_offline" }); return; }
        const next = {
          webhookUrl: String(msg.webhookUrl || "").trim(),
          token: String(msg.token || "").trim(),
          updatedAt: utNowISO(),
        };
        await utStorageSet({ [UT_CFG_KEY]: next });
        sendResponse({ ok:true });
      } catch(e){
        sendResponse({ ok:false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "USAGE_PING"){
    utHandlePing(msg).then(sendResponse).catch(e => sendResponse({ ok:false, error: e?.message || String(e) }));
    return true;
  }

  // ---- Chrome Profile ----
  if (msg.type === "GET_PROFILE"){
    utGetProfile().then(sendResponse).catch(e => sendResponse({ ok:false, error: e?.message || String(e) }));
    return true;
  }

  if (msg.type === "SIGN_IN_CHROME"){
    (async () => {
      try{
        await new Promise((resolve, reject) => {
          chrome.identity.getAuthToken({ interactive: true }, (token) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(token);
          });
        });
        const profile = await utGetProfile();
        sendResponse({ ok: true, email: profile.email || "" });
      } catch(e){
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  // ---- Feature / Tab Event ----
  if (msg.type === "USAGE_EVENT"){
    (async () => {
      try{
        let state = await utStorageGet(UT_STATE_KEY);
        if (!state || typeof state !== "object") state = {};
        if (!state.featureCounts) state.featureCounts = {};
        if (!state.tabsUsed)      state.tabsUsed = {};

        const ev  = String(msg.event || "").toLowerCase();
        const tab = String(msg.tab   || "").toLowerCase();

        if (ev === "tab" && tab) {
          state.lastTab = tab;
          state.tabsUsed[tab] = (state.tabsUsed[tab] || 0) + 1;
        } else if (ev && ev !== "tab") {
          state.featureCounts[ev] = (state.featureCounts[ev] || 0) + 1;
        }

        await utStorageSet({ [UT_STATE_KEY]: state });
        sendResponse({ ok: true });
      } catch(e){
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

// ---- Update Version (Google Drive) ----
if (msg.type === "OPEN_UPDATE_FOLDER"){
  (async () => {
    try{
      const ent = await utStorageGet(ENT_OFFLINE_KEY);
      if (ent){ sendResponse({ ok:false, skipped:true, reason:"enterprise_offline" }); return; }
    }catch(_){ }
    openUpdateFolder(msg.folderUrl).then(sendResponse).catch(e => sendResponse({ ok:false, error: e?.message || String(e) }));
  })();
  return true;
}

if (msg.type === "DRIVE_UPDATE_CHECK"){
  (async () => {
    try{
      const ent = await utStorageGet(ENT_OFFLINE_KEY);
      if (ent){ sendResponse({ ok:false, skipped:true, reason:"enterprise_offline" }); return; }
    }catch(_){ }
    checkDriveUpdate({
      manifestFileId: msg.manifestFileId,
      manifestFileUrl: msg.manifestFileUrl,
      manifestFolderUrl: msg.manifestFolderUrl,
      manifestPath: msg.manifestPath
    }).then(sendResponse).catch(e => sendResponse({ ok:false, error: e?.message || String(e) }));
  })();
  return true;
}

  // ---- Preflight Validator shared storage ----
  if (msg.type === "PFX_GET_STATE"){
    pfxGetStateBundle().then(sendResponse).catch((e) => sendResponse({ ok:false, error: e?.message || String(e) }));
    return true;
  }

  if (msg.type === "PFX_SAVE_SETTINGS"){
    pfxSaveSettings(msg.settings).then(sendResponse).catch((e) => sendResponse({ ok:false, error: e?.message || String(e) }));
    return true;
  }

  if (msg.type === "PFX_SAVE_RUN"){
    pfxSaveRun(msg.run).then(sendResponse).catch((e) => sendResponse({ ok:false, error: e?.message || String(e) }));
    return true;
  }

  if (msg.type === "PFX_CLEAR_ALL"){
    pfxClearAll().then(sendResponse).catch((e) => sendResponse({ ok:false, error: e?.message || String(e) }));
    return true;
  }


// ---- Autodesk Flow / ShotGrid Upload ----
if (msg.type === "FLOW_UPLOAD_VERSION"){
  (async () => {
    try{
      const ent = await utStorageGet(ENT_OFFLINE_KEY);
      if (ent){ sendResponse({ ok:false, skipped:true, reason:"enterprise_offline" }); return; }
      const endpoint = String(msg.endpoint || "").trim();
      if (!endpoint) throw new Error("Missing endpoint");
      const fd = new FormData();
      fd.append("project_key", String(msg.projectKey || ""));
      fd.append("shot_code", String(msg.shotCode || ""));
      if (msg.versionCode) fd.append("version_code", String(msg.versionCode || ""));
      if (msg.userEmail) fd.append("user_email", String(msg.userEmail || ""));
      if (msg.movieFile) fd.append("movie", msg.movieFile, msg.movieFile.name || `${msg.shotCode||"shot"}.mov`);
      if (msg.thumbBlob) fd.append("thumbnail", msg.thumbBlob, `${msg.shotCode||"shot"}.jpg`);

      const headers = {};
      const token = String(msg.token || "").trim();
      if (token) headers["Authorization"] = `Bearer ${token}`;

      // Large movie uploads can be slow — allow up to 10 minutes, but cap it.
      // Without a timeout the service worker hangs indefinitely on a stalled upload:
      // Chrome cannot suspend a SW that has a live fetch, causing memory pressure.
      const uploadCtrl = new AbortController();
      const uploadTimer = setTimeout(() => uploadCtrl.abort(), 10 * 60 * 1000);
      let res;
      try {
        res = await fetch(endpoint, { method:"POST", headers, body: fd, signal: uploadCtrl.signal });
      } finally {
        clearTimeout(uploadTimer);
      }
      let data = null;
      try{ data = await res.json(); } catch { data = await res.text(); }
      sendResponse({ ok: res.ok, status: res.status, data });
    } catch(e){
      sendResponse({ ok:false, error: e?.message || String(e) });
    }
  })();
  return true;
}

if (msg.type === "AE_HOST_PING"){
    pingNativeHost().then(sendResponse).catch(e => sendResponse({ ok:false, error: e?.message || String(e) }));
    return true;
  }

  if (msg.type === "AE_HOST_STATUS"){
    (async () => {
      const t0 = Date.now();
      const ping = await pingNativeHost();
      if (!ping || ping.ok === false){
        sendResponse({
          ok:false,
          host: NATIVE_HOST,
          ping: ping || { ok:false, error:"Native host not available" },
          status: { ok:false, error:"Skipped (PING failed)" },
          error: ping?.error || "Native host not available",
          ms: Date.now() - t0
        });
        return;
      }

      const status = await queryNativeHostStatus(900);
      const ok = !!(status && status.ok);

      sendResponse({
        ok,
        host: NATIVE_HOST,
        ping,
        status,
        ms: Date.now() - t0,
        error: ok ? null : (status?.error || "STATUS failed")
      });
    })();
    return true;
  }

  if (msg.type === "AE_BUILD_REQUEST"){
    const req = {
      requestId: msg.requestId || `aep_${Date.now()}`,
      aepName: msg.aepName,
      vfxRoot: msg.vfxRoot,
      mappingJson: msg.mappingJson
    };
    startNativeBuild(req).then(sendResponse).catch(e => sendResponse({ ok:false, error: e?.message || String(e) }));
    return true;
  }

  if (msg.type === "CSV_EXPORT_REQUEST"){
    const req = {
      requestId: msg.requestId || `csv_${Date.now()}`,
      vfxRoot: msg.vfxRoot,
      mappingJson: msg.mappingJson,
      csvName: msg.csvName,
      thumbsZipName: msg.thumbsZipName
    };

    // If a stale session exists, clear it first.
    cleanupCSV(req.requestId);

    startNativeCSVExport(req).then(sendResponse).catch(e => sendResponse({ ok:false, error: e?.message || String(e) }));
    return true;
  }


  // AAF (Native Host)
  if (msg.type === "AAF_HOST_PING"){
    pingNativeHost().then(sendResponse).catch(e => sendResponse({ ok:false, error: e?.message || String(e) }));
    return true;
  }

  if (msg.type === "AAF_PARSE_BEGIN"){
    const req = {
      requestId: msg.requestId || `aaf_${Date.now()}`,
      fileName: msg.fileName,
      totalBytes: msg.totalBytes,
      totalChunks: msg.totalChunks
    };

    // If a stale session exists, clear it first.
    cleanupAAF(req.requestId);

    startNativeAAFSession(req).then(sendResponse).catch(e => sendResponse({ ok:false, error: e?.message || String(e) }));
    return true;
  }

  if (msg.type === "AAF_PARSE_CHUNK"){
    if (!NATIVE_HOST_ENABLED){
      sendResponse({ ok:false, error:"Native Host disabled" });
      return;
    }
    const s = aafSessions.get(msg.requestId);
    if (!s?.port){
      sendResponse({ ok:false, error:"AAF session not found (did AAF_PARSE_BEGIN run?)" });
      return;
    }
    try{
      s.port.postMessage({
        type: "AAF_PARSE_CHUNK",
        requestId: msg.requestId,
        index: msg.index,
        totalChunks: msg.totalChunks,
        chunkBase64: msg.chunkBase64
      });
      sendResponse({ ok:true });
    } catch (e){
      const err = e?.message || String(e);
      sendToUI({ type:"AAF_PARSE_ERROR", requestId:msg.requestId, ok:false, error: err });
      cleanupAAF(msg.requestId);
      sendResponse({ ok:false, error: err });
    }
    return;
  }

  if (msg.type === "AAF_PARSE_END"){
    const s = aafSessions.get(msg.requestId);
    if (!s?.port){
      sendResponse({ ok:false, error:"AAF session not found (did AAF_PARSE_BEGIN run?)" });
      return;
    }
    try{
      s.port.postMessage({ type:"AAF_PARSE_END", requestId: msg.requestId });
      sendResponse({ ok:true });
    } catch (e){
      const err = e?.message || String(e);
      sendToUI({ type:"AAF_PARSE_ERROR", requestId:msg.requestId, ok:false, error: err });
      cleanupAAF(msg.requestId);
      sendResponse({ ok:false, error: err });
    }
    return;
  }

  // ---- ProRes Native Streaming ----
  if (msg.type === "PRORES_STREAM_REQUEST") {
    const req = {
      requestId: msg.requestId || `prores_${Date.now()}`,
      filePath: msg.filePath || "",
      streamPort: msg.streamPort || 8080
    };
    cleanupProRes(req.requestId);
    startProResStream(req).then(sendResponse).catch(e => sendResponse({ ok:false, error: e?.message || String(e) }));
    return true;
  }

  if (msg.type === 'IMF_PROXY_DEBUG_GET') {
    sendResponse({ ok: true, debug: snapshotImfBridgeDebug() });
    return true;
  }

  // ---- Companion HTTP port (used by proResProxy) ----
  if (msg.type === "PRORES_GET_HTTP_PORT") {
    sendImfCompanion({ action: 'ping' }, 20000)
      .then(resp => {
        const port  = resp?.data?.port ?? null;
        const token = resp?.data?.httpToken ?? null;
        sendResponse({ port, token });
      })
      .catch(() => sendResponse({ port: null, token: null }));
    return true;
  }

  // ---- Dedicated companion availability check (used by Advanced Native Playback UI) ----
  // Does a single atomic connectNative → getCapabilities within this SW event so the
  // SW cannot be suspended mid-check.  Returns { ok, features, httpPort, diagError }.
  if (msg.type === "COMPANION_CHECK") {
    let done = false;
    let natPort;

    const finish = (ok, payload) => {
      if (done) return;
      done = true;
      try { natPort?.disconnect(); } catch (_) {}
      sendResponse(ok ? { ok: true, ...payload } : { ok: false, diagError: payload });
    };

    try {
      natPort = chrome.runtime.connectNative(IMF_COMPANION_HOST);
    } catch (e) {
      finish(false, e?.message || 'connectNative threw');
      return true;
    }

    // Register listeners BEFORE postMessage so an immediate disconnect is never missed.
    // timer declared with let so closure references are valid before assignment.
    let timer;
    natPort.onDisconnect.addListener(() => {
      clearTimeout(timer);
      finish(false, chrome.runtime.lastError?.message || 'companion disconnected unexpectedly');
    });

    natPort.onMessage.addListener((resp) => {
      clearTimeout(timer);
      const data = resp?.data || {};
      finish(true, {
        features:  data.features  ?? null,
        httpPort:  data.httpPort  ?? data.port ?? null,
      });
    });

    timer = setTimeout(() => finish(false, 'timeout — no response in 10s'), 10000);

    natPort.postMessage({ action: 'getCapabilities', _id: 'companion_check' });
    return true;
  }

    // ---- IMF Companion request/response bridge ----
  if (msg.type === "IMF_COMPANION_CALL") {
    const payload = msg.payload || {};
    // OCF actions that can be partially handled client-side when native helper
    // is unavailable — return a clean "unsupported" error instead of hanging.
    const OCF_ACTIONS = ['ocfProbeFolder','ocfProbeFile','ocfExrExportStart','ocfExrExportStatus',
                         'ocfExrExportCancel','ocfPickFolder','openFolder'];
    if (OCF_ACTIONS.includes(payload.action)) {
      sendImfCompanion(payload, msg.timeoutMs || 60000)
        .then((response) => sendResponse({ ok: true, response }))
        .catch((error) => {
          // Return structured error so UI can show fallback panel gracefully
          const userMsg = error?.userMessage || error?.message || String(error);
          sendResponse({ ok: false, error: {
            code: 'OCF_UNSUPPORTED',
            message: userMsg,
            userMessage: `Native Helper does not support ${payload.action}. ` +
              `Update PostFlowX Native Helper or use Resolve/Nuke handoff scripts.`,
          }});
        });
      return true;
    }
    sendImfCompanion(payload, msg.timeoutMs || 20000)
      .then((response) => {
        // Auto-track Resolve render jobs so the SW stays alive during the render.
        const action = payload.action || '';
        if ((action === 'resolveRunJob' || action === 'resolve.runJob') && response?.ok !== false) {
          const data = response?.data || response || {};
          const sessionId = data.sessionId || data.jobId;
          if (sessionId) {
            _resolveTrackJob(sessionId, data.jobId || sessionId).catch(() => {});
          }
        }
        sendResponse({ ok: true, response });
      })
      .catch((error) => sendResponse({ ok: false, error }));
    return true;
  }

// ---- IMF Proxy QC ----
  if (msg.type === "IMF_PROXY_REQUEST") {
    const req = {
      requestId: msg.requestId || `imf_${Date.now()}`,
      cplPath: msg.cplPath || "",
      streamPort: msg.streamPort || 8080
    };
    cleanupIMFProxy(req.requestId);
    startIMFProxyQC(req).then(sendResponse).catch(e => sendResponse({ ok:false, error: e?.message || String(e) }));
    return true;
  }

  // ── OCF → EXR Pull: all actions routed through IMF_COMPANION_CALL ──────────
  // ocfProbeFolder, ocfExrExportStart, ocfExrExportStatus, ocfExrExportCancel,
  // ocfPickFolder, openFolder — all forwarded as-is to native helper.
  // No additional processing needed here; the companion handles the heavy work.

  // ---- Render Queue: reveal Downloads folder in Finder ----
  if (msg.type === "RQ_SHOW_DOWNLOADS") {
    try { chrome.downloads.showDefaultFolder(); } catch(_) {}
    sendResponse({ ok: true });
    return true;
  }

  // ---- System live usage (CPU % + RAM used/total) ----
  if (msg.type === "GET_SYS_USAGE") {
    (async () => {
      // Fetch each API independently so one failure doesn't block the other
      let cpuNow = null, mem = null;
      try { cpuNow = await chrome.system.cpu.getInfo(); } catch {}
      try { mem    = await chrome.system.memory.getInfo(); } catch {}

      // CPU % — delta against stored previous sample
      let cpuPct = 0;
      let cpuActiveCores = null;
      let cpuEqCores = null;
      if (cpuNow && _prevCpuSample) {
        let totalDelta = 0, idleDelta = 0;
        let eqCoreLoad = 0;
        let activeCoreCount = 0;
        (cpuNow.processors || []).forEach((proc, i) => {
          const prev = _prevCpuSample.processors?.[i];
          if (!prev) return;
          // Use kernel+user+idle (not .total to avoid double-counting)
          const used  = u => (u.kernel || 0) + (u.user || 0) + (u.idle || 0);
          const procTotalDelta = used(proc.usage) - used(prev.usage);
          const procIdleDelta  = (proc.usage.idle || 0) - (prev.usage.idle || 0);
          totalDelta += procTotalDelta;
          idleDelta  += procIdleDelta;
          if (procTotalDelta <= 0) return;
          const procPct = Math.max(0, Math.min(100, (1 - procIdleDelta / procTotalDelta) * 100));
          eqCoreLoad += procPct / 100;
          // Count a core as actively used only once it carries meaningful load.
          if (procPct >= 20) activeCoreCount += 1;
        });
        cpuPct = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;
        cpuActiveCores = activeCoreCount;
        cpuEqCores = Number(eqCoreLoad.toFixed(1));
      }
      if (cpuNow) _prevCpuSample = cpuNow;

      // RAM — capacity always available; availableCapacity may be unreliable on macOS
      const ramTotal = mem?.capacity || 0;
      const ramUsed  = ramTotal > 0 ? Math.max(0, ramTotal - (mem.availableCapacity || 0)) : 0;
      const ramPct   = ramTotal > 0 ? Math.round(ramUsed / ramTotal * 100) : 0;

      sendResponse({
        cpu: Math.max(0, cpuPct),
        cpuActiveCores,
        cpuEqCores,
        ramUsed,
        ramTotal,
        ramPct,
      });
    })();
    return true;
  }

  // ---- GPU usage via companion (ioreg on macOS Apple Silicon) ----
  if (msg.type === "GET_GPU_USAGE") {
    sendImfCompanion({ action: 'getGpuUsage' }, 2500)
      .then(res => sendResponse({ gpuPct: typeof res?.data?.gpuPct === 'number' ? res.data.gpuPct : null }))
      .catch(() => sendResponse({ gpuPct: null }));
    return true;
  }

  // ---- System specs (CPU cores/model + RAM total) ----
  if (msg.type === "GET_SYS_INFO") {
    Promise.all([
      chrome.system.cpu.getInfo(),
      chrome.system.memory.getInfo()
    ]).then(([cpuInfo, memInfo]) => {
      const cores = cpuInfo.numOfProcessors || cpuInfo.processors?.length || '?';
      const model = (cpuInfo.modelName || '').replace(/\s+@.*$/, '').trim();
      const gb    = Math.round(memInfo.capacity / 1073741824);
      sendResponse({ cpu: model ? `${model} · ${cores}c` : `${cores} cores`, ram: `${gb} GB`, cores });
    }).catch(() => sendResponse({}));
    return true;
  }
});
