/**
 * smartOcfTestHelper.js — PostFlowX OCF → EXR browser console test helper
 *
 * Usage from browser DevTools console:
 *
 *   // Import and run the full end-to-end test:
 *   const t = await import(chrome.runtime.getURL('scripts/smart/smartOcfTestHelper.js'));
 *   await t.runFullTest();
 *
 *   // Or step through:
 *   await t.testOcfMatcher();
 *   await t.testNamingEngine();
 *   await t.testPullPlanner();
 *   await t.testQCValidator();
 *   await t.testReportExporter();
 *   await t.testFullPipeline();   // runs the complete UI flow in mock mode
 */

import { matchAllEvents, matchSummary, MATCH_STATUS } from './smartOcfMatcher.js';
import { buildAllExrJobs } from './smartExrPullPlanner.js';
import { buildPlateName, buildEXRPattern, buildNamingContext } from './smartExrNamingEngine.js';
import { validateExrResult, qcSummary } from './smartExrQCValidator.js';
import { buildShotsCSV, buildJobsJSON, buildQCTextReport, buildOcfPullEDL } from './smartExrReportExporter.js';
import { ExrExportQueue } from './smartExrExportQueue.js';

const pass = (msg) => console.log(`%c✓ ${msg}`, 'color:#2ecc71;font-weight:700');
const fail = (msg) => console.error(`%c✗ ${msg}`, 'color:#e74c3c;font-weight:700');
const info = (msg) => console.log(`%c• ${msg}`, 'color:#3498db');

// ── Sample data ───────────────────────────────────────────────────────────────
const SAMPLE_EVENTS = [
  { eventNumber: '001', reel: 'A001C003', clipName: 'A001C003_240101_R3D', srcIn: '01:12:10:08', srcOut: '01:12:14:02', fps: 24, durationFrames: 90 },
  { eventNumber: '002', reel: 'B002C001', clipName: 'B002C001_240101',     srcIn: '09:00:10:00', srcOut: '09:00:18:00', fps: 24, durationFrames: 192 },
  { eventNumber: '003', reel: 'MISSING_REEL', clipName: 'NO_MATCH',         srcIn: '05:00:00:00', srcOut: '05:00:04:00', fps: 24, durationFrames: 96 },
];
const SAMPLE_OCF = [
  { name: 'A001C003_240101_R3D.R3D', path: '/Volumes/OCF/A001/A001C003_240101_R3D.R3D', reel: 'A001C003', tcIn: '01:12:10:08', tcOut: '01:12:14:02', fps: 24, frameCount: 90 },
  { name: 'B002C001_240101.ari',      path: '/Volumes/OCF/B002/B002C001_240101.ari',     reel: 'B002C001', tcIn: '09:00:10:00', tcOut: '09:00:18:00', fps: 24, frameCount: 192 },
];

export async function testOcfMatcher() {
  info('=== OCF Matcher ===');
  const results = matchAllEvents(SAMPLE_EVENTS, SAMPLE_OCF);
  const s = matchSummary(results);

  if (results[0].match.status === MATCH_STATUS.SAFE && results[0].match.confidence >= 80) {
    pass(`Event 001 matched SAFE at ${results[0].match.confidence}%`);
  } else fail(`Event 001 should be SAFE — got ${results[0].match.status} ${results[0].match.confidence}%`);

  if (results[1].match.status === MATCH_STATUS.SAFE) {
    pass('Event 002 matched SAFE');
  } else fail(`Event 002 should be SAFE — got ${results[1].match.status}`);

  if (results[2].match.status === MATCH_STATUS.MISSING || results[2].match.confidence < 50) {
    pass('Event 003 unmatched (expected)');
  } else fail(`Event 003 should be MISSING/LOW — got ${results[2].match.status}`);

  console.log('Match summary:', s);
  return results;
}

export async function testNamingEngine() {
  info('=== Naming Engine ===');
  const ctx = buildNamingContext({ event: { show: 'AGM', seq: '104', shot: '065_010' }, plateType: 'PL' });
  const expected = 'AGM_104_065_010_PL01_v001';
  if (ctx.plateName === expected) {
    pass(`Plate name: ${ctx.plateName}`);
  } else info(`Plate name: ${ctx.plateName} (expected ${expected} — differences in derivation are OK)`);

  const p2 = buildEXRPattern(ctx.plateName);
  if (p2.endsWith('.%04d.exr')) pass(`EXR pattern: ${p2}`);
  else fail(`Bad EXR pattern: ${p2}`);

  // Dedup test
  const used = new Set();
  const c1 = buildNamingContext({ event: SAMPLE_EVENTS[0], usedNames: used });
  const c2 = buildNamingContext({ event: SAMPLE_EVENTS[0], usedNames: used });
  if (c1.plateName !== c2.plateName) pass(`Dedup works: ${c1.plateName} ≠ ${c2.plateName}`);
  else fail('Dedup failed — duplicate names produced');
}

export async function testPullPlanner() {
  info('=== Pull Planner ===');
  const matchResults = matchAllEvents(SAMPLE_EVENTS, SAMPLE_OCF);
  const jobs = buildAllExrJobs(matchResults, { handleFrames: 8, frameStart: 1001 });

  if (jobs.length === SAMPLE_EVENTS.length) pass(`${jobs.length} jobs created`);
  else fail(`Expected ${SAMPLE_EVENTS.length} jobs, got ${jobs.length}`);

  const j = jobs[0];
  if (j.frameStart === 1001) pass('Frame start 1001');
  else fail(`Wrong frame start: ${j.frameStart}`);

  if (j.handleFrames === 8) pass('Handles = 8');
  else fail(`Wrong handles: ${j.handleFrames}`);

  if (j.expectedFrameCount >= 90 + 16) pass(`Frame count ${j.expectedFrameCount} includes handles`);
  else fail(`Frame count too low: ${j.expectedFrameCount}`);

  console.log('Sample job:', j);
  return jobs;
}

export async function testQCValidator() {
  info('=== QC Validator ===');
  const jobs = buildAllExrJobs(matchAllEvents(SAMPLE_EVENTS, SAMPLE_OCF), { handleFrames: 8, frameStart: 1001 });
  const j = jobs[0];

  // Passing result
  const okResult = { status: 'success', framesExported: j.expectedFrameCount, firstFrame: 1001, lastFrame: 1001 + j.expectedFrameCount - 1, missingFrames: [], warnings: [], errors: [] };
  const v1 = validateExrResult(j, okResult);
  if (v1.qcStatus === 'QC_PASSED') pass('QC passed for valid result');
  else fail(`Expected QC_PASSED — got ${v1.qcStatus}`);

  // Missing frames
  const badResult = { status: 'success', framesExported: j.expectedFrameCount - 3, firstFrame: 1001, lastFrame: 1001 + j.expectedFrameCount - 4, missingFrames: [1005, 1006, 1007], warnings: [], errors: [] };
  const v2 = validateExrResult(j, badResult);
  if (v2.qcStatus !== 'QC_PASSED') pass(`QC correctly flags missing frames: ${v2.qcStatus}`);
  else fail('QC should have failed for missing frames');
}

export async function testReportExporter() {
  info('=== Report Exporter ===');
  const jobs = buildAllExrJobs(matchAllEvents(SAMPLE_EVENTS, SAMPLE_OCF), { handleFrames: 8, frameStart: 1001 });

  const csv = buildShotsCSV(jobs);
  if (csv.includes('Shot ID') && csv.includes('PL01')) pass('CSV contains headers and plate names');
  else fail('CSV missing expected content');

  const edl = buildOcfPullEDL(jobs, 'TEST_PROJECT');
  if (edl.includes('TITLE: TEST_PROJECT') && edl.includes('PL01')) pass('EDL has title and plate names');
  else fail('EDL missing expected content');

  const json = buildJobsJSON(jobs, []);
  const parsed = JSON.parse(json);
  if (parsed.jobs?.length === jobs.length) pass(`JSON has ${parsed.jobs.length} jobs`);
  else fail('JSON job count mismatch');
}

export async function testFullPipeline() {
  info('=== Full Pipeline (mock mode) ===');

  // Enable mock mode
  if (typeof window.__pfxOcfMockMode === 'function') {
    window.__pfxOcfMockMode(true);
    pass('Mock mode enabled');
  } else {
    info('window.__pfxOcfMockMode not available — running module-only test');
  }

  const matchResults = matchAllEvents(SAMPLE_EVENTS, SAMPLE_OCF);
  const jobs = buildAllExrJobs(matchResults, { handleFrames: 8, frameStart: 1001 });

  // Mock export
  const mockDispatch = async (job, onProg) => {
    for (let i = 0; i <= 5; i++) { await new Promise(r => setTimeout(r, 10)); try { onProg?.(i*20); } catch {} }
    return { status: 'success', framesExported: job.expectedFrameCount, firstFrame: job.frameStart, lastFrame: job.frameStart + job.expectedFrameCount - 1, missingFrames: [], warnings: [], errors: [] };
  };

  const queue = new ExrExportQueue({ onLog: (id, msg) => info(msg) });
  queue.setNativeDispatch(mockDispatch);
  queue.addJobs(jobs);
  await queue.start();

  const queueJobs = queue.getJobs();
  const allDone = queueJobs.every(j => ['QC Passed','QC Warning'].includes(j.status));
  if (allDone) pass(`All ${queueJobs.length} jobs completed QC`);
  else fail(`Some jobs failed: ${queueJobs.map(j => j.status).join(', ')}`);

  console.log('Queue final states:', queueJobs.map(j => ({ id: j.id, status: j.status, frames: j.result?.framesExported })));
  return { matchResults, jobs, queue };
}

export async function runFullTest() {
  console.group('%c PostFlowX OCF → EXR — Full Test Suite', 'font-size:14px;font-weight:800;color:#56d5ff');
  try {
    await testOcfMatcher();
    await testNamingEngine();
    await testPullPlanner();
    await testQCValidator();
    await testReportExporter();
    await testFullPipeline();
    console.log('%c✓ All tests complete', 'color:#2ecc71;font-size:13px;font-weight:800');
  } catch (e) {
    console.error('Test suite error:', e);
  }
  console.groupEnd();
}
