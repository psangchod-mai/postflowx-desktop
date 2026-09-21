import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const backend = 'https://script.google.com/macros/s/AKfycbxhdc-5B2q-YYs_og7BU7fpJHz3VAcGKzDVu422XViMvZndXhy1ytGjTgJmNwKLSXgS/exec';
const boot = fs.readFileSync('src/scripts/auth/boot-guard.js', 'utf8');
const auth = fs.readFileSync('src/scripts/modules/auth.js', 'utf8');
const main = fs.readFileSync('electron/main.js', 'utf8');
const ipc = fs.readFileSync('electron/ipc.js', 'utf8');
const preload = fs.readFileSync('electron/preload.js', 'utf8');
const login = fs.readFileSync('src/scripts/auth/login-ui.js', 'utf8');
const index = fs.readFileSync('src/index.html', 'utf8');
const styles = fs.readFileSync('src/styles/main.css', 'utf8');

assert.match(boot, new RegExp(backend.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(auth, new RegExp(backend.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.ok(!boot.includes("token: 'awaiting-google-signin'"), 'desktop must not mint an awaiting-sign-in admin session');
assert.ok(!boot.includes('_needsSignIn: true'), 'desktop must stop before boot when no session exists');
assert.match(boot, /true boot gate/i);
assert.match(main, /https:\/\/script\.google\.com/);
assert.match(ipc, /pfx:policy-request/);
for (const route of ['requestLink', 'checkLink', 'featureFlags', 'annotateCatalog', 'annotateTrack']) {
  assert.match(ipc, new RegExp(`['"]${route}['"]`),
    `Electron policy proxy must allow the ${route} route used by policyApi.js`);
}
assert.match(preload, /policyRequest/);
assert.match(boot, /result\.source !== 'remote'/);
assert.match(boot, /result\?\.policy\?\.status === 'expired'/,
  'an explicit expired policy must clear access rather than reuse cached permissions');

const flow = fs.readFileSync('src/scripts/auth/bootPolicyFlow.js', 'utf8');
assert.match(flow, /status === 'pending' \|\| status === 'disabled' \|\| status === 'expired'/,
  'boot policy flow must never fall back to an allow cache after an explicit expiry');

const backendSource = fs.readFileSync('apps-script/auth-access/PfxAuthAccess.gs', 'utf8');
assert.match(backendSource, /res\.status === 'active' && res\.expiresAt && pfxAuthIsExpired_\(res\.expiresAt\)/,
  'the source policy backend must enforce expires_at even when a row is still marked active');
assert.match(backendSource, /status: 'expired', error: 'account_expired'/,
  'authenticated session creation must return an explicit expired decision');
assert.match(auth, /async function recheckAccess\(\)/,
  'auth must expose a server-backed access recheck for an existing identity');
assert.match(auth, /result\?\.ok && result\.policy && result\.source === 'remote'/,
  'recheck must not unlock from a stale policy cache');
assert.match(auth, /recheckAccess,/,
  'recheck must be part of the public PFX_AUTH API');
assert.match(boot, /storedToken === 'dev-bypass' \|\| storedEmail === 'local-dev@postflowx\.local'/,
  'a packaged build must evict a synthetic development identity before policy lookup');
assert.match(boot, /window\.PFX_SESSION_STORE\?\.clear\(\);[\s\S]*?await _clear\(\);[\s\S]*?development_session_removed/,
  'development-session eviction must clear both desktop and renderer persistence');
assert.match(auth, /token === 'dev-bypass' \|\| email === 'local-dev@postflowx\.local'[\s\S]*?await _pfxClear\(\);[\s\S]*?needs_sign_in/,
  'access recheck must discard a synthetic development identity instead of reusing it');
assert.match(login, /id="pfx-recheck-btn"/,
  'denied screen must offer Check access again');
assert.match(login, /PFX_AUTH\?\.recheckAccess\?\.\(\)/,
  'denied screen must run the authenticated policy recheck');
assert.match(login, /_startDeniedRecheckPolling\(\)/,
  'denied screen must recheck automatically while it remains visible');

// The full workspace must not remain visible or exposed to assistive
// technology behind the login/denied overlay. Source starts closed and only
// login-ui may open it after boot-guard returns an approved remote policy.
assert.match(index, /data-pfx-auth-state="checking"/,
  'the document must start with the application shell closed');
assert.match(styles, /html:not\(\[data-pfx-auth-state="granted"\]\) #appViewport\s*\{[\s\S]*?display:\s*none\s*!important/,
  'the workspace shell must stay out of layout and the accessibility tree until access is granted');
assert.match(login, /function _setAuthState\(state\)/,
  'login UI must own the document-level auth state');
assert.match(login, /function showChecking[\s\S]*?_setAuthState\('checking'\)/,
  'a visible checking state must keep the workspace closed during remote policy validation');
assert.match(boot, /DOMContentLoaded[\s\S]*?_showCheckingUI/,
  'boot guard must show immediate protected feedback instead of a blank window');
assert.match(login, /function showLogin[\s\S]*?_setAuthState\('login'\)/,
  'login state must keep the workspace shell closed');
assert.match(login, /function showDenied[\s\S]*?_setAuthState\('denied'\)/,
  'denied state must keep the workspace shell closed');
assert.match(login, /function showExpired[\s\S]*?_setAuthState\('expired'\)/,
  'expired state must keep the workspace shell closed');
assert.match(login, /function hide\(\)[\s\S]*?_setAuthState\('granted'\)/,
  'only the successful overlay hide path may reveal the workspace shell');

const negativeStart = boot.indexOf('// Explicit negative from the backend');
const negativeEnd = boot.indexOf('// Fresh valid policy', negativeStart);
const negativeBlock = boot.slice(negativeStart, negativeEnd);
assert.ok(!negativeBlock.includes('PFX_SESSION_STORE?.clear()'),
  'a temporary denied state must retain the verified identity for recheck');
assert.ok(!negativeBlock.includes('PFX_AUTH?.signOut'),
  'a temporary denied state must not force account switching');

// Exercise the real boot policy flow, not only its source shape. An explicit
// expiry is an authoritative admin decision and must win over an older allow
// cache, while a genuine transport outage may still use that cache.
function loadPolicyFlow({ remote, cached = null }) {
  let cacheReads = 0;
  const events = [];
  const testWindow = {
    pfxPolicyApi: {
      licenseCheck: async () => remote,
      logEvent: event => events.push(event),
    },
    pfxPolicyCache: {
      getPolicy: async () => { cacheReads += 1; return cached; },
      setPolicy: async () => {},
    },
  };
  const context = vm.createContext({
    window: testWindow,
    navigator: { language: 'en-US' },
    Intl,
    setTimeout,
    Promise,
  });
  vm.runInContext(flow, context, { filename: 'bootPolicyFlow.js' });
  return { flow: testWindow.pfxBootPolicyFlow, cacheReads: () => cacheReads, events };
}

const cachedAllow = { ok: true, status: 'active', allowedTabs: ['*'] };
const expiredHarness = loadPolicyFlow({
  remote: { ok: false, status: 'expired' },
  cached: cachedAllow,
});
const expiredResult = await expiredHarness.flow.run({ email: 'editor@example.test' });
assert.equal(expiredResult.ok, false);
assert.equal(expiredResult.source, 'denied');
assert.equal(expiredResult.policy.status, 'expired');
assert.equal(expiredHarness.cacheReads(), 0,
  'expiry must stop before policy cache lookup');
assert.equal(expiredHarness.events[0]?.event, 'boot_denied');

const outageHarness = loadPolicyFlow({ remote: null, cached: cachedAllow });
const outageResult = await outageHarness.flow.run({ email: 'editor@example.test' });
assert.equal(outageResult.ok, true);
assert.equal(outageResult.source, 'cache');
assert.equal(outageHarness.cacheReads(), 1);
console.log('direct access-control wiring tests passed');
