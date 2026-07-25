#!/usr/bin/env node
// tools/run-pytest.mjs — run the companion pytest suite with a Python that has pytest.
//
// `python3 -m pytest` silently fails on a stock macOS box: the Command Line Tools
// python3 has no pytest, so the companion suite was skipped and `build-verify`
// reported a partial pass. This resolves an interpreter in priority order —
// companion/.venv (the project-local env), then $PFX_PYTHON, then the PATH
// interpreters — and verifies pytest is importable before running. If none has
// pytest, it fails loudly with the exact command to create the venv rather than
// letting the gate pass with the Python tests missing.
// Run: node tools/run-pytest.mjs            (runs companion/ pytest -q)
//      node tools/run-pytest.mjs -k imf     (extra args forward to pytest)
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const COMPANION = join(ROOT, 'companion');
const VENV_PY = join(COMPANION, '.venv', 'bin', 'python');

// Priority: project venv → explicit override → PATH. First one with pytest wins.
const CANDIDATES = [VENV_PY, process.env.PFX_PYTHON, 'python3', 'python'].filter(Boolean);

// A candidate is usable only if it exists AND can import pytest.
export function hasPytest(py) {
  const r = spawnSync(py, ['-c', 'import pytest'], { stdio: 'ignore' });
  return r.status === 0;
}

function resolvePython() {
  for (const py of CANDIDATES) {
    // Absolute paths must exist; bare names are resolved by spawn via PATH.
    if (py.includes('/') && !existsSync(py)) continue;
    if (hasPytest(py)) return py;
  }
  return null;
}

const py = resolvePython();
if (!py) {
  console.error('✗ pytest not found — the companion Python suite cannot run.\n');
  console.error('  Create the project-local env once:\n');
  console.error('    python3 -m venv companion/.venv');
  console.error('    companion/.venv/bin/pip install pytest\n');
  console.error('  Or point PFX_PYTHON at an interpreter that has pytest.');
  process.exit(1);
}

const args = process.argv.slice(2);
const r = spawnSync(py, ['-m', 'pytest', ...(args.length ? args : ['-q'])], {
  cwd: COMPANION,
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
