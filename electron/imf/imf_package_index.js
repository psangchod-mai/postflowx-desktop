'use strict';

/**
 * imf_package_index.js — Main-process IMF package scanner and index builder.
 *
 * Reads ASSETMAP.xml from a folder, follows PKL and CPL references,
 * and builds a complete index mapping:
 *   - UUID → absolute MXF path (assetMap)
 *   - CPL ID → parsed composition (cpls[])
 *   - Virtual composition timeline: reels[] with frame ranges
 *
 * Node.js only — uses fs + the imf_xml string extractor (no DOMParser).
 */

const fs   = require('fs');
const path = require('path');
const xml  = require('./imf_xml');

// ── ASSETMAP parser ───────────────────────────────────────────────────────────

/**
 * Parse ASSETMAP.xml.
 * Returns Map<uuid, { relPath, absPath? }>
 */
function parseAssetMap(xmlText, folderPath) {
  const assetMap = new Map();
  for (const block of xml.getAllBlocks(xmlText, 'Asset')) {
    const id   = xml.normaliseUuid(xml.getText(block, 'Id'));
    const rel  = xml.getText(block, 'Path').trim();
    if (!id || !rel) continue;
    const abs = path.resolve(folderPath, rel);
    assetMap.set(id, { relPath: rel, absPath: abs });
  }
  return assetMap;
}

// ── PKL parser ────────────────────────────────────────────────────────────────

/**
 * Parse a PKL .xml file.
 * Returns Map<uuid, { type, size, originalFileName }>
 */
function parsePKL(xmlText) {
  const pkl = new Map();
  for (const block of xml.getAllBlocks(xmlText, 'Asset')) {
    const id       = xml.normaliseUuid(xml.getText(block, 'Id'));
    const type     = xml.getText(block, 'Type').trim().toLowerCase();
    const size     = parseInt(xml.getText(block, 'Size'), 10) || 0;
    const filename = xml.getText(block, 'OriginalFileName').trim() ||
                     xml.getText(block, 'AnnotationText').trim();
    if (!id) continue;
    pkl.set(id, { type, size, originalFileName: filename });
  }
  return pkl;
}

// ── CPL parser ────────────────────────────────────────────────────────────────

/**
 * Parse an EssenceDescriptor block into a descriptor object.
 */
function _parseDescriptor(block) {
  const id = xml.normaliseUuid(xml.getText(block, 'Id'));

  // Detect essence type from SMPTE UL (PictureEssenceCoding, EssenceContainer)
  const pecUL  = (xml.deepText(block, 'PictureEssenceCoding')  ||
                  xml.deepText(block, 'EssenceContainer') || '').toLowerCase();
  const isHTJ2K = pecUL.includes('0d01010201720100') ||
                  pecUL.includes('htj2k') ||
                  !!xml.getText(block, 'HTJ2KEssenceDescriptor') ||
                  !!xml.getText(block, 'HTJ2KPictureSubDescriptor');
  const isJ2K  = !isHTJ2K && (
    pecUL.includes('0d01010201040100') ||
    pecUL.includes('0d01010201060100') ||
    pecUL.includes('j2c') ||
    !!xml.getText(block, 'JPEG2000PictureSubDescriptor') ||
    !!xml.getText(block, 'J2KPictureDescriptor'));
  const isIAB  = pecUL.includes('iab') || !!xml.getText(block, 'IABEssenceDescriptor');
  const isRGBA = !isJ2K && !isHTJ2K && !!xml.getText(block, 'RGBADescriptor');
  const isCDCI = !isJ2K && !isHTJ2K && !isRGBA && !!xml.getText(block, 'CDCIDescriptor');
  const isPicture = isJ2K || isHTJ2K || isRGBA || isCDCI;

  // Resolution
  const w = parseInt(xml.deepText(block, 'StoredWidth')  || xml.deepText(block, 'SampledWidth')  || '', 10) || 0;
  const h = parseInt(xml.deepText(block, 'StoredHeight') || xml.deepText(block, 'SampledHeight') || '', 10) || 0;

  // Color metadata
  const tc = xml.deepText(block, 'TransferCharacteristic') ||
             xml.deepText(block, 'CaptureGamma') || '';
  const cp = xml.deepText(block, 'ColorPrimaries') || '';
  const depth = parseInt(xml.deepText(block, 'ComponentDepth') || xml.deepText(block, 'BitDepth') || '', 10) || 0;

  // HDR mastering info
  const masteringMaxLum = parseFloat(
    xml.deepText(block, 'MasteringDisplayMaximumLuminance') ||
    xml.deepText(block, 'MaxMasteringLuminance') || '') || null;
  const masteringMinLum = parseFloat(
    xml.deepText(block, 'MasteringDisplayMinimumLuminance') ||
    xml.deepText(block, 'MinMasteringLuminance') || '') || null;
  const maxCLL  = parseInt(xml.deepText(block, 'MaxContentLightLevel')      || xml.deepText(block, 'MaxCLL')  || '', 10) || null;
  const maxFALL = parseInt(xml.deepText(block, 'MaxFrameAverageLightLevel') || xml.deepText(block, 'MaxFALL') || '', 10) || null;

  return { id, isJ2K, isHTJ2K, isIAB, isRGBA, isCDCI, isPicture, w, h, tc, cp, depth,
    masteringMaxLum, masteringMinLum, maxCLL, maxFALL, pecUL };
}

/**
 * Parse a CPL XML.
 * Returns:
 *   { id, editRate, totalFrames, videoResources[], segments[], descriptors[],
 *     resolution, codec, transfer, primaries, isSupplemental, sourcePackageIdList }
 */
function parseCPL(xmlText, cplId) {
  const id         = xml.normaliseUuid(xml.getText(xmlText, 'Id')) || cplId;
  const erText     = xml.getText(xmlText, 'EditRate') || '24 1';
  const editRate   = xml.parseEditRate(erText);

  // Essence descriptors
  const descriptors = [];
  for (const edBlock of xml.getAllBlocks(xmlText, 'EssenceDescriptor')) {
    descriptors.push(_parseDescriptor(edBlock));
  }
  const picDesc   = descriptors.find(d => d.isPicture) || {};
  const descById  = Object.fromEntries(descriptors.map(d => [d.id, d]));

  // Codec label
  let codec = '–';
  if (picDesc.isHTJ2K)  codec = 'HTJ2K (JPEG 2000 Part 15)';
  else if (picDesc.isJ2K) codec = 'JPEG 2000';
  else if (picDesc.isRGBA) codec = 'RGBA (Uncompressed)';
  else if (picDesc.isCDCI) codec = 'CDCI';

  // Color
  const transfer  = _transferLabel(picDesc.tc || '');
  const primaries = _primariesLabel(picDesc.cp || '');
  const resolution = picDesc.w && picDesc.h ? { w: picDesc.w, h: picDesc.h } : null;

  // Supplemental CPL detection
  const isSupplemental = xmlText.includes('SupplementalMarker') ||
                         xmlText.includes('SourcePackageIdList') ||
                         xmlText.includes('CompositionMetadataList');
  const sourcePackageIdList = xml.getAllBlocks(xmlText, 'SourcePackageId')
    .map(b => xml.normaliseUuid(b.trim())).filter(Boolean);

  // Segments and resources
  const segments = [];
  const videoResources = [];
  let totalFrames = 0;

  for (const segBlock of xml.getAllBlocks(xmlText, 'Segment')) {
    const resources = [];
    const sequences = [];

    // Support both <SequenceList> container and direct children
    const seqContainer = xml.getFirstBlock(segBlock, 'SequenceList') || segBlock;

    // Sequence type names found in IMF CPLs
    const SEQ_TYPES = [
      'MainImageSequence', 'MainAudioSequence', 'SubtitlesSequence',
      'HearingImpairedCaptionsSequence', 'VisuallyImpairedTextSequence',
      'CommentarySequence', 'KaraokeSequence', 'AncillaryDataSequence',
      'IABSequence', 'TDMSequence',
    ];

    for (const seqType of SEQ_TYPES) {
      for (const seqBlock of xml.getAllBlocks(seqContainer, seqType)) {
        const seqId   = xml.normaliseUuid(xml.getText(seqBlock, 'Id'));
        const trackId = xml.getText(seqBlock, 'TrackId') || '';
        const seqResources = []; // resources belonging to THIS sequence only

        // Resources may be under <ResourceList> or direct children
        const resList = xml.getFirstBlock(seqBlock, 'ResourceList') || seqBlock;

        for (const resType of ['Resource', 'TrackFileResource']) {
          for (const resBlock of xml.getAllBlocks(resList, resType)) {
            const erR   = xml.getText(resBlock, 'EditRate') || erText;
            const resRate = xml.parseEditRate(erR) || editRate;

            const intrinsic = parseInt(xml.getText(resBlock, 'IntrinsicDuration') || '0', 10);
            const entry     = parseInt(xml.getText(resBlock, 'EntryPoint')         || '0', 10);
            const srcDur    = parseInt(xml.getText(resBlock, 'SourceDuration')     || String(intrinsic), 10) || intrinsic;
            const repeat    = parseInt(xml.getText(resBlock, 'RepeatCount')        || '1', 10) || 1;
            const fileId    = xml.normaliseUuid(xml.getText(resBlock, 'TrackFileId'));
            const essDescId = xml.normaliseUuid(
              xml.getText(resBlock, 'EssenceDescriptorId') ||
              xml.getText(resBlock, 'SourceEncoding'));

            if (!fileId) continue;

            const res = {
              seqType, seqId, trackId,
              editRate: resRate, intrinsicDuration: intrinsic,
              entryPoint: entry, sourceDuration: srcDur, repeatCount: repeat,
              trackFileId: fileId, essenceDescriptorId: essDescId,
              descriptor: descById[essDescId] || null,
            };
            resources.push(res);
            seqResources.push(res);

            if (seqType === 'MainImageSequence' || seqType.toLowerCase().includes('image')) {
              videoResources.push(res);
              totalFrames += srcDur * repeat;
            }
          }
        }
        // Use the per-sequence list — not the segment-cumulative `resources` —
        // so a later sequence (e.g. audio) doesn't inherit earlier (image)
        // resources, which produced false "multi-essence" validation errors.
        if (seqResources.length) {
          sequences.push({ seqType, seqId, trackId, resources: seqResources });
        }
      }
    }
    if (resources.length) segments.push({ resources, sequences });
  }

  return {
    id, editRate, totalFrames, videoResources, segments, descriptors,
    resolution, codec, transfer, primaries, isSupplemental, sourcePackageIdList,
    picDesc,
  };
}

// ── Transfer / primaries label helpers ───────────────────────────────────────

function _transferLabel(urn) {
  const u = urn.toLowerCase();
  if (u.includes('2084') || u.includes('pq') || u.includes('st2084')) return 'SMPTE ST 2084 (PQ)';
  if (u.includes('hlg') || u.includes('arib')) return 'HLG';
  if (u.includes('709') || u.includes('bt.709')) return 'BT.709';
  if (u.includes('p3') || u.includes('dci')) return 'Gamma 2.6';
  if (urn) return urn.split(':').pop() || urn;
  return '–';
}

function _primariesLabel(urn) {
  const u = urn.toLowerCase();
  if (u.includes('2020') || u.includes('bt.2020')) return 'BT.2020';
  if (u.includes('p3') || u.includes('dci')) return 'DCI-P3';
  if (u.includes('709') || u.includes('bt.709')) return 'BT.709';
  if (urn) return urn.split(':').pop() || urn;
  return '–';
}

// ── IMFPackageIndex class ─────────────────────────────────────────────────────

class IMFPackageIndex {
  constructor() {
    this.folderPath     = null;
    this.assetMap       = new Map();   // uuid → { relPath, absPath }
    this.pkl            = new Map();   // uuid → { type, size, originalFileName }
    this.cpls           = [];          // parsed CPL objects
    this.cplById        = new Map();   // cplId → cpl
    this.activeCpl      = null;
    this.packageHash    = null;        // SHA1-ish hash for cache keys
    this.errors         = [];
    this.assetMapPath   = null;
    this.pklPaths       = [];
    this.cplPaths       = [];
  }

  /**
   * Scan a folder: find ASSETMAP.xml, resolve PKLs and CPLs, build full index.
   * @param {string} folderPath — absolute path to the IMF package folder
   */
  scan(folderPath) {
    this.folderPath = folderPath;
    this.errors = [];

    // Find ASSETMAP
    const amPath = this._findAssetMap(folderPath);
    if (!amPath) {
      this.errors.push('ASSETMAP.xml not found in folder');
      return this;
    }
    this.assetMapPath = amPath;

    let amText;
    try { amText = fs.readFileSync(amPath, 'utf8'); }
    catch (e) { this.errors.push(`Cannot read ASSETMAP: ${e.message}`); return this; }

    this.assetMap = parseAssetMap(amText, folderPath);

    // Compute a stable package hash from ASSETMAP path + mtime
    try {
      const st = fs.statSync(amPath);
      this.packageHash = Buffer.from(amPath + st.mtimeMs).toString('base64').slice(0, 24).replace(/[+/=]/g, '_');
    } catch { this.packageHash = Date.now().toString(36); }

    // Find PKL(s) — referenced from ASSETMAP via asset type check, or by name
    this.pklPaths = this._findPKLPaths(folderPath);
    for (const pklPath of this.pklPaths) {
      try {
        const pklText = fs.readFileSync(pklPath, 'utf8');
        const entries = parsePKL(pklText);
        for (const [k, v] of entries) this.pkl.set(k, v);
      } catch (e) {
        this.errors.push(`Cannot read PKL ${path.basename(pklPath)}: ${e.message}`);
      }
    }

    // Find CPL(s) — listed in PKL as application/...cpl... type, or by name
    this.cplPaths = this._findCPLPaths(folderPath);
    for (const cplPath of this.cplPaths) {
      try {
        const cplText  = fs.readFileSync(cplPath, 'utf8');
        const cplId    = path.basename(cplPath, '.xml').toLowerCase();
        const cpl      = parseCPL(cplText, cplId);
        cpl.cplPath    = cplPath;
        this.cpls.push(cpl);
        this.cplById.set(cpl.id, cpl);
      } catch (e) {
        this.errors.push(`Cannot parse CPL ${path.basename(cplPath)}: ${e.message}`);
      }
    }

    // Select active CPL: prefer non-supplemental; prefer one with most frames
    const primaries = this.cpls.filter(c => !c.isSupplemental);
    const pool = primaries.length ? primaries : this.cpls;
    this.activeCpl = pool.sort((a, b) => b.totalFrames - a.totalFrames)[0] || null;

    return this;
  }

  /**
   * Scan from a CPL path directly (derive folder automatically).
   */
  scanFromCPL(cplPath) {
    return this.scan(path.dirname(cplPath));
  }

  /**
   * Resolve UUID → absolute MXF path.
   * Tries assetMap first, then direct folder scan.
   */
  resolveMXFPath(uuid) {
    const u = xml.normaliseUuid(uuid);
    const entry = this.assetMap.get(u);
    if (entry?.absPath && fs.existsSync(entry.absPath)) return entry.absPath;

    // Fallback: scan folder for .mxf files and match by basename substring
    const uShort = u.slice(0, 8).toLowerCase();
    const _scanDir = (dir) => {
      try {
        const files = fs.readdirSync(dir);
        // Direct match in dir
        const mxf = files.find(f => f.toLowerCase().endsWith('.mxf') && f.toLowerCase().includes(uShort));
        if (mxf) return path.join(dir, mxf);
        // One level of subdirectories (e.g. base/Meridian_tst_HD_.../VIDEO_.mxf)
        for (const f of files) {
          try {
            const sub = path.join(dir, f);
            if (fs.statSync(sub).isDirectory()) {
              const subFiles = fs.readdirSync(sub);
              const m = subFiles.find(sf => sf.toLowerCase().endsWith('.mxf') && sf.toLowerCase().includes(uShort));
              if (m) return path.join(sub, m);
            }
          } catch {}
        }
      } catch {}
      return null;
    };

    if (this.folderPath) {
      const found = _scanDir(this.folderPath);
      if (found) return found;
    }

    // Supplemental packages reference MXFs from the base package — scan sibling folders.
    // Walk up to the parent of folderPath and scan peer directories.
    if (this.folderPath) {
      try {
        const parent = path.dirname(this.folderPath);
        const peers = fs.readdirSync(parent);
        for (const peer of peers) {
          const peerPath = path.join(parent, peer);
          try {
            if (!fs.statSync(peerPath).isDirectory()) continue;
            const found = _scanDir(peerPath);
            if (found) return found;
          } catch {}
        }
      } catch {}
    }
    return null;
  }

  /**
   * Build a virtual composition reel list from the active CPL.
   * Returns array of { reelIndex, trackFileId, mxfPath, editRate,
   *   entryPoint, sourceDuration, intrinsicDuration, compStartFrame, compEndFrame,
   *   essenceType, colorMeta, descriptor }
   */
  buildReelList(cplId) {
    const cpl = cplId ? this.cplById.get(cplId) : this.activeCpl;
    if (!cpl) return [];

    const reels = [];
    let compFrame = 0;
    for (let i = 0; i < cpl.videoResources.length; i++) {
      const res = cpl.videoResources[i];
      const mxfPath = this.resolveMXFPath(res.trackFileId);

      const desc = res.descriptor || cpl.descriptors.find(d => d.id === res.essenceDescriptorId) || {};
      let essenceType = 'unknown';
      if (desc.isHTJ2K) essenceType = 'HTJ2K';
      else if (desc.isJ2K) essenceType = 'J2K';
      else if (desc.isRGBA) essenceType = 'RGBA';
      else if (desc.isCDCI) essenceType = 'CDCI';

      const colorMeta = {
        transfer: _transferLabel(desc.tc || ''),
        primaries: _primariesLabel(desc.cp || ''),
        depth: desc.depth || 0,
        masteringMaxLum: desc.masteringMaxLum,
        masteringMinLum: desc.masteringMinLum,
        maxCLL: desc.maxCLL,
        maxFALL: desc.maxFALL,
      };

      reels.push({
        reelIndex: i,
        trackFileId: res.trackFileId,
        mxfPath,
        editRate: res.editRate,
        entryPoint: res.entryPoint,
        sourceDuration: res.sourceDuration,
        intrinsicDuration: res.intrinsicDuration,
        compStartFrame: compFrame,
        compEndFrame: compFrame + res.sourceDuration * res.repeatCount - 1,
        essenceType,
        colorMeta,
        descriptor: desc,
      });
      compFrame += res.sourceDuration * res.repeatCount;
    }
    return reels;
  }

  // ── File discovery helpers ─────────────────────────────────────────────────

  _findAssetMap(folderPath) {
    // Standard name (case-insensitive scan)
    try {
      const files = fs.readdirSync(folderPath);
      // Prefer exact ASSETMAP.xml, then any file matching assetmap*.xml
      const exact = files.find(f => f.toUpperCase() === 'ASSETMAP.XML' || f.toUpperCase() === 'ASSETMAP');
      if (exact) return path.join(folderPath, exact);
      const fuzzy = files.find(f => /assetmap/i.test(f) && /\.xml$/i.test(f));
      if (fuzzy) return path.join(folderPath, fuzzy);
    } catch {}
    return null;
  }

  _findPKLPaths(folderPath) {
    try {
      const files = fs.readdirSync(folderPath);
      // PKL files match PKL_*.xml or contain 'PKL' or 'PACKING' in filename
      return files
        .filter(f => /\.(xml)$/i.test(f) &&
          (/^PKL/i.test(f) || /packing.?list/i.test(f) || /\.pkl\./i.test(f)) &&
          !/assetmap/i.test(f) && !/cpl/i.test(f))
        .map(f => path.join(folderPath, f));
    } catch { return []; }
  }

  _findCPLPaths(folderPath) {
    // Primary: use assetMap to find files that appear to be CPLs (not MXF, not PKL)
    const cplPaths = [];
    try {
      const files = fs.readdirSync(folderPath);
      for (const f of files) {
        if (!/\.xml$/i.test(f)) continue;
        if (/assetmap/i.test(f) || /^PKL/i.test(f) || /packing/i.test(f)) continue;
        const abs = path.join(folderPath, f);
        // Peek first 512 bytes to detect CompositionPlaylist
        try {
          const head = fs.readFileSync(abs, { encoding: 'utf8', flag: 'r' });
          const first = head.slice(0, 2048);
          if (first.includes('CompositionPlaylist') || first.includes('cpl') || /CPL/i.test(f)) {
            cplPaths.push(abs);
          }
        } catch {}
      }
    } catch {}
    return cplPaths;
  }

  /**
   * Serialise to a plain object for IPC transport.
   */
  toJSON() {
    const cpl = this.activeCpl;
    return {
      packageHash: this.packageHash,
      folderPath:  this.folderPath,
      errors:      this.errors,
      cpls: this.cpls.map(c => ({
        id: c.id, editRate: c.editRate, totalFrames: c.totalFrames,
        codec: c.codec, resolution: c.resolution,
        transfer: c.transfer, primaries: c.primaries,
        isSupplemental: c.isSupplemental, cplPath: c.cplPath,
        videoResourceCount: c.videoResources.length,
      })),
      activeCpl: cpl ? {
        id: cpl.id, editRate: cpl.editRate, totalFrames: cpl.totalFrames,
        codec: cpl.codec, resolution: cpl.resolution,
        transfer: cpl.transfer, primaries: cpl.primaries,
      } : null,
      reels: cpl ? this.buildReelList(cpl.id) : [],
    };
  }
}

module.exports = { IMFPackageIndex, parseAssetMap, parsePKL, parseCPL };
