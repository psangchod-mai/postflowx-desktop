/**
 * Tests for scripts/modules/edl_export.js — CMX 3600 EDL generator
 * Run: node --test tests/js/edl_export.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEDLFiles } from '../src/scripts/modules/edl_export.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeEv(srcIn, srcOut, recIn, recOut, overrides = {}) {
  return {
    clipName: overrides.clipName ?? 'A001C001_Shot',
    reel:     overrides.reel     ?? 'A001C001',
    srcFile:  overrides.srcFile  ?? 'A001C001_Shot.mov',
    srcIn, srcOut, recIn, recOut,
    fps: overrides.fps ?? 24,
    disabled: false,
    ...overrides,
  };
}

function build(events, opts = {}) {
  return buildEDLFiles(events, { projectName: 'TEST', ...opts });
}

// ── basic structure ───────────────────────────────────────────────────────────

test('buildEDLFiles: empty events returns one empty EDL', () => {
  const files = build([]);
  assert.equal(files.length, 1);
  assert.ok(files[0].filename.endsWith('.edl'));
  assert.ok(typeof files[0].content === 'string');
});

test('buildEDLFiles: filename includes projectName', () => {
  const files = buildEDLFiles([], { projectName: 'MY_SHOW' });
  assert.ok(files[0].filename.startsWith('MY_SHOW'));
});

test('buildEDLFiles: non-VFX mode filename has _CF_PULL suffix', () => {
  const files = build([makeEv('01:00:00:00','01:00:01:00','00:00:00:00','00:00:01:00')]);
  assert.ok(files[0].filename.includes('_CF_PULL'), files[0].filename);
});

test('buildEDLFiles: vfxMarker mode filename has _VFX_PULL suffix', () => {
  const files = build(
    [makeEv('01:00:00:00','01:00:01:00','00:00:00:00','00:00:01:00')],
    { vfxMarker: true }
  );
  assert.ok(files[0].filename.includes('_VFX_PULL'), files[0].filename);
});

// ── EDL content ───────────────────────────────────────────────────────────────

test('buildEDLFiles: content starts with TITLE header', () => {
  const files = build([makeEv('01:00:00:00','01:00:01:00','00:00:00:00','00:00:01:00')]);
  assert.ok(files[0].content.includes('TITLE:'), 'EDL must have TITLE line');
});

test('buildEDLFiles: event line contains reel name', () => {
  const ev = makeEv('01:00:00:00','01:00:01:00','00:00:00:00','00:00:01:00',
                    { reel: 'MYREEL' });
  const files = build([ev]);
  assert.ok(files[0].content.includes('MYREEL'), 'Reel name must appear in EDL');
});

test('buildEDLFiles: event line contains source timecodes', () => {
  const ev = makeEv('01:00:10:00','01:00:20:00','00:00:00:00','00:00:10:00');
  const files = build([ev]);
  assert.ok(files[0].content.includes('01:00:10:00'));
  assert.ok(files[0].content.includes('01:00:20:00'));
});

test('buildEDLFiles: SOURCE FILE comment included with metadata=true', () => {
  const ev = makeEv('01:00:00:00','01:00:01:00','00:00:00:00','00:00:01:00',
                    { srcFile: 'A001C001_Shot.mov' });
  const files = build([ev], { metadata: true });
  assert.ok(files[0].content.includes('SOURCE FILE'), 'SOURCE FILE comment missing');
  assert.ok(files[0].content.includes('A001C001_Shot.mov'));
});

test('buildEDLFiles: event numbered sequentially from 001', () => {
  const evs = [
    makeEv('01:00:00:00','01:00:01:00','00:00:00:00','00:00:01:00'),
    makeEv('01:00:01:00','01:00:02:00','00:00:01:00','00:00:02:00'),
  ];
  const content = build(evs)[0].content;
  assert.ok(/\b001\b/.test(content), 'Event 001 not found');
  assert.ok(/\b002\b/.test(content), 'Event 002 not found');
});

// ── REC TC rebuild ────────────────────────────────────────────────────────────

test('buildEDLFiles: recStartAtZero rebuilds REC TC from 00:00:00:00', () => {
  // Supply events with non-zero recIn — should be rebuilt from 0
  const ev = makeEv('01:00:00:00','01:00:01:00','10:00:00:00','10:00:01:00');
  const content = build([ev], { recStartAtZero: true })[0].content;
  assert.ok(content.includes('00:00:00:00'), 'REC TC must start at 00:00:00:00');
});

test('buildEDLFiles: multiple events REC TC increments sequentially', () => {
  const evs = [
    makeEv('01:00:00:00','01:00:01:00','00:00:00:00','00:00:01:00'),
    makeEv('02:00:00:00','02:00:02:00','00:00:01:00','00:00:03:00'),
  ];
  const content = build(evs, { recStartAtZero: true })[0].content;
  // First event ends at 00:00:01:00 (24 frames at 24fps)
  assert.ok(content.includes('00:00:01:00'), 'Sequential REC TC not found');
});

// ── skipDisabled ──────────────────────────────────────────────────────────────

test('buildEDLFiles: skipDisabled removes disabled events', () => {
  const evs = [
    makeEv('01:00:00:00','01:00:01:00','00:00:00:00','00:00:01:00', { disabled: false }),
    makeEv('01:00:01:00','01:00:02:00','00:00:01:00','00:00:02:00', { disabled: true }),
  ];
  const content = build(evs, { skipDisabled: true })[0].content;
  // Only 1 event → no event 002
  assert.ok(!/\b002\b/.test(content), 'Disabled event should be excluded');
});

test('buildEDLFiles: skipDisabled removes [DISABLED] tagged clips', () => {
  const evs = [
    makeEv('01:00:00:00','01:00:01:00','00:00:00:00','00:00:01:00',
           { clipName: 'ShotA [DISABLED]', disabled: false }),
  ];
  const content = build(evs, { skipDisabled: true })[0].content;
  // No real event lines should appear
  assert.ok(!/\b001\b/.test(content), '[DISABLED] tagged clip should be excluded');
});

// ── autosplit ─────────────────────────────────────────────────────────────────

test('buildEDLFiles: autosplit produces multiple files for large lists', () => {
  const evs = Array.from({ length: 5 }, (_, i) =>
    makeEv('01:00:00:00', '01:00:01:00', `00:00:0${i}:00`, `00:00:0${i+1}:00`,
           { reel: `REEL${i}` })
  );
  const files = build(evs, { autosplit: true, maxEventsPerPart: 2 });
  assert.ok(files.length >= 3, `Expected ≥3 parts, got ${files.length}`);
});

test('buildEDLFiles: autosplit filenames include part numbers', () => {
  const evs = Array.from({ length: 3 }, (_, i) =>
    makeEv('01:00:00:00','01:00:01:00',`00:00:0${i}:00`,`00:00:0${i+1}:00`)
  );
  const files = build(evs, { autosplit: true, maxEventsPerPart: 1 });
  const names = files.map(f => f.filename);
  assert.ok(names.some(n => n.includes('P01')), 'P01 filename not found');
  assert.ok(names.some(n => n.includes('P02')), 'P02 filename not found');
});

test('buildEDLFiles: autosplit=false keeps all events in one file', () => {
  const evs = Array.from({ length: 10 }, (_, i) =>
    makeEv('01:00:00:00','01:00:01:00',`00:00:${String(i).padStart(2,'0')}:00`,
           `00:00:${String(i+1).padStart(2,'0')}:00`)
  );
  const files = build(evs, { autosplit: false });
  assert.equal(files.length, 1);
});

// ── fps header ────────────────────────────────────────────────────────────────

test('buildEDLFiles: FCM line present in header', () => {
  const ev = makeEv('01:00:00:00','01:00:01:00','00:00:00:00','00:00:01:00');
  const content = build([ev])[0].content;
  assert.ok(content.includes('FCM'), 'FCM line missing from EDL header');
});

// ── Fractional frame rates: the whole-frame timecode base ─────────────────────
// Every test above this line pins fps to 24. The rates a real ALE or FCPXML
// actually carries — 23.976 from an ALE header, 30000/1001 from a frameDuration —
// were the ones never exercised, and they were the only ones broken.

// Rebuilt REC columns collapsed to 00:00:00:00 at every fractional rate while every
// integer rate stayed correct. `frames % fps` yielded a fractional frame field,
// framesToTC formatted "00:00:05:0.12000000000000455", and safeTC — which exists to
// keep malformed timecode out of the EDL — failed its own \d{2} regex on it, ran it
// through Number() to NaN, and returned "00:00:00:00". A timecode an editor would
// have rejected became one it silently accepts, so the loss was invisible.
test('buildEDLFiles: rebuilt REC timeline is correct at 23.976, not zeroed', () => {
  const ev = makeEv('01:00:00:00', '01:00:05:00', '', '', { fps: 23.976 });
  const content = build([ev], { recStartAtZero: true })[0].content;
  const rec = content.match(/^\d{3}\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\S+)\s+(\S+)/m);
  assert.ok(rec, 'no event line found');
  assert.equal(rec[1], '00:00:00:00', 'REC IN');
  assert.equal(rec[2], '00:00:05:00', 'REC OUT — was 00:00:00:00 (a five-second event with no duration)');
});

// A fractional rate and its whole-frame base are the same timecode grid, so they must
// produce byte-identical EDLs. This is the assertion that generalises: it holds for
// any future arithmetic added to this file, not just the modulo that broke here.
for (const [frac, whole] of [[23.976, 24], [29.97, 30], [59.94, 60]]) {
  test(`buildEDLFiles: ${frac} emits the same EDL as ${whole}`, () => {
    const evs = fps => [
      makeEv('01:00:00:00', '01:00:05:00', '', '', { fps, reel: 'R1', clipName: 'A' }),
      makeEv('02:00:00:00', '02:00:10:00', '', '', { fps, reel: 'R1', clipName: 'B' }),
    ];
    assert.equal(
      build(evs(frac), { recStartAtZero: true })[0].content,
      build(evs(whole), { recStartAtZero: true })[0].content,
    );
  });
}

// Structural guard on the whole artifact rather than on one field. safeTC turned the
// malformed value into a plausible one before any assertion could see it, so pinning
// individual columns is not enough — nothing anywhere in the text may be a non-timecode.
test('buildEDLFiles: no malformed timecode reaches the EDL text at any rate', () => {
  for (const fps of [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]) {
    const evs = [
      makeEv('01:00:00:00', '01:00:05:00', '', '', { fps }),
      makeEv('02:00:00:00', '02:00:10:12', '', '', { fps }),
    ];
    for (const opts of [{ recStartAtZero: true }, { metadata: true }, { vfxMarker: true }]) {
      const content = build(evs, opts)[0].content;
      // Any HH:MM:SS:FF-shaped run must have exactly two digits in each field —
      // a fractional or over-long field is the signature of rate-based arithmetic.
      const bad = content.match(/\d+[:;]\d+[:;]\d+[:;]\d*\.\d+/g)
               || content.match(/\b\d{3,}[:;]\d+[:;]\d+[:;]\d+/g);
      assert.equal(bad, null, `@${fps} ${JSON.stringify(opts)} emitted ${JSON.stringify(bad)}`);
    }
  }
});

// The duration itself was wrong before the frame field was, and by a different amount:
// five seconds measured 119.88 frames on the fractional rate where timecode says 120.
test('buildEDLFiles: a five-second source span is 120 frames at 23.976', () => {
  const ev = makeEv('01:00:00:00', '01:00:05:00', '', '', { fps: 23.976 });
  const c24 = build([makeEv('01:00:00:00', '01:00:05:00', '', '', { fps: 24 })], { recStartAtZero: true })[0].content;
  const c23 = build([ev], { recStartAtZero: true })[0].content;
  assert.equal(c23, c24, '23.976 must measure the same span as its 24-frame base');
});

// A wrong base that is used consistently cancels out: floor 23.976 to 23, count a
// five-second event as 115 frames, format it back on the same base, and the EDL text
// is byte-identical. Every assertion above survives that mutation. The base is only
// observable where an absolute frame count crosses into the timecode grid, and this
// file has exactly one such door — the ev.durFrames fallback in rebuildRecFromZero.
test('buildEDLFiles: durFrames is read on the whole-frame base, not a floored rate', () => {
  const ev = makeEv('', '', '', '', { fps: 23.976, durFrames: 120 });
  const content = build([ev], { recStartAtZero: true })[0].content;
  const rec = content.match(/^\d{3}\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\S+)\s+(\S+)/m);
  assert.ok(rec, 'no event line found');
  // 120 frames on a 24-frame base is exactly five seconds. On a floored base of 23 it
  // reads 00:00:05:05 — five frames of handle that were never in the source.
  assert.equal(rec[2], '00:00:05:00', 'REC OUT from durFrames=120 @23.976');
});
