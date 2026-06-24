// Media-bridge health state machine. Run: node tests-js/bridgeHealth.test.mjs
import { createBridgeMonitor, BRIDGE_STATE } from '../src/scripts/modules/bridgeHealth.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

// Starts online.
{
  const m = createBridgeMonitor();
  ok(m.state === BRIDGE_STATE.ONLINE && !m.isOffline(), 'starts online');
}

// Escalates online → degraded → offline on consecutive failures.
{
  const seen = [];
  const m = createBridgeMonitor({ degradeAt: 2, offlineAt: 3, onStateChange: s => seen.push(s) });
  m.reportFailure(); ok(m.state === BRIDGE_STATE.ONLINE, '1 failure stays online (below degradeAt)');
  m.reportFailure(); ok(m.state === BRIDGE_STATE.DEGRADED, '2 failures → degraded');
  m.reportFailure(); ok(m.state === BRIDGE_STATE.OFFLINE && m.isOffline(), '3 failures → offline');
  ok(seen.join(',') === 'degraded,offline', 'onStateChange fired once per transition');
}

// A success resets straight back to online.
{
  const m = createBridgeMonitor({ degradeAt: 2, offlineAt: 3 });
  m.reportFailure(); m.reportFailure(); m.reportFailure();
  ok(m.isOffline(), 'offline after 3 failures');
  m.reportSuccess();
  ok(m.state === BRIDGE_STATE.ONLINE && m.failures === 0, 'one success → online, failures cleared');
}

// onStateChange only fires on actual change (not every success while online).
{
  let calls = 0;
  const m = createBridgeMonitor({ onStateChange: () => calls++ });
  m.reportSuccess(); m.reportSuccess();
  ok(calls === 0, 'repeated success while online does not re-fire onStateChange');
}

// offlineAt is forced above degradeAt even if misconfigured.
{
  const m = createBridgeMonitor({ degradeAt: 5, offlineAt: 1 });
  m.reportFailure();
  ok(m.state === BRIDGE_STATE.ONLINE, 'offlineAt clamped above degradeAt — single failure stays online');
}

// A throwing onStateChange never breaks tracking.
{
  const m = createBridgeMonitor({ degradeAt: 1, offlineAt: 2, onStateChange: () => { throw new Error('ui boom'); } });
  m.reportFailure();
  ok(m.state === BRIDGE_STATE.DEGRADED, 'tracking survives a throwing onStateChange');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
