import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function findRunningPackagedApps(processList, root = repoRoot) {
  const distPrefix = `${path.join(root, 'dist')}${path.sep}`;
  return String(processList || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const command = line.replace(/^\d+\s+/, '');
      return command.includes(distPrefix)
        && command.includes('.app/Contents/MacOS/PostFlowX');
    });
}

export function assertPackagedAppNotRunning({ processList, root = repoRoot } = {}) {
  let currentProcesses = processList;
  if (currentProcesses === undefined) {
    currentProcesses = process.platform === 'darwin'
      ? execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
      : '';
  }

  const matches = findRunningPackagedApps(currentProcesses, root);
  if (!matches.length) return { ok: true, matches: [] };

  const error = new Error([
    'PostFlowX packaging stopped: a packaged app from this dist folder is still running.',
    'Quit that PostFlowX window, then run the package command again.',
    'Overwriting app.asar while Electron is running can produce unstyled HTML and random syntax errors.',
    ...matches.map((line) => `  ${line}`),
  ].join('\n'));
  error.code = 'PFX_PACKAGED_APP_RUNNING';
  error.matches = matches;
  throw error;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    assertPackagedAppNotRunning();
    console.log('PostFlowX package guard passed: no app in this dist folder is running.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
