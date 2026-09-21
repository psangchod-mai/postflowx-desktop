// Companion HTTP auth helpers. Run: node tests-js/companionAuth.test.mjs
import { tokenizeCompanionUrl, companionAuthHeaders } from '../src/scripts/modules/companionAuth.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

// tokenizeCompanionUrl — appends ?token= when the URL has no query string.
ok(tokenizeCompanionUrl('http://127.0.0.1:9999/frame/0.jpg', 'abc') === 'http://127.0.0.1:9999/frame/0.jpg?token=abc',
  'adds ?token= to a URL with no query');

// Uses & when a query string already exists.
ok(tokenizeCompanionUrl('http://h/f.jpg?w=640', 'abc') === 'http://h/f.jpg?w=640&token=abc',
  'adds &token= when a query string exists');

// Idempotent — never double-adds a token.
ok(tokenizeCompanionUrl('http://h/f.jpg?token=abc', 'xyz') === 'http://h/f.jpg?token=abc',
  'does not double-add when token= already present');

// Token is URL-encoded.
ok(tokenizeCompanionUrl('http://h/f.jpg', 'a b/c+d') === `http://h/f.jpg?token=${encodeURIComponent('a b/c+d')}`,
  'token is URL-encoded');

// Token is inserted before a URL fragment, not buried inside it.
ok(tokenizeCompanionUrl('http://x/frame?f=10#seg', 'T') === 'http://x/frame?f=10&token=T#seg',
  'inserts &token= before the #fragment');
ok(tokenizeCompanionUrl('http://x/frame#seg', 'T') === 'http://x/frame?token=T#seg',
  'inserts ?token= before the #fragment when no query');

// A 'token=' living only in the fragment is NOT treated as already tokenized.
ok(tokenizeCompanionUrl('http://x/frame#token=fake', 'T') === 'http://x/frame?token=T#token=fake',
  'fragment token= does not trip the idempotency guard');

// No token or no URL → unchanged.
ok(tokenizeCompanionUrl('http://h/f.jpg', '') === 'http://h/f.jpg', 'no token → url unchanged');
ok(tokenizeCompanionUrl('', 'abc') === '', 'no url → unchanged');

// companionAuthHeaders — adds X-PFX-Token and preserves caller headers.
{
  const h = companionAuthHeaders('abc', { Accept: 'image/jpeg' });
  ok(h['X-PFX-Token'] === 'abc' && h.Accept === 'image/jpeg', 'adds X-PFX-Token, keeps caller headers');
}
// No token → no X-PFX-Token header, base preserved.
{
  const h = companionAuthHeaders('', { Accept: 'image/jpeg' });
  ok(!('X-PFX-Token' in h) && h.Accept === 'image/jpeg', 'no token → no auth header, base intact');
}
// Undefined base is safe.
ok(companionAuthHeaders('abc')['X-PFX-Token'] === 'abc', 'undefined base headers is safe');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
