// ALE (Avid Log Exchange) import — timecode acceptance and the rows it decides
// to keep.
// Run: node tests-js/aleParser.test.mjs
//
// src/scripts/parsers/ale.js was live, reachable from two places in ui.js, and
// had no tests at all. Its parseTC accepted only ':' separators, so an NTSC
// drop-frame ALE — "01;00;00;00", or Avid's more common "01:00:00;00" — failed
// on every one of a row's four timecode fields at once. buildEventFromRow's
// "no usable timecode" guard then returned null and the row was gone. A 29.97
// DF ALE imported as an empty timeline with no error at either call site:
// ui.js's import loop reads an empty parse as "not this file" and moves on, and
// the match-back modal `continue`s past it without an entry in _mbFileMeta.
//
// parseTC is private, so everything here goes through parseALE — which is also
// the only way to observe the event-drop, the part that actually hurt.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseALE } from '../src/scripts/parsers/ale.js';
import { tcToFrames } from '../src/scripts/modules/utils_time.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

// Standard Avid ALE: tab-delimited, Heading / Column / Data sections.
function makeALE({ fps = '29.97', cols = null, rows = [] } = {}) {
  const columns = cols || ['Name', 'Tape', 'Start', 'End', 'Source File'];
  return [
    'Heading',
    'FIELD_DELIM\tTABS',
    'VIDEO_FORMAT\t1080',
    `FPS\t${fps}`,
    '',
    'Column',
    columns.join('\t'),
    '',
    'Data',
    ...rows.map(r => r.join('\t')),
  ].join('\n');
}

const row = (start, end = null) =>
  ['A001_C001', 'A001', start, end ?? start, 'A001C001_240101_R1AB.mxf'];

const one = (start, end = null) => parseALE(makeALE({ rows: [row(start, end)] }), 'day005.ale');

// ── non-drop still works exactly as before ──
{
  const r = one('01:00:00:00', '01:00:10:00');
  eq(r.events.length, 1, 'a non-drop row produces one event');
  eq(r.events[0].srcIn, '01:00:00:00', 'and its source in is unchanged');
  eq(r.events[0].srcOut, '01:00:10:00', 'as is its source out');
  // The heading rate is still read verbatim — it is now reported as `fpsExact`,
  // with `fps` carrying the whole-frame timecode base beside it. This assertion
  // used to read `r.fps === 29.97`, which is what made every consumer downstream
  // guess which of the two rates it had been handed.
  eq(r.fpsExact, 29.97, 'the heading rate is read as written');
  eq(r.fps, 30, 'and the whole-frame timecode base is derived from it');
  eq(r.events[0].reel, 'A001', 'Tape wins over the filename stem for the reel');
  eq(r.events[0].isOCF, true, 'and an .mxf source is camera original');
}

// ── the defect: drop-frame rows were dropped, not mis-parsed ──
// Worth being precise about the failure mode. The timecode did not come back
// wrong; the *event* did not come back. That is why nothing downstream noticed.
for (const [tc, why] of [
  ['01;00;00;00', 'fully semicolon-separated drop-frame'],
  ['01:00:00;00', 'the mixed form Avid writes most often'],
  ['01;00;00:00', 'a semicolon anywhere else'],
]) {
  const r = one(tc);
  eq(r.events.length, 1, `${why} survives the import`);
  eq(r.events[0]?.srcIn, '01:00:00:00', `${why} normalises to colons`);
}

// A whole drop-frame reel, not just one row — this is the shape of a real
// import, and previously every row of it disappeared together.
{
  const r = parseALE(makeALE({
    rows: [
      ['A001_C001', 'A001', '01;00;00;00', '01;00;04;12', 'A001C001_240101_R1AB.mxf'],
      ['A001_C002', 'A001', '01;00;04;12', '01;00;09;00', 'A001C002_240101_R1AB.mxf'],
      ['A001_C003', 'A001', '01;00;09;00', '01;00;13;22', 'A001C003_240101_R1AB.mxf'],
    ],
  }), 'day005.ale');
  eq(r.events.length, 3, 'a three-clip drop-frame reel imports all three clips');
  eq(r.events[2].srcOut, '01:00:13:22', 'and the last clip keeps its out point');
}

// ── drop-frame is normalised to NDF, deliberately and consistently ──
// This is lossy against wall-clock: 01;00;00;00 and 01:00:00:00 are different
// instants on a 29.97 timeline. It is still the right call here, because it is
// the single convention the rest of the codebase already runs on — utils_time's
// tcToFrames says "DF treated as NDF" in its own signature comment, xml.js
// strips ';' before calling it, edl.js matches /[:;]/ and reads the frame field
// straight. ale.js was the one parser that disagreed, and it disagreed by
// discarding data rather than by counting it differently. A ninth reading of
// drop-frame invented inside one importer would be a worse outcome than a
// known-lossy one shared by all of them.
{
  const r = one('01;00;00;00');
  eq(tcToFrames(r.events[0].srcIn, 29.97), tcToFrames('01;00;00;00', 29.97),
     'the ALE-normalised timecode and the raw drop-frame string agree in frames');
}

// ── DaVinci Resolve 21 subframe suffix ──
{
  const r = one('01:00:00:12.5');
  eq(r.events.length, 1, 'a Resolve subframe suffix no longer costs the event');
  eq(r.events[0]?.srcIn, '01:00:00:12', 'the subframe is stripped, the frame kept');
}

// ── the five-digit frame field this file claims to accept ──
// The header comment has always advertised HH:MM:SS:FFFFF. `ffInt % 100` then
// rewrote 00120 as 20: a timecode that is wrong, plausible, and silent. Passing
// the digits through is not a guess about what a five-digit field means — it is
// the absence of one.
{
  const r = one('00:00:00:00120');
  eq(r.events[0]?.srcIn, '00:00:00:120', 'a five-digit frame field keeps its value');
  ok(r.events[0]?.srcIn !== '00:00:00:20', 'and is not truncated to its last two digits');
}
eq(one('00:00:00:07').events[0]?.srcIn, '00:00:00:07', 'ordinary two-digit frames still pad to two');

// ── what must still be rejected ──
// Widening the separator class must not widen what counts as a timecode.
{
  const junk = parseALE(makeALE({
    rows: [['A001_C001', 'A001', 'n/a', '', 'A001C001_240101_R1AB.mxf']],
  }), 'day005.ale');
  eq(junk.events.length, 0, 'a row with no readable timecode is still dropped');
}
for (const bad of ['01:00:00', '01:00:00:00:00', '', 'TC', '01-00-00-00']) {
  eq(one(bad).events.length, 0, `"${bad}" is not a timecode and yields no event`);
}

// ── existing behaviour around the fields that do parse ──
{
  // Record-only row: recIn mirrors into srcIn. Unrelated to this change, but it
  // is the branch immediately above the guard that was deleting rows, and it
  // had no test either.
  const r = parseALE(makeALE({
    cols: ['Name', 'Tape', 'Record In', 'Record Out', 'Source File'],
    rows: [['A001_C001', 'A001', '10;00;00;00', '10;00;05;00', 'A001C001.mxf']],
  }), 'day005.ale');
  eq(r.events.length, 1, 'a record-only drop-frame row imports');
  eq(r.events[0].recIn, '10:00:00:00', 'record in is normalised');
  eq(r.events[0].srcIn, '10:00:00:00', 'and mirrored into source in when source is absent');
}
{
  const empty = parseALE('', 'day005.ale');
  eq(empty.events.length, 0, 'empty text yields no events');
  eq(empty.fps, 24, 'and the documented 24 fps default');
}
{
  // A different route to the same default, and the reason DEFAULT_FPS exists.
  // The assertion above returns before detectFPSFromHeading is ever called, so
  // it pinned one of the file's two hardcoded 24s and left the other free to
  // move — a mutation sweep changed that one and the suite stayed green. The
  // constant makes them one fact; this asserts the path the other one owned.
  const noFps = parseALE([
    'Heading', 'VIDEO_FORMAT\t1080', '',
    'Column', 'Name\tTape\tStart\tEnd', '',
    'Data', 'A001_C001\tA001\t01:00:00:00\t01:00:05:00',
  ].join('\n'), 'day005.ale');
  eq(noFps.events.length, 1, 'a heading with no FPS line still imports its rows');
  eq(noFps.fps, 24, 'and falls back to 24 fps through detectFPSFromHeading');
}
{
  // A fractional heading rate is the case the two-rate contract exists for: the
  // rate is kept exactly (fpsExact) AND a whole base is derived for the timecode
  // arithmetic (fps), instead of one number being asked to serve both.
  const frac = parseALE(makeALE({ fps: '23.976', rows: [row('01:00:00:00')] }));
  eq(frac.fpsExact, 23.976, 'a fractional heading FPS is read as written');
  eq(frac.fps, 24, 'and rounds to a whole timecode base');
  eq(frac.events[0].fps, 24, 'events are stamped with the base, not the fractional rate');
}

// ── the divergence is gone from the source ──
// Guards run against code with comments stripped. The first draft of the
// modulo guard below matched raw source text and duly failed on the comment in
// ale.js that names `% 100` while explaining its removal — describing a defect
// is not committing it, and a guard that cannot tell the two apart is the same
// class of mistake as the one it is checking for.
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
{
  const a = codeOnly(read('src/scripts/parsers/ale.js'));
  ok(/\[:;\]/.test(a), 'ale.js accepts both timecode separators');
  ok(!/%\s*100/.test(a), 'no code path takes the frame field modulo 100');
  ok(/\(\?:\\\.\\d\+\)\?/.test(a), 'and the subframe suffix is stripped in the pattern itself');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
