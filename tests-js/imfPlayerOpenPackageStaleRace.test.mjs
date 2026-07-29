// IMFPlayer.openPackage() concurrent-call race (linkedom).
// Run: node tests-js/imfPlayerOpenPackageStaleRace.test.mjs
//
// openPackage(inputPath) writes shared instance fields (this._packageId,
// this._packageData, this._cplId) after a single await on
// imfEngine.openPackage(). If a second openPackage() call arrives before the
// first's await resolves (e.g. the user double-clicks package A then quickly
// clicks package B in a file browser), and A's IPC round-trip happens to
// resolve after B's, A's stale response can overwrite B's already-applied
// package/CPL selection. This test drives two overlapping openPackage()
// calls with independently controlled resolution order (B resolves first,
// then the stale A resolves late) and asserts the final state matches B,
// with no clobbering from the superseded A.

import { parseHTML } from 'linkedom';

const { window, document } = parseHTML('<!doctype html><html><body><canvas id="c"></canvas></body></html>');
globalThis.window = window;
globalThis.document = document;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const openCalls = []; // { inputPath, deferred }

window.pfxPlatform = {
  imfEngine: {
    openPackage(inputPath) {
      const d = deferred();
      openCalls.push({ inputPath, deferred: d });
      return d.promise;
    },
  },
};

const canvas = document.getElementById('c');
canvas.getContext = () => ({ clearRect() {}, drawImage() {} });

const { createIMFPlayer } = await import('../src/scripts/modules/imf/imf_player_engine.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

async function flush(n = 10) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const player = createIMFPlayer(canvas, {});

// User clicks package A, which suspends inside imfEngine.openPackage().
const promiseA = player.openPackage('/path/A.imf');
ok(player._loadSeq === 1, 'openPackage(A) bumped _loadSeq before its await');

// Before A resolves, the user clicks package B.
const promiseB = player.openPackage('/path/B.imf');
ok(player._loadSeq === 2, 'openPackage(B) bumped _loadSeq again while A was still in flight');

// B's IPC round-trip resolves first.
openCalls[1].deferred.resolve({ ok: true, packageId: 'pkgB', package: { cpls: [{ id: 'cplB1' }], activeCplId: null } });
await flush();

ok(player._packageId === 'pkgB', 'live openPackage(B) wrote its package id once it resolved');
ok(player._cplId === 'cplB1', 'live openPackage(B) auto-selected its own CPL');

// A's IPC round-trip resolves late — it must be a no-op since B superseded it.
openCalls[0].deferred.resolve({ ok: true, packageId: 'pkgA', package: { cpls: [{ id: 'cplA1' }], activeCplId: null } });
await flush();

ok(player._packageId === 'pkgB', 'stale openPackage(A) must not have overwritten B after B superseded it');
ok(player._cplId === 'cplB1', 'stale openPackage(A) must not have overwritten B\'s CPL selection');

await Promise.all([promiseA, promiseB]);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
