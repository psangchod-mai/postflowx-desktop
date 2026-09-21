'use strict';
/**
 * nativeEngineClient.js — renderer-side client for PFXNativeMediaEngine.
 *
 * All calls go through pfxPlatform.nativeEngine (exposed by preload.js).
 * Provides typed wrappers so callers don't pass raw type strings.
 */

const ne = () => window.pfxPlatform?.nativeEngine;

function assertEngine() {
  if (!ne()) throw new Error('pfxPlatform.nativeEngine not available');
}

// ── Session ─────────────────────────────────────────────────────────────────

export async function neOpen(path, timeoutMs = 30_000) {
  assertEngine();
  return ne().command('media.open', { path }, timeoutMs);
}

export async function neClose(sessionId) {
  assertEngine();
  return ne().command('media.close', { sessionId });
}

export async function neProbe(path) {
  assertEngine();
  return ne().command('media.probe', { path });
}

// ── Playback state ───────────────────────────────────────────────────────────

export async function nePlay(sessionId) {
  assertEngine();
  return ne().command('playback.play', { sessionId });
}

export async function nePause(sessionId) {
  assertEngine();
  return ne().command('playback.pause', { sessionId });
}

export async function neSeek(sessionId, frame) {
  assertEngine();
  return ne().command('playback.seek', { sessionId, frame });
}

export async function neSetRate(sessionId, rate) {
  assertEngine();
  return ne().command('playback.setRate', { sessionId, rate });
}

export async function neSetRange(sessionId, inPoint, outPoint) {
  assertEngine();
  return ne().command('playback.setRange', { sessionId, inPoint, outPoint });
}

// ── Frame extraction ─────────────────────────────────────────────────────────

/**
 * Extract a single frame. Returns { dataUrl, imageDataUrl, frame, hwDecode }.
 * This replaces the per-process avf_bridge getStill call (~100ms → ~5ms).
 */
export async function neFrameExtract(sessionId, frame, outputWidth = 1280, quality = 0.88) {
  assertEngine();
  return ne().command('frame.extract', { sessionId, frame, outputWidth, quality });
}

// ── Thumbnails ───────────────────────────────────────────────────────────────

export async function neThumbnailGenerate(sessionIdOrPath, opts = {}) {
  assertEngine();
  const payload = typeof sessionIdOrPath === 'string' && sessionIdOrPath.startsWith('ses-')
    ? { sessionId: sessionIdOrPath, ...opts }
    : { path: sessionIdOrPath, ...opts };
  return ne().command('thumbnail.generate', payload, opts.timeoutMs ?? 120_000);
}

// ── Waveform ─────────────────────────────────────────────────────────────────

export async function neWaveformGenerate(sessionId, buckets = 1000, channel = 0) {
  assertEngine();
  return ne().command('waveform.generate', { sessionId, buckets, channel }, 120_000);
}

// ── Proxy ────────────────────────────────────────────────────────────────────

export async function neProxyCreate(sessionId, opts = {}) {
  assertEngine();
  return ne().command('proxy.create', { sessionId, ...opts });
}

export async function neProxyStatus(jobId) {
  assertEngine();
  return ne().command('proxy.status', { jobId });
}

export async function neProxyCancel(jobId) {
  assertEngine();
  return ne().command('proxy.cancel', { jobId });
}

// ── Render jobs ──────────────────────────────────────────────────────────────

export async function neRenderCreate(inputPath, outputPath, ranges, fps) {
  assertEngine();
  return ne().command('render.createJob', { inputPath, outputPath, ranges, fps }, 10_000);
}

export async function neRenderPause(jobId) {
  assertEngine();
  return ne().command('render.pauseJob', { jobId });
}

export async function neRenderCancel(jobId) {
  assertEngine();
  return ne().command('render.cancelJob', { jobId });
}

export async function neRenderStatus(jobId) {
  assertEngine();
  return ne().command('render.getStatus', { jobId });
}

// ── Diagnostics ──────────────────────────────────────────────────────────────

export async function neDiagnostics() {
  if (!ne()) return null;
  return ne().command('engine.diagnostics', {});
}

// ── Availability check ───────────────────────────────────────────────────────

export function nativeEngineAvailable() {
  return !!(window.pfxPlatform?.nativeEngine?.isReady);
}
