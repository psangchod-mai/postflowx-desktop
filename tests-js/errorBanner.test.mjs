// Error-banner DOM test (linkedom). Run: node tests-js/errorBanner.test.mjs
//
// showError() in ui.js was a no-op for its entire history: it looked up
// $("#errors"), an element that has never existed in this repo, and returned
// early. All 66 call sites in the renderer produced nothing on screen. The
// banner now mounts itself, and this file is what keeps it mounted — the
// failure mode is silent by nature, so nobody would notice it regressing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

// A fresh document per test: the module keeps one dismiss timer, and a banner
// left over from a previous case would make the next one pass for free.
function freshDoc(body = '') {
  const { window, document } = parseHTML(`<!doctype html><html><body>${body}</body></html>`);
  globalThis.window = window;
  globalThis.document = document;
  return document;
}
freshDoc();

const { showErrorBanner, hideErrorBanner, bannerHost, dismissDelay } =
  await import('../src/scripts/core/errorBanner.js');

// ── It appears at all — the whole point ──────────────────────────────────────

test('mounts itself when the page has no #errors element', () => {
  const doc = freshDoc();
  assert.equal(doc.querySelector('#errors'), null, 'precondition: no host slot');
  const el = showErrorBanner('Scan a VFX folder first.', doc);
  assert.ok(el, 'returned no element');
  assert.equal(el.textContent, 'Scan a VFX folder first.');
  assert.ok(doc.body.contains(el), 'banner was never attached to the document');
});

test('the message is visible, not merely present', () => {
  // The old code set opacity too; a banner in the DOM at opacity 0 is the same
  // bug wearing a disguise.
  const doc = freshDoc();
  const el = showErrorBanner('Native VFX Root is required.', doc);
  assert.equal(el.style.opacity, '1');
  assert.ok(el.classList.contains('pfx-error-banner--on'), 'missing the visible-state class');
});

test('only ever one banner, however many failures arrive', () => {
  const doc = freshDoc();
  showErrorBanner('first', doc);
  showErrorBanner('second', doc);
  showErrorBanner('third', doc);
  assert.equal(doc.querySelectorAll('#pfxErrorBanner').length, 1);
  assert.equal(doc.getElementById('pfxErrorBanner').textContent, 'third');
});

// ── It defers to a host that has its own slot ────────────────────────────────

test('an existing #errors element wins and no second banner is created', () => {
  // index.html has none, but the extension target and the tool pages do not
  // share that file — this module must not displace a slot someone added.
  const doc = freshDoc('<div id="errors"></div>');
  const el = showErrorBanner('Disk full', doc);
  assert.equal(el.id, 'errors');
  assert.equal(doc.getElementById('pfxErrorBanner'), null, 'created a banner despite a host slot');
  assert.equal(el.textContent, 'Disk full');
  assert.equal(el.style.opacity, '1', 'host slot must keep the old opacity contract');
});

// ── Clearing ─────────────────────────────────────────────────────────────────

test('an empty message hides the banner', () => {
  const doc = freshDoc();
  showErrorBanner('something failed', doc);
  const el = showErrorBanner('', doc);
  assert.equal(el.textContent, '');
  assert.equal(el.style.opacity, '0');
  assert.ok(!el.classList.contains('pfx-error-banner--on'));
});

test('null and undefined clear rather than printing themselves', () => {
  // showError(msg) passes `msg || ""` today, but this is called from catch
  // blocks and a literal "undefined" on screen is worse than nothing.
  for (const v of [null, undefined]) {
    const doc = freshDoc();
    const el = showErrorBanner(v, doc);
    assert.equal(el.textContent, '', `${String(v)} rendered as text`);
  }
});

test('hideErrorBanner clears a showing message', () => {
  const doc = freshDoc();
  showErrorBanner('still up', doc);
  const el = hideErrorBanner(doc);
  assert.equal(el.textContent, '');
});

// ── The message is text, never markup ────────────────────────────────────────

test('markup in a message is shown, not parsed', () => {
  // These strings come from catch blocks and carry raw exception text and
  // filesystem paths. A path can legally contain angle brackets.
  const doc = freshDoc();
  const payload = '<img src=x onerror="pwn()"> /Volumes/SHOW_A/<take 2>/reel.mxf';
  const el = showErrorBanner(payload, doc);
  assert.equal(el.textContent, payload, 'text was altered');
  assert.equal(el.querySelector('img'), null, 'markup was parsed into elements');
});

test('newlines survive, because file-not-found puts the path on its own line', () => {
  const doc = freshDoc();
  const msg = "That file or folder couldn't be found:\n/Volumes/SHOW_A/reel2.mxf";
  const el = showErrorBanner(msg, doc);
  assert.equal(el.textContent, msg);
  assert.match(el.textContent, /\n/);
});

// ── Reading time ─────────────────────────────────────────────────────────────

test('longer messages stay up longer, within bounds', () => {
  const short = dismissDelay('No events');
  const long = dismissDelay('x'.repeat(200));
  assert.ok(long > short, 'a long message is given no more time than a short one');
  assert.equal(short, 4000, 'must not drop below the 4s the old code allowed');
  assert.ok(long <= 15000, 'a banner that lingers this long becomes furniture');
  assert.equal(dismissDelay(''), 4000);
  assert.equal(dismissDelay(null), 4000);
});

test('the message clears itself once the delay elapses', () => {
  const doc = freshDoc();
  const real = globalThis.setTimeout;
  let captured = null, delay = 0;
  globalThis.setTimeout = (fn, ms) => { captured = fn; delay = ms; return 1; };
  try {
    const el = showErrorBanner('temporary problem', doc);
    assert.ok(captured, 'no dismiss timer was scheduled');
    assert.equal(delay, dismissDelay('temporary problem'));
    captured();
    assert.equal(el.textContent, '', 'timer fired but the text is still there');
    assert.equal(el.style.opacity, '0');
  } finally {
    globalThis.setTimeout = real;
  }
});

test('a second failure restarts the clock instead of inheriting the first one', () => {
  // Otherwise the first message's timeout cuts the second one short — worst on
  // the long messages that most need the reading time.
  const doc = freshDoc();
  const real = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const cleared = [];
  let id = 0, lastDelay = 0;
  globalThis.setTimeout = (_fn, ms) => { lastDelay = ms; return ++id; };
  globalThis.clearTimeout = (t) => cleared.push(t);
  try {
    showErrorBanner('short', doc);
    const longMsg = 'a considerably longer failure message that needs more reading time';
    showErrorBanner(longMsg, doc);
    assert.deepEqual(cleared, [1], 'the first timer was not cancelled');
    assert.equal(lastDelay, dismissDelay(longMsg));
  } finally {
    globalThis.setTimeout = real;
    globalThis.clearTimeout = realClear;
  }
});

// ── Reachable without a mouse or eyes ────────────────────────────────────────

test('the banner announces itself to a screen reader', () => {
  const doc = freshDoc();
  const el = showErrorBanner('Permission denied', doc);
  assert.equal(el.getAttribute('role'), 'alert');
  assert.equal(el.getAttribute('aria-live'), 'assertive');
});

test('clicking it dismisses it early', () => {
  const doc = freshDoc();
  const el = showErrorBanner('click me away', doc);
  el.dispatchEvent(new globalThis.window.Event('click'));
  assert.equal(el.textContent, '');
});

// ── No DOM at all ────────────────────────────────────────────────────────────

test('returns null rather than throwing when there is no document', () => {
  // Reached from catch blocks; a display failure must never mask the error it
  // was trying to report.
  assert.equal(bannerHost(null), null);
  assert.equal(bannerHost({}), null);          // an object with no .body
  assert.equal(bannerHost({ body: null }), null);

  const real = globalThis.document;
  globalThis.document = undefined;
  try {
    assert.equal(showErrorBanner('anything'), null, 'threw or invented a document');
  } finally {
    globalThis.document = real;
  }
});

// ── The caller is actually wired up ──────────────────────────────────────────

test('nothing in the renderer still writes to the phantom #errors element', () => {
  // The regression that started this: the display path existed, looked
  // plausible, and reached nothing. A unit test of this module alone would
  // still pass with ui.js disconnected, so assert on the caller too.
  //
  // Comments are stripped first — the replaced code is quoted in a comment
  // where showError used to live, and that is documentation, not a live lookup.
  const ui = readFileSync(SRC + 'scripts/ui.js', 'utf8');
  const code = ui.replace(/^[ \t]*\/\/.*$/gm, '');

  assert.equal(
    (code.match(/["'#]errors["'\)]/g) || []).length, 0,
    'a live #errors lookup is back; that element does not exist in any page');

  const fn = code.slice(code.indexOf('function showError(msg)'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
  assert.match(body, /showErrorBanner\(/, 'showError no longer calls the banner');
  assert.doesNotMatch(body, /if \(!el\) return/, 'the silent early-return is back');
  assert.match(code, /import \{ showErrorBanner, hideErrorBanner \} from "\.\/core\/errorBanner\.js"/,
    'the import is missing, so showError would throw instead of displaying');
  assert.match(code, /hideErrorBanner\(\)/,
    'the reset path no longer clears the banner, so a stale error survives a reset');
});

test('the stylesheet defines the classes the module sets', () => {
  // The module toggles pfx-error-banner--on; without the rule the banner stays
  // at opacity 0 and we are back to an invisible error.
  const css = readFileSync(SRC + 'styles/main.css', 'utf8');
  assert.match(css, /\.pfx-error-banner\s*\{/, '.pfx-error-banner rule missing');
  assert.match(css, /\.pfx-error-banner--on\s*\{/, '.pfx-error-banner--on rule missing');
  const on = css.slice(css.indexOf('.pfx-error-banner--on'));
  assert.match(on.slice(0, on.indexOf('}')), /opacity:\s*1/, 'the visible state is not visible');
});
