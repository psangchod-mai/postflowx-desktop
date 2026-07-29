// mediaSearchBox stale-async-response race test (linkedom).
// Run: node tests-js/mediaSearchBoxRace.test.mjs
//
// The debounced search fires an async db.search IPC call per keystroke.
// clearTimeout() only cancels a timer that hasn't fired yet — it does nothing
// once a search is already in flight. Without a sequence guard, a slower
// earlier search can resolve *after* a faster later one and silently
// clobber the dropdown/lastRows with results for a term the input no longer
// shows.
import { parseHTML } from 'linkedom';

const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = document;

const { mountMediaSearch } = await import('../src/scripts/features/mediaSearch/mediaSearchBox.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

// Fake native engine: 'cat' resolves slowly, 'cats' resolves fast — simulates
// the out-of-order resolution that a real IPC round-trip can produce.
const pending = {};
window.pfxPlatform = {
  nativeEngine: {
    command: (name, { term }) => new Promise((resolve) => {
      pending[term] = () => resolve([{ filename: `${term}.mov`, path: `/media/${term}.mov` }]);
    }),
  },
};

const host = document.createElement('div');
document.body.appendChild(host);
mountMediaSearch(host, () => {});
const input = host.querySelector('input');
const results = host.querySelector('.pfx-msrch-results');

function type(value) {
  input.value = value;
  input.dispatchEvent(new window.Event('input'));
}

// Fire the "cat" keystroke, let its debounce elapse (starts the slow search),
// then fire "cats" before "cat" resolves, and let its debounce elapse too.
type('cat');
await new Promise(r => setTimeout(r, 210));
type('cats');
await new Promise(r => setTimeout(r, 210));

// Resolve "cats" (the newer, faster search) first, then "cat" (the stale one).
pending['cats']();
await new Promise(r => setTimeout(r, 0));
pending['cat']();
await new Promise(r => setTimeout(r, 0));

ok(results.innerHTML.includes('cats.mov') && !results.innerHTML.includes('>cat.mov<'),
  `dropdown reflects the current term "cats", not the stale late-arriving "cat" response (got: ${results.innerHTML.replace(/\s+/g, ' ')})`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
