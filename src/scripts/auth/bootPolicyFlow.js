// scripts/auth/bootPolicyFlow.js
// Boot-time policy fetch: registerOrPingUser + licenseCheck + cache write.
// Implements fail-closed: if remote and cache both fail, returns a denied result.

(function () {
  'use strict';

  function _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function _licenseCheckWithWarmRetry(licenseCheck, params) {
    let freshPolicy = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        freshPolicy = await licenseCheck(params);
      } catch {}

      if (freshPolicy?.ok) return freshPolicy;

      // A concrete access state should not be retried away.
      if (freshPolicy && !freshPolicy.ok && freshPolicy.status) {
        return freshPolicy;
      }

      if (attempt === 0) {
        // Apps Script often needs one warm-up round-trip on cold start.
        await _delay(700);
      }
    }
    return freshPolicy;
  }

  /**
   * Run the full boot policy flow for a signed-in user.
   *
   * @param {{ email: string, name?: string, pfxToken?: string, version?: string }} opts
   * @returns {Promise<{ ok: boolean, policy: object|null, source: 'remote'|'cache'|'denied' }>}
   */
  async function run(opts = {}) {
    const { email, name, pfxToken, version } = opts;
    const { getPolicy, setPolicy } = window.pfxPolicyCache || {};
    const { registerOrPingUser, licenseCheck, logEvent } = window.pfxPolicyApi || {};

    // ── 1. Register / ping — fire-and-forget, never blocks boot ────────────
    if (registerOrPingUser && email) {
      const locale      = navigator.language || '';
      const timezone    = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      const localeParts = locale.split('-');
      const country     = localeParts.length > 1 ? localeParts[localeParts.length - 1].toUpperCase() : '';
      const countrySource = country ? 'guessed' : '';
      registerOrPingUser({ email, name: name || email, locale, timezone, country, countrySource, version }).catch(() => {});
    }

    // ── 2. Fetch fresh policy from remote ───────────────────────────────────
    if (licenseCheck) {
      const freshPolicy = await _licenseCheckWithWarmRetry(licenseCheck, { pfxToken, email });

      if (freshPolicy?.ok) {
        if (setPolicy) await setPolicy(freshPolicy);
        return { ok: true, policy: freshPolicy, source: 'remote' };
      }

      // Non-ok remote response with a known status → deny early (don't fall back to cache)
      if (freshPolicy && !freshPolicy.ok && freshPolicy.status) {
        const status = freshPolicy.status;
        if (status === 'pending' || status === 'disabled') {
          logEvent?.({ email, event: 'boot_denied', details: { status } });
          return { ok: false, policy: freshPolicy, source: 'denied' };
        }
      }
    }

    // ── 3. Remote failed — try session cache ─────────────────────────────────
    if (getPolicy) {
      const cached = await getPolicy();
      if (cached) {
        return { ok: true, policy: cached, source: 'cache' };
      }
    }

    // ── 4. Both failed → fail closed ─────────────────────────────────────────
    logEvent?.({ email, event: 'boot_fail_closed', details: { reason: 'remote_and_cache_unavailable' } });
    return { ok: false, policy: null, source: 'denied' };
  }

  window.pfxBootPolicyFlow = { run };
})();
