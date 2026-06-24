// scripts/auth/policyApi.js
// Apps Script endpoint wrappers for the PostFlowX policy service.
// All functions return null on network failure (caller decides fail-closed logic).

(function () {
  'use strict';

  function _backendUrl() {
    return window.__PFX_BACKEND_URL || '';
  }

  function _isAppsScript(url) {
    return url.includes('script.google.com');
  }

  function _getUrl(path, params) {
    const base = _backendUrl();
    if (!base) return null;
    const qs = new URLSearchParams(params || {});
    if (_isAppsScript(base)) {
      qs.set('path', path);
      return `${base}?${qs.toString()}`;
    }
    const qStr = qs.toString();
    return `${base}/${path}${qStr ? '?' + qStr : ''}`;
  }

  // Keep a bounded timeout so boot does not hang indefinitely, but allow enough
  // headroom for Apps Script cold starts that commonly take just over 5 seconds.
  const FETCH_TIMEOUT_MS = 8000;
  function _fetchWithTimeout(url, options) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  }

  async function _post(path, body) {
    const url = _getUrl(path);
    if (!url) return null;
    try {
      const res = await _fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      return await res.json().catch(() => null);
    } catch { return null; }
  }

  async function _get(path, params) {
    const url = _getUrl(path, params);
    if (!url) return null;
    try {
      const res = await _fetchWithTimeout(url);
      if (!res.ok) return null;
      return await res.json().catch(() => null);
    } catch { return null; }
  }

  /**
   * Register a new user or update last_seen_at for a known user.
   * Called on every boot. Returns { ok, registered, status } or null on error.
   */
  async function registerOrPingUser({ email, name, locale, timezone, country, countrySource, version }) {
    return _post('registerOrPingUser', { email, name, locale, timezone, country, countrySource, version });
  }

  /**
   * Fetch the current policy for a user.
   * Accepts pfxToken (stored session token) or email (first-boot fallback).
   * Returns { ok, status, role, allowedTabs, allowedActions, featureFlags, expiresAt } or null.
   */
  async function licenseCheck({ pfxToken, email } = {}) {
    const params = {};
    if (pfxToken) params.token = pfxToken;
    if (email)    params.email = email;
    return _get('licenseCheck', params);
  }

  /**
   * Returns { ok, latestVersion, minimumVersion, downloadUrl, notes } or null.
   * No auth required.
   */
  async function versionManifest() {
    return _get('versionManifest');
  }

  /**
   * Returns { ok, featureFlags } for an authenticated user or null.
   */
  async function featureFlags(pfxToken) {
    return _get('featureFlags', pfxToken ? { token: pfxToken } : {});
  }

  /**
   * Returns { ok, providers } for protected Annotate tracking sources.
   */
  async function annotateCatalog(pfxToken) {
    return _get('annotateCatalog', pfxToken ? { token: pfxToken } : {});
  }

  /**
   * Proxy an Annotate tracking request through the backend so upstream provider
   * URLs and API keys stay server-side.
   */
  async function annotateTrackProxy({ providerId, payload, pfxToken } = {}) {
    return _post('annotateTrack', {
      token: pfxToken || '',
      providerId: String(providerId || '').trim(),
      payload: payload && typeof payload === 'object' ? payload : {},
    });
  }

  /**
   * Fire-and-forget structured event log.
   * @param {object} event — { email, event, details, version, tab, action }
   */
  async function logEvent(event) {
    _post('logEvent', event).catch(() => {});
  }

  window.pfxPolicyApi = {
    registerOrPingUser,
    licenseCheck,
    versionManifest,
    featureFlags,
    annotateCatalog,
    annotateTrackProxy,
    logEvent,
  };
})();
