// imf_package_ui.js _openPackage() UI-layer stale-race (linkedom).
// Run: node tests-js/imfPackageUiOpenPackageStaleRace.test.mjs
//
// The underlying IMFPlayer.openPackage() already guards its own instance
// state with a _loadSeq counter — a superseded call resolves with
// { ok: false, error: 'superseded' } instead of clobbering the newer
// package's data. But the _openPackage() UI wrapper in imf_package_ui.js
// didn't know about that: it unconditionally called _showErrors() on any
// !r.ok result, including 'superseded'. A double-click on "Open IMF
// Package" (or a click landing on the dropzone right after the Open button
// was clicked) starts two overlapping opens; once the newer one settles and
// paints the CPL selector, the older (now-superseded) one's late resolution
// used to slap a false "Failed to open IMF package" error banner over the
// correctly-open package — a real, user-visible false-alarm bug.

import { parseHTML } from 'linkedom';

const { window, document } = parseHTML('<!doctype html><html><body><div id="container"></div></body></html>');
globalThis.window = window;
globalThis.document = document;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

window.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, drawImage() {} });

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const openCalls = []; // { inputPath, deferred }
const validateCalls = [];

window.pfxPlatform = {
  imfEngine: {
    openPackage(inputPath) {
      const d = deferred();
      openCalls.push({ inputPath, deferred: d });
      return d.promise;
    },
    validatePackage() {
      const d = deferred();
      validateCalls.push(d);
      return d.promise;
    },
  },
};

const { mountIMFPackageUI } = await import('../src/scripts/modules/imf/imf_package_ui.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

async function flush(n = 20) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const container = document.getElementById('container');
const ui = mountIMFPackageUI(container, {});

const errorsBar = container.querySelector('#imf-errors');

// Package A open starts, suspends inside imfEngine.openPackage().
const promiseA = ui.openPackage('/path/A.imf');
await flush();
// Before A resolves, the user (double-)clicks Open again for package B.
const promiseB = ui.openPackage('/path/B.imf');
await flush();
ok(openCalls.length === 2, 'each open call sent its own independent openPackage() probe');

// B's IPC round-trip resolves first — the live, intended package.
openCalls[1].deferred.resolve({ ok: true, packageId: 'pkgB', package: { cpls: [{ id: 'cplB1' }], activeCplId: null } });
await flush();

ok(errorsBar.style.display === 'none' || !errorsBar.innerHTML, 'no error banner shown once B opened successfully');

// A's IPC round-trip resolves late — superseded by B, per IMFPlayer's own
// _loadSeq guard, so it comes back { ok: false, error: 'superseded' }.
openCalls[0].deferred.resolve({ ok: true, packageId: 'pkgA', package: { cpls: [{ id: 'cplA1' }], activeCplId: null } });
await flush();

ok(errorsBar.style.display === 'none' || !errorsBar.innerHTML,
  'the stale, superseded open must not paint a false error banner over the live package');

// B's success path awaits _doValidate() -> player.validatePackage(), which
// this test leaves pending on purpose (only the open-race matters here).
// Resolve it so promiseB settles and doesn't trip Node's unsettled-await warning.
if (validateCalls.length) {
  validateCalls[0].resolve({
    ok: true,
    validation: {
      assetmapFound: true, pklFound: true, cplCount: 1,
      pictureTrackCount: 1, audioTrackCount: 1, missingMXFs: [],
      encryptedAssets: [], codecWarnings: [], ffprobeResult: null, canPlay: true,
    },
  });
}
await flush();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
