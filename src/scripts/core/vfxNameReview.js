// Deterministic VFX shot-name suggestions and duplicate protection.
// Pure helpers live outside Pull Prep so naming behaviour is easy to test and
// does not depend on the renderer, localStorage, or a mutable global counter.

export function normalizeVfxName(value) {
  const normalized = String(value ?? '')
    .trim()
    .replace(/\.[a-z0-9]{1,8}$/i, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toUpperCase();
  const parts = normalized.split('_');
  if (parts[0] === 'MMBLR') parts[0] = 'BLR';
  return parts.join('_');
}

function normalizePlateId(value = 'PL01') {
  const token = normalizeVfxName(value).replace(/^_+|_+$/g, '');
  const match = token.match(/^([A-Z][A-Z0-9]*?)(\d{1,3})$/);
  if (!match) return 'PL01';
  return `${match[1]}${String(Number(match[2])).padStart(2, '0')}`;
}

export function normalizeVfxVersion(value = 'v001') {
  const match = String(value ?? '').trim().match(/(\d{1,4})/);
  const number = match ? Number(match[1]) : 1;
  return `v${String(Math.max(1, number)).padStart(3, '0')}`;
}

export function splitVfxPlateName(value) {
  const raw = String(value ?? '').trim();
  const withoutExtension = raw.replace(/\.[a-z0-9]{1,8}$/i, '');
  const frameMatch = withoutExtension.match(/^(.*)\.(\d{3,9})$/);
  const normalized = normalizeVfxName(frameMatch ? frameMatch[1] : withoutExtension);
  const plateMatch = normalized.match(/^(.*)_([A-Z][A-Z0-9]*?\d{1,3})_(V\d{1,4})$/)
    || normalized.match(/^(.*)_([A-Z][A-Z0-9]*?\d{1,3})$/);
  if (!plateMatch) {
    return { shotName: normalized, plateId: '', version: '', frame: frameMatch?.[2] || '' };
  }
  return {
    shotName: plateMatch[1],
    plateId: normalizePlateId(plateMatch[2]),
    version: plateMatch[3] ? normalizeVfxVersion(plateMatch[3]) : '',
    frame: frameMatch?.[2] || '',
  };
}

export function associatedVfxShotName(value) {
  return splitVfxPlateName(value).shotName;
}

export function buildNetflixPlateName(shotOrPlate, plateId = '', version = '') {
  const parsed = splitVfxPlateName(shotOrPlate);
  const shotName = parsed.shotName || 'BLR_101_010';
  const resolvedPlate = normalizePlateId(plateId || parsed.plateId || 'PL01');
  const resolvedVersion = normalizeVfxVersion(version || parsed.version || 'v001');
  return `${shotName}_${resolvedPlate}_${resolvedVersion}`;
}

function isValidShotStem(value) {
  // BLR's existing three-field project convention is supported, while the
  // four/five-field forms cover Netflix's scene/sequence recommendations.
  if (/^BLR_\d{3}_\d{3,4}$/.test(value)) return true;
  return /^[A-Z][A-Z0-9]{1,5}_\d{3}(?:_[A-Z0-9]{2,4})?_\d{3}_\d{3,4}$/.test(value);
}

export function isValidNetflixVfxName(value) {
  const raw = String(value ?? '').trim();
  if (!raw || /\s/.test(raw) || /[^A-Za-z0-9._-]/.test(raw) || /^MMBLR_/i.test(raw)) return false;

  const fileMatch = raw.match(/^(.*)\.(\d{3,9})\.([a-z0-9]{2,8})$/i);
  const stem = normalizeVfxName(fileMatch ? fileMatch[1] : raw);
  // Version deliveries: <shot>_<task>_<vendor>_v###. Check these before
  // plate parsing so the final V001 token is not mistaken for a plate ID.
  const versionMatch = stem.match(/^(.*)_[A-Z][A-Z0-9-]*_[A-Z][A-Z0-9-]*_V\d{3,4}$/);
  if (versionMatch && isValidShotStem(versionMatch[1])) return true;

  const plate = splitVfxPlateName(stem);
  if (plate.plateId) {
    return Boolean(plate.version) && isValidShotStem(plate.shotName);
  }
  if (isValidShotStem(stem)) return true;

  return false;
}

export function canonicalVfxName(value) {
  return normalizeVfxName(value).toLocaleUpperCase('en-US');
}

export function duplicateVfxNameGroups(records = []) {
  const groups = new Map();
  records.forEach((record, index) => {
    const name = canonicalVfxName(record?.name ?? record?.shotName ?? record);
    if (!name) return;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({ index, record });
  });
  return new Map([...groups].filter(([, items]) => items.length > 1));
}

function incrementLastNumber(name, step, pad) {
  const match = String(name).match(/^(.*?)(\d+)([^\d]*)$/);
  if (!match) return null;
  const next = Number(match[2]) + step;
  const width = Math.max(match[2].length, pad);
  return `${match[1]}${String(next).padStart(width, '0')}${match[3]}`;
}

export function nextUniqueVfxName(preferred, occupiedNames = [], options = {}) {
  const step = Math.max(1, Number(options.step) || 10);
  const pad = Math.max(2, Math.min(6, Number(options.pad) || 3));
  const occupied = new Set([...occupiedNames].map(canonicalVfxName).filter(Boolean));
  let candidate = normalizeVfxName(preferred) || `VFX_${String(step).padStart(pad, '0')}`;
  candidate = candidate.replace(/_V(\d{3,4})(?=$|_)/g, '_v$1');
  if (!occupied.has(canonicalVfxName(candidate))) return candidate;

  // Keep production naming patterns intact. PL01 becomes PL02; a shot token
  // such as 060 becomes 070. Only add a suffix when no numeric token exists.
  const plateMatch = candidate.match(/^(.*_(?:PL|BG|FG|EL|MT|TX))(\d{2,3})(.*)$/i);
  if (plateMatch) {
    let plate = Number(plateMatch[2]);
    for (let attempt = 0; attempt < 999; attempt += 1) {
      plate += 1;
      const next = `${plateMatch[1]}${String(plate).padStart(plateMatch[2].length, '0')}${plateMatch[3]}`;
      if (!occupied.has(canonicalVfxName(next))) return next;
    }
  }

  let numericCandidate = candidate;
  for (let attempt = 0; attempt < 999; attempt += 1) {
    numericCandidate = incrementLastNumber(numericCandidate, step, pad);
    if (!numericCandidate) break;
    if (!occupied.has(canonicalVfxName(numericCandidate))) return numericCandidate;
  }

  const base = candidate;
  for (let sequence = step; sequence < step * 1000; sequence += step) {
    const next = `${base}_${String(sequence).padStart(pad, '0')}`;
    if (!occupied.has(canonicalVfxName(next))) return next;
  }
  return `${base}_${Date.now()}`;
}

export function buildTimelineVfxName({ event = {}, index = 0, template = {}, occupiedNames = [] } = {}) {
  const position = Math.max(0, Number(index) || 0);
  const start = Number.isFinite(Number(template.start)) ? Number(template.start) : 10;
  const step = Math.max(1, Number(template.step) || 10);
  const pad = Math.max(2, Math.min(6, Number(template.pad) || 3));
  const parts = [];

  if (template.showOn !== false && template.show) parts.push(normalizeVfxName(template.show));
  if (template.episodeOn !== false && template.episode) {
    const episode = /^\d+$/.test(String(template.episode))
      ? String(Number(template.episode)).padStart(3, '0')
      : normalizeVfxName(template.episode);
    parts.push(episode);
  }
  if (template.sequenceOn && template.sequence) parts.push(normalizeVfxName(template.sequence));
  if (template.sceneOn && template.scene) {
    const scene = /^\d+$/.test(String(template.scene))
      ? String(Number(template.scene)).padStart(3, '0')
      : normalizeVfxName(template.scene);
    parts.push(scene);
  }

  const shotNumber = start + (position * step);
  if (parts.length) {
    parts.push(String(shotNumber).padStart(pad, '0'));
  } else {
    // Camera reel names are unstable editorial identifiers, not VFX shot names.
    // Use a neutral timeline-based name until a show template is configured.
    const project = normalizeVfxName(template.project || '');
    const safeProject = project && !/^(TEST|UNTITLED|PROJECT|TIMELINE)$/.test(project)
      ? project.slice(0, 16)
      : 'BLR';
    parts.push(safeProject, String(shotNumber).padStart(pad, '0'));
  }

  return nextUniqueVfxName(parts.filter(Boolean).join('_'), occupiedNames, { step, pad });
}

if (typeof window !== 'undefined') {
  window.PFX_VFX_NAMING = {
    associatedVfxShotName,
    buildNetflixPlateName,
    isValidNetflixVfxName,
    normalizeVfxName,
    normalizeVfxVersion,
    splitVfxPlateName,
  };
}
