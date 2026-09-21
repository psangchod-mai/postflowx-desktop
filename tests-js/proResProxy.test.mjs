// ProRes proxy cache-key logic. Run: node tests-js/proResProxy.test.mjs
// Polyfill localStorage (module touches settings on import in some paths).
globalThis.localStorage = (() => { const m = new Map();
  return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)),
           removeItem: k => m.delete(k), clear: () => m.clear() }; })();

const { getProxyCacheKey, getCachedProxyForFile } =
  await import('../src/scripts/modules/proResProxy.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

// ── getProxyCacheKey: name(lowercased)|size|lastModified| (MIME intentionally excluded) ──
eq(getProxyCacheKey({ name: 'A001.MOV', size: 100, lastModified: 5, type: 'video/quicktime' }),
   'a001.mov|100|5|', 'key = lowercased name|size|lastModified|trailing-pipe');
// Cross-session stability: the SAME file must key identically regardless of MIME
// (empty on some platforms, video/quicktime on others) — the documented guarantee.
eq(getProxyCacheKey({ name: 'A001.mov', size: 100, lastModified: 5, type: '' }),
   getProxyCacheKey({ name: 'A001.mov', size: 100, lastModified: 5, type: 'video/quicktime' }),
   'same file, different MIME → same key');
// Distinct files key differently
ok(getProxyCacheKey({ name: 'A.mov', size: 100, lastModified: 5 }) !==
   getProxyCacheKey({ name: 'A.mov', size: 101, lastModified: 5 }), 'size change → different key');
ok(getProxyCacheKey({ name: 'A.mov', size: 100, lastModified: 5 }) !==
   getProxyCacheKey({ name: 'B.mov', size: 100, lastModified: 5 }), 'name change → different key');
// Field aliases + defaults
eq(getProxyCacheKey({ fileName: 'C.mov', size: 9 }), 'c.mov|9|0|', 'fileName alias + lastModified default 0');
eq(getProxyCacheKey(null), '', 'null → empty key');
eq(getProxyCacheKey({}), '', 'empty object (no identity) → empty key');

// ── getCachedProxyForFile: nothing cached → null (no throw) ──
eq(getCachedProxyForFile({ name: 'Nope.mov', size: 1, lastModified: 1 }), null, 'uncached file → null');
eq(getCachedProxyForFile(null), null, 'null → null');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
