import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);

// media_engine.js does require('electron') and require('child_process') at
// module-load time. Outside Electron, 'electron' resolves to a plain path
// string, and a real child_process.spawn would try to exec the actual
// avf_bridge binary — inject fakes into Node's require cache before first
// require(), same trick tests-js/downloadConflictAction.test.mjs and
// companionStartupRetry.test.mjs use for 'electron' / 'child_process'.
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { protocol: { registerSchemesAsPrivileged() {}, handle() {} } },
};

// NTSC "true" rate, as opposed to the nominal/rounded 24 used for HH:MM:SS:FF
// counting — see src/scripts/modules/utils_time.js's nominalBase() doc.
const FAKE_FPS = 23.976023976023978;

const childProcessPath = require.resolve('child_process');
const realChildProcess = require(childProcessPath);
require.cache[childProcessPath] = {
  id: childProcessPath,
  filename: childProcessPath,
  loaded: true,
  exports: {
    ...realChildProcess,
    spawn() {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write() {}, end() {} };
      proc.kill = () => {};
      queueMicrotask(() => {
        proc.stdout.emit('data', JSON.stringify({ ok: true, fps: FAKE_FPS, codec: 'h264' }));
        proc.emit('close');
      });
      return proc;
    },
  },
};

const mediaEngine = require('../electron/native/media_engine.js');

test('seek() with a timecode uses the nominal (rounded) fps, not the exact NTSC rate', async () => {
  const { ok, playerId, info } = await mediaEngine.open({ path: '/fake/A001C001.mov' });
  assert.equal(ok, true);
  assert.equal(info.fps, FAKE_FPS, 'sanity: session stores the exact probed fps');

  const r = await mediaEngine.seek({ playerId, timecode: '01:00:00:00' });
  assert.equal(r.ok, true);
  // Nominal 24fps * 3600s = 86400 frames. Using the exact NTSC rate instead
  // (23.976...) would floor to 86313 — the documented "two-rate contract" bug.
  assert.equal(r.frame, 86400, 'seek must use nominal fps (24) for HH:MM:SS:FF counting');

  await mediaEngine.close({ playerId });
});
