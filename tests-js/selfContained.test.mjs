// tests-js/selfContained.test.mjs
// The repository must contain the code the repository imports.
//
// WHY THIS EXISTS
// Every gate in this directory passes locally. That is a weaker claim than it
// reads as, because the tree they run against is not the tree that is committed.
// Export HEAD with `git archive` — the closest thing to a fresh clone — and the
// suite dies on its third file:
//
//     Error [ERR_MODULE_NOT_FOUND]: Cannot find module
//       …/features/aceslook/services/ocfIdtResolver.js
//       imported from …/features/vfxPull/colorPlanEngine.js
//
// ocfIdtResolver.js is 9,990 bytes on this disk and was never `git add`ed.
// colorPlanEngine.js, which imports it, is committed. Twenty-one imports in ten
// committed files point at fifteen modules nobody committed.
//
// The reason this is a gate and not a note is the arithmetic behind it. The
// runner is a shell loop; ERR_MODULE_NOT_FOUND kills the process; the loop
// stops. tests-js/ holds 102 test files, 72 of them tracked, and the crash is
// at the third tracked one. So a clone runs 2 gates out of 72 and this machine
// runs 102. Not one of the seventy-nine XSS, DOM-contract, accessibility or
// tutorial-coverage checks in between ever executes anywhere but here.
//
// That is the failure mode worth naming: the suite does not report itself as
// crippled. It prints two passing files and an exit code, and the exit code is
// the only part that is honest.
//
// THE RULE, in three parts
//   1. An import that resolves nowhere at all is a hard failure. Baselined
//      exceptions exist and may only shrink.
//   2. An import whose target exists locally but is untracked is a debt entry.
//      No new ones.
//   3. A test file on disk but not in git is a debt entry. No new ones.
//
// Parts 2 and 3 are shrink-only baselines rather than hard zeroes because the
// fifteen modules and thirty test files are somebody's uncommitted work. Whether
// they get committed or deleted is not this gate's call. What the gate can
// insist on is that the number stops going up, and that nobody adds the
// twenty-second.
//
// WHAT THIS CANNOT SEE
//  - Non-literal specifiers. `import(somePath)` is invisible in both
//    directions: a broken one is missed, and a module reached only that way
//    looks unimported.
//  - CommonJS. `electron/` is require()-based and out of scope. The same defect
//    there breaks the app rather than the suite and deserves its own pass.
//  - Whether a module that exists is correct, current, or does what its
//    importer expects. Only whether it will be there.
//  - Data files. A tracked module reading an untracked JSON at runtime passes.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { walk } from './lib/domIds.mjs';
import { trackedFiles, importEdges, importSpecs, resolveSpec, edgeKey } from './lib/moduleGraph.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (n) => JSON.parse(readFileSync(join(ROOT, 'tests-js/fixtures', n), 'utf8'));

const UNTRACKED_IMPORTS = fixture('untracked-imports.json');
const ABSENT_IMPORTS = fixture('absent-imports.json');
const UNTRACKED_TESTS = fixture('untracked-tests.json');

// Hard ceilings. A baseline is a debt list, not a parking space, so the bound is
// written as a literal: raising it is an edit somebody has to justify in review,
// which is the whole mechanism.
const MAX_UNTRACKED_IMPORTS = 21;
const MAX_ABSENT_IMPORTS = 2;
const MAX_UNTRACKED_TESTS = 30;

const tracked = trackedFiles(ROOT);
const haveGit = tracked !== null;

const srcFiles = walk(join(ROOT, 'src'), ['.js', '.mjs'], ROOT);
const trackedSrc = haveGit ? srcFiles.filter((f) => tracked.has(f.slice(ROOT.length + 1))) : [];
const edges = haveGit ? importEdges(trackedSrc, ROOT, tracked) : [];

const distinct = (state) => [...new Set(edges.filter((e) => e.state === state).map(edgeKey))].sort();
const untrackedEdges = distinct('untracked');
const absentEdges = distinct('absent');

const testFiles = readdirSync(join(ROOT, 'tests-js')).filter((f) => f.endsWith('.test.mjs')).sort();
const untrackedTests = haveGit ? testFiles.filter((f) => !tracked.has(`tests-js/${f}`)) : [];

// ── the scan has to work before what it reports means anything ───────────────

test('git is readable, or the reason is stated out loud', () => {
  // A source tarball has no .git and genuinely cannot answer this question. That
  // is a legitimate skip — but only if it is visible. A gate that quietly passed
  // when it could not run is exactly the silent no-op this repo keeps finding in
  // the app itself, and it would be worse here, because nobody looks at a green.
  if (!haveGit) {
    assert.equal(
      existsSync(join(ROOT, '.git')),
      false,
      '.git exists but `git ls-files` returned nothing — this gate is blind and reporting success',
    );
    return;
  }
  assert.ok(tracked.size > 500, `git ls-files returned only ${tracked.size} paths — that is not this repo`);
});

test('the scan actually sees the tree', () => {
  // Every assertion below is of the form "we found nothing new". A scan that
  // silently matched nothing would satisfy all of them, so pin the orders of
  // magnitude first.
  if (!haveGit) return;
  assert.ok(srcFiles.length > 200, `only ${srcFiles.length} .js files under src/ — the walk drifted`);
  assert.ok(trackedSrc.length > 180, `only ${trackedSrc.length} of them are tracked — the path join drifted`);
  assert.ok(edges.length > 250, `only ${edges.length} relative imports found — the import regexes drifted`);
  assert.ok(testFiles.length > 90, `only ${testFiles.length} test files found — the readdir drifted`);
  const resolved = edges.filter((e) => e.state === 'tracked').length;
  assert.ok(resolved > 250, `only ${resolved} imports resolved to tracked files — resolveSpec drifted`);
});

test('the detector separates a real import from a mentioned one', () => {
  const specs = importSpecs(
    [
      "import { a } from './real.js';",
      "// import { ghost } from './commented.js';",
      "import {",
      '  b,',
      "} from './multiline.js';",
      "import './sideEffect.js';",
      "const lazy = await import('./dynamic.js');",
      "import pkg from 'linkedom';",
    ].join('\n'),
  );
  assert.deepEqual(
    specs.map((s) => `${s.kind} ${s.spec}`).sort(),
    [
      'dynamic ./dynamic.js',
      'static ./multiline.js',
      'static ./real.js',
      'static ./sideEffect.js',
      'static linkedom',
    ],
    'importSpecs missed a form, or counted a comment as an import',
  );
});

test('the resolver models the shipped tree, not the source tree', () => {
  // build-renderer.js copies src/* and the repo-root assets/* into one directory
  // as siblings, so '../assets/…' from src/sandbox/ is correct at runtime even
  // though src/assets/ does not exist. Getting this wrong made the gate's first
  // run accuse a working decoder fallback of being dead.
  const seen = [];
  // Exact match, not endsWith: 'src/assets/imf/pure.js' also ends with
  // 'assets/imf/pure.js', so a suffix stub would pass whether or not the build
  // layout was modelled at all.
  const only = join(ROOT, 'assets/imf/pure.js');
  const exists = (p) => { seen.push(p); return p === only; };
  const got = resolveSpec('src/sandbox/j2k.js', '../assets/imf/pure.js?v=9', ROOT, exists);
  assert.equal(got, 'assets/imf/pure.js', `resolved to ${got}; the ?v= or the build layout was mishandled`);
  assert.ok(seen.some((p) => p.endsWith('src/assets/imf/pure.js')), 'src/ was never tried');

  // A bare package name is node_modules' problem, not this gate's.
  assert.equal(resolveSpec('src/scripts/ui.js', 'linkedom', ROOT), null);
  // And the doubled-segment shape that this iteration found stays detectable.
  assert.equal(
    resolveSpec('src/scripts/render_queue.js', './scripts/modules/x.js', ROOT, () => false),
    'src/scripts/scripts/modules/x.js',
  );
});

// ── the gate ─────────────────────────────────────────────────────────────────

test('no import resolves to nothing at all', () => {
  if (!haveGit) return;
  const fresh = absentEdges.filter((e) => !ABSENT_IMPORTS.includes(e));
  assert.deepEqual(
    fresh,
    [],
    'these imports point at files that do not exist anywhere — not in git, not on ' +
      'this disk, not in the built renderer. If the import is inside a try/catch it ' +
      'will fail silently forever; if it is static it takes the whole module down:\n  ' +
      fresh.join('\n  '),
  );
});

test('no committed file imports a module nobody committed', () => {
  if (!haveGit) return;
  const fresh = untrackedEdges.filter((e) => !UNTRACKED_IMPORTS.includes(e));
  assert.deepEqual(
    fresh,
    [],
    'a tracked file now imports an untracked one. It works here and breaks on every ' +
      'other machine, and if the importer is reached during tests it takes the rest ' +
      'of the suite down with it. Commit the target, or do not import it from ' +
      'committed code:\n  ' + fresh.join('\n  '),
  );
});

test('no new test file is left out of git', () => {
  if (!haveGit) return;
  const fresh = untrackedTests.filter((f) => !UNTRACKED_TESTS.includes(f));
  assert.deepEqual(
    fresh,
    [],
    'a gate exists on this disk and nowhere else. It protects nothing for anybody ' +
      'else, and its absence is invisible — the suite just runs fewer files:\n  ' +
      fresh.join('\n  '),
  );
});

// ── the baselines have to stay honest ────────────────────────────────────────

test('the baselines do not outlive what they describe', () => {
  if (!haveGit) return;
  const stale = [
    ...UNTRACKED_IMPORTS.filter((e) => !untrackedEdges.includes(e)).map((e) => `untracked-imports.json: ${e}`),
    ...ABSENT_IMPORTS.filter((e) => !absentEdges.includes(e)).map((e) => `absent-imports.json: ${e}`),
    ...UNTRACKED_TESTS.filter((f) => !untrackedTests.includes(f)).map((f) => `untracked-tests.json: ${f}`),
  ];
  assert.deepEqual(
    stale,
    [],
    'these entries are fixed — the module was committed, the import was corrected, or ' +
      'the file is gone. Delete them, or the baseline quietly re-permits the debt it ' +
      'was written to retire:\n  ' + stale.join('\n  '),
  );
});

test('the baselines only ever shrink', () => {
  assert.ok(
    UNTRACKED_IMPORTS.length <= MAX_UNTRACKED_IMPORTS,
    `untracked-imports.json grew to ${UNTRACKED_IMPORTS.length}; it is a debt list, not a parking lot`,
  );
  assert.ok(
    ABSENT_IMPORTS.length <= MAX_ABSENT_IMPORTS,
    `absent-imports.json grew to ${ABSENT_IMPORTS.length}; a dead import is a bug, not a baseline entry`,
  );
  assert.ok(
    UNTRACKED_TESTS.length <= MAX_UNTRACKED_TESTS,
    `untracked-tests.json grew to ${UNTRACKED_TESTS.length}; it is a debt list, not a parking lot`,
  );
});

test('the baselines are sorted and free of duplicates', () => {
  for (const [name, list] of [
    ['untracked-imports.json', UNTRACKED_IMPORTS],
    ['absent-imports.json', ABSENT_IMPORTS],
    ['untracked-tests.json', UNTRACKED_TESTS],
  ]) {
    assert.deepEqual(list, [...list].sort(), `${name} is out of order — regenerate it sorted`);
    assert.equal(new Set(list).size, list.length, `${name} has duplicate entries`);
  }
});

// ── the specific regression ──────────────────────────────────────────────────

test('the render queue can still reach the native helper', () => {
  // Found by the gate above on its first run, and worth pinning by name rather
  // than by count. render_queue.js imported './scripts/modules/native_helper_client.js'
  // — a doubled segment, from a file already inside src/scripts/ — inside a
  // `catch {}` that discarded the error. The import threw on every call, `helper`
  // was always null, and every press of Start Resolve Engine or Fix & Retry
  // ended with the job marked blocked and the toast "Native helper not available
  // — start Resolve manually, then retry". Resolve was installed and configured
  // correctly the whole time. The app blamed the user's machine for its own typo.
  const rq = readFileSync(join(ROOT, 'src/scripts/render_queue.js'), 'utf8');
  assert.doesNotMatch(
    rq,
    /import\(\s*['"]\.\/scripts\/modules\//,
    'the doubled path is back — render_queue.js is already inside src/scripts/',
  );
  assert.match(
    rq,
    /import\(\s*['"]\.\/modules\/native_helper_client\.js['"]\s*\)/,
    'render_queue.js no longer imports the native helper at all',
  );
  assert.equal(
    existsSync(join(ROOT, 'src/scripts/modules/native_helper_client.js')),
    true,
    'src/scripts/modules/native_helper_client.js is gone; the corrected path is now the broken one',
  );
});
