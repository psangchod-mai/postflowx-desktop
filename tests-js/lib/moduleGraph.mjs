// tests-js/lib/moduleGraph.mjs
// Extract "which modules does the committed tree import" and "which of those
// did anybody actually commit", so the two sets can be compared.
//
// WHY THIS EXISTS
// A `git archive HEAD` tree — the closest thing to a fresh clone — cannot run
// its own test suite. It dies here:
//
//     Error [ERR_MODULE_NOT_FOUND]: Cannot find module
//       …/features/aceslook/services/ocfIdtResolver.js
//       imported from …/features/vfxPull/colorPlanEngine.js
//
// colorPlanEngine.js is committed. ocfIdtResolver.js is 9,990 bytes on the
// author's disk and was never `git add`ed. The import is correct, the file is
// real, and the repository does not contain it.
//
// What makes this worth a gate rather than a note is the blast radius. The
// runner behind `npm run test:js` is a shell loop, and an ERR_MODULE_NOT_FOUND
// is a dead process, so the run stops at the first offender and every gate
// after it never executes. On a clone that is two files out of seventy-two.
// Every other gate in this directory — the XSS scan, the DOM contract, the
// accessibility names, the tutorial coverage — reports nothing, and reports it
// as success right up until the exit code.
//
// So the local suite being green is true, and it is green for a reason that
// does not survive leaving this machine. That is a different property from the
// one a green suite is supposed to establish.
//
// WHAT THIS CANNOT SEE
//  - Anything not written as a string literal. `import(dynamicPath)` is
//    invisible, in both directions.
//  - CommonJS. `electron/` is `require()`-based and out of scope here; the same
//    defect there breaks the app rather than the suite, and wants its own pass.
//  - Whether an imported module is *correct*. Only whether it will be there.
//  - Whether a file that exists is reachable at runtime. A tracked module that
//    nothing imports passes, as it should.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';

/** Repo-relative, forward-slashed, the way `git ls-files` prints paths. */
export const toRepoPath = (root, abs) => relative(root, abs).split(sep).join('/');

/**
 * Every path git knows about, or `null` when this is not a checkout.
 *
 * The null case is real and must stay distinguishable from "git said nothing":
 * a source tarball or a `git archive` export has no .git, and a gate that
 * quietly passed there would be exactly the silent no-op this repo keeps
 * finding. Callers are expected to check and say so out loud.
 */
export function trackedFiles(root) {
  if (!existsSync(join(root, '.git'))) return null;
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return new Set(out.split('\0').filter(Boolean));
}

/**
 * A comment cannot import anything. domIds.mjs learned this the hard way — a
 * sentence documenting a bug registered as its fix — and the modules below are
 * discussed by name in comments throughout this tree.
 */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;
export const stripCommentLines = (src) =>
  src.split('\n').filter((line) => !COMMENT_LINE.test(line)).join('\n');

// `[^;]` deliberately matches newlines: a multi-line `import { a, b } from 'x'`
// has no semicolon before `from`, so this spans the list without needing the
// `s` flag or a parser. Anchoring on a preceding boundary keeps it from firing
// inside identifiers like `reimport`.
const FROM = /(?:^|[;\s])(?:import|export)\s[^;]*?\bfrom\s*['"]([^'"]+)['"]/g;
const BARE = /(?:^|[;\s])import\s*['"]([^'"]+)['"]/g;
const DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Every module specifier this source pulls in, tagged by how.
 *
 * The tag matters because the two fail differently. A static import that cannot
 * resolve kills the process at load, before a single test runs. A dynamic one
 * rejects a promise at the moment the feature is used, which is worse for the
 * user and better for the suite.
 */
export function importSpecs(src) {
  const clean = stripCommentLines(src);
  const out = [];
  for (const re of [FROM, BARE]) {
    for (const m of clean.matchAll(new RegExp(re))) out.push({ spec: m[1], kind: 'static' });
  }
  for (const m of clean.matchAll(new RegExp(DYNAMIC))) out.push({ spec: m[1], kind: 'dynamic' });
  return out;
}

/**
 * `src/` is not the tree this code runs in.
 *
 * build-renderer.js copies the contents of src/ and the contents of the
 * repo-root assets/ into one directory, as siblings. So sandbox/j2k_decoder.js
 * importing '../assets/imf/jpeg2000_pure.js' is correct at runtime — it lands
 * on dist/desktop/assets/ — and looks broken if you resolve it against the
 * source layout, where src/assets/ does not exist.
 *
 * Resolving in the shipped tree's coordinates and then mapping back is the
 * difference between this gate reporting a real dead import and reporting the
 * repo's own directory structure at somebody.
 */
const toRenderer = (repoRel) => (repoRel.startsWith('src/') ? repoRel.slice(4) : repoRel);
const fromRenderer = (rendererRel) => [`src/${rendererRel}`, rendererRel];

/**
 * Turn a relative specifier into the repo-relative path that will be loaded.
 *
 * Returns null for anything that is not ours to check — a package name, a URL,
 * a data: import. Those resolve through node_modules and are the lockfile's
 * problem, not this gate's.
 *
 * ESM requires the extension, so the extensionless candidates below are a
 * courtesy for imports that would already be broken. They exist so that such an
 * import is reported as *absent* rather than skipped: being generous about what
 * counts as resolvable pushes the error toward "we flagged something real" and
 * away from "we silently ignored it".
 */
export function resolveSpec(importerRel, spec, root, exists = existsSync) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  // A cache-busting '?v=…' is part of the URL, never part of the filename.
  const clean = spec.split(/[?#]/)[0];
  const dir = dirname(toRenderer(importerRel));
  const base = join(dir, clean).split(sep).join('/');
  const stems = /\.(js|mjs|cjs|json|css)$/.test(base)
    ? [base]
    : [`${base}.js`, `${base}.mjs`, `${base}/index.js`];
  const candidates = stems.flatMap(fromRenderer);
  for (const c of candidates) if (exists(join(root, c))) return c;
  return candidates[0];
}

/**
 * Every relative import in `files`, resolved and labelled.
 *
 *   'tracked'   — git has it; a clone gets it
 *   'untracked' — on this disk only. The clone breaks; this machine never will.
 *   'absent'    — nowhere at all. Broken here too, so this must stay at zero.
 */
export function importEdges(files, root, tracked, read = (f) => readFileSync(f, 'utf8')) {
  const edges = [];
  for (const abs of files) {
    const from = toRepoPath(root, abs);
    for (const { spec, kind } of importSpecs(read(abs))) {
      const to = resolveSpec(from, spec, root);
      if (to === null) continue;
      const state = tracked.has(to) ? 'tracked' : existsSync(join(root, to)) ? 'untracked' : 'absent';
      edges.push({ from, spec, to, kind, state });
    }
  }
  return edges;
}

/** The stable one-line form a baseline entry takes. */
export const edgeKey = (e) => `${e.from} -> ${e.to}`;
