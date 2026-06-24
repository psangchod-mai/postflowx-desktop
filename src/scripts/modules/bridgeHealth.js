// bridgeHealth.js — media-bridge health state machine (pure, unit-testable).
//
// Playback depends on the companion / native media bridge. When it drops or
// stops responding, decodes fail and the UI otherwise dies silently. This
// tracks decode outcomes and derives a bridge state so the UI can show a clear
// status and a controller can start an auto-reconnect probe. No timers/IO here
// — the caller owns the ping loop and the UI; this is just the decision logic.
'use strict';

export const BRIDGE_STATE = { ONLINE: 'online', DEGRADED: 'degraded', OFFLINE: 'offline' };

/**
 * @param {{degradeAt?:number, offlineAt?:number, onStateChange?:(state,info)=>void}} [opts]
 *   degradeAt — consecutive failures before 'degraded' (default 2)
 *   offlineAt — consecutive failures before 'offline'  (default 3)
 *   onStateChange — called only when the state actually changes
 */
export function createBridgeMonitor(opts = {}) {
  const degradeAt = Math.max(1, opts.degradeAt ?? 2);
  const offlineAt = Math.max(degradeAt + 1, opts.offlineAt ?? 3);
  const onStateChange = typeof opts.onStateChange === 'function' ? opts.onStateChange : null;

  let state = BRIDGE_STATE.ONLINE;
  let failures = 0;

  function _set(next) {
    if (next === state) return;
    state = next;
    if (onStateChange) { try { onStateChange(state, { failures }); } catch { /* never let UI throw break tracking */ } }
  }

  return {
    /** A decode succeeded → bridge is healthy again. */
    reportSuccess() {
      failures = 0;
      _set(BRIDGE_STATE.ONLINE);
    },
    /** A decode failed (optionally a timeout). Escalates toward offline. */
    reportFailure() {
      failures += 1;
      if (failures >= offlineAt) _set(BRIDGE_STATE.OFFLINE);
      else if (failures >= degradeAt) _set(BRIDGE_STATE.DEGRADED);
    },
    /** Force back to a clean online state (e.g. after a manual reconnect). */
    reset() { failures = 0; _set(BRIDGE_STATE.ONLINE); },
    get state() { return state; },
    get failures() { return failures; },
    isOffline() { return state === BRIDGE_STATE.OFFLINE; },
  };
}
