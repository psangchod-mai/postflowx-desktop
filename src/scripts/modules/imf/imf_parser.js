// scripts/modules/imf/imf_parser.js
// Parse IMF package XML files: ASSETMAP, PKL, CPL
// Pure browser JS — no dependencies. Uses DOMParser.
// Namespace-agnostic: uses localName matching so all SMPTE IMF namespace variants work.
'use strict';

import { classifyJ2KDescriptor } from './j2kCodestream.js';

// ── SMPTE UL → human-readable label maps ──────────────────────────────────────
const UL_TRANSFER = {
  '060e2b34.0401010d.04010101.01010000': 'Gamma 2.2',
  '060e2b34.0401010d.04010101.01020000': 'Gamma 2.8',
  '060e2b34.0401010d.04010101.01050000': 'Rec.709',
  '060e2b34.0401010d.04010101.010a0000': 'PQ / ST 2084 (HDR)',
  '060e2b34.0401010d.04010101.010e0000': 'HLG',
  '060e2b34.0401010d.04010101.010f0000': 'S-Log3',
};
const UL_PRIMARIES = {
  '060e2b34.0401010d.04010101.03010000': 'BT.709',
  '060e2b34.0401010d.04010101.03030000': 'P3-D60',
  '060e2b34.0401010d.04010101.03040000': 'P3-DCI',
  '060e2b34.0401010d.04010101.03060000': 'P3-D65',
  '060e2b34.0401010d.04010101.03090000': 'BT.2020',
};

function ulLabel(map, urn) {
  if (!urn) return '–';
  const key = urn.replace('urn:smpte:ul:', '').toLowerCase();
  if (map[key]) return map[key];
  // Fallback: last dotted segment
  const last = urn.split('.').pop() || urn.split(':').pop();
  return last.replace(/0+$/, '').toUpperCase() || urn;
}

function parseXML(text) {
  return new DOMParser().parseFromString(text, 'application/xml');
}

// ── Namespace-agnostic DOM helpers ────────────────────────────────────────────
// Returns all descendants whose localName matches (case-insensitive option too)
function findAll(root, localName) {
  const out = [];
  for (const el of root.getElementsByTagName('*')) {
    if (el.localName === localName) out.push(el);
  }
  return out;
}

function findFirst(root, localName) {
  for (const el of root.getElementsByTagName('*')) {
    if (el.localName === localName) return el;
  }
  return null;
}

function childText(el, localName) {
  if (!el) return '';
  for (const child of el.children) {
    if (child.localName === localName) return child.textContent.trim();
  }
  return '';
}

function deepText(root, localName) {
  const el = findFirst(root, localName);
  return el ? el.textContent.trim() : '';
}

// ── ASSETMAP parser ───────────────────────────────────────────────────────────
export function parseAssetMap(xmlText) {
  const doc = parseXML(xmlText);
  const assets = {};

  for (const asset of findAll(doc, 'Asset')) {
    const id    = deepText(asset, 'Id').replace('urn:uuid:', '');
    const path  = deepText(asset, 'Path') || deepText(asset, 'ChunkPath');
    const isPKL = !!findFirst(asset, 'PackingList');
    if (id) assets[id] = { id, path, isPKL };
  }

  return {
    id:          deepText(doc, 'Id').replace('urn:uuid:', ''),
    annotation:  deepText(doc, 'AnnotationText') || deepText(doc, 'Annotation'),
    issuer:      deepText(doc, 'Issuer'),
    creator:     deepText(doc, 'Creator'),
    issueDate:   deepText(doc, 'IssueDate'),
    volumeCount: parseInt(deepText(doc, 'VolumeCount') || '1', 10),
    assets,
  };
}

// ── PKL parser ────────────────────────────────────────────────────────────────
export function parsePKL(xmlText) {
  const doc = parseXML(xmlText);
  const assets = {};

  for (const asset of findAll(doc, 'Asset')) {
    const id   = deepText(asset, 'Id').replace('urn:uuid:', '');
    const size = parseInt(deepText(asset, 'Size') || '0', 10);
    const hash = deepText(asset, 'Hash').replace(/\s+/g, '');
    const type = deepText(asset, 'Type');
    const file = deepText(asset, 'OriginalFileName') ||
                 deepText(asset, 'AnnotationText')   || '';
    if (id) assets[id] = { id, size, hash, type, file };
  }

  return {
    id:         deepText(doc, 'Id').replace('urn:uuid:', ''),
    annotation: deepText(doc, 'AnnotationText'),
    issueDate:  deepText(doc, 'IssueDate'),
    creator:    deepText(doc, 'Creator'),
    assets,
  };
}

// ── CPL parser ────────────────────────────────────────────────────────────────
export function parseCPL(xmlText) {
  const doc = parseXML(xmlText);

  // Edit rate (top-level)
  const erText   = deepText(doc, 'EditRate') || '24 1';
  const [ern, erd = '1'] = erText.trim().split(/\s+/);
  const editRate = Number(erd) > 0 ? Number(ern) / Number(erd) : 24;

  // ── Essence descriptors ──────────────────────────────────────────────────
  const descriptors = [];
  for (const ed of findAll(doc, 'EssenceDescriptor')) {
    const id    = deepText(ed, 'Id').replace('urn:uuid:', '');
    const w     = deepText(ed, 'StoredWidth')  || deepText(ed, 'SampledWidth')  || '–';
    const h     = deepText(ed, 'StoredHeight') || deepText(ed, 'SampledHeight') || '–';
    const tc    = ulLabel(UL_TRANSFER,  deepText(ed, 'TransferCharacteristic'));
    const cp    = ulLabel(UL_PRIMARIES, deepText(ed, 'ColorPrimaries'));
    // Bit depth: prefer ComponentDepth (CDCI), then first numeric ComponentDepth
    // inside PixelLayout RGBAComponents (RGBA/HTJ2K descriptors)
    let depth = deepText(ed, 'ComponentDepth');
    if (!depth || isNaN(Number(depth))) {
      // RGBA: find highest component depth among R/G/B channels
      let maxDepth = 0;
      for (const comp of findAll(ed, 'RGBAComponent')) {
        const d = parseInt(deepText(comp, 'ComponentDepth') || '0', 10);
        if (d > maxDepth) maxDepth = d;
      }
      depth = maxDepth > 0 ? String(maxDepth) : (deepText(ed, 'J2KComponentSizing') || '–');
    }

    // Immersive audio detection.
    //  • IAB  — SMPTE ST 2067-201 (Dolby Atmos in IMF, the common carriage)
    //  • MGA  — SMPTE ST 2127 Multichannel Generic Audio (newer Atmos carriage
    //           Resolve also treats as immersive). Without this, an MGA Atmos
    //           track imported as plain PCM instead of an immersive track.
    const isIAB   = !!findFirst(ed, 'IABEssenceDescriptor') ||
                    !!findFirst(ed, 'IABSoundfieldLabelSubDescriptor');
    const isMGA   = !!findFirst(ed, 'MGASoundEssenceDescriptor') ||
                    !!findFirst(ed, 'MGAAudioMetadataSubDescriptor') ||
                    !!findFirst(ed, 'MGASoundfieldGroupLabelSubDescriptor');
    const isImmersive = isIAB || isMGA;
    const channelCount = isImmersive ? 0 : (parseInt(deepText(ed, 'ChannelCount') || deepText(ed, 'Channels') || '0', 10) || 0);
    const isRGBA  = !!findFirst(ed, 'RGBADescriptor');
    const isCDCI  = !!findFirst(ed, 'CDCIDescriptor');
    // JPEG 2000, and separately whether it is Part 15 (HTJ2K). Both answers come
    // from j2kCodestream.js, which also owns the codestream-byte answer, so the
    // declaration and the truth cannot drift apart the way they had:
    // `isHTJ2K` was `isJ2K || …`, so every classic Part 1 package read as HTJ2K
    // and three downstream branches written for plain J2K were unreachable.
    //
    // ContainerConstraintsSubDescriptor is gone from the J2K test. It is ST
    // 379-2 generic-container constraints, carried by sound essence too, so it
    // made audio descriptors read as JPEG 2000 pictures.
    const pecUL   = deepText(ed, 'PictureEssenceCoding');
    const j2kClass = classifyJ2KDescriptor({
      hasJ2KSubDescriptor:     !!findFirst(ed, 'JPEG2000SubDescriptor') || !!findFirst(ed, 'J2CLayout'),
      hasExtendedCapabilities: !!findFirst(ed, 'J2KExtendedCapabilities'),
      pecUL,
    });
    const isJ2K      = j2kClass.isJ2K;
    const isHTJ2K    = j2kClass.isHTJ2K;
    const htEvidence = j2kClass.htEvidence;
    // isJ2K, not isHTJ2K. The old `isJ2K ||` above made the HT flag load-bearing
    // for picture detection, so narrowing HT without this line would have
    // dropped a J2K descriptor whose StoredWidth did not parse out of the
    // running for primary picture descriptor.
    const isPicture = isRGBA || isCDCI || isJ2K || (!isImmersive && (w !== '–'));

    // Dolby Vision sub-descriptor
    const isDVision = !!findFirst(ed, 'DolbyVisionFrameInfo') ||
                      !!findFirst(ed, 'DolbyVisionSubDescriptor');

    // Dolby Vision profile & level (from DolbyVisionSubDescriptor or FrameInfo)
    const dvNode = findFirst(ed, 'DolbyVisionSubDescriptor') || findFirst(ed, 'DolbyVisionFrameInfo');
    const dvProfile = dvNode ? (deepText(dvNode, 'DVProfile') || deepText(dvNode, 'Profile') || '') : '';
    const dvLevel   = dvNode ? (deepText(dvNode, 'DVLevel')   || deepText(dvNode, 'Level')   || '') : '';
    // Trim passes: listed as DolbyVisionTrimPass elements inside the sub-descriptor
    const dvTrimPasses = dvNode ? findAll(dvNode, 'DolbyVisionTrimPass').length : 0;

    // Frame layout / scan type
    const frameLayout = deepText(ed, 'FrameLayout') || '';
    const isInterlaced = frameLayout.toLowerCase().includes('separ') ||
                         frameLayout.toLowerCase().includes('interlace');

    // Mastering display metadata (from MasteringDisplayColorVolume sub-descriptor or inline)
    const masteringMaxLum = parseFloat(
      deepText(ed, 'MasteringDisplayMaximumLuminance') ||
      deepText(ed, 'MaxMasteringLuminance') || '') || null;
    const masteringMinLum = parseFloat(
      deepText(ed, 'MasteringDisplayMinimumLuminance') ||
      deepText(ed, 'MinMasteringLuminance') || '') || null;
    const maxCLL  = parseInt(deepText(ed, 'MaxContentLightLevel')      || deepText(ed, 'MaxCLL')  || '', 10) || null;
    const maxFALL = parseInt(deepText(ed, 'MaxFrameAverageLightLevel') || deepText(ed, 'MaxFALL') || '', 10) || null;
    const hasMasteringDisplay = masteringMaxLum != null || masteringMinLum != null;

    // Audio descriptor fields
    const audioSampleRate = parseFloat(
      deepText(ed, 'AudioSamplingRate') || deepText(ed, 'SamplingRate') || '') || null;
    const audioQuantBits  = parseInt(
      deepText(ed, 'QuantizationBits') || deepText(ed, 'AudioBitDepth') || '', 10) || null;

    descriptors.push({
      id, w, h, tc, cp, depth,
      isIAB, isMGA, isImmersive, isRGBA, isCDCI, isJ2K, isHTJ2K, htEvidence, isDVision, isPicture,
      dvProfile, dvLevel, dvTrimPasses, channelCount,
      frameLayout: isInterlaced ? 'Interlaced' : 'Progressive',
      pecUL,
      masteringMaxLum, masteringMinLum, maxCLL, maxFALL, hasMasteringDisplay,
      audioSampleRate, audioQuantBits,
    });
  }

  // ── Segments & resources ─────────────────────────────────────────────────
  const segments = [];
  let totalFrames = 0;

  for (const seg of findAll(doc, 'Segment')) {
    const resources = [];
    const sequences = [];

    // Sequences may live directly under Segment OR under a SequenceList container.
    // Handle both: flatten into one list of sequence elements.
    const seqContainer = findFirst(seg, 'SequenceList') || seg;
    const seqElems = Array.from(seqContainer.children);

    for (const seq of seqElems) {
      const seqType = seq.localName; // MainImageSequence, MainAudioSequence, IABSequence, etc.
      if (!seqType || seqType === 'Id' || seqType === 'TrackId') continue;

      const seqId = childText(seq, 'Id').replace('urn:uuid:', '') || '';
      const trackId = childText(seq, 'TrackId') || '';
      const seqResources = [];

      // Resources live under a ResourceList child, or directly as children
      const resList = findFirst(seq, 'ResourceList') || seq;

      for (const res of resList.children) {
        if (res.localName !== 'Resource' && res.localName !== 'TrackFileResource') continue;

        const erR   = deepText(res, 'EditRate') || erText;
        const [rn, rd = '1'] = erR.trim().split(/\s+/);
        const resRate = Number(rd) > 0 ? Number(rn) / Number(rd) : editRate;

        const intrinsic = parseInt(deepText(res, 'IntrinsicDuration') || '0', 10);
        const entry     = parseInt(deepText(res, 'EntryPoint')         || '0', 10);
        const srcDur    = parseInt(deepText(res, 'SourceDuration')     || String(intrinsic), 10);
        const repeat    = parseInt(deepText(res, 'RepeatCount')        || '1', 10) || 1;
        const fileId    = deepText(res, 'TrackFileId').replace('urn:uuid:', '');
        const essDescId = (deepText(res, 'EssenceDescriptorId') ||
                           deepText(res, 'SourceEncoding') || '').replace('urn:uuid:', '');

        const parsedRes = {
          seqType,
          seqId,
          trackId,
          editRate: resRate,
          intrinsicDuration: intrinsic,
          entryPoint: entry,
          sourceDuration: srcDur || intrinsic,
          repeatCount: repeat,
          trackFileId: fileId,
          essenceDescriptorId: essDescId,
        };

        resources.push(parsedRes);
        seqResources.push(parsedRes);

        if (seqType === 'MainImageSequence' || seqType.includes('Image')) {
          totalFrames += (srcDur || intrinsic) * repeat;
        }
      }

      if (seqResources.length) {
        sequences.push({ seqType, seqId, trackId, resources: seqResources });
      }
    }
    if (resources.length) segments.push({ resources, sequences });
  }

  // Primary picture descriptor
  const picDesc = descriptors.find(d => d.isPicture) || descriptors[0] || {};
  // Immersive descriptors (IAB or MGA) all flow through the IAB/immersive path.
  const iabDesc = descriptors.find(d => d.isImmersive);
  const iabDescriptorIds = new Set(descriptors.filter(d => d.isImmersive).map(d => d.id));

  // Codec label
  let codec = '–';
  if (picDesc.isHTJ2K) codec = 'HTJ2K (JPEG 2000 Part 15)';
  else if (picDesc.isJ2K) codec = 'JPEG 2000';
  else if (picDesc.isRGBA) codec = 'RGBA (Uncompressed)';
  else if (picDesc.isCDCI) codec = 'CDCI';

  // App version detection from namespace URIs or ApplicationIdentification element
  let appVersion = '–';
  const rootEl  = doc.documentElement;
  const allNS   = Array.from(rootEl.attributes).map(a => a.value).join(' ').toLowerCase();
  const appId   = deepText(doc, 'ApplicationIdentification').toLowerCase();
  const combined = allNS + ' ' + appId;
  // Match the part number exactly: "2067-21" NOT followed by another digit, so
  // the App#2E part (2067-21) is not confused with IAB (2067-201) and a malformed
  // namespace lacking the "/YEAR" suffix is still classified (avoids a false-PASS
  // where App#2E-specific checks would be silently skipped).
  if (/2067-21(?!\d)/.test(combined) || combined.includes('app#2e'))
    appVersion = 'App#2E (Netflix HDR)';
  else if (/2067-20(?!\d)/.test(combined) || combined.includes('app#2'))
    appVersion = 'App#2';
  else if (/2067-50(?!\d)/.test(combined) || combined.includes('app#5'))
    appVersion = 'App#5 (ACES)';
  else if (/2067-40(?!\d)/.test(combined) || combined.includes('app#4'))
    appVersion = 'App#4 (Cinema Mezzanine)';
  else if (combined.includes('2067'))
    appVersion = 'SMPTE ST 2067';

  const allAudioResources = segments.flatMap(s =>
    s.resources.filter(r =>
      r.seqType !== 'MainImageSequence' && !r.seqType.includes('Image')
    )
  );
  const isIabResource = (res) =>
    !!res && (
      /iab/i.test(String(res.seqType || '')) ||
      iabDescriptorIds.has(String(res.essenceDescriptorId || ''))
    );
  const descById = Object.fromEntries(descriptors.map(d => [d.id, d]));
  const iabResources = allAudioResources.filter(isIabResource);
  const pcmAudioResources = allAudioResources
    .filter(res => !isIabResource(res))
    .map(res => ({
      ...res,
      channelCount: descById[res.essenceDescriptorId]?.channelCount || 0,
    }));
  const allAudioSequences = segments.flatMap(s =>
    (s.sequences || []).filter(seq =>
      seq.seqType !== 'MainImageSequence' && !seq.seqType.includes('Image')
    )
  );
  const iabSequences = allAudioSequences.filter(seq =>
    /iab/i.test(String(seq.seqType || '')) ||
    (seq.resources || []).some(isIabResource)
  );
  const pcmAudioSequences = allAudioSequences.filter(seq => !iabSequences.includes(seq));

  // CompositionTimecode
  const tcEl = findFirst(doc, 'CompositionTimecode');
  const compositionTimecode = tcEl ? {
    startAddress: deepText(tcEl, 'TimecodeStartAddress') || deepText(tcEl, 'StartTimecode') || '',
    rate:         parseInt(deepText(tcEl, 'TimecodeRate') || '0', 10),
    dropFrame:    (() => { const df = (deepText(tcEl, 'TimecodeDropFrame') || deepText(tcEl, 'DropFrame') || '').trim().toLowerCase(); return df === 'true' || df === '1'; })(),
  } : null;

  // ContentVersionList
  const contentVersions = findAll(doc, 'ContentVersion').map(cv => ({
    id:    deepText(cv, 'Id'),
    label: deepText(cv, 'LabelText') || deepText(cv, 'Label') || '',
  })).filter(cv => cv.id);

  // ScreenAspectRatio
  const sarText = deepText(doc, 'ScreenAspectRatio');
  let screenAspectRatio = null;
  if (sarText) {
    const parts = sarText.trim().split(/[\s\/]+/);
    const n = Number(parts[0]); const d = Number(parts[1] || '1');
    if (n > 0 && d > 0) screenAspectRatio = { text: sarText.trim(), value: n / d };
  }

  // Markers (FFOC / LFOC / FFEC / LFEC / FFMC / LFMC etc.)
  const markers = findAll(doc, 'Marker').map(m => ({
    label:      deepText(m, 'Label') || deepText(m, 'MarkerLabel') || '',
    offset:     parseInt(deepText(m, 'Offset') || deepText(m, 'MarkerOffset') || '0', 10),
    annotation: deepText(m, 'AnnotationText') || '',
  })).filter(m => m.label);

  // Locales
  const locales = findAll(doc, 'Locale').map(loc => ({
    language: deepText(loc, 'Language') || '',
    region:   deepText(loc, 'Region') || '',
    rating:   deepText(loc, 'ContentMaturityRating') || '',
  })).filter(loc => loc.language || loc.region);

  return {
    id:           deepText(doc, 'Id').replace('urn:uuid:', ''),
    annotation:   deepText(doc, 'AnnotationText') || deepText(doc, 'Annotation'),
    contentTitle: deepText(doc, 'ContentTitle') || deepText(doc, 'FullContentTitleText'),
    contentKind:  deepText(doc, 'ContentKind'),
    issueDate:    deepText(doc, 'IssueDate'),
    issuer:       deepText(doc, 'Issuer'),
    creator:      deepText(doc, 'Creator'),
    compositionTimecode,
    contentVersions,
    screenAspectRatio,
    markers,
    locales,
    editRate,
    totalFrames,
    durationSec:  totalFrames / (editRate || 24),
    resolution:   { w: picDesc.w || '–', h: picDesc.h || '–' },
    transfer:     picDesc.tc || '–',
    primaries:    picDesc.cp || '–',
    bitDepth:     picDesc.depth || '–',
    codec,
    // Exposed so the validator and UI can read the classification instead of
    // substring-matching `codec`, which is a display string: re-wording the
    // label used to change validation severity.
    isJ2K:        !!picDesc.isJ2K,
    isHTJ2K:      !!picDesc.isHTJ2K,
    htEvidence:   picDesc.htEvidence || null,
    appVersion,
    isDolbyVision: descriptors.some(d => d.isDVision),
    hasIAB:       !!iabDesc || descriptors.some(d => d.isImmersive),
    hasMGA:       descriptors.some(d => d.isMGA),
    // DV metadata — pulled from the primary DV-bearing descriptor
    dvProfile:    descriptors.find(d => d.isDVision)?.dvProfile || '',
    dvLevel:      descriptors.find(d => d.isDVision)?.dvLevel   || '',
    dvTrimPasses: descriptors.reduce((n, d) => n + (d.dvTrimPasses || 0), 0),
    descriptors,
    // The primary picture descriptor, resolved once above. It was computed and
    // then dropped: five call sites already read `cpl.picDesc?.…` — the status
    // bar's decoder line, the engine's HTJ2K status suffix and its limitations
    // list, and two backfills for a missing bitDepth/resolution — and every one
    // of them had been reading undefined since the field was first referenced.
    //
    // Exporting it had to wait for the classification fix above. Before that,
    // `isHTJ2K` was true for every classic package, so handing picDesc to those
    // consumers would have spread the wrong label to five new places at once
    // instead of leaving it in one.
    picDesc,
    segments,
    videoResources: segments.flatMap(s =>
      s.resources.filter(r =>
        r.seqType === 'MainImageSequence' || r.seqType.includes('Image')
      )
    ),
    audioResources: allAudioResources,
    iabResources,
    pcmAudioResources,
    videoSequences: segments.flatMap(s =>
      (s.sequences || []).filter(seq =>
        seq.seqType === 'MainImageSequence' || seq.seqType.includes('Image')
      )
    ),
    audioSequences: allAudioSequences,
    iabSequences,
    pcmAudioSequences,
    // DV resources = video resources where the essence descriptor has DV sub-descriptor
    // Resolved at render time using descriptors[] map by essenceDescriptorId.
    dvDescriptorIds: new Set(descriptors.filter(d => d.isDVision).map(d => d.id)),
    get audioTracks() {
      const seen = new Set();
      const tracks = [];
      for (const res of pcmAudioResources) {
        const tid = res.trackFileId || '';
        if (seen.has(tid)) continue;
        seen.add(tid);
        tracks.push({ trackFileId: tid, channelCount: res.channelCount || 0, isIAB: false, seqType: res.seqType || '' });
      }
      for (const res of iabResources) {
        const tid = res.trackFileId || '';
        if (seen.has(tid)) continue;
        seen.add(tid);
        const d = descById[res.essenceDescriptorId];
        const immersiveFormat = d?.isMGA ? 'MGA' : 'IAB'; // ST 2127 vs ST 2067-201
        tracks.push({ trackFileId: tid, channelCount: 0, isIAB: true, immersiveFormat, seqType: res.seqType || '' });
      }
      return tracks;
    },
    get audioLayout() {
      const tracks = this.audioTracks;
      const has51  = tracks.some(t => !t.isIAB && t.channelCount === 6);
      const has20  = tracks.some(t => !t.isIAB && t.channelCount === 2);
      const immTrack = tracks.find(t => t.isIAB);
      const hasIAB = !!immTrack;
      const im = immTrack?.immersiveFormat || 'IAB'; // 'IAB' or 'MGA'
      if (hasIAB && has51 && has20) return `${im}+5.1+2.0`;
      if (hasIAB && has51)           return `${im}+5.1`;
      if (hasIAB && has20)           return `${im}+2.0`;
      if (hasIAB)                    return im;
      if (has51 && has20)            return '5.1+2.0';
      if (has51)                     return '5.1';
      if (has20)                     return '2.0';
      if (tracks.length) {
        const cc = tracks[0].channelCount;
        return cc ? `${cc}ch` : 'PCM';
      }
      return 'none';
    },
  };
}

// ── Duration formatter ────────────────────────────────────────────────────────
export function fmtDuration(sec) {
  if (!isFinite(sec) || sec < 0) return '–';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}

export function fmtFrames(frames, fps) {
  if (!frames || !fps) return '–';
  return `${frames.toLocaleString()} fr  (${fmtDuration(frames / fps)})`;
}
