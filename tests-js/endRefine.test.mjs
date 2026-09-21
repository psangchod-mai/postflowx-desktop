import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRefinableSpeed,
  acceptRefinedEnd,
  END_MIN_CONFIDENCE,
} from '../src/scripts/modules/conform/endRefine.js';

// ── isRefinableSpeed ────────────────────────────────────────────────────────
test('isRefinableSpeed: normal forward static shot is refinable', () => {
  assert.equal(isRefinableSpeed({ reversed: false, dynamicSpeed: false, speedRatio: 1 }), true);
});

test('isRefinableSpeed: reversed shot is NOT refinable', () => {
  assert.equal(isRefinableSpeed({ reversed: true, dynamicSpeed: false, speedRatio: 1 }), false);
});

test('isRefinableSpeed: dynamic (keyframed) speed is NOT refinable', () => {
  assert.equal(isRefinableSpeed({ reversed: false, dynamicSpeed: true, speedRatio: 1 }), false);
});

test('isRefinableSpeed: retimed shot (2x) is NOT refinable', () => {
  assert.equal(isRefinableSpeed({ reversed: false, dynamicSpeed: false, speedRatio: 2 }), false);
});

test('isRefinableSpeed: tiny speed drift within ±8% stays refinable', () => {
  assert.equal(isRefinableSpeed({ reversed: false, dynamicSpeed: false, speedRatio: 1.05 }), true);
  assert.equal(isRefinableSpeed({ reversed: false, dynamicSpeed: false, speedRatio: 0.93 }), true);
});

// ── acceptRefinedEnd ────────────────────────────────────────────────────────
test('acceptRefinedEnd: strong match near expected span → accepted, srcOut exclusive', () => {
  // srcIn 100, span 48 → expected last frame 147. Matched last frame 149.
  const r = acceptRefinedEnd({ correctedSrcInF: 100, matchedEndF: 149, endConfidence: 90, srcSpanF: 48 });
  assert.deepEqual(r, { srcOutF: 150, refinedSpanF: 50 }); // out is matchedEnd+1 (exclusive)
});

test('acceptRefinedEnd: weak confidence → null (keep span)', () => {
  const r = acceptRefinedEnd({ correctedSrcInF: 100, matchedEndF: 149, endConfidence: END_MIN_CONFIDENCE - 1, srcSpanF: 48 });
  assert.equal(r, null);
});

test('acceptRefinedEnd: end at/before start → null', () => {
  assert.equal(acceptRefinedEnd({ correctedSrcInF: 100, matchedEndF: 100, endConfidence: 95, srcSpanF: 48 }), null);
  assert.equal(acceptRefinedEnd({ correctedSrcInF: 100, matchedEndF: 80,  endConfidence: 95, srcSpanF: 48 }), null);
});

test('acceptRefinedEnd: refined span drifts >25% beyond source span → null', () => {
  // span 48 → tolerance max(12, 12) = 12. refinedSpan 70 (Δ22) exceeds it.
  const r = acceptRefinedEnd({ correctedSrcInF: 100, matchedEndF: 169, endConfidence: 95, srcSpanF: 48 });
  assert.equal(r, null);
});

test('acceptRefinedEnd: small span uses absolute ±12 frame floor', () => {
  // span 8 → tolerance max(12, 2) = 12. matchedEnd 118 → refinedSpan 11 (Δ3) within floor.
  const r = acceptRefinedEnd({ correctedSrcInF: 108, matchedEndF: 118, endConfidence: 88, srcSpanF: 8 });
  assert.deepEqual(r, { srcOutF: 119, refinedSpanF: 11 });
});

test('acceptRefinedEnd: large span uses ±25% fractional tolerance', () => {
  // span 200 → tolerance max(12, 50) = 50. refinedSpan 241 (Δ41) within 50.
  const r = acceptRefinedEnd({ correctedSrcInF: 100, matchedEndF: 340, endConfidence: 85, srcSpanF: 200 });
  assert.deepEqual(r, { srcOutF: 341, refinedSpanF: 241 });
});

test('acceptRefinedEnd: degenerate span (≤1) → null', () => {
  assert.equal(acceptRefinedEnd({ correctedSrcInF: 100, matchedEndF: 101, endConfidence: 95, srcSpanF: 1 }), null);
});
