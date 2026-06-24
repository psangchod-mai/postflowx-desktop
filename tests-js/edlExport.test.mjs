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
