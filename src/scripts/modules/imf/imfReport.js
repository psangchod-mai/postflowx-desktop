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
  'SCHEMA-AM': { doc: 'ASSETMAP schema',    smpte: 'SMPTE ST 429-9' },
  'SCHEMA-PKL':{ doc: 'PackingList schema', smpte: 'SMPTE ST 429-8 / ST 2067-2' },
  'SCHEMA-CPL':{ doc: 'CPL schema',         smpte: 'SMPTE ST 2067-3' },
  'SCHEMA-OPL':{ doc: 'OPL schema',         smpte: 'SMPTE ST 2067-100' },
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
  if (row.remediation) out.remediation = row.remediation;
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
  const s = v == null ? '' : String(v);
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
