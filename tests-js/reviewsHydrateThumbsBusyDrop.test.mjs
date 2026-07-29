// __pfxHydrateThumbs() busy-flag drop (src/scripts/features/reviews/index.js).
// Run: node tests-js/reviewsHydrateThumbsBusyDrop.test.mjs
//
// __pfxEnsureMarkerThumbLoaded(markerId) is the on-demand path several UI sites
// call to force one marker's thumbnail into memory. It works by awaiting
// __pfxHydrateThumbs({ markerIds: [id], ... }). But __pfxHydrateThumbs also runs
// as a background sweep (via __pfxScheduleHydrateThumbs / an {all:true} pass),
// and used to guard re-entrancy with a bare boolean:
//
//   if (__pfxHydrateThumbsBusy) return false;
//
// If that sweep was already in flight when an on-demand request for a specific
// marker arrived, the on-demand call got `false` back immediately — the
// marker's thumbnail was never loaded even though it would have succeeded had
// it simply waited its turn — and __pfxEnsureMarkerThumbLoaded then returned
// null for a thumbnail that exists and is reachable.
//
// This test extracts the real function bodies (plus their small pure
// dependencies) out of the 10k-line monolithic module via source-slicing and
// evaluates them against stubbed store/kvGet/kvSet, since the module itself
// only exposes these as closures private to mountVfxReviewsTab(mount) and
// mounting the whole tab is not required to exercise this logic.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/scripts/features/reviews/index.js'), 'utf8');

function extractBlock(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `could not find start marker: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end >= 0, `could not find end marker: ${endMarker}`);
  return src.slice(start, end + endMarker.length);
}

// Pure helpers + the two functions under test, in original source order.
const block = extractBlock(
  SRC,
  "const __PFX_REV_THUMB_IDB_PREFIX",
  "async function __pfxEnsureMarkerThumbLoaded(markerId) {\n  const id = String(markerId || '').trim();\n  if (!id) return null;\n  const markers = Array.isArray(store?.state?.markers) ? store.state.markers : [];\n  const cur = markers.find((m) => String(m?.id || '') === id) || null;\n  if (!cur) return null;\n  if (cur.thumbDataUrl) return cur.thumbDataUrl;\n  await __pfxHydrateThumbs({ markerIds: [id], trim: false, emit: false });\n  return (markers.find((m) => String(m?.id || '') === id) || cur)?.thumbDataUrl || null;\n}"
);

function buildHarness({ store, kvGet, kvSet }) {
  const markersBody = null;
  const notesVisibleIds = null;
  const factory = new Function(
    'store', 'markersBody', 'notesVisibleIds', 'kvGet', 'kvSet',
    `
    ${block}
    return { __pfxHydrateThumbs, __pfxEnsureMarkerThumbLoaded };
    `
  );
  return factory(store, markersBody, notesVisibleIds, kvGet, kvSet);
}

function makeStore(markers) {
  return { state: { markers, selectedMarkerId: '' } };
}

// A kvGet that resolves after a real delay, so a background sweep genuinely
// overlaps with an on-demand request instead of resolving synchronously.
function slowKvGet(db, delayMs) {
  return (key) => new Promise((resolve) => {
    setTimeout(() => resolve(db.get(key) ?? null), delayMs);
  });
}

test('on-demand thumbnail request succeeds even while a background sweep is in flight', async () => {
  const db = new Map([
    ['reviews.thumb.v1.m1', 'data:image/png;base64,AAA'],
    ['reviews.thumb.v1.m2', 'data:image/png;base64,BBB'],
  ]);
  const markers = [
    { id: 'm1', thumbKey: 'reviews.thumb.v1.m1', thumbDataUrl: null },
    { id: 'm2', thumbKey: 'reviews.thumb.v1.m2', thumbDataUrl: null },
  ];
  const store = makeStore(markers);
  const kvGet = slowKvGet(db, 30);
  const kvSet = async () => {};

  const { __pfxHydrateThumbs, __pfxEnsureMarkerThumbLoaded } = buildHarness({ store, kvGet, kvSet });

  // Kick off a background sweep covering every marker (mirrors
  // __pfxScheduleHydrateThumbs firing an {all:true} pass) and, before it
  // resolves, ask for a specific marker's thumbnail on demand.
  const sweepPromise = __pfxHydrateThumbs({ all: true });
  await new Promise((r) => setTimeout(r, 5)); // let the sweep actually start (past its busy-flag set)

  const onDemand = await __pfxEnsureMarkerThumbLoaded('m1');
  await sweepPromise;

  assert.equal(onDemand, 'data:image/png;base64,AAA',
    'on-demand request must resolve the real thumbnail, not null, even though a sweep was already running');
});

test('two overlapping on-demand requests for different markers both resolve', async () => {
  const db = new Map([
    ['reviews.thumb.v1.a', 'data:image/png;base64,A'],
    ['reviews.thumb.v1.b', 'data:image/png;base64,B'],
  ]);
  const markers = [
    { id: 'a', thumbKey: 'reviews.thumb.v1.a', thumbDataUrl: null },
    { id: 'b', thumbKey: 'reviews.thumb.v1.b', thumbDataUrl: null },
  ];
  const store = makeStore(markers);
  const kvGet = slowKvGet(db, 20);
  const kvSet = async () => {};

  const { __pfxEnsureMarkerThumbLoaded } = buildHarness({ store, kvGet, kvSet });

  const [a, b] = await Promise.all([
    __pfxEnsureMarkerThumbLoaded('a'),
    __pfxEnsureMarkerThumbLoaded('b'),
  ]);

  assert.equal(a, 'data:image/png;base64,A');
  assert.equal(b, 'data:image/png;base64,B');
});
