// test/_contract.mjs — the single event contract every parser must satisfy.
// (See CLAUDE_CODE_TASK §1.) Pure helpers reused across parser + pipeline tests.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tcToFrames } from '../src/scripts/modules/utils_time.js';

export const TC_RE = /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/;

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const fixturePath = (name) => path.join(HERE, 'fixtures', name);
export const readFixture = (name) => readFileSync(fixturePath(name), 'utf8');
export const readFixtureBuffer = (name) => readFileSync(fixturePath(name));

// OTIO emits `trackIndex`; AAF/EDL emit `track` (sometimes a string like "V2").
// Normalize so `track` is always an integer ≥ 0.
export function normalizeEvent(ev) {
  const track = Number.isInteger(ev.track)
    ? ev.track
    : Number.isInteger(ev.trackIndex)
      ? ev.trackIndex
      : 0;
  return { ...ev, track };
}

// Assert the per-event contract rules.
export function assertEventContract(ev, ctx = '') {
  const e = normalizeEvent(ev);
  const tag = ctx ? `[${ctx}] ` : '';
  for (const k of ['srcIn', 'srcOut', 'recIn', 'recOut']) {
    assert.match(String(e[k] ?? ''), TC_RE, `${tag}${k} must be HH:MM:SS:FF — got "${e[k]}"`);
  }
  assert.ok(Number.isInteger(e.fps) && e.fps > 0, `${tag}fps must be a positive integer — got ${e.fps}`);
  assert.ok(typeof e.reel === 'string' && e.reel.length > 0, `${tag}reel must be a non-empty string`);
  assert.ok(Number.isInteger(e.track) && e.track >= 0, `${tag}track must be an integer ≥ 0 — got ${e.track}`);
  if (!e.disabled) {
    const din = tcToFrames(e.srcIn, e.fps);
    const dout = tcToFrames(e.srcOut, e.fps);
    assert.ok(dout > din, `${tag}srcOut(${e.srcOut}) must be > srcIn(${e.srcIn}) for non-disabled events`);
  }
}

// Assert the contract over a whole parser result; returns the normalized events.
export function assertParseResult(result, { sourceType } = {}) {
  assert.ok(result && Array.isArray(result.events), 'result.events must be an array');
  assert.ok(typeof result.projectName === 'string' && result.projectName.length > 0, 'projectName non-empty');
  assert.ok(Number.isFinite(result.fps) && result.fps > 0, 'top-level fps positive');

  // The two-rate contract. `fps` is the number of frame fields in a timecode
  // second and is therefore always whole; `fpsExact` is the real-time playback
  // rate. Enforced here rather than per-parser because the bug this replaces
  // was precisely that each parser answered `fps` with a different one of the
  // two, and every downstream consumer had to guess which it had been handed.
  assert.ok(Number.isInteger(result.fps), `top-level fps must be a whole frame base — got ${result.fps}`);
  assert.ok(Number.isFinite(result.fpsExact) && result.fpsExact > 0,
    `fpsExact must be a positive playback rate — got ${result.fpsExact}`);
  assert.equal(Math.round(result.fpsExact), result.fps,
    `fps (${result.fps}) must be fpsExact (${result.fpsExact}) rounded to whole frames`);
  if (sourceType) assert.equal(result.sourceType, sourceType, `sourceType === ${sourceType}`);
  const norm = result.events.map(normalizeEvent);
  norm.forEach((ev, i) => assertEventContract(ev, `${sourceType || 'event'}#${i}`));
  return norm;
}
