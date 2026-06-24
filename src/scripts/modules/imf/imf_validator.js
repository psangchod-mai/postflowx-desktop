// scripts/modules/imf/imf_validator.js
// IMF package validation — runs in the browser against File handles.
'use strict';

export const SEV = { PASS: 'pass', WARN: 'warn', FAIL: 'fail', INFO: 'info' };

function result(sev, code, msg, detail = '') {
  return { sev, code, msg, detail };
}

// ── Structure validation (no file reading, just cross-reference) ──────────────

function unique(arr) { return [...new Set(arr.filter(Boolean))]; }
function normKey(v) { return String(v || '').trim().toLowerCase(); }

export function validateStructure(assetMap, pkl, cpl, fileMap) {
  const results = [];
  const pklAssets = Object.entries(pkl.assets || {});
  const nonXmlAssets = pklAssets.filter(([, a]) => (a.type || '').toLowerCase() !== 'text/xml');
  const videoResources = cpl.videoResources || [];
  const audioResources = cpl.audioResources || [];
  const videoSequences = cpl.videoSequences || [];
  const audioSequences = cpl.audioSequences || [];
  const descById = new Map((cpl.descriptors || []).map(d => [d.id, d]));

  // ── ASSETMAP ─────────────────────────────────────────────────────────────
  const pklAsset = Object.values(assetMap.assets || {}).find(a => a.isPKL);
  if (!pklAsset) {
    results.push(result(SEV.FAIL, 'AM001', 'No PackingList entry in ASSETMAP'));
  } else {
    results.push(result(SEV.PASS, 'AM001', 'ASSETMAP references a PackingList'));
  }

  if (pklAsset && pkl.id !== pklAsset.id) {
    results.push(result(SEV.WARN, 'AM002',
      'PKL ID mismatch between ASSETMAP and PKL file',
      `ASSETMAP: ${pklAsset.id} | PKL: ${pkl.id}`));
  } else if (pklAsset) {
    results.push(result(SEV.PASS, 'AM002', 'PKL ID consistent'));
  }

  const assetMapPaths = Object.values(assetMap.assets || {}).map(a => ({ id: a.id, path: a.path || '' }));
  const emptyPaths = assetMapPaths.filter(a => !a.path);
  if (emptyPaths.length) {
    results.push(result(SEV.WARN, 'AM003',
      `${emptyPaths.length} ASSETMAP entr${emptyPaths.length === 1 ? 'y has' : 'ies have'} no path`,
      emptyPaths.slice(0, 3).map(a => a.id).join(', ')));
  } else if (assetMapPaths.length) {
    results.push(result(SEV.PASS, 'AM003', 'All ASSETMAP entries declare a path'));
  }

  const dupePaths = [];
  const seenPaths = new Map();
  for (const a of assetMapPaths) {
    const key = normKey(a.path);
    if (!key) continue;
    if (seenPaths.has(key)) dupePaths.push(a.path);
    else seenPaths.set(key, a.id);
  }
  if (dupePaths.length) {
    results.push(result(SEV.WARN, 'AM004',
      `${dupePaths.length} duplicate ASSETMAP path entr${dupePaths.length === 1 ? 'y' : 'ies'}`,
      unique(dupePaths).slice(0, 3).join(', ')));
  } else if (assetMapPaths.length) {
    results.push(result(SEV.PASS, 'AM004', 'No duplicate ASSETMAP paths found'));
  }

  // ── PKL ───────────────────────────────────────────────────────────────────
  const cplInPKL = pkl.assets[cpl.id];
  if (!cplInPKL) {
    results.push(result(SEV.FAIL, 'PKL001', 'CPL not listed in PKL asset list'));
  } else {
    results.push(result(SEV.PASS, 'PKL001', 'CPL is listed in PKL'));
  }

  let missingFiles = 0;
  for (const [id, asset] of pklAssets) {
    if ((asset.type || '').toLowerCase() === 'text/xml') continue;
    const found = !!(
      fileMap.get(asset.file) || fileMap.get(normKey(asset.file)) ||
      fileMap.get(asset.assetMapPath) || fileMap.get(normKey(asset.assetMapPath)) ||
      fileMap.get(id) || fileMap.get(normKey(id))
    );
    if (!found) {
      results.push(result(SEV.FAIL, 'PKL002',
        `Missing file: ${asset.file || id}`, `UUID: ${id}`));
      missingFiles++;
    }
  }
  if (missingFiles === 0) {
    results.push(result(SEV.PASS, 'PKL002', 'All PKL assets present on disk'));
  }

  let sizeMismatches = 0;
  for (const [id, asset] of pklAssets) {
    if (!asset.size || (asset.type || '').toLowerCase() === 'text/xml') continue;
    const fh = fileMap.get(asset.file) || fileMap.get(normKey(asset.file)) || fileMap.get(asset.assetMapPath) || fileMap.get(normKey(asset.assetMapPath)) || fileMap.get(id) || fileMap.get(normKey(id));
    if (!fh) continue;
    if (fh.size !== asset.size) {
      results.push(result(SEV.FAIL, 'PKL003',
        `Size mismatch: ${asset.file || id}`,
        `Expected ${asset.size.toLocaleString()} B, got ${fh.size.toLocaleString()} B`));
      sizeMismatches++;
    }
  }
  if (sizeMismatches === 0) {
    results.push(result(SEV.PASS, 'PKL003', 'All file sizes match PKL declarations'));
  }

  const missingHashes = nonXmlAssets.filter(([, asset]) => !asset.hash);
  if (missingHashes.length) {
    results.push(result(SEV.WARN, 'PKL004',
      `${missingHashes.length} PKL asset${missingHashes.length === 1 ? '' : 's'} missing hash declarations`,
      missingHashes.slice(0, 3).map(([, a]) => a.file || a.id).join(', ')));
  } else if (nonXmlAssets.length) {
    results.push(result(SEV.PASS, 'PKL004', 'All non-XML PKL assets include a hash declaration'));
  }

  const hashShapes = nonXmlAssets.filter(([, asset]) => asset.hash).map(([, asset]) => String(asset.hash || '').trim());
  const oddHashes = hashShapes.filter(h => h && h.length < 20);
  if (oddHashes.length) {
    results.push(result(SEV.WARN, 'PKL005', 'One or more PKL hashes look unusually short', oddHashes.slice(0, 2).join(', ')));
  } else if (hashShapes.length) {
    results.push(result(SEV.PASS, 'PKL005', 'PKL hash declarations look structurally valid'));
  }

  // ── CPL core ───────────────────────────────────────────────────────────────
  if (!cpl.editRate || cpl.editRate <= 0) {
    results.push(result(SEV.FAIL, 'CPL001', 'CPL EditRate is invalid or missing'));
  } else {
    results.push(result(SEV.PASS, 'CPL001', `CPL EditRate: ${cpl.editRate} fps`));
  }

  if (videoResources.length === 0) {
    results.push(result(SEV.FAIL, 'CPL002', 'CPL has no MainImageSequence resources'));
  } else {
    results.push(result(SEV.PASS, 'CPL002',
      `CPL has ${videoResources.length} video reel(s)`));
  }

  const tracksNotInPKL = [];
  for (const res of [...videoResources, ...audioResources]) {
    if (res.trackFileId && !pkl.assets[res.trackFileId]) tracksNotInPKL.push(res.trackFileId);
  }
  if (tracksNotInPKL.length > 0) {
    results.push(result(SEV.WARN, 'CPL003',
      `${tracksNotInPKL.length} CPL TrackFileId(s) not in this PKL`,
      'May be from a supplemental or external package: ' + unique(tracksNotInPKL).slice(0, 3).join(', ')));
  } else {
    results.push(result(SEV.PASS, 'CPL003', 'All CPL TrackFileIds are in this PKL'));
  }

  if (cpl.totalFrames > 0) {
    const fps  = cpl.editRate || 24;
    const mins = Math.floor(cpl.durationSec / 60);
    const secs = Math.floor(cpl.durationSec % 60);
    results.push(result(SEV.INFO, 'CPL004',
      `Total duration: ${cpl.totalFrames.toLocaleString()} frames`,
      `${mins}m ${secs}s @ ${fps} fps`));
  }

  if (cpl.hasIAB) {
    results.push(result(SEV.INFO, 'CPL005', 'IAB (Dolby Atmos) audio track present'));
  } else if (audioResources.length > 0) {
    results.push(result(SEV.INFO, 'CPL005',
      `${audioResources.length} audio resource(s) present`));
  } else {
    results.push(result(SEV.WARN, 'CPL005', 'No audio resources found in CPL'));
  }

  let timingProblems = 0;
  for (const res of [...videoResources, ...audioResources]) {
    const intr = Number(res.intrinsicDuration || 0);
    const ent = Number(res.entryPoint || 0);
    const dur = Number(res.sourceDuration || 0);
    if (intr < 0 || ent < 0 || dur < 0) {
      // SourceDuration=0 is valid per SMPTE ST 2067-3 (means "all essence from EntryPoint")
      timingProblems++;
      continue;
    }
    if (intr > 0 && ent > intr) {
      timingProblems++;
      continue;
    }
    if (intr > 0 && (ent + dur) > intr) {
      timingProblems++;
      continue;
    }
  }
  if (timingProblems > 0) {
    results.push(result(SEV.FAIL, 'CPL006',
      `${timingProblems} resource timing entr${timingProblems === 1 ? 'y is' : 'ies are'} invalid`,
      'Check EntryPoint, SourceDuration and IntrinsicDuration relationships'));
  } else if (videoResources.length || audioResources.length) {
    results.push(result(SEV.PASS, 'CPL006', 'Resource timing relationships are internally consistent'));
  }

  const incompleteRefs = [...videoResources, ...audioResources].filter(r => !r.trackFileId || !r.essenceDescriptorId);
  if (incompleteRefs.length) {
    results.push(result(SEV.WARN, 'CPL007',
      `${incompleteRefs.length} resource${incompleteRefs.length === 1 ? '' : 's'} missing TrackFileId and/or EssenceDescriptorId`));
  } else if (videoResources.length || audioResources.length) {
    results.push(result(SEV.PASS, 'CPL007', 'All resources declare TrackFileId and EssenceDescriptorId'));
  }

  const uniqueVideoTracks = unique(videoResources.map(r => r.trackFileId));
  const externalVideoTracks = unique(videoResources.filter(r => r.trackFileId && !pkl.assets[r.trackFileId]).map(r => r.trackFileId));
  if (externalVideoTracks.length > 0) {
    results.push(result(SEV.INFO, 'CPL008',
      'Package appears to reference external video track file(s)',
      `Likely supplemental/external-reference IMP: ${externalVideoTracks.length} external video track file(s)`));
  } else if (uniqueVideoTracks.length) {
    results.push(result(SEV.INFO, 'CPL008',
      'Package appears self-contained for picture essences',
      `${uniqueVideoTracks.length} in-package video track file(s)`));
  }

  const multiVideoSeq = videoSequences.filter(seq => unique(seq.resources.map(r => r.trackFileId)).length > 1);
  if (multiVideoSeq.length) {
    results.push(result(SEV.WARN, 'CPL009',
      `${multiVideoSeq.length} MainImageSequence entr${multiVideoSeq.length === 1 ? 'y references' : 'ies reference'} multiple picture essences`,
      'IMF Insights flags this as a possible authoring or packaging issue for full deliveries'));
  } else if (videoSequences.length) {
    results.push(result(SEV.PASS, 'CPL009', 'Each MainImageSequence references a single picture essence at a time'));
  }

  const mixedVideoRates = unique(videoResources.map(r => Number(r.editRate || 0).toFixed(6))).filter(v => v !== '0.000000');
  const mixedAudioRates = unique(audioResources.map(r => Number(r.editRate || 0).toFixed(6))).filter(v => v !== '0.000000');
  if (mixedVideoRates.length > 1 || mixedAudioRates.length > 1) {
    results.push(result(SEV.WARN, 'CPL010',
      'Mixed resource edit rates detected inside the CPL',
      `Video rates: ${mixedVideoRates.join(', ') || '–'} | Audio rates: ${mixedAudioRates.join(', ') || '–'}`));
  } else {
    results.push(result(SEV.PASS, 'CPL010', 'Resource edit rates are consistent within each essence family'));
  }

  // ── Audio track intelligence ───────────────────────────────────────────────
  if (audioSequences.length) {
    const seqLabels = audioSequences.map(seq => (seq.seqType || '').toLowerCase());
    const hasIABSeq = seqLabels.some(s => s.includes('iab')) || cpl.hasIAB;
    if (hasIABSeq) {
      results.push(result(SEV.PASS, 'AUD001', 'Immersive audio sequence detected (IAB/Atmos path)'));
    } else {
      results.push(result(SEV.INFO, 'AUD001', `${audioSequences.length} audio sequence(s) detected`));
    }

    const multiEssAudio = audioSequences.filter(seq => unique(seq.resources.map(r => r.trackFileId)).length > 1);
    if (multiEssAudio.length) {
      results.push(result(SEV.WARN, 'AUD002',
        `${multiEssAudio.length} audio sequence${multiEssAudio.length === 1 ? '' : 's'} include edited/multiple essences`,
        'IMF Insights treats edited audio sequences as a possible encode-risk condition'));
    } else {
      results.push(result(SEV.PASS, 'AUD002', 'Audio sequences are single-essence within the current package graph'));
    }
  }

  // ── Picture quality checks ────────────────────────────────────────────────
  const res = cpl.resolution || {};
  const w = parseInt(res.w, 10) || 0;
  const h = parseInt(res.h, 10) || 0;

  if (w >= 3840 && h >= 2160) {
    results.push(result(SEV.PASS, 'PIC001', `Resolution: ${w}×${h} (4K UHD)`));
  } else if (w >= 2048 && h >= 1080) {
    results.push(result(SEV.PASS, 'PIC001', `Resolution: ${w}×${h} (2K)`));
  } else if (w > 0) {
    results.push(result(SEV.WARN, 'PIC001',
      `Resolution: ${w}×${h} — below standard IMF deliverable size`));
  }

  const transfer = cpl.transfer || '';
  if (transfer.includes('PQ') || transfer.includes('ST 2084')) {
    results.push(result(SEV.PASS, 'PIC002', `Transfer: ${transfer} (HDR)`));
  } else if (transfer.includes('HLG')) {
    results.push(result(SEV.PASS, 'PIC002', `Transfer: ${transfer} (HDR)`));
  } else if (transfer !== '–' && transfer !== 'Unknown') {
    results.push(result(SEV.INFO, 'PIC002', `Transfer: ${transfer}`));
  } else {
    results.push(result(SEV.WARN, 'PIC002', 'Transfer characteristic not identified'));
  }

  const primaries = cpl.primaries || '';
  if (primaries.includes('P3-D65') || primaries.includes('BT.2020')) {
    results.push(result(SEV.PASS, 'PIC003', `Color primaries: ${primaries} (Wide Gamut)`));
  } else if (primaries !== '–' && primaries !== 'Unknown') {
    results.push(result(SEV.INFO, 'PIC003', `Color primaries: ${primaries}`));
  } else {
    results.push(result(SEV.WARN, 'PIC003', 'Color primaries not identified'));
  }

  if (cpl.codec && cpl.codec !== '–') {
    const isHTJ2K = cpl.codec.includes('HTJ2K') || cpl.codec.includes('Part 15');
    const isJ2K = cpl.codec.includes('JPEG 2000');
    results.push(result(
      isHTJ2K ? SEV.INFO : isJ2K ? SEV.PASS : SEV.INFO,
      'PIC004',
      `Codec: ${cpl.codec}`,
      isHTJ2K ? 'HTJ2K declared — useful for routing, but decoder compatibility should still be verified at track level' : ''
    ));
  }

  if (cpl.isDolbyVision) {
    const dvProfile = parseInt(cpl.dvProfile, 10) || 0;
    const dvLevel   = parseInt(cpl.dvLevel,   10) || 0;
    const PROFILE_NAMES = { 4:'Profile 4 (BL+EL+MEL)', 5:'Profile 5 (BL+EL+FEL)',
                             7:'Profile 7 (BL+EL+RPU)', 8:'Profile 8.x',
                             9:'Profile 9', 10:'Profile 10' };
    const profLabel = dvProfile ? (PROFILE_NAMES[dvProfile] || `Profile ${dvProfile}`) : 'Profile not detected';
    const profOK = dvProfile === 5 || dvProfile === 8 || dvProfile === 0;
    results.push(result(
      dvProfile === 0 ? SEV.INFO : profOK ? SEV.PASS : SEV.WARN,
      'PIC005',
      `Dolby Vision metadata present — ${profLabel}`
    ));

    if (dvLevel > 0) {
      const levelOK = dvLevel >= 1 && dvLevel <= 13;
      results.push(result(
        levelOK ? SEV.PASS : SEV.WARN,
        'PIC005B',
        `DV Level: ${dvLevel}${levelOK ? '' : ' — outside expected SMPTE ST 2094-10 range (1–13)'}`
      ));
    } else {
      results.push(result(SEV.INFO, 'PIC005B', 'DV Level not present in EssenceDescriptor'));
    }

    const trimPasses = cpl.dvTrimPasses || 0;
    if (trimPasses > 0) {
      results.push(result(SEV.PASS, 'PIC005C',
        `DV Trim Pass: ${trimPasses} pass${trimPasses !== 1 ? 'es' : ''} declared`));
    } else {
      results.push(result(SEV.INFO, 'PIC005C',
        'DV Trim Pass: none declared in EssenceDescriptor (may be MXF-embedded)'));
    }
  }

  const bitDepth = parseInt(cpl.bitDepth, 10) || 0;
  if (bitDepth >= 12) {
    results.push(result(SEV.PASS, 'PIC006', `Bit depth: ${bitDepth}-bit (high-fidelity)`));
  } else if (bitDepth === 10) {
    results.push(result(SEV.PASS, 'PIC006', `Bit depth: ${bitDepth}-bit`));
  } else if (bitDepth > 0) {
    results.push(result(SEV.WARN, 'PIC006',
      `Bit depth: ${bitDepth}-bit — HDR deliverables typically require 10-bit or higher`));
  }

  const fps = cpl.editRate || 0;
  const validFPS = [23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60];
  const fpsFuzzy = validFPS.find(f => Math.abs(f - fps) < 0.01);
  if (fpsFuzzy) {
    results.push(result(SEV.PASS, 'PIC007', `Frame rate: ${fpsFuzzy} fps (standard)`));
  } else if (fps > 0) {
    results.push(result(SEV.WARN, 'PIC007',
      `Frame rate: ${fps} fps — non-standard value`));
  }

  const frameLayouts = unique((cpl.descriptors || []).map(d => d.frameLayout));
  if (frameLayouts.length) {
    results.push(result(SEV.INFO, 'PIC008', `Frame layout: ${frameLayouts.join(', ')}`));
  }

  // ── Application / smart routing ───────────────────────────────────────────
  const app = cpl.appVersion || '';
  if (app.includes('App#2E') || app.includes('2067-21')) {
    results.push(result(SEV.PASS, 'APP001',
      `Application: ${app}`, 'App #2E identified from CPL namespace / application identification'));
  } else if (app.includes('App#2')) {
    results.push(result(SEV.INFO, 'APP001', `Application: ${app}`));
  } else {
    results.push(result(SEV.INFO, 'APP001',
      app !== '–' ? `Application: ${app}` : 'Application version not declared in CPL namespace'));
  }

  if (app.includes('App#2E') || app.includes('2067-21')) {
    if (w > 0 && h > 0) {
      const insideEnvelope = w <= 4096 && h <= 3112;
      results.push(result(
        insideEnvelope ? SEV.PASS : SEV.FAIL,
        'APP002',
        insideEnvelope
          ? `App #2E image dimensions fall inside the ST 2067-21 envelope (${w}×${h})`
          : `App #2E image dimensions exceed the ST 2067-21 envelope (${w}×${h})`,
        insideEnvelope ? 'ST 2067-21:2023 Table 6 supports App #2E combinations up to 4096×3112 depending on profile' : 'Check profile/dimension conformance against ST 2067-21 Table 6'
      ));
    }

    const codecLabel = cpl.codec || '';
    if (/JPEG 2000|HTJ2K/i.test(codecLabel)) {
      results.push(result(SEV.PASS, 'APP003', 'App #2E picture essence is declared as JPEG 2000-family essence', codecLabel));
    } else if (codecLabel && codecLabel !== '–') {
      results.push(result(SEV.WARN, 'APP003', 'App #2E package does not declare JPEG 2000-family picture essence', codecLabel));
    }
  }

  const photonStageOk = !!(pklAsset && cplInPKL && videoResources.length && missingFiles === 0 && !timingProblems);
  results.push(result(
    photonStageOk ? SEV.PASS : SEV.WARN,
    'APP004',
    photonStageOk
      ? 'XML/package graph passes a Photon-style fail-fast preflight stage'
      : 'XML/package graph has issues that would likely fail a Photon-style preflight stage',
    'Netflix Backlot uses Photon to verify App #2E compliance from XMLs first; MXF inspection happens later'
  ));

  const routeHints = [];
  if (/HTJ2K|Part 15/i.test(cpl.codec || '')) routeHints.push('HTJ2K path advertised');
  if (/JPEG 2000/i.test(cpl.codec || '')) routeHints.push('JPEG 2000 family essence');
  if (cpl.hasIAB) routeHints.push('IAB audio present');
  if (cpl.isDolbyVision) routeHints.push('Dolby Vision metadata present');
  if (routeHints.length) {
    results.push(result(SEV.INFO, 'APP005', 'Smart routing hints', routeHints.join(' | ')));
  }

  // ── AM extended checks ────────────────────────────────────────────────────
  // AM005: Path character safety (SMPTE ST 0429-9: restricted charset per segment)
  const illegalPaths = assetMapPaths.filter(a => a.path && /[^a-zA-Z0-9._\-\/\\]/.test(a.path));
  if (illegalPaths.length) {
    results.push(result(SEV.WARN, 'AM005',
      `${illegalPaths.length} ASSETMAP path(s) contain characters outside SMPTE-permitted set`,
      illegalPaths.slice(0, 2).map(a => a.path).join(', ')));
  } else if (assetMapPaths.length) {
    results.push(result(SEV.PASS, 'AM005', 'All ASSETMAP paths use safe characters'));
  }

  // AM006: No path traversal or absolute paths
  const traversalPaths = assetMapPaths.filter(a => a.path && (a.path.includes('../') || a.path.startsWith('/')));
  if (traversalPaths.length) {
    results.push(result(SEV.FAIL, 'AM006',
      `${traversalPaths.length} ASSETMAP path(s) use unsafe traversal or absolute paths`,
      traversalPaths.slice(0, 2).map(a => a.path).join(', ')));
  } else if (assetMapPaths.length) {
    results.push(result(SEV.PASS, 'AM006', 'No path traversal or absolute paths in ASSETMAP'));
  }

  // AM007: VolumeCount must be 1 (single-volume IMP)
  const volCount = assetMap.volumeCount ?? 1;
  if (volCount !== 1) {
    results.push(result(SEV.WARN, 'AM007',
      `ASSETMAP VolumeCount is ${volCount} — IMF IMPs must be single-volume (VolumeCount = 1)`,
      'Multi-volume packages are not permitted per SMPTE ST 0429-9'));
  } else {
    results.push(result(SEV.PASS, 'AM007', 'ASSETMAP VolumeCount = 1 (single-volume IMP)'));
  }

  // ── PKL extended checks ───────────────────────────────────────────────────
  // PKL006: Hash algorithm advisory (SHA-1 = 28 chars base64, SHA-256 = 44 chars)
  const sha1Hashes  = hashShapes.filter(h => h.length === 28);
  const sha256Hashes = hashShapes.filter(h => h.length === 44);
  if (sha1Hashes.length > 0 && sha256Hashes.length === 0) {
    results.push(result(SEV.WARN, 'PKL006',
      'PKL uses SHA-1 hash algorithm — SMPTE advisory recommends SHA-256 for new deliveries',
      'SHA-1 is still technically valid but is deprecated for security reasons'));
  } else if (sha256Hashes.length > 0) {
    results.push(result(SEV.PASS, 'PKL006', `PKL uses SHA-256 hash algorithm (${sha256Hashes.length} assets)`));
  } else if (hashShapes.length > 0) {
    results.push(result(SEV.INFO, 'PKL006', 'Hash algorithm could not be determined from hash length'));
  }

  // PKL007: MIME type consistency with file extension
  const mimeErrors = [];
  for (const [id, asset] of pklAssets) {
    const fname = (asset.file || '').toLowerCase();
    const mime  = (asset.type  || '').toLowerCase();
    if (fname.endsWith('.mxf') && mime && !mime.includes('mxf')) mimeErrors.push(asset.file);
    if ((fname.endsWith('.xml') || fname.endsWith('.cpl')) && mime && mime.includes('mxf')) mimeErrors.push(asset.file);
  }
  if (mimeErrors.length) {
    results.push(result(SEV.WARN, 'PKL007',
      `${mimeErrors.length} PKL asset(s) have MIME type inconsistent with file extension`,
      mimeErrors.slice(0, 2).join(', ')));
  } else if (pklAssets.length) {
    results.push(result(SEV.PASS, 'PKL007', 'PKL MIME types are consistent with file extensions'));
  }

  // PKL008: PKL metadata presence
  const pklMeta = [];
  if (!pkl.creator)   pklMeta.push('Creator');
  if (!pkl.issueDate) pklMeta.push('IssueDate');
  if (pklMeta.length) {
    results.push(result(SEV.INFO, 'PKL008',
      `PKL missing recommended metadata: ${pklMeta.join(', ')}`));
  } else {
    results.push(result(SEV.PASS, 'PKL008', 'PKL metadata is complete (Creator, IssueDate)'));
  }

  // ── CPL extended checks ───────────────────────────────────────────────────
  // CPL011: ContentTitle is a SMPTE-required element
  if (!cpl.contentTitle) {
    results.push(result(SEV.FAIL, 'CPL011',
      'CPL is missing ContentTitle / FullContentTitleText — required by SMPTE ST 2067-3'));
  } else {
    results.push(result(SEV.PASS, 'CPL011', `ContentTitle: "${cpl.contentTitle.slice(0, 80)}"`));
  }

  // CPL012: ContentKind enumeration
  const KNOWN_CONTENT_KINDS = new Set([
    'feature', 'trailer', 'teaser', 'rating', 'advertisement', 'short', 'transitional',
    'test', 'policy', 'episode', 'minisode', 'supplemental', 'highlights', 'event',
    'promo', 'interstitial', 'collection', 'other',
  ]);
  if (!cpl.contentKind) {
    results.push(result(SEV.INFO, 'CPL012', 'ContentKind not declared in CPL'));
  } else if (!KNOWN_CONTENT_KINDS.has((cpl.contentKind || '').toLowerCase())) {
    results.push(result(SEV.WARN, 'CPL012',
      `ContentKind "${cpl.contentKind}" is not in the SMPTE ST 2067-3 enumeration`,
      'Use a custom URI scope if a non-standard value is required'));
  } else {
    results.push(result(SEV.PASS, 'CPL012', `ContentKind: "${cpl.contentKind}"`));
  }

  // CPL013: CompositionTimecode required (SMPTE ST 2067-3 SHALL)
  const tc = cpl.compositionTimecode;
  if (!tc) {
    results.push(result(SEV.FAIL, 'CPL013',
      'CPL is missing CompositionTimecode — required by SMPTE ST 2067-3'));
  } else if (!tc.startAddress) {
    results.push(result(SEV.WARN, 'CPL013',
      'CompositionTimecode is present but TimecodeStartAddress is empty'));
  } else {
    const dfNote = tc.dropFrame ? ' (drop-frame)' : ' (non-drop)';
    results.push(result(SEV.PASS, 'CPL013',
      `CompositionTimecode: ${tc.startAddress}${dfNote} at ${tc.rate || cpl.editRate || '?'} fps`));
  }

  // CPL014: ContentVersionList — at least one entry, no duplicate IDs
  const cvList = cpl.contentVersions || [];
  if (cvList.length === 0) {
    results.push(result(SEV.WARN, 'CPL014',
      'CPL ContentVersionList is absent or empty — required by SMPTE ST 2067-3'));
  } else {
    const cvIds = cvList.map(cv => cv.id);
    const dupeCvIds = cvIds.filter((id, i) => cvIds.indexOf(id) !== i);
    if (dupeCvIds.length) {
      results.push(result(SEV.FAIL, 'CPL014',
        `ContentVersionList contains ${dupeCvIds.length} duplicate ID(s)`,
        dupeCvIds.slice(0, 2).join(', ')));
    } else {
      results.push(result(SEV.PASS, 'CPL014',
        `ContentVersionList: ${cvList.length} version${cvList.length > 1 ? 's' : ''}${cvList[0].label ? ` — "${cvList[0].label.slice(0, 60)}"` : ''}`));
    }
  }

  // CPL015: EssenceDescriptor ID uniqueness
  const descIds = (cpl.descriptors || []).map(d => d.id);
  const dupeDescIds = descIds.filter((id, i) => id && descIds.indexOf(id) !== i);
  if (dupeDescIds.length) {
    results.push(result(SEV.FAIL, 'CPL015',
      `EssenceDescriptorList contains ${dupeDescIds.length} duplicate descriptor ID(s)`,
      dupeDescIds.slice(0, 2).join(', ')));
  } else if (descIds.length) {
    results.push(result(SEV.PASS, 'CPL015',
      `EssenceDescriptorList: ${descIds.length} unique descriptor ID(s)`));
  }

  // CPL016: All resource EssenceDescriptorIds must exist in EssenceDescriptorList
  const danglingDescRefs = [...videoResources, ...audioResources]
    .filter(r => r.essenceDescriptorId && !descById.has(r.essenceDescriptorId))
    .map(r => r.essenceDescriptorId);
  const uniqueDangling = unique(danglingDescRefs);
  if (uniqueDangling.length) {
    results.push(result(SEV.FAIL, 'CPL016',
      `${uniqueDangling.length} resource(s) reference EssenceDescriptorId not in EssenceDescriptorList`,
      uniqueDangling.slice(0, 2).join(', ')));
  } else if (videoResources.length) {
    results.push(result(SEV.PASS, 'CPL016',
      'All resource EssenceDescriptorIds resolve within EssenceDescriptorList'));
  }

  // CPL017: ScreenAspectRatio validity (positive rational, sane range 1.0–3.0)
  const sar = cpl.screenAspectRatio;
  if (!sar) {
    results.push(result(SEV.INFO, 'CPL017', 'ScreenAspectRatio not declared in CPL'));
  } else if (sar.value <= 0) {
    results.push(result(SEV.FAIL, 'CPL017',
      `ScreenAspectRatio "${sar.text}" is zero or negative — invalid rational`));
  } else if (sar.value < 1.0 || sar.value > 3.0) {
    results.push(result(SEV.WARN, 'CPL017',
      `ScreenAspectRatio ${sar.value.toFixed(4)} is outside the common range (1.0–3.0)`,
      `Declared: "${sar.text}"`));
  } else {
    results.push(result(SEV.PASS, 'CPL017',
      `ScreenAspectRatio: ${sar.value.toFixed(4)} (${sar.text})`));
  }

  // CPL018: A/V duration balance (video total duration vs PCM audio total duration)
  if (videoResources.length && audioResources.length) {
    const vidFrames = videoResources.reduce((n, r) =>
      n + (r.sourceDuration || r.intrinsicDuration || 0) * (r.repeatCount || 1), 0);
    const audFrames = (cpl.pcmAudioResources || audioResources.filter(r =>
      !((cpl.iabResources || []).some(x => x.trackFileId === r.trackFileId))))
      .reduce((n, r) => {
        const frames = (r.sourceDuration || r.intrinsicDuration || 0) * (r.repeatCount || 1);
        const scale  = r.editRate && cpl.editRate ? r.editRate / cpl.editRate : 1;
        return n + Math.round(frames * scale);
      }, 0);
    const diff = Math.abs(vidFrames - audFrames);
    if (audFrames > 0 && diff > 2) {
      results.push(result(SEV.FAIL, 'CPL018',
        `A/V duration mismatch: video ${vidFrames.toLocaleString()} frames vs audio ${audFrames.toLocaleString()} frames`,
        `Difference: ${diff} frame${diff !== 1 ? 's' : ''} — check EntryPoint/SourceDuration across all audio tracks`));
    } else if (audFrames > 0) {
      results.push(result(SEV.PASS, 'CPL018',
        `A/V duration balanced: ${vidFrames.toLocaleString()} video frames / ${audFrames.toLocaleString()} audio frames`));
    }
  }

  // CPL019: Picture EssenceDescriptor completeness
  const picDescList = (cpl.descriptors || []).filter(d => d.isPicture);
  const incompleteDesc = picDescList.filter(d =>
    !d.w || d.w === '–' || !d.h || d.h === '–' || !d.tc || d.tc === '–' || !d.cp || d.cp === '–');
  if (incompleteDesc.length) {
    results.push(result(SEV.WARN, 'CPL019',
      `${incompleteDesc.length} picture EssenceDescriptor(s) missing required field(s)`,
      'Fields required by SMPTE ST 2067-5: StoredWidth, StoredHeight, TransferCharacteristic, ColorPrimaries'));
  } else if (picDescList.length) {
    results.push(result(SEV.PASS, 'CPL019',
      'All picture EssenceDescriptors declare required metadata fields'));
  }

  // CPL020: CPL identification metadata
  const cplMeta = [];
  if (!cpl.issuer)    cplMeta.push('Issuer');
  if (!cpl.creator)   cplMeta.push('Creator');
  if (!cpl.issueDate) cplMeta.push('IssueDate');
  if (cplMeta.length) {
    results.push(result(SEV.INFO, 'CPL020',
      `CPL missing recommended metadata: ${cplMeta.join(', ')}`));
  } else {
    results.push(result(SEV.PASS, 'CPL020', 'CPL identification metadata complete'));
  }

  // CPL021: CPL Markers (FFOC/LFOC required for feature/episode content)
  const markerLabels = new Set((cpl.markers || []).map(m => (m.label || '').toUpperCase()));
  const isLongForm = ['feature', 'episode', 'minisode'].includes((cpl.contentKind || '').toLowerCase());
  if (isLongForm) {
    const ffoc = markerLabels.has('FFOC'); const lfoc = markerLabels.has('LFOC');
    if (!ffoc || !lfoc) {
      const missing = [!ffoc && 'FFOC', !lfoc && 'LFOC'].filter(Boolean);
      results.push(result(SEV.WARN, 'CPL021',
        `Long-form content (${cpl.contentKind}) is missing mandatory CPL marker(s): ${missing.join(', ')}`,
        'FFOC and LFOC are required by ST 2067-3 for feature/episode compositions'));
    } else {
      const markerList = [...markerLabels].join(', ');
      results.push(result(SEV.PASS, 'CPL021',
        `CPL markers present (${markerList})`));
    }
  } else if ((cpl.markers || []).length > 0) {
    results.push(result(SEV.PASS, 'CPL021',
      `CPL markers: ${[...markerLabels].join(', ')}`));
  } else {
    results.push(result(SEV.INFO, 'CPL021', 'No CPL markers declared'));
  }

  // CPL022: Locale language tag presence
  const locales = cpl.locales || [];
  if (locales.length) {
    const langs = locales.map(l => l.language).filter(Boolean);
    // Basic RFC 5646 sanity: 2-3 letter code, optionally with subtags
    const badLangs = langs.filter(l => !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(l));
    if (badLangs.length) {
      results.push(result(SEV.WARN, 'CPL022',
        `${badLangs.length} Locale language tag(s) do not match RFC 5646 format`,
        badLangs.slice(0, 2).join(', ')));
    } else {
      results.push(result(SEV.PASS, 'CPL022',
        `Locale language tag${langs.length > 1 ? 's' : ''}: ${langs.join(', ')}`));
    }
  } else {
    results.push(result(SEV.INFO, 'CPL022', 'No Locale entries declared in CPL'));
  }

  // CPL023: OV vs VF (Supplemental composition) detection
  const nsStr = (() => {
    try {
      // Check for PartiallyIsomorphicCompositionPlaylist namespace or element
      const xmlStr = (typeof cpl._raw === 'string') ? cpl._raw : '';
      if (xmlStr.includes('PartiallyIsomorphic') || xmlStr.includes('supplemental')) return 'VF';
    } catch {}
    return null;
  })();
  // Supplemental: any track file referenced by video that is NOT in this PKL
  const externalVidTracks = unique(videoResources.filter(r => r.trackFileId && !pkl.assets[r.trackFileId]).map(r => r.trackFileId));
  if (externalVidTracks.length > 0) {
    results.push(result(SEV.INFO, 'CPL023',
      'Supplemental / Version File (VF) composition detected',
      `${externalVidTracks.length} video track file(s) not in this PKL — require the Original Version (OV) IMP to decode`));
  } else {
    results.push(result(SEV.INFO, 'CPL023', 'Original Version (OV) — all picture track files self-contained in this IMP'));
  }

  // CPL024: Audio PCM channel count is standard value
  if ((cpl.pcmAudioResources || []).length) {
    const STANDARD_CH = new Set([1, 2, 4, 6, 8, 12, 16, 20, 24]);
    const allDescById = new Map((cpl.descriptors || []).map(d => [d.id, d]));
    const oddChannels = [];
    for (const res of (cpl.pcmAudioResources || [])) {
      const d = allDescById.get(res.essenceDescriptorId);
      const cc = d?.channelCount || res.channelCount || 0;
      if (cc > 0 && !STANDARD_CH.has(cc)) oddChannels.push(cc);
    }
    if (unique(oddChannels.map(String)).length) {
      results.push(result(SEV.WARN, 'CPL024',
        `Non-standard audio channel count(s) detected: ${unique(oddChannels.map(String)).join(', ')}`,
        'Standard IMF PCM track channel counts: 1, 2, 4, 6, 8, 12, 16, 20, 24'));
    } else {
      const layout = cpl.audioLayout || '';
      results.push(result(SEV.PASS, 'CPL024',
        `Audio channel configuration: ${layout || 'PCM'} — standard channel count`));
    }
  }

  // ── HDR / Mastering Display checks ────────────────────────────────────────
  const isPQ = (cpl.transfer || '').includes('PQ') || (cpl.transfer || '').includes('ST 2084');
  const isHDR = isPQ || (cpl.transfer || '').includes('HLG');
  const picDescForHDR = (cpl.descriptors || []).find(d => d.isPicture);

  if (isHDR) {
    // HDR001: Mastering display metadata required for HDR content
    const hasMD = (cpl.descriptors || []).some(d => d.hasMasteringDisplay);
    if (!hasMD) {
      results.push(result(SEV.WARN, 'HDR001',
        'HDR content is missing Mastering Display metadata in EssenceDescriptor(s)',
        'SMPTE ST 2086 mastering display metadata (max/min luminance, primaries) should be declared for HDR deliveries'));
    } else {
      const maxL = picDescForHDR?.masteringMaxLum;
      const minL = picDescForHDR?.masteringMinLum;
      results.push(result(SEV.PASS, 'HDR001',
        `Mastering Display metadata present${maxL != null ? ` — max ${maxL} cd/m²` : ''}${minL != null ? `, min ${minL} cd/m²` : ''}`));
    }

    // HDR002: MaxCLL / MaxFALL required for PQ HDR (Netflix / SMPTE best practice)
    if (isPQ) {
      const hasCLL  = (cpl.descriptors || []).some(d => d.maxCLL  != null);
      const hasFALL = (cpl.descriptors || []).some(d => d.maxFALL != null);
      if (!hasCLL || !hasFALL) {
        const miss = [!hasCLL && 'MaxCLL', !hasFALL && 'MaxFALL'].filter(Boolean);
        results.push(result(SEV.WARN, 'HDR002',
          `PQ HDR content is missing ${miss.join(' and ')} in EssenceDescriptor(s)`,
          'MaxCLL and MaxFALL are required for PQ HDR deliveries per Netflix and Disney+ specifications'));
      } else {
        const cllVal  = picDescForHDR?.maxCLL;
        const fallVal = picDescForHDR?.maxFALL;
        results.push(result(SEV.PASS, 'HDR002',
          `MaxCLL / MaxFALL declared${cllVal != null ? ` — CLL ${cllVal}` : ''}${fallVal != null ? `, FALL ${fallVal}` : ''} cd/m²`));
      }
    }

    // HDR003: Mastering display luminance range sanity
    const maxLum = picDescForHDR?.masteringMaxLum;
    const minLum = picDescForHDR?.masteringMinLum;
    if (maxLum != null) {
      if (maxLum <= 0 || maxLum > 10000) {
        results.push(result(SEV.WARN, 'HDR003',
          `Mastering Display maximum luminance ${maxLum} cd/m² is outside valid range (0–10000)`,
          'Check MasteringDisplayMaximumLuminance value in EssenceDescriptor'));
      } else {
        const profile = maxLum >= 1000 ? '1000+ nit (P3/D65)' : maxLum >= 600 ? '600 nit (P3)' : maxLum >= 100 ? '100 nit' : '< 100 nit';
        results.push(result(SEV.PASS, 'HDR003',
          `Mastering display: ${maxLum} cd/m² max luminance (${profile})`));
      }
    }
  } else if ((cpl.descriptors || []).length > 0) {
    results.push(result(SEV.INFO, 'HDR001', 'SDR content — mastering display metadata check skipped'));
  }

  // ── Inter-reel consistency checks ────────────────────────────────────────
  const reelDescIds = unique(videoResources.map(r => r.essenceDescriptorId));
  const reelDescs   = reelDescIds.map(id => descById.get(id)).filter(Boolean);

  if (reelDescs.length > 1) {
    // REEL001: Resolution must be uniform across all reels
    const reelResolutions = unique(reelDescs.map(d => `${d.w}×${d.h}`));
    if (reelResolutions.length > 1) {
      results.push(result(SEV.FAIL, 'REEL001',
        `Resolution changes across reels: ${reelResolutions.join(', ')}`,
        'SMPTE ST 2067-2 requires homogeneous picture parameters within a Composition'));
    } else {
      results.push(result(SEV.PASS, 'REEL001',
        `Resolution consistent across ${reelDescs.length} reels: ${reelResolutions[0]}`));
    }

    // REEL002: Transfer characteristic must be uniform
    const reelTransfers = unique(reelDescs.map(d => d.tc).filter(Boolean));
    if (reelTransfers.length > 1) {
      results.push(result(SEV.FAIL, 'REEL002',
        `Transfer characteristic changes across reels: ${reelTransfers.join(', ')}`,
        'Mixing HDR and SDR reels in a single Composition is not conformant'));
    } else if (reelTransfers.length) {
      results.push(result(SEV.PASS, 'REEL002',
        `Transfer characteristic consistent: ${reelTransfers[0]}`));
    }

    // REEL003: Color primaries must be uniform
    const reelPrimaries = unique(reelDescs.map(d => d.cp).filter(Boolean));
    if (reelPrimaries.length > 1) {
      results.push(result(SEV.FAIL, 'REEL003',
        `Color primaries change across reels: ${reelPrimaries.join(', ')}`,
        'Color primaries must be homogeneous within a Composition per SMPTE ST 2067-2'));
    } else if (reelPrimaries.length) {
      results.push(result(SEV.PASS, 'REEL003',
        `Color primaries consistent: ${reelPrimaries[0]}`));
    }

    // REEL004: Bit depth must be uniform
    const reelDepths = unique(reelDescs.map(d => d.depth).filter(d => d && d !== '–'));
    if (reelDepths.length > 1) {
      results.push(result(SEV.WARN, 'REEL004',
        `Bit depth varies across reels: ${reelDepths.join(', ')} bit`));
    } else if (reelDepths.length) {
      results.push(result(SEV.PASS, 'REEL004',
        `Bit depth consistent: ${reelDepths[0]}-bit across all reels`));
    }

    // REEL005: Codec type must be uniform
    const reelCodecFlags = unique(reelDescs.map(d =>
      d.isHTJ2K ? 'HTJ2K' : d.isJ2K ? 'JPEG 2000' : d.isRGBA ? 'RGBA' : d.isCDCI ? 'CDCI' : '?'));
    if (reelCodecFlags.length > 1) {
      results.push(result(SEV.FAIL, 'REEL005',
        `Codec type changes across reels: ${reelCodecFlags.join(', ')}`,
        'Mixing different picture codecs in a single Composition is a conformance violation'));
    } else if (reelCodecFlags.length) {
      results.push(result(SEV.PASS, 'REEL005',
        `Codec consistent across all reels: ${reelCodecFlags[0]}`));
    }
  } else if (videoResources.length > 0) {
    results.push(result(SEV.INFO, 'REEL001', 'Single-reel composition — inter-reel consistency checks not applicable'));
  }

  // ── Timecode checks ───────────────────────────────────────────────────────
  const tcInfo = cpl.compositionTimecode;
  if (tcInfo) {
    // TC001: Drop-frame flag correctness (drop-frame only valid at ~29.97 and ~59.94 fps)
    const fps = cpl.editRate || 0;
    const isDropFPS = Math.abs(fps - 29.97) < 0.02 || Math.abs(fps - 59.94) < 0.02;
    if (tcInfo.dropFrame && !isDropFPS) {
      results.push(result(SEV.WARN, 'TC001',
        `Drop-frame flag is set but frame rate is ${fps} fps — drop-frame is only valid at 29.97 or 59.94 fps`,
        'SMPTE ST 12-1: drop-frame timecode applies only to 30000/1001 and 60000/1001 rates'));
    } else if (!tcInfo.dropFrame && isDropFPS) {
      results.push(result(SEV.INFO, 'TC001',
        `Non-drop-frame timecode at ${fps} fps — drop-frame mode is more common for 29.97/59.94 fps`));
    } else {
      results.push(result(SEV.PASS, 'TC001',
        `Timecode drop-frame flag correct for ${fps} fps (${tcInfo.dropFrame ? 'drop-frame' : 'non-drop'})`));
    }

    // TC002: Timecode rate must be consistent with the CPL EditRate
    const tcRate = tcInfo.rate || 0;
    if (tcRate > 0 && fps > 0 && Math.abs(tcRate - fps) > 0.5) {
      results.push(result(SEV.WARN, 'TC002',
        `TimecodeRate (${tcRate}) does not match CPL EditRate (${fps})`,
        'The timecode rate should match the composition frame rate'));
    } else if (tcRate > 0) {
      results.push(result(SEV.PASS, 'TC002',
        `TimecodeRate (${tcRate}) consistent with CPL EditRate (${fps})`));
    }
  }

  // ── Audio conformance (ST 2067-2 §5.3) ──────────────────────────────────────
  // AUD007: PCM audio sample rate (48000 or 96000 Hz only)
  const audioDescs = (cpl.descriptors || []).filter(d => !d.isPicture && !d.isIAB && d.audioSampleRate != null);
  if (audioDescs.length) {
    const badRates = audioDescs.filter(d => d.audioSampleRate !== 48000 && d.audioSampleRate !== 96000);
    if (badRates.length) {
      const rates = unique(badRates.map(d => String(d.audioSampleRate)));
      results.push(result(SEV.FAIL, 'AUD007',
        `Non-conformant audio sample rate(s): ${rates.join(', ')} Hz`,
        'SMPTE ST 2067-2:2016 §5.3.2.2 — PCM audio shall be 48000 Hz or 96000 Hz'));
    } else {
      const rates = unique(audioDescs.map(d => `${d.audioSampleRate} Hz`));
      results.push(result(SEV.PASS, 'AUD007',
        `Audio sample rate: ${rates.join(', ')} (ST 2067-2 conformant)`));
    }
  }

  // AUD008: PCM audio bit depth (24-bit only per ST 2067-2 §5.3.2.3)
  const audioDescsWithBit = (cpl.descriptors || []).filter(d => !d.isPicture && !d.isIAB && d.audioQuantBits != null);
  if (audioDescsWithBit.length) {
    const non24 = audioDescsWithBit.filter(d => d.audioQuantBits !== 24);
    if (non24.length) {
      const depths = unique(non24.map(d => String(d.audioQuantBits)));
      results.push(result(SEV.WARN, 'AUD008',
        `Non-standard audio bit depth(s) in EssenceDescriptor(s): ${depths.join(', ')}-bit`,
        'SMPTE ST 2067-2:2016 §5.3.2.3 recommends 24-bit PCM for IMF deliveries'));
    } else {
      results.push(result(SEV.PASS, 'AUD008', 'Audio bit depth: 24-bit (ST 2067-2 conformant)'));
    }
  }

  // AUD009: Long-form content should declare at least one audio track
  const isLongFormContent = ['feature', 'episode', 'minisode'].includes((cpl.contentKind || '').toLowerCase());
  if (isLongFormContent && audioResources.length === 0) {
    results.push(result(SEV.WARN, 'AUD009',
      `Long-form content (${cpl.contentKind}) has no audio resources`,
      'Feature and episode CPLs are expected to include at least one audio virtual track'));
  } else if (audioResources.length > 0) {
    const pcmCount = (cpl.pcmAudioResources || audioResources.filter(r =>
      !(cpl.iabResources || []).some(x => x.trackFileId === r.trackFileId))).length;
    const iabCount = (cpl.iabResources || []).length;
    const parts = [];
    if (iabCount) parts.push(`${iabCount} IAB`);
    if (pcmCount) parts.push(`${pcmCount} PCM`);
    results.push(result(SEV.INFO, 'AUD009',
      `Audio resources: ${parts.join(' + ') || audioResources.length + ' track(s)'}`));
  }

  // ── CPL extended checks (continued) ────────────────────────────────────────
  // CPL025: Resource EntryPoint must be < IntrinsicDuration (strict §6.11.6 ST 2067-3)
  const badEP = [...videoResources, ...audioResources].filter(r => {
    const ep = Number(r.entryPoint || 0);
    const id = Number(r.intrinsicDuration || 0);
    return id > 0 && ep >= id;
  });
  if (badEP.length) {
    results.push(result(SEV.FAIL, 'CPL025',
      `${badEP.length} resource(s) have EntryPoint ≥ IntrinsicDuration`,
      'ST 2067-3 §6.11.6: EntryPoint must satisfy 0 ≤ EntryPoint < IntrinsicDuration'));
  } else if (videoResources.length) {
    results.push(result(SEV.PASS, 'CPL025', 'All resource EntryPoint values satisfy ST 2067-3 §6.11.6'));
  }

  // CPL026: Edit rate must be one of the 12 ST 2067-21 App2E permitted rates
  const APP2E_RATES = [23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 96, 120];
  const eFps = cpl.editRate || 0;
  const isPermittedRate = APP2E_RATES.some(r => Math.abs(r - eFps) < 0.02);
  if (eFps > 0 && !isPermittedRate) {
    results.push(result(SEV.WARN, 'CPL026',
      `Edit rate ${eFps} fps is not in the SMPTE ST 2067-21 permitted set`,
      'Permitted rates: 23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 96, 120 fps'));
  } else if (eFps > 0) {
    results.push(result(SEV.PASS, 'CPL026',
      `Edit rate ${eFps} fps is a permitted ST 2067-21 rate`));
  }

  // CPL027: RepeatCount > 1 advisory (unusual in mastering deliveries)
  const repeatedResources = [...videoResources, ...audioResources].filter(r => (r.repeatCount || 1) > 1);
  if (repeatedResources.length) {
    const maxRepeat = Math.max(...repeatedResources.map(r => r.repeatCount || 1));
    results.push(result(SEV.INFO, 'CPL027',
      `${repeatedResources.length} resource(s) use RepeatCount > 1 (max: ${maxRepeat})`,
      'Repeat counts > 1 are uncommon in mastering CPLs — verify this is intentional'));
  }

  // ── Picture extended checks ───────────────────────────────────────────────
  // PIC009: App2E requires progressive scan (interlaced is not conformant)
  const interlacedDescs = (cpl.descriptors || []).filter(d => d.isPicture && d.frameLayout === 'Interlaced');
  if (interlacedDescs.length) {
    results.push(result(SEV.FAIL, 'PIC009',
      `${interlacedDescs.length} picture EssenceDescriptor(s) declare interlaced scan`,
      'SMPTE ST 2067-21 (App#2E) requires progressive scan; interlaced frames are not conformant'));
  } else if ((cpl.descriptors || []).some(d => d.isPicture)) {
    results.push(result(SEV.PASS, 'PIC009', 'Picture scan: progressive (App#2E conformant)'));
  }

  // REEL006: Frame layout consistency across reels
  if (reelDescs.length > 1) {
    const reelLayouts = unique(reelDescs.map(d => d.frameLayout).filter(Boolean));
    if (reelLayouts.length > 1) {
      results.push(result(SEV.FAIL, 'REEL006',
        `Frame layout changes across reels: ${reelLayouts.join(', ')}`,
        'Mixing progressive and interlaced reels in a single Composition is non-conformant'));
    } else if (reelLayouts.length) {
      results.push(result(SEV.PASS, 'REEL006', `Frame layout consistent across reels: ${reelLayouts[0]}`));
    }
  }

  // PKL009: Timed text / subtitle track files present
  const timedTextAssets = pklAssets.filter(([, a]) =>
    /imsc|ttml|smpte-tt|subtitle|caption/i.test(a.type || '') ||
    /\.(ttml|xml\.gz|imsc)$/i.test(a.file || ''));
  if (timedTextAssets.length) {
    results.push(result(SEV.INFO, 'PKL009',
      `${timedTextAssets.length} timed-text / subtitle track file(s) in PKL`,
      timedTextAssets.slice(0, 2).map(([, a]) => a.file || a.id).join(', ')));
  }

  // TC003: Timecode start address format (HH:MM:SS:FF / HH:MM:SS;FF)
  const tcAddr = cpl.compositionTimecode?.startAddress || '';
  if (tcAddr) {
    const TC_FORMAT = /^[0-2][0-9][:\/;,+\-][0-5][0-9][:\/;,+\-][0-5][0-9][:\/;,+\-][0-9]{2,3}$/;
    if (!TC_FORMAT.test(tcAddr)) {
      results.push(result(SEV.WARN, 'TC003',
        `CompositionTimecode StartAddress "${tcAddr}" does not match expected HH:MM:SS:FF format`,
        'SMPTE ST 2067-3: TimecodeStartAddress should follow pattern HH:MM:SS:FF (or semicolons for drop-frame)'));
    } else {
      results.push(result(SEV.PASS, 'TC003', `Timecode start address format valid: ${tcAddr}`));
    }
  }

  // APP006: HTJ2K streaming progression order advisory
  if (/HTJ2K|Part 15/i.test(cpl.codec || '')) {
    results.push(result(SEV.INFO, 'APP006',
      'HTJ2K (JPEG 2000 Part 15) detected — verify RPCL progression order for streaming playback',
      'IMF plugfests (2024): RPCL is required for streaming; CPRL or LRCP will fail on-demand players. Check with a J2K codestream inspector.'));
  }

  return results;
}

// ── SHA-1 hash verification (async, per-file) ─────────────────────────────────
export async function verifySHA1(file, expectedBase64, onProgress) {
  try {
    // Guard: Web Crypto requires the full file in one ArrayBuffer. Cap at 2 GB to
    // avoid OOM on large MXF essence files — return null (skip) rather than crash.
    const MAX = 2 * 1024 * 1024 * 1024;
    if (file.size > MAX) return null;

    const ab = await file.arrayBuffer();
    if (onProgress) onProgress(1);
    const digest = await crypto.subtle.digest('SHA-1', ab);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    return b64 === expectedBase64;
  } catch {
    return null;
  }
}
