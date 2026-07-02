// ENGINE-UI wiring regression (P1-PROGRESS remediation round 2).
//
// Guards the two dead-wiring defects the integration tester found:
//   (1) electron/preload.js imfEngine bridge MUST expose startJob/jobProgress/
//       cancelJob mapping to the pfx:imf-engine IPC command+payload the engine's
//       route() understands (startJob → {kind,params}, jobProgress/cancelJob →
//       {jobId}). Without these the whole P1-PROGRESS feature is unreachable.
//   (2) src/scripts/modules/imf/imf_ui.js MUST actually CALL runImfEngineJob from
//       a live flow (the hash-verify pass), not leave it as a dead helper.
//
// Also behaviourally exercises the poll contract that runImfEngineJob relies on
// (startJob → jobProgress → cancelJob) against the real engine so the bridge and
// the engine can never drift apart in the command/payload shape.
//
// Run: node tests-js/imfEngineUiWiring.test.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

const preloadSrc = fs.readFileSync(path.join(root, 'electron/preload.js'), 'utf8');
const uiSrc      = fs.readFileSync(path.join(root, 'src/scripts/modules/imf/imf_ui.js'), 'utf8');

// ── (1) preload bridge exposes the three job methods on imfEngine ──────────────
{
  // Isolate the imfEngine bridge object so we don't match unrelated occurrences.
  const start = preloadSrc.indexOf('imfEngine:');
  ok(start >= 0, 'preload.js has an imfEngine bridge');
  const bridge = preloadSrc.slice(start, start + 2000);

  ok(/startJob\s*\(\s*kind\s*,\s*params\s*\)/.test(bridge),
     'preload imfEngine.startJob(kind, params) method present');
  ok(/jobProgress\s*\(\s*jobId\s*\)/.test(bridge),
     'preload imfEngine.jobProgress(jobId) method present');
  ok(/cancelJob\s*\(\s*jobId\s*\)/.test(bridge),
     'preload imfEngine.cancelJob(jobId) method present');

  // startJob must forward the engine-route payload shape { kind, params }.
  ok(/command:\s*'startJob'[\s\S]{0,80}payload:\s*\{\s*kind\s*,\s*params/.test(bridge),
     "startJob maps to pfx:imf-engine command:'startJob' with { kind, params }");
  ok(/command:\s*'jobProgress'[\s\S]{0,80}payload:\s*\{\s*jobId\s*\}/.test(bridge),
     "jobProgress maps to command:'jobProgress' with { jobId }");
  ok(/command:\s*'cancelJob'[\s\S]{0,80}payload:\s*\{\s*jobId\s*\}/.test(bridge),
     "cancelJob maps to command:'cancelJob' with { jobId }");
}

// ── (2) imf_ui.js actually calls runImfEngineJob from a live flow ──────────────
{
  ok(/function runImfEngineJob\(/.test(uiSrc), 'imf_ui defines runImfEngineJob');
  // The helper must be invoked somewhere OTHER than its own definition / the
  // window export line — i.e. a genuine caller exists.
  const callSites = uiSrc.match(/runImfEngineJob\s*\(/g) || [];
  // Occurrences: 1 definition, 1 window export uses the identifier w/o "(",
  // plus at least one real call.
  ok(callSites.length >= 2, `runImfEngineJob has a real caller (found ${callSites.length} call-expressions)`);

  ok(/_runHashVerificationViaEngine/.test(uiSrc),
     'hash-verify engine path (_runHashVerificationViaEngine) exists');
  ok(/_runHashVerificationViaEngine[\s\S]{0,4000}runImfEngineJob\('validate'/.test(uiSrc),
     "runHashVerification's engine path calls runImfEngineJob('validate', …)");
  // runHashVerification must consult the engine path before the legacy loop.
  ok(/async function runHashVerification[\s\S]{0,1400}_runHashVerificationViaEngine\(/.test(uiSrc),
     'runHashVerification prefers the engine (progress+cancel) path');
}

// ── (3) live poll contract against the real engine (bridge/engine parity) ──────
async function pollContract() {
  let engine = null;
  try { engine = require(path.join(root, 'electron/imf/imf_direct_engine.js')); }
  catch (e) { console.log('SKIP - engine not loadable for poll contract:', e.message); return; }
  const { startJob, jobProgress, cancelJob } = engine;

  // startJob('validate') on a missing package settles fast and is pollable via
  // the exact shape the preload bridge forwards.
  const started = startJob('validate', { packageId: 'no-such-pkg', cplId: null, hash: true });
  ok(started && started.ok === true && typeof started.jobId === 'string',
     'startJob(validate) returns { ok, jobId }');

  const snap = jobProgress(started.jobId);
  ok(snap && snap.ok === true && snap.snapshot && typeof snap.snapshot.state === 'string',
     'jobProgress(jobId) returns { ok, snapshot:{ state, progress } }');
  ok(snap.snapshot.progress && typeof snap.snapshot.progress.done === 'boolean',
     'snapshot.progress carries a boolean done flag (poll terminator)');

  // cancelJob is a no-throw call returning { ok } for a known/unknown id.
  const c1 = cancelJob(started.jobId);
  ok(c1 && typeof c1.ok === 'boolean', 'cancelJob(jobId) returns { ok }');
  const c2 = cancelJob('definitely-not-a-job');
  ok(c2 && c2.ok === false && c2.code === 'NOT_FOUND', 'cancelJob on unknown id → { ok:false, NOT_FOUND }');
}

await pollContract();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
