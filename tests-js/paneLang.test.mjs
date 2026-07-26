// tests-js/paneLang.test.mjs
// Covers scripts/core/paneLang.js — pushing the app's language into the tool
// panes — plus the two wiring points that make it reachable at runtime.
//
// The frames are hand-built rather than linkedom nodes: linkedom has no iframe
// navigation, no contentWindow, and no load event, and those three are exactly
// what this module is about. Faking them keeps the assertions on the module's
// own logic (which frames it picks, what it sends, when it re-sends) instead of
// on a DOM shim's approximation of a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const { broadcastLang, paneFrames, currentPaneLang, LANG_MESSAGE } =
  await import('../src/scripts/core/paneLang.js');

// ── helpers ──────────────────────────────────────────────────────────────────

/** A same-origin iframe that records what it was sent. */
function frame(opts = {}) {
  const f = {
    sent: [],
    loadHandlers: [],
    contentDocument: opts.contentDocument === undefined ? {} : opts.contentDocument,
    contentWindow: null,
    addEventListener(type, fn) {
      if (type === 'load') this.loadHandlers.push(fn);
    },
    fireLoad() { for (const fn of this.loadHandlers) fn(); },
  };
  f.contentWindow = opts.contentWindow === undefined
    ? { postMessage: (msg) => f.sent.push(msg) }
    : opts.contentWindow;
  return f;
}

/** An iframe pointing at a third party: touching contentDocument throws. */
function crossOriginFrame() {
  const f = {
    sent: [],
    get contentDocument() { throw new DOMExceptionish('blocked a frame from accessing a cross-origin frame'); },
    get contentWindow() { return { postMessage: (msg) => f.sent.push(msg) }; },
    addEventListener() {},
  };
  return f;
}
class DOMExceptionish extends Error {}

const docOf = (...frames) => ({ querySelectorAll: () => frames });

// ── which frames get talked to ───────────────────────────────────────────────

test('every same-origin frame in the document is messaged', () => {
  const a = frame(), b = frame();
  assert.equal(broadcastLang('th', docOf(a, b)), 2);
  assert.deepEqual(a.sent, [{ type: 'pfx:lang', lang: 'th' }]);
  assert.deepEqual(b.sent, [{ type: 'pfx:lang', lang: 'th' }]);
});

test('the message type is the exported constant, not a loose string', () => {
  const a = frame();
  broadcastLang('ko', docOf(a));
  assert.equal(a.sent[0].type, LANG_MESSAGE);
  assert.equal(LANG_MESSAGE, 'pfx:lang');
});

test('a cross-origin frame is skipped, not posted to', () => {
  // The Fun Box pane can hold a YouTube embed. Reaching contentDocument throws
  // there, and that throw is the origin check — if it ever stops being caught,
  // one bad frame takes the whole broadcast down with it.
  const yt = crossOriginFrame();
  const ours = frame();
  assert.equal(broadcastLang('ja', docOf(yt, ours)), 1);
  assert.deepEqual(yt.sent, []);
  assert.equal(ours.sent.length, 1);
});

test('a frame with no contentDocument is skipped', () => {
  const blank = frame({ contentDocument: null });
  assert.deepEqual(paneFrames(docOf(blank)), []);
  assert.equal(broadcastLang('id', docOf(blank)), 0);
});

test('a frame whose postMessage throws does not stop the others', () => {
  const bad = frame({ contentWindow: { postMessage() { throw new Error('detached'); } } });
  const good = frame();
  assert.equal(broadcastLang('th', docOf(bad, good)), 1);
  assert.equal(good.sent.length, 1);
});

test('a frame with no contentWindow is counted as unreached', () => {
  const f = frame({ contentWindow: null });
  assert.equal(broadcastLang('ja', docOf(f)), 0);
});

test('no document at all is survivable', () => {
  assert.deepEqual(paneFrames(null), []);
  assert.deepEqual(paneFrames({}), []);
  assert.equal(broadcastLang('th', null), 0);
});

// ── what counts as a language ────────────────────────────────────────────────

test('an empty language is not broadcast', () => {
  // Falsy here means "nothing was chosen", which is not a thing to force a pane
  // into — it would blank a pane that is already correctly localised.
  const a = frame();
  assert.equal(broadcastLang('', docOf(a)), 0);
  assert.equal(broadcastLang(null, docOf(a)), 0);
  assert.equal(broadcastLang(undefined, docOf(a)), 0);
  assert.deepEqual(a.sent, []);
});

test('currentPaneLang reports the last language actually sent', () => {
  broadcastLang('ko', docOf(frame()));
  assert.equal(currentPaneLang(), 'ko');
  broadcastLang('', docOf(frame()));
  assert.equal(currentPaneLang(), 'ko', 'a rejected empty broadcast must not clear it');
  broadcastLang('th', docOf(frame()));
  assert.equal(currentPaneLang(), 'th');
});

// ── the load race, which is the whole reason the module is not a one-liner ───

test('a pane that loads after the language was chosen still gets it', () => {
  // Both panes start display:none and load lazily; initI18nUI runs at startup.
  // Whichever order those happen in, the pane must end up in the right language.
  const f = frame();
  broadcastLang('th', docOf(f));
  f.sent.length = 0;
  f.fireLoad();
  assert.deepEqual(f.sent, [{ type: 'pfx:lang', lang: 'th' }]);
});

test('the load handler sends the current language, not the one it was armed with', () => {
  const f = frame();
  broadcastLang('ja', docOf(f));
  broadcastLang('ko', docOf(f));
  f.sent.length = 0;
  f.fireLoad();
  assert.deepEqual(f.sent, [{ type: 'pfx:lang', lang: 'ko' }]);
});

test('the load handler is armed once, however many broadcasts happen', () => {
  const f = frame();
  broadcastLang('en', docOf(f));
  broadcastLang('th', docOf(f));
  broadcastLang('ko', docOf(f));
  assert.equal(f.loadHandlers.length, 1, 'one handler per frame, or a reload sends N duplicates');
});

// ── wiring: the module only matters if something calls it ────────────────────

test('i18n.js broadcasts on every language application', () => {
  const src = read('src/scripts/modules/i18n.js');
  assert.match(src, /import \{ broadcastLang \} from "\.\.\/core\/paneLang\.js"/);

  const start = src.indexOf('export function applyI18n(lang)');
  assert.ok(start > 0, 'applyI18n moved or was renamed');
  const body = src.slice(start, src.indexOf('\nfunction applyI18nTo', start));
  assert.match(body, /broadcastLang\(L\)/, 'applyI18n must push the language to the panes');

  // setLang and initI18nUI both route through applyI18n; if that ever stops
  // being true the broadcast silently covers only one of the two entry points.
  const setLang = src.slice(src.indexOf('export function setLang(lang)'));
  assert.match(setLang.slice(0, 200), /applyI18n\(v\)/);
});

test('the broadcast cannot leave the i18n observer paused', () => {
  // applyI18n pauses its MutationObserver while it walks. A throw from a pane
  // must not escape before resumeObserver() runs, or the whole app stops
  // translating anything ever again.
  const src = read('src/scripts/modules/i18n.js');
  const start = src.indexOf('export function applyI18n(lang)');
  const body = src.slice(start, src.indexOf('\nfunction applyI18nTo', start));
  assert.ok(
    body.indexOf('resumeObserver()') < body.indexOf('broadcastLang('),
    'broadcastLang must run after the observer is resumed'
  );
  assert.match(body, /try\{ broadcastLang\(L\); \}catch\{\}/, 'and be caught regardless');
});

test('the bwav pane prefers the app-wide language over its own mirror', () => {
  const src = read('src/tools/bwav/app.js');
  assert.match(src, /function preferredLocale\(\)/);

  const fn = src.slice(src.indexOf('function preferredLocale()'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(
    body.indexOf('"mps.lang"') < body.indexOf('"bwav_locale"'),
    'mps.lang is the user\'s stated choice; bwav_locale is only what this file wrote last'
  );
  assert.match(body, /navigator\.language/, 'the OS guess must survive as a last resort');
  assert.match(src, /const initial = preferredLocale\(\)/, 'and it has to actually be used');
});

test('the bwav pane reacts to a language change, not just to startup', () => {
  const src = read('src/tools/bwav/app.js');
  const init = src.slice(src.indexOf('function initLocaleUI()'));
  const body = init.slice(0, init.indexOf('\n}\n'));

  assert.match(body, /addEventListener\("message"/, 'postMessage is the primary channel');
  assert.match(body, /d\.type !== "pfx:lang"/, 'and must match what paneLang.js sends');
  assert.match(body, /addEventListener\("storage"/, 'storage is the fallback');
  assert.match(body, /ev\.key !== "mps\.lang"/, 'keyed on mps.lang only — reacting to our own write loops');
  assert.doesNotMatch(body, /ev\.key === "bwav_locale"/);
});

test('the pfx:lang contract is spelled the same on both sides', () => {
  const bwav = read('src/tools/bwav/app.js');
  const pane = read('src/scripts/core/paneLang.js');
  assert.match(pane, /export const LANG_MESSAGE = 'pfx:lang'/);
  assert.match(bwav, /d\.type !== "pfx:lang"/);
  assert.match(bwav, /normalizeLocale\(d\.lang\)/, 'the host sends host locale codes; the pane must map them');
});

test('every language the host can send maps to something bwav can render', () => {
  // The host offers 7 languages; bwav has 5 dictionaries. The mapping must be
  // total — an unmapped code would fall through to a locale with no entries and
  // render raw dictionary keys ("ui.subtitle") to the user.
  const bwav = read('src/tools/bwav/app.js');
  const hostLangs = ['en', 'ko', 'ja', 'zh-TW', 'th', 'id', 'fil'];

  const norm = bwav.slice(bwav.indexOf('function normalizeLocale(raw)'));
  const rules = [...norm.slice(0, norm.indexOf('\n}\n')).matchAll(/startsWith\("(\w+)"\)\) return "([\w-]+)"/g)];
  const mapped = (code) => {
    const s = code.toLowerCase();
    for (const [, prefix, out] of rules) if (s.startsWith(prefix)) return out;
    return 'en';
  };

  const dicts = new Set([...bwav.matchAll(/^  ([a-z-]+): \{$/gm)].map((m) => m[1]));
  for (const lang of hostLangs) {
    const target = mapped(lang);
    assert.ok(
      dicts.has(target) || target === 'zh-TW',
      `host language ${lang} maps to ${target}, which has no dictionary`
    );
  }
  assert.equal(mapped('fil'), 'en', 'Filipino has no bwav dictionary and must fall back cleanly');
  assert.equal(mapped('th'), 'th');
  assert.equal(mapped('zh-TW'), 'zh-TW');
});
