'use strict';

/**
 * authConfigInherit — precedence for build-time auth values that must never be
 * erased by a build that simply wasn't told about them.
 *
 * WHY THIS EXISTS
 * build-renderer.js used to resolve two credentials like this:
 *
 *     const apiUrl = (process.env.POSTFLOWX_AUTH_API_URL || '').trim();
 *
 * Read as a default that looks harmless: "no env var, no value." But this file
 * is then written over `authConfig.json`, which electron-builder packages as
 * `Resources/authConfig.json` — the one file the packaged main process reads to
 * find the access-policy service. So "no env var" did not mean "leave it
 * unset". It meant *delete the working URL that was already there*.
 *
 * The result was a packaged app that met every user with
 *
 *     PostFlowX access policy service is not configured for this build.
 *
 * after nothing more hostile than a routine `npm run build:renderer`. Nothing
 * failed at build time; the build reported success.
 *
 * THE RULE
 * An absent environment variable is not an instruction to erase. Take the first
 * source that actually has a value: the build environment, then whatever the
 * last build baked in, then the developer's local config. Only a value that no
 * source has ever supplied resolves to empty.
 *
 * WHAT MUST NOT USE THIS
 * `devAuthBypass`. Defaulting it to false is a safety property, not an
 * oversight — inheriting a `true` from a developer's machine would ship a build
 * that signs everyone in as "Local Dev".
 */

/**
 * @param {Array<{source: string, value: unknown}>} candidates
 *   Ordered highest-priority first. `value` may be undefined/null.
 * @returns {{value: string, source: string}}
 *   The first non-blank value and where it came from, or `''`/`'unset'`.
 */
function resolveInherited(candidates) {
  for (const candidate of candidates || []) {
    if (!candidate) continue;
    const value = String(candidate.value == null ? '' : candidate.value).trim();
    if (value) return { value, source: candidate.source };
  }
  return { value: '', source: 'unset' };
}

module.exports = { resolveInherited };
