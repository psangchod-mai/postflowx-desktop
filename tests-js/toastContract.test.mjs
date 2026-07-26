// tests-js/toastContract.test.mjs
// A notification the user cannot see has not been sent.
//
// This tree had two ways of failing that test, and both were invisible from the
// call site:
//
//   1. A phantom global. `window._pmShowToast`, `window._showToast` and
//      `window.showToast` were read in feedback fallback chains and assigned
//      nowhere in src/. `typeof fn === 'function'` reads absent as "skip", so
//      the branch was dropped in silence. core/shotWorkItems.js had no working
//      branch left underneath, and "VFX marker created" reached console.info
//      and nobody else.
//
//   2. A phantom class. modules/amf_convert.js emitted class="mps-toast" and
//      toggled `.show` on it; neither selector existed in any stylesheet. Ten
//      messages — including export confirmations and raw upload errors —
//      appended unstyled text to the bottom of the document.
//
// Same species as the phantom element ids frozen in domContract.test.mjs, one
// level up in each direction: the name resolves to nothing, and nothing throws.
// So the gates below are name-resolution gates. A toast global must have a
// writer; a toast class must have a rule.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { parseHTML } from 'linkedom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const MODULE_PATH = join(SRC, 'scripts/core/pfxToast.js');
const MODULE_SRC = readFileSync(MODULE_PATH, 'utf8');
const MAIN_CSS = readFileSync(join(SRC, 'styles/main.css'), 'utf8');

// A source grep cannot tell code from prose, and this repo has been burned by
// that in both directions — a comment quoting `id="errors"` once convinced a
// scanner the element existed, and a comment explaining a removed
// `location.reload()` once convinced a gate the bug was still there. Every
// scan below runs on comment-stripped source.
const stripComments = (src) =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

function walkJs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkJs(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const JS_FILES = walkJs(SRC).map((p) => ({ path: p, rel: relative(ROOT, p), code: stripComments(readFileSync(p, 'utf8')) }));

// ── the harness has to work before what it reports means anything ────────────

/**
 * Runs the module the way a browser would — as a classic script against a real
 * document — with timers handed in so the suite can advance them instead of
 * waiting 3.5 real seconds per toast.
 */
function mountToast() {
  const { window } = parseHTML('<!doctype html><html><body></body></html>');
  const timers = new Map();
  let nextId = 1;
  const setTimeoutStub = (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; };
  const clearTimeoutStub = (id) => { timers.delete(id); };

  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'setTimeout', 'clearTimeout', MODULE_SRC)(
    window, window.document, setTimeoutStub, clearTimeoutStub,
  );

  return {
    window,
    doc: window.document,
    timers,
    /** Fire every timer currently pending, once, oldest first. */
    flush() {
      const due = [...timers.entries()].sort((a, b) => a[0] - b[0]);
      for (const [id, t] of due) { timers.delete(id); t.fn(); }
    },
    stack: () => window.document.getElementById('pfxToastStack'),
  };
}

/** The stack's children as a real array — HTMLCollection is array-*like*. */
const kids = (t) => Array.prototype.slice.call(t.stack()?.children || []);

test('the module installs both names its readers look for', () => {
  const { window } = mountToast();
  assert.equal(typeof window.pfxToast?.show, 'function', 'window.pfxToast.show is missing');
  assert.equal(typeof window.pfxToast?.dismissAll, 'function', 'window.pfxToast.dismissAll is missing');
  assert.equal(typeof window._pfxToast, 'function', 'window._pfxToast is missing');
});

test('the scan sees the tree', () => {
  // A grep-based gate can pass by finding nothing, which is exactly the failure
  // it exists to prevent. Pin the order of magnitude.
  assert.ok(JS_FILES.length > 100, `only ${JS_FILES.length} .js files found under src/`);
  assert.ok(MAIN_CSS.length > 100000, 'main.css was not read');
});

// ── behaviour: what the user actually gets ───────────────────────────────────

test('a message reaches the document as readable text', () => {
  const t = mountToast();
  t.window.pfxToast.show('Queued: A001_C003', 'info');
  const stack = t.stack();
  assert.ok(stack, 'no toast container was created');
  assert.equal(stack.children.length, 1);
  assert.match(stack.textContent, /Queued: A001_C003/);
});

test('the container is announced, and errors interrupt', () => {
  // Everything here is unrequested, so the region is polite by default. An
  // error is the one case worth cutting in on.
  const t = mountToast();
  t.window.pfxToast.show('Saved', 'success');
  assert.equal(t.stack().getAttribute('aria-live'), 'polite');
  assert.equal(t.stack().getAttribute('role'), 'status');

  t.window.pfxToast.show('Upload failed', 'error');
  const err = t.stack().lastElementChild;
  assert.equal(err.getAttribute('role'), 'alert');
});

test('an error waits to be read instead of expiring', () => {
  // The whole point. A 3.5s error has not been reported to anyone who has to
  // read it, work out what it means, and decide what to do.
  const t = mountToast();
  t.window.pfxToast.show('Resolve path not configured', 'error');
  const before = t.stack().children.length;
  t.flush();
  t.flush();
  assert.equal(t.stack().children.length, before, 'an error toast auto-dismissed');

  const close = t.stack().lastElementChild.querySelector('.pfx-toast-close');
  assert.ok(close, 'a non-expiring toast has no way to be dismissed');
  assert.equal(close.getAttribute('aria-label'), 'Dismiss this message');
  close.dispatchEvent(new t.window.Event('click'));
  t.flush();
  assert.equal(t.stack().children.length, 0, 'the dismiss button did not remove the toast');
});

test('a non-error toast does expire', () => {
  const t = mountToast();
  t.window.pfxToast.show('Mode set to Background Auto', 'info');
  assert.equal(t.stack().children.length, 1);
  t.flush();   // the dwell timer → schedules removal
  t.flush();   // the removal timer
  assert.equal(t.stack().children.length, 0, 'an info toast never went away');
});

test('a repeated message counts up instead of stacking', () => {
  // render_queue fires "Already queued: <clip>" once per click. Four identical
  // toasts is noise that hides the one underneath them that differs.
  const t = mountToast();
  t.window.pfxToast.show('Already queued: A001_C003', 'info');
  t.window.pfxToast.show('Already queued: A001_C003', 'info');
  t.window.pfxToast.show('Already queued: A001_C003', 'info');
  assert.equal(t.stack().children.length, 1);
  const badge = t.stack().lastElementChild.querySelector('.pfx-toast-count');
  assert.equal(badge.textContent, '×3');
  assert.equal(badge.hidden, false);
});

test('the stack is bounded, and bounding it terminates', () => {
  // This is the test that earned its keep. The first draft of the trim was
  // `while (host.children.length > MAX_VISIBLE) dismiss(host.firstElementChild)`
  // — and dismiss() is asynchronous, so the dismissed node is still a child on
  // the next check and the loop never exits. Nine toasts in a row froze the
  // renderer. If this test ever hangs instead of failing, that is the bug back.
  const t = mountToast();
  for (let i = 0; i < 9; i++) t.window.pfxToast.show(`Queued: clip ${i}`, 'info');
  const live = kids(t).filter((el) => !el.classList.contains('is-leaving'));
  assert.equal(live.length, 4, `${live.length} toasts left on screen`);
  // …and it is the oldest that go, not the newest.
  assert.match(live[0].textContent, /clip 5/);
  assert.match(live[3].textContent, /clip 8/);
});

test('an empty message is not a toast', () => {
  const t = mountToast();
  assert.equal(t.window.pfxToast.show('', 'info'), null);
  assert.equal(t.window.pfxToast.show(null), null);
  assert.equal(t.window.pfxToast.show('   '), null);
  assert.equal(t.stack(), null, 'an empty message still built the container');
});

test('an unknown severity is readable rather than invisible', () => {
  // Callers pass 'warn', 'error', 'danger', 'info' and sometimes nothing. A
  // severity the stylesheet does not know must not produce an unstyled toast —
  // that is the mps-toast bug in miniature.
  const t = mountToast();
  for (const sev of ['danger', 'fail', 'ok', 'WARNING', undefined, 'nonsense']) {
    t.window.pfxToast.show(`msg ${sev}`, sev);
  }
  for (const el of kids(t)) {
    const cls = el.getAttribute('class');
    assert.match(cls, /pfx-toast--(info|success|warn|error)\b/, `unstyled severity: ${cls}`);
  }
});

test('a throwing consumer cannot take the caller down with it', () => {
  // These calls sit at the end of export routines and queue handlers. A toast
  // that throws would abandon the work that succeeded.
  const t = mountToast();
  t.window.pfxFriendlyText = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => t.window.pfxToast.show('Upload failed', 'error'));
  assert.match(t.stack().textContent, /Upload failed/);
});

// ── gate 1: a toast global must have a writer ────────────────────────────────

test('no toast-shaped global is read that nothing assigns', () => {
  const READ = /window\.(_?[A-Za-z][A-Za-z0-9_]*[Tt]oast[A-Za-z0-9_]*)/g;
  const WRITE = /(?:window|globalThis)\.([A-Za-z_][A-Za-z0-9_]*)\s*=[^=]/g;

  const written = new Set();
  for (const f of JS_FILES) {
    for (const m of f.code.matchAll(WRITE)) written.add(m[1]);
  }

  const orphans = new Map();
  for (const f of JS_FILES) {
    for (const m of f.code.matchAll(READ)) {
      if (written.has(m[1])) continue;
      if (!orphans.has(m[1])) orphans.set(m[1], []);
      orphans.get(m[1]).push(f.rel);
    }
  }

  assert.deepEqual(
    [...orphans.keys()].sort(),
    [],
    `a toast global is read but never assigned anywhere in src/. The lookup ` +
      `returns undefined, the guard around it reads that as "skip", and the ` +
      `message is never shown:\n` +
      [...orphans].map(([n, fs]) => `  window.${n}  ${[...new Set(fs)].join(' ')}`).join('\n') +
      `\n\nUse window.pfxToast.show / window._pfxToast (scripts/core/pfxToast.js).`,
  );

  // The gate must be able to see the names it is meant to police.
  assert.ok(written.has('pfxToast'), 'the scan cannot see window.pfxToast being assigned');
  assert.ok(written.has('_pfxToast'), 'the scan cannot see window._pfxToast being assigned');
});

// ── gate 2: a toast class must have a rule ───────────────────────────────────

test('every class the shared toast emits is styled', () => {
  // Hand-maintained on purpose: the module builds variant names by
  // concatenation, so nothing can extract them reliably. Each entry is checked
  // against the module source as well as the stylesheet, so a rename breaks the
  // list rather than quietly emptying it.
  const EMITTED = [
    'pfx-toast-stack',
    'pfx-toast',
    'pfx-toast--info',
    'pfx-toast--success',
    'pfx-toast--warn',
    'pfx-toast--error',
    'pfx-toast-msg',
    'pfx-toast-count',
    'pfx-toast-close',
    'is-leaving',
  ];

  const unstyled = EMITTED.filter((c) => !new RegExp(`\\.${c.replace(/-/g, '\\-')}\\b`).test(MAIN_CSS));
  assert.deepEqual(
    unstyled,
    [],
    `these classes are emitted by pfxToast.js and styled nowhere in main.css, ` +
      `which is how .mps-toast shipped as unstyled text at the bottom of the ` +
      `document:\n` + unstyled.map((c) => `  .${c}`).join('\n'),
  );

  // …and the other direction: the list must still describe the module.
  const src = stripComments(MODULE_SRC);
  const stale = EMITTED.filter((c) => {
    if (!c.startsWith('pfx-toast--')) return !src.includes(c);
    // The variant is concatenated, so check the two halves separately: the
    // prefix as the module writes it, and the suffix as a KINDS value.
    const kind = c.slice('pfx-toast--'.length);
    return !src.includes("pfx-toast--' + kind") || !new RegExp(`:\\s*'${kind}'`).test(src);
  });
  assert.deepEqual(stale, [], `EMITTED lists classes pfxToast.js no longer produces: ${stale.join(', ')}`);
});

test('the amf_convert fallback class is styled too', () => {
  // This one is not emitted by pfxToast.js — it is the pre-existing div in
  // modules/amf_convert.js, which now delegates to the shared toast but keeps
  // its own path for the case where the shared module has not loaded. That
  // path was the bug; leaving it unstyled would leave the bug.
  assert.match(MAIN_CSS, /\.mps-toast\b/, '.mps-toast is still unstyled');
  assert.match(MAIN_CSS, /#mpsToast\.mps-toast\.show\b/, 'the .show state has no rule, so the toast can never appear');
  const amf = stripComments(readFileSync(join(SRC, 'scripts/modules/amf_convert.js'), 'utf8'));
  assert.match(amf, /window\.pfxToast\?\.show/, 'amf_convert no longer delegates to the shared toast');
});

// ── gate 3: the module is actually wired into the page ───────────────────────

test('index.html loads the module that defines the globals', () => {
  // Six panes now depend on window.pfxToast existing. Nothing in the tree
  // imports this file — it is a classic script — so a missing <script> tag
  // would restore all of the above with no test failing anywhere else.
  const html = readFileSync(join(SRC, 'index.html'), 'utf8');
  assert.match(html, /<script[^>]+src="scripts\/core\/pfxToast\.js"/, 'index.html does not load scripts/core/pfxToast.js');
});
