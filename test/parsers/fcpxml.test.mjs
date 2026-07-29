// FCPXML parser — contract + golden. Run: node --test test/parsers/fcpxml.test.mjs
import '../_setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFCPXML } from '../../src/scripts/parsers/fcpxml.js';
import { assertParseResult, readFixture } from '../_contract.mjs';

test('fcpx_basic.fcpxml — 2 clips, 25fps', () => {
  const res = parseFCPXML(readFixture('fcpx_basic.fcpxml'));
  const evs = assertParseResult(res, { sourceType: 'fcpxml' });

  assert.equal(evs.length, 2, 'exactly 2 events');
  assert.equal(res.fps, 25, 'frameDuration 1/25s → 25 fps');
  assert.equal(res.projectName, 'FCPX BASIC');
  assert.equal(evs[0].clipName, 'shot_010', 'asset-clip name → clipName');
  assert.equal(evs[0].reel, 'A001C001', 'asset name → reel');
  assert.equal(evs[0].srcFile, 'A001C001.mov', 'media-rep src → srcFile');
  assert.equal(evs[0].srcIn, '01:00:00:00');
  assert.equal(evs[0].srcOut, '01:00:04:00');
  assert.equal(evs[0].recIn, '01:00:00:00', 'sequence tcStart offsets record TC');
  assert.equal(evs[1].srcIn, '00:33:20:00', 'asset start 50000/25s = 33:20');
  assert.equal(evs[1].recIn, '01:00:04:00', 'second clip record position');
});

test('mixed_rate.fcpxml — 24 + 30 clips resolve to correct seconds', () => {
  const res = parseFCPXML(readFixture('mixed_rate.fcpxml'));
  const evs = assertParseResult(res, { sourceType: 'fcpxml' });

  assert.equal(evs.length, 2);
  assert.equal(res.fps, 24, 'sequence format rate (clips normalized to it)');
  assert.equal(evs[0].srcIn, '01:00:00:00', '24fps clip');
  // 30fps asset start 54000/30 = 1800s = 00:30:00 — correct regardless of nominal rate
  assert.equal(evs[1].srcIn, '00:30:00:00', '30fps source time resolved to correct seconds');
  assert.equal(evs[1].recIn, '01:00:04:00', 'placed after the 24fps clip (96f = 4s)');
});

// ── NTSC / fractional rates ─────────────────────────────────────────────────
// Both fixtures above are integer-rate (25 and 24), where the whole-frame
// timecode base and the true playback rate are the same number — so neither
// could see that this parser converted rational REAL seconds to frames using
// the ROUNDED rate. An FCPXML time value denotes the frame value/frameDuration,
// so multiplying seconds by 24 instead of 23.976 put every event late by an
// amount that grows with position: 86 frames (3.6s) at the 1-hour mark, 172 at
// two hours. 23.976 is the most common rate in film and episodic post.

test('fcpx_ntsc.fcpxml — 23.976 events land on exact timecode, not 3.6s late', () => {
  const res = parseFCPXML(readFixture('fcpx_ntsc.fcpxml'));
  const evs = assertParseResult(res, { sourceType: 'fcpxml' });

  assert.equal(evs.length, 2);
  assert.equal(res.fps, 24, 'frameDuration 1001/24000s reports the nominal base 24');
  assert.equal(res._seqBaseFrames, 86400, 'tcStart 86486400/24000s = frame 86400 (was 86486)');
  assert.equal(evs[0].recIn, '01:00:00:00', 'first clip at the hour (was 01:00:03:14)');
  assert.equal(evs[0].recOut, '01:00:04:00');
  assert.equal(evs[1].recIn, '01:00:04:00', 'second clip (was 01:00:07:14)');
  assert.equal(evs[0].srcIn, '01:00:00:00', 'source TC too (was 01:00:03:14)');
});

test('rational times resolve exactly at every broadcast rate', () => {
  // frameDuration num/den, and frame f as an exact rational in that timebase.
  const build = (num, den) => {
    const at = f => `${f * num}/${den}s`;
    const base = Math.round(den / num);
    const hour = 3600 * base, four = 4 * base;
    return { base, xml: `<?xml version="1.0"?><fcpxml version="1.9"><resources>
      <format id="r1" frameDuration="${num}/${den}s"/>
      <asset id="a1" name="A001" format="r1" start="${at(hour)}" duration="${at(hour)}">
        <media-rep src="file:///a.mov"/></asset></resources>
      <library><event><project name="P">
      <sequence format="r1" tcStart="${at(hour)}" duration="${at(four * 2)}"><spine>
        <asset-clip name="c1" ref="a1" offset="${at(hour)}" start="${at(hour)}" duration="${at(four)}"/>
        <asset-clip name="c2" ref="a1" offset="${at(hour + four)}" start="${at(hour + four)}" duration="${at(four)}"/>
      </spine></sequence></project></event></library></fcpxml>` };
  };

  for (const [num, den, label] of [[1, 24, '24'], [1001, 24000, '23.976'], [1, 25, '25'],
                                   [1001, 30000, '29.97'], [1, 30, '30'], [1001, 60000, '59.94']]) {
    const { base, xml } = build(num, den);
    const res = parseFCPXML(xml);
    const evs = res.events || [];
    assert.equal(res.fps, base, `@${label} reports nominal base ${base}`);
    assert.ok(Number.isInteger(res.fps), `@${label} the reported rate stays a whole number`);
    assert.equal(res._seqBaseFrames, 3600 * base, `@${label} tcStart → frame ${3600 * base}`);
    assert.equal(evs[0]?.recIn, '01:00:00:00', `@${label} first clip on the hour`);
    assert.equal(evs[1]?.recIn, '01:00:04:00', `@${label} second clip 4s later`);
    assert.equal(evs[1]?.recOut, '01:00:08:00', `@${label} and 4s long`);
    for (const ev of evs) {
      for (const k of ['recIn', 'recOut', 'srcIn', 'srcOut']) {
        assert.match(String(ev[k]), /^\d{2}:\d{2}:\d{2}:\d{2}$/, `@${label} ${k} well-formed`);
      }
    }
  }
});

test('drift does not accumulate two hours down a 23.976 reel', () => {
  const at = f => `${f * 1001}/24000s`;
  const deep = 3 * 3600 * 24;   // 03:00:00:00 at base 24
  const res = parseFCPXML(`<?xml version="1.0"?><fcpxml version="1.9"><resources>
    <format id="r1" frameDuration="1001/24000s"/>
    <asset id="a1" name="A001" format="r1" start="0s" duration="${at(deep * 2)}">
      <media-rep src="file:///a.mov"/></asset></resources>
    <library><event><project name="P">
    <sequence format="r1" tcStart="${at(3600 * 24)}" duration="${at(deep)}"><spine>
      <asset-clip name="deep" ref="a1" offset="${at(deep)}" start="${at(deep)}" duration="${at(96)}"/>
    </spine></sequence></project></event></library></fcpxml>`);
  assert.equal(res.events[0]?.recIn, '03:00:00:00', 'two hours in, still exact (was 02:59:52:20)');
});

test('a bare-seconds time value is read as real seconds, not as timecode', () => {
  // Deliberate behaviour change. tcStart="3600s" is 3600 REAL seconds, which on
  // a 23.976 timeline is frame 86314 — timecode 00:59:56:10, not 01:00:00:00.
  // This parser used to answer 01:00:00:00 because it multiplied by 24. No
  // conforming NTSC exporter writes this form (a whole second is not a frame
  // boundary at 24000/1001, and FCP X and Resolve both emit the rational), so
  // this changes no real file — but it is the spec answer, so it is asserted
  // rather than left to be rediscovered as a regression.
  const res = parseFCPXML(`<?xml version="1.0"?><fcpxml version="1.9"><resources>
    <format id="r1" frameDuration="1001/24000s"/>
    <asset id="a1" name="A001" format="r1" start="0s" duration="7200s">
      <media-rep src="file:///a.mov"/></asset></resources>
    <library><event><project name="P">
    <sequence format="r1" tcStart="3600s" duration="8s"><spine>
      <asset-clip name="lit" ref="a1" offset="3600s" start="3600s" duration="4.004s"/>
    </spine></sequence></project></event></library></fcpxml>`);
  assert.equal(res.events[0]?.recIn, '00:59:56:10');
  assert.equal(res.events[0]?.recOut, '01:00:00:10', 'and the 4.004s duration is still exactly 96 frames');
});

// ── ref-clip markers ─────────────────────────────────────────────────────────
// A <ref-clip> (a compound-clip/multicam instance dropped on the timeline)
// resolves its <media>/<sequence> and recurses into it, then returns before
// ever reaching this parser's own marker-collection step — so a marker placed
// directly on the ref-clip node itself (as opposed to inside the referenced
// sequence) used to be silently dropped. It should now surface on the first
// row the ref-clip's recursion produces.
test('a marker on a <ref-clip> node itself is not dropped', () => {
  const res = parseFCPXML(`<?xml version="1.0"?><fcpxml version="1.9"><resources>
    <format id="r1" frameDuration="1/24s"/>
    <asset id="a1" name="A001" format="r1" start="0s" duration="10s">
      <media-rep src="file:///a.mov"/></asset>
    <media id="m1" name="Compound">
      <sequence format="r1" tcStart="0s" duration="4s"><spine>
        <asset-clip name="inner" ref="a1" offset="0s" start="0s" duration="4s"/>
      </spine></sequence>
    </media>
    </resources>
    <library><event><project name="P">
    <sequence format="r1" tcStart="3600s" duration="4s"><spine>
      <ref-clip name="Compound Clip" ref="m1" offset="3600s" duration="4s">
        <marker start="2s" value="REVIEW"/>
      </ref-clip>
    </spine></sequence></project></event></library></fcpxml>`);
  const evs = assertParseResult(res, { sourceType: 'fcpxml' });

  assert.equal(evs.length, 1, 'the ref-clip itself produces no row — only the resolved sequence content does');
  assert.equal(evs[0].clipName, 'inner');
  assert.ok(evs[0].markers?.some(m => m.name === 'REVIEW'),
    'marker dropped directly on the ref-clip node is attached to the first row from its resolved sequence');
});

// ── fallback-scan source-in trim ─────────────────────────────────────────────
// When the sequence's <spine> sits two levels below <sequence> (some large
// FCPXML exports nest it inside extra wrapper elements), the recursive
// collector finds nothing: it only special-cases a `<spine>` that is a
// DIRECT child of the node it is currently visiting (`:scope > spine`), and
// its final catch-all recursion only descends into children that are
// themselves asset-clip/clip/mc-clip/sync-clip/ref-clip/gap/title — an
// unrecognized wrapper tag is none of those, so a spine nested two levels
// down is never reached. parseFCPXML then falls back to a flat
// querySelectorAll scan of the whole subtree. That fallback scanner used to
// hardcode srcIn to frame 0 instead of reading the clip's own `start`
// attribute, silently discarding the real source-in trim point.
test('flat-sequence-scan fallback reads the real source-in trim, not frame 0', () => {
  const res = parseFCPXML(`<?xml version="1.0"?><fcpxml version="1.9"><resources>
    <format id="r1" frameDuration="1/24s"/>
    <asset id="a1" name="A001" format="r1" start="0s" duration="3600s">
      <media-rep src="file:///A001.mov"/></asset></resources>
    <library><event><project name="P">
    <sequence format="r1" tcStart="0s" duration="5/24s">
      <outer><inner><spine>
        <asset-clip name="c1" ref="a1" offset="0s" start="480/24s" duration="120/24s"/>
      </spine></inner></outer>
    </sequence></project></event></library></fcpxml>`);

  assert.equal(res._fallback, 'flat-sequence-scan', 'spine nested in a wrapper defeats the recursive collector');
  const evs = assertParseResult(res, { sourceType: 'fcpxml' });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].srcIn, '00:00:20:00', 'start=480/24s (20s in) must not be flattened to frame 0');
  assert.equal(evs[0].srcOut, '00:00:25:00', 'srcOut = srcIn + duration (5s)');
});

// ── animated-transform keyframe times ────────────────────────────────────────
// <adjust-transform><param><keyframe time="..."/> times are FCPXML rational
// values, same as offset/duration/start elsewhere in the file — a keyframe at
// a non-integer-second position is written as "N/Ds" (e.g. "12345/24000s").
// The keyframe reader used plain parseFloat on the raw string, which stops at
// the first non-numeric character: parseFloat("12345/24000s") is 12345, not
// 12345/24000 = 0.514375. Every fractional-second keyframe time was silently
// corrupted by a factor of ~24000.
test('animated transform keyframe times parse rational seconds, not the bare numerator', () => {
  const res = parseFCPXML(`<?xml version="1.0"?><fcpxml version="1.9"><resources>
    <format id="r1" frameDuration="1/24s"/>
    <asset id="a1" name="A001" format="r1" start="0s" duration="10s">
      <media-rep src="file:///a.mov"/></asset></resources>
    <library><event><project name="P">
    <sequence format="r1" tcStart="0s" duration="4s"><spine>
      <asset-clip name="c1" ref="a1" offset="0s" start="0s" duration="4s">
        <adjust-transform>
          <param key="position">
            <keyframe time="12345/24000s" value="0 0"/>
            <keyframe time="24690/24000s" value="10 10"/>
          </param>
        </adjust-transform>
      </asset-clip>
    </spine></sequence></project></event></library></fcpxml>`);
  const evs = assertParseResult(res, { sourceType: 'fcpxml' });

  const keys = evs[0].transform?.keys?.position;
  assert.ok(Array.isArray(keys) && keys.length === 2, 'both keyframes captured');
  assert.equal(keys[0].time, 12345 / 24000, 'time="12345/24000s" is 0.514375s, not the bare numerator 12345');
  assert.equal(keys[1].time, 24690 / 24000, 'second keyframe likewise resolved as a true fraction');
});
