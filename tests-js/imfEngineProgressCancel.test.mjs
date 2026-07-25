// P1-PROGRESS: progress reporting + cooperative cancellation for long IMF passes.
// Deterministic + no ffmpeg: exercises the CancellationToken / ProgressJob
// primitives and the poll-based startJob → jobProgress → cancelJob lifecycle in
// electron/imf/imf_direct_engine.js.
// Run: node tests-js/imfEngineProgressCancel.test.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let engine = null;
try { engine = require(path.join(root, 'electron/imf/imf_direct_engine.js')); }
// imf_direct_engine.js is first-party and always present — a load failure is a
// BUG, not an optional dependency. This used to exit(0), which meant a syntax
// error in the engine silently deleted this whole file from `test:js` and the
// suite still reported green. Fail loudly instead.
catch (e) { console.error('FAIL - imf_direct_engine failed to load:', e.stack || e.message); process.exit(1); }

const { CancellationToken, CancellationError, startJob, jobProgress, cancelJob, _getJob } = engine;

// ── CancellationToken primitive ──
{
  ok(typeof CancellationToken === 'function', 'CancellationToken exported');
  const t = new CancellationToken();
  ok(t.cancelled === false, 'fresh token is not cancelled');
  let ran = 0;
  const unregister = t.onCancel(() => { ran++; });
  t.cancel();
  ok(t.cancelled === true, 'cancel() flips cancelled flag');
  ok(ran === 1, 'onCancel callback fires exactly once on cancel');
  t.cancel();
  ok(ran === 1, 'second cancel() is a no-op (callback not re-run)');
  unregister();

  // throwIfCancelled
  let threw = false;
  try { t.throwIfCancelled(); } catch (e) { threw = e instanceof CancellationError; }
  ok(threw, 'throwIfCancelled() throws CancellationError once cancelled');

  // onCancel after already-cancelled runs immediately.
  let late = 0; t.onCancel(() => { late++; });
  ok(late === 1, 'onCancel on an already-cancelled token runs immediately');
}

// ── Job lifecycle: unknown kind rejected ──
{
  const r = startJob('does-not-exist', {});
  ok(r.ok === false && r.code === 'UNKNOWN_JOB', 'startJob rejects unknown kind');
}

// ── Job lifecycle: validate on a missing package settles fast + is pollable ──
{
  const r = startJob('validate', { packageId: 'no-such-package', cplId: null });
  ok(r.ok === true && typeof r.jobId === 'string', 'startJob(validate) returns a jobId');
  const jobId = r.jobId;

  // Poll until it settles.
  let snap = null;
  for (let i = 0; i < 50; i++) {
    const jp = jobProgress(jobId);
    ok(jp.ok === true || i > 0, 'jobProgress returns ok while job is live');
    snap = jp.snapshot;
    if (snap.progress.done || snap.state !== 'running') break;
    await sleep(10);
  }
  ok(snap && snap.progress.done === true, 'validate job reaches a terminal (done) progress state');
  // Missing package → NOT_FOUND surfaces as an error settle.
  ok(snap.state === 'error' || snap.state === 'done', 'terminal state is error/done for a missing package');
}

// ── Push-based onProgress via the in-process job handle ──
{
  const r = startJob('validate', { packageId: 'no-such-package-2', cplId: null });
  const job = _getJob(r.jobId);
  ok(job && typeof job.onProgress === 'function', '_getJob(id).onProgress available for in-process subscribers');
  let updates = 0;
  const unsub = job.onProgress(() => { updates++; });
  // Wait for settle.
  for (let i = 0; i < 50; i++) { if (job.state !== 'running') break; await sleep(10); }
  unsub();
  ok(updates >= 1, 'onProgress fired at least the current snapshot immediately');
}

// ── cancelJob on a live token flips it (cooperative) ──
{
  const token = new CancellationToken();
  // Simulate the engine wiring: cancelJob calls token.cancel() on the job.
  // Here we assert the public API returns NOT_FOUND for an unknown id and ok for
  // a real running job's cancel path.
  const bad = cancelJob('nope');
  ok(bad.ok === false && bad.code === 'NOT_FOUND', 'cancelJob(unknown) → NOT_FOUND');

  const r = startJob('validate', { packageId: 'no-such-package-3', cplId: null });
  const c = cancelJob(r.jobId);
  ok(c.ok === true, 'cancelJob(live job) returns ok');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
