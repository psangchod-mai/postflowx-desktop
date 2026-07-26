// tests-js/lib/domIds.mjs
// Extract "which element ids does the renderer define" and "which does it read",
// so the two sets can be compared.
//
// WHY THIS EXISTS
// Three separate iterations of this project each found the same species of bug
// by hand: code that looks up an element id no HTML file contains.
//
//     ui.js            $("#errors")        — 66 error messages, none displayed
//     bwav/app.js      #localeSelect       — 6 translations, none selectable
//     preflight/app.js #localeSelect       — 18 locale files, none selectable
//
// Every one failed *silently*. `getElementById` returns null, the surrounding
// `if (!el) return` treats that as "nothing to do", and the feature is switched
// off with no error, no log line, and no way for a user to tell a refused action
// from a broken one. Finding these by reading code does not scale: the sweep
// this module was written for turned up 311 such ids across 440 read sites.
//
// The point is not to fix 311 ids. Most are harmless leftovers — an element the
// UI redesign renamed, with a working alternate right beside it. The point is
// that number 311 should be impossible to add without noticing.
//
// WHAT THIS CANNOT SEE
// An id assembled at runtime (`el.id = "row-" + n`) is invisible to a static
// scan, in both directions. Reads are therefore restricted to *string-literal*
// lookups, and the definition side is deliberately generous — anything that
// looks remotely like it might mint an id counts as defining it. Both choices
// push errors toward "we missed a phantom" and away from "we invented one",
// because a false positive here costs somebody an afternoon proving a working
// feature works.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Every file under `dir` whose name ends in one of `exts`, repo-relative. */
export function walk(dir, exts, root = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, exts, root, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

// An id is "defined" if any of these appear anywhere in any source file. They
// are matched against JS as well as HTML because most of this renderer's markup
// is minted from template literals — #eventScroll, for one, exists only inside a
// backtick string in ui.js. A scan that read HTML alone would report hundreds of
// live elements as missing.
const DEFINERS = [
  /\sid\s*=\s*\\?["']([^"'{}\s\\$]+)\\?["']/g,          // <div id="x">, in markup or a template literal
  /\.id\s*=\s*["'`]([^"'`${}]+)["'`]/g,                  // el.id = "x"
  /setAttribute\(\s*["']id["']\s*,\s*["']([^"']+)["']/g, // el.setAttribute("id", "x")
];

// A read is a lookup by string literal. Anything computed is out of scope.
const READERS = [
  /getElementById\(\s*["'`]([A-Za-z_][\w-]*)["'`]\s*\)/g,
  /querySelector\(\s*["'`]#([A-Za-z_][\w-]*)["'`]\s*\)/g,
  /querySelectorAll\(\s*["'`]#([A-Za-z_][\w-]*)["'`]\s*\)/g,
  /(?<![\w.])\$\(\s*["'`]#([A-Za-z_][\w-]*)["'`]\s*\)/g, // the repo's own $ helper
];

/**
 * A comment cannot create an element, and treating one as if it could is how
 * this scan nearly shipped blind. `errorBanner.js` opens with a note reading
 * `No element with id="errors" has ever existed` — the sentence documenting the
 * bug registered as a fix for it, and #errors dropped out of the results. Any
 * line whose *first* non-space characters begin a comment is skipped. That is
 * narrow on purpose: a trailing `// note` after real code leaves the code
 * intact, and no markup line starts with `//`.
 */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

/** All ids the sources could plausibly bring into existence. */
export function definedIds(files, read = (f) => readFileSync(f, 'utf8')) {
  const ids = new Set();
  for (const f of files) {
    const src = read(f)
      .split('\n')
      .filter((line) => !COMMENT_LINE.test(line))
      .join('\n');
    for (const re of DEFINERS) for (const m of src.matchAll(new RegExp(re))) ids.add(m[1]);
  }
  return ids;
}

/**
 * Every literal id lookup, with enough context to say what happens when it
 * misses. The distinction is the whole point — see classify() below.
 */
export function idReads(files, read = (f) => readFileSync(f, 'utf8'), root = process.cwd()) {
  const out = [];
  for (const f of files) {
    const rel = relative(root, f);
    const lines = read(f).split('\n');
    lines.forEach((line, i) => {
      for (const re of READERS) {
        for (const m of line.matchAll(new RegExp(re))) {
          out.push({
            id: m[1],
            file: rel,
            line: i + 1,
            kind: classify(line.slice(0, m.index), line.slice(m.index + m[0].length), m[1], lines[i + 1]),
            text: line.trim(),
          });
        }
      }
    });
  }
  return out;
}

/**
 * What a miss costs, judged by what the code does with the result.
 *
 *   'crash'    — dereferenced with no guard. null.textContent throws, and in a
 *                renderer that throw takes the rest of the handler with it.
 *   'fallback' — the first arm of `a || b`. A miss is the intended path.
 *   'silent'   — stored, optional-chained, or truthiness-tested. Nothing
 *                happens, and nothing says so.
 *
 * Two cases need more than the text to the right of the lookup:
 *
 * `if ($("#kFps")) $("#kFps").textContent = x` reads the same id twice on one
 * line, and the second read is dereferenced. It is not a crash — the first read
 * is the guard. Any repeat of an id already mentioned earlier on the line is
 * therefore treated as guarded.
 *
 * `const el = $("#x");` followed by `el.textContent = y` is a crash that lives
 * on two lines. Catching it needs one line of lookahead, which is as far as this
 * goes; anything more is a job for a parser, not a regex.
 */
export function classify(before, after, id, nextLine) {
  if (/^\s*(\|\||\?\?)/.test(after)) return 'fallback';
  if (/^\s*\.\s*[A-Za-z_]/.test(after)) {
    return before.includes(id) ? 'silent' : 'crash';
  }
  // `[\w$.]*$` absorbs the receiver. `const el = document.getElementById("x")`
  // leaves "const el = document." to the left of the match, not "const el = ",
  // so anchoring hard on `=` made this branch fire for the repo's own $("#x")
  // helper and for nothing else — it passed its unit test while never once
  // running against real source.
  const assigned = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[\w$.]*$/.exec(before);
  if (assigned && /^\s*;?\s*$/.test(after) && nextLine != null) {
    // `?.` is a guard; a bare `.` on the very next line is not.
    if (new RegExp(`^\\s*${assigned[1]}\\s*\\.\\s*[A-Za-z_]`).test(nextLine)) return 'crash';
  }
  return 'silent';
}
