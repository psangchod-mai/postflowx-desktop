// OCF preview error-pane HTML builder. Run: node tests-js/ocfErrorPane.test.mjs
import { buildOcfErrorPaneHtml, buildOcfStripCellHtml, buildOcfEngineRequiredHtml } from '../src/scripts/features/vfxPull/ocfErrorPane.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

// ── Resolve connected: shows stage + diagnostic button ──
const conn = buildOcfErrorPaneHtml({ stage: 'render_timeout', resolveConnected: true });
ok(conn.includes('OCF linked, but preview frame cannot be decoded'), 'connected: headline present');
ok(conn.includes('Resolve Engine is connected but extraction failed'), 'connected: status message');
ok(conn.includes('Stage: render_timeout.'), 'connected: stage shown');
ok(conn.includes('data-ocf-action="test-resolve"'), 'connected: Test Resolve Still button present');
ok(conn.includes('data-ocf-action="retry"') && conn.includes('data-ocf-action="use-ffmpeg"'), 'retry + ffmpeg buttons always present');

// ── Not connected: no diagnostic button, generic message ──
const dis = buildOcfErrorPaneHtml({ stage: 'connect', resolveConnected: false });
ok(dis.includes('Check console for details'), 'disconnected: generic message');
ok(!dis.includes('data-ocf-action="test-resolve"'), 'disconnected: no Test Resolve button');
ok(!dis.includes('Stage:'), 'disconnected: stage not shown');
ok(dis.includes('data-ocf-action="retry"') && dis.includes('data-ocf-action="use-ffmpeg"'), 'disconnected still has retry + ffmpeg');

// ── No stage → no "Stage:" fragment ──
ok(!buildOcfErrorPaneHtml({ resolveConnected: true }).includes('Stage:'), 'empty stage → no Stage fragment');

// ── Escaping: a malicious stage string cannot inject markup ──
const evil = buildOcfErrorPaneHtml({ stage: '<img src=x onerror=alert(1)>', resolveConnected: true });
ok(!evil.includes('<img'), 'stage is HTML-escaped (no raw <img>)');
ok(evil.includes('&lt;img'), 'stage escaped to entities');

// ── defaults (no args) ──
ok(buildOcfErrorPaneHtml().includes('Check console for details'), 'no args → safe disconnected default');

// ── strip cell ──
const cell = buildOcfStripCellHtml({ label: 'In', stage: 'render_timeout', error: 'too slow' });
ok(cell.includes('>In<'), 'strip cell shows position label');
ok(cell.includes('>render_timeout<'), 'strip cell shows stage as label');
ok(cell.includes('title="too slow"'), 'strip cell error in tooltip');
ok(buildOcfStripCellHtml({ label: 'Out', stage: 'unknown' }).includes('>decode error<'), 'unknown stage → "decode error"');
ok(buildOcfStripCellHtml({ label: 'Out' }).includes('>decode error<'), 'no stage → "decode error"');
const evilCell = buildOcfStripCellHtml({ label: '<b>x', stage: '<script>', error: '"><img onerror=1>' });
ok(!evilCell.includes('<script>') && !evilCell.includes('<img'), 'strip cell escapes label/stage/error');

// ── engine-required ("Start Resolve") pane ──
const raw = buildOcfEngineRequiredHtml({ rawLabel: 'RED R3D RAW', isRaw: true });
ok(raw.includes('This shot is linked correctly'), 'engine-req: linked-correctly message');
ok(raw.includes('<b>RED R3D RAW</b>'), 'engine-req: rawLabel shown');
ok(raw.includes('data-ocf-action="start-resolve"') && raw.includes('data-ocf-action="retry"'), 'engine-req: start-resolve + retry');
ok(!raw.includes('use-ffmpeg'), 'camera-RAW → no "Try FFmpeg anyway" (would always fail)');
ok(raw.includes('approve and export this shot without a preview'), 'engine-req: export-anyway hint');
ok(buildOcfEngineRequiredHtml({ rawLabel: 'MXF', isRaw: false }).includes('Try FFmpeg anyway'),
   'non-RAW → "Try FFmpeg anyway" offered');
ok(!buildOcfEngineRequiredHtml({ rawLabel: '<img src=x>' }).includes('<img'), 'engine-req: rawLabel escaped');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
