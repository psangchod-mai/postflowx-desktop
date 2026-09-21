// Router & extension consistency (Phase C + D). The renderer's parseFromFiles
// delegates DRP handling + extension routing to this canonical registry, which
// is pure and testable here. Run: node --test test/pipeline/router.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TIMELINE_EXTS, TIMELINE_ACCEPT, routeTimelineFile, isTimelineFile, drpHintResult, DRP_HINT,
} from '../../src/scripts/modules/conform/timelineFormats.js';

test('every supported extension dispatches to a handler (no fall-through)', () => {
  for (const ext of TIMELINE_EXTS) {
    const r = routeTimelineFile('clip' + ext);
    assert.ok(r.kind, `${ext} → handler kind "${r.kind}" (not a silent no-events fall-through)`);
  }
});

test('.drp routes to the OTIO-export hint, never a silent empty', () => {
  const r = routeTimelineFile('project.drp');
  assert.equal(r.kind, 'drp');
  assert.equal(r.hint, DRP_HINT);
  assert.deepEqual(r.events, []);
  // The typed result parseFromFiles returns for a dropped .drp:
  assert.deepEqual(drpHintResult(), { events: [], _hint: 'DRP_EXPORT_OTIO' });
});

test('canonical set + accept string include the formats that had drifted', () => {
  for (const ext of ['.prproj', '.drp', '.edl', '.otio', '.fcpxml', '.aaf', '.ale']) {
    assert.ok(TIMELINE_EXTS.includes(ext), `TIMELINE_EXTS includes ${ext}`);
    assert.ok(TIMELINE_ACCEPT.includes(ext), `accept string includes ${ext}`);
  }
});

test('isTimelineFile — case-insensitive, accepts names and File-likes', () => {
  assert.ok(isTimelineFile('A.PRPROJ'));
  assert.ok(isTimelineFile({ name: 'x.drp' }));
  assert.ok(isTimelineFile('cut.edl'));
  assert.ok(!isTimelineFile('movie.mov'), 'non-timeline rejected');
  assert.equal(routeTimelineFile('movie.mov').kind, null, 'unsupported → kind null');
});
