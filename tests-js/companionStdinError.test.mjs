import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);

// Same require-cache-patching trick as companionStartupRetry.test.mjs: swap
// child_process's spawn before companion.js's own top-level
// `const { spawn } = require('child_process');` first runs.
const cp = require('child_process');

function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.write = () => true;
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

test('an async EPIPE on stdin does not crash the process', async () => {
  companion._waitReady = () => Promise.resolve({ ok: true });

  await companion.start();
  assert.equal(spawnedProcs.length, 1);
  assert.equal(companion.isReady, true);

  // A real child_process stdin surfaces a post-death write failure as an
  // async 'error' event, not a throw from write(). An EventEmitter with no
  // 'error' listener throws synchronously on emit('error', ...) — exactly
  // mirroring Node's real "unhandled stream error crashes the process"
  // behavior. If companion.js failed to attach a listener, this line itself
  // throws and fails the test.
  spawnedProcs[0].stdin.emit('error', new Error('EPIPE: write after end'));

  // The subprocess itself is still considered alive — the module treats a
  // stdin write failure as a warning, not a fatal condition.
  assert.equal(companion.isReady, true);
});
