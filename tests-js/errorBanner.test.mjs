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
// Imported for the line-layout tests below: they assert against the parts
// friendlyError() returns rather than against copies of the wordings, which
// drift. Same module the banner itself humanizes through.
const { friendlyError, friendlyText } = await import('../src/scripts/core/friendlyError.js');

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
  const el = showErrorBanner('Scan a VFX folder first.', doc);
  assert.equal(el.id, 'errors');
  assert.equal(doc.getElementById('pfxErrorBanner'), null, 'created a banner despite a host slot');
  assert.equal(el.textContent, 'Scan a VFX folder first.');
  assert.equal(el.style.opacity, '1', 'host slot must keep the old opacity contract');
});

// ── Plain language, applied where nothing can bypass it ──────────────────────

test('raw exception text is rewritten before it reaches the screen', () => {
  // 17 of the 70 showError() call sites pass err?.message straight through.
  // Before the banner existed those were invisible; now they are the first
  // thing a non-technical user reads.
  const doc = freshDoc();
  const el = showErrorBanner('ENOSPC: no space left on device', doc);
  assert.doesNotMatch(el.textContent, /ENOSPC/, 'the errno reached the user');
  assert.match(el.textContent, /disk is full/i, 'no plain-language rewrite happened');
  assert.match(el.textContent, /free up space/i, 'rewritten but with no next step');
});

test('a stack-shaped message never reaches the user verbatim', () => {
  const doc = freshDoc();
  const el = showErrorBanner("TypeError: cannot read properties of undefined (reading 'frames')", doc);
  assert.doesNotMatch(el.textContent, /TypeError|undefined|properties/,
    'raw JS internals shown to someone who cannot act on them');
  assert.match(el.textContent, /went wrong inside PostFlowX/i);
});

test("the app's own hand-written messages are left exactly alone", () => {
  // 53 of the 70 sites already say something useful. Rewriting those would be
  // a regression, not an improvement.
  const doc = freshDoc();
  for (const msg of [
    'Scan a VFX folder first.',
    'Native VFX Root is required.',
    'Open the Cut Diff tab, then retry',
    'No events to export.',
  ]) {
    assert.equal(showErrorBanner(msg, doc).textContent, msg, `reworded: ${msg}`);
  }
});

test('rewriting twice is the same as rewriting once', () => {
  // Some callers humanize before calling — including showError itself in an
  // in-flight working-tree change — and a rule's output can re-match its own
  // pattern ("The disk is full…" still contains "disk is full"). If this ever
  // stops holding, those messages get their hint appended twice.
  const doc = freshDoc();
  for (const raw of [
    'ENOENT: no such file or directory, open /Volumes/SHOW/reel.mxf',
    'ENOSPC: no space left on device',
    'EACCES: permission denied, open /private/x',
    'EBUSY: resource busy or locked',
    'Failed to fetch',
    '401 Unauthorized',
    'memory access out of bounds',
  ]) {
    const once = showErrorBanner(raw, doc).textContent;
    const twice = showErrorBanner(once, doc).textContent;
    assert.equal(twice, once, `not idempotent for: ${raw}`);
  }
});

test('the filesystem path survives the rewrite — it is the actionable part', () => {
  const doc = freshDoc();
  const el = showErrorBanner('ENOENT: no such file or directory, open /Volumes/SHOW/reel.mxf', doc);
  assert.match(el.textContent, /\/Volumes\/SHOW\/reel\.mxf/, 'the path was reworded away');
  assert.match(el.textContent, /\n/, 'the path must stay on its own line');
});

// ── The advice goes on its own line, never glued to a path ───────────────────
//
// friendlyText() used to join message and hint with a space. Two rules end
// their message with a filesystem path, and post-house volumes have spaces in
// their names, so the result was a line with no visible boundary between the
// path and the advice:
//
//   /Volumes/SHOW DRIVE 01/reel3/A003C012.ari Check that it still exists and…
//
// One raw string per rule, so this notices a rule added later with the old
// join — enumerating the rules, not the wordings, which drift.

const CORPUS = [
  'ECONNREFUSED connecting to the companion',
  'HTTP 401 unauthorized',
  'unknown native action: probeMedia',
  'DaVinci Resolve not installed',
  'Resolve scripting is disabled on this machine',
  'ENOSPC: no space left on device',
  "EACCES: permission denied, open '/Volumes/SHOW A/out.mxf'",
  'EBUSY: resource busy or locked',
  "ENOENT: no such file or directory, open '/Volumes/SHOW DRIVE 01/reel3/A003C012.ari'",
  'ETIMEDOUT',
  'failed to write output file',
  'ffmpeg exited with code 1',
  'Unexpected end of JSON input',
  'Failed to fetch',
  'memory access out of bounds',
  "cannot read properties of undefined (reading 'frames')",
];

test('every rule with advice puts it on its own line', () => {
  let hinted = 0;
  for (const raw of CORPUS) {
    const f = friendlyError(raw);
    if (!f.hint) continue;
    hinted++;
    const text = friendlyText(raw);
    assert.equal(text, `${f.message}\n${f.hint}`, `advice is not on its own line for: ${raw}`);
    const lines = text.split('\n');
    assert.equal(lines[lines.length - 1], f.hint, `last line is not the advice for: ${raw}`);
    assert.ok(
      !lines.slice(0, -1).some((l) => l.includes(f.hint)),
      `the advice also appears above its own line for: ${raw}`,
    );
  }
  // Guards the corpus itself: if the rules stopped matching these strings the
  // loop above would pass by never running.
  assert.ok(hinted >= 14, `only ${hinted} of ${CORPUS.length} samples matched a rule with advice`);
});

test('file-not-found reads as three lines: what, where, what next', () => {
  // The volume name has a space in it on purpose — that is the case the space
  // join made unreadable, and the one every post house actually has.
  const doc = freshDoc();
  const raw = "ENOENT: no such file or directory, open '/Volumes/SHOW DRIVE 01/reel3/A003C012.ari'";
  const lines = showErrorBanner(raw, doc).textContent.split('\n');
  assert.equal(lines.length, 3, `expected 3 lines, got ${lines.length}:\n  ${lines.join('\n  ')}`);
  assert.equal(lines[1], '/Volumes/SHOW DRIVE 01/reel3/A003C012.ari', 'the path is not alone on its line');
  assert.equal(lines[2], friendlyError(raw).hint, 'the advice is not alone on the last line');
});

test('the banner carries pre-wrap inline, not only via the stylesheet', () => {
  // The tool pages mount this without main.css. Without the inline rule the
  // newlines above collapse there and the defect comes back on those hosts
  // only, which is the version of it nobody would find.
  const doc = freshDoc();
  const el = showErrorBanner('ENOSPC: no space left on device', doc);
  assert.equal(el.style.whiteSpace, 'pre-wrap');
});

test('a host-supplied #errors is left to its own styling', () => {
  // Same reasoning as the class/opacity handling: that slot owns its
  // presentation, and this module must not start overriding it.
  const doc = freshDoc('<div id="errors"></div>');
  const el = showErrorBanner('ENOSPC: no space left on device', doc);
  assert.equal(el.id, 'errors', 'precondition: the host slot was used');
  // Unset reads back as '' in a browser and undefined in linkedom; both mean
  // untouched, which is the thing being asserted.
  assert.ok(!el.style.whiteSpace, 'the module imposed white-space on a host slot');
});

test('an unrewritable message is still shown rather than replaced', () => {
  // Pass-through is the conservative default; a message nobody wrote a rule for
  // is better than a generic one.
  const doc = freshDoc();
  const odd = 'Reel 04A failed conform at 01:00:12:07';
  assert.equal(showErrorBanner(odd, doc).textContent, odd);
});

test('reading time is measured on what is displayed, not what was thrown', () => {
  // A three-word errno becomes two sentences; timing the dismissal on the errno
  // would take the message away before it could be read.
  const doc = freshDoc();
  const raw = 'ENOSPC';
  const shown = showErrorBanner(raw, doc).textContent;
  assert.ok(shown.length > raw.length, 'precondition: the rewrite is longer');
  assert.ok(dismissDelay(shown) > dismissDelay(raw), 'dismissal still timed on the raw text');
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

  // The messages are multi-line. This has been here since the banner was added
  // — pinning it so a stylesheet tidy-up cannot quietly collapse them back into
  // one run-on paragraph on the pages that DO load main.css.
  const base = css.slice(css.indexOf('.pfx-error-banner {'));
  assert.match(base.slice(0, base.indexOf('}')), /white-space:\s*pre-wrap/,
    'the banner no longer honours newlines, so the advice runs on from the path');
});
