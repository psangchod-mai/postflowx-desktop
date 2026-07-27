// tests-js/proResProxyFailure.test.mjs
// What PostFlowX tells you when it could not build a preview proxy.
//
// WHY THIS EXISTS
// proResProxy.js is the only place in the app that says *why* a proxy build
// failed, and seven other modules render that sentence verbatim into their own
// status lines (prep_mark, playableMedia, aceslook, cutdiff, cutdiff2,
// platelink2, amf_convert). For a long time the sentence came out of a
// three-branch ternary whose default read:
//
//     : `${label} — unsupported codec`;
//
// Measured against every way getProxyStreamUrl can reject, that default was
// wrong five times out of six. A companion that stopped answering mid-poll, the
// 30-minute transcode cap, a non-OK progress response, a failed upload, and
// whatever ffmpeg itself reported all arrived at a colourist as "unsupported
// codec" — which is not a vague message, it is a specific and false one. It
// sends someone off to re-transcode a plate that was never the problem while
// the actual fault (restart the helper, reconnect the drive) goes unmentioned.
// A silent failure wastes a minute; a confidently wrong diagnosis wastes an
// afternoon.
//
// WHAT IS PINNED HERE
// The tokens are not invented. They are read back out of proResProxy.js's own
// throws and out of the companion's _update_session(error=…) calls, so a new
// rejection that nobody classified fails this file rather than reaching a user
// as a guess. On top of that: no reason may claim a codec problem unless ffmpeg
// said so, every reason is one line (these land in one-line status elements
// this module does not style), and the abort that fires on a hung companion
// carries a name so it cannot be mistaken for a user who cancelled.
//
// WHAT THIS CANNOT SEE
// - Two alternatives in the table, host_timeout and file_not_found, are not
//   produced on this file's measured path today; host_timeout comes from
//   imf_proxy.js and file_not_found from a different companion handler. Both
//   share a regex alternative with a token that IS produced, so each costs zero
//   dictionary rows — they are kept as cheap insurance, not claimed as coverage.
// - data.error can also be ffmpeg's own last line or a bare Python str(e).
//   Those have no token to enumerate; they fall to friendlyError, and the two
//   assertions below only prove that the common ones land somewhere true.
// - Deleting the transcode_timeout rule does not fail this file, and that is
//   correct rather than a hole: friendlyError classifies the token on its own
//   ("That took too long and timed out."). The dedicated rule is a wording
//   upgrade — it names the 30-minute cap as something PostFlowX did — not the
//   only thing between the user and a false message. Measured, not assumed.
// - Whether the six locales read well. errorI18n.test.mjs proves the rows exist,
//   are short, and are not English. Not that they are good Thai.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { _proxyFailReason } from '../src/scripts/modules/proResProxy.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(ROOT + p, 'utf8');

const PROXY_PATH = 'src/scripts/modules/proResProxy.js';
const HOST_PATH = 'src/tools/pfx_host.py';
const proxy = read(PROXY_PATH);
const host = read(HOST_PATH);

// ── The corpus, with the line that produces each one ─────────────────────────
// A citation per row, because a corpus of invented strings would only prove the
// rules match themselves.

const REJECTIONS = [
  ['host_unavailable', /native helper/i, `${PROXY_PATH} — no companion port`],
  ['upload_failed_413', /handed to the media helper/i, `${PROXY_PATH} — POST /upload was not ok`],
  ['transcode_timeout', /took too long/i, `${PROXY_PATH} — the 30-minute cap`],
  ['progress_fetch_failed', /stopped responding/i, `${PROXY_PATH} — GET /progress was not ok`],
  ['ffmpeg_missing', /ffmpeg/i, `${HOST_PATH}:159 — shutil.which('ffmpeg') found nothing`],
  ['input_missing', /could not be found/i, `${HOST_PATH}:162 — the plate moved after queueing`],
  ['ENOSPC: no space left on device', /disk is full/i, 'data.error — the proxy drive filled up'],
  ['EACCES: permission denied, open \'/Volumes/SHOW/a.mov\'', /permission/i, 'data.error — an unmounted or locked volume'],
];

for (const [raw, expect, where] of REJECTIONS) {
  test(`says something true for: ${raw.slice(0, 40)}`, () => {
    assert.match(_proxyFailReason(new Error(raw)), expect, `from ${where}`);
  });
}

test('a hung companion is not reported as a user cancelling', () => {
  // The per-fetch abort used to be a bare ctrl.abort(), which rejects with "The
  // user aborted a request." — the same text the DOM gives when someone
  // dismisses a file picker. Naming it lets the table tell the two apart.
  const named = new DOMException('the media helper timed out', 'TimeoutError');
  assert.match(_proxyFailReason(named), /stopped responding/i);

  // And by the name, not by that wording. A DOMException keeps the useful half
  // of its identity in .name; a reason function that reads only .message is one
  // reworded throw away from losing the classification.
  const renamed = new DOMException('signal aborted without explanation', 'TimeoutError');
  assert.match(_proxyFailReason(renamed), /stopped responding/i);

  // And a genuine abort still gets a wording that does not assert intent.
  const bare = new DOMException('The user aborted a request.', 'AbortError');
  assert.doesNotMatch(_proxyFailReason(bare), /cancel/i);
});

// ── The finding itself ───────────────────────────────────────────────────────

test('nothing is blamed on the codec unless ffmpeg said so', () => {
  // The whole point of this file. Every rejection that is NOT about decoding
  // must come back without a codec claim in it.
  const NOT_A_CODEC_PROBLEM = [
    'host_unavailable', 'transcode_timeout', 'progress_fetch_failed',
    'upload_failed_500', 'input_missing', 'ffmpeg_missing',
    'ENOSPC: no space left on device', 'Failed to fetch',
    new DOMException('the media helper timed out', 'TimeoutError'),
  ];
  for (const raw of NOT_A_CODEC_PROBLEM) {
    const out = _proxyFailReason(typeof raw === 'string' ? new Error(raw) : raw);
    assert.doesNotMatch(out, /codec|decode/i, `blames the codec for ${raw}: ${out}`);
  }

  // The one case where it IS the codec keeps saying so — the rule was made
  // narrower, not deleted.
  assert.match(_proxyFailReason(new Error('Unsupported codec in stream 0')), /decoded/i);
  assert.match(_proxyFailReason(new Error('moov atom not found')), /decoded/i);
});

test('the old ternary and its false default are gone from the source', () => {
  // Comments stripped first: the block above _PROXY_FAIL_REASONS quotes the old
  // default in order to explain why it was wrong, and that prose is the record
  // of this finding. What must not come back is the string in a code position.
  const code = proxy.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /unsupported codec/i,
    'the "unsupported codec" default is back in proResProxy.js');
  assert.match(proxy, /onProxyFail\?\.\(`\$\{label\} — \$\{_proxyFailReason\(e\)\}`\)/,
    'the catch no longer routes through _proxyFailReason');
});

test('the per-fetch abort still names itself', () => {
  // If this reverts to a bare abort(), the TimeoutError branch above goes dead
  // while every assertion in this file still passes — the reason it is checked
  // in the source and not only through the function.
  assert.match(proxy, /ctrl\.abort\(\s*new DOMException\([^)]*'TimeoutError'\s*\)/,
    'the 10 s poll timeout is a bare abort() again, indistinguishable from a cancel');
});

// ── Floors: the thing being described has to still be there ──────────────────

test('floor: every literal rejection this file throws has a rule or a true answer', () => {
  // Constructs, not a hand-written list. A new `throw new Error('some_token')`
  // that nobody classified shows up here rather than in front of a user.
  const tokens = [...proxy.matchAll(/(?:throw|reject\()\s*new Error\(\s*[`'"]([a-z_]+)/g)]
    .map((m) => m[1]);
  assert.ok(tokens.length >= 4, `only found ${tokens.length} thrown tokens — did the file change shape?`);
  const vague = [];
  for (const t of tokens) {
    const out = _proxyFailReason(new Error(t));
    if (/could not be converted for preview/.test(out)) vague.push(`${t} -> ${out}`);
  }
  assert.deepEqual(vague, [],
    `these rejections reach the user as the catch-all; give them a rule:\n  ${vague.join('\n  ')}`);
});

test('floor: every literal error the companion sets has a rule or a true answer', () => {
  // /progress/ hands back session["error"] verbatim, and proResProxy rejects
  // with it — so _update_session(error="…") is the other half of the corpus.
  const tokens = [...host.matchAll(/_update_session\([^)]*error="([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(tokens.length >= 2, `only found ${tokens.length} companion error tokens in ${HOST_PATH}`);
  const vague = tokens
    .map((t) => [t, _proxyFailReason(new Error(t))])
    .filter(([, out]) => /could not be converted for preview/.test(out))
    .map(([t, out]) => `${t} -> ${out}`);
  assert.deepEqual(vague, [], `unclassified companion errors:\n  ${vague.join('\n  ')}`);
});

test('floor: the consumers that render this sentence are still there', () => {
  // Seven modules pass an onProxyFail handler. If that drops toward zero, this
  // producer stopped mattering and the rules should be reconsidered rather than
  // maintained out of habit.
  const consumers = [
    'src/scripts/prep_mark.js',
    'src/scripts/core/playableMedia.js',
    'src/scripts/features/aceslook/index.js',
    'src/scripts/features/cutdiff/index.js',
    'src/scripts/features/cutdiff2/index.js',
    'src/scripts/features/platelink2/index.js',
    'src/scripts/modules/amf_convert.js',
  ].filter((f) => /onProxyFail\s*:\s*\(hint\)/.test(read(f)));
  assert.equal(consumers.length, 7, `only ${consumers.length} of 7 modules still render this sentence`);
});

// ── Shape: these land in a one-line strip somebody else styles ───────────────

test('every reason is one line and short enough for a status strip', () => {
  const ALL = [
    ...REJECTIONS.map(([r]) => r),
    'blorp', '', 'Failed to fetch', 'file_not_found', 'host_timeout',
  ];
  for (const raw of ALL) {
    const out = _proxyFailReason(new Error(raw));
    assert.ok(out, `empty reason for: ${JSON.stringify(raw)}`);
    assert.doesNotMatch(out, /\n/, `a newline would collapse in the caller's strip: ${JSON.stringify(out)}`);
    assert.ok(out.length < 120, `too long for a status line (${out.length}): ${out}`);
  }
});

test('an unrecognised failure says only what is certainly true', () => {
  // No rule and nothing friendlyError knows: the honest answer is that the
  // conversion did not happen, with no cause attached.
  for (const raw of ['blorp', '', null, undefined]) {
    assert.equal(_proxyFailReason(raw), 'this file could not be converted for preview');
  }
});

// ── Vacuity floor ────────────────────────────────────────────────────────────

test('floor: the corpus is not empty and the rules are not all one rule', () => {
  assert.ok(REJECTIONS.length >= 8, `corpus shrank to ${REJECTIONS.length}`);
  const distinct = new Set(REJECTIONS.map(([r]) => _proxyFailReason(new Error(r))));
  assert.ok(distinct.size >= 6,
    `only ${distinct.size} distinct answers for ${REJECTIONS.length} rejections — a catch-all would pass this file`);
});
