import assert from 'node:assert/strict';
import path from 'node:path';
import {
  assertPackagedAppNotRunning,
  findRunningPackagedApps,
} from '../tools/assert-packaged-app-not-running.mjs';

const root = '/Users/test/PostFlowX_Desktop';
const running = [
  `101 ${path.join(root, 'dist/mac-arm64/PostFlowX.app/Contents/MacOS/PostFlowX')}`,
  '202 /Applications/Other.app/Contents/MacOS/Other',
].join('\n');

assert.deepEqual(findRunningPackagedApps(running, root), [
  `101 ${path.join(root, 'dist/mac-arm64/PostFlowX.app/Contents/MacOS/PostFlowX')}`,
]);

assert.throws(
  () => assertPackagedAppNotRunning({ processList: running, root }),
  (error) => error?.code === 'PFX_PACKAGED_APP_RUNNING'
    && /Overwriting app\.asar/.test(error.message),
);

assert.deepEqual(
  assertPackagedAppNotRunning({
    processList: '303 /Applications/PostFlowX.app/Contents/MacOS/PostFlowX',
    root,
  }),
  { ok: true, matches: [] },
);

console.log('package while running guard tests passed');
