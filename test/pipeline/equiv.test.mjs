// Cross-format equivalence: EDL and OTIO describing the SAME 3-cut sequence must
// produce interchangeable event lists — the proof that parsers are uniform feeds
// into Pull Prep. Run: node --test test/pipeline/equiv.test.mjs
import '../_setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEDL } from '../../src/scripts/parsers/edl.js';
import { parseOTIO } from '../../src/scripts/parsers/otio.js';
import { validatePullList } from '../../src/scripts/modules/pullValidator.js';
import { readFixture, normalizeEvent } from '../_contract.mjs';

const KEYS = ['reel', 'srcIn', 'srcOut', 'recIn', 'recOut'];
const pick = (ev) => { const n = normalizeEvent(ev); const o = {}; for (const k of KEYS) o[k] = n[k]; return o; };

test('EDL ↔ OTIO — same sequence yields agreeing events', () => {
  const edl  = parseEDL(readFixture('equiv.edl'), 'equiv.edl').events.map(pick);
  const otio = parseOTIO(readFixture('equiv.otio')).events.map(pick);

  assert.equal(edl.length, 3, 'EDL: 3 events');
  assert.equal(otio.length, 3, 'OTIO: 3 events');
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(otio[i], edl[i], `event[${i}] reel/srcIn/srcOut/recIn/recOut agree across formats`);
  }
  // both must pass validation cleanly
  assert.equal(validatePullList(parseEDL(readFixture('equiv.edl'), 'equiv.edl').events).ok, true, 'EDL validates');
  assert.equal(validatePullList(parseOTIO(readFixture('equiv.otio')).events).ok, true, 'OTIO validates');
});
