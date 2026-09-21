'use strict';

const { spawnSync } = require('child_process');

function isAdHocMacSignature(details = '') {
  return /(?:^|\n)Signature=adhoc(?:\n|$)/.test(details)
    || /(?:^|\n)TeamIdentifier=not set(?:\n|$)/.test(details);
}

function shouldUseBasicPasswordStore({
  platform = process.platform,
  env = process.env,
  isPackaged = false,
  execPath = process.execPath,
  runCodesign = spawnSync,
} = {}) {
  if (platform !== 'darwin') return false;

  // A consistently Developer ID-signed production build should keep using the
  // macOS Keychain. This explicit escape hatch is also useful during release QA.
  if (env.POSTFLOWX_USE_MAC_KEYCHAIN === 'true') return false;
  if (env.POSTFLOWX_NO_KEYCHAIN === 'true') return true;

  // Electron development and locally rebuilt apps do not have a stable signing
  // identity. Keychain binds Safe Storage access to that identity, so every
  // rebuild would otherwise ask for the login-keychain password again.
  if (!isPackaged) return true;

  try {
    const result = runCodesign(
      '/usr/bin/codesign',
      ['-dv', '--verbose=4', execPath],
      { encoding: 'utf8' },
    );
    if (result?.error) return false;
    const details = `${result?.stdout || ''}\n${result?.stderr || ''}`;
    return isAdHocMacSignature(details);
  } catch {
    // Fail secure: if the signing state cannot be established, retain Keychain.
    return false;
  }
}

function configureMacPasswordStore(app, options = {}) {
  const useBasic = shouldUseBasicPasswordStore({
    isPackaged: app.isPackaged,
    ...options,
  });
  if (useBasic) app.commandLine.appendSwitch('password-store', 'basic');
  return useBasic;
}

module.exports = {
  configureMacPasswordStore,
  isAdHocMacSignature,
  shouldUseBasicPasswordStore,
};
