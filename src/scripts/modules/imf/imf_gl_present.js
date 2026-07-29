// scripts/modules/imf/imf_gl_present.js
// GPU present path for IMF "Path B" (renderer WASM HTJ2K decode).
//
// Takes a decoded frame (raw component samples straight from the OpenJPH WASM
// decoder) and runs the full preview color pipeline on the GPU via WebGL2, then
// draws it into a reusable offscreen canvas the 2D player composites with drawImage.
//
// On Apple Silicon, Chromium's ANGLE backend runs WebGL2 on Metal, so this IS
// Metal GPU acceleration of the color pipeline (matrix -> PQ->linear -> tonemap ->
// primaries -> sRGB), replacing the per-pixel CPU math in imf_render_worker.js.
//
// The GLSL below is a faithful port of imf_render_worker.js — SAME BT.709/2020
// matrices, SAME PQ inverse-EOTF, SAME Hable tone map with white-point
// normalization, SAME DV L8 trim, SAME SDR passthrough gating. Per-frame scalar
// constants (shot peak, tone-map scale/white point, primaries/hue matrices) are
// computed on the CPU here and passed as uniforms so the shader math matches the
// worker exactly without recomputing log10()/cos()/sin() per pixel.
//
// build marker
console.log('[IMF] gl present build: 2026-07-05-v1');
'use strict';

// ── Color-math helpers (mirror imf_render_worker.js exactly) ───────────────────
function _isPQTransfer(transfer) {
  const t = String(transfer || '').toUpperCase();
  return t.includes('PQ') || t.includes('ST 2084') || t.includes('ST2084');
}

// Safe-nits normalization identical to toneMapHdrLinear01()._safeNits.
function _safeNits(n) {
  const x = Number(n) || 0;
  return x > 10000 ? x / 10000 : (x > 0 ? x : 0);
}

function _hableCurve(x) {
  return (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
}

// Precompute the per-frame tone-map scalars from toneMapHdrLinear01(). The
// per-pixel part (nits = v*10000; x = nits/shotPeak*scale; hable(x)/w) stays in
// the shader; these three constants are frame-global.
function _toneMapConsts(srcPeakNits, activeL1MaxNits) {
  const globalPeak = Math.max(100, _safeNits(srcPeakNits) || 1000);
  const shotPeak = activeL1MaxNits > 0
    ? Math.max(50, Math.min(globalPeak, _safeNits(activeL1MaxNits)))
    : globalPeak;
  const scale = 1.0 + 0.12 * Math.log10(shotPeak / 1000 + 1);
  const w = _hableCurve(scale);
  return { shotPeak, scale, w };
}

// Column-major mat3 (WebGL layout) from row-major rows so that M*v == row·v,
// matching the CPU matrix multiplies in convertPrimariesLinear / _applyHueRotate.
function _mat3ColMajor(rows) {
  const [r0, r1, r2] = rows;
  return new Float32Array([
    r0[0], r1[0], r2[0],
    r0[1], r1[1], r2[1],
    r0[2], r1[2], r2[2],
  ]);
}

const _IDENTITY3 = _mat3ColMajor([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);

// Mirror convertPrimariesLinear(): source primaries -> Rec.709 in linear light.
function _primariesMatrix(primaries) {
  const p = String(primaries || '').toUpperCase();
  if (p.includes('P3-D65') || p.includes('DISPLAY P3') || p.includes('DISPLAY-P3')) {
    return _mat3ColMajor([
      [1.22474526, -0.22490436, 0.00000002],
      [-0.04205792, 1.04208101, -0.00000002],
      [-0.01964228, -0.07865492, 1.09853719],
    ]);
  }
  if (p.includes('2020') || p.includes('BT.2020') || p.includes('REC.2020')) {
    return _mat3ColMajor([
      [1.6605, -0.5876, -0.0728],
      [-0.1246, 1.1329, -0.0083],
      [-0.0182, -0.1006, 1.1187],
    ]);
  }
  return _IDENTITY3;
}

// Mirror _applyHueRotate() (Rec.709 luminance-preserving hue rotation).
function _hueMatrix(angleDeg) {
  if (!angleDeg) return _IDENTITY3;
  const c = Math.cos(angleDeg * Math.PI / 180);
  const s = Math.sin(angleDeg * Math.PI / 180);
  return _mat3ColMajor([
    [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
    [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283],
    [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
  ]);
}

// colorMode: 0 = SDR passthrough (non-PQ), 1 = PQ 'sdr' tone map, 2 = PQ 'full'
// boost, 3 = PQ 'trim' (DV L8). Matches previewEncodeRgbPrime() branch selection.
function _colorMode(colorInfo) {
  if (!_isPQTransfer(colorInfo.transfer)) return 0;
  const mode = colorInfo.tonemapMode || 'sdr';
  if (mode === 'full') return 2;
  if (mode === 'trim' && colorInfo.dvTrim) return 3;
  return 1;
}

// ── GLSL ───────────────────────────────────────────────────────────────────────
// Attribute-less fullscreen triangle; v_uv spans [0,1] over the visible region.
const _VERT_SRC = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 pos = vec2(float((gl_VertexID & 1) << 2) - 1.0,
                  float((gl_VertexID & 2) << 1) - 1.0);
  v_uv = (pos + 1.0) * 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

// SAMPLER_DECL is injected: highp usampler2D (u8/u16) or highp isampler2D (i16).
function _fragSrc(samplerType) {
  return `#version 300 es
precision highp float;
precision highp int;
uniform highp ${samplerType} u_tex;
in vec2 v_uv;
out vec4 fragColor;

uniform int   u_colorMode;   // 0 SDR passthrough | 1 PQ sdr | 2 PQ full | 3 PQ trim
uniform float u_maxVal;      // 2^bits - 1
uniform float u_dcOffset;    // signed DC offset (0 for unsigned)
uniform float u_sdrDiv;      // 2^(bits-8) truncation divisor for SDR passthrough
uniform float u_shotPeak;    // per-shot tone-map peak nits
uniform float u_tmScale;     // tone-map input scale
uniform float u_tmW;         // tone-map white-point normalizer (hable(scale))
uniform float u_boost;       // 'full' mode linear boost (25.7)
uniform mat3  u_primMat;     // primaries -> Rec.709 (identity if none)
uniform float u_gain;        // DV L8 slope
uniform float u_lift;        // DV L8 offset
uniform float u_gamma;       // DV L8 power
uniform float u_effSat;      // DV L8 sat * chromaWeight
uniform mat3  u_hueMat;      // DV L8 hue rotation (identity if none)

float clamp01(float v) { return clamp(v, 0.0, 1.0); }

float pqToLinear01(float v) {
  float x = clamp01(v);
  const float m1 = 2610.0 / 16384.0;
  const float m2 = 2523.0 / 32.0;
  const float c1 = 3424.0 / 4096.0;
  const float c2 = 2413.0 / 128.0;
  const float c3 = 2392.0 / 128.0;
  float p = pow(x, 1.0 / m2);
  float num = max(p - c1, 0.0);
  float den = c2 - c3 * p;
  if (den <= 0.0) return 0.0;
  return pow(num / den, 1.0 / m1);
}

float hableCurve(float x) {
  return (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
}

float toneMap(float v) {
  float nits = max(0.0, v) * 10000.0;
  float x = (nits / u_shotPeak) * u_tmScale;
  return clamp01(u_tmW > 0.0 ? hableCurve(x) / u_tmW : hableCurve(x));
}

float linearToSrgb01(float v) {
  float x = clamp01(v);
  return x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1.0 / 2.4) - 0.055;
}

void main() {
  // ArrayBufferView uploads ignore UNPACK_FLIP_Y_WEBGL, so flip in the sampler:
  // data row 0 (top of image) lives at texture v=0.
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec3 s = vec3(texture(u_tex, uv).rgb);

  if (u_colorMode == 0) {
    // SDR passthrough — matches px(): (v >> (bits-8)) & 0xff, then /255.
    // clamp() would clip negative signed samples to 0 instead of wrapping
    // them into the low byte the way & 0xff does, so use mod() (GLSL's
    // mod is floor-based, so it matches two's-complement truncation for
    // any integer, positive or negative).
    vec3 c = mod(floor(s / u_sdrDiv), 256.0) / 255.0;
    fragColor = vec4(c, 1.0);
    return;
  }

  // PQ pipeline. Normalize R'G'B' to [0,1] like pxColor().
  vec3 rp = clamp((s + u_dcOffset) / u_maxVal, 0.0, 1.0);
  vec3 lin = vec3(pqToLinear01(rp.r), pqToLinear01(rp.g), pqToLinear01(rp.b));
  lin = u_primMat * lin;

  vec3 enc;
  if (u_colorMode == 2) {
    // 'full' HDR boost preview.
    enc = vec3(linearToSrgb01(clamp01(lin.r * u_boost)),
               linearToSrgb01(clamp01(lin.g * u_boost)),
               linearToSrgb01(clamp01(lin.b * u_boost)));
  } else if (u_colorMode == 3) {
    // 'trim' — tone map to SDR linear, apply DV L8 trim, then sRGB encode.
    vec3 c = vec3(toneMap(lin.r), toneMap(lin.g), toneMap(lin.b));
    c = c * u_gain + vec3(u_lift);                                 // slope + offset
    c = vec3(c.r > 0.0 ? pow(c.r, u_gamma) : 0.0,                  // power
             c.g > 0.0 ? pow(c.g, u_gamma) : 0.0,
             c.b > 0.0 ? pow(c.b, u_gamma) : 0.0);
    float luma = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;       // saturation
    c = vec3(luma) + u_effSat * (c - vec3(luma));
    c = clamp(u_hueMat * c, 0.0, 1.0);                             // hue shift
    enc = vec3(linearToSrgb01(c.r), linearToSrgb01(c.g), linearToSrgb01(c.b));
  } else {
    // 'sdr' — Hable tone map with per-shot white-point normalization.
    enc = vec3(linearToSrgb01(toneMap(lin.r)),
               linearToSrgb01(toneMap(lin.g)),
               linearToSrgb01(toneMap(lin.b)));
  }
  fragColor = vec4(enc, 1.0);
}`;
}

// ── Presenter ────────────────────────────────────────────────────────────────
export function createImfGlPresenter() {
  let canvas = null;
  let gl = null;
  try {
    canvas = (typeof OffscreenCanvas === 'function')
      ? new OffscreenCanvas(2, 2)
      : document.createElement('canvas');
    gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true, // 2D drawImage reads the canvas after our draw
    });
  } catch (e) {
    gl = null;
  }
  if (!gl) {
    return { available: false, render() { return null; }, dispose() {} };
  }

  // Program cache keyed by sampler kind ('u' = usampler2D, 'i' = isampler2D).
  const _programs = new Map();
  let _vao = null;
  let _tex = null;
  // If the driver rejects our texture/shader setup repeatedly (e.g. an
  // unsupported integer RGB format), latch off so we stop retrying every frame
  // and the caller stays on the CPU path.
  let _failures = 0;
  let _dead = false;

  // Context loss (GPU reset / driver crash) would otherwise leave render()
  // silently drawing nothing while the timecode advances — especially after the
  // getError() warmup window closes. Latch dead so render() returns null and the
  // caller falls back to the CPU path.
  try {
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      _dead = true;
      console.warn('[IMF] WebGL2 context lost — disabling GPU path (CPU fallback)');
    }, false);
    canvas.addEventListener('webglcontextrestored', () => {
      console.log('[IMF] WebGL2 context restored (GPU path stays disabled until reload)');
    }, false);
  } catch (_) { /* OffscreenCanvas may lack addEventListener in some engines */ }
  // gl.getError() forces a full CPU<->GPU sync, so we only probe during a short
  // warmup window (re-armed when the texture format changes, i.e. a new clip).
  // Bad formats/shaders fail immediately, so warmup is enough to trip the latch;
  // steady-state playback then skips the per-frame sync entirely.
  const _MAX_CHECKS = 8;
  let _checks = 0;
  let _lastFmtKey = '';

  function _compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('shader compile failed: ' + log);
    }
    return sh;
  }

  function _getProgram(kind) {
    let entry = _programs.get(kind);
    if (entry) return entry;
    const samplerType = kind === 'i' ? 'isampler2D' : 'usampler2D';
    const vs = _compile(gl.VERTEX_SHADER, _VERT_SRC);
    const fs = _compile(gl.FRAGMENT_SHADER, _fragSrc(samplerType));
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error('program link failed: ' + log);
    }
    entry = {
      prog,
      u: {
        tex:        gl.getUniformLocation(prog, 'u_tex'),
        colorMode:  gl.getUniformLocation(prog, 'u_colorMode'),
        maxVal:     gl.getUniformLocation(prog, 'u_maxVal'),
        dcOffset:   gl.getUniformLocation(prog, 'u_dcOffset'),
        sdrDiv:     gl.getUniformLocation(prog, 'u_sdrDiv'),
        shotPeak:   gl.getUniformLocation(prog, 'u_shotPeak'),
        tmScale:    gl.getUniformLocation(prog, 'u_tmScale'),
        tmW:        gl.getUniformLocation(prog, 'u_tmW'),
        boost:      gl.getUniformLocation(prog, 'u_boost'),
        primMat:    gl.getUniformLocation(prog, 'u_primMat'),
        gain:       gl.getUniformLocation(prog, 'u_gain'),
        lift:       gl.getUniformLocation(prog, 'u_lift'),
        gamma:      gl.getUniformLocation(prog, 'u_gamma'),
        effSat:     gl.getUniformLocation(prog, 'u_effSat'),
        hueMat:     gl.getUniformLocation(prog, 'u_hueMat'),
      },
    };
    _programs.set(kind, entry);
    return entry;
  }

  // Resolve GL texture format from decoded pixel type + component count.
  function _texFormat(pixelsType, comps) {
    const rgba = comps >= 4;
    if (pixelsType === 'u16') {
      return { kind: 'u', internal: rgba ? gl.RGBA16UI : gl.RGB16UI,
               format: rgba ? gl.RGBA_INTEGER : gl.RGB_INTEGER, type: gl.UNSIGNED_SHORT };
    }
    if (pixelsType === 'i16') {
      return { kind: 'i', internal: rgba ? gl.RGBA16I : gl.RGB16I,
               format: rgba ? gl.RGBA_INTEGER : gl.RGB_INTEGER, type: gl.SHORT };
    }
    return { kind: 'u', internal: rgba ? gl.RGBA8UI : gl.RGB8UI,
             format: rgba ? gl.RGBA_INTEGER : gl.RGB_INTEGER, type: gl.UNSIGNED_BYTE };
  }

  // Render a decoded frame to the internal canvas and return it (reused across
  // frames). Returns null for layouts the GPU path doesn't handle (caller falls
  // back to the CPU worker path).
  function render(decoded, colorInfo) {
    if (_dead) return null;
    if (!decoded || !decoded.pixels) return null;
    // Only interleaved RGB(A) is GPU-accelerated; planar/YUV/mono -> CPU fallback.
    if ((decoded.sampleLayout || 'interleaved') !== 'interleaved') return null;
    const comps = decoded.componentCount | 0;
    if (comps < 3) return null;

    const w = decoded.width | 0, h = decoded.height | 0;
    if (w <= 0 || h <= 0) return null;

    const bits = decoded.bitsPerSample || 8;
    const isSigned = !!decoded.isSigned;
    const pixelsType = decoded.pixelsType || (bits > 8 ? (isSigned ? 'i16' : 'u16') : 'u8');
    const fmt = _texFormat(pixelsType, comps);

    // Re-arm the getError() warmup probe whenever the texture format changes
    // (a new clip may use a format the driver rejects even if the last one worked).
    const fmtKey = pixelsType + 'x' + comps;
    if (fmtKey !== _lastFmtKey) { _lastFmtKey = fmtKey; _checks = 0; }

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);

    if (!_vao) _vao = gl.createVertexArray();
    gl.bindVertexArray(_vao);

    if (!_tex) {
      _tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, _tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, _tex);
    }

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // Reuse the texture object; re-upload each frame (dims change with reduced-res
    // adaptive decode, so texImage2D not texSubImage2D).
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, w, h, 0, fmt.format, fmt.type, decoded.pixels);

    const entry = _getProgram(fmt.kind);
    gl.useProgram(entry.prog);
    const U = entry.u;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, _tex);
    gl.uniform1i(U.tex, 0);

    const mode = _colorMode(colorInfo);
    gl.uniform1i(U.colorMode, mode);

    const maxVal = Math.max(1, (1 << bits) - 1);
    const dcOffset = isSigned ? (1 << (bits - 1)) : 0;
    const sdrDiv = bits > 8 ? Math.pow(2, bits - 8) : 1;
    gl.uniform1f(U.maxVal, maxVal);
    gl.uniform1f(U.dcOffset, dcOffset);
    gl.uniform1f(U.sdrDiv, sdrDiv);

    const tm = _toneMapConsts(colorInfo.srcPeakNits, colorInfo.activeL1MaxNits || 0);
    gl.uniform1f(U.shotPeak, tm.shotPeak);
    gl.uniform1f(U.tmScale, tm.scale);
    gl.uniform1f(U.tmW, tm.w);
    gl.uniform1f(U.boost, 25.7);
    gl.uniformMatrix3fv(U.primMat, false, _primariesMatrix(colorInfo.primaries));

    const dv = (mode === 3) ? colorInfo.dvTrim : null;
    gl.uniform1f(U.gain, dv ? dv.gain : 1);
    gl.uniform1f(U.lift, dv ? dv.lift : 0);
    gl.uniform1f(U.gamma, dv ? dv.gamma : 1);
    gl.uniform1f(U.effSat, dv ? ((dv.sat ?? 1) * (dv.chromaWeight ?? 1)) : 1);
    gl.uniformMatrix3fv(U.hueMat, false, dv ? _hueMatrix(dv.hueShift) : _IDENTITY3);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Only probe gl.getError() during the warmup window (it forces a GPU sync).
    if (_checks < _MAX_CHECKS) {
      _checks++;
      if (gl.getError && gl.getError() !== gl.NO_ERROR) {
        if (++_failures >= 3) {
          _dead = true;
          console.warn('[IMF] WebGL2 present errored repeatedly — disabling GPU path (CPU fallback)');
        }
        return null;
      }
      _failures = 0;
    }
    return canvas;
  }

  function dispose() {
    try {
      for (const { prog } of _programs.values()) gl.deleteProgram(prog);
      _programs.clear();
      if (_tex) gl.deleteTexture(_tex);
      if (_vao) gl.deleteVertexArray(_vao);
      _tex = null; _vao = null;
    } catch (_) {}
  }

  console.log('[IMF] WebGL2 present context created', gl.getParameter(gl.VERSION));
  return { available: true, render, dispose, get canvas() { return canvas; } };
}
