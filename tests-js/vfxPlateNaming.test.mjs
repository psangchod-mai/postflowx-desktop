import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildNamingContext,
  buildPlateName,
  deriveShotName,
} from '../src/scripts/smart/smartExrNamingEngine.js';

test('VFX Pull migrates MMBLR and strips an existing plate suffix from the shot', () => {
  assert.equal(deriveShotName({ _pmShot: 'MMBLR_103_008_PL01_v001' }), 'BLR_103_008');
  assert.equal(buildPlateName('MMBLR_103_008_PL01', 'PL01', '001'), 'BLR_103_008_PL01_v001');
});

test('VFX Pull produces one plate/version suffix and Netflix-safe duplicate plates', () => {
  const usedNames = new Set();
  const first = buildNamingContext({
    event: { _pmShot: 'BLR_103_067_0010_PL01_v001' },
    plateId: 'PL01', version: '001', usedNames,
  });
  const second = buildNamingContext({
    event: { _pmShot: 'BLR_103_067_0010_PL01_v001' },
    plateId: 'PL01', version: '001', usedNames,
  });
  assert.equal(first.shotName, 'BLR_103_067_0010');
  assert.equal(first.plateName, 'BLR_103_067_0010_PL01_v001');
  assert.equal(second.plateName, 'BLR_103_067_0010_PL02_v001');
  assert.doesNotMatch(second.plateName, /PL\d+_PL\d+/);
});

test('camera reel fallback uses BLR rather than the source reel', () => {
  assert.equal(
    deriveShotName({ reel: 'A001L001_25030131', eventNumber: 7 }),
    'BLR_101_007',
  );
});

test('Pull Prep hands separate shot and plate names to ShotWorkItem', async () => {
  const source = await readFile(new URL('../src/scripts/core/shotWorkItems.js', import.meta.url), 'utf8');
  assert.match(source, /shotName:\s+names\.shotName/);
  assert.match(source, /plateName:\s+names\.plateName/);
  assert.doesNotMatch(source, /plateName:\s+marker\.shotName/);
});
