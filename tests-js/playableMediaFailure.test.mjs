// tests-js/playableMediaFailure.test.mjs
// What PostFlowX tells you when it could not play a clip.
//
// WHY THIS EXISTS
// playableMedia.js is the module that decides, per clip, whether the browser
// plays it, the native AVFoundation engine plays it, mpv plays it, or nobody
// does. When nobody does it calls onProxyFail(hint), and seven modules render
// that hint verbatim into a one-line status strip. Three of those hints were
// written as English literals that said more than the code knew:
//
//   1. The mpv catch read
//        `... (${err.message.includes('not found') ? 'mpv not installed' : err.message}) ...`
//      A substring test on an English message decided the diagnosis, and the
//      default handed the raw exception to the UI. Measured against what
//      mpv_engine.js actually throws, the default was the common case:
//      _waitForSocket rejects with "MPV socket not created at
//      /var/folders/…/mpv-3.sock within 4000ms" — no "not found" in it — so
//      somebody whose mpv is installed but wedged read a temp-directory socket
//      path where a sentence should be.
//   2. "could not decode with the native player" was printed whenever
//      _pfxNativeAttempted was set. That flag is set on *entry* to
//      _startNativeAVPath, so it proves the native path was tried and nothing
//      about decoding. An engine that failed to open and a genuinely
//      undecodable file produced the same confident sentence.
//   3. "could not create playback URL" is a sentence about our plumbing.
//
// A vague message wastes a minute. A specific and false one — "mpv not
// installed" to someone who installed mpv this morning — wastes an afternoon.
//
// WHAT IS PINNED HERE
// Every rejection in the corpus is cited to the line that throws it, and the
// wording of those throws is pinned in their own files, so rewording a throw
// fails this file rather than silently retiring the rule that matched it. On
// top of that: nothing claims an mpv install problem unless mpv was actually
// missing, no reason echoes a filesystem path, and every reason is one line.
//
// WHAT THIS CANNOT SEE
// - Whether mpv_engine.js's open() can reject in a way nobody here enumerated.
//   The floors below pin the three throws that exist today; a fourth added
//   later falls to friendlyError and then to the honest catch-all, which is a
//   true answer but not a helpful one.
// - Site 3 (`could not prepare this file for playback`) is also reached when
//   the token moved on mid-load, i.e. when the user already selected another
//   clip. The forwarder in attachPlayableVideo drops those, but this direct
//   call site is not behind it. That is pre-existing and unchanged here.
// - Whether the six locales read well. errorI18n.test.mjs proves the rows
//   exist, are short, and are not English. Not that they are good Thai.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { _playbackFailReason } from '../src/scripts/core/playableMedia.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(ROOT + p, 'utf8');

const MEDIA_PATH = 'src/scripts/core/playableMedia.js';
const ENGINE_PATH = 'electron/native/mpv_engine.js';
const PLAYER_PATH = 'src/scripts/core/mpvPlayer.js';
const media = read(MEDIA_PATH);

// ── The corpus, with the line that produces each one ─────────────────────────

const REJECTIONS = [
  ['mpv not found. Install mpv: brew install mpv', /not installed/i,
    `${ENGINE_PATH}:109 — _findMpv() found no binary`],
  ['MPV socket not created at /var/folders/qq/T/mpv-3.sock within 4000ms', /did not start/i,
    `${ENGINE_PATH}:99 — mpv spawned but never opened its IPC socket`],
  ['MPV open failed', /did not start/i,
    `${PLAYER_PATH}:52 — the main process answered without ok/sessionId`],
  ['MPV IPC error: property unavailable', /did not start/i,
    `${ENGINE_PATH}:80 — the socket answered with an error`],
  ['EACCES: permission denied, open \'/Volumes/SHOW/a.mov\'', /permission/i,
    'friendlyError — an unmounted or locked volume'],
];

for (const [raw, expect, where] of REJECTIONS) {
  test(`says something true for: ${raw.slice(0, 44)}`, () => {
    assert.match(_playbackFailReason(new Error(raw)), expect, `from ${where}`);
  });
}

// ── The finding itself ───────────────────────────────────────────────────────

test('nothing is called an mpv install problem unless mpv was missing', () => {
  // The whole point of this file. The old branch decided this by looking for
  // the substring "not found" anywhere in the message, so any rejection that
  // happened to mention something not being found became an install problem.
  const MPV_IS_INSTALLED = [
    'MPV socket not created at /var/folders/qq/T/mpv-3.sock within 4000ms',
    'MPV open failed',
    'MPV IPC error: property unavailable',
    'ENOENT: no such file or directory, open \'/Volumes/SHOW/a001.mov\'',
    'the source file could not be found',
    'Timed out after 15000ms',
    'blorp',
  ];
  for (const raw of MPV_IS_INSTALLED) {
    const out = _playbackFailReason(new Error(raw));
    assert.doesNotMatch(out, /not installed|MPV_NOT_FOUND/i,
      `blames the mpv install for "${raw}": ${out}`);
  }

  // And the one case where it IS the install keeps saying so.
  assert.match(_playbackFailReason(new Error('mpv not found. Install mpv: brew install mpv')),
    /mpv is not installed/i);
});

test('no reason hands the user a filesystem path or a raw exception', () => {
  for (const [raw] of REJECTIONS) {
    const out = _playbackFailReason(new Error(raw));
    assert.doesNotMatch(out, /\/[A-Za-z_.-]+\//,
      `a path leaked into a status strip: ${out}`);
    assert.ok(!out.includes(raw),
      `the raw exception is being echoed verbatim: ${out}`);
  }
});

test('the old literals are gone from the source', () => {
  // Comments stripped first: the block above _PLAYBACK_FAIL_REASONS quotes the
  // old ternary in order to explain why it was wrong, and that prose is the
  // record of this finding. What must not come back is code that behaves that
  // way.
  const code = media.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '');
  assert.doesNotMatch(code, /includes\('not found'\)/,
    'the English-substring branch is back in playableMedia.js');
  assert.doesNotMatch(code, /could not decode with the native player/,
    'the native path is asserting a decode failure it has not established again');
  assert.doesNotMatch(code, /could not create playback URL/,
    '"playback URL" is back in front of a colourist');
  assert.doesNotMatch(code, /Direct ProRes playback failed/,
    'the untranslated mpv literal is back');
});

test('all three hints are routed through translate()', () => {
  // An English literal in an onProxyFail call is invisible to i18n.js — it is
  // not a key, so it can never be a row. Every one of the three must be either
  // a translate() call or the reason function, which translates internally.
  const calls = [...media.matchAll(/onProxyFail\?\.\(\s*\n?\s*`([^`]*)`/g)].map((m) => m[1]);
  assert.ok(calls.length >= 3, `only found ${calls.length} onProxyFail literals — did the file change shape?`);
  for (const c of calls) {
    // Strip the interpolations, then nothing but punctuation and whitespace
    // may be left. Anything else is an untranslated English sentence.
    const literal = c.replace(/\$\{[^}]*\}/g, '').trim();
    assert.match(literal, /^[\s—.,:;?!-]*$/,
      `untranslated English in an onProxyFail hint: ${JSON.stringify(c)}`);
  }
});

// ── Floors: the throws these rules match must still say what they say ────────

test('floor: mpv_engine.js still throws the two messages the table matches', () => {
  // If either wording changes, the rule that matched it goes dead while every
  // assertion above still passes — the reason this is checked in the source and
  // not only through the function.
  const engine = read(ENGINE_PATH);
  assert.match(engine, /new Error\('mpv not found\./,
    `${ENGINE_PATH} no longer says "mpv not found" — the /mpv not found/ rule is dead`);
  assert.match(engine, /MPV socket not created at/,
    `${ENGINE_PATH} no longer says "socket not created" — the /socket not created/ rule is dead`);
});

test('floor: mpvPlayer.js still throws the message the table matches', () => {
  assert.match(read(PLAYER_PATH), /'MPV open failed'/,
    `${PLAYER_PATH} no longer says "MPV open failed" — that rule is dead`);
});

test('floor: _pfxNativeAttempted is still set on entry, not on failure', () => {
  // The whole justification for finding #2. If someone moves this assignment
  // into a catch, the flag would then genuinely mean "the native player
  // failed", and the wording could go back to being specific.
  const fn = media.slice(media.indexOf('function _startNativeAVPath'));
  const head = fn.slice(0, fn.indexOf('const canvas = mountNativeCanvas'));
  assert.match(head, /_pfxNativeAttempted = true;/,
    'the flag moved out of the top of _startNativeAVPath — re-read whether the ' +
    'wording at the _pfxNativeAttempted branch can now be more specific');
});

// ── Shape: these land in a one-line strip somebody else styles ───────────────

test('every reason is one line and short enough for a status strip', () => {
  const ALL = [...REJECTIONS.map(([r]) => r), 'blorp', '', 'Failed to fetch'];
  for (const raw of ALL) {
    const out = _playbackFailReason(new Error(raw));
    assert.ok(out, `empty reason for: ${JSON.stringify(raw)}`);
    assert.doesNotMatch(out, /\n/, `a newline would collapse in the caller's strip: ${JSON.stringify(out)}`);
    assert.ok(out.length < 120, `too long for a status line (${out.length}): ${out}`);
  }
});

test('an unrecognised failure says only what is certainly true', () => {
  for (const raw of ['blorp', '', null, undefined]) {
    assert.equal(_playbackFailReason(raw), 'this file could not be opened for playback');
  }
});

test('a named DOMException is classified by its name', () => {
  // A DOMException keeps the useful half of its identity in .name; a reason
  // function that reads only .message loses the classification the moment the
  // thrower rewords itself.
  const t = new DOMException('signal aborted without explanation', 'TimeoutError');
  assert.match(_playbackFailReason(t), /did not start/i);
});

// ── Vacuity floor ────────────────────────────────────────────────────────────

test('floor: the corpus is not empty and the rules are not all one rule', () => {
  assert.ok(REJECTIONS.length >= 5, `corpus shrank to ${REJECTIONS.length}`);
  const distinct = new Set(REJECTIONS.map(([r]) => _playbackFailReason(new Error(r))));
  assert.ok(distinct.size >= 3,
    `only ${distinct.size} distinct answers for ${REJECTIONS.length} rejections — a catch-all would pass this file`);
});
