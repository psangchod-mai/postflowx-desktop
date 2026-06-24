/**
 * Tests for postflowx-adobe/src/core/cutDiffEngine.ts
 * Run: node --experimental-strip-types --test tests/js/cutdiff_engine.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSnapshots } from '../src/core/cutDiffEngine.ts';
import type { TimelineSnapshot, ClipSnapshot } from '../src/model/timeline.ts';
import type { MarkerSnapshot } from '../src/model/timeline.ts';

// ── helpers ───────────────────────────────────────────────────────────────────

let _clipSeq = 0;
let _snapSeq = 0;

function makeClip(overrides: Partial<ClipSnapshot> = {}): ClipSnapshot {
  const id = `clip_${++_clipSeq}`;
  return {
    clipId:        id,
    projectItemId: id,
    hostType:      'videoClipTrackItem',
    name:          `Clip ${id}`,
    startTicks:    '0',
    endTicks:      '864000',
    inTicks:       '0',
    outTicks:      '864000',
    sourcePath:    `/media/${id}.mov`,
    ...overrides,
  };
}

function makeSnapshot(clips: ClipSnapshot[], overrides: Partial<TimelineSnapshot> = {}): TimelineSnapshot {
  const id = `snap_${++_snapSeq}`;
  return {
    projectId:       'proj',
    projectName:     'Test Project',
    sequenceId:      'seq',
    sequenceName:    'Sequence 1',
    revisionToken:   id,
    capturedAtIso:   new Date().toISOString(),
    playheadTicks:   '0',
    selectedClipIds: [],
    markers:         [],
    tracks: [{
      trackId: 'V1',
      kind:    'video',
      index:   0,
      clips,
    }],
    ...overrides,
  };
}

// ── no changes ────────────────────────────────────────────────────────────────

test('compareSnapshots: identical snapshots → no diffs', () => {
  const clip = makeClip();
  const base = makeSnapshot([clip]);
  const latest = makeSnapshot([{ ...clip }]);
  const diff = compareSnapshots(base, latest);
  assert.equal(diff.clipDiffs.length, 0);
  assert.equal(diff.hasChanges, false);
});

// ── added clip ────────────────────────────────────────────────────────────────

test('compareSnapshots: new clip → added diff', () => {
  const existing = makeClip();
  const added = makeClip();
  const base   = makeSnapshot([existing]);
  const latest = makeSnapshot([existing, added]);
  const diff = compareSnapshots(base, latest);

  const addedDiffs = diff.clipDiffs.filter(d => d.kind === 'added');
  assert.equal(addedDiffs.length, 1);
  assert.equal(addedDiffs[0].clipId, added.clipId);
  assert.equal(diff.hasChanges, true);
});

// ── removed clip ──────────────────────────────────────────────────────────────

test('compareSnapshots: removed clip → removed diff', () => {
  const clip1 = makeClip();
  const clip2 = makeClip();
  const base   = makeSnapshot([clip1, clip2]);
  const latest = makeSnapshot([clip1]);
  const diff = compareSnapshots(base, latest);

  const removedDiffs = diff.clipDiffs.filter(d => d.kind === 'removed');
  assert.equal(removedDiffs.length, 1);
  assert.equal(removedDiffs[0].clipId, clip2.clipId);
});

// ── moved clip ────────────────────────────────────────────────────────────────

test('compareSnapshots: startTicks changed → moved diff', () => {
  const clip = makeClip({ startTicks: '0' });
  const base   = makeSnapshot([clip]);
  const latest = makeSnapshot([{ ...clip, startTicks: '432000' }]);
  const diff = compareSnapshots(base, latest);

  const movedDiffs = diff.clipDiffs.filter(d => d.kind === 'moved');
  assert.equal(movedDiffs.length, 1);
  assert.equal(movedDiffs[0].clipId, clip.clipId);
});

// ── trimmed clip ───────────────────────────────────────────────────────────────

test('compareSnapshots: inTicks changed → trimmed diff', () => {
  const clip = makeClip({ inTicks: '0', outTicks: '864000' });
  const base   = makeSnapshot([clip]);
  const latest = makeSnapshot([{ ...clip, inTicks: '100000' }]);
  const diff = compareSnapshots(base, latest);

  const trimmed = diff.clipDiffs.filter(d => d.kind === 'trimmed');
  assert.equal(trimmed.length, 1);
});

test('compareSnapshots: outTicks changed → trimmed diff', () => {
  const clip = makeClip({ outTicks: '864000' });
  const base   = makeSnapshot([clip]);
  const latest = makeSnapshot([{ ...clip, outTicks: '720000' }]);
  const diff = compareSnapshots(base, latest);

  const trimmed = diff.clipDiffs.filter(d => d.kind === 'trimmed');
  assert.equal(trimmed.length, 1);
});

// ── renamed clip ───────────────────────────────────────────────────────────────

test('compareSnapshots: name changed → renamed diff', () => {
  const clip = makeClip({ name: 'Original Name' });
  const base   = makeSnapshot([clip]);
  const latest = makeSnapshot([{ ...clip, name: 'New Name' }]);
  const diff = compareSnapshots(base, latest);

  const renamed = diff.clipDiffs.filter(d => d.kind === 'renamed');
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0].clipId, clip.clipId);
});

// ── relinked clip ─────────────────────────────────────────────────────────────

test('compareSnapshots: sourcePath changed → relinked diff', () => {
  const clip = makeClip({ sourcePath: '/old/path.mov' });
  const base   = makeSnapshot([clip]);
  const latest = makeSnapshot([{ ...clip, sourcePath: '/new/path.mov' }]);
  const diff = compareSnapshots(base, latest);

  const relinked = diff.clipDiffs.filter(d => d.kind === 'relinked');
  assert.equal(relinked.length, 1);
  assert.ok(relinked[0].detail?.includes('/old/path.mov'));
});

// ── markers ───────────────────────────────────────────────────────────────────

test('compareSnapshots: new marker → marker-added diff', () => {
  const clip = makeClip();
  const marker: MarkerSnapshot = { markerId: 'm1', startTicks: '100', durationTicks: '0', name: 'Cut', comments: '', colorIndex: 0, markerType: 'comment' };
  const base   = makeSnapshot([clip]);
  const latest = makeSnapshot([clip], { markers: [marker] });
  const diff = compareSnapshots(base, latest);

  const added = diff.markerDiffs.filter(d => d.kind === 'marker-added');
  assert.equal(added.length, 1);
  assert.equal(added[0].markerId, 'm1');
});

test('compareSnapshots: removed marker → marker-removed diff', () => {
  const clip = makeClip();
  const marker: MarkerSnapshot = { markerId: 'm2', startTicks: '200', durationTicks: '0', name: 'Mark', comments: '', colorIndex: 1, markerType: 'comment' };
  const base   = makeSnapshot([clip], { markers: [marker] });
  const latest = makeSnapshot([clip], { markers: [] });
  const diff = compareSnapshots(base, latest);

  const removed = diff.markerDiffs.filter(d => d.kind === 'marker-removed');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].markerId, 'm2');
});

// ── live state ────────────────────────────────────────────────────────────────

test('compareSnapshots: playhead change reported', () => {
  const clip = makeClip();
  const base   = makeSnapshot([clip], { playheadTicks: '0' });
  const latest = makeSnapshot([clip], { playheadTicks: '432000' });
  const diff = compareSnapshots(base, latest);

  assert.equal(diff.liveState.playheadChanged, true);
  assert.equal(diff.liveState.previousPlayheadTicks, '0');
  assert.equal(diff.liveState.currentPlayheadTicks, '432000');
});

test('compareSnapshots: selection change reported', () => {
  const clip = makeClip();
  const base   = makeSnapshot([clip], { selectedClipIds: [] });
  const latest = makeSnapshot([clip], { selectedClipIds: [clip.clipId] });
  const diff = compareSnapshots(base, latest);

  assert.equal(diff.liveState.selectionChanged, true);
});

// ── multiple changes ──────────────────────────────────────────────────────────

test('compareSnapshots: multiple simultaneous changes all detected', () => {
  const unchanged = makeClip();
  const moved     = makeClip({ startTicks: '0' });
  const removed   = makeClip();

  const base = makeSnapshot([unchanged, moved, removed]);
  const added = makeClip();
  const latest = makeSnapshot([
    unchanged,
    { ...moved, startTicks: '864000' },
    added,
  ]);

  const diff = compareSnapshots(base, latest);
  const kinds = new Set(diff.clipDiffs.map(d => d.kind));
  assert.ok(kinds.has('moved'));
  assert.ok(kinds.has('removed'));
  assert.ok(kinds.has('added'));
  assert.equal(diff.hasChanges, true);
});
