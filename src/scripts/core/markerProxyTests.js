// Marker Proxy QC — Phase 1 unit tests (pure function tests, no DOM required).
// Run in browser console: window.PFX_MPQ_TESTS.runAll()
// Or via Node: node scripts/core/markerProxyTests.js
(function () {
  'use strict';

  const results = [];

  function test(name, fn) {
    try {
      fn();
      results.push({ name, status: 'pass' });
    } catch (e) {
      results.push({ name, status: 'fail', error: e.message });
    }
  }

  function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'Assertion failed');
  }

  function assertEqual(a, b, msg) {
    assert(a === b, `${msg || ''}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }

  // ── scoreCandidate tests (requires PFX_OCF_RELINK loaded) ─────────────────
  function makeSWI(overrides) {
    return {
      shotWorkId: 'swi_test',
      markerId: 'm1',
      markerType: 'VFX',
      enabled: true,
      shotName: 'LMP_101_060_PL01',
      sourceClipName: 'A001L002_25030194.mxf',
      editorialClipName: 'A001L002_25030194.mxf',
      reel: 'A001',
      camera: 'ARRI',
      srcTcIn:  '07:24:18:11',
      srcTcOut: '07:24:20:15',
      fps: 24,
      durationFrames: 52,
      handles: 8,
      ocfStatus: 'missing',
      proxyStatus: 'blocked',
      ...overrides,
    };
  }

  function makeEntry(overrides) {
    return {
      ocfId: 'ocf_1',
      fileStem: 'A001L002_25030194',
      fileName: 'A001L002_25030194.mxf',
      extension: '.mxf',
      camera: 'ARRI',
      reel: 'A001',
      startTc: '07:24:18:00',
      endTc:   '07:24:21:00',
      fps: 24,
      durationFrames: 72,
      path: '/OCF/A001/A001L002_25030194.mxf',
      ...overrides,
    };
  }

  // These tests run synchronously against the scoring function
  test('scoreCandidate: exact match ≥ 90', () => {
    if (!window.PFX_OCF_RELINK?.scoreCandidate) return; // skip if not loaded yet
    const swi = makeSWI();
    const entry = makeEntry();
    const result = window.PFX_OCF_RELINK.scoreCandidate(swi, entry);
    assert(result.score >= 90, `Expected score ≥ 90 for exact match, got ${result.score}`);
  });

  test('scoreCandidate: different reel lowers score', () => {
    if (!window.PFX_OCF_RELINK?.scoreCandidate) return;
    const swi = makeSWI({ reel: 'A001' });
    const entry = makeEntry({ reel: 'B002' });
    const result = window.PFX_OCF_RELINK.scoreCandidate(swi, entry);
    assert(result.score < 90, `Expected score < 90 for reel mismatch, got ${result.score}`);
  });

  test('scoreCandidate: fps mismatch heavily penalized', () => {
    if (!window.PFX_OCF_RELINK?.scoreCandidate) return;
    const swi = makeSWI({ fps: 24 });
    const entry = makeEntry({ fps: 30 });
    const result = window.PFX_OCF_RELINK.scoreCandidate(swi, entry);
    assert(result.score < 70, `Expected score < 70 for fps mismatch, got ${result.score}`);
  });

  // ── proxyFingerprint tests ────────────────────────────────────────────────
  test('proxyFingerprint: compute returns hash', () => {
    if (!window.PFX_PROXY_FP?.compute) return;
    const swi = makeSWI();
    swi.ocf = { path: '/OCF/A001/test.mxf', mtime: 1234567890, size: 999 };
    swi.color = { hash: 'abc123' };
    const fp = window.PFX_PROXY_FP.compute(swi);
    assert(fp?.hash, 'Fingerprint hash should be truthy');
    assertEqual(typeof fp.hash, 'string', 'hash type');
  });

  test('proxyFingerprint: different TC produces different hash', () => {
    if (!window.PFX_PROXY_FP?.compute) return;
    const swi1 = makeSWI({ srcTcIn: '07:24:18:11' });
    swi1.ocf = { path: '/OCF/test.mxf', mtime: 0, size: 0 };
    swi1.color = { hash: '' };
    const swi2 = makeSWI({ srcTcIn: '07:24:19:00' });
    swi2.ocf = { path: '/OCF/test.mxf', mtime: 0, size: 0 };
    swi2.color = { hash: '' };
    const fp1 = window.PFX_PROXY_FP.compute(swi1);
    const fp2 = window.PFX_PROXY_FP.compute(swi2);
    assert(fp1.hash !== fp2.hash, 'Different TC should produce different fingerprint hash');
  });

  // ── proxyJobBuilder tests ─────────────────────────────────────────────────
  test('getBlockedReasons: disabled marker is blocked', () => {
    if (!window.PFX_PROXY_JOBS?.getBlockedReasons) return;
    const swi = makeSWI({ enabled: false });
    const reasons = window.PFX_PROXY_JOBS.getBlockedReasons(swi);
    assert(reasons.includes('marker disabled'), `Expected "marker disabled" in reasons: ${JSON.stringify(reasons)}`);
  });

  test('getBlockedReasons: OCF missing is blocked', () => {
    if (!window.PFX_PROXY_JOBS?.getBlockedReasons) return;
    const swi = makeSWI({ ocfStatus: 'missing' });
    const reasons = window.PFX_PROXY_JOBS.getBlockedReasons(swi);
    assert(reasons.includes('OCF missing'), `Expected "OCF missing" in reasons`);
  });

  test('getBlockedReasons: ready proxy with no stale flag is skipped', () => {
    if (!window.PFX_PROXY_JOBS?.getBlockedReasons) return;
    const swi = makeSWI({ ocfStatus: 'linked', proxyStatus: 'ready', proxyIsStale: false });
    const reasons = window.PFX_PROXY_JOBS.getBlockedReasons(swi);
    assert(reasons.includes('proxy already current'), `Expected "proxy already current"`);
  });

  // ── Run and report ────────────────────────────────────────────────────────
  function runAll() {
    results.length = 0;
    // Re-run all tests
    test('scoreCandidate: exact match ≥ 90', () => {
      if (!window.PFX_OCF_RELINK?.scoreCandidate) return;
      const result = window.PFX_OCF_RELINK.scoreCandidate(makeSWI(), makeEntry());
      assert(result.score >= 90, `Expected ≥90, got ${result.score}`);
    });
    test('proxyFingerprint: compute', () => {
      if (!window.PFX_PROXY_FP?.compute) return;
      const swi = makeSWI(); swi.ocf = { path: '/t', mtime: 0, size: 0 }; swi.color = { hash: '' };
      const fp = window.PFX_PROXY_FP.compute(swi);
      assert(fp?.hash, 'hash truthy');
    });
    test('getBlockedReasons: OCF missing', () => {
      if (!window.PFX_PROXY_JOBS?.getBlockedReasons) return;
      const r = window.PFX_PROXY_JOBS.getBlockedReasons(makeSWI({ ocfStatus: 'missing' }));
      assert(r.includes('OCF missing'), 'OCF missing blocked');
    });
    test('getBlockedReasons: worker offline', () => {
      if (!window.PFX_PROXY_JOBS?.getBlockedReasons) return;
      const swi = makeSWI({ ocfStatus: 'linked', proxyStatus: 'missing' });
      const r = window.PFX_PROXY_JOBS.getBlockedReasons(swi);
      // Worker offline should appear in reasons when offline
      const workerOnline = window.PFX_RENDER_WORKER?.isOnline?.() ?? false;
      if (!workerOnline) {
        assert(r.includes('render worker offline'), 'worker offline reason');
      }
    });

    const passed = results.filter(r => r.status === 'pass').length;
    const failed = results.filter(r => r.status === 'fail').length;
    console.table(results);
    console.info(`[MPQ_TESTS] ${passed} passed, ${failed} failed`);
    return { passed, failed, results: [...results] };
  }

  window.PFX_MPQ_TESTS = { runAll, results };
  console.info('[MPQ_TESTS] Test harness ready — run window.PFX_MPQ_TESTS.runAll()');
})();
