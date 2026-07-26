// tests-js/friendlyErrorDomExceptions.test.mjs
// The DOM's own exceptions, which friendlyError had no rules for.
//
// WHY THIS EXISTS
// friendlyError's table was written against Node and ffmpeg failures — errno
// codes, decoder complaints, fetch errors. Everything a *browser* throws fell
// straight through and reached the user verbatim. Measured against the thirteen
// DOMException strings this app's own code proves it can hit, thirteen out of
// thirteen came out as raw text: "SecurityError: Failed to execute
// 'getImageData' on 'CanvasRenderingContext2D': The canvas has been tainted by
// cross-origin data." is what a colourist saw when Visual QC could not read a
// frame, and iteration 25 had just finished routing that very strip through
// friendlyStatus — which made the pass-through the whole remaining problem.
//
// THE ONE THAT CHANGED THE WORDING
// The obvious rule for AbortError is "Cancelled". It is wrong. Three sites in
// this app check `err.name === 'AbortError'` to mean *the user dismissed a file
// picker* (features/reviews/index.js, ui.js, features/tl_convert/index.js) —
// but eight others arm `setTimeout(() => ctrl.abort())` on a fetch, and the DOM
// hands back the identical text "The user aborted a request." for both. Telling
// someone "you cancelled this" when their companion had gone quiet is a false
// statement dressed up as a friendly one. The rule says "stopped before it
// finished" instead, which is true either way, and the wording is pinned below
// so it cannot drift back.
//
// WHAT THIS CANNOT SEE
// - QuotaExceededError and NotReadableError are still unmatched, deliberately.
//   prep_mark.js:4085 already catches the quota case and shows its own message,
//   so the rule would never fire; NotReadableError is a capture-device error and
//   this app captures only audio, in one place that has its own handler. Both
//   were left out rather than paying eighteen dictionary rows each for a rule
//   that measurement says nothing reaches.
// - Whether the six locales read well. They are machine-authored; errorI18n
//   proves they exist, are short enough, and are not English. Not that they are
//   good Thai.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { friendlyError } from '../src/scripts/core/friendlyError.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(ROOT + p, 'utf8');

// Real exception text, each paired with the place in this repo that can throw
// it. The citation is not decoration: a corpus of invented strings would prove
// the rules match themselves and nothing else.
const CLASSIFIED = [
  ["NotAllowedError: play() failed because the user didn't interact with the document first.",
    'Not allowed', 'any of the 38 .play() calls'],
  ['NotAllowedError: Permission dismissed',
    'Not allowed', 'src/scripts/prep_mark.js:29280 — microphone'],
  ['PermissionDeniedError: The request is not allowed by the user agent',
    'Not allowed', 'the same, under the legacy name'],
  ["SecurityError: Failed to execute 'getImageData' on 'CanvasRenderingContext2D': The canvas has been tainted by cross-origin data.",
    'Could not read the video frame', 'src/scripts/components/visualQcModal/index.js:425'],
  ['SecurityError: The operation is insecure.',
    'Could not read the video frame', 'src/scripts/modules/imf/imf_player.js:1538'],
  ['AbortError: The user aborted a request.',
    'Stopped before it finished', 'src/scripts/prep_mark.js:12778 and six fetch timeouts'],
  ['AbortError: The play() request was interrupted by a call to pause().',
    'Stopped before it finished', 'transport scrubbing over a paused player'],
  ['The operation was aborted.',
    'Stopped before it finished', 'an AbortController with no name on the message'],
  ['NotSupportedError: The element has no supported sources.',
    'Could not decode media', 'a <video> handed media the engine cannot open'],
  ['MEDIA_ELEMENT_ERROR: Format error',
    'Could not decode media', 'the same, as the element reports it'],
  ["InvalidStateError: Failed to execute 'createMediaElementSource' on 'AudioContext': HTMLMediaElement already connected previously to a different MediaElementSourceNode.",
    'Something went wrong', 'src/scripts/modules/imf/imf_ui.js:594'],
];

for (const [raw, title, where] of CLASSIFIED) {
  test(`classifies: ${raw.slice(0, 44)}… → ${title}`, () => {
    assert.equal(friendlyError(raw).title, title, `from ${where}`);
  });
}

// ── The corpus has to still describe this codebase ───────────────────────────
// Rules kept for exceptions nothing can throw are dead weight that reads like
// coverage. If a construct below goes away, the matching rule should be
// reconsidered rather than left to rot.

test('floor: the constructs these rules exist for are still in the source', () => {
  const STILL_THERE = [
    ['src/scripts/components/visualQcModal/index.js', /getImageData\s*\(/, 'Visual QC still reads pixels'],
    ['src/scripts/modules/imf/imf_ui.js', /createMediaElementSource\s*\(/, 'the IMF audio meter still re-attaches'],
    ['src/scripts/prep_mark.js', /getUserMedia\s*\(|NotAllowedError/, 'something still asks for the microphone'],
    ['src/scripts/auth/policyApi.js', /setTimeout\(\(\)\s*=>\s*\w+\.abort\(\)/, 'a fetch timeout still presents as an abort'],
  ];
  for (const [file, re, why] of STILL_THERE) {
    assert.match(read(file), re, `${why} — ${file} no longer matches ${re}`);
  }
});

// ── Ordering: every one of these pairs would collide if the table moved ──────

test('an abort that names a timeout stays a timeout', () => {
  // AbortSignal.timeout() rejects with text that says so, and "Timed out" gives
  // the better advice of the two — check the connection, not "try again". The
  // abort rule therefore sits BELOW the timeout rule; moving it up silently
  // swaps a useful message for a vague one.
  assert.equal(friendlyError('AbortError: The operation was aborted due to timeout').title, 'Timed out');
  assert.equal(friendlyError('TimeoutError: signal timed out').title, 'Timed out');
});

test('a filesystem permission error is not claimed by the browser rule', () => {
  // Two different refusals with two different fixes: pick another folder and
  // grant Files & Folders access, versus click in the window. The new rule sits
  // above EACCES, so this pins that it did not swallow it.
  const f = friendlyError("EACCES: permission denied, open '/Volumes/SHOW DRIVE 01/a.ari'");
  assert.equal(f.title, 'Permission denied');
  assert.match(f.hint, /Files & Folders/);
});

test('a CORS fetch failure is not claimed by the canvas rule', () => {
  // The first draft of the tainted-canvas rule matched a bare "cross-origin",
  // which a blocked fetch also says — and "copy the file to a local drive" is
  // useless advice for an unreachable companion. That alternative was dropped
  // before it shipped; this pins that it stays dropped.
  assert.equal(friendlyError('TypeError: Failed to fetch').title, 'Network problem');
  // Measured, not assumed: neither browser's CORS sentence matches any rule
  // today, and that is fine — an unclassified string reaches the user as
  // itself, which is where it started. What must never happen is the *wrong*
  // answer. Re-adding "cross-origin" to the canvas rule turns both of these
  // into "copy the file to a local drive", which is nonsense advice for a
  // companion the browser refused to talk to.
  for (const cors of [
    'Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at http://127.0.0.1:8765/status',
    'Access to fetch at http://127.0.0.1:8765 has been blocked by CORS policy',
  ]) {
    assert.notEqual(friendlyError(cors).title, 'Could not read the video frame', cors);
  }
});

test('widening the decode rule did not disturb what it already caught', () => {
  assert.equal(friendlyError('moov atom not found').title, 'Could not decode media');
  assert.equal(friendlyError('ffmpeg exited with code 1').title, 'Could not decode media');
  assert.equal(friendlyError('Failed to mux output stream').title, 'Export could not be written');
});

// ── The honest-wording constraint ────────────────────────────────────────────

test('the abort message does not tell the user they cancelled', () => {
  // This is the finding, not a style preference. Eight of the eleven places
  // this app can produce an abort are fetch timeouts; three are a dismissed
  // picker, and the two are textually indistinguishable. Any wording that
  // asserts intent is wrong most of the time.
  const f = friendlyError('AbortError: The user aborted a request.');
  for (const part of [f.title, f.message, f.hint]) {
    assert.doesNotMatch(part, /cancel/i, `claims the user cancelled: ${part}`);
    assert.doesNotMatch(part, /\byou (cancelled|canceled|stopped|aborted)\b/i, `blames the user: ${part}`);
  }
  assert.match(f.message, /stopped before it finished/i);
});

// ── Quality of what the user reads, for the new set specifically ─────────────

test('no new message leaks an exception name at the user', () => {
  // The whole point. A rule that classifies correctly and then prints
  // "NotAllowedError" back has done nothing.
  const NAMES = /\b(NotAllowedError|SecurityError|AbortError|NotSupportedError|InvalidStateError|PermissionDeniedError|DOMException|getImageData|CanvasRenderingContext2D|MEDIA_ELEMENT_ERROR)\b/;
  for (const [raw] of CLASSIFIED) {
    const f = friendlyError(raw);
    assert.doesNotMatch(f.title, NAMES, `title: ${f.title}`);
    assert.doesNotMatch(f.message, NAMES, `message: ${f.message}`);
    assert.doesNotMatch(f.hint, NAMES, `hint: ${f.hint}`);
  }
});

test('every new failure offers one next step, short enough for a toast', () => {
  for (const [raw] of CLASSIFIED) {
    const { hint } = friendlyError(raw);
    assert.ok(hint, `no hint for: ${raw}`);
    assert.ok(hint.length < 170, `hint too long for a toast (${hint.length}): ${hint}`);
  }
});

test('the raw text is still kept for a support log', () => {
  const raw = 'SecurityError: The operation is insecure.';
  assert.equal(friendlyError(raw).raw, raw);
});

// ── Vacuity floor ────────────────────────────────────────────────────────────

test('floor: the corpus is not empty and the rules are not all one rule', () => {
  assert.ok(CLASSIFIED.length >= 11, `corpus shrank to ${CLASSIFIED.length}`);
  const titles = new Set(CLASSIFIED.map(([, t]) => t));
  assert.ok(titles.size >= 5, `only ${titles.size} distinct outcomes — a catch-all would pass this file`);
});
