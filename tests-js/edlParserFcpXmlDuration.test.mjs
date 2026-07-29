// Regression test: parseFcpXml's durationFrames must come from the RECORD span
// (<start>/<end>), not the SOURCE span (<in>/<out>). This matches the file's own
// documented policy (edlParser.js: "Timeline duration comes from the RECORD TCs —
// authoritative, not the source TCs") and its sibling parseEdl(), which already
// derives duration from record timecodes. A retimed clip has a different source
// span than its record span, so using the wrong one silently corrupts conform
// timing for any FCPXML with retimes.
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
if (!globalThis.DOMParser) globalThis.DOMParser = DOMParser;
import { parseFcpXml } from '../src/scripts/modules/conform/edlParser.js';

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

const events = parseFcpXml(FCPXML_RETIMED);
assert.equal(events.length, 1, 'FCPXML retimed clip parsed as 1 event');
assert.equal(
  events[0].durationFrames,
  96,
  'FCPXML durationFrames from record span (end-start=96), not source span (out-in=48)',
);

console.log('edlParser FCPXML duration tests passed');
