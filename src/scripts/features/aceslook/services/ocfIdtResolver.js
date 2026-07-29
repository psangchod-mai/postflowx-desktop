// scripts/features/acesLook/services/ocfIdtResolver.js
//
// Bridge between OCF metadata (ocf_engine probe) and ACES Look / VFX Pull.
// Takes an OCF metadata-like object and resolves the correct ACES IDT, color
// space label, and AMF-compatible transform URN, so both features can
// auto-populate the IDT instead of relying on a manual pick.
//
// ESM (renderer module) — imported directly by colorPlanEngine, amfBuilder,
// fdlGenerator, and the VFX Pull UI. (The original automation prompt assumed a
// CommonJS module in dist/ + an electron/ocf SDK; PostFlowX is ESM with the OCF
// engine at features/ocf_engine, so this is the adapted port.)
//
// @typedef {Object} IDTResolution
//   acesIdtUrn, acesVersion, colorSpaceLabel, cameraFamily, ocioName,
//   isAutoDetected, source, warningMsg

'use strict';

// ACES IDT map — keyed by normalized colorSpace/codec/camera string fragments.
const IDT_MAP = [
  // ── ARRI ──────────────────────────────────────────────────────────────────
  { match: ['logc4', 'awg4', 'alexa 35', 'a35', 'alexa35'],
    idt: { acesIdtUrn: 'urn:ampas:aces:transformId:v2.0:IDT.ARRI.ALEXA35.ARRIRAW.a2.v1',
           acesVersion: '2.0', colorSpaceLabel: 'ARRI LogC4 / AWG4', cameraFamily: 'ARRI', ocioName: 'ARRI LogC4' } },
  { match: ['logc3', 'awg3', 'alexa mini lf', 'alexa lf', 'alexa mini', 'alexa xt',
            'alexa sxt', 'amira', 'arriraw'],
    idt: { acesIdtUrn: 'urn:ampas:aces:transformId:v1.5:IDT.ARRI.Alexa-v3-raw-EI0800.a1.v1',
           acesVersion: '1.5', colorSpaceLabel: 'ARRI LogC3 / AWG3', cameraFamily: 'ARRI', ocioName: 'ARRI LogC3 EI800 - Wide Gamut' } },

  // ── RED ───────────────────────────────────────────────────────────────────
  { match: ['log3g10', 'rwg', 'redwidegamut', 'r3d', 'komodo', 'monstro',
            'helium', 'dragon', 'gemini', 'v-raptor', 'raptor'],
    idt: { acesIdtUrn: 'urn:ampas:aces:transformId:v1.5:IDT.RedColorScience.REDWideGamutRGB_Log3G10.a1.v1',
           acesVersion: '1.5', colorSpaceLabel: 'REDWideGamutRGB / Log3G10', cameraFamily: 'RED', ocioName: 'Red Log3G10 / REDWideGamutRGB' } },

  // ── Sony ──────────────────────────────────────────────────────────────────
  { match: ['slog3', 's-log3', 'sgamut3.cine', 's-gamut3.cine', 'venice',
            'fx9', 'fx6', 'fx3', 'ilme', 'xocn', 'x-ocn'],
    idt: { acesIdtUrn: 'urn:ampas:aces:transformId:v1.5:IDT.Sony.SLog3_SGamut3Cine.a1.v1',
           acesVersion: '1.5', colorSpaceLabel: 'Sony S-Log3 / S-Gamut3.Cine', cameraFamily: 'Sony', ocioName: 'S-Log3 S-Gamut3.Cine' } },
  { match: ['slog2', 's-log2', 'sgamut', 's-gamut'],
    idt: { acesIdtUrn: 'urn:ampas:aces:transformId:v1.5:IDT.Sony.SLog2_SGamut.a1.v1',
           acesVersion: '1.5', colorSpaceLabel: 'Sony S-Log2 / S-Gamut', cameraFamily: 'Sony', ocioName: 'S-Log2 S-Gamut' } },

  // ── Panasonic ─────────────────────────────────────────────────────────────
  { match: ['vlog', 'v-log', 'vgamut', 'v-gamut', 'varicam', 'lumix'],
    idt: { acesIdtUrn: 'urn:ampas:aces:transformId:v1.5:IDT.Panasonic.VLog_VGamut.a1.v1',
           acesVersion: '1.5', colorSpaceLabel: 'Panasonic V-Log / V-Gamut', cameraFamily: 'Panasonic', ocioName: 'V-Log V-Gamut' } },

  // ── Canon ─────────────────────────────────────────────────────────────────
  // Note: the bare 'canon' vendor token is deliberately NOT included on either
  // entry below. Since _findBySearchStr returns on the first array match, a
  // generic vendor token here would short-circuit before the more specific
  // clog2/clog3 tokens are ever checked, misclassifying C-Log2 footage (and
  // even non-log Canon Rec.709 footage) as C-Log3. Cameras that are Canon but
  // don't hit clog2/clog3 fall through to the Rec.709 fallback below.
  { match: ['clog3', 'c-log3', 'cinema gamut'],
    idt: { acesIdtUrn: 'urn:ampas:aces:transformId:v1.5:IDT.Canon.CLog3_CGamut.a1.v1',
           acesVersion: '1.5', colorSpaceLabel: 'Canon C-Log3 / Cinema Gamut', cameraFamily: 'Canon', ocioName: 'Canon Log 3 Cinema Gamut' } },
  { match: ['clog2', 'c-log2'],
    idt: { acesIdtUrn: 'urn:ampas:aces:transformId:v1.5:IDT.Canon.CLog2_CGamut.a1.v1',
           acesVersion: '1.5', colorSpaceLabel: 'Canon C-Log2 / Cinema Gamut', cameraFamily: 'Canon', ocioName: 'Canon Log 2 Cinema Gamut' } },

  // ── Blackmagic ────────────────────────────────────────────────────────────
  { match: ['bmdfilm', 'blackmagic design film', 'braw', 'ursa', 'pocket', 'blackmagic'],
    idt: { acesIdtUrn: 'urn:ampas:aces:transformId:v1.5:IDT.BlackmagicDesign.BMDFilmGen5.a1.v1',
           acesVersion: '1.5', colorSpaceLabel: 'Blackmagic Film Gen 5', cameraFamily: 'Blackmagic', ocioName: 'Blackmagic Film Gen 5' } },

  // ── DJI ───────────────────────────────────────────────────────────────────
  { match: ['dlog', 'd-log', 'dji'],
    idt: { acesIdtUrn: 'urn:ampas:aces:transformId:v1.5:IDT.DJI.DLog_DGamut.a1.v1',
           acesVersion: '1.5', colorSpaceLabel: 'DJI D-Log / D-Gamut', cameraFamily: 'DJI', ocioName: 'DJI D-Log D-Gamut' } },

  // ── Generic Rec.709 fallback ──────────────────────────────────────────────
  { match: ['rec.709', 'rec709', 'bt.709', 'bt709', 'h.264', 'h264', 'h.265',
            'h265', 'prores', 'dnxhd', 'dnxhr'],
    idt: { acesIdtUrn: 'urn:ampas:aces:transformId:v1.5:ACEScsc.Academy.Rec709_100nits_dim.a1.0.3',
           acesVersion: '1.5', colorSpaceLabel: 'Rec.709', cameraFamily: 'Generic', ocioName: 'Rec.709 - Camera',
           warningMsg: 'Rec.709 IDT applied — verify color space matches camera settings' } },
];

/** Resolve IDT from an OCF metadata-like object. Never throws. */
export function resolveIdtFromOCFMeta(ocfMeta) {
  if (!ocfMeta) return _unknownResolution('No OCF metadata provided');

  // 1. Trust an ACES URN the OCF layer already resolved.
  if (ocfMeta.defaultAcesIdt && String(ocfMeta.defaultAcesIdt).startsWith('urn:ampas')) {
    const matched = _findByUrn(ocfMeta.defaultAcesIdt);
    if (matched) {
      return { ...matched, isAutoDetected: true, source: ocfMeta.source || 'ocf', warningMsg: matched.warningMsg || null };
    }
  }

  // 2. Search across all available metadata fields.
  const searchStr = [
    ocfMeta.colorSpace, ocfMeta.codec, ocfMeta.cameraType,
    ocfMeta.cameraFamily, ocfMeta.format, ocfMeta.container,
  ].map(v => v || '').join(' ').toLowerCase();

  const matched = _findBySearchStr(searchStr);
  if (matched) {
    return { ...matched, isAutoDetected: true, source: ocfMeta.source || 'ocf', warningMsg: matched.warningMsg || null };
  }

  // 3. No match → Rec.709 fallback with warning.
  return _unknownResolution(
    `Could not auto-detect IDT from: codec="${ocfMeta.codec || ''}", ` +
    `colorSpace="${ocfMeta.colorSpace || ''}", camera="${ocfMeta.cameraType || ocfMeta.cameraFamily || ''}". ` +
    `Please select IDT manually.`);
}

/** Map an ocf_engine probe object → resolved IDT (sync). */
export function resolveIdtFromProbe(probe) {
  if (!probe) return _unknownResolution('No OCF probe provided');
  return resolveIdtFromOCFMeta({
    colorSpace:   probe.colorSpace || probe.gamut || '',
    codec:        probe.codec || probe.format || '',
    cameraType:   probe.cameraType || probe.cameraModel || '',
    cameraFamily: probe.cameraFamily || '',
    container:    probe.container || probe.format || '',
    defaultAcesIdt: probe.defaultAcesIdt || null,
    source:       probe.source || 'ocf',
  });
}

/** Resolve IDT from a file path — probes via the OCF engine, then resolves (async). */
export async function resolveIdtFromFilePath(filePath) {
  try {
    const { ocfProbe } = await import('../../ocf_engine/ocfEngine.js');
    const probe = await ocfProbe(filePath);
    return resolveIdtFromProbe(probe?.data ?? probe);
  } catch (err) {
    return _unknownResolution(`OCF read failed: ${err?.message || err}`);
  }
}

/** All supported IDTs — for settings/UI dropdowns. */
export function listSupportedIdts() {
  return IDT_MAP.map(e => ({
    label: e.idt.colorSpaceLabel, urn: e.idt.acesIdtUrn,
    cameraFamily: e.idt.cameraFamily, ocioName: e.idt.ocioName, acesVersion: e.idt.acesVersion,
  }));
}

// ── Private ───────────────────────────────────────────────────────────────────
function _findByUrn(urn) {
  const n = String(urn).toLowerCase();
  for (const e of IDT_MAP) if (e.idt.acesIdtUrn.toLowerCase() === n) return { ...e.idt };
  return null;
}
function _findBySearchStr(searchStr) {
  // Separator-insensitive fallback so multi-word tokens ('alexa mini lf') still
  // match real filenames that concatenate them ('ALEXAMINI_LF', 'alexa-mini-lf').
  // Additive: original substring match is tried first, so existing behaviour is
  // unchanged; the stripped form only ADDS matches.
  const strip = s => s.replace(/[\s_-]+/g, '');
  const stripped = strip(searchStr);
  for (const e of IDT_MAP) {
    if (e.match.some(t => searchStr.includes(t) || stripped.includes(strip(t)))) return { ...e.idt };
  }
  return null;
}
function _unknownResolution(warningMsg) {
  return {
    acesIdtUrn: 'urn:ampas:aces:transformId:v1.5:ACEScsc.Academy.Rec709_100nits_dim.a1.0.3',
    acesVersion: '1.5', colorSpaceLabel: 'Unknown (Rec.709 fallback)', cameraFamily: 'Unknown',
    ocioName: 'Rec.709 - Camera', isAutoDetected: false, source: 'fallback', warningMsg,
  };
}
