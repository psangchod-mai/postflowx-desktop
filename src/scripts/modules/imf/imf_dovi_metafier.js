/**
 * imf_dovi_metafier.js — Dolby Vision Professional Tools · Metafier
 *
 * Pure-logic module (no DOM access). Handles:
 *   - Full CM XML parsing (all levels L1–L11, trim passes)
 *   - Shot boundary / DVS cut detection
 *   - Transition classification (black / fade / dissolve)
 *   - Canvas (L6) extraction
 *   - Zero-value and UUID-consistency validation
 *   - CM XML v2.0.5 export
 */

'use strict';

// ─── PQ ↔ Nits ───────────────────────────────────────────────────────────────

const _PQ_MAX = 4095;
const _PQ_M1  = 2610 / 16384;
const _PQ_M2  = 2523 / 32;
const _PQ_C1  = 3424 / 4096;
const _PQ_C2  = 2413 / 128;
const _PQ_C3  = 2392 / 128;

export function pqToNits(pq) {
  const v = Math.max(0, Number(pq)) / _PQ_MAX;
  if (v <= 0) return 0;
  const eN = Math.max(0, Math.pow(v, 1 / _PQ_M2) - _PQ_C1);
  const eD = _PQ_C2 - _PQ_C3 * Math.pow(v, 1 / _PQ_M2);
  if (eD <= 0) return 0;
  return Math.round(Math.pow(eN / eD, 1 / _PQ_M1) * 10000 * 10) / 10;
}

export function nitsToPq(nits) {
  const y = Math.max(0, Number(nits)) / 10000;
  if (y <= 0) return 0;
  const e = Math.pow(y, _PQ_M1);
  return Math.round(Math.pow((_PQ_C1 + _PQ_C2 * e) / (1 + _PQ_C3 * e), _PQ_M2) * _PQ_MAX);
}

// ─── XML Helpers ─────────────────────────────────────────────────────────────

function _lname(tagName) {
  // Handle Clark notation: {http://...}LocalName → LocalName
  const brace = tagName.lastIndexOf('}');
  if (brace >= 0) return tagName.slice(brace + 1);
  // Handle QName prefix notation: prefix:LocalName → LocalName
  const colon = tagName.indexOf(':');
  if (colon >= 0) return tagName.slice(colon + 1);
  return tagName;
}

function _childText(el, ...names) {
  for (const child of el.children) {
    if (names.includes(_lname(child.tagName))) return child.textContent.trim();
  }
  return null;
}

function _childInt(el, ...names) {
  const t = _childText(el, ...names);
  if (t == null) return null;
  const n = parseInt(t, 10);
  return isNaN(n) ? null : n;
}

// ─── Level Parsers ────────────────────────────────────────────────────────────

function _parseL1(el) {
  const maxPq = _childInt(el, 'L1MaxPq', 'MaxPq', 'Max');
  if (maxPq == null) return null;
  const minPq = _childInt(el, 'L1MinPq', 'MinPq', 'Min') ?? 0;
  const midPq = _childInt(el, 'L1MidPq', 'MidPq', 'Mid', 'AvgPq', 'Avg') ?? 0;
  return {
    minPq, midPq, maxPq,
    minNits: pqToNits(minPq),
    midNits: pqToNits(midPq),
    maxNits: pqToNits(maxPq),
  };
}

function _parseL3(el) {
  return {
    minPqOffset: _childInt(el, 'L3MinPqOffset', 'MinPqOffset'),
    maxPqOffset: _childInt(el, 'L3MaxPqOffset', 'MaxPqOffset'),
    avgPqOffset: _childInt(el, 'L3AvgPqOffset', 'AvgPqOffset'),
  };
}

function _parseL5(el) {
  return {
    activeAreaX: _childInt(el, 'L5ActiveAreaX', 'ActiveAreaX'),
    activeAreaY: _childInt(el, 'L5ActiveAreaY', 'ActiveAreaY'),
    activeAreaW: _childInt(el, 'L5ActiveAreaW', 'ActiveAreaW'),
    activeAreaH: _childInt(el, 'L5ActiveAreaH', 'ActiveAreaH'),
  };
}

// DV CM v4.0 stores mastering display luminance in units of 1/10000 cd/m².
// CM v2.0.5 stores it directly in cd/m² (nits).
// Heuristic: values > 10,000 must be in 1/10000 scale (no real display exceeds 10,000 nits).
// MaxCLL / MaxFALL are always in cd/m² directly in both formats.
function _dvL6MastNits(raw) {
  if (raw == null) return null;
  return raw > 10000 ? raw / 10000 : raw;
}

function _parseL6(el) {
  const rawMax = _childInt(el, 'L6MaxDisplayMasteringLuminance', 'MaxDisplayMasteringLuminance', 'MaxMLuminance');
  const rawMin = _childInt(el, 'L6MinDisplayMasteringLuminance', 'MinDisplayMasteringLuminance', 'MinMLuminance');
  return {
    maxMasteringLuminance:    _dvL6MastNits(rawMax),  // normalized to nits
    minMasteringLuminance:    _dvL6MastNits(rawMin),  // normalized to nits
    maxContentLightLevel:     _childInt(el, 'L6MaxContentLightLevel',      'MaxContentLightLevel',      'MaxCLL'),
    maxFrameAverageLightLevel:_childInt(el, 'L6MaxFrameAverageLightLevel', 'MaxFrameAverageLightLevel', 'MaxFALL'),
    _rawMaxMast: rawMax,  // preserved for XML round-trip export
    _rawMinMast: rawMin,
  };
}

function _parseL8(el) {
  return {
    targetDisplayIndex: _childInt(el,  'L8TargetDisplayIndex', 'TargetDisplayIndex'),
    hueShift:          _childInt(el,  'L8HueShift',           'HueShift'),
    saturationGain:    _childInt(el,  'L8SaturationGain',     'SaturationGain'),
    trimSlope:         _childInt(el,  'L8TrimSlope',          'TrimSlope'),
    trimOffset:        _childInt(el,  'L8TrimOffset',         'TrimOffset'),
    trimPower:         _childInt(el,  'L8TrimPower',          'TrimPower'),
    chromaWeight:      _childInt(el,  'L8ChromaWeight',       'ChromaWeight'),
  };
}

function _parseL9(el) {
  return { sourceColorPrimary: _childText(el, 'L9SourceColorPrimary', 'SourceColorPrimary') };
}

function _parseL11(el) {
  return {
    contentType:            _childText(el, 'L11ContentType',            'ContentType'),
    whitepointTemperature:  _childInt(el,  'L11WhitepointTemperature',  'WhitepointTemperature'),
    referenceModeFlag:      _childText(el, 'L11ReferenceModeFlag',      'ReferenceModeFlag'),
  };
}

const _LEVEL_PARSERS = {
  Level1: _parseL1, L1: _parseL1,
  Level3: _parseL3, L3: _parseL3,
  Level5: _parseL5, L5: _parseL5,
  Level6: _parseL6, L6: _parseL6,
  Level8: _parseL8, L8: _parseL8,
  Level9: _parseL9, L9: _parseL9,
  Level11: _parseL11, L11: _parseL11,
};

// L2 is per-target (array), L8 can also be per-target (array)
const _LEVEL_ARRAY = new Set(['Level2', 'L2', 'Level8', 'L8']);

function _levelKey(tagName) {
  // 'Level1' → 'l1', 'L6' → 'l6', 'Level11' → 'l11'
  return 'l' + tagName.replace(/^L(?:evel)?/, '');
}

function _parseLevelsInto(el, shot) {
  for (const child of el.children) {
    const n = _lname(child.tagName);
    const parser = _LEVEL_PARSERS[n];
    if (!parser) continue;
    const parsed = parser(child);
    const key = _levelKey(n);
    if (_LEVEL_ARRAY.has(n)) {
      if (!Array.isArray(shot[key])) shot[key] = [];
      shot[key].push(parsed);
    } else {
      shot[key] = parsed;
    }
  }
}

function _parsePluginNode(node, shot) {
  for (const plugin of node.children) {
    const pn = _lname(plugin.tagName);
    if (pn === 'DVGlobalData' || pn === 'DolbyLabsMDF' || pn === 'GlobalData') {
      _parseLevelsInto(plugin, shot);
    } else if (pn === 'DVTrimPass' || pn === 'TrimPass') {
      for (const tp of plugin.children) {
        const tpn = _lname(tp.tagName);
        if (tpn === 'TrimPassData' || tpn === 'DVTrimPassData') {
          const target = tp.getAttribute('Target');
          const trimData = { target: target != null ? parseInt(target, 10) : null, levels: {} };
          // Parse levels inside trim pass into trimData.levels
          for (const child of tp.children) {
            const n = _lname(child.tagName);
            const parser = _LEVEL_PARSERS[n];
            if (!parser) continue;
            const key = _levelKey(n);
            trimData.levels[key] = parser(child);
          }
          if (!Array.isArray(shot.trimPasses)) shot.trimPasses = [];
          shot.trimPasses.push(trimData);
        }
      }
    } else {
      // Some formats nest levels directly in PluginNode children
      _parseLevelsInto(plugin, shot);
    }
  }
}

function _parseShotEl(shotEl) {
  const shot = {
    uuid: null, begin: 0, end: 0,
    l1: null, l2: [], l3: null, l5: null,
    l6: null, l8: [], l9: null, l11: null,
    trimPasses: [],
  };
  for (const child of shotEl.children) {
    const n = _lname(child.tagName);
    if (n === 'UniqueID')   { shot.uuid  = child.textContent.trim(); continue; }
    if (n === 'Begin')      { shot.begin = parseInt(child.textContent, 10) || 0; continue; }
    if (n === 'End')        { shot.end   = parseInt(child.textContent, 10) || 0; continue; }
    if (n === 'PluginNode') { _parsePluginNode(child, shot); continue; }
    // Some XML puts levels directly under Shot
    const parser = _LEVEL_PARSERS[n];
    if (parser) {
      const key = _levelKey(n);
      if (_LEVEL_ARRAY.has(n)) {
        if (!Array.isArray(shot[key])) shot[key] = [];
        shot[key].push(parser(child));
      } else {
        shot[key] = parser(child);
      }
    }
  }
  return shot;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse a Dolby Vision CM XML string into structured shot data.
 * @param {string} xmlText
 * @returns {{ shots: object[], version: string|null, title: string|null }}
 */
export function parseDoviXml(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) return { shots: [], version: null, title: null };
  const root = doc.documentElement;

  const version = root.querySelector('Version')?.textContent?.trim() ?? null;
  const title   = root.querySelector('Title')?.textContent?.trim()   ?? null;

  const shots = [];
  // querySelector('Shot') only gets first; iterate all
  function collectShots(node) {
    for (const child of node.children) {
      if (_lname(child.tagName) === 'Shot' || _lname(child.tagName) === 'shot') {
        shots.push(_parseShotEl(child));
      } else {
        collectShots(child);
      }
    }
  }
  collectShots(root);

  return { shots, version, title };
}

/**
 * Annotate shots with cut / transition information.
 * Mutates the array in-place (also returns it for chaining).
 */
export function annotateShots(shots) {
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const prev = i > 0 ? shots[i - 1] : null;

    shot.index = i;
    shot.durationFrames = shot.end - shot.begin + 1;
    shot.gapBefore = prev != null ? Math.max(0, shot.begin - (prev.end + 1)) : 0;
    // Every non-first Shot in the DoVi CM XML is a new shot boundary (an editorial
    // cut), regardless of frame continuity. gapBefore separately flags a metadata
    // anomaly (missing frames between shots) and is NOT itself a cut signal.
    shot.isCut = prev != null;

    // Transition classification from L1
    const l1 = shot.l1;
    if (l1 != null && l1.minPq === 0) {
      shot.isTransition = true;
      if (l1.maxPq === 0) {
        shot.transitionType = 'black';
      } else if (l1.midPq < l1.maxPq * 0.4) {
        shot.transitionType = 'fade';
      } else {
        shot.transitionType = 'dissolve';
      }
    } else {
      shot.isTransition = false;
      shot.transitionType = null;
    }
  }
  return shots;
}

/**
 * Validate shots for zero values and UUID / canvas consistency.
 * @returns {{ type, severity, shotIndex, uuid, frame, message }[]}
 */
export function validateDoviShots(shots) {
  const warnings = [];
  const uuidColorMap = new Map(); // uuid → JSON(l6)

  // Pre-pass: collect the set of L8 target indices present on every content shot
  // (skip pure transitions/blacks) so we can flag trim-coverage inconsistency.
  const _shotTrimSets = shots.map(shot => {
    const l8s = Array.isArray(shot.l8) ? shot.l8 : (shot.l8 ? [shot.l8] : []);
    const tpL8s = (shot.trimPasses || []).map(tp => tp.levels?.l8).filter(Boolean);
    const allL8 = [...l8s, ...tpL8s];
    const indices = new Set(allL8.map(l => l.targetDisplayIndex).filter(v => v != null));
    return indices;
  });

  // Build the "full" expected trim set: targets present on any non-transition shot
  const fullTrimSet = new Set();
  shots.forEach((shot, i) => {
    if (!shot.isTransition && _shotTrimSets[i].size > 0) {
      _shotTrimSets[i].forEach(idx => fullTrimSet.add(idx));
    }
  });

  shots.forEach((shot, i) => {
    const loc = `Shot ${i + 1} (frames ${shot.begin}–${shot.end})`;

    // Zero L1MaxPq on non-transition shot
    if (shot.l1 != null && shot.l1.maxPq === 0 && !shot.isTransition) {
      warnings.push({
        type: 'zero_l1_max', severity: 'error',
        shotIndex: i, uuid: shot.uuid, frame: shot.begin,
        message: `${loc}: L1MaxPq is 0 on a non-black shot`,
      });
    }

    // Crushed blacks — L1MinPq below broadcast black (PQ 64 ≈ 0.005 nit)
    if (shot.l1?.minPq != null && shot.l1.minPq > 0 && shot.l1.minPq < 64 && !shot.isTransition) {
      warnings.push({
        type: 'crushed_black', severity: 'warn',
        shotIndex: i, uuid: shot.uuid, frame: shot.begin,
        message: `${loc}: L1MinPq ${shot.l1.minPq} is below broadcast black (64 PQ) — possible crushed blacks`,
      });
    }

    // L1 peak above canvas mastering peak
    if (shot.l1?.maxNits != null && shot.l6?.maxMasteringLuminance != null) {
      if (shot.l1.maxNits > shot.l6.maxMasteringLuminance * 1.01) {
        warnings.push({
          type: 'l1_above_canvas', severity: 'error',
          shotIndex: i, uuid: shot.uuid, frame: shot.begin,
          message: `${loc}: L1 peak ${Math.round(shot.l1.maxNits)} nit exceeds canvas (L6) mastering peak ${shot.l6.maxMasteringLuminance} nit`,
        });
      }
    }

    // Canvas (L6) zero checks
    if (shot.l6 != null) {
      if (!shot.l6.maxMasteringLuminance) {
        warnings.push({
          type: 'zero_l6_max', severity: 'error',
          shotIndex: i, uuid: shot.uuid, frame: shot.begin,
          message: `${loc}: L6 MaxDisplayMasteringLuminance is 0 or missing`,
        });
      }
      if (!shot.l6.maxContentLightLevel && !shot.isTransition) {
        warnings.push({
          type: 'zero_l6_cll', severity: 'warn',
          shotIndex: i, uuid: shot.uuid, frame: shot.begin,
          message: `${loc}: L6 MaxContentLightLevel is 0`,
        });
      }
      // MaxCLL should not exceed mastering peak
      if (shot.l6.maxContentLightLevel && shot.l6.maxMasteringLuminance &&
          shot.l6.maxContentLightLevel > shot.l6.maxMasteringLuminance) {
        warnings.push({
          type: 'cll_above_mastering', severity: 'warn',
          shotIndex: i, uuid: shot.uuid, frame: shot.begin,
          message: `${loc}: MaxCLL (${shot.l6.maxContentLightLevel} nit) exceeds mastering peak (${shot.l6.maxMasteringLuminance} nit)`,
        });
      }
    }

    // Trim coverage inconsistency — non-transition shot missing targets seen elsewhere
    if (!shot.isTransition && fullTrimSet.size > 0) {
      const mySet = _shotTrimSets[i];
      const missing = [...fullTrimSet].filter(idx => !mySet.has(idx));
      if (missing.length > 0 && mySet.size > 0) {
        warnings.push({
          type: 'trim_coverage_gap', severity: 'warn',
          shotIndex: i, uuid: shot.uuid, frame: shot.begin,
          message: `${loc}: Missing L8 trim target(s) ${missing.join(', ')} (present on other shots)`,
        });
      } else if (mySet.size === 0 && fullTrimSet.size > 0) {
        warnings.push({
          type: 'no_trim_passes', severity: 'warn',
          shotIndex: i, uuid: shot.uuid, frame: shot.begin,
          message: `${loc}: No L8 trim passes found (other shots have ${fullTrimSet.size} target(s))`,
        });
      }
    }

    // UUID consistency: same UUID → same canvas
    if (shot.uuid) {
      const colorKey = JSON.stringify(shot.l6);
      if (uuidColorMap.has(shot.uuid)) {
        if (uuidColorMap.get(shot.uuid) !== colorKey) {
          warnings.push({
            type: 'uuid_color_mismatch', severity: 'error',
            shotIndex: i, uuid: shot.uuid, frame: shot.begin,
            message: `${loc}: UUID "${shot.uuid.slice(0, 8)}…" has inconsistent canvas (L6) vs. earlier occurrence`,
          });
        }
      } else {
        uuidColorMap.set(shot.uuid, colorKey);
      }
    } else {
      warnings.push({
        type: 'missing_uuid', severity: 'warn',
        shotIndex: i, uuid: null, frame: shot.begin,
        message: `${loc}: Shot has no UniqueID`,
      });
    }
  });

  return warnings;
}

/**
 * Build UUID → canvas map and list conflicts.
 * @returns {{ map: Map, conflicts: { uuid, shotIndices }[] }}
 */
export function buildUuidColorMap(shots) {
  const map = new Map();        // uuid → l6 (first seen)
  const keys = new Map();       // uuid → JSON(l6) (for comparison)
  const indices = new Map();    // uuid → [shotIndex, ...]
  const conflicts = [];

  shots.forEach((shot, i) => {
    if (!shot.uuid) return;
    const colorKey = JSON.stringify(shot.l6);
    if (!map.has(shot.uuid)) {
      map.set(shot.uuid, shot.l6);
      keys.set(shot.uuid, colorKey);
      indices.set(shot.uuid, [i]);
    } else {
      indices.get(shot.uuid).push(i);
      if (keys.get(shot.uuid) !== colorKey) {
        // Mark as null = conflicted
        map.set(shot.uuid, null);
      }
    }
  });

  for (const [uuid, canvas] of map) {
    if (canvas === null) conflicts.push({ uuid, shotIndices: indices.get(uuid) });
  }

  return { map, conflicts };
}

// ─── XML Export ──────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _emitL1(l1, pad) {
  if (!l1) return null;
  return [
    `${pad}<Level1>`,
    `${pad}  <L1MinPq>${l1.minPq ?? 0}</L1MinPq>`,
    `${pad}  <L1MidPq>${l1.midPq ?? 0}</L1MidPq>`,
    `${pad}  <L1MaxPq>${l1.maxPq ?? 0}</L1MaxPq>`,
    `${pad}</Level1>`,
  ].join('\n');
}

function _emitL3(l3, pad) {
  if (!l3 || (l3.minPqOffset == null && l3.maxPqOffset == null && l3.avgPqOffset == null)) return null;
  const lines = [`${pad}<Level3>`];
  if (l3.minPqOffset != null) lines.push(`${pad}  <L3MinPqOffset>${l3.minPqOffset}</L3MinPqOffset>`);
  if (l3.maxPqOffset != null) lines.push(`${pad}  <L3MaxPqOffset>${l3.maxPqOffset}</L3MaxPqOffset>`);
  if (l3.avgPqOffset != null) lines.push(`${pad}  <L3AvgPqOffset>${l3.avgPqOffset}</L3AvgPqOffset>`);
  lines.push(`${pad}</Level3>`);
  return lines.join('\n');
}

function _emitL5(l5, pad) {
  if (!l5 || l5.activeAreaX == null) return null;
  return [
    `${pad}<Level5>`,
    `${pad}  <L5ActiveAreaX>${l5.activeAreaX ?? 0}</L5ActiveAreaX>`,
    `${pad}  <L5ActiveAreaY>${l5.activeAreaY ?? 0}</L5ActiveAreaY>`,
    `${pad}  <L5ActiveAreaW>${l5.activeAreaW ?? 0}</L5ActiveAreaW>`,
    `${pad}  <L5ActiveAreaH>${l5.activeAreaH ?? 0}</L5ActiveAreaH>`,
    `${pad}</Level5>`,
  ].join('\n');
}

function _emitL6(l6, pad) {
  if (!l6) return null;
  const lines = [`${pad}<Level6>`];
  // Prefer raw values for round-trip accuracy; fall back to nits (will re-encode as nits for v2.0.5)
  const maxMastOut = l6._rawMaxMast ?? l6.maxMasteringLuminance;
  const minMastOut = l6._rawMinMast ?? l6.minMasteringLuminance;
  if (maxMastOut != null) lines.push(`${pad}  <L6MaxDisplayMasteringLuminance>${maxMastOut}</L6MaxDisplayMasteringLuminance>`);
  if (minMastOut != null) lines.push(`${pad}  <L6MinDisplayMasteringLuminance>${minMastOut}</L6MinDisplayMasteringLuminance>`);
  if (l6.maxContentLightLevel     != null) lines.push(`${pad}  <L6MaxContentLightLevel>${l6.maxContentLightLevel}</L6MaxContentLightLevel>`);
  if (l6.maxFrameAverageLightLevel != null) lines.push(`${pad}  <L6MaxFrameAverageLightLevel>${l6.maxFrameAverageLightLevel}</L6MaxFrameAverageLightLevel>`);
  lines.push(`${pad}</Level6>`);
  return lines.join('\n');
}

function _emitL8(l8, pad) {
  if (!l8) return null;
  const lines = [`${pad}<Level8>`];
  if (l8.targetDisplayIndex != null) lines.push(`${pad}  <L8TargetDisplayIndex>${l8.targetDisplayIndex}</L8TargetDisplayIndex>`);
  if (l8.hueShift           != null) lines.push(`${pad}  <L8HueShift>${l8.hueShift}</L8HueShift>`);
  if (l8.saturationGain     != null) lines.push(`${pad}  <L8SaturationGain>${l8.saturationGain}</L8SaturationGain>`);
  if (l8.trimSlope          != null) lines.push(`${pad}  <L8TrimSlope>${l8.trimSlope}</L8TrimSlope>`);
  if (l8.trimOffset         != null) lines.push(`${pad}  <L8TrimOffset>${l8.trimOffset}</L8TrimOffset>`);
  if (l8.trimPower          != null) lines.push(`${pad}  <L8TrimPower>${l8.trimPower}</L8TrimPower>`);
  if (l8.chromaWeight       != null) lines.push(`${pad}  <L8ChromaWeight>${l8.chromaWeight}</L8ChromaWeight>`);
  lines.push(`${pad}</Level8>`);
  return lines.join('\n');
}

function _emitL9(l9, pad) {
  if (!l9?.sourceColorPrimary) return null;
  return [
    `${pad}<Level9>`,
    `${pad}  <L9SourceColorPrimary>${_esc(l9.sourceColorPrimary)}</L9SourceColorPrimary>`,
    `${pad}</Level9>`,
  ].join('\n');
}

function _emitL11(l11, pad) {
  if (!l11 || (!l11.contentType && l11.whitepointTemperature == null && !l11.referenceModeFlag)) return null;
  const lines = [`${pad}<Level11>`];
  if (l11.contentType)           lines.push(`${pad}  <L11ContentType>${_esc(l11.contentType)}</L11ContentType>`);
  if (l11.whitepointTemperature != null) lines.push(`${pad}  <L11WhitepointTemperature>${l11.whitepointTemperature}</L11WhitepointTemperature>`);
  if (l11.referenceModeFlag)     lines.push(`${pad}  <L11ReferenceModeFlag>${_esc(l11.referenceModeFlag)}</L11ReferenceModeFlag>`);
  lines.push(`${pad}</Level11>`);
  return lines.join('\n');
}

/**
 * Export annotated shots as Dolby Vision CM XML v2.0.5.
 * @param {object[]} shots  - annotated shots from parseDoviXml + annotateShots
 * @param {{ title?, version?, blackLevel? }} [opts]
 * @returns {string} XML text
 */
export function exportDoviXml(shots, opts = {}) {
  const { title = '', version = '2.0.5', blackLevel = 64 } = opts;

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<DolbyLabsMDF xmlns="http://www.dolby.com/schemas/2014/MDFormat">',
    `  <Version>${_esc(version)}</Version>`,
  ];
  if (title) lines.push(`  <Title>${_esc(title)}</Title>`);
  lines.push(`  <BlackLevel>${blackLevel}</BlackLevel>`);
  lines.push('  <ShotSequence>');

  for (const shot of shots) {
    lines.push('    <Shot>');
    if (shot.uuid) lines.push(`      <UniqueID>${_esc(shot.uuid)}</UniqueID>`);
    lines.push(`      <Begin>${shot.begin}</Begin>`);
    lines.push(`      <End>${shot.end}</End>`);

    // Global data plugin
    const globalParts = [
      _emitL1(shot.l1, '          '),
      _emitL3(shot.l3, '          '),
      _emitL5(shot.l5, '          '),
      _emitL6(shot.l6, '          '),
      _emitL9(shot.l9, '          '),
      _emitL11(shot.l11, '          '),
    ].filter(Boolean);

    if (globalParts.length) {
      lines.push('      <PluginNode>');
      lines.push('        <DVGlobalData>');
      lines.push(...globalParts);
      lines.push('        </DVGlobalData>');
      lines.push('      </PluginNode>');
    }

    // Trim passes plugin
    const allTrimPasses = shot.trimPasses ?? [];
    // Also include any shot-level L8 entries as default trim pass
    const shotL8s = Array.isArray(shot.l8) ? shot.l8 : (shot.l8 ? [shot.l8] : []);
    if (allTrimPasses.length || shotL8s.length) {
      lines.push('      <PluginNode>');
      lines.push('        <DVTrimPass>');

      // Shot-level L8s without explicit target
      for (const l8 of shotL8s) {
        const targetAttr = l8.targetDisplayIndex != null ? ` Target="${l8.targetDisplayIndex}"` : '';
        lines.push(`          <TrimPassData${targetAttr}>`);
        const l8xml = _emitL8(l8, '            ');
        if (l8xml) lines.push(l8xml);
        lines.push('          </TrimPassData>');
      }

      // Explicit trim passes
      for (const tp of allTrimPasses) {
        const targetAttr = tp.target != null ? ` Target="${tp.target}"` : '';
        lines.push(`          <TrimPassData${targetAttr}>`);
        const lvls = tp.levels ?? {};
        const tpParts = [
          lvls.l2  ? `            <Level2><L2TargetMaxPq>${tp.target ?? 0}</L2TargetMaxPq></Level2>` : null,
          _emitL8(lvls.l8, '            '),
        ].filter(Boolean);
        lines.push(...tpParts);
        lines.push('          </TrimPassData>');
      }

      lines.push('        </DVTrimPass>');
      lines.push('      </PluginNode>');
    }

    lines.push('    </Shot>');
  }

  lines.push('  </ShotSequence>');
  lines.push('</DolbyLabsMDF>');
  return lines.join('\n');
}

// ─── Dolby Vision Target Display Registry ─────────────────────────────────────
// Mapping of Dolby-assigned L8 target display indices to human-readable labels.
// Sources: Dolby CM SDK documentation and Netflix IMF delivery specifications.
// This is intentionally a superset — only the most common studio targets are listed.
export const DV_TRIM_TARGETS = new Map([
  [1,  { name: 'SDR 100-nit BT.1886/Rec.709',         nits: 100,  tier: 'sdr'  }],
  [16, { name: 'HDR 1000-nit Home Theater',            nits: 1000, tier: 'hdr'  }],
  [27, { name: 'SDR 100-nit Rec.709 (Netflix)',         nits: 100,  tier: 'sdr'  }],
  [28, { name: 'HDR 1000-nit Rec.2020 PQ',             nits: 1000, tier: 'hdr'  }],
  [37, { name: 'HDR 600-nit Mobile/Consumer',           nits: 600,  tier: 'hdr'  }],
  [38, { name: 'HDR 3000-nit Reference Monitor',        nits: 3000, tier: 'hdr'  }],
  [48, { name: 'HDR 1000-nit Home Theater (Profile 5)', nits: 1000, tier: 'hdr'  }],
  [49, { name: 'HDR 2000-nit Premium TV',               nits: 2000, tier: 'hdr'  }],
  [56, { name: 'HDR 1000-nit ETSI/EBU Broadcast',      nits: 1000, tier: 'hdr'  }],
  [62, { name: 'HDR 2000-nit Studio Monitor',           nits: 2000, tier: 'hdr'  }],
  [63, { name: 'HDR 4000-nit Reference Mastering',      nits: 4000, tier: 'hdr'  }],
]);

/**
 * Return a short, human-readable label for an L8 target display index.
 * Falls back to "Display <idx>" for unknown indices.
 * @param {number|null|undefined} idx
 * @returns {string}
 */
export function getTrimTargetLabel(idx) {
  if (idx == null) return 'Unknown target';
  const entry = DV_TRIM_TARGETS.get(idx);
  if (entry) return `${entry.name} [${idx}]`;
  return `Display ${idx}`;
}

/**
 * Returns true if the L8 trim values are all at their neutral (pass-through) defaults.
 * Dolby CM XML encodes neutral as: slope=2048, offset=2048, power=2048, sat=2048,
 * chromaWeight=0, hueShift=0.
 * @param {object} l8
 * @returns {boolean}
 */
export function isNeutralL8(l8) {
  if (!l8) return true;
  const neutral = { trimSlope: 2048, trimOffset: 2048, trimPower: 2048,
                    saturationGain: 2048, chromaWeight: 0, hueShift: 0 };
  return Object.entries(neutral).every(([k, n]) => l8[k] == null || l8[k] === n);
}

/**
 * Format a raw Dolby CM fixed-point L8 value as a human-readable string.
 * Fixed-point encoding: slope/power/satGain center = 2048 → 1.00
 *                       offset/hueShift/chromaWeight center = 0 (or 2048 for offset) → 0
 * @param {'trimSlope'|'trimOffset'|'trimPower'|'saturationGain'|'chromaWeight'|'hueShift'} key
 * @param {number|null} raw
 * @returns {string}
 */
export function fmtL8Value(key, raw) {
  if (raw == null) return '—';
  switch (key) {
    case 'trimSlope':
    case 'trimPower':
    case 'saturationGain':
      // 2048 → 1.00, range [0, 4095] → [0.00, 2.00]
      return (raw / 2048).toFixed(3);
    case 'trimOffset':
      // 2048 = neutral (0), range [0, 4095] → [-1.00, +1.00]
      return ((raw - 2048) / 2048).toFixed(3);
    case 'hueShift':
      // raw is degrees * 65536, or just raw integer degrees in some Metafier versions;
      // treat as signed 16-bit degree offset: 0 = neutral
      return raw === 0 ? '0°' : `${raw > 0 ? '+' : ''}${raw}`;
    case 'chromaWeight':
      // 0 = neutral, range negative = desaturate, positive = boost
      return raw === 0 ? '0' : `${raw > 0 ? '+' : ''}${raw}`;
    default:
      return String(raw);
  }
}

// ─── SDR (100-nit Rec.709) trim selection ─────────────────────────────────────
// Dolby's standard target-display index 27 == 100-nit, BT.1886, Rec.709 (the SDR
// trim). We prefer that target; otherwise the lowest-index (lowest-nit) target.
const _SDR_TARGET_INDEX = 27;

// Decode 12-bit Dolby trim controls (neutral 2048) into representative multipliers.
// NOTE: these mappings are a documented APPROXIMATION of Dolby's trim encoding,
// tuned for a recognisable preview — NOT a reference-accurate CM result.
function _trimGain(slope)        { return slope        == null ? 1 : Math.max(0,   slope        / 2048); } // 2048→1.0
function _trimLift(offset)       { return offset       == null ? 0 : (offset - 2048) / 2048 * 0.5;        } // ±0.5
function _trimGamma(power)       { return power        == null ? 1 : Math.max(0.05, power       / 2048); } // 2048→1.0 exponent; 0.05 min allows deep shadow corrections
function _trimSat(satGain)       { return satGain      == null ? 1 : Math.max(0,   satGain      / 2048); } // 2048→1.0
// ChromaWeight (2048 = neutral, 0 = luma-only, >2048 = emphasize chroma) → [0..∞], typical 0.5–1.5
function _trimChromaWeight(cw)   { return cw           == null ? 1 : Math.max(0,   cw           / 2048); }
// HueShift (2048 = 0°, range 0–4095 ≈ ±30°)
function _trimHueShift(hs)       { return hs           == null ? 0 : (hs - 2048) / 2048 * 30;            } // degrees

function _l8ToTrim(l8, sourceMaxNits) {
  if (!l8) return null;
  return {
    targetIndex:   l8.targetDisplayIndex ?? null,
    gain:          _trimGain(l8.trimSlope),
    lift:          _trimLift(l8.trimOffset),
    gamma:         _trimGamma(l8.trimPower),
    sat:           _trimSat(l8.saturationGain),
    chromaWeight:  _trimChromaWeight(l8.chromaWeight),
    hueShift:      _trimHueShift(l8.hueShift),
    sourceMaxNits: sourceMaxNits || 1000,
    raw: { slope: l8.trimSlope, offset: l8.trimOffset, power: l8.trimPower,
           saturationGain: l8.saturationGain, chromaWeight: l8.chromaWeight, hueShift: l8.hueShift },
  };
}

/**
 * Pick the 100-nit Rec.709 (SDR) trim for a shot. Searches trimPasses
 * (each {target, levels:{l8}}) and shot-level l8[] for the SDR target index 27,
 * falling back to the lowest target index, then any L8 present.
 * @param {object} shot annotated shot from parseDoviXml
 * @returns {{targetIndex:number|null, gain:number, lift:number, gamma:number, sat:number, sourceMaxNits:number, raw:object}|null}
 */
export function pickSdrTrim(shot) {
  if (!shot) return null;
  const srcMax = shot.l6?.maxMasteringLuminance || shot.l1?.maxNits || 1000;
  const cands = [];
  for (const tp of (shot.trimPasses || [])) {
    const l8 = tp.levels?.l8;
    if (l8) cands.push({ idx: tp.target ?? l8.targetDisplayIndex, l8 });
  }
  const shotL8s = Array.isArray(shot.l8) ? shot.l8 : (shot.l8 ? [shot.l8] : []);
  for (const l8 of shotL8s) { if (l8) cands.push({ idx: l8.targetDisplayIndex, l8 }); }
  if (!cands.length) return null;
  let pick = cands.find(c => c.idx === _SDR_TARGET_INDEX);
  if (!pick) {
    const withIdx = cands.filter(c => c.idx != null).sort((a, b) => a.idx - b.idx);
    pick = withIdx[0] || cands[0];
  }
  return _l8ToTrim(pick.l8, srcMax);
}

/**
 * Build an ffmpeg filter fragment approximating a trim (for proxy bake). Maps
 * gain→contrast, lift→brightness, gamma→gamma, sat→saturation. Representative only.
 * @param {object} trim result of pickSdrTrim
 * @returns {string|null} an `eq=...` fragment for a -vf chain
 */
export function ffmpegTrimFilter(trim) {
  if (!trim) return null;
  const gain   = Number.isFinite(trim.gain)  ? trim.gain.toFixed(3)               : '1';
  const bright = Number.isFinite(trim.lift)  ? trim.lift.toFixed(3)               : '0';
  const gamma  = Number.isFinite(trim.gamma) ? Math.max(0.1, trim.gamma).toFixed(3) : '1';
  const sat    = Number.isFinite(trim.sat)   ? trim.sat.toFixed(3)                : '1';
  return `eq=contrast=${gain}:brightness=${bright}:gamma=${gamma}:saturation=${sat}`;
}
