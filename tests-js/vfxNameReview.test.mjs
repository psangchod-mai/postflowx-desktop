import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  associatedVfxShotName,
  buildNetflixPlateName,
  buildTimelineVfxName,
  canonicalVfxName,
  duplicateVfxNameGroups,
  isValidNetflixVfxName,
  nextUniqueVfxName,
  normalizeVfxName,
  splitVfxPlateName,
} from '../src/scripts/core/vfxNameReview.js';

test('normalizes production-safe VFX names', () => {
  assert.equal(normalizeVfxName('  blr 101-060 comp.mov '), 'BLR_101_060_COMP');
  assert.equal(canonicalVfxName('blr_101_060'), 'BLR_101_060');
  assert.equal(normalizeVfxName('MMBLR_103_008'), 'BLR_103_008');
});

test('builds deterministic timeline names without a mutable counter', () => {
  const input = {
    event: { reel: 'A001L001_25030131' },
    index: 3,
    template: {
      show: 'BLR', episode: '2', sequence: 'TCC', showOn: true,
      episodeOn: true, sequenceOn: true, start: 10, step: 10, pad: 3,
    },
  };
  assert.equal(buildTimelineVfxName(input), 'BLR_002_TCC_040');
  assert.equal(buildTimelineVfxName(input), 'BLR_002_TCC_040');
});

test('uses the BLR show ID instead of turning a camera reel into a shot name', () => {
  const name = buildTimelineVfxName({
    event: { reel: 'A001L001_25030131' },
    index: 1,
    template: { project: 'test', start: 10, step: 10, pad: 3 },
  });
  assert.equal(name, 'BLR_020');
});

test('separates shot and plate names without duplicating PL01', () => {
  assert.equal(associatedVfxShotName('MMBLR_103_008_PL01_v001'), 'BLR_103_008');
  assert.equal(buildNetflixPlateName('MMBLR_103_008_PL01'), 'BLR_103_008_PL01_v001');
  assert.equal(buildNetflixPlateName('BLR_103_008_PL01_v002'), 'BLR_103_008_PL01_v002');
  assert.equal(buildNetflixPlateName('BLR_103_067_0010', 'PL02', '2'), 'BLR_103_067_0010_PL02_v002');
  assert.deepEqual(splitVfxPlateName('BLR_103_067_0010_PL01_v001.1023.exr'), {
    shotName: 'BLR_103_067_0010', plateId: 'PL01', version: 'v001', frame: '1023',
  });
});

test('validates BLR shot, plate, version, and EXR names', () => {
  assert.equal(isValidNetflixVfxName('BLR_103_008'), true);
  assert.equal(isValidNetflixVfxName('BLR_103_067_0010'), true);
  assert.equal(isValidNetflixVfxName('BLR_103_067_0010_PL01_v001'), true);
  assert.equal(isValidNetflixVfxName('BLR_103_067_0010_PL01_v001.1023.exr'), true);
  assert.equal(isValidNetflixVfxName('BLR_103_067_0010_comp_NFX_v001'), true);
  assert.equal(isValidNetflixVfxName('BLR_103_067_0010_PL01'), false);
  assert.equal(isValidNetflixVfxName('MMBLR_103_008_PL01_v001'), false);
});

test('increments the final shot number when a name is already occupied', () => {
  assert.equal(
    nextUniqueVfxName('BLR_002_TCC_060', ['blr_002_tcc_060'], { step: 10, pad: 3 }),
    'BLR_002_TCC_070',
  );
});

test('increments plate numbers without changing the shot base', () => {
  assert.equal(
    nextUniqueVfxName('BLR_002_TCC_060_PL01', ['BLR_002_TCC_060_PL01'], { step: 10, pad: 3 }),
    'BLR_002_TCC_060_PL02',
  );
});

test('reports duplicate groups case-insensitively', () => {
  const groups = duplicateVfxNameGroups([
    { name: 'BLR_002_060' },
    { name: 'blr-002-060' },
    { name: 'BLR_002_070' },
  ]);
  assert.equal(groups.size, 1);
  assert.equal(groups.get('BLR_002_060').length, 2);
});

test('Pull Prep routes automatic names through user review and duplicate repair', async () => {
  const source = await readFile(new URL('../src/scripts/prep_mark.js', import.meta.url), 'utf8');
  assert.match(source, /Review suggested name/);
  assert.match(source, /Resolve duplicate shot name/);
  assert.match(source, /source: 'ai'/);
  assert.match(source, /source: 'template'/);
  assert.match(source, /_pmNameReviewedBy = reviewedBy/);
  assert.match(source, /_pmShotLocked = true/);
  assert.match(source, /Mark VFX shot — suggest one unique name for review/);
  assert.doesNotMatch(source, /class="pm-shot-ai-btn"/);
});
