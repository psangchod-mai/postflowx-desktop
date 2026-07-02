// Cross-CPL timeline diff (CHANGE 2). Run: node tests-js/imfTimelineDiff.test.mjs
// Fixtures mirror the real "Meridian HDRIAB" OV + supplementals sample:
//   shared video 22279733 (→ same), supplementals add ccb71bf8/88cc5a7d (OV
//   shorter → gap), audio swapped 02fc11ab → c6faac8a in the audio supplemental.
import { computeCplResourceDiff } from '../src/scripts/modules/imf/imf_timeline_diff.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ov = { key: 'ov', cpl: { totalFrames: 1000,
  videoResources: [{ trackFileId: '22279733', sourceDuration: 1000 }],
  audioResources: [{ trackFileId: '02fc11ab', sourceDuration: 1000 }] } };
const vsup = { key: 'vsup', cpl: { totalFrames: 1500,
  videoResources: [{ trackFileId: '22279733', sourceDuration: 500 }, { trackFileId: 'ccb71bf8', sourceDuration: 500 }, { trackFileId: '88cc5a7d', sourceDuration: 500 }],
  audioResources: [{ trackFileId: '02fc11ab', sourceDuration: 1500 }] } };
const asup = { key: 'asup', cpl: { totalFrames: 1500,
  videoResources: [{ trackFileId: '22279733', sourceDuration: 500 }, { trackFileId: 'ccb71bf8', sourceDuration: 500 }, { trackFileId: '88cc5a7d', sourceDuration: 500 }],
  audioResources: [{ trackFileId: 'c6faac8a', sourceDuration: 1500 }] } };
const entries = [ov, vsup, asup];

// ── VIDEO ──
{
  const v = computeCplResourceDiff(entries, 'video');
  ok(v.maxReels === 3, 'video maxReels = 3 (supplementals are longest)');
  ok(v.masterFrames === 1500, 'masterFrames = longest CPL totalFrames (1500)');
  ok(eq(v.strip, ['same', 'gap', 'gap']), 'video strip: shared reel same, OV-missing reels = gap');
  ok(v.matchCount === 1, 'video matchCount = 1 (only the shared reel matches)');
  ok(!v.flags.ov[0] && !v.flags.vsup[0] && !v.flags.asup[0], 'shared reel 0 → no ≠ on any CPL');
  ok(!v.flags.vsup[1] && !v.flags.asup[1], 'reel 1 present+identical in both supplementals → no ≠');
  ok(v.flags.ov[0] === false, 'OV reel 0 not flagged');
  ok(v.flags.ov[1] === undefined, 'OV has no reel 1 (missing → no flag entry)');
}

// ── AUDIO (swap) ──
{
  const a = computeCplResourceDiff(entries, 'audio');
  ok(a.maxReels === 1, 'audio maxReels = 1');
  ok(eq(a.strip, ['changed']), 'audio strip: changed (audio supplemental swapped the track)');
  ok(a.matchCount === 0, 'audio matchCount = 0');
  ok(a.flags.ov[0] && a.flags.vsup[0] && a.flags.asup[0], 'all three audio reels flagged ≠ (swap)');
}

// ── single CPL → everything matches, nothing flagged ──
{
  const v = computeCplResourceDiff([ov], 'video');
  ok(v.maxReels === 1 && eq(v.strip, ['same']) && v.matchCount === 1, 'single CPL → 1 reel, all same');
  ok(!v.flags.ov[0], 'single CPL → no diff flags');
}

// ── empty / defensive ──
{
  const v = computeCplResourceDiff([], 'video');
  ok(v.maxReels === 0 && v.masterFrames === 1 && v.matchCount === 0 && eq(v.strip, []), 'empty entries → safe defaults');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
