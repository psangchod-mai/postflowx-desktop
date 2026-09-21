// Renderer data-integrity tests — exercises the REAL safeFile.js against an
// in-memory FileSystemDirectoryHandle mock. Run: node tests-js/safeFile.test.mjs
import { safeWriteText, safeReadJSON, readTextIfExists, BAK_SUFFIX } from '../src/scripts/core/safeFile.js';

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('PASS -', label); }
  else { failed++; console.error('FAIL -', label); }
}
async function throws(fn, label) {
  try { await fn(); failed++; console.error('FAIL -', label, '(did not throw)'); }
  catch { passed++; console.log('PASS -', label); }
}

// In-memory dir handle. `corrupt` makes close() store a truncated copy to
// simulate a crash/partial flush, so write-verification can be tested.
function makeDir() {
  const files = new Map();
  let corrupt = false;
  const dir = {
    files,
    setCorrupt(v) { corrupt = v; },
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) throw new Error('NotFoundError');
        files.set(name, '');
      }
      return {
        async getFile() {
          if (!files.has(name)) throw new Error('NotFoundError');
          const data = files.get(name);
          return { text: async () => data };
        },
        async createWritable() {
          let buf = '';
          return {
            async write(t) { buf += t; },
            async close() {
              // Corruption models a crash during the PRIMARY write only — the
              // .bak snapshot completes before the crash window, so backups stay
              // intact (as on a real filesystem).
              const doCorrupt = corrupt && !name.endsWith(BAK_SUFFIX);
              files.set(name, doCorrupt ? buf.slice(0, Math.floor(buf.length / 2)) : buf);
            },
          };
        },
      };
    },
  };
  return dir;
}

(async () => {
  // 1. Basic round-trip
  {
    const d = makeDir();
    await safeWriteText(d, 'a.json', JSON.stringify({ v: 1 }));
    const got = await safeReadJSON(d, 'a.json');
    ok(got && got.v === 1, 'write→read round-trip');
  }

  // 2. Overwrite snapshots the prior copy to .bak
  {
    const d = makeDir();
    await safeWriteText(d, 'a.json', JSON.stringify({ v: 1 }));
    await safeWriteText(d, 'a.json', JSON.stringify({ v: 2 }));
    const bak = await readTextIfExists(d, 'a.json' + BAK_SUFFIX);
    ok(bak === JSON.stringify({ v: 1 }), 'overwrite creates .bak with prior content');
    const cur = await safeReadJSON(d, 'a.json');
    ok(cur.v === 2, 'primary holds latest content after overwrite');
  }

  // 3. Read falls back to .bak when the primary is corrupted
  {
    const d = makeDir();
    await safeWriteText(d, 'a.json', JSON.stringify({ v: 1 }));
    await safeWriteText(d, 'a.json', JSON.stringify({ v: 2 })); // .bak = v1
    d.files.set('a.json', '{ this is : not json'); // corrupt the primary out-of-band
    const got = await safeReadJSON(d, 'a.json');
    ok(got && got.v === 1, 'read recovers from .bak when primary is corrupt');
  }

  // 4. A corrupt/partial WRITE is detected, throws, and restores the prior good copy
  {
    const d = makeDir();
    await safeWriteText(d, 'a.json', JSON.stringify({ v: 1, keep: 'me' })); // good v1
    d.setCorrupt(true); // next close() truncates → simulates crash mid-write
    await throws(() => safeWriteText(d, 'a.json', JSON.stringify({ v: 2 })),
      'corrupt write is detected and throws (no false success)');
    d.setCorrupt(false);
    const recovered = await safeReadJSON(d, 'a.json');
    ok(recovered && recovered.v === 1 && recovered.keep === 'me',
      'after a failed write, the previous good data is intact');
  }

  // 5. Missing file with no backup → null (not a throw)
  {
    const d = makeDir();
    const got = await safeReadJSON(d, 'nope.json');
    ok(got === null, 'missing file with no backup returns null');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
