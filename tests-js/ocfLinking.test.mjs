// OCF-linking intelligence tests — overlap conflict + reel-alias.
// Exercises the REAL matchAllEvents. Run: node tests-js/ocfLinking.test.mjs
import { matchAllEvents, suggestReelAliases } from '../src/scripts/smart/smartOcfMatcher.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
const warnsOf = (r) => (r.match.warnings || []).join(' | ');

const A001 = { reel: 'A001', name: 'A001.mxf', path: '/cam/A001.mxf', tcIn: '01:00:00:00', tcOut: '01:00:30:00', tcKnown: true, fps: 24 };

// ── Overlapping pulls from the same camera file → flagged ──
{
  const events = [
    { reel: 'A001', srcIn: '01:00:00:00', srcOut: '01:00:10:00', fps: 24 },
    { reel: 'A001', srcIn: '01:00:08:00', srcOut: '01:00:18:00', fps: 24 }, // overlaps the first
  ];
  const res = matchAllEvents(events, [A001], { deduplicate: true });
  ok(res.every(r => r.match._overlapConflict), 'overlapping same-reel pulls both flagged _overlapConflict');
  ok(res.some(r => /overlapping pull/i.test(warnsOf(r))), 'overlap warning present');
}

// ── Multi-take at DIFFERENT (non-overlapping) ranges → NOT flagged ──
{
  const events = [
    { reel: 'A001', srcIn: '01:00:00:00', srcOut: '01:00:05:00', fps: 24 },
    { reel: 'A001', srcIn: '01:00:10:00', srcOut: '01:00:15:00', fps: 24 }, // separate take
  ];
  const res = matchAllEvents(events, [A001], { deduplicate: true });
  ok(res.every(r => !r.match._overlapConflict), 'non-overlapping multi-takes are NOT flagged (normal)');
}

// ── Reel alias: editorial "REEL_A" links to camera "A001" ──
{
  const events = [{ reel: 'REEL_A', srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 24 }];
  const noAlias = matchAllEvents(events, [A001], { deduplicate: false });
  const withAlias = matchAllEvents(events, [A001], { deduplicate: false, reelAliases: { REEL_A: 'A001' } });
  ok((noAlias[0].match.confidence || 0) < (withAlias[0].match.confidence || 0),
    'alias improves confidence vs no alias');
  ok((withAlias[0].match.reasons || []).some(x => /reel alias/i.test(x)),
    'alias is recorded in match reasons');
  ok(withAlias[0].match.matchedPath === '/cam/A001.mxf', 'aliased event links to the camera original');
}

// ── Alias accepts a Map too ──
{
  const events = [{ reel: 'REEL_A', srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 24 }];
  const r = matchAllEvents(events, [A001], { deduplicate: false, reelAliases: new Map([['REEL_A', 'A001']]) });
  ok(r[0].match.matchedPath === '/cam/A001.mxf', 'reelAliases as a Map works');
}

// ── Large/24h-roll TC-hour index: clip spanning 10:00→13:00 found by a 12:30 event ──
// The hour index only engages for >50 files; start-hour-only indexing risked
// dropping multi-hour rolls. Verifies the outcome among 60+ files.
{
  const files = [];
  for (let i = 0; i < 60; i++) {
    const hh = String((i % 9) + 1).padStart(2, '0');
    files.push({ reel: `X${i}`, name: `X${i}.mxf`, path: `/c/X${i}.mxf`, tcIn: `${hh}:00:00:00`, tcOut: `${hh}:30:00:00`, tcKnown: true, fps: 24 });
  }
  files.push({ reel: 'A050', name: 'A050.mxf', path: '/c/A050.mxf', tcIn: '10:00:00:00', tcOut: '13:00:00:00', tcKnown: true, fps: 24 });
  const events = [{ reel: 'A050', srcIn: '12:30:00:00', srcOut: '12:30:04:00', fps: 24 }];
  const r = matchAllEvents(events, files, { deduplicate: false });
  ok(r[0].match.matchedPath === '/c/A050.mxf', 'multi-hour roll (10→13h) links for a 12:30 event among 61 files');
}
// ── No regression: normal single-hour match still works with >50 files ──
{
  const files = [];
  for (let i = 0; i < 60; i++) {
    const hh = String((i % 9) + 1).padStart(2, '0');
    files.push({ reel: `R${i}`, name: `R${i}.mxf`, path: `/c/R${i}.mxf`, tcIn: `${hh}:00:00:00`, tcOut: `${hh}:10:00:00`, tcKnown: true, fps: 24 });
  }
  const events = [{ reel: 'R5', srcIn: '06:00:02:00', srcOut: '06:00:04:00', fps: 24 }]; // R5 → hh=06
  const r = matchAllEvents(events, files, { deduplicate: false });
  ok(r[0].match.matchedPath === '/c/R5.mxf', 'single-hour match unaffected by the spanned-hour index change');
}

// ── Reel-alias auto-suggest: renamed reel proposed from camera-name + TC ──
{
  const ocfCam = { reel: 'A001', name: 'A001C002_220101_R1AB.mxf', path: '/c/A001C002.mxf', tcIn: '01:00:00:00', tcOut: '01:00:30:00', tcKnown: true, fps: 24 };
  const evRenamed = { reel: 'REEL_A', srcFile: 'A001C002_220101_R1AB', clipName: 'A001C002_220101_R1AB', srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 24 };
  const sugg = suggestReelAliases([evRenamed], [ocfCam], {});
  ok(sugg.some(s => s.editorialReel === 'REEL_A' && s.cameraReel === 'A001'),
    'auto-suggest proposes REEL_A → A001 from camera-name + TC');
}
// No suggestion when the reel already resolves
{
  const ocf = { reel: 'A001', name: 'A001.mxf', path: '/c/A001.mxf', tcIn: '01:00:00:00', tcOut: '01:00:30:00', tcKnown: true, fps: 24 };
  const ev = { reel: 'A001', srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 24 };
  ok(suggestReelAliases([ev], [ocf], {}).length === 0, 'no suggestion when reel already matches');
}
// No suggestion when already aliased
{
  const ocfCam = { reel: 'A001', name: 'A001C002_220101_R1AB.mxf', path: '/c/A001C002.mxf', tcIn: '01:00:00:00', tcOut: '01:00:30:00', tcKnown: true, fps: 24 };
  const evRenamed = { reel: 'REEL_A', clipName: 'A001C002_220101_R1AB', srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 24 };
  ok(suggestReelAliases([evRenamed], [ocfCam], { reelAliases: { REEL_A: 'A001' } }).length === 0,
    'no suggestion when an alias already exists');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
