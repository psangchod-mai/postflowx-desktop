// smartExrNamingEngine.js — PostFlowX EXR plate naming engine
// Netflix VFX Plate Naming Best Practices
// Format: {SHOW}_{EP}_{SCENE}_{SHOT}_{PLATE_ID}_{VERSION}.{FRAME}.exr
// Example: TST_101_067_0000_BG01_v001.1001.exr

import {
  associatedVfxShotName,
  buildNetflixPlateName,
  nextUniqueVfxName,
  normalizeVfxName,
} from '../core/vfxNameReview.js';

const ALLOWED = /[^A-Za-z0-9_\-.]/g;

export const PLATE_TYPES = {
  PL: 'Pull Plate',
  CP: 'Clean Plate',
  FG: 'Foreground',
  BG: 'Background',
  EL: 'Element',
  RF: 'Reference',
  BS: 'Bluescreen',
  GS: 'Greenscreen',
  CC: 'Color Chart',
  LG: 'Lens Grid',
  CH: 'Chromeball',
};

try { if (typeof window !== 'undefined') window.__pfxPlateLabels = PLATE_TYPES; } catch {}

export function sanitize(str) {
  return String(str || '').replace(/\s+/g, '_').replace(ALLOWED, '').replace(/__+/g, '_').replace(/^_+|_+$/g, '');
}

// Determine next plate number for a given shot+type, checking existing plates.
export function nextPlateNum(existingPlates = [], type = 'PL') {
  const prefix = type.toUpperCase();
  let max = 0;
  for (const p of existingPlates) {
    const m = String(p).match(new RegExp(`${prefix}(\\d+)`, 'i'));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return String(max + 1).padStart(2, '0');
}

export function nextVersion(existingVersions = []) {
  let max = 0;
  for (const v of existingVersions) {
    const m = String(v).match(/v(\d+)/i);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return String(max + 1).padStart(3, '0');
}

// Build the plate base name.
// Modern 3-arg form:  buildPlateName(shot, 'BG01',  '001')  → TST_101_0000_BG01_v001
// Legacy 4-arg form:  buildPlateName(shot, 'BG',    '01', '001') — still supported for
//                     callers that haven't migrated to a full plate ID string.
export function buildPlateName(shotName, plateIdOrType = 'PL01', versionOrNum = '001', legacyVersion) {
  let pid, ver;
  if (legacyVersion !== undefined) {
    // Legacy: (shot, 'PL', '01', '001')
    const type = String(plateIdOrType).toUpperCase();
    const num  = String(versionOrNum).padStart(2, '0');
    pid = `${type}${num}`;
    ver = String(legacyVersion).replace(/^v/i, '').padStart(3, '0');
  } else {
    // Modern: (shot, 'BG01', '001') or (shot, 'smoke01', 'v002')
    pid = sanitize(String(plateIdOrType));
    ver = String(versionOrNum).replace(/^v/i, '').padStart(3, '0');
  }
  return buildNetflixPlateName(shotName, pid, `v${ver}`);
}

// Build a single EXR filename: plateName.frameNum.exr
export function buildEXRFilename(plateName, frameNum) {
  return `${plateName}.${String(frameNum).padStart(4, '0')}.exr`;
}

// Build the printf-style pattern for Native Helper.
export function buildEXRPattern(plateName) {
  return `${plateName}.%04d.exr`;
}

// Build shot name from the available event / marker / project-naming data.
//
// Priority:
//   1. event._pmShot     — authoritative: already fully formatted by the PostFlowX
//                          naming template ("LMP_102_0001").  Return it unchanged.
//   2. marker.shotName   — pre-built name on a PostFlowX PM marker.
//   3. event._pfxShow/_pfxEp/_pfxScene/_pfxShot  — per-event injected fields.
//   4. projectNaming.show/ep/scene + event.shot  — global naming template chips
//                          used for Resolve events that have no PM marker linked.
//   5. EDL / Resolve event fields (show, seq, shot, clipName, reel …).
//   6. SHOT### fallback label.
export function deriveShotName(event = {}, marker = {}, projectNaming = {}) {
  // Levels 1–2: fully-formatted names — return immediately without reconstruction.
  // event._pmShot is set by prep_mark.js only when the naming template has been applied.
  if (event._pmShot)    return associatedVfxShotName(event._pmShot);
  if (marker?.shotName) return associatedVfxShotName(marker.shotName);

  // Levels 3–5: reconstruct SHOW_EP_SCENE_SHOT from structured fields.
  const show  = normalizeVfxName(event._pfxShow  || projectNaming.show  || event.show   || event.project  || '');
  const ep    = sanitize(event._pfxEp    || projectNaming.ep    || event.ep     || event.episode  ||
                          event.seq      || event.sequence      || '');
  const scene = sanitize(event._pfxScene || projectNaming.scene || event.scene  || '');
  const shot  = sanitize(event._pfxShot  || event.shot         || event.shotNum || '');

  if (show || ep || scene || shot) {
    const parts = [];
    if (show)  parts.push(show.toUpperCase() === 'MMBLR' ? 'BLR' : show.toUpperCase());
    if (ep)    parts.push(String(ep).padStart(3, '0'));
    if (scene) parts.push(String(scene).padStart(3, '0'));
    if (shot)  parts.push(String(shot).padStart(4, '0'));
    if (parts.length) return parts.join('_');
  }

  // Level 6: never turn a camera roll into a VFX shot name. Use the approved
  // BLR show ID and a deterministic event number until the user reviews it.
  const fallbackNumber = String(Number(event.eventNumber || 1)).padStart(3, '0');
  return `BLR_101_${fallbackNumber}`;
}

// Check for duplicate names in a set; returns deduplicated name with suffix bump.
export function dedupName(name, usedNames = new Set()) {
  if (!usedNames.has(name)) { usedNames.add(name); return name; }
  const deduped = nextUniqueVfxName(name, usedNames, { step: 10, pad: 3 })
    .replace(/_V(\d{3,4})$/, '_v$1');
  usedNames.add(deduped);
  return deduped;
}

// Build full naming context for a single event+marker combination.
export function buildNamingContext({
  event            = {},
  marker           = {},
  plateId          = null,   // full plate ID string: "BG01", "smoke01", "muzzleFlash01"
  plateType        = 'PL',   // 2-letter code — used only when plateId is not set
  plateNum         = null,   // 2-digit number — used only when plateId is not set
  version          = null,
  existingPlates   = [],
  existingVersions = [],
  usedNames        = new Set(),
  projectNaming    = {},     // {show, ep, scene} from global naming template chips
}) {
  const shotName = deriveShotName(event, marker, projectNaming);

  // Resolve plate ID — prefer explicit full string over legacy type+num split
  let resolvedPlateId;
  if (plateId) {
    resolvedPlateId = sanitize(String(plateId));
  } else {
    const pNum = plateNum ?? nextPlateNum(existingPlates, plateType);
    const type  = String(plateType).toUpperCase();
    resolvedPlateId = `${type}${String(pNum).padStart(2, '0')}`;
  }

  const ver       = version ?? nextVersion(existingVersions);
  const plateName = buildPlateName(shotName, resolvedPlateId, ver);
  const unique    = dedupName(plateName, usedNames);
  return {
    shotName,
    plateId:   resolvedPlateId,
    plateType: resolvedPlateId.replace(/\d+$/, ''),
    plateNum:  resolvedPlateId.match(/\d+$/)?.[0] ?? '01',
    version:   String(ver).replace(/^v/i, '').padStart(3, '0'),
    plateName: unique,
    pattern:   buildEXRPattern(unique),
  };
}
