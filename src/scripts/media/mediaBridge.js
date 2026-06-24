// scripts/media/mediaBridge.js
// Native Messaging bridge for the shared media runtime.
// Routes all media commands through background.js via IMF_COMPANION_CALL.
// Tabs never talk to the native helper directly.

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Send a media action to the companion via the background bridge.
 * @param {string} action     - companion action name (e.g. 'mediaOpenFile')
 * @param {Object} payload    - additional parameters
 * @param {number} timeoutMs  - override default 30 s timeout
 * @returns {Promise<Object>} - resolved data on ok; throws on error/timeout
 */
export function sendMediaCommand(action, payload = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject({ code: 'timeout', message: `Media command '${action}' timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    chrome.runtime.sendMessage(
      {
        type: 'IMF_COMPANION_CALL',
        payload: { action, ...payload },
        timeoutMs,
      },
      (res) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject({ code: 'helper_not_installed', message: chrome.runtime.lastError.message });
          return;
        }
        if (!res?.ok) {
          const err = res?.error || res?.response?.error || {};
          reject({
            code:    err.code    || 'backend_not_available',
            message: err.message || 'Media command failed',
          });
          return;
        }
        // Unwrap the companion envelope: res.response.data
        resolve(res?.response?.data ?? res?.response ?? {});
      }
    );
  });
}

/**
 * Get the raw companion capabilities (for diagnostics).
 */
export async function getHelperCapabilities() {
  return sendMediaCommand('getCapabilities', {}, 10_000);
}

/**
 * Check whether the companion helper is reachable.
 * @returns {Promise<boolean>}
 */
export async function isHelperReachable() {
  try {
    await sendMediaCommand('ping', {}, 5_000);
    return true;
  } catch {
    return false;
  }
}
