// modules/utils_time.js
// Helper: FPS & timecode conversions (NDF + drop-frame)

// ── FPS preset table ──────────────────────────────────────────────────────────
export const FPS_PRESETS = [
  { label: '23.976 fps', fps: 23.976, numerator: 24000, denominator: 1001, dfCapable: false },
  { label: '24 fps',     fps: 24,     numerator: 24,    denominator: 1,    dfCapable: false },
  { label: '25 fps',     fps: 25,     numerator: 25,    denominator: 1,    dfCapable: false },
  { label: '29.97 fps',  fps: 29.97,  numerator: 30000, denominator: 1001, dfCapable: true  },
  { label: '30 fps',     fps: 30,     numerator: 30,    denominator: 1,    dfCapable: false },
  { label: '50 fps',     fps: 50,     numerator: 50,    denominator: 1,    dfCapable: false },
  { label: '59.94 fps',  fps: 59.94,  numerator: 60000, denominator: 1001, dfCapable: true  },
  { label: '60 fps',     fps: 60,     numerator: 60,    denominator: 1,    dfCapable: false },
  { label: '120 fps',    fps: 120,    numerator: 120,   denominator: 1,    dfCapable: false },
];

export function fpsFromFrameDuration(fd) { // e.g. "100/2400s"
  if (!fd) return 24;
  const m = String(fd).match(/(\d+)\/(\d+)s/);
  if (!m) return 24;
  const num = +m[1], den = +m[2];
  if (!den || !num) return 24;
  return den / num;
}

export function parseFracSeconds(frac, fps) { // "A/Bs" -> frames @fps
  if (!frac) return 0;
  const m = String(frac).match(/(\d+)\/(\d+)s/);
  if (!m) return 0;
  const num = +m[1], den = +m[2];
  if (!den) return 0;
  return Math.round((num / den) * fps);
}

/**
 * Timecode counts on a whole-frame base: 23.976 fits 24 frame fields into a
 * timecode second, 29.97 NDF fits 30. Handing the fractional rate to a HH:MM:SS:FF
 * conversion asks for something unrepresentable — 24 distinct frame fields do not
 * fit into 23.976 frames — and the pair stops being invertible. It was measurably
 * not invertible: tcToFrames('01:00:00:00', 23.976) returned 86313 where timecode
 * says 86400, and framesToTC turned that back into '00:59:59:23'. A one-hour start
 * timecode came back 87 frames — 3.6 seconds — short of itself, and a five-second
 * span measured 119 frames instead of 120, which is the shape of a VFX pull that
 * arrives one frame short.
 *
 * Rounding here is not a new convention; it is the one already written down three
 * times and never applied at the bottom. timecodeToFrames calls
 * `tcToFrames(tc, Math.round(fps))` and explains why in as many words; xml.js's
 * normFps rounds before every conversion it makes; and timecodeFuzz.test.mjs calls
 * this pair's contract "nominal-base" — while fuzzing it only at 24/25/30/50/60,
 * the rates where nominal and real are the same number. The gap survived because
 * every caller that knew about it worked around it on the way in.
 *
 * For callers already passing an integer rate this is a no-op.
 */
export function nominalBase(fps) {
  const n = Number(fps);
  if (!Number.isFinite(n) || n <= 0) return 24;
  return Math.round(n);
}

export function tcToFrames(tc, fps) { // "HH:MM:SS:FF" or "HH;MM;SS;FF" (DF treated as NDF) -> frames
  if (!tc) return 0;
  // Normalise drop-frame semicolon separators to colons
  const parts = String(tc).replace(/;/g, ':').split(':');
  // Strip subframe suffix emitted by DaVinci Resolve 21 (e.g. "12.5" → "12")
  if (parts.length >= 4) parts[3] = parts[3].replace(/\.\d+$/, '');
  const [hh, mm, ss, ff] = parts.map(n => +n || 0);
  // Math.round, not `| 0`: on a whole-frame base the product is already an
  // integer, so the old truncation was a no-op that also silently wrapped past
  // 2^31 frames. Rounding keeps the arithmetic and drops the 32-bit ceiling.
  return Math.round(((hh * 3600) + (mm * 60) + ss) * nominalBase(fps) + ff);
}

export function framesToTC(fr, fps) { // frames -> "HH:MM:SS:FF" (NDF)
  const base = nominalBase(fps);
  fr = Math.max(0, Math.round(fr));
  const hh = Math.floor(fr / (3600 * base)); fr -= hh * 3600 * base;
  const mm = Math.floor(fr / (60 * base));   fr -= mm * 60 * base;
  const ss = Math.floor(fr / base);          fr -= ss * base;
  const ff = Math.floor(Math.max(0, fr));
  const pad = n => String(n).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

// ── Project-settings-aware helpers ────────────────────────────────────────────

export function getProjectFrameRate(settings) {
  const fps = settings?.general?.frameRate;
  return (fps && fps > 0) ? fps : 23.976;
}

export function getProjectFrameRateExact(settings) {
  const ex = settings?.general?.frameRateExact;
  if (ex?.numerator && ex?.denominator) return { numerator: ex.numerator, denominator: ex.denominator };
  const fps = getProjectFrameRate(settings);
  const entry = FPS_PRESETS.find(e => Math.abs(e.fps - fps) < 0.01);
  return entry
    ? { numerator: entry.numerator, denominator: entry.denominator }
    : { numerator: Math.round(fps * 1001), denominator: 1001 };
}

export function isDropFrameCapable(fps) {
  return Math.abs(fps - 29.97) < 0.02 || Math.abs(fps - 59.94) < 0.02;
}

export function getEffectiveDropFrame(settings) {
  const fps  = getProjectFrameRate(settings);
  const mode = settings?.general?.timecodeMode || 'auto';
  if (!isDropFrameCapable(fps)) return false;
  if (mode === 'non-drop') return false;
  return true; // 'auto' or 'drop' → true for DF-capable rates
}

// ── Drop-frame internal math ──────────────────────────────────────────────────
// dropCount = 2 for 29.97 DF, 4 for 59.94 DF

function _dfTcToFrames(h, m, s, f, dropCount) {
  const nomFps = dropCount === 2 ? 30 : 60;
  const totalMin = h * 60 + m;
  return nomFps * (h * 3600 + m * 60 + s) + f - dropCount * (totalMin - Math.floor(totalMin / 10));
}

function _dfFramesToTC(n, dropCount) {
  const nomFps       = dropCount === 2 ? 30 : 60;
  const framesPerMin  = nomFps * 60 - dropCount;   // 1798 or 3596
  const framesPer10m  = framesPerMin * 10 + dropCount; // 17982 or 35964
  const framesPerHour = framesPer10m * 6;            // 107892 or 215784
  n = Math.max(0, Math.round(n));
  const hh  = Math.floor(n / framesPerHour); n %= framesPerHour;
  const d10 = Math.floor(n / framesPer10m);  n %= framesPer10m;
  let mm1, sf;
  if (n < nomFps * 60) {
    // First minute of 10-minute block — no drop
    mm1 = 0; sf = n;
  } else {
    // Minutes 1-9 of block — drop frames 0..(dropCount-1)
    n -= nomFps * 60;
    mm1 = Math.min(9, Math.floor(n / framesPerMin) + 1);
    sf  = n % framesPerMin + dropCount;
  }
  return [hh, d10 * 10 + mm1, Math.floor(sf / nomFps), sf % nomFps];
}

// ── Project-aware timecode conversions ────────────────────────────────────────

export function timecodeToFrames(tc, settings) {
  const fps = getProjectFrameRate(settings);
  const df  = getEffectiveDropFrame(settings);
  // Non-drop: timecode frame fields are integers on a whole-frame base (23.976
  // uses a 24-frame base, 29.97 NDF a 30-frame base). Using the fractional fps
  // here breaks frame↔TC round-trips, so round to the integer base.
  if (!df) return tcToFrames(tc, Math.round(fps));
  const parts = String(tc || '').replace(/;/g, ':').split(':');
  if (parts.length >= 4) parts[3] = parts[3].replace(/\.\d+$/, '');
  const [h, m, s, f] = parts.map(n => +n || 0);
  const dropCount = Math.abs(fps - 29.97) < 0.02 ? 2 : 4;
  return _dfTcToFrames(h, m, s, f, dropCount);
}

export function framesToTimecode(frames, settings) {
  const fps = getProjectFrameRate(settings);
  const df  = getEffectiveDropFrame(settings);
  // Non-drop uses the whole-frame timecode base (see timecodeToFrames).
  if (!df) return framesToTC(frames, Math.round(fps));
  const dropCount = Math.abs(fps - 29.97) < 0.02 ? 2 : 4;
  const [hh, mm, ss, ff] = _dfFramesToTC(frames, dropCount);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)};${pad(ff)}`;
}

export function durationToFrames(durationTc, settings) {
  return timecodeToFrames(durationTc, settings);
}

// ── Unit tests ────────────────────────────────────────────────────────────────
export function runTimecodeUnitTests() {
  const results = [];
  const check = (label, got, expected) => {
    const pass = got === expected;
    results.push({ label, got, expected, pass });
    if (!pass) console.warn(`[TC TEST FAIL] ${label}: got "${got}", expected "${expected}"`);
    return pass;
  };

  const ndf = fps => ({ general: { frameRate: fps, timecodeMode: 'non-drop', dropFrame: false } });
  const df  = fps => ({ general: { frameRate: fps, timecodeMode: 'drop',     dropFrame: true  } });

  // NDF frame counts — whole-frame timecode base (23.976→24, 29.97 NDF→30)
  check('01:00:00:00 @23.976 NDF → frames', timecodeToFrames('01:00:00:00', ndf(23.976)), 86400);
  check('01:00:00:00 @24 NDF → frames',     timecodeToFrames('01:00:00:00', ndf(24)),     86400);
  check('01:00:00:00 @25 NDF → frames',     timecodeToFrames('01:00:00:00', ndf(25)),     90000);
  check('01:00:00:00 @29.97 NDF → frames',  timecodeToFrames('01:00:00:00', ndf(29.97)),  108000);

  // DF frame counts  (1 hour = 107892 @ 29.97 DF, 215784 @ 59.94 DF)
  check('01:00:00;00 @29.97 DF → frames',   timecodeToFrames('01:00:00;00', df(29.97)),  107892);
  check('01:00:00;00 @59.94 DF → frames',   timecodeToFrames('01:00:00;00', df(59.94)),  215784);

  // Round-trip DF
  check('107892 @29.97 DF → "01:00:00;00"', framesToTimecode(107892, df(29.97)), '01:00:00;00');
  check('215784 @59.94 DF → "01:00:00;00"', framesToTimecode(215784, df(59.94)), '01:00:00;00');

  // Drop minutes: 00:01:00;02 is the first valid frame after the drop
  check('1800 @29.97 DF → "00:01:00;02"',   framesToTimecode(1800, df(29.97)),  '00:01:00;02');
  check('00:01:00;02 @29.97 DF → frames',    timecodeToFrames('00:01:00;02', df(29.97)), 1800);

  const passed = results.filter(r => r.pass).length;
  console.log(`[TC Tests] ${passed}/${results.length} passed`);
  return results;
}
