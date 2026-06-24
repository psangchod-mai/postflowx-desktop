// scripts/parsers/aaf_wasm.js
// Adapter: normalises AAF worker output to the MPS parsed shape.
// Input from aaf_worker.js:
//   { events: [{ event, reel, clipName, srcIn, srcOut, recIn, recOut, fps }],
//     fps, projectName }
// Output (same shape as EDL / FCPXML parsers):
//   { events: [...], fps, projectName, sourceType: "aaf" }
//
// The worker already emits TC strings ("HH:MM:SS:FF").
// If a future WASM build sends frame numbers instead, framesToTC() converts them.

function stemNoExt(name = "") {
  const base = (String(name).split("/").pop() || "");
  const dot  = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

// Convert a frame number to "HH:MM:SS:FF" (pass-through if already a string)
function normTC(val, fps) {
  // Pass through valid TC strings, incl. drop-frame (HH:MM:SS;FF). Without the
  // ';' alternative a drop-frame TC was mangled to 00:00:00:00.
  if (typeof val === "string" && /^\d+[:;]\d+[:;]\d+[:;]\d+$/.test(val)) return val;
  const f = Math.max(0, Math.round(Number(val) || 0));
  const r = Math.max(1, Math.round(fps || 24));
  const fr = f % r;
  const s  = Math.floor(f / r) % 60;
  const m  = Math.floor(f / r / 60) % 60;
  const h  = Math.floor(f / r / 3600);
  return `${p2(h)}:${p2(m)}:${p2(s)}:${p2(fr)}`;
}
function p2(n) { return String(n).padStart(2, "0"); }

/**
 * Normalise AAF worker JSON → MPS parsed shape.
 * @param {object} aafJson  Raw data from aaf_worker.js
 * @param {string} fallbackName  Original filename (used for projectName fallback)
 */
export function parseAAFJson(aafJson, fallbackName = "AAF") {
  const fps         = Number(aafJson?.fps) || 24;
  const projectName = aafJson?.projectName || stemNoExt(fallbackName);
  const raw         = Array.isArray(aafJson?.events) ? aafJson.events : [];

  const events = raw
    .filter(ev => ev?.reel || ev?.clipName || ev?.sourceFile)
    .map((ev, i) => {
      const sourceFile = ev?.sourceFile || "";
      const reel       = String(ev?.reel || stemNoExt(sourceFile || ev?.clipName || `AAF_${i + 1}`)).trim();
      const evFps      = Number(ev?.fps) || fps;
      // Ensure srcFile is always set to the camera reel stem (never null/empty).
      // normalizeOCFReel() in ui.js uses ev.srcFile to recompute the reel; if srcFile were null
      // it would fall through to "REEL" and overwrite the correctly-extracted reel from the worker.
      const srcFile = sourceFile || reel;
      return {
        _from:      "aaf",
        sourceType: "aaf",
        type:       "video",
        role:       "video",
        event:      ev?.event ?? i + 1,
        reel,
        clipName: String(ev?.clipName || reel).trim(),
        camera:   "",
        fps:      evFps,
        srcIn:    normTC(ev?.srcIn,  evFps),
        srcOut:   normTC(ev?.srcOut, evFps),
        recIn:    normTC(ev?.recIn,  evFps),
        recOut:   normTC(ev?.recOut, evFps),
        srcFile,
        track:      ev?.track != null ? Number(ev.track) : 0,
        trackIndex: ev?.track != null ? Number(ev.track) : 0,
        disabled: false,
        isOCF:    false,
        markers:  [],
        _markers: [],
      };
    });

  return { events, fps, projectName, sourceType: "aaf" };
}
