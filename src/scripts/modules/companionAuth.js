// companionAuth.js — companion HTTP auth helpers (pure, unit-testable).
//
// The companion's local HTTP server is token-gated. Frame/thumbnail URLs must
// carry the token (as a ?token= query param and/or an X-PFX-Token header) or
// they 403 — which previously surfaced as a silent black preview pane. These
// pure helpers centralise that so every fetch path authenticates the same way.
'use strict';

/** Append ?token= to a companion URL (idempotent; no-op without url/token). */
export function tokenizeCompanionUrl(url, token) {
  if (!url || !token) return url;
  if (/[?&]token=/.test(url)) return url;           // already tokenized
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/** Header object carrying the companion token, merged onto any caller headers. */
export function companionAuthHeaders(token, base = {}) {
  const headers = { ...(base || {}) };
  if (token) headers['X-PFX-Token'] = token;
  return headers;
}
