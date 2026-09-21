/**
 * Tests for scripts/core/timelineModel.js
 * Run: node --test tests/js/timeline_model.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSeqBaseFrames,
  buildImportedTimelineFromEvents,
} from '../src/scripts/core/timelineModel.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const FPS = 24;

function makeEvent(recIn, recOut, opts = {}) {
  return {
    clipName: opts.clipName ?? 'CLIP',
    reel:     opts.reel    ?? 'REEL',
    srcIn:    opts.srcIn   ?? recIn,
    srcOut:   opts.srcOut  ?? recOut,
    recIn,
    recOut,
    disabled:   opts.disabled   ?? false,
    type:       opts.type       ?? 'video',
    role:       opts.role       ?? 'V1',
    trackIndex: opts.trackIndex ?? 0,
    ...opts,
  };
}

// ── getSeqBaseFrames ──────────────────────────────────────────────────────────

test('getSeqBaseFrames: reads _seqBaseFrames from object directly', () => {
  assert.equal(getSeqBaseFrames({ _seqBaseFrames: 86400 }, FPS), 86400);
});

test('getSeqBaseFrames: reads from events[0]._seqBaseFrames', () => {
  const obj = { events: [{ _seqBaseFrames: 1440 }] };
  assert.equal(getSeqBaseFrames(obj, FPS), 1440);
});

test('getSeqBaseFrames: falls back to earliest recIn', () => {
  const events = [
    makeEvent('01:00:00:00', '01:00:01:00'),
    makeEvent('00:30:00:00', '00:30:01:00'),
  ];
  // earliest recIn = 00:30:00:00 = 43200 frames @ 24fps
  const base = getSeqBaseFrames({ events }, FPS);
  assert.equal(base, 43200);
});

test('getSeqBaseFrames: returns null when no events (caller must handle)', () => {
  // Documented behaviour: null when no base can be derived — callers check for null
  assert.equal(getSeqBaseFrames({ events: [] }, FPS), null);
});

// ── buildImportedTimelineFromEvents — basics ──────────────────────────────────

test('buildImportedTimelineFromEvents: empty array returns valid structure', () => {
  const result = buildImportedTimelineFromEvents([], FPS);
  assert.ok(Array.isArray(result.tracks));
  assert.equal(result.tracks.length, 0);
  assert.ok(result.durationFrames >= 1);
});

test('buildImportedTimelineFromEvents: null events treated as empty', () => {
  const result = buildImportedTimelineFromEvents(null, FPS);
  assert.deepEqual(result.tracks, []);
});

test('buildImportedTimelineFromEvents: single event produces one track, one item', () => {
  const result = buildImportedTimelineFromEvents(
    [makeEvent('00:00:00:00', '00:00:01:00')],
    FPS
  );
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].items.length, 1);
});

test('buildImportedTimelineFromEvents: item inF/outF correct for 24fps', () => {
  const result = buildImportedTimelineFromEvents(
    [makeEvent('00:00:10:00', '00:00:20:00')],
    FPS
  );
  const item = result.tracks[0].items[0];
  assert.equal(item.inF,  10 * 24);  // 240
  assert.equal(item.outF, 20 * 24);  // 480
});

test('buildImportedTimelineFromEvents: durationFrames spans all events', () => {
  const result = buildImportedTimelineFromEvents([
    makeEvent('00:00:00:00', '00:00:05:00'),
    makeEvent('00:00:05:00', '00:01:00:00'),
  ], FPS);
  // Total span: 0 → 60s = 1440 frames
  assert.equal(result.durationFrames, 1440);
});

// ── filtering ─────────────────────────────────────────────────────────────────

test('buildImportedTimelineFromEvents: disabled events skipped with hideDisabled', () => {
  const events = [
    makeEvent('00:00:00:00', '00:00:01:00', { disabled: false }),
    makeEvent('00:00:01:00', '00:00:02:00', { disabled: true }),
  ];
  const result = buildImportedTimelineFromEvents(events, FPS, { hideDisabled: true });
  assert.equal(result.tracks[0]?.items.length, 1);
});

test('buildImportedTimelineFromEvents: disabled events kept without hideDisabled', () => {
  const events = [
    makeEvent('00:00:00:00', '00:00:01:00', { disabled: false }),
    makeEvent('00:00:01:00', '00:00:02:00', { disabled: true }),
  ];
  const result = buildImportedTimelineFromEvents(events, FPS, { hideDisabled: false });
  assert.equal(result.tracks[0]?.items.length, 2);
});

test('buildImportedTimelineFromEvents: audio events filtered by default', () => {
  const events = [
    makeEvent('00:00:00:00', '00:00:01:00', { type: 'video' }),
    makeEvent('00:00:00:00', '00:00:01:00', { type: 'audio' }),
  ];
  const result = buildImportedTimelineFromEvents(events, FPS);
  assert.equal(result.tracks[0]?.items.length, 1,
    'Audio event should be filtered when includeAudio=false');
});

test('buildImportedTimelineFromEvents: audio events included with includeAudio', () => {
  const events = [
    makeEvent('00:00:00:00', '00:00:01:00', { type: 'video' }),
    makeEvent('00:00:01:00', '00:00:02:00', { type: 'audio' }),
  ];
  const result = buildImportedTimelineFromEvents(events, FPS, { includeAudio: true });
  const totalItems = result.tracks.reduce((n, t) => n + t.items.length, 0);
  assert.equal(totalItems, 2);
});

test('buildImportedTimelineFromEvents: events with invalid TC skipped', () => {
  const events = [
    makeEvent('00:00:00:00', '00:00:01:00'),  // valid
    makeEvent('bad:tc',       'also:bad'),     // invalid
    { clipName: 'NoTC' },                     // no TC at all
  ];
  const result = buildImportedTimelineFromEvents(events, FPS);
  assert.equal(result.tracks[0]?.items.length, 1);
});

test('buildImportedTimelineFromEvents: zero-duration event skipped', () => {
  const events = [
    makeEvent('00:00:01:00', '00:00:01:00'),  // outF === inF → skip
    makeEvent('00:00:00:00', '00:00:01:00'),  // valid
  ];
  const result = buildImportedTimelineFromEvents(events, FPS);
  assert.equal(result.tracks[0]?.items.length, 1);
});

// ── multi-track ───────────────────────────────────────────────────────────────

test('buildImportedTimelineFromEvents: V1 and V2 events on separate tracks', () => {
  const events = [
    makeEvent('00:00:00:00', '00:00:01:00', { trackIndex: 0, role: 'V1' }),
    makeEvent('00:00:00:00', '00:00:01:00', { trackIndex: 1, role: 'V2' }),
  ];
  const result = buildImportedTimelineFromEvents(events, FPS);
  assert.equal(result.tracks.length, 2, 'Separate trackIndex values → separate tracks');
});

// ── seqBaseFrames override ────────────────────────────────────────────────────

test('buildImportedTimelineFromEvents: seqBaseFrames option overrides natural base', () => {
  const events = [
    makeEvent('01:00:00:00', '01:00:01:00'),  // natural base = 86400
  ];
  const result = buildImportedTimelineFromEvents(events, FPS, { seqBaseFrames: 0 });
  // With seqBase=0 and event at 1h, duration should be much larger than 24
  assert.ok(result.baseFrames === 0, `Expected baseFrames=0, got ${result.baseFrames}`);
});

// ── items sorted by recIn ─────────────────────────────────────────────────────

test('buildImportedTimelineFromEvents: items sorted by inF within track', () => {
  const events = [
    makeEvent('00:00:10:00', '00:00:11:00'),
    makeEvent('00:00:00:00', '00:00:01:00'),
    makeEvent('00:00:05:00', '00:00:06:00'),
  ];
  const result = buildImportedTimelineFromEvents(events, FPS);
  const items = result.tracks[0].items;
  assert.equal(items[0].inF, 0);
  assert.equal(items[1].inF, 5 * 24);
  assert.equal(items[2].inF, 10 * 24);
});

// ── explodeOverlaps ───────────────────────────────────────────────────────────

test('buildImportedTimelineFromEvents: overlapping items stay in one track by default', () => {
  const events = [
    makeEvent('00:00:00:00', '00:00:10:00'),
    makeEvent('00:00:05:00', '00:00:15:00'),  // overlaps with first
  ];
  const result = buildImportedTimelineFromEvents(events, FPS, { explodeOverlaps: false });
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].items.length, 2);
});

test('buildImportedTimelineFromEvents: explodeOverlaps splits into visual lanes', () => {
  const events = [
    makeEvent('00:00:00:00', '00:00:10:00'),
    makeEvent('00:00:05:00', '00:00:15:00'),  // overlaps → needs extra lane
  ];
  const result = buildImportedTimelineFromEvents(events, FPS, { explodeOverlaps: true });
  // Two overlapping items → 2 visual tracks
  assert.ok(result.tracks.length >= 2, `Expected ≥2 tracks with explodeOverlaps, got ${result.tracks.length}`);
});
