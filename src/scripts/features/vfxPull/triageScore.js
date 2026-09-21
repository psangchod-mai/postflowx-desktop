// triageScore.js — VFX Pull risk-triage scoring (pure, unit-testable).
//
// Blends a shot's per-signal confidences into a 0–100 health score
// (higher = safer), a triage level (ok | review | blocked), and
// human-readable reasons for anything subpar. No DOM, no module state — the
// UI layer (vfxPullPanel.js) gathers the inputs and renders the result.
'use strict';

/**
 * @param {object} inputs
 *   ocfLinked   {boolean}     OCF resolved + SAFE
 *   status      {string}      verify status ('approved'|'failed'|…)
 *   fileConf    {number|null} reel/TC file-match confidence 0–100
 *   visual      {number|null} per-frame visual match confidence 0–100
 *   color       {number|null} CDL color-match confidence 0–100
 *   reframe     {number|null} reframe confidence 0–1
 *   drift       {number}      frame-align in-point drift (frames)
 *   driftApplied{boolean}     whether the drift was applied to the pull
 * @returns {{ health:number, level:'ok'|'review'|'blocked', reasons:string[] }}
 */
export function shotRiskScore(inputs = {}) {
  const { ocfLinked, status, fileConf, visual, color, reframe, drift = 0, driftApplied = false } = inputs;
  if (!ocfLinked) return { health: 0, level: 'blocked', reasons: ['No OCF linked'] };
  if (status === 'approved') return { health: 100, level: 'ok', reasons: [] };

  const reasons = [];
  const signals = [];
  const add = (v, w, lowThresh, label) => {
    if (v == null || !Number.isFinite(Number(v))) return;
    const val = Number(v);
    signals.push({ v: val, w });
    if (val < lowThresh) reasons.push(label(Math.round(val)));
  };
  add(fileConf, 1.0, 80, p => `OCF match ${p}%`);
  add(visual,   1.5, 70, p => `Visual match ${p}%`);
  add(color,    1.0, 60, p => `Color match ${p}%`);
  if (reframe != null && Number.isFinite(Number(reframe))) signals.push({ v: Number(reframe) * 100, w: 0.5 });
  if (!signals.length && status !== 'failed') reasons.push('Not yet verified');

  let health = 100;
  if (signals.length) {
    const wsum = signals.reduce((a, s) => a + s.w, 0);
    health = Math.round(signals.reduce((a, s) => a + s.v * s.w, 0) / wsum);
  }
  if (drift && !driftApplied) {
    reasons.push(`Frame drift ${drift > 0 ? '+' : ''}${drift}f (not applied)`);
    health = Math.max(0, health - Math.min(20, Math.abs(drift) * 3));
  }
  if (status === 'failed') reasons.push('Verification failed');

  const level = (status === 'failed' || health < 75 || reasons.length) ? 'review' : 'ok';
  return { health, level, reasons };
}
