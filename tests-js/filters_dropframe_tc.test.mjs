// filters.js's local tcToFrames must accept drop-frame "HH:MM:SS;FF"
// timecodes, not just NDF "HH:MM:SS:FF" — edl.js preserves the ';' separator
// for DF sources, and filters.js's own tcToFrames regex only matched ':',
// so every DF timecode failed to match, returned 0, and filterValidTimecode
// then discarded every event as zero-length ("0 <= 0"). Run:
// node tests-js/filters_dropframe_tc.test.mjs
import { filterValidTimecode } from '../src/scripts/modules/filters.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

// A valid, non-zero-length DF-timecoded event must survive the filter.
{
  const events = [{
    srcIn: '01:00:00;00', srcOut: '01:00:10;00',
    recIn: '01:00:00;00', recOut: '01:00:10;00',
  }];
  const out = filterValidTimecode(events, 30);
  ok(out.length === 1, 'valid DF-timecoded event is kept, not dropped');
}

// The equivalent NDF event must also survive (parity, not a regression).
{
  const events = [{
    srcIn: '01:00:00:00', srcOut: '01:00:10:00',
    recIn: '01:00:00:00', recOut: '01:00:10:00',
  }];
  const out = filterValidTimecode(events, 30);
  ok(out.length === 1, 'equivalent NDF-timecoded event is still kept');
}

// A genuinely zero-length event (DF separator) must still be dropped.
{
  const events = [{
    srcIn: '01:00:00;00', srcOut: '01:00:00;00',
    recIn: '01:00:00;00', recOut: '01:00:00;00',
  }];
  const out = filterValidTimecode(events, 30);
  ok(out.length === 0, 'zero-length DF event is still correctly dropped');
}

// Malformed timecodes must still be safely rejected, not crash.
{
  const events = [{ srcIn: 'garbage', srcOut: 'garbage', recIn: 'garbage', recOut: 'garbage' }];
  const out = filterValidTimecode(events, 30);
  ok(out.length === 0, 'malformed timecode is safely dropped, not kept or crashed on');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
