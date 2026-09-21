// P1-TIMELINE: CPL segment/timeline continuity. Run: node tests-js/imfTimeline.test.mjs
import { validateTimeline, SEV } from '../src/scripts/modules/imf/imf_validator.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
const byCode = (rs, code) => rs.find(r => r.code === code);
const sevOf = (rs, code) => byCode(rs, code)?.sev;

// A 2-reel CPL: 100 + 100 = 200 frames of video, one audio track of matching length.
function makeValid() {
  return {
    id: 'urn:uuid:cpl-1', editRate: 24, totalFrames: 200,
    videoResources: [],
    videoSequences: [
      { trackId: 'v', seqType: 'MainImageSequence', resources: [
        { trackFileId: 'v1', entryPoint: 0, sourceDuration: 100, intrinsicDuration: 200, editRate: 24, repeatCount: 1 },
        { trackFileId: 'v2', entryPoint: 0, sourceDuration: 100, intrinsicDuration: 100, editRate: 24, repeatCount: 1 },
      ] },
    ],
    audioSequences: [
      { trackId: 'a', seqType: 'MainAudioSequence', resources: [
        { trackFileId: 'a1', entryPoint: 0, sourceDuration: 200, intrinsicDuration: 400, editRate: 24, repeatCount: 1 },
      ] },
    ],
  };
}

// ── Valid timeline → all PASS ──
{
  const r = validateTimeline(makeValid());
  ok(sevOf(r, 'TL001') === SEV.PASS, 'TL001 PASS — source ranges in bounds');
  ok(sevOf(r, 'TL002') === SEV.PASS, 'TL002 PASS — no zero-duration resources');
  ok(sevOf(r, 'TL003') === SEV.PASS, 'TL003 PASS — video covers composition');
  ok(sevOf(r, 'TL004') === SEV.PASS, 'TL004 PASS — tracks span same duration');
  ok(!r.some(x => x.sev === SEV.FAIL), 'valid timeline → no FAIL');
}

// ── Source range out of bounds → TL001 FAIL ──
{
  const c = makeValid();
  c.videoSequences[0].resources[1].entryPoint = 50; // 50 + 100 > 100 intrinsic
  const r = validateTimeline(c);
  ok(sevOf(r, 'TL001') === SEV.FAIL, 'TL001 FAIL — EntryPoint+Duration > IntrinsicDuration');
  ok(byCode(r, 'TL001').remediation, 'TL001 carries remediation');
}

// ── Zero-duration resource → TL002 FAIL ──
{
  const c = makeValid();
  c.videoSequences[0].resources[1].sourceDuration = 0;
  c.videoSequences[0].resources[1].intrinsicDuration = 0;
  const r = validateTimeline(c);
  ok(sevOf(r, 'TL002') === SEV.FAIL, 'TL002 FAIL — zero-duration resource');
}

// ── Track duration mismatch → TL004 FAIL ──
{
  const c = makeValid();
  c.audioSequences[0].resources[0].sourceDuration = 150; // audio 150 vs video 200
  const r = validateTimeline(c);
  ok(sevOf(r, 'TL004') === SEV.FAIL, 'TL004 FAIL — tracks span different durations');
  ok(byCode(r, 'TL004').resourceRef?.kind === 'cpl', 'TL004 resourceRef points at cpl');
}

// ── Video coverage vs totalFrames mismatch → TL003 FAIL ──
{
  const c = makeValid();
  c.totalFrames = 300; // declared 300 but timeline covers 200
  const r = validateTimeline(c);
  ok(sevOf(r, 'TL003') === SEV.FAIL, 'TL003 FAIL — coverage != declared total');
}

// ── Audio-rate scaling: 48k audio scaled into 24fps composition units ──
{
  const c = makeValid();
  // Audio at 48000 edit rate must scale down; verify no false TL004.
  c.audioSequences[0].resources[0].editRate = 48000;
  c.audioSequences[0].resources[0].sourceDuration = 200 * (48000 / 24); // equiv 200 comp units
  c.audioSequences[0].resources[0].intrinsicDuration = 999999999;
  const r = validateTimeline(c);
  ok(sevOf(r, 'TL004') === SEV.PASS, 'TL004 PASS — audio edit-rate scaled into composition units');
}

// ── Robustness: empty cpl → [] no throw ──
{
  ok(validateTimeline(null).length === 0, 'null cpl → [] no throw');
  ok(validateTimeline({}).length === 0, 'empty cpl → [] no throw');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
