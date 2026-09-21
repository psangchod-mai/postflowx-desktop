// Shared media cache (blob-URL reuse + refcount). Run: node tests-js/mediaCache.test.mjs
// Polyfill URL object-url methods (Node lacks them) so the cache logic is testable.
let _urlSeq = 0; const _created = []; const _revoked = [];
URL.createObjectURL = (f) => { const u = `blob:pfx/${_urlSeq++}`; _created.push(u); return u; };
URL.revokeObjectURL = (u) => { _revoked.push(u); };

const {
  pfxFileSig, pfxAcquireObjectUrl, pfxReleaseObjectUrl,
  pfxPeekObjectUrl, pfxClearMediaCache, pfxGetHandleFile,
} = await import('../src/scripts/core/mediaCache.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

const file = (name, size, lm = 0, type = 'video/mxf') => ({ name, size, lastModified: lm, type });

// ── pfxFileSig ──
eq(pfxFileSig(file('A.mxf', 100, 5, 'video/mxf')), 'A.mxf::100::5::video/mxf', 'sig format');
eq(pfxFileSig(null), '', 'null file → empty sig');
eq(pfxFileSig(file('A.mxf', 100, 5)), pfxFileSig(file('A.mxf', 100, 5)), 'same attrs → same sig');
ok(pfxFileSig(file('A.mxf', 100, 5)) !== pfxFileSig(file('A.mxf', 101, 5)), 'size change → different sig');

// ── acquire dedups by signature + refcounts ──
pfxClearMediaCache();
const f1 = file('A.mxf', 100, 5);
const before = _created.length;
const u1 = pfxAcquireObjectUrl(f1);
ok(u1.startsWith('blob:'), 'acquire returns a blob url');
const u1b = pfxAcquireObjectUrl(file('A.mxf', 100, 5)); // same sig, different object
eq(u1b, u1, 'same signature → same url (dedup)');
eq(_created.length, before + 1, 'createObjectURL called once for the same signature');
const u2 = pfxAcquireObjectUrl(file('B.mxf', 200, 9));
ok(u2 !== u1, 'different file → different url');

// ── peek ──
eq(pfxPeekObjectUrl(file('A.mxf', 100, 5)), u1, 'peek returns cached url');
eq(pfxPeekObjectUrl(file('Z.mxf', 1, 1)), '', 'peek uncached → empty');

// ── release: refcount holds the url until it hits 0; small cache keeps it ──
const revBefore = _revoked.length;
pfxReleaseObjectUrl(u1);  // ref 2 → 1 (acquired twice)
eq(pfxPeekObjectUrl(f1), u1, 'still cached after one release (ref>0)');
eq(_revoked.length, revBefore, 'not revoked while referenced / under cap');
// unknown url → revoked directly
pfxReleaseObjectUrl('blob:not-ours');
ok(_revoked.includes('blob:not-ours'), 'unknown url released → revoked directly');

// ── clear revokes everything ──
const revBeforeClear = _revoked.length;
pfxClearMediaCache();
ok(_revoked.length > revBeforeClear, 'clear revokes outstanding urls');
eq(pfxPeekObjectUrl(f1), '', 'peek empty after clear');

// ── getHandleFile caches handle.getFile() (one call, then cached) ──
let calls = 0;
const fileObj = file('C.mxf', 9);
const handle = { getFile: async () => { calls++; return fileObj; } };
eq(await pfxGetHandleFile(handle), fileObj, 'getHandleFile returns the file');
eq(calls, 1, 'getFile called once');
await pfxGetHandleFile(handle);
eq(calls, 1, 'second call served from cache (no extra getFile)');
await pfxGetHandleFile(handle, { force: true });
eq(calls, 2, 'force:true refetches');
eq(await pfxGetHandleFile(null), null, 'no handle → null');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
