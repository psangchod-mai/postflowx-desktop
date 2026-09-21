// Regression tests for edlParser.js conform fixes (V1.4 audit):
//   - drop-frame timecode math (parse + emit)
//   - CMX 3600 event regex keeps dissolves/wipes (not just cuts)
//   - audio-only tracks are dropped; record-TCs drive duration
//   - clip-name comment tolerates missing "FROM"
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DOMParser } from 'linkedom';
if (!globalThis.DOMParser) globalThis.DOMParser = DOMParser;
import { tcToFrames, framesToTc, parseEdl, parseFcpXml, fpsIsDrop, eventsToEdl }
  from '../src/scripts/modules/conform/edlParser.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
void root;

// ── Drop-frame timecode (values cross-checked against conform_lib.py) ──
assert.equal(tcToFrames('01:00:00;00', 29.97), 107892, 'DF 1h → frames');
assert.equal(framesToTc(107892, 29.97), '01:00:00;00', 'DF frames → TC (round-trip)');
assert.equal(tcToFrames('01:00:00:00', 24), 86400, 'NDF 1h → frames');
assert.equal(framesToTc(86400, 24), '01:00:00:00', 'NDF round-trip');
assert.equal(fpsIsDrop(29.97), true);
assert.equal(fpsIsDrop(59.94), true);
assert.equal(fpsIsDrop(24), false);

// ── CMX 3600: dissolves kept, audio dropped, record-TC duration ──
const edl = [
  'TITLE: TEST', 'FCM: NON-DROP FRAME', '',
  '001  AX       V     C        00:00:00:00 00:00:05:18 01:00:00:00 01:00:05:18',
  '* FROM CLIP NAME: shot_01.mov',
  '002  AX       V     D  030   00:00:10:00 00:00:12:11 01:00:05:18 01:00:07:29',
  '* CLIP NAME: shot_02.mov',
  '003  AX       A1    C        00:00:00:00 00:00:02:00 01:00:07:29 01:00:09:29',
].join('\n');
const evs = parseEdl(edl, 24);
assert.equal(evs.length, 2, 'dissolve kept, audio-only dropped');
assert.equal(evs[1].index, 2, 'dissolve parsed as its own event');
assert.equal(evs[1].clipName, 'shot_02.mov', 'clip name without FROM is read');
assert.equal(evs[0].track, 'V', 'track field captured');
assert.equal(
  evs[0].durationFrames,
  tcToFrames('01:00:05:18', 24) - tcToFrames('01:00:00:00', 24),
  'duration derived from record TCs',
);

// ── FCPXML: durationFrames must come from record (start/end), not source ──
// Comment at edlParser.js:99-100 states timeline duration is authoritative
// from RECORD TCs, not source TCs, since source is re-resolved by matching.
// parseEdl (above) honors this; parseFcpXml must too — a retimed clip has a
// different source span than its record span.
const FCPXML_RETIMED = `<?xml version="1.0"?>
<xmeml>
  <sequence>
    <track>
      <clipitem>
        <name>shot_01</name>
        <rate><timebase>24</timebase></rate>
        <file><name>shot_01.mov</name></file>
        <in>100</in>
        <out>148</out>
        <start>500</start>
        <end>596</end>
      </clipitem>
    </track>
  </sequence>
</xmeml>`;
const fcpEvents = parseFcpXml(FCPXML_RETIMED);
assert.equal(fcpEvents.length, 1, 'FCPXML retimed clip parsed as 1 event');
assert.equal(
  fcpEvents[0].durationFrames,
  96,
  'FCPXML durationFrames from record span (end-start=96), not source span (out-in=48)',
);

// ── Export FCM reflects drop-frame ──
assert.match(eventsToEdl([], 29.97), /FCM: DROP FRAME/);
assert.match(eventsToEdl([], 24), /FCM: NON-DROP FRAME/);

console.log('edlParser conform tests passed');
