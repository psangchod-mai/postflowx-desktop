// VFX-pull triage risk scoring. Run: node tests-js/shotRisk.test.mjs
import { shotRiskScore } from '../src/scripts/features/vfxPull/triageScore.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

// No OCF linked → blocked, health 0.
{
  const r = shotRiskScore({ ocfLinked: false });
  ok(r.level === 'blocked' && r.health === 0, 'no OCF → blocked');
  ok(r.reasons.includes('No OCF linked'), 'blocked reason surfaced');
}

// Approved overrides everything → ok.
{
  const r = shotRiskScore({ ocfLinked: true, status: 'approved', fileConf: 10, visual: 10 });
  ok(r.level === 'ok' && r.health === 100, 'approved → ok regardless of low signals');
}

// All-high signals → ok, no reasons.
{
  const r = shotRiskScore({ ocfLinked: true, status: 'match_ok', fileConf: 96, visual: 92, color: 88, reframe: 0.95, drift: 0 });
  ok(r.level === 'ok' && r.reasons.length === 0, 'strong signals → ok, no reasons');
  ok(r.health >= 85, 'strong signals → high health');
}

// Low visual match → review, with a reason.
{
  const r = shotRiskScore({ ocfLinked: true, status: 'decode_ok', fileConf: 95, visual: 40, color: 90 });
  ok(r.level === 'review', 'low visual → review');
  ok(r.reasons.some(s => s.includes('Visual match')), 'visual reason surfaced');
}

// Unapplied frame drift dents health and is flagged.
{
  const hi = shotRiskScore({ ocfLinked: true, status: 'match_ok', fileConf: 95, visual: 95, drift: 0 });
  const lo = shotRiskScore({ ocfLinked: true, status: 'match_ok', fileConf: 95, visual: 95, drift: 5, driftApplied: false });
  ok(lo.health < hi.health, 'unapplied drift lowers health');
  ok(lo.reasons.some(s => s.includes('drift')), 'drift reason surfaced');
}

// Applied drift is NOT penalised.
{
  const r = shotRiskScore({ ocfLinked: true, status: 'match_ok', fileConf: 95, visual: 95, drift: 5, driftApplied: true });
  ok(r.level === 'ok' && !r.reasons.some(s => s.includes('drift')), 'applied drift is clean');
}

// Failed verification → review even with decent signals.
{
  const r = shotRiskScore({ ocfLinked: true, status: 'failed', fileConf: 90, visual: 90 });
  ok(r.level === 'review' && r.reasons.includes('Verification failed'), 'failed status → review');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
