import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBackendStatus, buildBackendStatusBadgeHtml, BACKEND_STATUS }
  from '../src/scripts/features/vfxPull/backendStatusBadge.js';

test('READY: real decoded frame', () => {
  const c = classifyBackendStatus({ ok: true, dataUrl: 'data:image/jpeg;base64,xx', decoder: 'Resolve Engine', extractor: 'resolve' });
  assert.equal(c.status, BACKEND_STATUS.READY);
  assert.equal(c.tone, 'ok');
});

test('PREVIEW_ONLY: frame from a proxy/baked path', () => {
  const c = classifyBackendStatus({ ok: true, dataUrl: 'data:...', extractor: 'proxy' });
  assert.equal(c.status, BACKEND_STATUS.PREVIEW_ONLY);
  assert.equal(c.tone, 'warn');
  const c2 = classifyBackendStatus({ ok: true, dataUrl: 'data:...', previewOnly: true });
  assert.equal(c2.status, BACKEND_STATUS.PREVIEW_ONLY);
});

test('SDK_MISSING: camera-RAW needs Resolve which is not available', () => {
  const c = classifyBackendStatus({ ok: false, requiresResolve: true, resolveAvailable: false, decoder: 'Unsupported' });
  assert.equal(c.status, BACKEND_STATUS.SDK_MISSING);
  assert.equal(c.tone, 'warn');
});

test('UNAVAILABLE: engine not running (connect stage)', () => {
  const c = classifyBackendStatus({ ok: false, stage: 'connect', error: 'Resolve Engine is not running.' });
  assert.equal(c.status, BACKEND_STATUS.UNAVAILABLE);
});

test('METADATA_ONLY: metadata read but no frame', () => {
  const c = classifyBackendStatus({ ok: false, metadataOnly: true });
  assert.equal(c.status, BACKEND_STATUS.METADATA_ONLY);
  const c2 = classifyBackendStatus({ ok: false, hasMetadata: true, dataUrl: null });
  assert.equal(c2.status, BACKEND_STATUS.METADATA_ONLY);
});

test('UNAVAILABLE: empty/unknown result', () => {
  assert.equal(classifyBackendStatus().status, BACKEND_STATUS.UNAVAILABLE);
  assert.equal(classifyBackendStatus({ ok: false }).status, BACKEND_STATUS.UNAVAILABLE);
});

test('resolveAvailable defaults true when omitted (requiresResolve alone is not SDK_MISSING)', () => {
  const c = classifyBackendStatus({ ok: false, requiresResolve: true });
  assert.notEqual(c.status, BACKEND_STATUS.SDK_MISSING);
});

test('badge HTML escapes and applies tone class', () => {
  const html = buildBackendStatusBadgeHtml(classifyBackendStatus({ ok: false, requiresResolve: true, resolveAvailable: false }));
  assert.match(html, /SDK missing/);
  assert.match(html, /pfx-backend-warn/);
  // custom toneClass mapper
  const html2 = buildBackendStatusBadgeHtml({ status: 'READY', label: 'Ready', tone: 'ok', hint: 'h' }, t => `pfx-vfx-vf-${t}`);
  assert.match(html2, /pfx-vfx-vf-ok/);
});
