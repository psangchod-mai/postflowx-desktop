// mediaDecode.js — resilient wrappers for native/companion media decode calls.
//
// Frame/still decodes go through the companion or platform bridge and can hang
// (offline companion, stuck ffmpeg, slow network share). A bare `await` then
// leaves the UI frozen on "Loading…" forever. These helpers add a timeout,
// bounded retry with backoff, and a clear thrown error so callers can show an
// error state instead of hanging. Pure (timer-injectable) → unit-testable.
'use strict';

/**
 * Race a promise against a timeout. Rejects `TIMEOUT: <label>…` if it doesn't
 * settle in `ms`. Zero/negative `ms` disables the timeout. The timer is always
 * cleared so it can't keep the event loop alive.
 */
export function withTimeout(promise, ms, label = 'decode') {
  const p = Promise.resolve(promise);
  if (!(ms > 0)) return p;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

/**
 * Run a decode `factory` (a function returning a fresh promise each call) with
 * a per-attempt timeout and up to `retries` re-attempts on failure, backing off
 * `backoffMs * attempt` between tries. Re-invokes the factory each attempt (a
 * settled promise can't be retried). Throws the last error if all attempts fail.
 *
 * @param {() => Promise<any>} factory
 * @param {{timeoutMs?:number, retries?:number, backoffMs?:number, label?:string, sleep?:(ms:number)=>Promise<void>}} [opts]
 */
export async function decodeWithRetry(factory, opts = {}) {
  const { timeoutMs = 8000, retries = 1, backoffMs = 150, label = 'decode' } = opts;
  const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await withTimeout(factory(), timeoutMs, label);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(backoffMs * (attempt + 1));
    }
  }
  throw lastErr || new Error(`${label} failed`);
}

/** True when an error is a decode timeout raised by withTimeout. */
export function isTimeout(err) {
  return !!err && typeof err.message === 'string' && err.message.startsWith('TIMEOUT:');
}

/**
 * Try a chain of decode factories in order until one returns a truthy value, so
 * playback degrades gracefully (e.g. companion → ffmpeg). Each step gets its own
 * timeout; steps default to NO retry (a dead decoder should yield to the next
 * one quickly, not retry itself). A step that throws or returns falsy advances
 * to the next. Returns { value, step } (step = index that succeeded, -1 if none
 * produced a value); throws the last error only if every step threw.
 *
 * @param {Array<() => Promise<any>>} steps
 * @param {{timeoutMs?:number, retries?:number, backoffMs?:number, label?:string, sleep?:Function}} [opts]
 */
export async function runDecodeChain(steps, opts = {}) {
  const list = (Array.isArray(steps) ? steps : []).filter(s => typeof s === 'function');
  const base = {
    timeoutMs: opts.timeoutMs ?? 8000,
    retries:   opts.retries   ?? 0,
    backoffMs: opts.backoffMs,
    sleep:     opts.sleep,
  };
  let lastErr = null, threw = false;
  for (let i = 0; i < list.length; i++) {
    try {
      const v = await decodeWithRetry(list[i], { ...base, label: `${opts.label || 'decode'}[${i}]` });
      if (v) return { value: v, step: i };
    } catch (e) { lastErr = e; threw = true; }
  }
  if (threw) throw lastErr;
  return { value: null, step: -1 };
}
