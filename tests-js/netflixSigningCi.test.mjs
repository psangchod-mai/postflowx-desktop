import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Netflix shared-builder release is main-only and verifies the mounted DMG', () => {
  const ciPath = path.join(root, '.netflix', 'netflix.ci');
  const ci = fs.readFileSync(ciPath, 'utf8');
  const rocket = fs.readFileSync(path.join(root, '.netflix', 'rocket.yml'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  assert.match(rocket, /label: "macos_arm64_aws && nf\.app:sct_macbuilders"/);
  assert.match(ci, /^#!\/bin\/bash\nset -euo pipefail/m);
  assert.doesNotMatch(ci, /set -x/);
  assert.match(ci, /ROCKET_EVENT_TYPE:-.*PR/);
  assert.match(ci, /ROCKET_BRANCH:-.*main/);
  assert.match(ci, /Jenkins credential NOTARIZE_APPLE_ID is required/);
  assert.match(ci, /Jenkins credential NOTARIZE_APP_PASSWORD is required/);
  assert.match(ci, /update-keychain/);
  assert.match(ci, /Developer ID Application: Netflix, Inc\. \(EZ4M4LKSQP\)/);
  assert.match(ci, /APPLE_APP_SPECIFIC_PASSWORD=/);
  assert.match(ci, /local exit_status="\$1"/);
  assert.match(ci, /cleanup_release_state "\$\?"/);
  assert.match(ci, /trap - EXIT/);
  assert.match(ci, /exit "\$exit_status"/);
  assert.match(ci, /notarytool submit/);
  assert.match(ci, /stapler staple/);
  assert.match(ci, /hdiutil attach -readonly/);
  assert.match(ci, /app\.asar/);
  assert.match(ci, /lipo -archs/);
  assert.match(ci, /spctl --assess/);
  assert.equal(pkg.build.mac.hardenedRuntime, true);
  assert.equal(pkg.build.mac.notarize, true);
  assert.equal(fs.statSync(ciPath).mode & 0o100, 0o100);
});
