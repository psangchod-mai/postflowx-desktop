import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const {
  configureMacPasswordStore,
  isAdHocMacSignature,
  shouldUseBasicPasswordStore,
} = require('../electron/password_store.js');

test('recognizes ad-hoc macOS signing without treating Developer ID as local', () => {
  assert.equal(isAdHocMacSignature('Signature=adhoc\nTeamIdentifier=not set\n'), true);
  assert.equal(isAdHocMacSignature('Authority=Developer ID Application: Example\nTeamIdentifier=ABC123\n'), false);
});

test('uses local storage for development and explicitly ad-hoc packaged builds', () => {
  assert.equal(shouldUseBasicPasswordStore({ platform: 'darwin', isPackaged: false, env: {} }), true);
  assert.equal(shouldUseBasicPasswordStore({
    platform: 'darwin',
    isPackaged: true,
    env: {},
    runCodesign: () => ({ stdout: '', stderr: 'Signature=adhoc\nTeamIdentifier=not set\n' }),
  }), true);
});

test('retains Keychain for a stable Developer ID signature or an unknown signing state', () => {
  assert.equal(shouldUseBasicPasswordStore({
    platform: 'darwin',
    isPackaged: true,
    env: {},
    runCodesign: () => ({ stdout: '', stderr: 'Authority=Developer ID Application: Example\nTeamIdentifier=ABC123\n' }),
  }), false);
  assert.equal(shouldUseBasicPasswordStore({
    platform: 'darwin',
    isPackaged: true,
    env: {},
    runCodesign: () => ({ error: new Error('codesign unavailable') }),
  }), false);
});

test('supports explicit local and Keychain overrides', () => {
  assert.equal(shouldUseBasicPasswordStore({
    platform: 'darwin', isPackaged: true, env: { POSTFLOWX_NO_KEYCHAIN: 'true' },
  }), true);
  assert.equal(shouldUseBasicPasswordStore({
    platform: 'darwin', isPackaged: false, env: { POSTFLOWX_USE_MAC_KEYCHAIN: 'true' },
  }), false);
  assert.equal(shouldUseBasicPasswordStore({ platform: 'linux', isPackaged: false, env: {} }), false);
});

test('configures the switch before Electron readiness', () => {
  const switches = [];
  const fakeApp = {
    isPackaged: true,
    commandLine: { appendSwitch: (...args) => switches.push(args) },
  };
  const enabled = configureMacPasswordStore(fakeApp, {
    platform: 'darwin',
    env: {},
    runCodesign: () => ({ stdout: '', stderr: 'Signature=adhoc\nTeamIdentifier=not set\n' }),
  });
  assert.equal(enabled, true);
  assert.deepEqual(switches, [['password-store', 'basic']]);

  const main = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8');
  assert.ok(
    main.indexOf('configureMacPasswordStore(app)') < main.indexOf('\napp.whenReady().then'),
    'password-store must be selected before app.whenReady()',
  );
});
