import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const config = JSON.parse(read('authConfig.json'));
assert.equal(config.meechumClientId, 'postflowx-desktop-test');
assert.equal(config.meechumIssuer, 'https://meechum.prod.netflix.net/');
assert.equal(config.meechumRedirectUri, 'https://postflowx.netflix.net/oauth2/callback');
assert.equal(config.meechumScopes, 'openid profile default');
assert.equal(config.meechumAuthStrategy, 'NetflixPartnerLogin');
assert.equal(config.meechumLoopbackRedirects, true);
assert.equal(Object.hasOwn(config, 'meechumClientSecret'), false, 'client secret must not be bundled');

const builder = read('build-renderer.js');
assert.match(builder, /POSTFLOWX_MEECHUM_CLIENT_ID/);
assert.match(builder, /meechumRedirectUri/);
assert.match(builder, /POSTFLOWX_MEECHUM_AUTH_STRATEGY/);   // partner login knob
assert.match(builder, /meechumAuthStrategy/);
assert.doesNotMatch(builder, /meechumClientSecret/);

const ipc = read('electron/ipc.js');
assert.match(ipc, /pfx:meechum-oauth/);
assert.match(ipc, /code_challenge_method: 'S256'/);
assert.match(ipc, /authParams\.auth_strategy = cfg\.authStrategy/);   // partner strategy hint
assert.match(ipc, /partnerLoginEnabled/);
assert.match(ipc, /shell\.openExternal\(authorizationUrl\)/);
// Automatic path: FIXED loopback ports (Edward exact-matches incl. port), captured
// by a local server — like Netflix Team Workspaces.
assert.match(ipc, /MEE_LOOPBACK_PORTS = \[51900, 8477, 8478, 8479\]/); // Edward-registered primary + fallbacks
assert.match(ipc, /server\.listen\(p, '127\.0\.0\.1'/);           // Meechum fixed-port bind (not ephemeral)
assert.match(ipc, /const redirectUri = `http:\/\/127\.0\.0\.1:\$\{port\}\/oauth2\/callback`/);
assert.match(ipc, /u\.pathname !== '\/oauth2\/callback'/);         // callback path guard
// Dual method: seamless loopback + a paste fallback on the already-registered
// HTTPS redirect (works before Edward has the loopback URLs).
assert.match(ipc, /Paste callback URL/);                           // fallback present
assert.match(ipc, /const httpsRedirect = cfg\.redirectUri/);       // registered HTTPS fallback redirect
assert.match(ipc, /const pick = cfg\.loopbackRedirects/);          // never send an unregistered loopback callback by default
assert.match(ipc, /redirectUri: usedRedirect/);                    // exchange reuses the redirect actually used
assert.match(ipc, /auth\/meechum/);
assert.match(ipc, /return _runMeechumSystemBrowserOAuth\(_activeWindow, cfg\)/);
// Primary desktop path mirrors Netflix Team Workspaces with nflx-access-managed
// client certificates, while keeping PostFlowX credentials in its own userData.
assert.match(ipc, /Netflix Team Workspaces\.app\/Contents\/Resources\/app\.asar\/node_modules\/nflx-access/);
assert.match(ipc, /app\.getPath\('userData'\), 'nflxaccess'/);
assert.match(ipc, /await nflxAccess\.getCredentialsInfo\(certsPath\)/);
assert.match(ipc, /await nflxAccess\.renewCredentials/);
assert.match(ipc, /authUrlCallback: \(\) => true/);
assert.match(ipc, /workspaceResult = await _runTeamWorkspacesAuthentication\(\)/);

// Partner-enabled builds must not reuse the certificate shortcut because that
// path derives @netflix.com from process.env.USER and cannot identify the
// authenticated Pandora account. Browser OAuth returns verified Meechum
// userinfo and must be selected before the workforce-only shortcut.
const oauthHandlerStart = ipc.indexOf("ipcMain.handle('pfx:meechum-oauth'");
const oauthHandlerEnd = ipc.indexOf("ipcMain.handle('pfx:google-oauth'", oauthHandlerStart);
const oauthHandler = ipc.slice(oauthHandlerStart, oauthHandlerEnd);
assert.ok(oauthHandlerStart >= 0 && oauthHandlerEnd > oauthHandlerStart, 'Meechum handler must exist');
assert.match(oauthHandler, /const partnerLoginEnabled = \/partner\/i\.test\(cfg\.authStrategy \|\| ''\)/);
assert.ok(
  oauthHandler.indexOf('if (partnerLoginEnabled)') < oauthHandler.indexOf('workspaceResult = await _runTeamWorkspacesAuthentication()'),
  'partner routing must run before the Team Workspaces certificate shortcut',
);
assert.match(
  oauthHandler,
  /if \(partnerLoginEnabled\) \{[\s\S]*?return _runMeechumSystemBrowserOAuth\(_activeWindow, cfg\);[\s\S]*?\}/,
);

const backend = read('apps-script/auth-access/PfxAuthAccess.gs');
assert.match(backend, /case 'auth\/meechum'/);
assert.match(backend, /PFX_MEECHUM_CLIENT_SECRET/);
assert.match(backend, /code_verifier: verifier/);
assert.match(backend, /pfxAuthResolveAccess_\(email\)/);
// Backend accepts a loopback callback and reuses the app-provided redirect in the
// token exchange (so the Automatic/loopback flow works, not just the HTTPS paste).
assert.match(backend, /var isLoopback =/);
assert.match(backend, /configuredRedirect/);
assert.match(backend, /127\.0\.0\.1/);   // loopback host referenced in the guard

const preload = read('electron/preload.js');
assert.match(preload, /enterpriseSignIn/);
assert.match(preload, /isEnterpriseAuthConfigured/);

const auth = read('src/scripts/modules/auth.js');
assert.match(auth, /async function signInWithEnterprise/);
assert.match(auth, /init, ready, signInWithEnterprise, signInWithGoogle/);

const login = read('src/scripts/auth/login-ui.js');
assert.match(login, /Netflix \/ Partner/);
assert.match(login, /Continue with Netflix/);
assert.match(login, /PFX_AUTH\?\.signInWithEnterprise/);
assert.match(login, /const HTML_LANG = Object\.freeze\(\{/);
assert.match(login, /ph: 'fil'/);
assert.match(login, /tw: 'zh-Hant'/);
assert.match(login, /root\.lang = HTML_LANG\[lang\] \|\| HTML_LANG\.eng/);
assert.match(login, /el\.setAttribute\('role', 'dialog'\)/, 'auth overlay must expose dialog semantics');
assert.match(login, /el\.setAttribute\('aria-modal', 'true'\)/, 'auth overlay must remain modal to assistive technology');
assert.match(login, /el\.addEventListener\('keydown', _trapOverlayFocus\)/, 'auth overlay must contain keyboard focus');
assert.match(login, /aria-pressed="\$\{l\.code === cur \? 'true' : 'false'\}"/, 'language picker must expose its selected state');
assert.match(login, /aria-label="\$\{_t\('languageLabel'\)\}"/, 'language picker group must use the active language');
assert.match(login, /heading\.focus\(\{ preventScroll: true \}\)/, 'screen changes must announce the new auth heading');
assert.match(login, /_escHtml\(opts\.message\)/, 'login notices from the backend must be rendered as text');
assert.match(login, /toast\.setAttribute\('role', type === 'error' \? 'alert' : 'status'\)/,
  'auth results must be announced without a blocking alert');
assert.match(login, /_showToast\(_t\('requestSent'\), 'success'\)/);
assert.match(login, /_showToast\(_t\('requestFailed'\), 'error'\)/);
for (const [locale, nextLocale] of [
  ['th', 'id'], ['id', 'ph'], ['ph', 'tw'], ['tw', 'kr'], ['kr', 'jp'], ['jp', null],
]) {
  const start = login.indexOf(`    ${locale}: {`);
  const end = nextLocale ? login.indexOf(`    ${nextLocale}: {`, start) : login.indexOf('\n  };', start);
  const block = login.slice(start, end);
  assert.ok(start >= 0 && end > start, `${locale} login locale block must exist`);
  assert.match(block, /enterpriseSigninBtn:/, `${locale} must localize the Netflix sign-in button`);
  assert.match(block, /enterpriseMethod:/, `${locale} must localize the enterprise method label`);
  assert.match(block, /enterpriseIntro:/, `${locale} must localize the Meechum explanation`);
  assert.match(block, /authUnavailable:/, `${locale} must localize unavailable sign-in guidance`);
  assert.match(block, /authNotConfigured:/, `${locale} must localize missing configuration guidance`);
  assert.match(block, /requestSent:/, `${locale} must localize access-request confirmation`);
  assert.match(block, /requestFailed:/, `${locale} must localize access-request failure`);
  assert.match(block, /languageLabel:/, `${locale} must localize the language-picker label`);
}

console.log('meechum auth wiring tests passed');
