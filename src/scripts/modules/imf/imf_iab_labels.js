'use strict';

let _rulesPromise = null;

function _assetUrl(relPath) {
  const clean = String(relPath || '').replace(/^\/+/, '');
  try {
    if (globalThis.chrome?.runtime?.getURL) return chrome.runtime.getURL(clean);
    if (globalThis.browser?.runtime?.getURL) return browser.runtime.getURL(clean);
  } catch {}
  try { return new URL(clean, document.baseURI).toString(); } catch {}
  return clean;
}

async function _loadRules() {
  if (_rulesPromise) return _rulesPromise;
  _rulesPromise = (async () => {
    const [atmResp, labelsResp] = await Promise.all([
      fetch(_assetUrl('tools/bwav/data/atmosLabelConfiguration.json')),
      fetch(_assetUrl('tools/bwav/data/netflix_recognized_group_labels.json')),
    ]);
    const atm = await atmResp.json();
    const labelsFallback = await labelsResp.json();
    const labels = (atm && Array.isArray(atm.validAudioContentGroups)) ? atm : labelsFallback;
    return { labels };
  })().catch(err => {
    _rulesPromise = null; // allow retry on next call
    throw err;
  });
  return _rulesPromise;
}

function _normalizeLabel(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function _buildSynonymSets(labels) {
  const toArr = (arr) => (arr || []).map(_normalizeLabel);
  const toSet = (arr) => new Set(toArr(arr));
  let buckets = { Dialogue: [], Music: [], Effects: [], Narration: [] };
  let subgroupBuckets = { Dialogue: {}, Music: {}, Effects: {}, Narration: {} };

  const mapGroup = (g) => {
    const k = String(g || '').toLowerCase();
    if (k === 'dialogue') return 'Dialogue';
    if (k === 'music') return 'Music';
    if (k === 'effects') return 'Effects';
    if (k === 'narration') return 'Narration';
    return k ? (k[0].toUpperCase() + k.slice(1)) : 'Other';
  };

  if (labels && Array.isArray(labels.validAudioContentGroups)) {
    for (const g of labels.validAudioContentGroups) {
      const key = mapGroup(g.groupName);
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(...(g.labels || []));
      for (const sg of (g.validContentLabelSubGroups || [])) {
        const sgName = String(sg.subGroupName || '').trim() || 'subgroup';
        if (!subgroupBuckets[key]) subgroupBuckets[key] = {};
        if (!subgroupBuckets[key][sgName]) subgroupBuckets[key][sgName] = [];
        subgroupBuckets[key][sgName].push(...(sg.labels || []));
        buckets[key].push(...(sg.labels || []));
      }
    }
  } else {
    buckets = {
      Dialogue: labels?.Dialogue || [],
      Music: labels?.Music || [],
      Effects: labels?.Effects || [],
      Narration: labels?.Narration || [],
    };
  }

  const sets = {
    Dialogue: toSet(buckets.Dialogue),
    Music: toSet(buckets.Music),
    Effects: toSet(buckets.Effects),
    Narration: toSet(buckets.Narration),
    __normLists: {
      Dialogue: toArr(buckets.Dialogue),
      Music: toArr(buckets.Music),
      Effects: toArr(buckets.Effects),
      Narration: toArr(buckets.Narration),
    },
    __subgroups: {},
    __subgroupLookup: new Map(),
  };

  for (const group of Object.keys(subgroupBuckets || {})) {
    const gObj = subgroupBuckets[group] || {};
    sets.__subgroups[group] = {};
    for (const [sgName, arr] of Object.entries(gObj)) {
      const normArr = toArr(arr);
      sets.__subgroups[group][sgName] = new Set(normArr);
      for (const n of normArr) {
        if (!sets.__subgroupLookup.has(n)) sets.__subgroupLookup.set(n, { group, subgroup: sgName });
      }
    }
  }
  return sets;
}

function _mapLabel(norm, sets) {
  try {
    const hit = sets?.__subgroupLookup?.get(norm);
    if (hit) return hit;
  } catch {}
  for (const k of ['Dialogue', 'Music', 'Effects', 'Narration']) {
    if (sets[k]?.has(norm)) return { group: k, subgroup: '' };
  }
  return null;
}

function _levenshtein(a, b) {
  a = a || '';
  b = b || '';
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
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
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[n];
}

function _sourceCategory(source) {
  const s = String(source || '').toLowerCase();
  if (s.includes('audioprogramme')) return 'programme';
  if (s.includes('audiopackformat')) return 'pack';
  if (s.includes('audiotrackformat')) return 'trackformat';
  if (s.includes('audiotrackuid')) return 'trackuid';
  if (s.includes('audioobject')) return 'object';
  if (s.includes('audiocontent')) return 'content';
  return 'other';
}

function _bestGroupSuggestion(normLabel, normLists) {
  let best = { group: null, label: null, dist: Infinity };
  for (const [group, arr] of Object.entries(normLists || {})) {
    for (const s of arr) {
      const d = _levenshtein(normLabel, s);
      if (d < best.dist) best = { group, label: s, dist: d };
      if (best.dist === 0) return best;
    }
  }
  return best.group ? best : null;
}

function _fixForReject(rawLabel, source, normLists) {
  const cat = _sourceCategory(source);
  const norm = _normalizeLabel(rawLabel);
  if (cat === 'programme') {
    return 'Not a bed/object group label. Fix: ignore audioProgrammeName in label QC (validate audioObject/audioContent only).';
  }
  if (cat === 'pack') {
    return 'Technical pack name. Fix: ignore audioPackFormatName in label QC.';
  }
  if (cat === 'trackformat' || cat === 'trackuid') {
    return 'Channel identifier (not group). Fix: exclude audioTrackFormat/UID from group label QC.';
  }
  if (cat === 'object') {
    return 'Bed/object name — not a group label. Fix: exclude audioObject names from group label QC (validate audioContent group labels only).';
  }
  const sug = _bestGroupSuggestion(norm, normLists);
  if (sug) return `Rename to a recognized ${sug.group} label (closest: "${sug.label}").`;
  return 'Rename to a recognized group label (Dialogue/Music/Effects/Narration).';
}

function _extractCandidates(xmlDoc) {
  const out = [];
  const uniqPush = (rawLabel, source) => {
    const t = String(rawLabel || '').trim();
    if (!t) return;
    out.push({ rawLabel: t, source });
  };
  const byLocalName = (localName) => {
    const nodes = [];
    try { nodes.push(...Array.from(xmlDoc.getElementsByTagNameNS('*', localName))); } catch {}
    try { nodes.push(...Array.from(xmlDoc.getElementsByTagName(localName))); } catch {}
    const seen = new Set();
    const uniq = [];
    for (const n of nodes) {
      if (n && !seen.has(n)) {
        seen.add(n);
        uniq.push(n);
      }
    }
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

  pullAttr('audioProgramme', 'audioProgrammeName', 'audioProgramme@audioProgrammeName');
  pullAttr('audioContent', 'audioContentName', 'audioContent@audioContentName');
  pullAttr('audioObject', 'audioObjectName', 'audioObject@audioObjectName');
  pullAttr('audioPackFormat', 'audioPackFormatName', 'audioPackFormat@audioPackFormatName');
  pullAttr('audioTrackUID', 'audioTrackUIDName', 'audioTrackUID@audioTrackUIDName');
  pullAttr('audioTrackFormat', 'audioTrackFormatName', 'audioTrackFormat@audioTrackFormatName');

  pullText('audioProgrammeName', 'audioProgrammeName');
  pullText('audioContentName', 'audioContentName');
  pullText('audioObjectName', 'audioObjectName');
  pullText('audioPackFormatName', 'audioPackFormatName');
  pullText('audioTrackUIDName', 'audioTrackUIDName');
  pullText('audioTrackFormatName', 'audioTrackFormatName');

  const seen = new Set();
  const dedup = [];
  for (const r of out) {
    const k = `${r.source}::${r.rawLabel}`;
    if (!seen.has(k)) {
      seen.add(k);
      dedup.push(r);
    }
  }
  return dedup;
}

function _countTag(doc, ln) {
  try {
    const n = doc.getElementsByTagNameNS('*', ln).length;
    if (n) return n;
  } catch {}
  try { return doc.getElementsByTagName(ln).length; } catch {}
  return 0;
}

async function _extractEmbeddedAdmXml(file) {
  const decoder = new TextDecoder('latin1');
  const chunkSize = 2 * 1024 * 1024;
  const overlap = 256;
  const primaryStart = '<ebuCoreMain';
  const primaryEnd = '</ebuCoreMain>';
  const fallbackStart = '<audioFormatExtended';
  const fallbackEnd = '</audioFormatExtended>';
  let carry = '';
  let started = false;
  let usingFallback = false;
  let xmlText = '';

  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const buf = await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer();
    const text = decoder.decode(buf);
    const scan = carry + text;

    if (!started) {
      let idx = scan.indexOf(primaryStart);
      if (idx < 0) {
        idx = scan.indexOf(fallbackStart);
        if (idx >= 0) usingFallback = true;
      }
      if (idx < 0) {
        carry = scan.slice(-overlap);
        continue;
      }
      started = true;
      xmlText = scan.slice(idx);
    } else {
      xmlText += text;
    }

    const endTag = usingFallback ? fallbackEnd : primaryEnd;
    const endIdx = xmlText.indexOf(endTag);
    if (endIdx >= 0) {
      let xml = xmlText.slice(0, endIdx + endTag.length);
      const firstLt = xml.indexOf('<');
      if (firstLt > 0) xml = xml.slice(firstLt);
      if (usingFallback) {
        xml = `<?xml version="1.0" encoding="UTF-8"?><ebuCoreMain><coreMetadata><format>${xml}</format></coreMetadata></ebuCoreMain>`;
      }
      return xml;
    }
    carry = text.slice(-overlap);
  }
  throw new Error('Embedded ADM XML not found in IAB asset');
}

function _byLocalName(doc, localName) {
  const nodes = [];
  try { nodes.push(...Array.from(doc.getElementsByTagNameNS('*', localName))); } catch {}
  try { nodes.push(...Array.from(doc.getElementsByTagName(localName))); } catch {}
  const seen = new Set();
  const uniq = [];
  for (const n of nodes) {
    if (n && !seen.has(n)) {
      seen.add(n);
      uniq.push(n);
    }
  }
  return uniq;
}

function _pullAttrValues(doc, elemLocalName, attrName) {
  const out = [];
  const seen = new Set();
  for (const n of _byLocalName(doc, elemLocalName)) {
    try {
      const v = String(n.getAttribute(attrName) || '').trim();
      if (!v) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    } catch {}
  }
  return out;
}

export async function inspectIabAdm(file) {
  if (!file) throw new Error('No IAB asset file provided');
  const rules = await _loadRules();
  const sets = _buildSynonymSets(rules.labels);
  const xmlText = await _extractEmbeddedAdmXml(file);
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Invalid embedded ADM XML in IAB asset');
  }

  const candidates = _extractCandidates(doc);
  const rows = [];
  for (const c of candidates) {
    const norm = _normalizeLabel(c.rawLabel);
    const mapped = _mapLabel(norm, sets);
    let status = mapped ? 'PASS' : 'REJECT';
    if (status === 'REJECT') {
      const cat = _sourceCategory(c.source);
      if (cat === 'programme' || cat === 'pack' || cat === 'trackformat' || cat === 'trackuid' || cat === 'object') {
        status = 'WARN';
      }
    }
    rows.push({
      status,
      rawLabel: c.rawLabel,
      normalized: norm,
      mapped: mapped ? (mapped.group || '') : '',
      subgroup: mapped ? (mapped.subgroup || '') : '',
      source: c.source,
      fix: status === 'PASS' ? '' : _fixForReject(c.rawLabel, c.source, sets.__normLists || {}),
    });
  }

  const programmeNames = _pullAttrValues(doc, 'audioProgramme', 'audioProgrammeName');
  const contentNames = _pullAttrValues(doc, 'audioContent', 'audioContentName');
  const objectNames = _pullAttrValues(doc, 'audioObject', 'audioObjectName');
  const packNames = _pullAttrValues(doc, 'audioPackFormat', 'audioPackFormatName');
  const trackFormatNames = _pullAttrValues(doc, 'audioTrackFormat', 'audioTrackFormatName');
  const defaultBedObjects = objectNames.filter((name) => /bed/i.test(name));
  const numberedObjects = objectNames.filter((name) => /^object\s+\d+$/i.test(name));
  const namedObjects = objectNames.filter((name) => !/^object\s+\d+$/i.test(name) && !/defaultbed/i.test(name));
  const counts = {
    total: rows.length,
    pass: rows.filter((r) => r.status === 'PASS').length,
    warn: rows.filter((r) => r.status === 'WARN').length,
    reject: rows.filter((r) => r.status === 'REJECT').length,
  };

  return {
    rows,
    xmlText,
    axmlRoot: {
      localName: doc.documentElement?.localName || doc.documentElement?.nodeName || '',
      ns: doc.documentElement?.namespaceURI || '',
    },
    admStats: {
      audioProgramme: _countTag(doc, 'audioProgramme'),
      audioContent: _countTag(doc, 'audioContent'),
      audioObject: _countTag(doc, 'audioObject'),
      audioPackFormat: _countTag(doc, 'audioPackFormat'),
      audioTrackUID: _countTag(doc, 'audioTrackUID'),
      audioTrackFormat: _countTag(doc, 'audioTrackFormat'),
    },
    programmeNames,
    contentNames,
    objectNames,
    packNames,
    trackFormatNames,
    objectSummary: {
      totalObjects: objectNames.length,
      bedObjects: defaultBedObjects.length,
      numberedObjects: numberedObjects.length,
      namedObjects: namedObjects.length,
      sampleNamedObjects: namedObjects.slice(0, 8),
    },
    counts,
  };
}

export async function extractIabAdmLabelQC(file) {
  const inspected = await inspectIabAdm(file);
  return {
    rows: inspected.rows,
    xmlText: inspected.xmlText,
    axmlRoot: inspected.axmlRoot,
    admStats: inspected.admStats,
  };
}

/**
 * Run label QC rules on pre-extracted name arrays (e.g. from companion metadata).
 * Produces the same { rows, admStats, axmlRoot, counts } shape as extractIabAdmLabelQC
 * but without requiring access to the raw MXF bytes.
 *
 * @param {{ programmeNames?, contentNames?, objectNames?, packNames?, trackFormatNames? }} names
 */
export async function inspectIabAdmFromNames({
  programmeNames = [],
  contentNames = [],
  objectNames = [],
  packNames = [],
  trackFormatNames = [],
} = {}) {
  const rules = await _loadRules();
  const sets = _buildSynonymSets(rules.labels);

  const rawCandidates = [
    ...programmeNames.map(n  => ({ rawLabel: n, source: 'audioProgramme@audioProgrammeName' })),
    ...contentNames.map(n    => ({ rawLabel: n, source: 'audioContent@audioContentName' })),
    ...objectNames.map(n     => ({ rawLabel: n, source: 'audioObject@audioObjectName' })),
    ...packNames.map(n       => ({ rawLabel: n, source: 'audioPackFormat@audioPackFormatName' })),
    ...trackFormatNames.map(n => ({ rawLabel: n, source: 'audioTrackFormat@audioTrackFormatName' })),
  ];

  const seen = new Set();
  const candidates = rawCandidates.filter(c => {
    const k = `${c.source}::${c.rawLabel}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const rows = candidates.map(c => {
    const norm = _normalizeLabel(c.rawLabel);
    const mapped = _mapLabel(norm, sets);
    let status = mapped ? 'PASS' : 'REJECT';
    if (status === 'REJECT') {
      const cat = _sourceCategory(c.source);
      if (cat === 'programme' || cat === 'pack' || cat === 'trackformat' || cat === 'trackuid' || cat === 'object') {
        status = 'WARN';
      }
    }
    return {
      status,
      rawLabel: c.rawLabel,
      normalized: norm,
      mapped: mapped ? (mapped.group || '') : '',
      subgroup: mapped ? (mapped.subgroup || '') : '',
      source: c.source,
      fix: status === 'PASS' ? '' : _fixForReject(c.rawLabel, c.source, sets.__normLists || {}),
    };
  });

  const counts = {
    total: rows.length,
    pass: rows.filter(r => r.status === 'PASS').length,
    warn: rows.filter(r => r.status === 'WARN').length,
    reject: rows.filter(r => r.status === 'REJECT').length,
  };

  return { rows, admStats: null, axmlRoot: null, counts };
}

// ─── ADM Programme Tree ───────────────────────────────────────────────────────

// Map SMPTE ST 2067-201 / ITU-R BS.2051 speaker labels to short names
const _SPEAKER_MAP = {
  'M+030': 'L',  'M-030': 'R',  'M+000': 'C',   'LFE1': 'LFE', 'LFE': 'LFE',
  'M+110': 'Ls', 'M-110': 'Rs', 'M+SC':  'LC',  'M-SC': 'RC',
  'U+030': 'Ltf','U-030': 'Rtf','U+110': 'Ltr', 'U-110': 'Rtr',
  'U+000': 'Ct', 'T+000': 'T',
  // Legacy / common ADM labels
  'LEFT': 'L', 'RIGHT': 'R', 'CENTER': 'C', 'LFE2': 'LFE',
  'LEFT SURROUND': 'Ls', 'RIGHT SURROUND': 'Rs',
  'LEFT SIDE SURROUND': 'Lss', 'RIGHT SIDE SURROUND': 'Rss',
};

function _mapSpeakerLabel(raw) {
  const k = String(raw || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (_SPEAKER_MAP[k]) return _SPEAKER_MAP[k];
  // Partial match: strip suffix suffixes like "_0" or "(1)"
  const base = k.replace(/[\s_(-].*$/, '');
  return _SPEAKER_MAP[base] || raw;
}

function _parseAdmTree(xmlDoc) {
  // audioPackFormat: typeDefinition tells us bed vs object
  const packTypes = new Map(); // id → { type, name }
  for (const n of _byLocalName(xmlDoc, 'audioPackFormat')) {
    const id   = (n.getAttribute('audioPackFormatID') || n.getAttribute('UID') || '').trim();
    const type = (n.getAttribute('typeDefinition') || n.getAttribute('typeLabel') || '').trim();
    const name = (n.getAttribute('audioPackFormatName') || '').trim();
    if (id) packTypes.set(id, { type, name });
  }

  // audioObject → audioPackFormatIDRef → classify
  const beds = [];
  const atmosObjects = [];
  for (const obj of _byLocalName(xmlDoc, 'audioObject')) {
    const objName = (obj.getAttribute('audioObjectName') || '').trim();
    // Use _byLocalName on element for ns-safe child lookup
    const refs = _byLocalName(obj, 'audioPackFormatIDRef').map(r => r.textContent.trim()).filter(Boolean);
    for (const ref of refs) {
      const pf = packTypes.get(ref);
      if (!pf) continue;
      if (/DirectSpeakers/i.test(pf.type)) beds.push({ name: objName || pf.name });
      else if (/Objects/i.test(pf.type)) atmosObjects.push(objName);
    }
  }

  // Speaker labels from all audioBlockFormat elements
  const speakerSet = new Set();
  for (const bf of _byLocalName(xmlDoc, 'audioBlockFormat')) {
    for (const sl of _byLocalName(bf, 'speakerLabel')) {
      const v = (sl.textContent || '').trim();
      if (v) speakerSet.add(v);
    }
  }

  // Map speaker labels to readable names
  const mappedChannels = [...speakerSet].map(_mapSpeakerLabel);
  const _51_SET  = new Set(['L','R','C','LFE','Ls','Rs']);
  const _71_SET  = new Set(['L','R','C','LFE','Ls','Rs','Lss','Rss']);
  const bedChannels = mappedChannels.filter(c => _51_SET.has(c) || _71_SET.has(c));
  const matched51 = bedChannels.filter(c => _51_SET.has(c)).length;
  // is51: at least 5 of 6 standard channels found, OR beds present with no speaker labels (common in companion path)
  const is51 = matched51 >= 5 || (matched51 === 0 && beds.length > 0);
  const is71 = bedChannels.filter(c => _71_SET.has(c)).length >= 7;

  // Programme names
  const programmes = _pullAttrValues(xmlDoc, 'audioProgramme', 'audioProgrammeName');

  return {
    programmes,
    beds,
    atmosObjects,
    bedChannels: [...new Set(bedChannels)],
    speakerLabels: [...speakerSet],
    objectCount: atmosObjects.length,
    bedCount: beds.length,
    isAtmos: atmosObjects.length > 0,
    is51,
    is71,
  };
}

/**
 * Extract ADM programme tree structure from an IAB MXF file.
 * Returns beds (DirectSpeakers), Atmos objects, speaker channel map, and 5.1/7.1 flags.
 */
export async function extractAdmProgrammeTree(file) {
  if (!file) throw new Error('No IAB asset file');
  const xmlText = await _extractEmbeddedAdmXml(file);
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid embedded ADM XML');
  return _parseAdmTree(doc);
}

/**
 * Build an ADM programme tree from pre-extracted name lists (companion path).
 * Simplified — cannot detect speaker labels without raw XML.
 */
export function extractAdmProgrammeTreeFromCompanion({ programmeNames = [], contentNames = [], objectNames = [], packNames = [], objectSummary = {} } = {}) {
  const bedObjects = (objectNames || []).filter(n => /bed|direct.*speaker|5\.1|7\.1|surround/i.test(n));
  const atmosObjects = (objectNames || []).filter(n => !/bed|direct.*speaker/i.test(n) && !/^object\s*\d+$/i.test(n));
  const bedFromSummary = Number(objectSummary?.bedObjects || 0);
  const totalObj = Number(objectSummary?.totalObjects || objectNames.length);
  return {
    programmes: programmeNames || [],
    beds: bedObjects.length ? bedObjects.map(n => ({ name: n })) : (bedFromSummary > 0 ? [{ name: '5.1 Bed' }] : []),
    atmosObjects: atmosObjects.length ? atmosObjects : [],
    bedChannels: bedObjects.length || bedFromSummary ? ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'] : [],
    speakerLabels: [],
    objectCount: totalObj - (bedFromSummary || bedObjects.length),
    bedCount: bedObjects.length || bedFromSummary,
    isAtmos: (totalObj - (bedFromSummary || bedObjects.length)) > 0,
    is51: bedFromSummary > 0 || bedObjects.length > 0,
    is71: false,
  };
}
