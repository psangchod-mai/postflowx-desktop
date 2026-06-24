// Phase F — Smart Pro gating. The new color capabilities ride the EXISTING
// plan→action policy (auth/planPolicy.js); no new auth system.
// Run: node --test test/color/gating.test.mjs
import './_setup.mjs';
import '../../src/scripts/auth/planPolicy.js'; // side effect: sets globalThis.PFX_PLAN_POLICY
import test from 'node:test';
import assert from 'node:assert/strict';

const P = globalThis.PFX_PLAN_POLICY;

test('plan policy loaded', () => {
  assert.ok(P && typeof P.canPlanDoAction === 'function');
});

test('free plan blocks the new pro color exports', () => {
  assert.equal(P.canPlanDoAction('free', 'export_fdl_asc'), false);
  assert.equal(P.canPlanDoAction('free', 'import_amf'), false);
  assert.equal(P.canPlanDoAction('free', 'export_amf'), false, 'and existing pro exports stay blocked');
});

test('pro plan allows the new + existing color actions', () => {
  for (const a of ['export_fdl_asc', 'import_amf', 'export_amf', 'export_clf', 'export_cdl']) {
    assert.equal(P.canPlanDoAction('pro', a), true, `pro can ${a}`);
  }
});

test('enterprise (*) allows everything', () => {
  assert.equal(P.canPlanDoAction('enterprise', 'export_fdl_asc'), true);
  assert.equal(P.canPlanDoAction('enterprise', 'anything_at_all'), true);
});

test('new actions are gated identically to the existing pro exports', () => {
  for (const plan of ['free', 'pro', 'enterprise']) {
    assert.equal(P.canPlanDoAction(plan, 'export_fdl_asc'), P.canPlanDoAction(plan, 'export_amf'), `export_fdl_asc == export_amf for ${plan}`);
    assert.equal(P.canPlanDoAction(plan, 'import_amf'), P.canPlanDoAction(plan, 'export_amf'), `import_amf == export_amf for ${plan}`);
  }
});

test('boot-guard-style synthetic session: mocked getPlan → granted actions', () => {
  const getPlan = () => 'pro'; // mock window.PFX_AUTH.getPlan
  const actions = P.actionsForPlan(getPlan());
  assert.ok(actions.includes('export_fdl_asc') && actions.includes('import_amf'));
  assert.ok(P.tabsForPlan('pro').includes('aces_look'), 'aces_look tab still pro');
  assert.deepEqual(P.actionsForPlan('free'), ['open_project', 'view_markers'], 'free unchanged');
});
