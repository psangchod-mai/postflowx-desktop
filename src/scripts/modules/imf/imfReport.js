// scripts/modules/imf/imfReport.js
// P2-REPORT: production-grade IMF QC report EXPORT as PURE functions.
//
// No UI / DOM. These functions take the result rows produced by imf_validator.js
// (validateStructure / validateSchema / validateOPL / validateTTML / validateTimeline)
// and serialize them to:
//   (a) a schema-versioned JSON document  → buildReport() / toJSON()
//   (b) a spreadsheet-friendly CSV         → toCSV()
//
// Every result row is mapped to its authoritative SMPTE reference via its code
// prefix, so the report is self-documenting for downstream QC tooling.
'use strict';

export const REPORT_SCHEMA_VERSION = '1.0.0';

// Result row severities (kept in lock-step with imf_validator.js SEV).
const SEV_ORDER = { fail: 0, warn: 1, info: 2, pass: 3 };

// ── Code → SMPTE reference map ────────────────────────────────────────────────
// Keyed by the code PREFIX (letters before the digits). Every finding code emitted
// by the validator family falls under one of these families.
const CODE_FAMILY = {
  AM:          { doc: 'ASSETMAP',           smpte: 'SMPTE ST 429-9' },
  PKL:         { doc: 'PackingList',        smpte: 'SMPTE ST 429-8 / ST 2067-2' },
  CPL:         { doc: 'CompositionPlaylist', smpte: 'SMPTE ST 2067-3' },
  AUD:         { doc: 'Audio',              smpte: 'SMPTE ST 2067-2 §5.3' },
  PIC:         { doc: 'Picture',            smpte: 'SMPTE ST 2067-2 / ST 2067-21' },
  APP:         { doc: 'Application',        smpte: 'SMPTE ST 2067-20 / ST 2067-21' },
  HDR:         { doc: 'HDR / Mastering',    smpte: 'SMPTE ST 2086 / ST 2094' },
  REEL:        { doc: 'Inter-reel',         smpte: 'SMPTE ST 2067-2' },
  TC:          { doc: 'Timecode',           smpte: 'SMPTE ST 12-1 / ST 2067-3' },
  OPL:         { doc: 'OutputProfileList',  smpte: 'SMPTE ST 2067-100' },
  TT:          { doc: 'Timed Text (TTML/IMSC)', smpte: 'W3C TTML1 / SMPTE ST 2052-1 (IMSC)' },
  TL:          { doc: 'Timeline continuity', smpte: 'SMPTE ST 2067-3 §6 (Segment/Sequence)' },
  UG:          { doc: 'IMF User Group Best Practice', smpte: 'IMF-UG TSP / SMPTE ST 2067-2' },
  PHOTON:      { doc: 'Photon conformance (Netflix/SMPTE)', smpte: 'SMPTE ST 2067 / Netflix IMF' },
  HASH:        { doc: 'PackingList Asset Hash', smpte: 'SMPTE ST 429-8 (SHA-1 / SHA-256)' },
  'SCHEMA-AM': { doc: 'ASSETMAP schema',    smpte: 'SMPTE ST 429-9' },
  'SCHEMA-PKL':{ doc: 'PackingList schema', smpte: 'SMPTE ST 429-8 / ST 2067-2' },
  'SCHEMA-CPL':{ doc: 'CPL schema',         smpte: 'SMPTE ST 2067-3' },
  'SCHEMA-OPL':{ doc: 'OPL schema',         smpte: 'SMPTE ST 2067-100' },
};

// ── Code → plain-English remediation fallback ────────────────────────────────
// Fills the Remediation column when a validator row carries no explicit remediation
// text. Exact-code entries win; a family-prefix entry is the last-resort fallback so
// no FAIL/WARN reaches the report with an empty Remediation column.
const DEFAULT_REMEDIATION = {
  // Exact finding codes.
  AM001:  'Add a <PackingList> asset entry to ASSETMAP.xml so players can locate the PKL.',
  PKL001: 'List the CPL as an <Asset> in the PackingList (PKL) with its UUID, hash, and size.',
  PKL002: 'Ensure every file referenced by the PKL exists on disk at its ASSETMAP path.',
  CPL001: 'Set a valid <EditRate> (e.g. "24 1") in the CompositionPlaylist.',
  CPL002: 'The CPL must include at least one MainImageSequence picture track — add the picture resources.',
  CPL006: 'Fix EntryPoint/SourceDuration/IntrinsicDuration so each resource stays within its track file bounds.',
  // Family-prefix fallbacks.
  AM:  'Correct the ASSETMAP so all package assets are mapped to on-disk paths.',
  PKL: 'Correct the PackingList so every asset is listed with a valid hash and size.',
  CPL: 'Fix the CompositionPlaylist to match the SMPTE ST 2067-3 requirement noted in the message.',
  PIC: 'Correct the picture EssenceDescriptor so resolution, scan type, colour and bit depth match the deliverable requirement in the message.',
  AUD: 'Correct the audio EssenceDescriptor (sample rate, bit depth, channel count) to match the requirement in the message.',
  APP: 'Adjust the package so it conforms to the IMF Application profile (App #2 / #2E / #5) named in the message.',
  HDR: 'Fix the HDR / mastering-display metadata (ST 2086 / ST 2094) as described in the message.',
  REEL: 'Align the inter-reel edit rate and resource boundaries so all reels are continuous per the message.',
  TC: 'Correct the timecode (rate, start address, drop-frame flag) to match the requirement in the message.',
  TL: 'Fix the timeline so every virtual track fully covers the composition duration described in the message.',
  TT: 'Correct the Timed Text (IMSC / TTML) essence — namespace, profile or xml:lang — as noted in the message.',
  OPL: 'Fix the OutputProfileList so it validates against SMPTE ST 2067-100 as described in the message.',
  UG: 'Apply the IMF User Group best-practice noted in the message (advisory, not a hard failure).',
  PHOTON: 'Address the Photon / Netflix conformance issue described in the message.',
  HASH: 'Recompute the asset hash and correct the PackingList so it matches the on-disk file.',
  SCHEMA: 'Fix the XML so it validates against the SMPTE schema — check namespace, element order and required elements named in the message.',
};

// Resolve a code to its family record. SCHEMA-* codes match their 2-segment prefix
// first (SCHEMA-CPL-NS → SCHEMA-CPL); everything else matches its leading letters.
export function smpteForCode(code) {
  const c = String(code || '');
  if (c.startsWith('SCHEMA-')) {
    const key = c.split('-').slice(0, 2).join('-'); // SCHEMA-CPL
    if (CODE_FAMILY[key]) return { code: c, ...CODE_FAMILY[key] };
    return { code: c, doc: 'Schema', smpte: 'SMPTE IMF' };
  }
  const prefix = (c.match(/^[A-Za-z]+/) || [''])[0].toUpperCase();
  if (CODE_FAMILY[prefix]) return { code: c, ...CODE_FAMILY[prefix] };
  return { code: c, doc: 'Unknown', smpte: '' };
}

// Normalise a raw validator row into a stable report row (adds smpte/doc; preserves
// remediation/resourceRef/ref when present).
function normalizeRow(row) {
  const fam = smpteForCode(row.code);
  const out = {
    code: row.code || '',
    severity: row.sev || 'info',
    message: row.msg || '',
    detail: row.detail || '',
    document: fam.doc,
    smpte: fam.smpte,
  };
  const prefix = (String(row.code || '').match(/^[A-Za-z]+/) || [''])[0].toUpperCase();
  // Only apply the code-keyed remediation FALLBACK to actionable rows (fail/warn).
  // An explicit remediation from the validator is always kept; but filling passing
  // rows from the fallback would put contradictory "fix it" text on green checks.
  const actionable = out.severity === 'fail' || out.severity === 'warn';
  const rem = row.remediation || (actionable ? (DEFAULT_REMEDIATION[row.code] || DEFAULT_REMEDIATION[prefix]) : '');
  if (rem) out.remediation = rem;
  if (row.resourceRef) out.resourceRef = row.resourceRef;
  else if (row.ref) out.resourceRef = { kind: 'resource', ...row.ref };
  return out;
}

// Aggregate severity counts.
export function summarize(rows) {
  const counts = { fail: 0, warn: 0, info: 0, pass: 0 };
  for (const r of rows || []) {
    const s = r.sev || r.severity || 'info';
    if (counts[s] != null) counts[s]++;
  }
  const total = (rows || []).length;
  return {
    total,
    fail: counts.fail,
    warn: counts.warn,
    info: counts.info,
    pass: counts.pass,
    // A package "passes QC" only if there are no FAIL rows.
    verdict: counts.fail > 0 ? 'FAIL' : counts.warn > 0 ? 'PASS_WITH_WARNINGS' : 'PASS',
  };
}

// Build the full report object (pure data — no serialization). `meta` is merged into
// the report header (e.g. { packageName, cplId, generatedBy, generatedAt }).
export function buildReport(rows, meta = {}) {
  const normalized = (rows || []).map(normalizeRow);
  // Deterministic ordering: FAIL first, then WARN/INFO/PASS, stable by code within.
  const sorted = normalized
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const sa = SEV_ORDER[a.r.severity] ?? 9;
      const sb = SEV_ORDER[b.r.severity] ?? 9;
      if (sa !== sb) return sa - sb;
      if (a.r.code !== b.r.code) return a.r.code < b.r.code ? -1 : 1;
      return a.i - b.i;
    })
    .map(x => x.r);

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: 'imf-qc-report',
    generatedAt: meta.generatedAt || new Date().toISOString(),
    package: {
      name: meta.packageName || '',
      cplId: meta.cplId || '',
      pklId: meta.pklId || '',
      ...(meta.package || {}),
    },
    summary: summarize(rows),
    findings: sorted,
  };
}

// (a) Schema-versioned JSON string.
export function toJSON(rows, meta = {}, opts = {}) {
  const report = buildReport(rows, meta);
  return JSON.stringify(report, null, opts.pretty === false ? 0 : 2);
}

// CSV field escaping per RFC 4180: wrap in quotes if the value contains a comma,
// quote, CR or LF; double any embedded quotes.
function csvField(v) {
  let s = v == null ? '' : String(v);
  // Neutralize spreadsheet formula injection: prefix a single quote when the
  // cell begins with =, +, -, @, tab or CR (matches reviews/store.js guard).
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// (b) CSV string. Columns are stable/self-documenting; resourceRef is flattened to a
// single human/machine-readable token so it survives a round-trip into a spreadsheet.
export function toCSV(rows, meta = {}) {
  const report = buildReport(rows, meta);
  const header = ['Severity', 'Code', 'SMPTE', 'Document', 'Message', 'Detail', 'Remediation', 'ResourceRef'];
  const lines = [header.map(csvField).join(',')];
  for (const f of report.findings) {
    const rr = f.resourceRef
      ? Object.entries(f.resourceRef)
          .filter(([, v]) => v != null && v !== '')
          .map(([k, v]) => `${k}=${v}`)
          .join(';')
      : '';
    lines.push([
      f.severity.toUpperCase(),
      f.code,
      f.smpte,
      f.document,
      f.message,
      f.detail,
      f.remediation || '',
      rr,
    ].map(csvField).join(','));
  }
  // CRLF line terminator per RFC 4180.
  return lines.join('\r\n');
}
