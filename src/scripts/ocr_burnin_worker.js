/* scripts/ocr_burnin_worker.js
 * Burn-in OCR (ENG only) using embedded tesseract.js-core + eng.traineddata.
 * - No Chrome TextDetector dependency.
 * - Designed for MV3 extension pages.
 */

/* global TesseractCore */

const ORIGIN = self.location.origin;
const CORE_DIR = `${ORIGIN}/assets/ocr`;
const CORE_JS = `${CORE_DIR}/tesseract-core-lstm.js`;
const TRAINEDDATA = `${CORE_DIR}/eng.traineddata`;

let core = null;
let api = null;
let initPromise = null;

// Defaults (can be overridden per-recognize request)
let __defaultPsm = 6;
let __defaultWhitelist = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_./:-';

async function init(){
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // Load Emscripten glue (defines global TesseractCore factory)
    importScripts(CORE_JS);

    // Instantiate with locateFile so wasm resolves inside CORE_DIR.
    // NOTE: This tesseract-core build returns a *Promise* (TesseractCore.ready).
    // We must await it to get the actual Emscripten module object.
    // Silence extremely noisy stderr output coming from the native core.
    // These messages show up in chrome://extensions "Errors" and confuse users
    // (e.g. "Total count=0", quartile/mean stats, baseline debug lines).
    // If the core actually fails, we still surface the error via our JS layer.
    core = await TesseractCore({
      locateFile: (path) => `${CORE_DIR}/${path}`,
      print: () => {},
      printErr: () => {}
    });

    if (!core || !core.FS || !core.TessBaseAPI){
      throw new Error('Tesseract core init failed');
    }

    // Load traineddata into Emscripten FS.
    // Different core builds resolve tessdata differently (some look for /tessdata/eng.traineddata,
    // others fall back to /eng.traineddata). We write both for robustness.
    try { core.FS.mkdir('/tessdata'); } catch (e) {}
    // Some builds expect datapath + '/tessdata/<lang>.traineddata'
    // so we also create a nested tessdata directory.
    try { core.FS.mkdir('/tessdata/tessdata'); } catch (e) {}
    const resp = await fetch(TRAINEDDATA);
    if (!resp.ok) throw new Error(`Failed to load eng.traineddata: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    const td = new Uint8Array(buf);
    core.FS.writeFile('/tessdata/eng.traineddata', td);
    try { core.FS.writeFile('/tessdata/tessdata/eng.traineddata', td); } catch (e) {}
    try { core.FS.writeFile('/eng.traineddata', td); } catch (e) {}

    // Init API
    api = new core.TessBaseAPI();
    // datapath should contain tessdata; try the canonical path first, then root.
    let rc = 0;
    try {
      try { core.ENV = core.ENV || {}; core.ENV.TESSDATA_PREFIX = '/tessdata'; } catch (_e) {}
      rc = api.Init('/tessdata', 'eng');
    } catch (e) { rc = 1; }
    if (rc) {
      try { rc = api.Init('/', 'eng'); } catch(e) { rc = 1; }
    }
    if (rc) throw new Error('Failed to init tesseract (eng.traineddata not found)');
    // Robust defaults for burn-in style overlays
    api.SetPageSegMode(__defaultPsm); // uniform block by default
    api.SetVariable('tessedit_char_whitelist', __defaultWhitelist);
    api.SetVariable('preserve_interword_spaces', '1');
    api.SetVariable('user_defined_dpi', '300');
    // Disable word/frequency dictionaries — they "correct" filenames toward English words,
    // which degrades accuracy for camera roll names like A001L002_25030194.mxf
    api.SetVariable('load_system_dawg', 'false');
    api.SetVariable('load_freq_dawg', 'false');
    api.SetVariable('load_punc_dawg', 'false');
    api.SetVariable('load_number_dawg', 'false');
    api.SetVariable('load_unambig_dawg', 'false');
    api.SetVariable('load_bigram_dawg', 'false');
    // Increase beam width for better character-level accuracy
    api.SetVariable('lstm_choice_mode', '2');
    // Don't penalise non-word sequences (filenames are never "words")
    api.SetVariable('wordrec_enable_assoc', 'false');

    return true;
  })();
  // Reset on failure so the next call can retry instead of permanently caching the error.
  initPromise.catch(() => { initPromise = null; });
  return initPromise;
}

function recognizeRGBA(rgba, width, height){
  // Allocate and copy RGBA bytes to wasm heap, then SetImage.
  const bytes = new Uint8Array(rgba);
  const n = bytes.byteLength;
  const ptr = core._malloc(n);
  core.HEAPU8.set(bytes, ptr);

  try{
    // SetImage(pointer, width, height, bytesPerPixel, bytesPerLine, exif=1, angle=0)
    api.SetImage(ptr, width, height, 4, width * 4);
    const txt = api.GetUTF8Text();
    return (txt || '').trim();
  } finally {
    core._free(ptr);
  }
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  const id = msg.id;
  try{
    if (msg.type === 'ping'){
      self.postMessage({ id, ok: true, type: 'pong' });
      return;
    }

    if (msg.type === 'recognize'){
      await init();
      // Allow per-request tuning (e.g., single-line strips).
      try{
        const psm = Number.isFinite(msg?.psm) ? Number(msg.psm) : null;
        if (psm != null) api.SetPageSegMode(psm);
        else api.SetPageSegMode(__defaultPsm);
      } catch(_e) {}

      try{
        const wl = (typeof msg?.whitelist === 'string' && msg.whitelist.trim()) ? msg.whitelist.trim() : '';
        api.SetVariable('tessedit_char_whitelist', wl || __defaultWhitelist);
      } catch(_e) {}

      const { buffer, width, height } = msg.image || {};
      if (!buffer || !width || !height) throw new Error('Invalid image payload');
      const text = recognizeRGBA(buffer, width, height);
      self.postMessage({ id, ok: true, type: 'result', text });
      return;
    }

    self.postMessage({ id, ok: false, type: 'error', error: 'Unknown message type' });
  } catch (err){
    self.postMessage({ id, ok: false, type: 'error', error: String(err?.message || err) });
  }
};
