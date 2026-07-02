// P2-REPORT + P2-ACTIONABLE: report export + enriched rows. Run: node tests-js/imfReport.test.mjs
import { buildReport, toJSON, toCSV, summarize, smpteForCode, REPORT_SCHEMA_VERSION }
  from '../src/scripts/modules/imf/imfReport.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

// Raw validator rows (mix of families + P2-ACTIONABLE fields).
const ROWS = [
  { sev: 'pass', code: 'AM001', msg: 'ASSETMAP references a PackingList', detail: '' },
  { sev: 'fail', code: 'PKL002', msg: 'Missing file: video.mxf', detail: 'UUID: x',
    ref: { trackFileId: 'x' } },
  { sev: 'warn', code: 'CPL,012', msg: 'ContentKind "weird", not standard', detail: 'has, commas',
    remediation: 'Use a standard ContentKind', resourceRef: { kind: 'cpl', id: 'urn:uuid:c' } },
  { sev: 'fail', code: 'TL004', msg: 'Tracks differ', detail: 'v: 200 | a: 150',
    resourceRef: { kind: 'cpl', id: 'urn:uuid:c' }, remediation: 'Align tracks' },
  { sev: 'info', code: 'SCHEMA-CPL-NS', msg: 'CPL conforms to ST 2067-3', detail: '' },
  { sev: 'fail', code: 'OPL004', msg: 'Dangling handle', detail: 'ghost',
    resourceRef: { kind: 'opl', id: 'urn:uuid:o' } },
];

// ── smpteForCode maps families ──
{
  ok(smpteForCode('AM001').smpte === 'SMPTE ST 429-9', 'AM → ST 429-9');
  ok(smpteForCode('TL004').smpte.includes('2067-3'), 'TL → ST 2067-3');
  ok(smpteForCode('OPL001').smpte === 'SMPTE ST 2067-100', 'OPL → ST 2067-100');
  ok(smpteForCode('TT002').smpte.includes('IMSC'), 'TT → IMSC');
  ok(smpteForCode('SCHEMA-CPL-NS').smpte === 'SMPTE ST 2067-3', 'SCHEMA-CPL → ST 2067-3');
  ok(smpteForCode('ZZZ9').doc === 'Unknown', 'unknown prefix → Unknown');
}

// ── summarize ──
{
  const s = summarize(ROWS);
  ok(s.total === 6 && s.fail === 3 && s.warn === 1 && s.info === 1 && s.pass === 1, 'summary counts correct');
  ok(s.verdict === 'FAIL', 'verdict FAIL when any fail present');
  ok(summarize([{ sev: 'warn' }]).verdict === 'PASS_WITH_WARNINGS', 'verdict PASS_WITH_WARNINGS');
  ok(summarize([{ sev: 'pass' }]).verdict === 'PASS', 'verdict PASS when clean');
}

// ── buildReport structure + ordering ──
{
  const rep = buildReport(ROWS, { packageName: 'TestIMP', cplId: 'urn:uuid:c' });
  ok(rep.schemaVersion === REPORT_SCHEMA_VERSION, 'report carries schemaVersion');
  ok(rep.kind === 'imf-qc-report', 'report kind set');
  ok(rep.package.name === 'TestIMP', 'package name propagated');
  ok(rep.summary.fail === 3, 'summary embedded');
  // FAIL rows sort first.
  ok(rep.findings[0].severity === 'fail', 'findings sorted: FAIL first');
  ok(rep.findings[rep.findings.length - 1].severity === 'pass', 'PASS last');
  // Each finding enriched with smpte + document.
  ok(rep.findings.every(f => f.smpte !== undefined && f.document !== undefined), 'every finding has smpte+document');
  // legacy ref promoted to resourceRef.
  const pkl = rep.findings.find(f => f.code === 'PKL002');
  ok(pkl.resourceRef && pkl.resourceRef.trackFileId === 'x', 'legacy ref promoted to resourceRef');
}

// ── toJSON round-trips ──
{
  const json = toJSON(ROWS, { packageName: 'TestIMP' });
  const parsed = JSON.parse(json);
  ok(parsed.findings.length === 6, 'JSON parses with all findings');
  ok(parsed.schemaVersion === REPORT_SCHEMA_VERSION, 'JSON schemaVersion');
}

// ── toCSV: header + escaping ──
{
  const csv = toCSV(ROWS, { packageName: 'TestIMP' });
  const lines = csv.split('\r\n');
  ok(lines[0] === 'Severity,Code,SMPTE,Document,Message,Detail,Remediation,ResourceRef', 'CSV header correct');
  ok(lines.length === 7, 'CSV has header + 6 rows');
  // Row with commas/quotes must be quoted.
  const cplLine = lines.find(l => l.includes('CPL,012') || l.includes('"CPL,012"'));
  ok(csv.includes('"CPL,012"'), 'code containing comma is quoted');
  ok(csv.includes('"has, commas"'), 'detail containing comma is quoted');
  // resourceRef flattened.
  ok(csv.includes('kind=cpl;id=urn:uuid:c'), 'resourceRef flattened into token');
  ok(csv.includes('kind=resource;trackFileId=x'), 'legacy ref flattened');
}

// ── Robustness: empty rows ──
{
  ok(buildReport([]).findings.length === 0, 'empty rows → empty findings');
  ok(toCSV([]).split('\r\n').length === 1, 'empty rows → header-only CSV');
  ok(JSON.parse(toJSON([])).summary.total === 0, 'empty rows → total 0');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
