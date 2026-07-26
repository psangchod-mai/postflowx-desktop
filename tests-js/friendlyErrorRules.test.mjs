import { test } from 'node:test';
import assert from 'node:assert/strict';
import { friendlyError, friendlyText } from '../src/scripts/core/friendlyError.js';

// Companion to friendlyError.test.mjs, which covers the original rule set.
// This file pins the failures that used to fall through to raw text, plus the
// rule-ordering pairs that would collide if the table is ever reordered.
//
// friendlyError is what ui.js showError() and three separate _showToast
// implementations route through, so it is the single place a non-technical user
// meets a failure. Inputs here are real strings this app produces:
// "memory access out of bounds" is the WASM crash render_queue.js already
// special-cases for jobs, and it reaches the error banner by the same route.

// ── Previously fell through as raw technical text ────────────────────────────

const NEWLY_CLASSIFIED = [
  ['EBUSY: resource busy or locked',                    'File is in use'],
  ['Error: EBUSY: resource busy, unlink',               'File is in use'],
  ['moov atom not found',                               'Could not decode media'],
  ['Invalid data found when processing input',          'Could not decode media'],
  ['Failed to mux output stream',                       'Export could not be written'],
  ['Encoding failed at frame 1024',                     'Export could not be written'],
  ['RuntimeError: memory access out of bounds',         'Ran out of memory'],
  ['memory access out of bounds',                       'Ran out of memory'],
  ['fetch failed',                                      'Network problem'],
  ['getaddrinfo ENOTFOUND api.example.com',             'Network problem'],
];

for (const [raw, title] of NEWLY_CLASSIFIED) {
  test(`classifies: ${raw.slice(0, 42)} → ${title}`, () => {
    assert.equal(friendlyError(raw).title, title);
  });
}

// ── Rule ordering is load-bearing ────────────────────────────────────────────
// First match wins, so a broad rule placed above a precise one silently
// swallows it. Each of these pins a pair that would actually collide.

test('a locked file is not reported as a permissions problem', () => {
  // Both rules could plausibly claim this, and the two fixes are different:
  // one is "close it in Resolve", the other is "grant Full Disk Access".
  assert.equal(friendlyError('EBUSY: resource busy, unlink').title, 'File is in use');
});

test('a WASM crash is not swallowed by the generic programming-error rule', () => {
  // The generic rule matches "out of memory" and would give the wrong advice:
  // restarting the app, when the memory is held by other open decoders.
  const f = friendlyError('RuntimeError: memory access out of bounds');
  assert.equal(f.title, 'Ran out of memory');
  assert.match(f.hint, /Close the other tabs/);
  assert.doesNotMatch(f.hint, /restart the app/i);
});

test('a bare ffmpeg exit stays a decode problem rather than being guessed at', () => {
  // Nothing in the string says which end failed, so the narrow encode rule must
  // NOT claim it — guessing "check your output folder" sends the user away from
  // the input media that is actually broken.
  assert.equal(friendlyError('ffmpeg exited with code 1').title, 'Could not decode media');
});

test('an explicit write failure is not reported as unreadable media', () => {
  assert.equal(friendlyError('failed to write output file').title, 'Export could not be written');
});

// ── Pass-through must survive: the app writes good messages already ──────────

const ALREADY_GOOD = [
  'Scan a VFX folder first.',
  'Load a proxy video file in the tab, then retry',
  'Open the Cut Diff tab, then retry',
  'Ensure shots/markers are set in the tab, then retry',
];

for (const raw of ALREADY_GOOD) {
  test(`leaves an already-friendly message alone: ${raw.slice(0, 38)}`, () => {
    const f = friendlyError(raw);
    assert.equal(f.title, '', `was wrongly classified as "${f.title}"`);
    assert.equal(friendlyText(raw), raw);
  });
}

// ── Quality of what the user actually reads ──────────────────────────────────

test('no classified message leaks jargon into user-facing text', () => {
  const JARGON = /\b(ENOENT|EACCES|EPERM|ENOSPC|EBUSY|ECONNREFUSED|ENOTFOUND|RuntimeError|TypeError|WASM|stderr|stack)\b/;
  for (const [raw] of NEWLY_CLASSIFIED) {
    const f = friendlyError(raw);
    assert.doesNotMatch(f.title, JARGON, `title: ${f.title}`);
    assert.doesNotMatch(f.message, JARGON, `message: ${f.message}`);
    assert.doesNotMatch(f.hint, JARGON, `hint: ${f.hint}`);
  }
});

test('every classified failure offers exactly one next step, short enough for a toast', () => {
  for (const [raw] of NEWLY_CLASSIFIED) {
    const { hint } = friendlyError(raw);
    assert.ok(hint, `no hint for: ${raw}`);
    assert.ok(hint.length < 170, `hint too long for a toast: ${hint}`);
  }
});

test('the raw text is kept for support even when it is hidden from the user', () => {
  const raw = 'RuntimeError: memory access out of bounds';
  assert.equal(friendlyError(raw).raw, raw);
});

// ── Never throws, never shows nothing ────────────────────────────────────────

test('handles everything a catch block can hand it', () => {
  for (const input of [null, undefined, '', 0, false, {}, [], new Error(), NaN, () => {}]) {
    const f = friendlyError(input);
    assert.equal(typeof f.title, 'string');
    assert.equal(typeof f.hint, 'string');
    assert.ok(f.message.length > 0, `empty message for ${String(input)}`);
  }
});

test('a message-less object does not surface as [object Object]', () => {
  // Worse than saying nothing: it looks like a crash and tells the user zero.
  assert.equal(friendlyError({}).message, 'Something went wrong.');
  assert.equal(friendlyError({ code: 42 }).message, 'Something went wrong.');
  // A shape that does carry text is still read.
  assert.equal(friendlyError({ reason: 'Scan a folder first.' }).message, 'Scan a folder first.');
});
