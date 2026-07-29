// smart_playback_engine.js companion config staleness (Chrome-extension path).
// Run: node tests-js/smartPlaybackEngineCompanionConfigStale.test.mjs
//
// _companionConfig() used to memoize its pfxStorage read into a module-level
// _companionCfgCache the FIRST time any companion call was made, and never
// invalidated it. The companion server mints a new token on every restart
// (and a user can repoint the companion URL in Settings), so once cached,
// every subsequent probe()/decodeFrame()/etc. kept sending the stale
// URL/token for the lifetime of the page — even though smart_engine_settings.js's
// own (uncached) helper and the Settings "Check Engines" button would report
// the change immediately. The fix drops the memoization so every companion
// call reads pfxStorage fresh.

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = undefined; // force the Chrome-extension (companion) path, not Electron

const storageValues = { companionUrl: 'http://127.0.0.1:47125', companionToken: 'token-A' };
globalThis.pfxStorage = {
  async get(keys) {
    const out = {};
    for (const k of keys) out[k] = storageValues[k];
    return out;
  },
};

const requestsSeen = [];
globalThis.fetch = async (url, opts) => {
  requestsSeen.push({ url, token: opts.headers['X-PFX-Token'] });
  return { ok: true, json: async () => ({}) };
};

const SmartEngine = await import('../src/scripts/modules/smart_playback_engine.js');

test('a companion token/URL change in storage is picked up on the next call, not cached forever', async () => {
  await SmartEngine.probe('/path/to/clip.mov');
  assert.equal(requestsSeen[0].token, 'token-A', 'first call uses the initial token');

  // Companion server restarted and minted a new token / user repointed the URL.
  storageValues.companionToken = 'token-B';
  storageValues.companionUrl = 'http://127.0.0.1:9999';

  await SmartEngine.probe('/path/to/clip.mov');
  assert.equal(requestsSeen[1].token, 'token-B',
    `second call must use the updated token (got "${requestsSeen[1].token}")`);
  assert.ok(requestsSeen[1].url.startsWith('http://127.0.0.1:9999'),
    `second call must use the updated companion URL (got "${requestsSeen[1].url}")`);
});

console.log('smartPlaybackEngineCompanionConfigStale: run via node --test');
