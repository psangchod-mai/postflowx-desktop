// tests-js/visualQcProgress.test.mjs
// The Visual QC scan narrates itself. This checks it can do that in six languages.
//
// WHY THIS EXISTS
// A Visual QC scan is the longest-running thing in PostFlowX — it seeks through
// a whole clip frame by frame, and the only evidence it is still alive is the
// line under the progress bar. Every one of those lines was a hardcoded English
// literal:
//
//     setProgress(0, 'Preparing…');
//     setProgress(i/totalSteps, `Scanning… ${i+1}/${totalSteps}`);
//     setProgress(1, 'Done. No events.');
//
// A literal in a template is not a dictionary key, so i18n.js could not see it
// and the MutationObserver could not fix it: setProgress writes with
// .textContent, and the observer only re-translates nodes whose text it has a
// key for. So the app was translated everywhere except the one place a person
// stares at for four minutes wondering whether it has hung.
//
// The two error labels are the same species with a sharper edge.
// friendlyStatus() deliberately holds the "<what failed>:" prefix back from
// translation — its own doc says so, because running the whole string through
// friendlyText() would drop the prefix and lose the only context on screen.
// That contract puts the job of localising the label on the CALL SITE, which is
// exactly why friendlyError.js exports translate(). Both call sites here had
// skipped it, so a Thai user reading a fully translated error message still got
// "Visual QC scan failed:" welded onto the front of it.
//
// WHAT IS PINNED HERE
// Every string setProgress is handed is either produced by translate(), by
// friendlyStatus, or by saveNotice/notice (which translate internally). The
// counters, ratios and filenames interpolated around them stay as they are —
// digits do not need a dictionary. Each key has a row in all six locales, and
// no row is a copy of the English.
//
// WHAT THIS CANNOT SEE
// - Whether the six locales read well. This proves the rows exist, are short
//   enough for the strip, and are not English. Not that they are good Thai.
// - The saveNotice/notice paths (lines that report a save or an export result)
//   are translated by their own modules and gated by their own tests; this file
//   only checks that setProgress is not handed a bare English literal.
// - Runtime order. translate() reads the language chosen at call time, which is
//   the right behaviour for a progress line written during a scan, but nothing
//   here starts a scan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(ROOT + p, 'utf8');

const QC_PATH = 'src/scripts/components/visualQcModal/index.js';
const I18N_PATH = 'src/scripts/modules/i18n.js';
const qc = read(QC_PATH);
const i18n = read(I18N_PATH);

// The eleven strings this iteration moved into the dictionary.
const KEYS = [
  'Preparing…',
  'Scanning…',
  'Merging hits…',
  'Done. No events.',
  'Resolving burn-in…',
  'Done.',
  'Capturing stills…',
  'Building report…',
  'Opening print dialog…',
  'Visual QC scan failed',
  'Exporting the PDF report failed',
];

const UI_LOCALES = ['ko', 'ja', 'zh-TW', 'th', 'id', 'fil'];

// ── The finding itself ───────────────────────────────────────────────────────

test('no setProgress call is handed a bare English literal', () => {
  // Constructs the list from the source rather than repeating it, so a
  // thirteenth setProgress added next month is checked without anyone
  // remembering to come back here.
  const calls = [...qc.matchAll(/setProgress\(\s*[^,]+,\s*([\s\S]*?)\);/g)].map((m) => m[1]);
  assert.ok(calls.length >= 13, `only found ${calls.length} setProgress calls — did the file change shape?`);

  const offenders = [];
  for (const arg of calls) {
    // Look only at the STRING LITERALS in the argument, and only at the ones
    // that are not already the argument of a translate() call. An expression
    // with no literals in it (saveNotice(outcome).text, notice.text) produces
    // its own translated prose and is somebody else's gate; an expression with
    // a bare literal in it is this file's problem.
    const withoutTranslated = arg.replace(/translate\(\s*(['"`])(?:\\.|(?!\1)[\s\S])*?\1\s*\)/g, '');
    const literals = [...withoutTranslated.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)]
      .map((m) => m[2].replace(/\$\{[\s\S]*?\}/g, ''));
    if (literals.some((s) => /[A-Za-z]{3,}/.test(s))) offenders.push(arg.trim().slice(0, 90));
  }
  assert.deepEqual(offenders, [],
    `untranslated English handed to the progress strip:\n  ${offenders.join('\n  ')}`);
});

test('both error labels are translated at the call site, as friendlyStatus requires', () => {
  // friendlyStatus keeps the label out of friendlyText on purpose — see its
  // doc comment. That makes localising the label the call site's job, and
  // friendlyError.js exports translate() for exactly this. If either reverts
  // to a bare literal, a fully translated message gets an English heading.
  const labelled = [...qc.matchAll(/friendlyStatus\(\s*`([^`]*)`/g)].map((m) => m[1]);
  assert.equal(labelled.length, 2, `expected 2 friendlyStatus call sites, found ${labelled.length}`);
  for (const s of labelled) {
    assert.match(s, /^\$\{translate\(/,
      `the "<what failed>:" label is a bare English literal again: ${JSON.stringify(s)}`);
  }
});

test('translate is imported from friendlyError, not reimplemented', () => {
  // friendlyError's _t shim is guarded and does not import i18n — importing
  // i18n directly from a component would pull the whole dictionary into a
  // module that only needs eleven rows.
  assert.match(qc, /import \{ friendlyStatus, translate \} from '\.\.\/\.\.\/core\/friendlyError\.js';/,
    'visualQcModal no longer takes translate from core/friendlyError.js');
});

// ── The dictionary side ──────────────────────────────────────────────────────

test('every key has a row in all six locales', () => {
  const missing = [];
  for (const k of KEYS) {
    const row = i18n.match(new RegExp(`\\n\\s*${escapeRe(JSON.stringify(k))}:\\s*\\[([^\\]]*)\\]`));
    if (!row) { missing.push(`${k} — no row at all`); continue; }
    const cells = row[1].split(/",\s*"/).length;
    if (cells !== UI_LOCALES.length) missing.push(`${k} — ${cells} cells, expected ${UI_LOCALES.length}`);
  }
  assert.deepEqual(missing, [], `incomplete UI_DICT_ROWS entries:\n  ${missing.join('\n  ')}`);
});

test('no locale cell is just the English back again', () => {
  // A row that copies the key passes a naive "is it present" check while
  // showing English to the user — the failure mode this file exists to catch,
  // one level down.
  const echoes = [];
  for (const k of KEYS) {
    const row = i18n.match(new RegExp(`\\n\\s*${escapeRe(JSON.stringify(k))}:\\s*\\[([^\\]]*)\\]`));
    if (!row) continue;
    for (const cell of JSON.parse(`[${row[1]}]`)) {
      if (cell.trim().toLowerCase() === k.trim().toLowerCase()) echoes.push(`${k} -> ${cell}`);
    }
  }
  assert.deepEqual(echoes, [], `identity translations:\n  ${echoes.join('\n  ')}`);
});

test('every reason fits the strip: one line, short', () => {
  // setProgress writes into progTxt and mirrors into the caller's one-line
  // status element. A newline collapses there and a long line truncates.
  const tooLong = [];
  for (const k of KEYS) {
    const row = i18n.match(new RegExp(`\\n\\s*${escapeRe(JSON.stringify(k))}:\\s*\\[([^\\]]*)\\]`));
    if (!row) continue;
    for (const cell of JSON.parse(`[${row[1]}]`)) {
      if (/\n/.test(cell) || cell.length > 60) tooLong.push(`${k} -> ${cell} (${cell.length})`);
    }
  }
  assert.deepEqual(tooLong, [], `will not fit a progress strip:\n  ${tooLong.join('\n  ')}`);
});

// ── Floors ───────────────────────────────────────────────────────────────────

test('floor: the mirror still flattens newlines before handing text to the caller', () => {
  // setProgress's mirror strips line breaks because the caller's status element
  // is single-line and not this component's to restyle. If that goes, a
  // two-line friendlyStatus message arrives there with the hint welded on.
  assert.match(qc, /onStatus\?\.\(String\(text \|\| ''\)\.replace\(\/\\s\*\\n\\s\*\/g, ' '\)\)/,
    'setProgress no longer flattens the newline for the mirrored status element');
});

test('floor: friendlyStatus still holds the label back from translation', () => {
  // The whole justification for translating the label at the call site. If
  // friendlyStatus ever starts running the prefix through friendlyText, doing
  // it here too would translate it twice.
  const fe = read('src/scripts/core/friendlyError.js');
  const body = fe.slice(fe.indexOf('export function friendlyStatus'));
  assert.match(body.slice(0, 600), /return `\$\{m\[1\]\}: \$\{tail\}`/,
    'friendlyStatus changed shape — re-check whether the call-site translate() is still correct');
});

test('floor: the keys are not in ERROR_DICT', () => {
  // These are progress lines. ERROR_DICT is scanned by errorI18n.test.mjs
  // against a list of source files; putting a progress string there makes it
  // look like a dead error key to that check.
  const errDict = i18n.slice(i18n.indexOf('const ERROR_DICT'), i18n.indexOf('const PARITY_DICT'));
  const strays = KEYS.filter((k) => errDict.includes(`${JSON.stringify(k)}:`));
  assert.deepEqual(strays, [], `progress strings landed in ERROR_DICT: ${strays.join(', ')}`);
});

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
