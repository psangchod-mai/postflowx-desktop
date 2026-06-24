// Resilient media-decode wrappers. Run: node tests-js/mediaDecode.test.mjs
import { withTimeout, decodeWithRetry, isTimeout, runDecodeChain } from '../src/scripts/modules/mediaDecode.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

const noSleep = () => Promise.resolve();   // skip backoff delay in tests

async function run() {
  // withTimeout resolves a fast promise.
  ok(await withTimeout(Promise.resolve('frame'), 1000, 'x') === 'frame', 'withTimeout passes through a fast resolve');

  // withTimeout rejects a hung promise.
  {
    let timedOut = false;
    try { await withTimeout(new Promise(() => {}), 30, 'hang'); }
    catch (e) { timedOut = isTimeout(e); }
    ok(timedOut, 'withTimeout rejects with TIMEOUT when the promise hangs');
  }

  // withTimeout with ms<=0 disables the timeout (still resolves).
  ok(await withTimeout(Promise.resolve(7), 0) === 7, 'ms<=0 disables timeout');

  // decodeWithRetry returns on first success, factory called once.
  {
    let calls = 0;
    const v = await decodeWithRetry(() => { calls++; return Promise.resolve('ok'); }, { retries: 2, sleep: noSleep });
    ok(v === 'ok' && calls === 1, 'returns first success without extra attempts');
  }

  // decodeWithRetry retries after a failure, then succeeds.
  {
    let calls = 0;
    const v = await decodeWithRetry(() => {
      calls++;
      return calls < 2 ? Promise.reject(new Error('boom')) : Promise.resolve('recovered');
    }, { retries: 2, sleep: noSleep });
    ok(v === 'recovered' && calls === 2, 'recovers on a retry (2 attempts)');
  }

  // decodeWithRetry exhausts retries then throws the last error.
  {
    let calls = 0, err = null;
    try {
      await decodeWithRetry(() => { calls++; return Promise.reject(new Error(`fail${calls}`)); }, { retries: 2, sleep: noSleep });
    } catch (e) { err = e; }
    ok(calls === 3 && err && err.message === 'fail3', 'exhausts retries (1+2) and throws the last error');
  }

  // decodeWithRetry re-invokes the factory each attempt (fresh promise).
  {
    let made = 0;
    await decodeWithRetry(() => { made++; return made < 2 ? Promise.reject(new Error('x')) : Promise.resolve(1); }, { retries: 1, sleep: noSleep });
    ok(made === 2, 'factory re-invoked per attempt (not a reused settled promise)');
  }

  // decodeWithRetry applies the timeout per attempt.
  {
    let err = null;
    try { await decodeWithRetry(() => new Promise(() => {}), { timeoutMs: 20, retries: 1, sleep: noSleep }); }
    catch (e) { err = e; }
    ok(isTimeout(err), 'per-attempt timeout fires on a hung factory');
  }

  // runDecodeChain — first step wins, later steps not called.
  {
    let a = 0, b = 0;
    const r = await runDecodeChain([
      () => { a++; return Promise.resolve('primary'); },
      () => { b++; return Promise.resolve('ffmpeg'); },
    ], { sleep: noSleep });
    ok(r.value === 'primary' && r.step === 0 && a === 1 && b === 0, 'chain: first success wins, later steps skipped');
  }

  // runDecodeChain — primary throws → falls through to ffmpeg.
  {
    const r = await runDecodeChain([
      () => Promise.reject(new Error('companion down')),
      () => Promise.resolve('ffmpeg'),
    ], { sleep: noSleep });
    ok(r.value === 'ffmpeg' && r.step === 1, 'chain: throwing primary falls through to step 1');
  }

  // runDecodeChain — primary returns falsy (no frame) → next step.
  {
    const r = await runDecodeChain([() => Promise.resolve(null), () => Promise.resolve('ok')], { sleep: noSleep });
    ok(r.value === 'ok' && r.step === 1, 'chain: falsy result advances to next step');
  }

  // runDecodeChain — all throw → rejects with last error.
  {
    let err = null;
    try { await runDecodeChain([() => Promise.reject(new Error('e1')), () => Promise.reject(new Error('e2'))], { sleep: noSleep }); }
    catch (e) { err = e; }
    ok(err && err.message === 'e2', 'chain: all throwing → rejects with last error');
  }

  // runDecodeChain — all return falsy (no error) → {value:null, step:-1}.
  {
    const r = await runDecodeChain([() => Promise.resolve(null), () => Promise.resolve(undefined)], { sleep: noSleep });
    ok(r.value === null && r.step === -1, 'chain: all falsy → null value, step -1 (caller uses last-good)');
  }

  // runDecodeChain — empty chain → graceful null.
  {
    const r = await runDecodeChain([], { sleep: noSleep });
    ok(r.value === null && r.step === -1, 'chain: empty → null, no throw');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
run();
