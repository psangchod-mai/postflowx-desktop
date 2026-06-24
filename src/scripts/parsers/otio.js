// modules/parser_otio.js
// OTIO parser — Timeline → Stack/Track/Clip
//
// ✅ Supports:
//   • DaVinci Resolve OTIO exports
//   • Avid (AAF-derived) OTIO exports (Clip.2 + media_references)
//
// ✅ Output contract for PostFlowX:
//   {
//     events:[{
//       clipName, srcFile, reel,
//       srcIn, srcOut, recIn, recOut,
//       fps, role, sourceType:"otio",
//       markers, _markers
//     }],
//     projectName,
//     fps
//   }
//
// Notes:
// - MPS pipeline (filters.js) assumes integer fps for HH:MM:SS:FF parsing.
//   OTIO often stores exact rates (e.g. 30000/1001). We normalize to nominal.
// - Uses timeline.global_start_time as record timecode base (Avid commonly 01:00:00:00).
// - For Resolve OTIO: record position is derived from Track cursor, including
//   OTIO Transition overlap offsets (in_offset/out_offset). Resolve often omits
//   range_in_parent on clips.
// - For nested Stack.1 (compound/multicam) we flatten to a SINGLE event using the
//   Stack source_range (record duration) + a "primary" inner Clip.2 for OCF naming.
// - For Avid OTIO (AAF-derived): source_range.start_time is SOURCE start, and
//   record position may be provided via range_in_parent.

export function parseOTIO(jsonInput) {
  try {
    // ----- Root: รองรับทั้ง string JSON และ object -----
    let root = {};
    if (typeof jsonInput === "string") {
      const txt = jsonInput.trim();
      root = txt ? JSON.parse(txt) : {};
    } else if (jsonInput && typeof jsonInput === "object") {
      root = jsonInput;
    }

    // --- Helpers ---
    const pad2 = (n) => String(n).padStart(2, "0");

    const stemNoExt = (p = "") => {
      const s = String(p || "");
      const i = s.lastIndexOf(".");
      return i > 0 ? s.slice(0, i) : s;
    };

    const toArray = (v) => (Array.isArray(v) ? v : (v ? [v] : []));

    const urlToFilename = (url = "") => {
      const s = String(url || "");
      try {
        if (s.startsWith("file:")) {
          const u = new URL(s);
          const p = u.pathname || "";
          const base = p.split("/").filter(Boolean).pop() || "";
          return decodeURIComponent(base);
        }
      } catch {
        // ignore
      }
      const parts = s.split(/[\\/]/);
      return parts[parts.length - 1] || s || "SOURCE";
    };

    const framesToTC = (fr, fps = 24) => {
      // fps must be integer here
      const FPS = Math.max(1, Math.round(fps || 24));
      const f = Math.max(0, Math.round(fr || 0));
      const s = Math.floor(f / FPS);
      const ff = f % FPS;
      const hh = Math.floor(s / 3600);
      const mm = Math.floor((s % 3600) / 60);
      const ss = s % 60;
      return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
    };

    // Normalize exact rate (e.g. 29.97002997) to nominal integer (30)
    const normalizeRateToNominal = (rateMaybe) => {
      const r = Number(rateMaybe);
      if (!Number.isFinite(r) || r <= 0) return { fps: 24, fpsExact: 24 };

      const candidates = [
        { exact: 24000 / 1001, nominal: 24 },
        { exact: 30000 / 1001, nominal: 30 },
        { exact: 60000 / 1001, nominal: 60 },
        { exact: 24, nominal: 24 },
        { exact: 25, nominal: 25 },
        { exact: 30, nominal: 30 },
        { exact: 50, nominal: 50 },
        { exact: 60, nominal: 60 }
      ];

      let best = { fps: Math.round(r), fpsExact: r };
      let bestDiff = Infinity;

      for (const c of candidates) {
        const d = Math.abs(r - c.exact);
        if (d < bestDiff) {
          bestDiff = d;
          best = { fps: c.nominal, fpsExact: r };
        }
      }

      // if it's something unusual (e.g. 120), keep rounded integer
      if (bestDiff > 0.05) return { fps: Math.max(1, Math.round(r)), fpsExact: r };
      return best;
    };

    // RationalTime helpers (OTIO: value / rate)
    // IMPORTANT: Many OTIO writers (including Avid AAF-derived) set rate≈29.97 but
    // keep value in nominal frames. If rate is close to fallbackRate, do NOT scale.
    const rtToFrames = (rt, fallbackRate = 24) => {
      if (!rt || typeof rt !== "object") return 0;
      const rate = Number(rt.rate ?? fallbackRate) || fallbackRate;
      const val = Number(rt.value ?? 0) || 0;

      // Treat near rates as same (29.97 ~ 30, 23.976 ~ 24)
      if (Math.abs(rate - fallbackRate) < 0.05) return Math.round(val);

      // Otherwise scale by seconds equivalence
      return Math.round(val * (fallbackRate / rate));
    };

    const rangeToFrames = (range, fallbackRate = 24) => {
      if (!range || typeof range !== "object") {
        return { startF: 0, durF: 0, endF: 0 };
      }
      const startF = rtToFrames(range.start_time, fallbackRate);
      const durF = rtToFrames(range.duration, fallbackRate);
      return { startF, durF, endF: startF + durF };
    };

    const toLower = (x) => String(x || "").toLowerCase();

    // OCF-ish detection (camera clip names)
    // NOTE: OTIO exports (Resolve) sometimes omit media references and keep only
    // the original camera filename in the Clip/Stack name. We treat DJI_* as OCF
    // so those clips remain actionable (not VIS-only).
    const looksLikeOCF = (s = "") => {
      const t = String(s || "");
      if (!t) return false;
      // Standard ARRI/Sony: letter + 3 digits + C + 3 digits
      if (/[A-Z]\d{3}C\d{3}/i.test(t)) return true;
      // ARRI LF / generic: letter + 3 digits + ANY letter + 3+ digits (e.g. A001L002)
      if (/^[A-Za-z]\d{3}[A-Za-z]\d{3,}/i.test(t)) return true;
      if (/^DJI_/i.test(t)) return true;
      // Any .mxf with camera-like naming (short alphanumeric roll/clip structure)
      if (/\.(mxf|r3d|braw|ari)$/i.test(t) && /^[A-Za-z][0-9A-Za-z_-]{3,}/i.test(t)) return true;
      return false;
    };

    const normalizeOcfName = (s = "") => {
      let n = stemNoExt(String(s || "")).trim();
      // common Resolve suffix: " - v1" (or "-v2")
      n = n.replace(/\s*-\s*v\d+\s*$/i, "").trim();
      return n;
    };

    const isVideoTrack = (tr) => {
      const k = toLower(tr?.kind || tr?.metadata?.kind || "");
      // ถ้าไม่ระบุ kind ให้ถือว่าเป็น video track (Resolve บางเวอร์ชันไม่เขียน kind)
      return k.includes("video") || !k;
    };

    // --- Project / timeline ---
    const projectName = root.name || root.timeline?.name || "PROJECT";

    // pick main timeline (Resolve-friendly)
    let pickTimeline = null;
    if (root.timeline) {
      pickTimeline = root.timeline;
    } else if (Array.isArray(root.timelines) && root.timelines.length) {
      pickTimeline = root.timelines[0];
    } else if (root.tracks) {
      pickTimeline = root;
    } else if (root.racks && !root.OTIO_SCHEMA) {
      pickTimeline = root;
    }

    if (!pickTimeline) {
      return { events: [], projectName, fps: 24 };
    }

    // fps default (exact)
    let fpsExact = 24;
    if (pickTimeline.global_start_time?.rate) {
      fpsExact = Number(pickTimeline.global_start_time.rate) || fpsExact;
    } else if (pickTimeline.duration?.rate) {
      fpsExact = Number(pickTimeline.duration.rate) || fpsExact;
    }

    const norm = normalizeRateToNominal(fpsExact);
    const fps = norm.fps;

    // Avid detection (AAF metadata present)
    const looksLikeAvid =
      !!root?.metadata?.AAF ||
      !!pickTimeline?.metadata?.AAF;

    // Timeline base record start (Avid commonly uses 01:00:00:00)
    const baseRecF = pickTimeline.global_start_time
      ? rtToFrames(pickTimeline.global_start_time, fps)
      : 0;

    // Collect tracks
    let trackNodes = [];
    if (pickTimeline?.tracks) {
      if (Array.isArray(pickTimeline.tracks)) {
        trackNodes = pickTimeline.tracks;
      } else if (pickTimeline.tracks.children) {
        trackNodes = toArray(pickTimeline.tracks.children);
      } else {
        trackNodes = toArray(pickTimeline.tracks);
      }
    } else if (root.tracks) {
      if (Array.isArray(root.tracks)) {
        trackNodes = root.tracks;
      } else if (root.tracks.children) {
        trackNodes = toArray(root.tracks.children);
      }
    }

    // guard against typo "racks"
    if (!trackNodes.length && pickTimeline?.racks) {
      const racks = Array.isArray(pickTimeline.racks)
        ? pickTimeline.racks
        : (pickTimeline.racks?.children ? toArray(pickTimeline.racks.children) : []);
      trackNodes = racks;
    }

    if (!trackNodes.length) {
      return { events: [], projectName, fps };
    }

    // Helper: extract camera reel/tape from OTIO clip or stack metadata.
    // Checks common keys written by Resolve, FCP X, and Avid OTIO exporters.
    const pickReelFromMetadata = (node) => {
      const meta = node?.metadata;
      if (!meta || typeof meta !== "object") return "";
      // Keys used by various exporters (checked case-insensitively via explicit list)
      const candidates = [
        meta?.reel, meta?.Reel,
        meta?.tape, meta?.Tape,
        meta?.TapeID, meta?.tape_name,
        meta?.["Final Cut Pro X"]?.tape_name,
        meta?.["Final Cut Pro X"]?.reel,
        meta?.["Avid Media Composer"]?.TapeID,
        meta?.Avid?.TapeID,
        meta?.FCP?.tape,
        meta?.DaVinci?.tape, meta?.DaVinci?.reel,
        meta?.sourceFile, meta?.SourceFile,
      ];
      for (const v of candidates) {
        const s = v != null ? String(v).trim() : "";
        if (s && s !== "SOURCE" && s !== "CLIP") return s;
      }
      return "";
    };

    // Helper: pick media reference for both OTIO styles
    const pickMediaRefFilename = (child) => {
      // 1) Standard OTIO: media_reference
      const mr = child?.media_reference;
      if (mr) {
        if (mr.target_url) return urlToFilename(mr.target_url);
        if (mr.name) return String(mr.name);
      }

      // 2) Avid OTIO: media_references + active_media_reference_key
      const mrs = child?.media_references;
      if (mrs && typeof mrs === "object") {
        const activeKey =
          child?.active_media_reference_key ||
          child?.metadata?.active_media_reference_key ||
          (mrs.DEFAULT_MEDIA ? "DEFAULT_MEDIA" : "");

        const tryKeys = [];
        if (activeKey) tryKeys.push(activeKey);
        if (mrs.DEFAULT_MEDIA) tryKeys.push("DEFAULT_MEDIA");

        // Prefer references that have target_url
        for (const k of tryKeys) {
          const ref = mrs[k];
          if (ref?.target_url) return urlToFilename(ref.target_url);
          if (ref?.name) return String(ref.name);
        }

        // Otherwise: first ref with target_url, else first ref name
        for (const k of Object.keys(mrs)) {
          const ref = mrs[k];
          if (ref?.target_url) return urlToFilename(ref.target_url);
        }
        for (const k of Object.keys(mrs)) {
          const ref = mrs[k];
          if (ref?.name) return String(ref.name);
        }
      }

      // 3) Metadata reel/tape (before falling back to clip name which may be a scene annotation)
      const metaReel = pickReelFromMetadata(child);
      if (metaReel) return metaReel;

      // 4) Fallback — only use clip name if it looks like a camera file (not a scene annotation)
      if (child?.name) {
        const n = String(child.name);
        if (looksLikeOCF(n) || /\.[a-zA-Z0-9]{2,5}$/.test(n)) return n;
      }
      return "";
    };

    const events = [];

    // ---------------------------------------------------------------------
    // OTIO record-time logic (Resolve-friendly)
    //
    // - record position is derived from Track cursor + range_in_parent (when present).
    // - Transition.1 objects define overlap via in_offset/out_offset.
    //   We model Resolve-style edit points by trimming:
    //     outgoing clip: subtract out_offset
    //     incoming clip: subtract in_offset
    //   This yields abutting clip blocks (Resolve-like) and stable cursor math.
    // - Nested Stack.1 (compound/multicam): DECOMPOSE recursively like FCPXML.
    //   Inner video tracks are expanded upward from the parent track instead of
    //   being flattened to a single wrapper clip.
    // ---------------------------------------------------------------------

    const getDurF = (item) => {
      const sr = rangeToFrames(item?.source_range, fps);
      if (sr?.durF) return sr.durF;
      const rp = rangeToFrames(item?.range_in_parent, fps);
      return rp?.durF || 0;
    };

    // Returns { scalar, speedPct, reversed, freeze }
    // speedPct is 100-based (200 = 2x fast, -103 = reversed at 103%, 0 = freeze)
    const getTimeWarpInfo = (item) => {
      let scalar = 1.0;
      let reversed = false;
      let freeze = false;
      const effs = Array.isArray(item?.effects) ? item.effects : [];
      for (const e of effs) {
        const sch = String(e?.OTIO_SCHEMA || "");
        if (sch.startsWith("LinearTimeWarp")) {
          const ts = Number(e?.time_scalar);
          if (Number.isFinite(ts) && ts !== 0) {
            if (ts < 0) reversed = true;
            scalar *= Math.abs(ts);
          }
        }
        if (sch.startsWith("FreezeFrame")) {
          freeze = true;
          scalar = 0;
        }
      }
      const speedPct = freeze ? 0 : (reversed ? -(scalar * 100) : scalar * 100);
      return { scalar: freeze ? 0 : scalar, speedPct, reversed, freeze };
    };

    // Back-compat alias used by buildClipEvent for duration math
    const getTimeScalar = (item) => getTimeWarpInfo(item).scalar;

    // Extract transform (scale/position/rotation/crop) from Premiere ADBE effects
    const getTransformFromEffects = (item) => {
      const effs = Array.isArray(item?.effects) ? item.effects : [];
      const out = {};
      const summaryParts = [];
      const animated = {};  // field → true if multiple keyframes

      const readParam = (params, displayName) => {
        for (const p of params) {
          if (p.DisplayName !== displayName) continue;
          const kfs = p.Keyframes || [];
          const vals = kfs.map(k => k.Value).filter(v => v != null);
          if (vals.length >= 2) return { values: vals, animated: true };
          if (vals.length === 1) return { values: vals, animated: false };
          if (p.StartValue != null) return { values: [p.StartValue.Value], animated: false };
        }
        return null;
      };

      for (const e of effs) {
        if (String(e?.OTIO_SCHEMA || '') !== 'Effect.1') continue;
        const pp = e?.metadata?.PremierePro_OTIO;
        if (!pp) continue;

        if (pp.MatchName === 'AE.ADBE Motion') {
          const params = pp.Parameters || [];
          // Scale
          const sc = readParam(params, 'Scale');
          if (sc) {
            const nums = sc.values.map(Number).filter(Number.isFinite);
            const scaleMax = Math.max(...nums);
            const scaleMin = Math.min(...nums);
            if (Math.abs(scaleMax / 100 - 1) > 0.005 || sc.animated) {
              out.scale = scaleMax;  // percent; _pmNormalizeTransform handles >10 → /100
              if (sc.animated) { animated.scale = true; summaryParts.push(`Scale ${Math.round(scaleMin)}–${Math.round(scaleMax)}%↗`); }
              else summaryParts.push(`Scale ${Math.round(scaleMax)}%`);
            }
          }
          // Position
          const pos = readParam(params, 'Position');
          if (pos) {
            const first = pos.values[0];
            if (first && typeof first === 'object' && (first.X != null || first.Y != null)) {
              // normalize 0–1 range → pixel offset from center (approximate)
              const px = Number(first.X ?? 0.5);
              const py = Number(first.Y ?? 0.5);
              if (Math.abs(px - 0.5) > 0.01 || Math.abs(py - 0.5) > 0.01) {
                out.position = [px, py];
                if (pos.animated) { animated.position = true; summaryParts.push('Pos↗'); }
              }
            }
          }
          // Rotation
          const rot = readParam(params, 'Rotation');
          if (rot) {
            const rv = Number(rot.values[0]);
            if (Number.isFinite(rv) && Math.abs(rv) > 0.01) {
              out.rotation = rv;
              if (rot.animated) { animated.rotation = true; summaryParts.push(`Rot ${rv.toFixed(1)}°↗`); }
              else summaryParts.push(`Rot ${rv.toFixed(1)}°`);
            }
          }
        }

        // Crop (AE.ADBE Crop)
        if (pp.MatchName === 'AE.ADBE Crop') {
          const params = pp.Parameters || [];
          const cropMap = { 'Crop Left': 'cropL', 'Crop Top': 'cropT', 'Crop Right': 'cropR', 'Crop Bottom': 'cropB' };
          let hasCrop = false;
          for (const p of params) {
            const field = cropMap[p.DisplayName];
            if (!field) continue;
            const kfs = p.Keyframes || [];
            const sv = p.StartValue?.Value ?? (kfs[0]?.Value);
            const n = Number(sv);
            if (Number.isFinite(n) && Math.abs(n) > 0.001) { out[field] = n; hasCrop = true; }
          }
          if (hasCrop) summaryParts.push('Crop');
        }
      }

      if (!Object.keys(out).length) return null;
      if (Object.keys(animated).length) out.animated = true;
      return { ...out, _summary: summaryParts.join(' | ') };
    };

    // Build EDL-style transition string from OTIO Transition.1 offsets
    const buildTransitionStr = (transNode) => {
      if (!transNode) return null;
      const inOff  = rtToFrames(transNode?.in_offset,  fps);
      const outOff = rtToFrames(transNode?.out_offset, fps);
      const dur = Math.max(inOff, outOff, 1);
      if (outOff > 0 && inOff === 0) return `FO${outOff}`;   // fade-out only
      if (inOff  > 0 && outOff === 0) return `FI${inOff}`;   // fade-in only
      return `D${dur}`;                                        // dissolve (both sides)
    };

    const computeVisibleRange = (recStartRelF, recDurF, windowStartF = 0, windowEndF = Number.POSITIVE_INFINITY) => {
      const recStart = Number(recStartRelF || 0);
      const recEnd = recStart + Math.max(0, Number(recDurF || 0));
      const visStart = Math.max(recStart, Number.isFinite(windowStartF) ? windowStartF : 0);
      const visEnd = Math.min(recEnd, Number.isFinite(windowEndF) ? windowEndF : recEnd);
      if (!(visEnd > visStart)) return null;
      return {
        visStart,
        visEnd,
        trimLeftF: visStart - recStart,
        trimRightF: recEnd - visEnd,
        visibleDurF: visEnd - visStart
      };
    };

    const emitEvent = ({
      clipName,
      srcName,
      reelName,
      srcInF,
      srcOutF,
      recInAbsF,
      recDurF,
      trackIndex,
      isDisabled,
      markers,
      extra = {}
    }) => {
      if (!recDurF || recDurF <= 0) return;
      const mks = Array.isArray(markers) ? markers : [];
      events.push({
        sourceType: "otio",
        type: "video",
        clipName: clipName || "CLIP",
        srcFile: srcName || "SOURCE",
        reel: reelName || stemNoExt(srcName || "SOURCE"),
        srcIn: framesToTC(srcInF || 0, fps),
        srcOut: framesToTC(srcOutF || 0, fps),
        recIn: framesToTC(recInAbsF || 0, fps),
        recOut: framesToTC((recInAbsF || 0) + recDurF, fps),
        disabled: !!isDisabled,
        enabled: !isDisabled,
        fps,
        fpsExact,
        role: "video",
        trackIndex,
        isOCF: looksLikeOCF(srcName || ""),
        markers: mks,
        _markers: mks,
        ...extra
      });
    };

    const parseAngleHintFromStackName = (nm = "") => {
      const m = String(nm || "").match(/\s-\s([A-Za-z0-9]+)\s*$/);
      return m ? String(m[1] || "").trim() : "";
    };

    const scoreCandidateClip = (clip) => {
      if (!clip || String(clip?.OTIO_SCHEMA || "") !== "Clip.2") return -1;
      const nm = String(clip?.name || "");
      const src = pickMediaRefFilename(clip);
      const sr = rangeToFrames(clip.source_range, fps);
      const dur = sr?.durF || 0;
      let score = 0;
      if (looksLikeOCF(nm) || looksLikeOCF(src)) score += 100000;
      const bad = ["text", "roundtrip dummy", "limbix_leader", "leader", "slug", "offline", "dummy"];
      const low = toLower(nm);
      if (bad.some((b) => low.includes(b))) score -= 5000;
      score += Math.min(5000, Math.max(0, dur));
      return score;
    };

    const collectCandidateClips = (node, out = []) => {
      if (!node) return out;
      const sch = String(node?.OTIO_SCHEMA || "");
      if (sch === "Clip.2") {
        out.push(node);
        return out;
      }
      if (sch.startsWith("Stack") || sch.startsWith("Track")) {
        const kids = toArray(node?.children || node?.items || node?.tracks);
        for (const k of kids) collectCandidateClips(k, out);
      }
      return out;
    };

    const pickPrimaryClipFromStack = (stack) => {
      const angleHint = parseAngleHintFromStackName(stack?.name);
      const tracks = toArray(stack?.children || stack?.tracks || stack?.items)
        .filter((t) => String(t?.OTIO_SCHEMA || "").startsWith("Track") && isVideoTrack(t));

      const ordered = [...tracks].sort((a, b) => {
        if (!angleHint) return 0;
        const an = String(a?.name || "").trim().toLowerCase();
        const bn = String(b?.name || "").trim().toLowerCase();
        const want = angleHint.toLowerCase();
        const am = (an === want) ? 0 : (an.endsWith(want) ? 1 : 2);
        const bm = (bn === want) ? 0 : (bn.endsWith(want) ? 1 : 2);
        return am - bm;
      });

      let best = null;
      let bestScore = -1;
      for (const tr of ordered) {
        const cands = collectCandidateClips(tr, []);
        for (const c of cands) {
          const s = scoreCandidateClip(c);
          if (s > bestScore) {
            bestScore = s;
            best = c;
          }
        }
        if (angleHint && best && bestScore >= 100000) break;
      }

      return best;
    };

    const buildMarkersForRange = ({ baseAbsF, recStartRelF, visible, sourceMarkers }) => {
      const out = [];
      if (!Array.isArray(sourceMarkers)) return out;
      const absStart = baseAbsF + visible.visStart;
      const absEnd = baseAbsF + visible.visEnd;
      for (const mk of sourceMarkers) {
        if (!mk) continue;
        const mName = mk.name || mk.label || "";
        const mColor = mk.color || "Green";
        const mrng = rangeToFrames(mk.marked_range, fps);
        const mkAbsF = baseAbsF + recStartRelF + (mrng.startF || 0);
        if (mkAbsF < absStart || mkAbsF > absEnd) continue;
        out.push({ name: mName, color: mColor, tc: framesToTC(mkAbsF, fps), scope: "clip" });
      }
      return out;
    };

    const buildStackFallbackEvent = ({ stack, baseAbsF, recStartRelF, recDurF, trackIndex, isDisabled, inTrimF, windowStartF, windowEndF, transitionIn = null, transitionOut = null }) => {
      const visible = computeVisibleRange(recStartRelF, recDurF, windowStartF, windowEndF);
      if (!visible) return;

      const primary = pickPrimaryClipFromStack(stack);
      const stackSR = rangeToFrames(stack?.source_range, fps);
      const stackStartInSourceF = stackSR.startF || 0;
      const warp = getTimeWarpInfo(stack);
      const timeScalar = warp.scalar || 1.0;

      const metaReelStack = pickReelFromMetadata(stack) || (primary ? pickReelFromMetadata(primary) : "");
      const srcNameRaw = primary ? (pickMediaRefFilename(primary) || metaReelStack || stack?.name) : (metaReelStack || stack?.name || "SOURCE");
      const srcName = String(srcNameRaw || "SOURCE");
      const clipName = String(stack?.name || (primary?.name || stemNoExt(srcName) || "CLIP"));
      const pSR = primary ? rangeToFrames(primary?.source_range, fps) : { startF: 0 };
      const srcTrimLeftF = (inTrimF || 0) + visible.trimLeftF;
      const srcInBaseF = (pSR.startF || 0) + (stackStartInSourceF || 0);
      const srcInF = srcInBaseF + Math.round(srcTrimLeftF * timeScalar);
      const srcDurF = Math.round((visible.visibleDurF || 0) * timeScalar);
      const srcOutF = srcInF + (timeScalar === 0 ? 1 : srcDurF);
      const reelName = looksLikeOCF(srcName) ? normalizeOcfName(srcName) : stemNoExt(srcName);
      const markers = buildMarkersForRange({ baseAbsF, recStartRelF, visible, sourceMarkers: stack?.markers });
      const transform = getTransformFromEffects(primary || stack);
      const transition = transitionOut || transitionIn || undefined;
      const speedPct = warp.speedPct;
      const extra = { kind: "compound" };
      if (transition) extra.transition = transition;
      if (Math.abs(speedPct - 100) > 0.1) extra.speedFactor = speedPct;
      if (warp.reversed) extra.speedReversed = true;
      if (transform) { extra.transform = transform; if (transform._summary) extra.transformSummary = transform._summary; }

      emitEvent({ clipName, srcName, reelName, srcInF, srcOutF, recInAbsF: baseAbsF + visible.visStart, recDurF: visible.visibleDurF, trackIndex, isDisabled, markers, extra });
    };

    const getStackTrackNodes = (stack) => {
      const kids = toArray(stack?.children || stack?.tracks || stack?.items);
      const tracks = kids.filter((t) => String(t?.OTIO_SCHEMA || "").startsWith("Track") && isVideoTrack(t));
      if (tracks.length) return tracks;
      const direct = kids.filter((t) => {
        const sch = String(t?.OTIO_SCHEMA || "");
        return sch.startsWith("Clip") || sch.startsWith("Stack") || sch.startsWith("Gap") || sch.startsWith("Transition");
      });
      if (!direct.length) return [];
      return [{ OTIO_SCHEMA: "Track.1", kind: "Video", children: direct, name: stack?.name || "Nested Track" }];
    };

    const buildClipEvent = ({ clip, baseAbsF, recStartRelF, recDurF, trackIndex, isDisabled, inTrimF, windowStartF, windowEndF, transitionIn = null, transitionOut = null }) => {
      const visible = computeVisibleRange(recStartRelF, recDurF, windowStartF, windowEndF);
      if (!visible) return;

      const warp = getTimeWarpInfo(clip);
      const timeScalar = warp.scalar || 1.0;
      const sr = rangeToFrames(clip?.source_range, fps);
      const srcNameRaw = pickMediaRefFilename(clip);
      const srcName = String(srcNameRaw || clip?.name || "SOURCE");
      const clipName = String(clip?.name || stemNoExt(srcName) || "CLIP");
      const srcTrimLeftF = (inTrimF || 0) + visible.trimLeftF;
      const srcInF = (sr.startF || 0) + Math.round(srcTrimLeftF * timeScalar);
      const srcDurF = Math.round((visible.visibleDurF || 0) * timeScalar);
      const srcOutF = srcInF + (timeScalar === 0 ? 1 : srcDurF);
      const reelName = looksLikeOCF(srcName) ? normalizeOcfName(srcName) : stemNoExt(srcName);
      const markers = buildMarkersForRange({ baseAbsF, recStartRelF, visible, sourceMarkers: clip?.markers });
      const transform = getTransformFromEffects(clip);
      // transition: outgoing side (FO/D) takes priority; if none, use incoming (FI/D)
      const transition = transitionOut || transitionIn || undefined;
      const speedPct = warp.speedPct;
      const extra = { kind: "clip" };
      if (transition) extra.transition = transition;
      if (Math.abs(speedPct - 100) > 0.1) extra.speedFactor = speedPct;
      if (warp.reversed) extra.speedReversed = true;
      if (transform) { extra.transform = transform; if (transform._summary) extra.transformSummary = transform._summary; }

      emitEvent({ clipName, srcName, reelName, srcInF, srcOutF, recInAbsF: baseAbsF + visible.visStart, recDurF: visible.visibleDurF, trackIndex, isDisabled, markers, extra });
    };

    const walkTrack = (track, baseAbsF, trackIndex, windowStartF = 0, windowEndF = Number.POSITIVE_INFINITY, inheritedDisabled = false) => {
      const children = toArray(track?.children || track?.items);
      let cursorF = 0;
      let pendingInTrimF = 0;
      let pendingTransitionIn = null; // transition string for the next clip's incoming side

      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (!child) continue;
        const schema = String(child?.OTIO_SCHEMA || "");

        if (schema.startsWith("Transition")) continue; // handled via lookahead below

        const enabled = (child?.enabled !== false);
        const isDisabled = !!(inheritedDisabled || !enabled);

        if (schema.startsWith("Gap")) {
          const durF = getDurF(child);
          cursorF += durF;
          pendingInTrimF = 0;
          continue;
        }

        const inTrimF = pendingInTrimF || 0;
        pendingInTrimF = 0;
        const transitionIn = pendingTransitionIn;
        pendingTransitionIn = null;

        let outTrimF = 0;
        let transitionOut = null;
        const next = children[i + 1];
        if (next && String(next?.OTIO_SCHEMA || "").startsWith("Transition")) {
          outTrimF        = rtToFrames(next?.out_offset, fps);
          pendingInTrimF  = rtToFrames(next?.in_offset,  fps);
          const str = buildTransitionStr(next);
          // Assign outgoing side to current clip; incoming side to next clip
          const inOff  = rtToFrames(next?.in_offset,  fps);
          const outOff = rtToFrames(next?.out_offset, fps);
          if (outOff > 0 && inOff === 0) {
            transitionOut    = `FO${outOff}`;
            pendingTransitionIn = null;
          } else if (inOff > 0 && outOff === 0) {
            transitionOut    = null;
            pendingTransitionIn = `FI${inOff}`;
          } else {
            // Dissolve — both clips carry it
            const dur = Math.max(inOff, outOff, 1);
            transitionOut    = `D${dur}`;
            pendingTransitionIn = `D${dur}`;
          }
        }

        let baseDurF = getDurF(child);
        let recStartRelF = cursorF;
        if (child?.range_in_parent) {
          const rp = rangeToFrames(child.range_in_parent, fps);
          recStartRelF = rp.startF;
          baseDurF = rp.durF || baseDurF;
          cursorF = Math.max(cursorF, recStartRelF);
        }

        const recDurF = Math.max(0, baseDurF - inTrimF - outTrimF);
        const recEndRelF = recStartRelF + recDurF;
        if (!(recDurF > 0)) {
          cursorF = Math.max(cursorF, recEndRelF);
          continue;
        }

        if (schema.startsWith("Stack")) {
          const visible = computeVisibleRange(recStartRelF, recDurF, windowStartF, windowEndF);
          if (visible) {
            const innerTracks = getStackTrackNodes(child);
            if (innerTracks.length) {
              // Check if primary inner clip looks like a real camera file.
              // If inner clips are scene annotations (multicam stack from Resolve), decomposing
              // would produce events with scene-annotation reels — use fallback instead.
              const primary = pickPrimaryClipFromStack(child);
              const primarySrc = primary ? (pickMediaRefFilename(primary) || primary?.name || "") : "";
              const primaryIsOCF = looksLikeOCF(primarySrc) || /\.[a-zA-Z0-9]{2,5}$/.test(primarySrc);
              if (primaryIsOCF) {
                const stackSR = rangeToFrames(child?.source_range, fps);
                const stackStartF = (stackSR.startF || 0) + (inTrimF || 0) + visible.trimLeftF;
                const stackEndF = stackStartF + visible.visibleDurF;
                const nestedBaseAbsF = baseAbsF + visible.visStart - stackStartF;
                for (let innerIndex = 0; innerIndex < innerTracks.length; innerIndex++) {
                  walkTrack(innerTracks[innerIndex], nestedBaseAbsF, trackIndex + innerIndex, stackStartF, stackEndF, isDisabled);
                }
              } else {
                // Multicam/scene-annotation stack — emit ONE event using stack name as reel/clip
                buildStackFallbackEvent({
                  stack: child,
                  baseAbsF,
                  recStartRelF,
                  recDurF,
                  trackIndex,
                  isDisabled,
                  inTrimF,
                  windowStartF,
                  windowEndF,
                  transitionIn,
                  transitionOut,
                });
              }
            } else {
              buildStackFallbackEvent({
                stack: child,
                baseAbsF,
                recStartRelF,
                recDurF,
                trackIndex,
                isDisabled,
                inTrimF,
                windowStartF,
                windowEndF,
                transitionIn,
                transitionOut,
              });
            }
          }
          cursorF = Math.max(cursorF, recEndRelF);
          continue;
        }

        if (schema.startsWith("Clip")) {
          buildClipEvent({
            clip: child,
            baseAbsF,
            recStartRelF,
            recDurF,
            trackIndex,
            isDisabled,
            inTrimF,
            windowStartF,
            windowEndF,
            transitionIn,
            transitionOut,
          });
          cursorF = Math.max(cursorF, recEndRelF);
          continue;
        }

        if (schema.startsWith("Track")) {
          walkTrack(child, baseAbsF + recStartRelF, trackIndex, windowStartF, windowEndF, isDisabled);
          cursorF = Math.max(cursorF, recEndRelF);
          continue;
        }

        cursorF = Math.max(cursorF, recEndRelF);
      }
    };

    // Walk each top-level Video track
    let trackCounter = 0;
    for (const tr of trackNodes) {
      if (!isVideoTrack(tr)) continue;
      walkTrack(tr, baseRecF, trackCounter);
      trackCounter++;
    }

    // Sort by Rec In (string TC → frames @ nominal fps)
    const tcToFramesLocal = (tc) => {
      const m = String(tc || "").match(/^(\d+):(\d+):(\d+):(\d+)$/);
      if (!m) return 0;
      return (+m[1] * 3600 + +m[2] * 60 + +m[3]) * fps + +m[4];
    };
    events.sort((a, b) => tcToFramesLocal(a.recIn) - tcToFramesLocal(b.recIn));

    // Dedup conservative (same srcFile+recIn+recOut+clipName+trackIndex+disabled)
    const seen = new Set();
    const dedup = [];
    for (const e of events) {
      const key = [e.srcFile, e.recIn, e.recOut, e.clipName, e.trackIndex, e.disabled ? 1 : 0].join("|");
      if (!seen.has(key)) {
        seen.add(key);
        dedup.push(e);
      }
    }

    return { events: dedup, projectName, fps, sourceType: "otio" };
  } catch (e) {
    console.warn("parseOTIO failed", e);
    return { events: [], projectName: "—", fps: 24, _error: String(e?.message || e) };
  }
}

export default { parseOTIO };
