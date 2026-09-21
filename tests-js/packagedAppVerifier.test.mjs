import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_ASAR_ENTRIES,
  assessAsarInventory,
  classifyMacSignature,
  summarizePackagedApp,
} from '../tools/packaged-app-verifier-core.mjs';

test('packaged app inventory reports every missing renderer/runtime file', () => {
  const partial = assessAsarInventory(REQUIRED_ASAR_ENTRIES.slice(0, -2));
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.missing, REQUIRED_ASAR_ENTRIES.slice(-2));
  assert.equal(assessAsarInventory(REQUIRED_ASAR_ENTRIES).ok, true);
});

test('signature classification distinguishes local ad-hoc from distributable Developer ID', () => {
  const local = classifyMacSignature('flags=0x10002(adhoc,runtime) Signature=adhoc', false);
  assert.deepEqual(local, {
    mode: 'ad-hoc',
    hardenedRuntime: true,
    gatekeeperAccepted: false,
    distributionReady: false,
  });

  const release = classifyMacSignature('flags=0x10000(runtime) Authority=Developer ID Application: Example', true);
  assert.equal(release.mode, 'developer-id');
  assert.equal(release.distributionReady, true);
});

test('local readiness requires inventory, native engines, metadata, signature, and hardened runtime', () => {
  const ready = summarizePackagedApp({
    inventory: { ok: true }, native: { ok: true }, metadata: { ok: true },
    codesign: { ok: true }, signature: { hardenedRuntime: true, distributionReady: false },
  });
  assert.equal(ready.localReady, true);
  assert.equal(ready.distributionReady, false);

  assert.equal(summarizePackagedApp({
    inventory: { ok: true }, native: { ok: false }, metadata: { ok: true },
    codesign: { ok: true }, signature: { hardenedRuntime: true, distributionReady: false },
  }).localReady, false);
});
