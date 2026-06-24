// scripts/auth/policyCache.js
// Session-scoped policy cache backed by chrome.storage.session.
// TTL: 15 minutes. Fail-closed: getPolicy() returns null when expired or absent.

const POLICY_CACHE_KEY = 'pfx_policyCache_v1';
const POLICY_TTL_MS    = 15 * 60 * 1000; // 15 minutes

/**
 * Persist a policy payload to chrome.storage.session.
 * @param {object} policy — the full licenseCheck response body
 */
async function setPolicy(policy) {
  const entry = {
    policy,
    cachedAt: Date.now(),
    expiresAt: Date.now() + POLICY_TTL_MS,
  };
  await chrome.storage.session.set({ [POLICY_CACHE_KEY]: entry });
}

/**
 * Read back the cached policy.
 * Returns null if absent, expired, or malformed.
 */
async function getPolicy() {
  try {
    const result = await chrome.storage.session.get(POLICY_CACHE_KEY);
    const entry  = result[POLICY_CACHE_KEY];
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) return null;
    return entry.policy || null;
  } catch {
    return null;
  }
}

/** Remove the cached policy immediately (e.g. on logout or forced recheck). */
async function clearPolicy() {
  try {
    await chrome.storage.session.remove(POLICY_CACHE_KEY);
  } catch {}
}

/**
 * Returns true if a non-expired policy is in cache, without reading it.
 * Useful for guarding fast-path checks.
 */
async function isValid() {
  try {
    const result = await chrome.storage.session.get(POLICY_CACHE_KEY);
    const entry  = result[POLICY_CACHE_KEY];
    return !!(entry && Date.now() <= entry.expiresAt);
  } catch {
    return false;
  }
}

window.pfxPolicyCache = { setPolicy, getPolicy, clearPolicy, isValid };
