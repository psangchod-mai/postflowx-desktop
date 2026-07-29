import assert from 'node:assert/strict';
import test from 'node:test';
import { ExrExportQueue, JOB_STATUS } from '../src/scripts/smart/smartExrExportQueue.js';

// Controls when the fake native dispatch resolves, so the test can call
// cancel() while _runJob is suspended mid-await — mirroring a user clicking
// Cancel on a shot whose export request is already in flight.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('cancelling a job mid-export must not let the in-flight result overwrite CANCELLED', async () => {
  const queue = new ExrExportQueue();
  const gate = deferred();
  queue.setNativeDispatch(async () => gate.promise);

  queue.addJobs([{ plateName: 'shot_010', shotId: 'shot_010' }]);
  const startPromise = queue.start();

  // Let _runJob progress to the point where it's awaiting _nativeDispatch.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(queue.getJob('shot_010').status, JOB_STATUS.EXPORTING);

  queue.cancel('shot_010');
  assert.equal(queue.getJob('shot_010').status, JOB_STATUS.CANCELLED);

  // Now let the stale dispatch resolve — on the pre-fix code this silently
  // flips the job to QC_PASSED/QC_FAILED, clobbering the cancellation.
  gate.resolve({ framesExported: 24 });
  await startPromise;

  const job = queue.getJob('shot_010');
  assert.equal(job.status, JOB_STATUS.CANCELLED, `cancelled job status must survive a late dispatch resolution, got ${job.status}`);
  assert.equal(job.result, null, 'a cancelled job must not pick up the stale export result');
});
