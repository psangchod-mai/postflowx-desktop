const $ = (sel) => document.querySelector(sel);

function assetUrl(relPath){
  try{
    if (globalThis.chrome?.runtime?.getURL) return chrome.runtime.getURL(relPath);
    if (globalThis.browser?.runtime?.getURL) return browser.runtime.getURL(relPath);
  } catch (_) {}
  try { return new URL(relPath, document.baseURI).toString(); } catch (_) {}
  return relPath;
}


let currentMode = "backlot";
let report = {};
let simpleExpanded = false;
let lastFile = null;
let lastResult = null;
let lastExtracted = null;
let rulesCache = null;

async function loadRules() {
  const [atmResp, labelsResp, profilesResp, loudResp, clipResp, hitResp, fmtResp, silResp] = await Promise.all([
    fetch(assetUrl("data/atmosLabelConfiguration.json")),
    fetch(assetUrl("data/netflix_recognized_group_labels.json")),
    fetch(assetUrl("data/netflix_adm_deliverable_profiles.json")),
    fetch(assetUrl("data/audioLoudnessInspection.json")),
    fetch(assetUrl("data/clippingInspection.json")),
    fetch(assetUrl("data/digitalHitInspection.json")),
    fetch(assetUrl("data/mediaFormatInspection.json")),
    fetch(assetUrl("data/silenceInspection.json")),
  ]);
  const atm = await atmResp.json();
  const labelsFallback = await labelsResp.json();
  const profiles = await profilesResp.json();
  const loudness = await loudResp.json();
  const clipping = await clipResp.json();
  const digitalHits = await hitResp.json();
  const mediaFormat = await fmtResp.json();
  const silence = await silResp.json();
  const labels = (atm && Array.isArray(atm.validAudioContentGroups)) ? atm : labelsFallback;
  return { labels, profiles, inspections: { loudness, clipping, digitalHits, mediaFormat, silence } };
}



function dbfsFromAmp(a){
  if (!a || a <= 0) return -Infinity;
  return 20 * Math.log10(a);
}

function evalMediaFormat(fmtInfo, cfg){
  const issues = [];
  if (!fmtInfo) return { pass:false, issues:["Missing fmt chunk"], summary:"Missing fmt" };
  const audioFormat = fmtInfo.audioFormat;
  const codec = (audioFormat === 1) ? "LPCM" : (audioFormat === 3 ? "FLOAT" : `WAV(${audioFormat})`);
  const ch = fmtInfo.numChannels || 0;
  const sr = fmtInfo.sampleRate || 0;
  const bd = fmtInfo.bitsPerSample || 0;

  const kbps = (sr && bd && ch) ? (sr * bd * ch / 1000) : 0;

  const allowedCodec = (cfg?.allowedCodecs || []).map(String);
  if (allowedCodec.length && !allowedCodec.includes(codec)) issues.push(`Codec ${codec} not allowed`);

  if (audioFormat === 3 && cfg?.floatingPointAllowed === false) issues.push("Floating point not allowed");

  const allowedSR = cfg?.allowedSampleRate || [];
  if (allowedSR.length && !allowedSR.includes(sr)) issues.push(`Sample rate ${sr} not allowed`);

  const allowedBD = cfg?.allowedPCMBitDepth || [];
  if (allowedBD.length && !allowedBD.includes(bd)) issues.push(`Bit depth ${bd} not allowed`);

  const allowedCh = new Set([...(cfg?.allowedChannelCount||[]), ...((cfg?.extraSupportedChannelMappings)||[])]);
  if (allowedCh.size && !allowedCh.has(ch)) issues.push(`Channel count ${ch} not allowed`);

  if (cfg?.minBitRate && kbps && kbps < cfg.minBitRate) issues.push(`Bitrate ${kbps.toFixed(0)} kbps < ${cfg.minBitRate}`);

  const pass = issues.length === 0;
  const summary = pass ? `PASS • ${codec} • ${ch}ch @ ${sr}Hz • ${bd}-bit` : `FAIL • ${issues[0]}`;
  return { pass, codec, channels: ch, sampleRate: sr, bitDepth: bd, bitRateKbps: kbps, issues, summary };
}

function channelLayoutGroups(ch){
  // Approx standard order for 2/6/8. For others, best-effort.
  if (ch === 2) return { LR:[0,1], C:[], LFE:[], Surround:[] };
  if (ch === 6) return { LR:[0,1], C:[2], LFE:[3], Surround:[4,5] };
  if (ch === 8) return { LR:[0,1], C:[2], LFE:[3], Surround:[4,5,6,7] };
  if (ch === 10) return { LR:[0,1], C:[2], LFE:[3], Surround:[4,5,6,7], Height:[8,9] };
  return { LR:[0,1].filter(i=>i<ch), C:[2].filter(i=>i<ch), LFE:[3].filter(i=>i<ch), Surround:Array.from({length:Math.max(0,ch-4)},(_,i)=>i+4) };
}

async function runAudioScanQuick(file, extracted, cfgs, onMsg){
  const loudCfg = cfgs?.loudness || {};
  const clipCfg = cfgs?.clipping || {};
  const hitCfg = cfgs?.digitalHits || {};
  const silCfg = cfgs?.silence || {};

  const fmtInfo = extracted?.fmtInfo;
  const dataChunk = extracted?.dataChunk;
  if (!fmtInfo || !dataChunk) return { error: "No audio data chunk info available." };

  if (fmtInfo.audioFormat !== 1) {
    return { error: `AudioFormat ${fmtInfo.audioFormat} not supported for scan (PCM only).` };
  }

  const ch = fmtInfo.numChannels || 0;
  const sr = fmtInfo.sampleRate || 0;
  const bd = fmtInfo.bitsPerSample || 0;
  const bps = bd / 8;
  if (![2,3,4].includes(bps)) return { error: `Unsupported bit depth ${bd}` };
  const frameSize = ch * bps;
  if (!frameSize || !sr) return { error: "Invalid PCM format" };

  const MAX_BYTES = 40 * 1024 * 1024;
  const half = Math.floor(MAX_BYTES / 2);

  const windows = [];
  const startOff = dataChunk.offset;
  const startSize = Math.min(half, dataChunk.size);
  windows.push({ off: startOff, size: startSize, label: "start" });

  if (dataChunk.size > startSize + 1024) {
    const endSize = Math.min(half, dataChunk.size - startSize);
    const endOff = dataChunk.offset + dataChunk.size - endSize;
    if (endOff > startOff) windows.push({ off: endOff, size: endSize, label: "end" });
  }

  const absMax = new Array(ch).fill(0);
  const prev = new Array(ch).fill(0);
  const silentCount = new Array(ch).fill(0);
  const totalCount = new Array(ch).fill(0);

  const clipThr = (typeof clipCfg.repeatedClippingNearFullscaleThreshold === "number") ? clipCfg.repeatedClippingNearFullscaleThreshold : 0.95;
  const clipSamples = new Array(ch).fill(0);
  const clipRuns = new Array(ch).fill(0);
  const clipRunStart = new Array(ch).fill(0);
  const clipSegments = Array.from({length:ch}, ()=>[]);
  const maxSeg = clipCfg.maxClippedSegmentsToReportPerChannel || 3;

  const hits = [];
  const maxHits = hitCfg.maximumNumberHitsReported || 10;
  const silenceThr = 0.0005; // ~ -66 dBFS

  let scannedBytes = 0;
  let scannedFrames = 0;

  const decodeSample = (u8, i) => {
    if (bd === 16) {
      const v = (u8[i] | (u8[i+1] << 8));
      const s = (v & 0x8000) ? v - 0x10000 : v;
      return s / 32768;
    }
    if (bd === 24) {
      let v = (u8[i] | (u8[i+1] << 8) | (u8[i+2] << 16));
      if (v & 0x800000) v = v - 0x1000000;
      return v / 8388608;
    }
    if (bd === 32) {
      // PCM 32-bit int
      let v = (u8[i] | (u8[i+1] << 8) | (u8[i+2] << 16) | (u8[i+3] << 24));
      return v / 2147483648;
    }
    return 0;
  };

  for (const w of windows) {
    onMsg?.(`Scanning audio (${w.label})…`);
    const buf = await file.slice(w.off, w.off + w.size).arrayBuffer();
    const u8 = new Uint8Array(buf);
    scannedBytes += u8.byteLength;

    const frames = Math.floor(u8.length / frameSize);
    for (let f = 0; f < frames; f++) {
      const base = f * frameSize;
      scannedFrames += 1;
      for (let c = 0; c < ch; c++) {
        const si = base + c * bps;
        const s = decodeSample(u8, si);
        const a = Math.abs(s);
        if (a > absMax[c]) absMax[c] = a;

        // silence
        totalCount[c] += 1;
        if (a < silenceThr) silentCount[c] += 1;

        // clipping samples + segments
        if (a >= clipThr) {
          clipSamples[c] += 1;
          if (clipRuns[c] === 0) clipRunStart[c] = scannedFrames;
          clipRuns[c] += 1;
        } else if (clipRuns[c] > 0) {
          if (clipSegments[c].length < maxSeg) {
            clipSegments[c].push({ startFrame: clipRunStart[c], frames: clipRuns[c] });
          }
          clipRuns[c] = 0;
        }

        // digital hits heuristic
        const d = Math.abs(s - prev[c]);
        if (hits.length < maxHits && d > 0.8 && a > 0.6 && Math.abs(prev[c]) < 0.2) {
          hits.push({ channel: c+1, frame: scannedFrames, timeSec: scannedFrames / sr, delta: d });
        }
        prev[c] = s;
      }
    }
  }

  // flush clip runs
  for (let c = 0; c < ch; c++) {
    if (clipRuns[c] > 0 && clipSegments[c].length < maxSeg) {
      clipSegments[c].push({ startFrame: clipRunStart[c], frames: clipRuns[c] });
    }
  }

  const overallMax = Math.max(...absMax);
  const samplePeakDb = dbfsFromAmp(overallMax);
  const truePeakDbEst = samplePeakDb; // MVP
  const scannedSeconds = scannedFrames / sr;

  const clipTotal = clipSamples.reduce((a,b)=>a+b,0);
  const clipError = (clipCfg.statisticalClippingErrorThreshold != null) ? (clipTotal > clipCfg.statisticalClippingErrorThreshold) : false;

  const layout = channelLayoutGroups(ch);
  const pct = (arrIdx) => {
    if (!arrIdx.length) return null;
    let s=0,t=0;
    for (const i of arrIdx) { s += silentCount[i] || 0; t += totalCount[i] || 0; }
    return t ? (100*s/t) : null;
  };
  const lrPct = pct(layout.LR);
  const cPct = pct(layout.C);
  const surPct = pct(layout.Surround);
  const overallPct = (totalCount.reduce((a,b)=>a+b,0)) ? (100*silentCount.reduce((a,b)=>a+b,0)/totalCount.reduce((a,b)=>a+b,0)) : null;

  const silenceNotes = [];
  if (overallPct != null && overallPct >= (silCfg.nearTotalSilence ?? 99)) silenceNotes.push(`Near-total silence (~${overallPct.toFixed(1)}%)`);
  if (lrPct != null && silCfg.allowedLRChannelSilencePercent != null && lrPct > silCfg.allowedLRChannelSilencePercent) silenceNotes.push(`LR silence ${lrPct.toFixed(1)}% > ${silCfg.allowedLRChannelSilencePercent}%`);
  if (cPct != null && silCfg.allowedCenterChannelSilencePercent != null && cPct > silCfg.allowedCenterChannelSilencePercent) silenceNotes.push(`C silence ${cPct.toFixed(1)}% > ${silCfg.allowedCenterChannelSilencePercent}%`);
  if (surPct != null && silCfg.allowedSurroundChannelSilencePercent != null && surPct > silCfg.allowedSurroundChannelSilencePercent) silenceNotes.push(`Surround silence ${surPct.toFixed(1)}% > ${silCfg.allowedSurroundChannelSilencePercent}%`);

  const peakViol = (isFinite(samplePeakDb) && loudCfg.maxSamplePeakDBFS != null) ? (samplePeakDb > loudCfg.maxSamplePeakDBFS) : false;
  const tpViol = (isFinite(truePeakDbEst) && loudCfg.maxTruePeakDBFS != null) ? (truePeakDbEst > loudCfg.maxTruePeakDBFS) : false;

  return {
    scannedSeconds,
    scannedBytes,
    samplePeakDbfs: samplePeakDb,
    truePeakDbfsEst: truePeakDbEst,
    peakViolation: peakViol,
    truePeakViolation: tpViol,
    clipping: { clippedSamples: clipTotal, error: clipError, threshold: clipCfg.statisticalClippingErrorThreshold ?? null, segmentsPerChannel: clipSegments },
    digitalHits: { count: hits.length, examples: hits },
    silence: { overallPercent: overallPct, lrPercent: lrPct, cPercent: cPct, surroundPercent: surPct, notes: silenceNotes },
  };
}


async function runAudioScanFull(file, extracted, cfgs, onMsg, onProgress, isCancelled){
  const loudCfg = cfgs?.loudness || {};
  const clipCfg = cfgs?.clipping || {};
  const hitCfg = cfgs?.digitalHits || {};
  const silCfg = cfgs?.silence || {};

  const fmtInfo = extracted?.fmtInfo;
  const dataChunk = extracted?.dataChunk;
  if (!fmtInfo || !dataChunk) return { error: "No audio data chunk info available." };

  if (fmtInfo.audioFormat !== 1) {
    return { error: `AudioFormat ${fmtInfo.audioFormat} not supported for scan (PCM only).` };
  }

  const ch = fmtInfo.numChannels || 0;
  const sr = fmtInfo.sampleRate || 0;
  const bd = fmtInfo.bitsPerSample || 0;
  const bps = bd / 8;
  if (![2,3,4].includes(bps)) return { error: `Unsupported bit depth ${bd}` };
  const frameSize = ch * bps;
  if (!frameSize || !sr) return { error: "Invalid PCM format" };

  // Accumulators (same as quick)
  const absMax = new Array(ch).fill(0);
  const prev = new Array(ch).fill(0);
  const silentCount = new Array(ch).fill(0);
  const totalCount = new Array(ch).fill(0);

  const clipThr = (typeof clipCfg.repeatedClippingNearFullscaleThreshold === "number") ? clipCfg.repeatedClippingNearFullscaleThreshold : 0.95;
  const clipSamples = new Array(ch).fill(0);
  const clipRuns = new Array(ch).fill(0);
  const clipRunStart = new Array(ch).fill(0);
  const clipSegments = Array.from({length:ch}, ()=>[]);
  const maxSeg = clipCfg.maxClippedSegmentsToReportPerChannel || 3;

  const hits = [];
  const maxHits = hitCfg.maximumNumberHitsReported || 10;
  const silenceThr = 0.0005; // ~ -66 dBFS

  let scannedBytes = 0;
  let scannedFrames = 0;

  const decodeSample = (u8, i) => {
    if (bd === 16) {
      const v = (u8[i] | (u8[i+1] << 8));
      const s = (v & 0x8000) ? v - 0x10000 : v;
      return s / 32768;
    }
    if (bd === 24) {
      let v = (u8[i] | (u8[i+1] << 8) | (u8[i+2] << 16));
      if (v & 0x800000) v = v - 0x1000000;
      return v / 8388608;
    }
    if (bd === 32) {
      let v = (u8[i] | (u8[i+1] << 8) | (u8[i+2] << 16) | (u8[i+3] << 24));
      return v / 2147483648;
    }
    return 0;
  };

  // Stream over entire data chunk in manageable blocks
  const totalBytes = Number(dataChunk.size || 0);
  const startOff = Number(dataChunk.offset || 0);
  const BLOCK = 8 * 1024 * 1024; // 8 MB
  let off = 0;

  let carry = new Uint8Array(0);

  onMsg?.("Scanning audio (full) …");

  while (off < totalBytes) {
    if (isCancelled?.()) return { cancelled: true, scannedSeconds: scannedFrames / sr, scannedBytes };

    const take = Math.min(BLOCK, totalBytes - off);
    const buf = await file.slice(startOff + off, startOff + off + take).arrayBuffer();
    let u8 = new Uint8Array(buf);
    scannedBytes += u8.byteLength;

    // Prepend carry if we had leftover bytes from last block
    if (carry.length) {
      const merged = new Uint8Array(carry.length + u8.length);
      merged.set(carry, 0);
      merged.set(u8, carry.length);
      u8 = merged;
      carry = new Uint8Array(0);
    }

    const frames = Math.floor(u8.length / frameSize);
    const usable = frames * frameSize;
    if (usable < u8.length) carry = u8.slice(usable);

    for (let f = 0; f < frames; f++) {
      const base = f * frameSize;
      scannedFrames += 1;
      for (let c = 0; c < ch; c++) {
        const si = base + c * bps;
        const s = decodeSample(u8, si);
        const a = Math.abs(s);
        if (a > absMax[c]) absMax[c] = a;

        totalCount[c] += 1;
        if (a < silenceThr) silentCount[c] += 1;

        if (a >= clipThr) {
          clipSamples[c] += 1;
          if (clipRuns[c] === 0) clipRunStart[c] = scannedFrames;
          clipRuns[c] += 1;
        } else if (clipRuns[c] > 0) {
          if (clipSegments[c].length < maxSeg) {
            clipSegments[c].push({ startFrame: clipRunStart[c], frames: clipRuns[c] });
          }
          clipRuns[c] = 0;
        }

        const d = Math.abs(s - prev[c]);
        if (hits.length < maxHits && d > 0.8 && a > 0.6 && Math.abs(prev[c]) < 0.2) {
          hits.push({ channel: c+1, frame: scannedFrames, timeSec: scannedFrames / sr, delta: d });
        }
        prev[c] = s;
      }
    }

    off += take;

    if (typeof onProgress === "function") {
      const pct = totalBytes ? Math.min(100, (100 * off / totalBytes)) : 0;
      onProgress(pct, scannedFrames / sr);
    }
    // Yield to UI
    await new Promise(r => setTimeout(r, 0));
  }

  // flush clip runs
  for (let c = 0; c < ch; c++) {
    if (clipRuns[c] > 0 && clipSegments[c].length < maxSeg) {
      clipSegments[c].push({ startFrame: clipRunStart[c], frames: clipRuns[c] });
    }
  }

  const overallMax = Math.max(...absMax);
  const samplePeakDb = dbfsFromAmp(overallMax);
  const truePeakDbEst = samplePeakDb; // MVP
  const scannedSeconds = scannedFrames / sr;

  const clipTotal = clipSamples.reduce((a,b)=>a+b,0);
  const clipError = (clipCfg.statisticalClippingErrorThreshold != null) ? (clipTotal > clipCfg.statisticalClippingErrorThreshold) : false;

  const layout = channelLayoutGroups(ch);
  const pct = (arrIdx) => {
    if (!arrIdx.length) return null;
    let s=0,t=0;
    for (const i of arrIdx) { s += silentCount[i] || 0; t += totalCount[i] || 0; }
    return t ? (100*s/t) : null;
  };
  const lrPct = pct(layout.LR);
  const cPct = pct(layout.C);
  const surPct = pct(layout.Surround);
  const overallPct = (totalCount.reduce((a,b)=>a+b,0)) ? (100*silentCount.reduce((a,b)=>a+b,0)/totalCount.reduce((a,b)=>a+b,0)) : null;

  const silenceNotes = [];
  if (overallPct != null && overallPct >= (silCfg.nearTotalSilence ?? 99)) silenceNotes.push(`Near-total silence (~${overallPct.toFixed(1)}%)`);
  if (lrPct != null && silCfg.allowedLRChannelSilencePercent != null && lrPct > silCfg.allowedLRChannelSilencePercent) silenceNotes.push(`LR silence ${lrPct.toFixed(1)}% > ${silCfg.allowedLRChannelSilencePercent}%`);
  if (cPct != null && silCfg.allowedCenterChannelSilencePercent != null && cPct > silCfg.allowedCenterChannelSilencePercent) silenceNotes.push(`C silence ${cPct.toFixed(1)}% > ${silCfg.allowedCenterChannelSilencePercent}%`);
  if (surPct != null && silCfg.allowedSurroundChannelSilencePercent != null && surPct > silCfg.allowedSurroundChannelSilencePercent) silenceNotes.push(`Surround silence ${surPct.toFixed(1)}% > ${silCfg.allowedSurroundChannelSilencePercent}%`);

  const peakViol = (isFinite(samplePeakDb) && loudCfg.maxSamplePeakDBFS != null) ? (samplePeakDb > loudCfg.maxSamplePeakDBFS) : false;
  const tpViol = (isFinite(truePeakDbEst) && loudCfg.maxTruePeakDBFS != null) ? (truePeakDbEst > loudCfg.maxTruePeakDBFS) : false;

  return {
    scannedSeconds,
    scannedBytes,
    samplePeakDbfs: samplePeakDb,
    truePeakDbfsEst: truePeakDbEst,
    peakViolation: peakViol,
    truePeakViolation: tpViol,
    clipping: { clippedSamples: clipTotal, error: clipError, threshold: clipCfg.statisticalClippingErrorThreshold ?? null, segmentsPerChannel: clipSegments },
    digitalHits: { count: hits.length, examples: hits },
    silence: { overallPercent: overallPct, lrPercent: lrPct, cPercent: cPct, surroundPercent: surPct, notes: silenceNotes },
  };
}

function levenshtein(a, b) {
  a = a || ""; b = b || "";
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[n];
}

function sourceCategory(source) {
  const s = (source || "").toLowerCase();
  if (s.includes("audioprogramme")) return "programme";
  if (s.includes("audiopackformat")) return "pack";
  if (s.includes("audiotrackformat")) return "trackformat";
  if (s.includes("audiotrackuid")) return "trackuid";
  if (s.includes("audioobject")) return "object";
  if (s.includes("audiocontent")) return "content";
  return "other";
}

function bestGroupSuggestion(normLabel, normLists) {
  let best = { group: null, label: null, dist: Infinity };
  for (const [group, arr] of Object.entries(normLists || {})) {
    for (const s of arr) {
      const d = levenshtein(normLabel, s);
      if (d < best.dist) best = { group, label: s, dist: d };
      if (best.dist === 0) return best;
    }
  }
  return best.group ? best : null;
}

function fixForReject(rawLabel, source, normLists) {
  const cat = sourceCategory(source);
  const norm = normalizeLabel(rawLabel);

  if (cat === "programme") {
    return "Not a bed/object group label. Fix: ignore audioProgrammeName in label QC (validate audioObject/audioContent only).";
  }
  if (cat === "pack") {
    return "Technical pack name. Fix: ignore audioPackFormatName in label QC.";
  }
  if (cat === "trackformat" || cat === "trackuid") {
    return "Channel identifier (not group). Fix: exclude audioTrackFormat/UID from group label QC.";
  }

  const sug = bestGroupSuggestion(norm, normLists);
  if (sug) return `Rename to a recognized ${sug.group} label (closest: "${sug.label}").`;
  return "Rename to a recognized group label (Dialogue/Music/Effects/Narration).";
}

function normalizeLabel(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function setPill(el, text, tone) {
  el.textContent = text;
  el.style.borderColor = "rgba(255,255,255,0.10)";
  el.style.background = "rgba(255,255,255,0.04)";
  if (tone === "good") { el.style.borderColor = "rgba(56,217,150,0.45)"; el.style.background = "rgba(56,217,150,0.10)"; }
  if (tone === "warn") { el.style.borderColor = "rgba(255,204,102,0.50)"; el.style.background = "rgba(255,204,102,0.10)"; }
  if (tone === "bad")  { el.style.borderColor = "rgba(255,92,92,0.55)";  el.style.background = "rgba(255,92,92,0.12)"; }
}

function setStatus(msg) { $("#statusLine").textContent = msg; }

function setProgress(pct, label){
  const wrap = document.getElementById("progressWrap");
  const bar = document.getElementById("progressBar");
  const text = document.getElementById("progressText");
  if (!wrap || !bar || !text) return;
  if (pct == null) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const p = Math.max(0, Math.min(100, pct));
  bar.style.width = `${p.toFixed(0)}%`;
  text.textContent = label ? label : `${p.toFixed(0)}%`;
}

function setActiveGroup(selector, className, matcher) {
  document.querySelectorAll(selector).forEach(btn => {
    const on = matcher(btn);
    btn.classList.toggle(className, on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
}

function switchMode(mode) {
  currentMode = mode;
  const sel = document.getElementById("modeSelect");
  if (sel) sel.value = mode;
  // (Mode UI removed) Keep status line for operational messages.
}

function switchTab(tab) {
  // Single-page layout: no tabs.
  return;
}

function resetUI() {
  $("#fileMeta").hidden = true;
  $("#fileMeta").textContent = "";

  $("#mAdm").textContent = "—";
  $("#mLabels").textContent = "—";
  $("#mFormat").textContent = "—";
  $("#mChna").textContent = "—";

  setPill($("#pAdm"), "Waiting");
  setPill($("#pLabels"), "Waiting");
  setPill($("#pFormat"), "—");
  setPill($("#pChna"), "Waiting");

  const tb = $("#labelsTable tbody");
  tb.innerHTML = `<tr class="empty"><td colspan="5">No file loaded.</td></tr>`;
  _allLabelRows = [];
  try { const cEl = document.getElementById("labelsCount"); if (cEl) cEl.textContent = "—"; } catch {}
  try { const qEl = document.getElementById("filterText"); if (qEl) qEl.value = ""; } catch {}
  try { const sEl = document.getElementById("filterStatus"); if (sEl) sEl.value = "ALL"; } catch {}
  try { const gEl = document.getElementById("filterGroup"); if (gEl) gEl.value = "ALL"; } catch {}
  (() => { const _st = document.getElementById("structureText"); if (_st) _st.textContent = "No data."; })();

  report = {};
  lastFile = null;
  lastResult = null;
  try { const st = document.getElementById("scanStatus"); if (st) st.textContent = "Not run"; } catch {}
  $("#reportJson").textContent = JSON.stringify(report, null, 2);
  try { renderReportSummary(report); } catch {}
  try { setProgress(null); } catch {}
  setStatus("Ready.");
}

function renderLabelsTable(rows) {
  const tb = $("#labelsTable tbody");
  tb.innerHTML = "";
  if (!rows.length) {
    tb.innerHTML = `<tr class="empty"><td colspan="5">No label entries (AXML structure may be nonstandard / namespace).</td></tr>`;
    return;
  }
  for (const r of rows) {
    const cls = r.status === "PASS" ? "pass" : (r.status === "WARN" ? "warn" : "reject");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="badge ${cls}">${r.status}</span></td>
      <td>${escapeHtml(r.rawLabel || "")}</td>
      <td>${escapeHtml((r.mapped || "") + (r.subgroup ? ` / ${r.subgroup}` : ""))}</td>
      <td>${escapeHtml(r.source || "")}</td>
      <td class="fix">${escapeHtml(r.fix || "")}</td>
    `;
    tb.appendChild(tr);
  }
}

let _allLabelRows = [];
let lastFilteredRows = null;

function applyLabelFilters() {
  const qEl = document.getElementById("filterText");
  const sEl = document.getElementById("filterStatus");
  const gEl = document.getElementById("filterGroup");
  const q = (qEl?.value || "").trim().toLowerCase();
  const status = (sEl?.value || "ALL");
  const group = (gEl?.value || "ALL");

  let rows = Array.isArray(_allLabelRows) ? _allLabelRows.slice() : [];
  if (status !== "ALL") rows = rows.filter(r => r.status === status);
  if (group !== "ALL") {
    if (group === "UNMAPPED") rows = rows.filter(r => !r.mapped);
    else rows = rows.filter(r => (r.mapped || "") === group);
  }
  if (q) {
    rows = rows.filter(r =>
      (r.rawLabel || "").toLowerCase().includes(q) ||
      (r.mapped || "").toLowerCase().includes(q) ||
      (r.source || "").toLowerCase().includes(q)
    );
  }

  lastFilteredRows = rows;
  renderLabelsTable(rows);

  const cEl = document.getElementById("labelsCount");
  if (cEl) cEl.textContent = `${rows.length} shown / ${_allLabelRows.length}`;
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[m]));
}


function fmtSize(bytes){
  if (!Number.isFinite(bytes)) return "—";
  const mb = bytes / 1024 / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb/1024).toFixed(2)} GB`;
}

function setText(id, val){
  const el = document.getElementById(id);
  if (el) el.textContent = val ?? "—";
}

function setSevByValueId(valueId, sev){
  const v = document.getElementById(valueId);
  const kv = v ? v.closest(".kv") : null;
  if (!kv) return;
  kv.dataset.sev = sev || "info";
}

function setValueWithBadge(valueId, sev, text){
  const v = document.getElementById(valueId);
  if (!v) return;
  const sevLabel = (sev || "info").toUpperCase();
  v.innerHTML = `<span class="sev-badge">${sevLabel}</span>${escapeHtml(text || "—")}`;
  setSevByValueId(valueId, sev);
}

function renderReportSummary(res){
  if (!res) return;

  const name = res.file?.name || "—";
  const size = fmtSize(res.file?.sizeBytes);
  setText("rFile", `${name} • ${size}`);

  const fi = res.fmtInfo;
  if (fi?.numChannels) {
    setText("rPcm", `${fi.numChannels}ch • ${fi.sampleRate} Hz • ${fi.bitsPerSample}-bit`);
  } else {
    setText("rPcm", "—");
  }

  const sf = res.soundfield;
  setText("rFormat", sf?.kind || "—");
  setText("rObjects", sf ? (sf.objects ? "Yes" : "No") : "—");

  setText("rAdm", res.axmlFound ? "Found" : "Missing");
  setText("rAxmlWhere", res.axmlWhere || "—");
  if (res.axmlRoot) {
    const r = res.axmlRoot;
    setText("rAxmlRoot", `${r.localName}${r.ns ? ` • ${r.ns}` : ""}`);
  }
  if (res.admStats) {
    const s = res.admStats;
    setText("rAdmStats", `prog:${s.audioProgramme} • cont:${s.audioContent} • obj:${s.audioObject} • pack:${s.audioPackFormat} • uid:${s.audioTrackUID}`);
  }
  // BXML/SXML flags
  if (typeof res.bxmlFound !== "undefined" || typeof res.sxmlFound !== "undefined") {
    const b = res.bxmlFound ? "BXML present" : "BXML none";
    const s = res.sxmlFound ? "SXML present" : "SXML none";
    setText("rBxml", `${b} • ${s}`);
  }
  // ds64 summary
  if (res.ds64) {
    if (res.ds64.found) setText("rDs64", `ds64 found${res.ds64.rescue ? " (rescue)" : ""} • dataSize:${res.ds64.dataSize ?? "?"}`);
    else setText("rDs64", "ds64 not found");
  }
  // chunk scan count
  if (Array.isArray(res.chunkHeaders)) {
    setText("rChunks", `${res.chunkHeaders.length} headers`);
  }

  // Inspections (with severity)
  // Media format inspection
  if (res.mediaFormat) {
    const sev = res.mediaFormat.pass ? "ok" : "fail";
    const txt = res.mediaFormat.summary || (res.mediaFormat.pass ? "PASS" : "FAIL");
    setValueWithBadge("rMediaFormat", sev, txt);
  } else {
    setValueWithBadge("rMediaFormat", "info", "Not run");
  }

  // Audio scan (Quick) results
  const insp = rulesCache?.inspections || {};
  const loudCfg = insp.audioLoudnessInspection || {};
  const clipCfg = insp.clippingInspection || {};
  const hitCfg = insp.digitalHitInspection || {};
  const silCfg = insp.silenceInspection || {};

  if (res.audioScan) {
    const spVal = res.audioScan.samplePeakDbfs;
    const tpVal = res.audioScan.truePeakDbfsEst;

    const spTxt = (spVal === -Infinity) ? "-inf dBFS" : `${spVal.toFixed(2)} dBFS`;
    const tpTxt = (tpVal === -Infinity) ? "-inf dBFS" : `${tpVal.toFixed(2)} dBFS (est)`;

    const spLimit = (typeof loudCfg.maxSamplePeakDBFS === "number") ? loudCfg.maxSamplePeakDBFS : -2;
    const tpLimit = (typeof loudCfg.maxTruePeakDBFS === "number") ? loudCfg.maxTruePeakDBFS : 0;

    const spSev = (spVal !== -Infinity && spVal > spLimit) ? (loudCfg.treatViolationsAsErrors ? "fail" : "warn") : "ok";
    const tpSev = (tpVal !== -Infinity && tpVal > tpLimit) ? (loudCfg.treatViolationsAsErrors ? "fail" : "warn") : "ok";

    const spExtra = (spSev !== "ok") ? ` • > ${spLimit} dBFS` : "";
    const tpExtra = (tpSev !== "ok") ? ` • > ${tpLimit} dBFS` : "";

    setValueWithBadge("rSamplePeak", spSev, spTxt + spExtra);
    setValueWithBadge("rTruePeak", tpSev, tpTxt + tpExtra);

    const clip = res.audioScan.clipping || { clippedSamples: 0 };
    const clipThresh = (typeof clipCfg.statisticalClippingErrorThreshold === "number") ? clipCfg.statisticalClippingErrorThreshold : 4000;
    let clipSev = "ok";
    if (clip.clippedSamples > 0 && clip.clippedSamples < clipThresh) clipSev = "warn";
    if (clip.clippedSamples >= clipThresh) clipSev = "fail";
    const clipTxt = `${clip.clippedSamples} clipped sample(s)` + (clip.clippedSamples >= clipThresh ? ` • >= ${clipThresh}` : "");
    setValueWithBadge("rClipping", clipSev, clipTxt);

    const hits = res.audioScan.digitalHits || { count: 0 };
    const hitsSev = hits.count > 0 ? "warn" : "ok";
    const hitsTxt = `${hits.count} hit(s)` + (hits.count ? ` • check for digital pops` : "");
    setValueWithBadge("rHits", hitsSev, hitsTxt);

    const sil = res.audioScan.silence || {};
    const o = sil.overallPercent == null ? "—" : `${sil.overallPercent.toFixed(1)}%`;
    const note = (sil.notes && sil.notes.length) ? sil.notes[0] : "";
    const silSev = note ? "warn" : "ok";
    const silTxt = note ? `${o} • ${note}` : o;
    setValueWithBadge("rSilence", silSev, silTxt);
  } else {
    setValueWithBadge("rSamplePeak", "info", "Not run");
    setValueWithBadge("rTruePeak", "info", "Not run");
    setValueWithBadge("rClipping", "info", "Not run");
    setValueWithBadge("rHits", "info", "Not run");
    setValueWithBadge("rSilence", "info", "Not run");
  }

  const candidates = (res.labelChecks || []).length;
  const pass = res.totals?.pass ?? 0;
  const reject = res.totals?.reject ?? 0;
  if (!candidates) setText("rLabels", "No label candidates found");
  else setText("rLabels", `${candidates} candidates • ${reject} reject`);

  const warnEl = document.getElementById("rWarning");
  const errEl = document.getElementById("rError");
  if (warnEl) {
    if (res.warning) { warnEl.hidden = false; warnEl.textContent = `Warning: ${res.warning}`; }
    else warnEl.hidden = true;
  }
  if (errEl) {
    if (res.error) { errEl.hidden = false; errEl.textContent = `Error: ${res.error}`; }
    else errEl.hidden = true;
  }
  renderSimpleSummary(res);
}


function sevRank(sev){
  const s = String(sev||"").toLowerCase();
  if (s === "fail" || s === "error" || s === "reject") return 3;
  if (s === "warn" || s === "warning") return 2;
  if (s === "ok" || s === "pass") return 1;
  return 0;
}
function sevLabel(sev){
  const s = String(sev||"").toLowerCase();
  if (s === "fail" || s === "error" || s === "reject") return "FAIL";
  if (s === "warn" || s === "warning") return "WARN";
  if (s === "ok" || s === "pass") return "OK";
  return "INFO";
}
function sevClass2(sev){
  const s = String(sev||"").toLowerCase();
  if (s === "fail" || s === "error" || s === "reject") return "sev-fail";
  if (s === "warn" || s === "warning") return "sev-warn";
  if (s === "ok" || s === "pass") return "sev-ok";
  return "sev-info";
}

function renderSimpleSummary(res){
  const overallEl = document.getElementById("sumOverall");
  const countsEl = document.getElementById("sumCounts");
  const listEl = document.getElementById("sumList");
  if (!overallEl || !countsEl || !listEl) return;

  const issues = [];
  const add = (sev, title, detail, fix) => issues.push({ sev, title, detail, fix });

  // 1) Media format
  if (res?.mediaFormat && !res.mediaFormat.pass) {
    const cfg = rulesCache?.inspections?.mediaFormatInspection || {};
    const allowed = Array.isArray(cfg.allowedChannelCount) ? cfg.allowedChannelCount.join(", ") : "";
    add("fail",
      "Wrong file format",
      res.mediaFormat.summary || "Format check failed",
      allowed ? `Fix: Deliver the correct file. Expected channels: ${allowed}.` : "Fix: Deliver the correct file (codec / sample rate / channels).");
  }

  // 2) Audio scan items
  if (res?.audioScan) {
    const insp = rulesCache?.inspections || {};
    const loudCfg = insp.audioLoudnessInspection || {};
    const clipCfg = insp.clippingInspection || {};

    const sp = res.audioScan.samplePeakDbfs;
    const spLimit = (typeof loudCfg.maxSamplePeakDBFS === "number") ? loudCfg.maxSamplePeakDBFS : -2;
    if (sp !== -Infinity && sp > spLimit) {
      add(loudCfg.treatViolationsAsErrors ? "fail" : "warn",
        "Too loud (peak)",
        `Peak ${sp.toFixed(2)} dBFS (limit ${spLimit} dBFS)`,
        "Fix: Turn down master / limiter and re-render.");
    }

    const clip = res.audioScan.clipping || { clippedSamples: 0 };
    const clipThresh = (typeof clipCfg.statisticalClippingErrorThreshold === "number") ? clipCfg.statisticalClippingErrorThreshold : 4000;
    if (clip.clippedSamples > 0) {
      add(clip.clippedSamples >= clipThresh ? "fail" : "warn",
        "Clipping",
        `${clip.clippedSamples} clipped samples found`,
        "Fix: Reduce level or repair clipping, then re-render.");
    }

    const hits = res.audioScan.digitalHits || { count: 0 };
    if (hits.count > 0) {
      add("warn",
        "Digital pops / clicks",
        `${hits.count} possible pop(s)`,
        "Fix: Listen and repair pops/clicks (de-click / re-render).");
    }

    const sil = res.audioScan.silence || {};
    const note = (sil.notes && sil.notes.length) ? sil.notes[0] : "";
    if (note) {
      add("warn",
        "Channel is too silent",
        note,
        "Fix: Check routing / missing stems (center, surrounds).");
    }
  } else {
    add("info",
      "Audio scan not run",
      "Click “Run audio scan (Quick)” to check peaks / clipping / pops / silence",
      "");
  }

  // 3) Label rejects
  const rejects = Array.isArray(res?.labelChecks) ? res.labelChecks.filter(r=>r.status==="REJECT").length : 0;
  if (rejects > 0) {
    add("fail",
      "Labeling errors",
      `${rejects} label(s) are REJECT`,
      "Fix: Rename labels to the approved list (see Labels table).");
  }

  // Overall + counts
  const hasFail = issues.some(i=>sevRank(i.sev)===3);
  const hasWarn = issues.some(i=>sevRank(i.sev)===2);

  const overall = hasFail ? "FAIL" : (hasWarn ? "WARN" : "OK");
  overallEl.textContent = overall;
  overallEl.className = `badge ${sevClass2(overall.toLowerCase())}`;

  const failCount = issues.filter(i=>sevRank(i.sev)===3).length;
  const warnCount = issues.filter(i=>sevRank(i.sev)===2).length;
  countsEl.textContent = `${failCount} FAIL • ${warnCount} WARN`;
  countsEl.className = `badge ${hasFail ? "sev-fail" : (hasWarn ? "sev-warn" : "sev-ok")}`;

  // Render list (FAIL -> WARN -> INFO)
  const sorted = issues.slice().sort((a,b)=>sevRank(b.sev)-sevRank(a.sev));
  const toggle = document.getElementById("sumToggle");
  const limit = 3;
  const hasMore = sorted.length > limit;
  if (toggle) {
    toggle.hidden = !hasMore;
    toggle.textContent = simpleExpanded ? "Show less" : `Show all (${sorted.length})`;
    toggle.onclick = () => { simpleExpanded = !simpleExpanded; renderSimpleSummary(res); };
  }
  const view = (!simpleExpanded && hasMore) ? sorted.slice(0, limit) : sorted;

  const items = view.map((it, idx) => {
    const cls = sevClass2(it.sev);
    const fix = it.fix ? `<div class="simple-fix">${escapeHtml(it.fix)}</div>` : "";
    return `
      <div class="simple-item ${cls}">
        <div class="simple-left">
          <div class="simple-idx">${idx+1}</div>
          <span class="badge ${cls}">${sevLabel(it.sev)}</span>
        </div>
        <div class="simple-body">
          <div class="simple-h">${escapeHtml(it.title)}</div>
          <div class="simple-d">${escapeHtml(it.detail)}</div>
          ${fix}
        </div>
      </div>
    `;
  }).join("");

  const moreNote = (!simpleExpanded && hasMore) ? `<div class="simple-empty">Showing top ${limit}. Click “Show all” for the full list.</div>` : "";
  listEl.innerHTML = (items ? (items + moreNote) : `<div class="simple-empty">All checks look OK.</div>`);
}


async function readSlice(file, start, length) {
  const buf = await file.slice(start, start + length).arrayBuffer();
  return new DataView(buf);
}

function fourCC(dv, o) {
  return String.fromCharCode(dv.getUint8(o), dv.getUint8(o+1), dv.getUint8(o+2), dv.getUint8(o+3));
}

// Simple AXML extraction (best-effort): scan the first 64KB; if not found, scan in 1MB windows for a raw 'axml' marker.
async function extractAxml(file, onProgress) {
  const read = async (offset, length) => {
    const buf = await file.slice(offset, offset + length).arrayBuffer();
    if (buf.byteLength < length) return null;
    return new DataView(buf);
  };
  const fourCC = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o+1), dv.getUint8(o+2), dv.getUint8(o+3));
  const u64le = (dv, o) => {
    try { if (typeof dv.getBigUint64 === "function") return Number(dv.getBigUint64(o, true)); } catch {}
    const lo = dv.getUint32(o, true);
    const hi = dv.getUint32(o + 4, true);
    return hi * 4294967296 + lo;
  };

  const update = (off, msg) => {
    if (typeof onProgress === "function") {
      const pct = (off / (file.size || 1)) * 100;
      onProgress(pct, msg || `${pct.toFixed(0)}%`);
    }
  };

  const header = await read(0, 12);
  if (!header) throw new Error("Unexpected EOF reading header.");
  const riff = fourCC(header, 0);
  const wave = fourCC(header, 8);
  if (!["RIFF","RF64","BW64"].includes(riff) || wave !== "WAVE") throw new Error(`Not WAVE/BWAV: ${riff}/${wave}`);

  let ds64 = { riffSize: null, dataSize: null, table: new Map(), found: false, foundAt: null, rescue: false };

  const parseDs64At = async (chunkOff) => {
    const hdr = await read(chunkOff, 8);
    if (!hdr) return false;
    const id = fourCC(hdr, 0);
    if (id !== "ds64") return false;
    const size32 = hdr.getUint32(4, true);
    const dataOff = chunkOff + 8;
    const want = Math.min(size32, 8 + 8 + 8 + 4 + 16384);
    const dv = await read(dataOff, want);
    if (!dv) return false;
    ds64.riffSize = u64le(dv, 0);
    ds64.dataSize = u64le(dv, 8);
    const tableLen = dv.getUint32(24, true);
    let o = 28;
    for (let i = 0; i < tableLen; i++) {
      if (o + 12 > dv.byteLength) break;
      const cid = fourCC(dv, o);
      const csz = u64le(dv, o + 4);
      ds64.table.set(cid, csz);
      o += 12;
    }
    ds64.found = true;
    ds64.foundAt = chunkOff;
    return true;
  };

  const rescueFindDs64 = async () => {
    const limit = Math.min(file.size, 8 * 1024 * 1024);
    const buf = await file.slice(0, limit).arrayBuffer();
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < u8.length - 8; i++) {
      if (u8[i] === 0x64 && u8[i+1] === 0x73 && u8[i+2] === 0x36 && u8[i+3] === 0x34) {
        const size32 = new DataView(buf, i + 4, 4).getUint32(0, true);
        if (size32 > 0 && size32 < 1024 * 1024) {
          const ok = await parseDs64At(i);
          if (ok) { ds64.rescue = true; return true; }
        }
      }
    }
    return false;
  };

  let offset = 12;
  let fmtInfo = null;
  let axmlText = null;
  let chnaFound = false;
  let bxmlFound = false;
  let sxmlFound = false;
  let where = null;
  let dataChunk = null;

  const chunks = [];
  const maxChunks = 800;

  while (offset + 8 <= file.size) {
    update(offset, "Scanning…");
    const dv = await read(offset, 8);
    if (!dv) break;

    const idRaw = fourCC(dv, 0);
    const id = idRaw.toLowerCase();
    const size32 = dv.getUint32(4, true);
    const dataOff = offset + 8;

    if (chunks.length < maxChunks) chunks.push({ id: idRaw, size32, offset });

    if (id === "ds64") {
      await parseDs64At(offset);
    }

    let chunkSize = size32;

    if ((riff === "RF64" || riff === "BW64") && size32 === 0xFFFFFFFF) {
      if (!ds64.found) {
        await rescueFindDs64();
      }
      if (id === "data" && Number.isFinite(ds64.dataSize)) {
        chunkSize = ds64.dataSize;
      } else {
        chunkSize = ds64.table.get(idRaw) ?? ds64.table.get(idRaw.toUpperCase()) ?? null;
        if (chunkSize == null) {
          break; // cannot safely skip; fallback to raw scan
        }
      }
    }

    // capture audio data chunk location
    if (id === "data" && !dataChunk) {
      dataChunk = { offset: dataOff, size: Number(chunkSize) };
    }

    if (id === "fmt " && chunkSize >= 16) {
      const fmtDv = await read(dataOff, 16);
      if (fmtDv) {
        fmtInfo = {
          audioFormat: fmtDv.getUint16(0, true),
          numChannels: fmtDv.getUint16(2, true),
          sampleRate: fmtDv.getUint32(4, true),
          bitsPerSample: fmtDv.getUint16(14, true),
        };
      }
    }

    if (id === "chna") chnaFound = true;
    if (id === "bxml") bxmlFound = true;
    if (id === "sxml") sxmlFound = true;

    if (id === "axml") {
      const max = Number(chunkSize);
      const parts = [];
      const step = 4 * 1024 * 1024;
      for (let p = 0; p < max; p += step) {
        update(offset + p, "Reading AXML…");
        const buf = await file.slice(dataOff + p, dataOff + Math.min(max, p + step)).arrayBuffer();
        parts.push(new Uint8Array(buf));
      }
      const total = parts.reduce((s,a)=>s+a.length,0);
      const all = new Uint8Array(total);
      let w = 0;
      for (const a of parts) { all.set(a, w); w += a.length; }
      axmlText = new TextDecoder("utf-8").decode(all);
      where = `chunk@${offset}`;
      update(offset, "AXML found");
      if (chnaFound) break;
    }

    offset = dataOff + Number(chunkSize) + (Number(chunkSize) % 2);
    if (!Number.isFinite(offset) || offset <= dataOff) break;
  }

  if (!axmlText) {
    const step = 8 * 1024 * 1024;
    for (let pos = 0; pos < file.size; pos += step) {
      update(pos, "Searching AXML…");
      const buf = await file.slice(pos, Math.min(file.size, pos + step)).arrayBuffer();
      const u8 = new Uint8Array(buf);
      for (let i = 0; i < u8.length - 8; i++) {
        if (u8[i] === 0x61 && u8[i+1] === 0x78 && u8[i+2] === 0x6d && u8[i+3] === 0x6c) {
          const size32 = new DataView(buf, i + 4, 4).getUint32(0, true);
          if (size32 > 0 && size32 < 256 * 1024 * 1024) {
            const dataOff = pos + i + 8;
            update(dataOff, "Reading AXML…");
            const axBuf = await file.slice(dataOff, dataOff + size32).arrayBuffer();
            axmlText = new TextDecoder("utf-8").decode(new Uint8Array(axBuf));
            where = `scan@${pos + i}`;
            break;
          }
        }
      }
      if (axmlText) break;
    }
  }

  update(file.size, "Done");
  return { riff, wave, axmlText, found: where, fmtInfo, chnaFound, bxmlFound, sxmlFound, chunks, ds64, dataChunk };
}


function textOfFirst(node) { return (node && (node.textContent || "")).trim(); }

function detectSoundfield(xmlDoc, fmtInfo) {
  // Clarified detection:
  // - "Atmos" ONLY when we have real object evidence:
  //   * audioBlockFormatObjects present OR audioPackFormat typeDefinition="Objects"
  // - Otherwise we show channel/bed layout (e.g., 5.1, 7.1, 7.1.4 bed)
  // - We also keep an "atmosHint" if names include "Atmos" (profile/template), but it won't force Atmos.
  const packs = [];
  try { packs.push(...Array.from(xmlDoc.getElementsByTagNameNS("*", "audioPackFormat"))); } catch {}
  try { packs.push(...Array.from(xmlDoc.getElementsByTagName("audioPackFormat"))); } catch {}

  const seen = new Set();
  const uniq = [];
  for (const p of packs) { if (p && !seen.has(p)) { seen.add(p); uniq.push(p); } }

  const countTag = (ln) => {
    try { return xmlDoc.getElementsByTagNameNS("*", ln).length; } catch {}
    try { return xmlDoc.getElementsByTagName(ln).length; } catch {}
    return 0;
  };

  const objBlocks = countTag("audioBlockFormatObjects");
  const hasObjBlocks = objBlocks > 0;

  let objectsPacks = 0;
  let atmosHint = false;

  let maxDirectCh = 0;
  let maxAnyCh = 0;

  for (const p of uniq) {
    const typeDef = (p.getAttribute("typeDefinition") || "").toLowerCase();
    const packName = (p.getAttribute("audioPackFormatName") || "").toLowerCase();

    if (typeDef.includes("objects")) objectsPacks += 1;
    if (packName.includes("atmos")) atmosHint = true;

    const refs = [];
    try { refs.push(...Array.from(p.getElementsByTagNameNS("*", "audioChannelFormatIDRef"))); } catch {}
    try { refs.push(...Array.from(p.getElementsByTagName("audioChannelFormatIDRef"))); } catch {}
    const chCount = refs.length;

    if (chCount > maxAnyCh) maxAnyCh = chCount;
    if (typeDef.includes("directspeakers") && chCount > maxDirectCh) maxDirectCh = chCount;
  }

  const pcmCh = fmtInfo?.numChannels || 0;

  const bedLabel = (ch) => {
    if (!ch) return null;
    if (ch === 2) return "Stereo";
    if (ch === 6) return "5.1";
    if (ch === 8) return "7.1";
    if (ch === 10) return "7.1.2";
    if (ch === 12) return "7.1.4";
    return `${ch}ch`;
  };

  const bedCh = maxDirectCh || (pcmCh && pcmCh <= 12 ? pcmCh : 0) || maxAnyCh || 0;
  const bed = bedLabel(bedCh);

  const objects = hasObjBlocks || objectsPacks > 0;

  if (objects) {
    let detail = "";
    if (hasObjBlocks) detail = `Objects present (audioBlockFormatObjects=${objBlocks})`;
    else detail = `Objects present (typeDefinition Objects packs=${objectsPacks})`;
    if (bed) detail += ` • bed ${bed}`;
    if (pcmCh) detail += ` • ${pcmCh}ch PCM`;
    return { kind: "Atmos", detail, bedLabel: bed, bedChannels: bedCh || null, objects: true, atmosHint };
  }

  let kind = bed || (pcmCh ? `${pcmCh}ch` : "Unknown");
  let detail = "Channel-based (no objects detected)";
  if (bed) detail += ` • bed ${bed}`;
  if (pcmCh) detail += ` • ${pcmCh}ch PCM`;
  if (atmosHint) detail += " • Atmos-named packs (template/profile)";
  return { kind, detail, bedLabel: bed, bedChannels: bedCh || null, objects: false, atmosHint };
}
function buildSynonymSets(labels) {
  const toArr = (arr) => (arr || []).map(normalizeLabel);
  const toSet = (arr) => new Set(toArr(arr));

  // Support both:
  // 1) legacy {Dialogue:[], Music:[], Effects:[], Narration:[]}
  // 2) atmosLabelConfiguration { validAudioContentGroups:[{groupName, labels, validContentLabelSubGroups:[{subGroupName, labels}]}], ... }
  let buckets = { Dialogue: [], Music: [], Effects: [], Narration: [] };
  let subgroupBuckets = { Dialogue: {}, Music: {}, Effects: {}, Narration: {} };

  const mapGroup = (g) => {
    const k = String(g || "").toLowerCase();
    if (k === "dialogue") return "Dialogue";
    if (k === "music") return "Music";
    if (k === "effects") return "Effects";
    if (k === "narration") return "Narration";
    return k ? (k[0].toUpperCase() + k.slice(1)) : "Other";
  };

  if (labels && Array.isArray(labels.validAudioContentGroups)) {
    for (const g of labels.validAudioContentGroups) {
      const key = mapGroup(g.groupName);
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(...(g.labels || []));

      // subgroups
      for (const sg of (g.validContentLabelSubGroups || [])) {
        const sgName = String(sg.subGroupName || "").trim() || "subgroup";
        if (!subgroupBuckets[key]) subgroupBuckets[key] = {};
        if (!subgroupBuckets[key][sgName]) subgroupBuckets[key][sgName] = [];
        subgroupBuckets[key][sgName].push(...(sg.labels || []));
        // also consider subgroup labels valid for the parent group
        buckets[key].push(...(sg.labels || []));
      }
    }
  } else {
    buckets = {
      Dialogue: labels.Dialogue || [],
      Music: labels.Music || [],
      Effects: labels.Effects || [],
      Narration: labels.Narration || [],
    };
  }

  const sets = {
    Dialogue: toSet(buckets.Dialogue),
    Music: toSet(buckets.Music),
    Effects: toSet(buckets.Effects),
    Narration: toSet(buckets.Narration),
  };

  // arrays (for suggestions)
  sets.__normLists = {
    Dialogue: toArr(buckets.Dialogue),
    Music: toArr(buckets.Music),
    Effects: toArr(buckets.Effects),
    Narration: toArr(buckets.Narration),
  };

  // subgroup sets + quick lookup
  sets.__subgroups = {};
  sets.__subgroupLookup = new Map(); // normLabel -> {group, subgroup}
  for (const group of Object.keys(subgroupBuckets || {})) {
    const gObj = subgroupBuckets[group] || {};
    sets.__subgroups[group] = {};
    for (const [sgName, arr] of Object.entries(gObj)) {
      const normArr = toArr(arr);
      sets.__subgroups[group][sgName] = new Set(normArr);
      for (const n of normArr) {
        // first hit wins
        if (!sets.__subgroupLookup.has(n)) sets.__subgroupLookup.set(n, { group, subgroup: sgName });
      }
    }
  }

  // expose enforcement flags when provided
  sets.__enforce = {
    labelValidityEnforced: !!labels?.labelValidityEnforced,
    labelExistenceEnforced: !!labels?.labelExistenceEnforced,
  };

  return sets;
}
function mapLabel(norm, sets) {
  // Return {group, subgroup?} when we can.
  // 1) subgroup hit (if configured)
  try {
    const hit = sets?.__subgroupLookup?.get(norm);
    if (hit) return hit;
  } catch {}

  // 2) group-level hit
  for (const k of ["Dialogue","Music","Effects","Narration"]) {
    if (sets[k]?.has(norm)) return { group: k, subgroup: "" };
  }
  return null;
}

function extractCandidates(xmlDoc) {
  // Extract label candidates from BOTH attributes and sub-elements.
  // In BS.2076 ADM, names like audioObjectName/audioContentName are commonly ATTRIBUTES:
  // https://mediaarea.net/Specs/ITU-R_BS.2076/audioObject
  const out = [];

  const uniqPush = (rawLabel, source) => {
    const t = (rawLabel || "").trim();
    if (!t) return;
    out.push({ rawLabel: t, source });
  };

  const byLocalName = (localName) => {
    const nodes = [];
    try { nodes.push(...Array.from(xmlDoc.getElementsByTagNameNS("*", localName))); } catch {}
    try { nodes.push(...Array.from(xmlDoc.getElementsByTagName(localName))); } catch {}
    const seen = new Set();
    const uniq = [];
    for (const n of nodes) { if (n && !seen.has(n)) { seen.add(n); uniq.push(n); } }
    return uniq;
  };

  const pullAttr = (elemLocalName, attrName, source) => {
    for (const n of byLocalName(elemLocalName)) {
      try {
        const v = n.getAttribute(attrName);
        if (v) uniqPush(v, source);
      } catch {}
    }
  };

  const pullText = (nameLocalName, source) => {
    for (const n of byLocalName(nameLocalName)) uniqPush(n.textContent, source);
  };

  // Attribute-based names (common)
  pullAttr("audioProgramme", "audioProgrammeName", "audioProgramme@audioProgrammeName");
  pullAttr("audioContent", "audioContentName", "audioContent@audioContentName");
  pullAttr("audioObject", "audioObjectName", "audioObject@audioObjectName");
  pullAttr("audioPackFormat", "audioPackFormatName", "audioPackFormat@audioPackFormatName");
  pullAttr("audioTrackUID", "audioTrackUIDName", "audioTrackUID@audioTrackUIDName");
  pullAttr("audioTrackFormat", "audioTrackFormatName", "audioTrackFormat@audioTrackFormatName");

  // Element-based names (some tools export these)
  pullText("audioProgrammeName", "audioProgrammeName");
  pullText("audioContentName", "audioContentName");
  pullText("audioObjectName", "audioObjectName");
  pullText("audioPackFormatName", "audioPackFormatName");
  pullText("audioTrackUIDName", "audioTrackUIDName");
  pullText("audioTrackFormatName", "audioTrackFormatName");

  const seen = new Set();
  const dedup = [];
  for (const r of out) {
    const k = `${r.source}::${r.rawLabel}`;
    if (!seen.has(k)) { seen.add(k); dedup.push(r); }
  }
  return dedup;
}

async function validate(file) {
  rulesCache = rulesCache || await loadRules();
  const sets = buildSynonymSets(rulesCache.labels);
  const normLists = sets.__normLists || {};

  const extracted = await extractAxml(file, (pct, label) => setProgress(pct, label));

  const fmtInfo = extracted.fmtInfo || null;
  const mediaFormatRes = evalMediaFormat(fmtInfo, rulesCache.inspections?.mediaFormat);

  const res = {
    app: "BWAV Inspector",
    version: "0.1.0",
    mode: currentMode,
    file: { name: file.name, sizeBytes: file.size },
    riff: extracted.riff,
    wave: extracted.wave,
    fmtInfo,
    dataChunk: extracted.dataChunk,
    mediaFormat: mediaFormatRes,
    audioScan: null,
    chnaFound: extracted.chnaFound,
    bxmlFound: extracted.bxmlFound,
    sxmlFound: extracted.sxmlFound,
    chunkHeaders: extracted.chunks,
    ds64: extracted.ds64,
    axmlFound: !!extracted.axmlText,
    axmlWhere: extracted.found,
    labelChecks: [],
    totals: { pass: 0, reject: 0 }
  };

  if (!extracted.axmlText) {
    if (extracted.bxmlFound) {
      res.error = "AXML chunk not found, but BXML (compressed XML) is present. This file may use BW64 BXML instead of AXML. Decoding BXML is not implemented yet.";
    } else {
      res.error = "AXML (ADM XML) chunk not found. This file may not be an ADM BWF/BW64, or it may be malformed. Use a chunk inspector (e.g., BWF MetaEdit) to confirm whether axml/chna exist.";
    }
    res.totals.reject = 1;
    return res;
  }

  const doc = new DOMParser().parseFromString(extracted.axmlText, "application/xml");
  if (doc.querySelector("parsererror")) {
    res.error = "Invalid XML in AXML chunk.";
    res.totals.reject = 1;
    return res;
  }

  // AXML root + quick ADM stats (helps explain why some report fields may be empty)
  res.axmlRoot = {
    localName: doc.documentElement?.localName || doc.documentElement?.nodeName || "",
    ns: doc.documentElement?.namespaceURI || ""
  };

  const countTag = (ln) => {
    try { return doc.getElementsByTagNameNS("*", ln).length; } catch {}
    try { return doc.getElementsByTagName(ln).length; } catch {}
    return 0;
  };

  res.admStats = {
    audioProgramme: countTag("audioProgramme"),
    audioContent: countTag("audioContent"),
    audioObject: countTag("audioObject"),
    audioPackFormat: countTag("audioPackFormat"),
    audioTrackUID: countTag("audioTrackUID"),
    audioTrackFormat: countTag("audioTrackFormat"),
  };

  const soundfield = detectSoundfield(doc, fmtInfo);
  res.soundfield = soundfield;

  const candidates = extractCandidates(doc);
  if (!candidates.length) {
    res.warning = "No label candidates were found in AXML (checked both attribute-based and element-based name fields). Validation is inconclusive.";
  }
  for (const c of candidates) {
    const norm = normalizeLabel(c.rawLabel);
    const mapped = mapLabel(norm, sets);
    let status = mapped ? "PASS" : "REJECT";
    let fix = "";
    if (status === "REJECT") {
      const cat = sourceCategory(c.source);
      // Non-group sources become WARN (informational) by default
      if (cat === "programme" || cat === "pack" || cat === "trackformat" || cat === "trackuid") {
        status = "WARN";
      }
      fix = fixForReject(c.rawLabel, c.source, sets.__normLists || {});
    }
    res.labelChecks.push({ status, rawLabel: c.rawLabel, normalized: norm, mapped: mapped ? (mapped.group || "") : "", subgroup: mapped ? (mapped.subgroup || "") : "", source: c.source, fix });
    if (status === "PASS") res.totals.pass += 1;
    else if (status === "REJECT") res.totals.reject += 1;
  }

  return res;
}

// UI events
const modeSel = document.getElementById("modeSelect");
if (modeSel) {
  modeSel.value = currentMode;
  modeSel.addEventListener("change", () => switchMode(modeSel.value));
}
/* no tabs in single-page layout */
$("#btnSettings").addEventListener("click", () => {
  try {
    if (globalThis.chrome?.runtime?.openOptionsPage) return chrome.runtime.openOptionsPage();
  } catch (_) {}
  try {
    window.open(assetUrl("options.html"), "_blank");
  } catch (_) {}
});

const dropzone = $("#dropzone");
dropzone.addEventListener("click", () => $("#fileInput").click());
dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") $("#fileInput").click(); });
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.style.borderColor = "rgba(229,9,20,0.65)"; });
dropzone.addEventListener("dragleave", () => { dropzone.style.borderColor = "rgba(255,255,255,0.18)"; });
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.style.borderColor = "rgba(255,255,255,0.18)";
  const file = e.dataTransfer.files?.[0];
  if (file) handleFile(file);
});

$("#fileInput").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) handleFile(file);
});

async function handleFile(file) {
  $("#fileMeta").hidden = false;
  $("#fileMeta").textContent = `${file.name} • ${(file.size/1024/1024).toFixed(1)} MB`;
  // fmt info will be appended after validation
  lastFile = file;
  lastResult = null;
  try { const st = document.getElementById("scanStatus"); if (st) st.textContent = "Not run"; } catch {}

  try {
    setProgress(0, "0%");
    setStatus("Validating…");
    const res = await validate(file);
    if (res.fmtInfo?.numChannels) {
      const fi = res.fmtInfo;
      $("#fileMeta").textContent = `${file.name} • ${(file.size/1024/1024).toFixed(1)} MB • ${fi.numChannels}ch • ${fi.sampleRate}Hz • ${fi.bitsPerSample}-bit`;
    }

    $("#mAdm").textContent = res.axmlFound ? "Found" : "Missing";
    setPill($("#pAdm"), res.axmlFound ? "OK" : "Missing", res.axmlFound ? "good" : "bad");

        $("#mChna").textContent = res.chnaFound ? "Found" : "Missing";
    setPill($("#pChna"), res.chnaFound ? "OK" : "Missing", res.chnaFound ? "good" : "warn");

    const rejects = res.labelChecks.filter(x => x.status === "REJECT").length;
    const warns = res.labelChecks.filter(x => x.status === "WARN").length;
    const candidatesCount = res.labelChecks.length;
    if (!candidatesCount) {
      $("#mLabels").textContent = "—";
      setPill($("#pLabels"), "No labels found", "warn");
    } else {
      $("#mLabels").textContent = `${rejects} Reject${warns ? ` • ${warns} Warn` : ""}`;
      setPill($("#pLabels"), rejects ? "Check" : "OK", rejects ? "bad" : "good");
    }

    // Format (Atmos / 5.1 / etc) — show bed/object clarity
    if (res.soundfield?.kind) {
      $("#mFormat").textContent = res.soundfield.kind;
      const bed = res.soundfield.bedLabel;
      const tone = res.soundfield.objects ? "good" : (
        res.soundfield.kind === "5.1" || res.soundfield.kind === "Stereo" || res.soundfield.kind === "7.1" || String(res.soundfield.kind).includes("7.1")
          ? "good" : "warn"
      );

      let pill = res.soundfield.objects ? "Objects" : "Bed-only";
      if (bed) pill += ` • Bed ${bed}`;
      if (!res.soundfield.objects && res.soundfield.atmosHint) pill += " • Atmos name";
      setPill($("#pFormat"), pill, tone);
    } else if (res.fmtInfo?.numChannels) {
      const ch = res.fmtInfo.numChannels;
      $("#mFormat").textContent = `${ch}ch`;
      setPill($("#pFormat"), "PCM", ch <= 12 ? "good" : "warn");
    } else {
      $("#mFormat").textContent = "—";
      setPill($("#pFormat"), "Unknown", "warn");
    }


    _allLabelRows = res.labelChecks || [];
    applyLabelFilters();
    (() => { const _st = document.getElementById("structureText"); if (_st) _st.textContent = res.error
      ? `Error:
${res.error}`
      : `${res.warning ? `Warning:
${res.warning}

` : ""}AXML: ${res.axmlWhere}
Candidates: ${res.labelChecks.length}
Pass: ${res.totals.pass}
Reject: ${res.totals.reject}`; })();
    report = res;
    lastResult = res;
    $("#reportJson").textContent = JSON.stringify(report, null, 2);
    try { renderReportSummary(report); } catch {}
    setStatus(res.error ? "Completed with warnings." : "Done.");
    
  } catch (e) {
    try { setProgress(null); } catch {}
    setStatus("Failed.");
    (() => { const _st = document.getElementById("structureText"); if (_st) _st.textContent = String(e?.message || e); })();
    setPill($("#pAdm"), "Error", "bad");
  }
}

$("#btnClear").addEventListener("click", resetUI);
$("#btnCopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#reportJson").textContent); setStatus("Copied JSON."); }
  catch { setStatus("Copy failed."); }
});
$("#btnExport").addEventListener("click", () => {
  const blob = new Blob([$("#reportJson").textContent], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "bwav-inspector-report.json"; a.click();
  URL.revokeObjectURL(url);
  setStatus("Exported JSON.");
});


// Audio scan button
const scanBtn = document.getElementById("btnScanAudio");
if (scanBtn) {
  scanBtn.addEventListener("click", async () => {
    if (!lastFile || !lastResult) {
      const st = document.getElementById("scanStatus");
      if (st) st.textContent = "Load a file first";
      return;
    }
    try {
      const st = document.getElementById("scanStatus");
      if (st) st.textContent = "Scanning…";
      const scan = await runAudioScanQuick(lastFile, lastResult, rulesCache.inspections, (msg)=>{ if (st) st.textContent = msg; });
      if (scan.error) {
        if (st) st.textContent = `Scan failed: ${scan.error}`;
        return;
      }
      lastResult.audioScan = scan;
      report = lastResult;
      renderReportSummary(lastResult);
      // update JSON view
      const pre = document.getElementById("reportJson");
      if (pre) pre.textContent = JSON.stringify(lastResult, null, 2);
      if (st) st.textContent = `Scan OK • ${scan.scannedSeconds.toFixed(1)}s scanned`;
    } catch (e) {
      const st = document.getElementById("scanStatus");
      if (st) st.textContent = `Scan error: ${e?.message || e}`;
    }
  });
}

// Filters
["filterText","filterStatus","filterGroup"].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener(id === "filterText" ? "input" : "change", applyLabelFilters);
});
function exportPdf() {
  try {
    const rows = (lastFilteredRows && Array.isArray(lastFilteredRows)) ? lastFilteredRows
      : (Array.isArray(_allLabelRows) ? _allLabelRows : (report?.labelChecks || []));
    const payload = {
      report: report || {},
      rows

    };

    const openPdf = () => {
      const url = assetUrl("pdf.html");
      try {
        if (globalThis.chrome?.tabs?.create) return chrome.tabs.create({ url });
      } catch (_) {}
      try { window.open(url, "_blank"); } catch (_) {}
    };

    try {
      if (globalThis.chrome?.storage?.local?.set) {
        chrome.storage.local.set({ bwavInspector_pdfPayload: payload }, openPdf);
      } else {
        localStorage.setItem("bwavInspector_pdfPayload", JSON.stringify(payload));
        openPdf();
      }
    } catch (_) {
      // last resort fallback
      localStorage.setItem("bwavInspector_pdfPayload", JSON.stringify(payload));
      openPdf();
    }
  } catch (e) {
    console.error("Export PDF failed", e);
    alert("Export PDF failed. See console for details.");
  }
}


resetUI();

