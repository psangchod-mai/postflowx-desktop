/**
 * imf_dovi_extractor.js — PostFlowX Dolby Vision IMF Metadata Extractor
 *
 * Discovery pipeline (in order):
 *   1. Companion API  — getDoviMetafier (CPL XML scan → sidecar XML → binary MXF → ffprobe)
 *   2. Browser FSA    — recursive directory scan for DV XML sidecar
 *   3. Browser FSA    — embedded CM XML scan inside picture MXF files (all reels)
 *
 * Returns a structured result with status, source, per-shot data, and diagnostics.
 * Enable debug logging:  window.PFX_DEBUG_DOVI = true
 */

import { parseDoviXml, annotateShots }                             from './imf_dovi_metafier.js';
import { extractEmbeddedDoviXml }                                  from './imf_mxf.js';
import { imfGetDoviMetafier, imfExtractDoviFromMxf, imfDetectMetafier, imfReadExtractedXml } from './imf_proxy.js';

// ── Status enum ───────────────────────────────────────────────────────────────
export const DOVI_STATUS = Object.freeze({
  FOUND:               'found',            // per-shot metadata extracted
  CONFIRMED_NO_DATA:   'confirmed_no_data',// DV confirmed (MXF/CPL), no per-shot XML
  NOT_FOUND:           'not_found',        // all paths tried, no DV metadata
  EXTRACTOR_REQUIRED:  'extractor_required',// DV likely embedded, no extractor available
  EXTRACT_FAILED:      'extract_failed',   // extractor ran but failed
  PARSE_FAILED:        'parse_failed',     // XML found, DOMParser error
  SCANNING:            'scanning',
  IDLE:                'idle',
});

// ── Source enum ───────────────────────────────────────────────────────────────
export const DOVI_SOURCE = Object.freeze({
  XML_SIDECAR:       'xml_sidecar',        // standalone DV CM XML file
  EMBEDDED_MXF:      'embedded_video_mxf', // embedded in picture MXF
  CPL_DESCRIPTOR:    'cpl_descriptor',     // only CPL EssenceDescriptorList reference
  COMPANION_API:     'companion_api',      // companion handled extraction
  NONE:              'none',
});

// ── DV XML detection keywords ─────────────────────────────────────────────────
// All checked case-insensitively. Covers CM v2.0.5, CM v4.0, CM v5.0, proprietary.
const DV_XML_KEYWORDS = [
  'dolbylabsmdf',        // root element — CM v2.0.5 / v4.0
  'dolbyvisionmetadata', // alternate root
  'dolbyvision',         // general marker
  'cmversion',           // CM version attribute
  'cm_version',          // alternate attribute name
  'contentmapping',      // some CM v5.0 formats
  'targetdisplay',       // trim target
  'level1',              // L1 analysis
  'level8',              // L8 trim passes
  'l1maxpq',             // L1 PQ value
  'trimslopevalue',      // L8 trim slope
  'dolbyvisionsubdescriptor', // MXF descriptor reference
];

// Exclude these CPL/PKL file names from the XML scan
const SKIP_XML_NAMES = new Set([
  'assetmap.xml', 'assetmap',
  'packinglist.xml',
  'volindex.xml',
]);

// Exclude XML files that contain these strings (CPL/PKL content)
const SKIP_XML_CONTAINS = ['compositionplaylist', 'packinglst', 'packinglist', 'assetmap'];

// ── Debug logger ──────────────────────────────────────────────────────────────
function _log(...args) {
  if (window.PFX_DEBUG_DOVI) console.log('[PFX DoVi]', ...args);
}
function _warn(...args) {
  console.warn('[PFX DoVi]', ...args);
  if (window.PFX_DEBUG_DOVI) console.warn('[PFX DoVi]', ...args);
}

// ── Build empty result ────────────────────────────────────────────────────────
function _emptyResult(status = DOVI_STATUS.IDLE) {
  return {
    status,
    sourceType: DOVI_SOURCE.NONE,
    sourceAssetId: '',
    sourcePath: '',
    cmVersion: '',
    profile: '',
    level: '',
    detectedBy: '',
    hasLevel1: false,
    hasLevel2: false,
    hasLevel8: false,
    hasTrimPass: false,
    shots: [],         // raw annotated shots (from parseDoviXml + annotateShots)
    dvSegments: [],
    trimSegments: [],
    cutMarkers: [],
    warnings: [],
    errors: [],
    rawSummary: {},
  };
}

// ── Check whether text looks like a DV metadata document ─────────────────────
function _looksLikeDvXml(text) {
  const lower = text.toLowerCase();
  if (SKIP_XML_CONTAINS.some(s => lower.includes(s))) return false;
  return DV_XML_KEYWORDS.some(k => lower.includes(k));
}

// ── Parse DV XML text → annotated shots ──────────────────────────────────────
function _parseAndAnnotate(xmlText, sourcePath = '') {
  try {
    const { shots, version, title } = parseDoviXml(xmlText);
    if (!shots.length) return { shots: [], version, title };
    return { shots: annotateShots(shots), version, title };
  } catch (e) {
    _warn('Parse error:', e?.message || e, 'source:', sourcePath);
    return null;
  }
}

// ── Populate result from parsed shots ─────────────────────────────────────────
function _populateFromShots(result, shots, parsed, sourcePath, sourceType) {
  result.status      = DOVI_STATUS.FOUND;
  result.sourceType  = sourceType;
  result.sourcePath  = sourcePath;
  result.shots       = shots;
  result.cmVersion   = parsed?.version || '';
  result.hasLevel1   = shots.some(s => s.l1 != null);
  result.hasLevel2   = shots.some(s => Array.isArray(s.l2) ? s.l2.length > 0 : s.l2 != null);
  result.hasLevel8   = shots.some(s => (Array.isArray(s.l8) ? s.l8.length : (s.l8 ? 1 : 0)) > 0
                                      || (s.trimPasses?.length ?? 0) > 0);
  result.hasTrimPass = result.hasLevel8;
  // Build flat segment/cut arrays for timeline rendering
  result.dvSegments    = shots.map(s => ({
    id: s.uuid || `shot_${s.index}`, startFrame: s.begin, endFrame: s.end,
    hasL1: s.l1 != null, hasL2: !!s.l2, hasL8: result.hasLevel8,
    label: `Shot ${s.index + 1}`, source: sourceType,
  }));
  result.cutMarkers    = shots.filter(s => s.isCut).map(s => ({
    id: `cut_${s.index}`, frame: s.begin, label: s.uuid?.slice(0, 8) || `#${s.index + 1}`,
  }));
  result.rawSummary    = {
    shotCount: shots.length, cmVersion: result.cmVersion,
    l1Count: shots.filter(s => s.l1).length,
    l8Count: shots.filter(s => (Array.isArray(s.l8) ? s.l8.length : (s.l8 ? 1 : 0)) > 0).length,
    cutCount: result.cutMarkers.length,
  };
  _log(`Found ${shots.length} shots via ${sourceType} · L1=${result.hasLevel1} L8=${result.hasLevel8} cuts=${result.cutMarkers.length}`);
}

// ── Recursive FSA directory scan ──────────────────────────────────────────────
async function _scanDirHandle(dirHandle, depth = 0) {
  if (depth > 4) return null;
  for await (const [name, entry] of dirHandle.entries()) {
    if (entry.kind === 'directory' && !name.startsWith('.')) {
      const found = await _scanDirHandle(entry, depth + 1);
      if (found) return found;
    } else if (entry.kind === 'file' && name.toLowerCase().endsWith('.xml')
               && !SKIP_XML_NAMES.has(name.toLowerCase())) {
      try {
        const file  = await entry.getFile();
        const text  = await file.text();
        if (_looksLikeDvXml(text)) {
          _log('XML sidecar found:', name);
          return { text, name, file };
        }
      } catch {}
    }
  }
  return null;
}

// ── Main: analyze Dolby Vision from an IMF package ───────────────────────────
/**
 * @param {object} imfContext
 *   pkg                  — parsed package (cpl, descriptors, videoResources …)
 *   imfSourceBackend     — 'companion' | 'browser' | ''
 *   imfSourceFolderPath  — absolute path (companion mode)
 *   imfSourceDirHandle   — FileSystemDirectoryHandle (browser mode)
 *   imfSourcePackageId   — companion package ID
 *   currentCplKey        — selected CPL key
 *   cplEntries           — array of CPL entry objects
 *   getReelFile          — (res) => File | null  (returns file handle for reel)
 * @returns {Promise<DoviExtractResult>}
 */
export async function analyzeDolbyVisionFromImfPackage(imfContext) {
  const {
    pkg, imfSourceBackend, imfSourceFolderPath, imfSourceDirHandle,
    currentCplKey, cplEntries, getReelFile,
  } = imfContext || {};

  const result = _emptyResult(DOVI_STATUS.SCANNING);
  const cpl    = pkg?.cpl;
  if (!cpl) { result.status = DOVI_STATUS.IDLE; return result; }

  // Fall back to the user-configured native root (set via Settings > Relink IMF Root)
  // when the companion path is not set but the user has configured it manually.
  const _effectiveFolderPath = imfSourceFolderPath ||
    (typeof window !== 'undefined' ? (window.__pfxImfNativeRoot || '') : '');

  _log('Starting analysis — backend:', imfSourceBackend, '· CPL:', cpl.id?.slice(0, 16));

  // ── Path 1: Companion API ─────────────────────────────────────────────────
  if ((imfSourceBackend === 'companion' || _effectiveFolderPath) && _effectiveFolderPath) {
    _log('Path 1: companion API');
    const curEntry = (cplEntries || []).find(e => e.key === currentCplKey);
    const relPath  = String(curEntry?.relativePath || curEntry?.cpl?.relativePath || '');
    const cplPath  = String(
      curEntry?.cplPath || curEntry?.cpl?.absolutePath || curEntry?.cpl?.path ||
      pkg?.cpl?.absolutePath || pkg?.cpl?.path || pkg?.cplPath ||
      (relPath && _effectiveFolderPath ? `${_effectiveFolderPath}/${relPath}` : '')
    ).trim();

    _log('Companion folder:', imfSourceFolderPath, '· CPL path hint:', cplPath || '(none)');

    let data = null;
    try { data = await imfGetDoviMetafier(_effectiveFolderPath, cplPath); } catch (e) {
      _warn('Companion getDoviMetafier failed:', e?.message);
    }

    _log('Companion response:', data?.detectedBy || 'null',
         '· shots:', data?.shots?.length ?? 0, '· fromMxfHeader:', !!data?.fromMxfHeader);

    if (data?.shots?.length) {
      // Full per-shot data from companion extraction
      const parsed = { version: data.version || '', title: data.title || '' };
      _populateFromShots(result, annotateShots(data.shots), parsed,
        data.xmlPath || imfSourceFolderPath, DOVI_SOURCE.COMPANION_API);
      result.detectedBy = data.detectedBy || 'companion';
      result.profile    = data.dvProfile || '';
      result.level      = data.dvLevel   || '';
      return result;
    }

    if (data?.fromMxfHeader) {
      // DV confirmed from CPL/MXF scan but no embedded CM XML found
      result.status      = DOVI_STATUS.CONFIRMED_NO_DATA;
      result.sourceType  = DOVI_SOURCE.CPL_DESCRIPTOR;
      result.sourcePath  = data.xmlPath || '';
      result.detectedBy  = data.detectedBy || 'binary_mxf_scan';
      result.profile     = data.dvProfile || '';
      result.level       = data.dvLevel   || '';
      result.warnings.push('Dolby Vision confirmed in package but no CM XML could be extracted. A Metafier tool may be required for per-shot trim data.');
      _log('DV confirmed (MXF header/CPL) but no CM XML — extractor may be required');
      return result;
    }

    if (data === null) {
      result.warnings.push('Companion did not respond to getDoviMetafier request.');
    }
    _log('Companion: no DV found — continuing to browser paths');
  }

  // ── Path 1b: Native helper embedded MXF extraction (companion mode, no sidecar) ──
  // Use stored Metafier path from localStorage if available (set via Settings panel)
  const _storedMetafierPath = (() => {
    try { return localStorage?.getItem('pfx_dovi_metafier_path') || ''; } catch { return ''; }
  })();
  // When the companion is available but getDoviMetafier found no XML sidecar,
  // try running Metafier directly on each picture MXF to extract embedded CM XML.
  // The companion reads the MXF from disk — no binary is sent through native messaging.
  if (_effectiveFolderPath) {
    const vids = pkg?.cpl?.videoResources || [];
    if (vids.length > 0) {
      _log(`Path 1b: native helper extraction — ${vids.length} video MXF candidate(s)`);
      // Check Metafier availability first (fast check, cached by caller)
      const metafierInfo = await imfDetectMetafier().catch(() => ({ found: false }));
      if (metafierInfo?.found) {
        _log('Metafier found:', metafierInfo.path);
        for (let ri = 0; ri < vids.length; ri++) {
          const res = vids[ri];
          const asset = pkg?.assetIndex?.get?.(res.trackFileId) || {};
          const assetPath = asset.assetMapPath || asset.file || '';
          if (!assetPath) { _log(`Reel ${ri + 1}: no asset path — skip`); continue; }
          _log(`Reel ${ri + 1}: extracting via Metafier → ${assetPath}`);
          let exResult = null;
          try {
            exResult = await imfExtractDoviFromMxf({
              packageRootPath: _effectiveFolderPath,
              mxfRelativePath: assetPath,
              assetId:         res.trackFileId || '',
              reelId:          `R${ri + 1}`,
              metafierPath:    _storedMetafierPath || metafierInfo.path,
            });
          } catch (e) { _warn(`Reel ${ri + 1} extraction error:`, e?.message); }

          if (!exResult) continue;
          if (!exResult.ok) {
            _log(`Reel ${ri + 1} extraction failed: ${exResult.errorCode} — ${exResult.message}`);
            if (exResult.errorCode === 'METAFIER_NOT_FOUND') break; // no point trying others
            result.warnings.push(`Reel ${ri + 1}: ${exResult.message}`);
            continue;
          }
          let xmlText = exResult.xmlText || '';
          if (!xmlText && exResult.xmlTruncated && exResult.outputXmlPath) {
            _log(`Reel ${ri + 1}: XML ${Math.round((exResult.xmlSizeBytes || 0) / 1024)} KB — fetching from outputXmlPath`);
            const readRes = await imfReadExtractedXml(exResult.outputXmlPath).catch(() => null);
            xmlText = readRes?.xmlText || '';
          }
          if (!xmlText) {
            _log(`Reel ${ri + 1}: extractor ran but returned empty XML`);
            result.warnings.push(`Reel ${ri + 1}: Metafier produced no CM XML (may have no embedded DV metadata).`);
            continue;
          }
          const parsed = _parseAndAnnotate(xmlText, exResult.mxfPath || assetPath);
          if (parsed === null) {
            result.errors.push(`Reel ${ri + 1}: CM XML found but failed to parse.`);
            continue;
          }
          if (parsed.shots.length) {
            _log(`Reel ${ri + 1}: Metafier extracted ${parsed.shots.length} shots`);
            _populateFromShots(result, parsed.shots, parsed,
              exResult.mxfPath || assetPath, DOVI_SOURCE.EMBEDDED_MXF);
            result.detectedBy = `metafier_reel_${ri + 1}`;
            return result;
          }
          result.warnings.push(`Reel ${ri + 1}: CM XML parsed but no shots found.`);
        }
        // Metafier ran on all reels, nothing found
        if (!result.errors.length && !result.shots.length) {
          result.status = DOVI_STATUS.NOT_FOUND;
          result.warnings.push('Metafier ran on all reels but found no embedded Dolby Vision metadata.');
          _log('Metafier: no embedded DV metadata in any reel');
          return result;
        }
      } else {
        _log('Metafier not found — marking as EXTRACTOR_REQUIRED');
        result.status    = DOVI_STATUS.EXTRACTOR_REQUIRED;
        result.sourceType = DOVI_SOURCE.NONE;
        result.warnings.push('Dolby Vision metadata may be embedded in the video MXF. Configure Dolby Metafier in Settings > IMF / Dolby Vision to extract it.');
        return result;
      }
    }
  }

  // ── Path 2: Browser FSA — scan directory for DV XML sidecar ──────────────
  if (imfSourceDirHandle) {
    _log('Path 2: Browser FSA sidecar scan');
    try {
      const hit = await _scanDirHandle(imfSourceDirHandle);
      if (hit) {
        const parsed = _parseAndAnnotate(hit.text, hit.name);
        if (parsed === null) {
          result.status = DOVI_STATUS.PARSE_FAILED;
          result.errors.push(`XML sidecar found (${hit.name}) but failed to parse.`);
          return result;
        }
        if (parsed.shots.length) {
          _populateFromShots(result, parsed.shots, parsed, hit.name, DOVI_SOURCE.XML_SIDECAR);
          result.cmVersion = parsed.version || '';
          return result;
        }
        result.warnings.push(`XML sidecar found (${hit.name}) but contained no shot data.`);
      }
    } catch (e) {
      _warn('FSA sidecar scan failed:', e?.message);
      result.warnings.push(`Sidecar directory scan error: ${e?.message}`);
    }

    // ── Path 3: Browser FSA — extract embedded CM XML from picture MXF reels ──
    _log('Path 3: embedded MXF scan — reels:', cpl.videoResources?.length ?? 0);
    const vids = cpl.videoResources || [];
    let reelsChecked = 0;
    for (let i = 0; i < vids.length; i++) {
      const f = getReelFile ? getReelFile(vids[i]) : null;
      if (!f) continue;
      reelsChecked++;
      _log(`Scanning reel ${i + 1} (${f.name}) for embedded CM XML…`);
      try {
        const xmlText = await extractEmbeddedDoviXml(f);
        if (!xmlText) { _log(`Reel ${i + 1}: no embedded CM XML`); continue; }
        const parsed = _parseAndAnnotate(xmlText, f.name);
        if (parsed === null) {
          result.errors.push(`Embedded XML in reel ${i + 1} (${f.name}) failed to parse.`);
          continue;
        }
        if (parsed.shots.length) {
          _log(`Reel ${i + 1}: extracted ${parsed.shots.length} shots from embedded MXF`);
          _populateFromShots(result, parsed.shots, parsed, f.name, DOVI_SOURCE.EMBEDDED_MXF);
          result.cmVersion = parsed.version || '';
          return result;
        }
        result.warnings.push(`Embedded CM XML found in reel ${i + 1} but contained no shot data.`);
      } catch (e) {
        _warn(`Reel ${i + 1} embedded scan failed:`, e?.message);
        result.warnings.push(`Embedded MXF scan error (reel ${i + 1}): ${e?.message}`);
      }
    }

    if (reelsChecked === 0) {
      _log('No reel file handles available for embedded scan');
    }
  }

  // ── No DV found — determine why and set appropriate status ────────────────
  const isPq = /PQ|2084|smpte2084/i.test(cpl.transfer || '');
  const dvDescInCpl = cpl.isDolbyVision || (cpl.descriptors || []).some(d => d.isDVision);

  if (dvDescInCpl || isPq) {
    // PQ/DV content but couldn't get metadata — extractor likely needed
    result.status = DOVI_STATUS.EXTRACTOR_REQUIRED;
    result.sourceType = DOVI_SOURCE.NONE;
    result.warnings.push(
      dvDescInCpl
        ? 'Dolby Vision descriptor found in CPL but no CM XML could be extracted. ' +
          'The metadata is likely embedded in the picture MXF — a Metafier tool or ' +
          'Native Helper is required to extract it.'
        : 'Package uses PQ transfer but no Dolby Vision metadata was detected. ' +
          'May be HDR10/PQ only, or Dolby Vision metadata may be embedded in the MXF.'
    );
    _log('Status: EXTRACTOR_REQUIRED — PQ/DV content, no CM XML found');
  } else {
    result.status = DOVI_STATUS.NOT_FOUND;
    _log('Status: NOT_FOUND — no DV indicators in this package');
  }

  return result;
}

// ── Status description helpers ────────────────────────────────────────────────

/** Human-readable one-line status for the DV row header */
export function doviStatusLabel(result) {
  if (!result) return '';
  switch (result.status) {
    case DOVI_STATUS.FOUND:
      return `${result.shots.length} shot${result.shots.length !== 1 ? 's' : ''} · ${result.sourceType === DOVI_SOURCE.XML_SIDECAR ? 'XML sidecar' : result.sourceType === DOVI_SOURCE.EMBEDDED_MXF ? 'Embedded MXF' : 'Companion API'}`;
    case DOVI_STATUS.CONFIRMED_NO_DATA:
      return 'DV confirmed — CM XML not extracted (Metafier required)';
    case DOVI_STATUS.EXTRACTOR_REQUIRED:
      return 'DV likely embedded — Metafier / Native Helper required';
    case DOVI_STATUS.EXTRACT_FAILED:
      return 'DV extraction failed — see debug log';
    case DOVI_STATUS.PARSE_FAILED:
      return 'DV XML found but parse failed';
    case DOVI_STATUS.NOT_FOUND:
      return 'No Dolby Vision metadata detected';
    case DOVI_STATUS.SCANNING:
      return 'Scanning for Dolby Vision metadata…';
    default:
      return '';
  }
}

/** Severity level for validation: 'pass' | 'warn' | 'fail' | 'info' */
export function doviStatusSeverity(result, expectDV = false) {
  if (!result) return 'info';
  switch (result.status) {
    case DOVI_STATUS.FOUND:             return 'pass';
    case DOVI_STATUS.CONFIRMED_NO_DATA: return expectDV ? 'warn' : 'info';
    case DOVI_STATUS.EXTRACTOR_REQUIRED:return expectDV ? 'warn' : 'info';
    case DOVI_STATUS.EXTRACT_FAILED:    return expectDV ? 'fail' : 'warn';
    case DOVI_STATUS.PARSE_FAILED:      return 'warn';
    case DOVI_STATUS.NOT_FOUND:         return expectDV ? 'fail' : 'info';
    default:                            return 'info';
  }
}
