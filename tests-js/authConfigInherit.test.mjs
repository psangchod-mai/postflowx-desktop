// tests-js/authConfigInherit.test.mjs
// A build must not erase the credential it wasn't told about.
//
// WHY THIS EXISTS
// build-renderer.js writes authConfig.json, which electron-builder packages as
// Resources/authConfig.json — the only auth config a packaged PostFlowX reads.
// It resolved the access-policy URL like this:
//
//     const apiUrl = (process.env.POSTFLOWX_AUTH_API_URL || '').trim();
//
// which looks like an ordinary default and is in fact a delete. Run
// `npm run build:renderer` without that env var — the normal thing to do, and
// what every packaging run in this repo does — and the working URL is replaced
// with "". Package that, and the login card answers every user with
//
//     PostFlowX access policy service is not configured for this build.
//
// Nothing failed. The build printed success, the tests passed, the app
// launched. The only symptom was one red line under the sign-in button, and it
// named a *build* problem to a user who has no build.
//
// THE RULE
// An absent environment variable is not an instruction to erase. resolveInherited
// takes the first source that actually has a value; only a value no source has
// ever supplied resolves to empty.
//
// WHAT THIS CANNOT SEE
//  - Whether the URL is correct, reachable, or points at the right deployment.
//    "Non-empty" is the whole net. A build that inherits a stale endpoint passes.
//  - devAuthBypass, which must NOT inherit — a `true` picked up from a
//    developer's machine would ship a build that signs everyone in as Local Dev.
//    The last test here pins that it stays out of the inheriting set.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);
const { resolveInherited } = require_(join(ROOT, 'tools/authConfigInherit.js'));

const readJson = (f) => {
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
};

// ── the policy ───────────────────────────────────────────────────────────────

test('the highest-priority source that has a value wins', () => {
  assert.deepEqual(
    resolveInherited([
      { source: 'env', value: 'https://from-env/exec' },
      { source: 'prior', value: 'https://from-prior/exec' },
    ]),
    { value: 'https://from-env/exec', source: 'env' },
  );
});

test('an absent env var falls through instead of erasing', () => {
  // This is the whole bug in three lines: process.env.X is undefined, and the
  // value that already exists must survive that.
  assert.deepEqual(
    resolveInherited([
      { source: 'env', value: process.env.__PFX_DEFINITELY_UNSET__ },
      { source: 'authConfig.json', value: 'https://from-prior/exec' },
      { source: 'local', value: 'https://from-local/exec' },
    ]),
    { value: 'https://from-prior/exec', source: 'authConfig.json' },
  );
});

test('blank, whitespace and null never displace a real value', () => {
  for (const blank of ['', '   ', '\n\t', null, undefined]) {
    const got = resolveInherited([
      { source: 'env', value: blank },
      { source: 'local', value: 'https://real/exec' },
    ]);
    assert.equal(got.value, 'https://real/exec', `${JSON.stringify(blank)} displaced a real value`);
  }
});

test('a value no source supplies resolves to empty, not to a guess', () => {
  assert.deepEqual(
    resolveInherited([{ source: 'env', value: '' }, { source: 'local', value: undefined }]),
    { value: '', source: 'unset' },
  );
  assert.deepEqual(resolveInherited([]), { value: '', source: 'unset' });
  assert.deepEqual(resolveInherited(undefined), { value: '', source: 'unset' });
});

test('values are trimmed — a trailing newline from a file must not break the URL', () => {
  // authConfig.json values arrive via JSON.parse, but env vars piped in from a
  // shell or a CI secret store routinely carry one.
  assert.equal(resolveInherited([{ source: 'env', value: ' https://x/exec\n' }]).value, 'https://x/exec');
});

// ── the specific regression ──────────────────────────────────────────────────

test('build-renderer no longer resolves either credential with a bare `|| \'\'`', () => {
  const build = readFileSync(join(ROOT, 'build-renderer.js'), 'utf8');
  assert.match(build, /resolveInherited\(/, 'build-renderer stopped using the inheriting resolver');

  // The exact shape that caused this: an env read defaulting straight to ''.
  for (const envVar of ['POSTFLOWX_AUTH_API_URL', 'GOOGLE_DESKTOP_CLIENT_ID']) {
    const destructive = new RegExp(`process\\.env\\.${envVar}\\s*\\|\\|\\s*\\n?\\s*['"]['"]`);
    assert.equal(
      destructive.test(build),
      false,
      `${envVar} is back to defaulting to '' — an unset env var will erase a working build again`,
    );
  }
});

test('devAuthBypass never inherits', () => {
  // Deliberately not pinned to one spelling — it has been a hardcoded `false`
  // and an env read, and both are correct. The property is narrower than either:
  // nothing that decides devAuthBypass may consult a previous build's config.
  const build = readFileSync(join(ROOT, 'build-renderer.js'), 'utf8');
  const lines = build.split('\n').filter((l) => l.includes('devAuthBypass') && !/^\s*(\/\/|\/\*|\*)/.test(l));
  assert.ok(lines.length > 0, 'devAuthBypass vanished from build-renderer entirely');
  for (const line of lines) {
    assert.doesNotMatch(
      line,
      /resolveInherited|priorResources|localDevConfig/,
      `devAuthBypass must not inherit — a \`true\` picked up from a developer's ` +
        `machine would ship a build that signs everyone in as Local Dev:\n  ${line.trim()}`,
    );
  }
});

test('the main process has a fallback when Resources/authConfig.json is empty', () => {
  const ipc = readFileSync(join(ROOT, 'electron/ipc.js'), 'utf8');
  const fn = ipc.slice(ipc.indexOf('function _getPostflowxAuthApiUrl()'));
  const body = fn.slice(0, fn.indexOf('\n  }') + 4);
  assert.match(
    body,
    /authConfig\.generated\.json/,
    '_getPostflowxAuthApiUrl has no bundled fallback; one empty value takes access checking offline',
  );
});

// ── the build actually on this machine ───────────────────────────────────────

test('this checkout has not lost an access-policy URL it used to have', () => {
  // authConfig.json is git-ignored and generated, so it is absent on a fresh
  // clone and in CI — nothing to check there. The failure worth catching is the
  // narrow one: the file exists, its URL is empty, and a source that could have
  // filled it is sitting right here. That is erasure, not "never configured".
  const resources = readJson(join(ROOT, 'authConfig.json'));
  if (!resources) return;
  if (String(resources.postflowxAuthApiUrl || '').trim()) return;

  const available = [
    ['electron/authConfig.local.json', readJson(join(ROOT, 'electron/authConfig.local.json'))],
    ['electron/generated/authConfig.generated.json', readJson(join(ROOT, 'electron/generated/authConfig.generated.json'))],
  ].filter(([, cfg]) => String(cfg?.postflowxAuthApiUrl || '').trim());

  assert.deepEqual(
    available.map(([f]) => f),
    [],
    'authConfig.json has an empty postflowxAuthApiUrl while a real one is available here. ' +
      'Packaging this would ship a build that cannot sign anyone in. Re-run `npm run build:renderer`.',
  );
});

test('the guard that reads this config still exists', () => {
  // Anchored on _isPostflowxApiConfigured, not on the login-card wording. The
  // "…not configured for this build." string lives on the Netflix sign-in path,
  // which is in-flight work — a gate that depends on uncommitted text is a gate
  // that breaks for the next person to clone this repo.
  const ipc = readFileSync(join(ROOT, 'electron/ipc.js'), 'utf8');
  assert.match(
    ipc,
    /function _isPostflowxApiConfigured\(\)/,
    'the guard is gone; nothing now checks whether the access-policy URL survived the build',
  );
  assert.match(ipc, /_getPostflowxAuthApiUrl\(\)/);
  assert.equal(existsSync(join(ROOT, 'tools/authConfigInherit.js')), true);
});
