import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);

// electron/companion.js is CommonJS and does
// `const { spawn } = require('child_process');` at module-load time. Swap out
// child_process's spawn on the shared, cached module object *before*
// companion.js is first required, so its destructured `spawn` binds to our
// fake and we never touch a real subprocess.
const cp = require('child_process');

function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: () => {} };
  proc.killed = false;
  proc.kill = function (signal) { this.killed = true; this.killSignal = signal; };
  return proc;
}

const spawnedProcs = [];
cp.spawn = () => {
  const proc = makeFakeProc();
  spawnedProcs.push(proc);
  return proc;
};

const companion = require('../electron/companion.js');

test('start() kills and clears the subprocess after both startup-probe retries fail', async () => {
  companion._waitReady = () => Promise.reject(new Error('probe failed'));

  // start() waits 3s (real timer) between the first failure and the retry.
  // Fast-forward it so the test doesn't actually sleep.
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (fn, _ms, ...rest) => originalSetTimeout(fn, 0, ...rest);
  try {
    await companion.start();
  } finally {
    global.setTimeout = originalSetTimeout;
  }

  assert.equal(spawnedProcs.length, 1, 'expected exactly one spawn from this start() attempt');
  assert.equal(spawnedProcs[0].killed, true, 'the orphaned subprocess must be killed once both probe attempts fail');
  assert.equal(companion._proc, null, 'this._proc must be nulled out so a later start() can respawn');
  assert.equal(companion.isReady, false);

  // Confirm the `if (this._proc) return;` guard no longer locks start() out
  // permanently — a later call must actually respawn.
  const originalSetTimeout2 = global.setTimeout;
  global.setTimeout = (fn, _ms, ...rest) => originalSetTimeout2(fn, 0, ...rest);
  try {
    await companion.start();
  } finally {
    global.setTimeout = originalSetTimeout2;
  }
  assert.equal(spawnedProcs.length, 2, 'a later start() call must respawn rather than silently no-op');
});
