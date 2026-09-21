// imf_ug_checks.js — IMF User Group Best Practice checks
// Based on IMF UG guidelines: Timecode, IMSC Subtitles, MCA Labels, CPL Constraints, Packaging Naming
'use strict';

// ── Result helpers ─────────────────────────────────────────────────────────────
function pass(id, label, detail = '') { return { id, label, status: 'pass', detail }; }
function warn(id, label, detail = '') { return { id, label, status: 'warn', detail }; }
function fail(id, label, detail = '') { return { id, label, status: 'fail', detail }; }
function skip(id, label, detail = '') { return { id, label, status: 'skip', detail }; }

// ── IMF UG Check 1: Timecode ──────────────────────────────────────────────────
// SMPTE ST 2067-2: CPLs should contain a TimecodeTrack with a proper Timecode
// resource and the FrameRate should match the EditRate.
export function checkTimecode(cpl) {
  if (!cpl) return skip('TC', 'Timecode Track', 'No CPL loaded');

  const tc = cpl.compositionTimecode || null;
  const hasTimecodeTrack = !!tc;
  const editRate  = cpl.editRate || cpl.compositionEditRate;
  const frameRate = tc?.rate;

  const issues = [];

  if (!hasTimecodeTrack) {
    issues.push('No TimecodeTrack found in CPL — required by SMPTE ST 2067-2 §9');
  }

  // Tolerant compare: EditRate is the exact fraction (e.g. 24000/1001 = 23.976…)
  // while FrameRate/TimecodeRate is the integer nominal (24). They "match" for
  // all common fractional delivery rates, so compare numerically with tolerance
  // rather than by string (which spuriously WARNed on every 23.976/29.97 package).
  const _er = Number(editRate), _fr = Number(frameRate);
  if (Number.isFinite(_er) && Number.isFinite(_fr) && Math.abs(_er - _fr) > 0.5) {
    issues.push(`EditRate (${editRate}) ≠ FrameRate (${frameRate}) — must match per IMF UG Timecode BP`);
  }

  if (tc?.dropFrame === true) {
    issues.push('Drop-Frame timecode detected — IMF UG recommends Non-Drop-Frame for content above 30fps');
  }

  if (tc?.startAddress) {
    const tcStr = String(tc.startAddress);
    const isAligned = tcStr === '00:00:00:00' || tcStr.startsWith('01:00:00');
    if (!isAligned) {
      issues.push(`Start timecode "${tcStr}" — IMF UG recommends 00:00:00:00 or 01:00:00:00`);
    }
  }

  if (issues.length === 0) {
    return pass('TC', 'Timecode Track', `TimecodeTrack present, EditRate ${editRate || '—'} fps`);
  }
  const sev = issues.some(m => m.includes('No TimecodeTrack')) ? fail : warn;
  return sev('TC', 'Timecode Track', issues.join(' · '));
}

// ── IMF UG Check 2: IMSC Subtitle ─────────────────────────────────────────────
// SMPTE ST 2067-2: Subtitle track files must use IMSC namespace (not TTML 1.0).
// IMF UG best practice: declare xml:id on every span, use tts:extent on region.
export function checkImscSubtitles(cpl) {
  if (!cpl) return skip('IMSC', 'IMSC Subtitle Track', 'No CPL loaded');

  const subs = cpl.subtitleResources || cpl.timedTextResources || [];
  if (subs.length === 0) {
    return pass('IMSC', 'IMSC Subtitle Track', 'No subtitle tracks (N/A)');
  }

  const issues = [];
  let imscCount = 0;
  let nonImscCount = 0;

  for (const r of subs) {
    const ns = r.namespace || r.imscNamespace || '';
    const isImsc = ns.includes('imsc') || ns.includes('ttml#parameter');
    if (isImsc) {
      imscCount++;
    } else {
      nonImscCount++;
      issues.push(`Track "${r.id || r.trackFileId || '?'}" namespace "${ns || 'unknown'}" is not IMSC`);
    }

    if (r.lang && !/^[a-z]{2,3}(-[A-Z]{2,3})?(-[A-Za-z0-9]+)*$/.test(r.lang)) {
      issues.push(`Track "${r.id || '?'}" xml:lang "${r.lang}" does not follow BCP-47`);
    }
  }

  if (issues.length === 0) {
    return pass('IMSC', 'IMSC Subtitle Track', `${imscCount} subtitle track${imscCount !== 1 ? 's' : ''}, IMSC compliant`);
  }
  return warn('IMSC', 'IMSC Subtitle Track', issues.join(' · '));
}

// ── IMF UG Check 3: Audio MCA Labels ─────────────────────────────────────────
// SMPTE ST 377-4: MXF audio track files must carry MCA soundfield group labels.
// IMF UG best practice: each audio track file should have SoundFieldGroupLinkID
// and AudioChannelLabelSubDescriptor for every channel.
export function checkMcaLabels(cpl, mcaData) {
  if (!cpl) return skip('MCA', 'Audio MCA Labels', 'No CPL loaded');

  const audioTracks = cpl.audioResources || cpl.audioTrackFiles || [];
  if (audioTracks.length === 0) {
    return pass('MCA', 'Audio MCA Labels', 'No audio tracks (N/A)');
  }

  // mcaData is optional — if unavailable, we do a structural check only
  if (!mcaData || Object.keys(mcaData).length === 0) {
    return warn('MCA', 'Audio MCA Labels', `${audioTracks.length} audio track file(s) — MXF MCA label data not yet extracted. Run Labels tab for full check.`);
  }

  const issues = [];
  let checkedCount = 0;

  for (const track of audioTracks) {
    const id = track.trackFileId || track.id || '';
    const meta = mcaData[id] || mcaData[id.toLowerCase()] || null;
    if (!meta) continue;
    checkedCount++;

    if (!meta.hasMcaLabels && !meta.soundfieldGroupId) {
      issues.push(`Track "${id.slice(0, 8)}…" missing MCA SoundFieldGroup labels`);
    }
    if (meta.channelCount > 0 && (!meta.mcaChannelLabels || meta.mcaChannelLabels.length < meta.channelCount)) {
      issues.push(`Track "${id.slice(0, 8)}…" has ${meta.channelCount} channels but only ${meta.mcaChannelLabels?.length || 0} MCA channel labels`);
    }
  }

  if (checkedCount === 0) {
    return warn('MCA', 'Audio MCA Labels', `${audioTracks.length} audio track file(s) — no MXF metadata available yet`);
  }

  if (issues.length === 0) {
    return pass('MCA', 'Audio MCA Labels', `${checkedCount} audio track file(s) have MCA labels`);
  }
  return fail('MCA', 'Audio MCA Labels', issues.join(' · '));
}

// ── IMF UG Check 4: CPL Constraints (App #2E / Generic IMF) ──────────────────
// SMPTE ST 2067-21: App #2E defines constraints on CPL structure.
// IMF UG best practice: ContentVersionList, ApplicationIdentification, etc.
export function checkCplConstraints(cpl) {
  if (!cpl) return skip('CPL', 'CPL Constraints (App #2E)', 'No CPL loaded');

  const issues = [];

  // ContentVersionList: required by SMPTE ST 2067-3
  if (!cpl.contentVersions?.length) {
    issues.push('ContentVersionList missing — required by SMPTE ST 2067-3 §8.6');
  }

  // ApplicationIdentification: should reference an IMF Application
  const appId = cpl.appVersion || '';
  if (!appId || appId === '–') {
    issues.push('ApplicationIdentification missing — required by SMPTE ST 2067-21 for App #2E compliance');
  }

  // EditRate sanity: must be a recognized frame rate
  const er = cpl.editRate;
  const validRates = [24, 25, 30, 48, 50, 60, 23.976, 29.97, 47.952, 59.94, 96, 120];
  if (er && !validRates.some(r => Math.abs(er - r) < 0.01)) {
    issues.push(`EditRate ${er} fps — not a recognized IMF frame rate`);
  }

  // Duration check: totalFrames must be positive
  if (!cpl.totalFrames || cpl.totalFrames <= 0) {
    issues.push('CPL totalFrames is zero or missing');
  }

  // EssenceDescriptor reference check (structural)
  const hasEssenceDescList = Array.isArray(cpl.descriptors) && cpl.descriptors.length > 0;
  if (!hasEssenceDescList) {
    issues.push('EssenceDescriptorList missing — required by SMPTE ST 2067-3 for App #2E');
  }

  if (issues.length === 0) {
    return pass('CPL', 'CPL Constraints (App #2E)', `EditRate ${er} fps, ContentVersion present, ApplicationIdentification present`);
  }
  const hasFails = issues.some(m => m.includes('required'));
  return hasFails
    ? fail('CPL', 'CPL Constraints (App #2E)', issues.join(' · '))
    : warn('CPL', 'CPL Constraints (App #2E)', issues.join(' · '));
}

// ── IMF UG Check 5: Packaging & Delivery Naming ───────────────────────────────
// IMF UG Packaging Glossary + Delivery Naming Conventions:
// - ASSETMAP.xml (exact name, not ASSETMAP or AssetMap.xml)
// - PKL_<UUID>.xml naming
// - CPL_<UUID>.xml naming
// - No spaces in filenames
// - Supplemental IMP folder should reference base IMP via Packing List
export function checkPackagingNaming(assetMap, fileMap, folderName) {
  if (!assetMap) return skip('PKG', 'Packaging & Delivery Naming', 'No AssetMap loaded');

  const issues = [];
  const allFiles = fileMap ? Object.keys(fileMap) : [];

  // ASSETMAP filename check
  const assetMapFile = allFiles.find(f => f.toUpperCase().includes('ASSETMAP'));
  if (assetMapFile) {
    if (assetMapFile !== 'ASSETMAP.xml') {
      issues.push(`AssetMap filename "${assetMapFile}" — IMF UG requires exact name "ASSETMAP.xml"`);
    }
  }

  // No spaces in any filenames
  const spacedFiles = allFiles.filter(f => f.includes(' '));
  if (spacedFiles.length > 0) {
    issues.push(`${spacedFiles.length} file(s) have spaces in name — not allowed: ${spacedFiles.slice(0, 2).join(', ')}${spacedFiles.length > 2 ? '…' : ''}`);
  }

  // PKL naming: should be PKL_<UUID>.xml
  const pklFiles = allFiles.filter(f => f.match(/\.xml$/i) && (f.startsWith('PKL_') || f.toLowerCase().includes('pkl')));
  for (const pkl of pklFiles) {
    if (!pkl.match(/^PKL_[0-9a-f-]{36}\.xml$/i)) {
      issues.push(`PKL "${pkl}" — IMF UG recommends PKL_<UUID>.xml naming`);
    }
  }

  // CPL naming: should be CPL_<UUID>.xml
  const cplFiles = allFiles.filter(f => f.match(/\.xml$/i) && (f.startsWith('CPL_') || f.toLowerCase().includes('cpl')));
  for (const cpl of cplFiles) {
    if (!cpl.match(/^CPL_[0-9a-f-]{36}\.xml$/i)) {
      issues.push(`CPL "${cpl}" — IMF UG recommends CPL_<UUID>.xml naming`);
    }
  }

  // Folder naming: should not contain spaces
  if (folderName && folderName.includes(' ')) {
    issues.push(`Package folder "${folderName}" has spaces — IMF UG recommends no spaces in delivery paths`);
  }

  // MXF files should follow UUID naming
  const mxfFiles = allFiles.filter(f => f.match(/\.mxf$/i));
  const nonUuidMxf = mxfFiles.filter(f => !f.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i));
  if (nonUuidMxf.length > 0) {
    issues.push(`${nonUuidMxf.length} MXF file(s) do not use UUID naming (e.g. "${nonUuidMxf[0]}")`);
  }

  if (issues.length === 0) {
    return pass('PKG', 'Packaging & Delivery Naming', `${allFiles.length} file(s) — naming conventions compliant`);
  }
  const hasFails = issues.some(m => m.includes('requires exact') || m.includes('have spaces'));
  return hasFails
    ? fail('PKG', 'Packaging & Delivery Naming', issues.join(' · '))
    : warn('PKG', 'Packaging & Delivery Naming', issues.join(' · '));
}

// ── Run all checks and return results array ───────────────────────────────────
export function runAllUgChecks({ cpl, assetMap, fileMap, folderName, mcaData } = {}) {
  return [
    checkTimecode(cpl),
    checkImscSubtitles(cpl),
    checkMcaLabels(cpl, mcaData),
    checkCplConstraints(cpl),
    checkPackagingNaming(assetMap, fileMap, folderName),
  ];
}
