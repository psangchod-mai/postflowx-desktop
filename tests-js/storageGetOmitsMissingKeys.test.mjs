import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

// electron/storage.js does `const { app } = require('electron');` and calls
// app.getPath('userData') at first use. Outside Electron, require('electron')
// just resolves to a path string (the Electron binary), so we inject a fake
// module into the require cache — keyed by the resolved path, same trick the
// companion tests use for child_process.spawn — before storage.js is loaded.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfx-storage-test-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { app: { getPath: () => tmpDir } },
};

const storage = require('../electron/storage.js');

test('get() omits a missing single key rather than returning it as undefined', () => {
  storage.clear();
  storage.set({ foo: 'bar' });

  const result = storage.get('missing');
  assert.deepEqual(result, {});
  assert.equal('missing' in result, false);
});

test('get() with an array omits missing keys but keeps present ones', () => {
  storage.clear();
  storage.set({ foo: 'bar' });

  const result = storage.get(['foo', 'missing']);
  assert.deepEqual(result, { foo: 'bar' });
  assert.equal('missing' in result, false);
});

test('get() still returns a present single key correctly', () => {
  storage.clear();
  storage.set({ foo: 'bar' });

  assert.deepEqual(storage.get('foo'), { foo: 'bar' });
});

test('get(null) still returns the whole cache unaffected', () => {
  storage.clear();
  storage.set({ foo: 'bar', baz: 'qux' });

  assert.deepEqual(storage.get(null), { foo: 'bar', baz: 'qux' });
});

test('get() with a defaults object returns defaults for missing keys and stored values for present ones', () => {
  storage.clear();
  storage.set({ foo: 'bar' });

  const result = storage.get({ foo: 'fallback', missing: 'default' });
  assert.deepEqual(result, { foo: 'bar', missing: 'default' });
});
