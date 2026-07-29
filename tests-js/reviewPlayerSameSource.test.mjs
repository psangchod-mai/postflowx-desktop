// ReviewPlayer._sameSource exact-match test (linkedom). Run: node tests-js/reviewPlayerSameSource.test.mjs
// Guards against substring-containment false positives, e.g. ".../clip1.mp4"
// vs ".../clip12.mp4" being treated as the same source.
import { parseHTML } from 'linkedom';

const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
// linkedom leaves baseURI as null with no document URL; the code under test
// needs a real base to resolve relative URLs against.
Object.defineProperty(document, 'baseURI', { value: 'https://cdn.example.com/app/', configurable: true });
globalThis.window = window;
globalThis.document = document;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent || window.Event;

const { ReviewPlayer } = await import('../src/scripts/features/reviews/player.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

const videoA = document.createElement('video');
const videoB = document.createElement('video');
const player = new ReviewPlayer({ videoA, videoB, store: {} });

// Distinct clips where one URL is a literal prefix of the other (e.g. clip
// id "1" vs "10") must NOT match — this is the exact shape the old
// substring-containment check ("cur.includes(want) || want.includes(cur)")
// got wrong.
{
  const video = { currentSrc: 'https://cdn.example.com/stream?clip=clip1' };
  ok(player._sameSource(video, 'https://cdn.example.com/stream?clip=clip10') === false,
    'clip=clip1 vs clip=clip10 (one URL a literal prefix of the other) is not treated as same source');
}
{
  const video = { currentSrc: 'https://cdn.example.com/stream?clip=clip10' };
  ok(player._sameSource(video, 'https://cdn.example.com/stream?clip=clip1') === false,
    'reverse direction: clip=clip10 vs clip=clip1 is not treated as same source');
}

// Exact matches must still return true.
{
  const video = { currentSrc: 'https://cdn.example.com/clips/clip1.mp4' };
  ok(player._sameSource(video, 'https://cdn.example.com/clips/clip1.mp4') === true,
    'identical absolute URLs are treated as same source');
}

// Equivalent relative/absolute forms resolving to the same absolute URL must match.
{
  const video = { currentSrc: 'https://cdn.example.com/app/clips/clip1.mp4' };
  ok(player._sameSource(video, 'clips/clip1.mp4') === true,
    'relative URL resolving to the same absolute URL as currentSrc is treated as same source');
}

// Empty/null/undefined inputs must still return false.
{
  const video = { currentSrc: '' };
  ok(player._sameSource(video, 'https://cdn.example.com/clips/clip1.mp4') === false,
    'empty currentSrc returns false');
}
{
  const video = { currentSrc: 'https://cdn.example.com/clips/clip1.mp4' };
  ok(player._sameSource(video, '') === false, 'empty url returns false');
  ok(player._sameSource(video, null) === false, 'null url returns false');
  ok(player._sameSource(video, undefined) === false, 'undefined url returns false');
}
ok(player._sameSource(null, 'https://cdn.example.com/clips/clip1.mp4') === false,
  'null video returns false');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
