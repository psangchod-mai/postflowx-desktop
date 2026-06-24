console.log('[IMF] render worker build: 2026-04-07-v52');
// scripts/modules/imf/imf_render_worker.js
'use strict';

function typedArrayFrom(type, buffer) {
  if (type === 'u16') return new Uint16Array(buffer);
  if (type === 'i16') return new Int16Array(buffer);
  return new Uint8Array(buffer);
}



function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function isPQTransfer(transfer) {
  const t = String(transfer || '').toUpperCase();
  return t.includes('PQ') || t.includes('ST 2084') || t.includes('ST2084');
}

function pqToLinear01(v) {
  const x = clamp01(v);
  const m1 = 2610 / 16384;
  const m2 = 2523 / 32;
  const c1 = 3424 / 4096;
  const c2 = 2413 / 128;
  const c3 = 2392 / 128;
  const p = Math.pow(x, 1 / m2);
  const num = Math.max(p - c1, 0);
  const den = c2 - c3 * p;
  if (den <= 0) return 0;
  return Math.pow(num / den, 1 / m1);
}

// srcPeakNits: global mastering display peak (DV L6). activeL1MaxNits: per-shot peak (DV L1).
// Resolve adapts tone mapping per shot using L1 MaxPq — we do the same.
// Hable/Uncharted2 base curve (standard coefficients).
function _hableCurve(x) {
  return (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
}

function toneMapHdrLinear01(v, srcPeakNits, activeL1MaxNits) {
  // Safety: cap at physical maximum (10,000 nits). Raw L6 values sometimes arrive
  // in 1/10000 cd/m² units (e.g. 10,000,000 = 1,000 nits) if not normalized upstream.
  const _safeNits = (n) => { const x = Number(n) || 0; return x > 10000 ? x / 10000 : (x > 0 ? x : 0); };
  const globalPeak = Math.max(100, _safeNits(srcPeakNits) || 1000);
  const shotPeak   = activeL1MaxNits > 0 ? Math.max(50, Math.min(globalPeak, _safeNits(activeL1MaxNits))) : globalPeak;
  const nits = Math.max(0, v) * 10000;
  // Scale factor: expands the input range so the curve uses more of its shoulder.
  // Derived from the peak: x=1.0 at shot peak nits.
  const scale = 1.0 + 0.12 * Math.log10(shotPeak / 1000 + 1);
  const x = (nits / shotPeak) * scale;
  // White-point normalization: divide by the curve value at peak (x = scale) so
  // the peak nits map exactly to 1.0 linear output. Without this, peak content
  // maps to ~0.81 linear (90% sRGB), underexposing by ~10%.
  const w = _hableCurve(scale);
  return clamp01(w > 0 ? _hableCurve(x) / w : _hableCurve(x));
}

// Hue rotation matrix for DV L8 HueShift (Rec.709 luminance-preserving, CSS hue-rotate method).
function _applyHueRotate(r, g, b, angleDeg) {
  if (!angleDeg) return [r, g, b];
  const c = Math.cos(angleDeg * Math.PI / 180);
  const s = Math.sin(angleDeg * Math.PI / 180);
  return [
    clamp01(r * (0.213 + c*0.787 - s*0.213) + g * (0.715 - c*0.715 - s*0.715) + b * (0.072 - c*0.072 + s*0.928)),
    clamp01(r * (0.213 - c*0.213 + s*0.143) + g * (0.715 + c*0.285 + s*0.140) + b * (0.072 - c*0.072 - s*0.283)),
    clamp01(r * (0.213 - c*0.213 - s*0.787) + g * (0.715 - c*0.715 + s*0.715) + b * (0.072 + c*0.928 + s*0.072)),
  ];
}

// Apply DV L8 trim controls in linear light.
// dvTrim: {gain, lift, gamma, sat, chromaWeight, hueShift} from pickSdrTrim()
function applyDvTrimLinear(lin3, dvTrim) {
  if (!dvTrim) return lin3;
  let [r, g, b] = lin3;
  // 1. Slope + Offset
  r = r * dvTrim.gain + dvTrim.lift;
  g = g * dvTrim.gain + dvTrim.lift;
  b = b * dvTrim.gain + dvTrim.lift;
  // 2. Power (gamma in linear domain)
  r = r > 0 ? Math.pow(r, dvTrim.gamma) : 0;
  g = g > 0 ? Math.pow(g, dvTrim.gamma) : 0;
  b = b > 0 ? Math.pow(b, dvTrim.gamma) : 0;
  // 3. Saturation (SaturationGain) + ChromaWeight blend.
  //    ChromaWeight modulates chroma isolation: 1.0 = full chroma, 0 = luma-only.
  //    Combined effective saturation: sat × chromaWeight (both neutral at 1.0).
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const effectiveSat = (dvTrim.sat ?? 1) * (dvTrim.chromaWeight ?? 1);
  r = luma + effectiveSat * (r - luma);
  g = luma + effectiveSat * (g - luma);
  b = luma + effectiveSat * (b - luma);
  // 4. HueShift (degrees, ±30° range)
  if (dvTrim.hueShift) [r, g, b] = _applyHueRotate(r, g, b, dvTrim.hueShift);
  return [clamp01(r), clamp01(g), clamp01(b)];
}

function linearToSrgb01(v) {
  const x = clamp01(v);
  if (x <= 0.0031308) return 12.92 * x;
  return 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function convertPrimariesLinear(rgb, primaries) {
  const p = String(primaries || '').toUpperCase();
  const r = rgb[0], g = rgb[1], b = rgb[2];
  if (p.includes('P3-D65') || p.includes('DISPLAY P3') || p.includes('DISPLAY-P3')) {
    return [
      1.22474526 * r - 0.22490436 * g + 0.00000002 * b,
      -0.04205792 * r + 1.04208101 * g - 0.00000002 * b,
      -0.01964228 * r - 0.07865492 * g + 1.09853719 * b,
    ];
  }
  if (p.includes('2020') || p.includes('BT.2020') || p.includes('REC.2020')) {
    return [
      1.6605 * r - 0.5876 * g - 0.0728 * b,
      -0.1246 * r + 1.1329 * g - 0.0083 * b,
      -0.0182 * r - 0.1006 * g + 1.1187 * b,
    ];
  }
  return [r, g, b];
}

// opts: { tonemapMode?, srcPeakNits?, activeL1MaxNits?, dvTrim? }
function previewEncodeRgbPrime(rgbPrime, transfer, primaries, opts) {
  opts = opts || {};
  if (!isPQTransfer(transfer)) {
    return [
      Math.max(0, Math.min(255, Math.round(rgbPrime[0] * 255))),
      Math.max(0, Math.min(255, Math.round(rgbPrime[1] * 255))),
      Math.max(0, Math.min(255, Math.round(rgbPrime[2] * 255))),
    ];
  }
  let lin = [pqToLinear01(rgbPrime[0]), pqToLinear01(rgbPrime[1]), pqToLinear01(rgbPrime[2])];
  // Primaries conversion: source→Rec.709 in linear light
  lin = convertPrimariesLinear(lin, primaries);
  const mode = opts.tonemapMode || 'sdr';
  const l1 = opts.activeL1MaxNits || 0;
  let enc;
  if (mode === 'full') {
    // HDR boost preview: scale linear so Rec.2408 reference diffuse white
    // (203 nits = 0.0203 in [0,1] linear where 10000 nits = 1.0) maps to 75% sRGB.
    //
    // Derivation:
    //   Target sRGB = 0.75
    //   Required linear = inverse_sRGB(0.75) = ((0.75+0.055)/1.055)^2.4 ≈ 0.522
    //   BOOST = 0.522 / 0.0203 ≈ 25.7
    //
    // Highlights above ~3800 nits (0.0203×25.7=0.522 → any pixel with lin > 1/25.7)
    // clip at 100% — useful for checking specular/highlight detail that SDR
    // tone mapping would compress.
    const _BOOST = 25.7;
    enc = [
      linearToSrgb01(clamp01(lin[0] * _BOOST)),
      linearToSrgb01(clamp01(lin[1] * _BOOST)),
      linearToSrgb01(clamp01(lin[2] * _BOOST)),
    ];
  } else if (mode === 'trim' && opts.dvTrim) {
    // Dolby Vision L8 trim — correct processing order per CM v4.0 spec:
    //   1. Tone map HDR → SDR linear (linear Rec.709, normalized to display peak)
    //   2. Apply L8 trim (slope/offset/power/sat/hue) in SDR linear domain
    //   3. sRGB encode
    //
    // L8 TrimSlope/Offset/Power/SaturationGain are calibrated for a 0–1 SDR signal.
    // Applying them to linear HDR values (0–10000 nit range) before tone mapping
    // would produce completely wrong results.
    const sdrLin = [
      toneMapHdrLinear01(lin[0], opts.srcPeakNits, l1),
      toneMapHdrLinear01(lin[1], opts.srcPeakNits, l1),
      toneMapHdrLinear01(lin[2], opts.srcPeakNits, l1),
    ];
    const trimmed = applyDvTrimLinear(sdrLin, opts.dvTrim);
    enc = [
      linearToSrgb01(trimmed[0]),
      linearToSrgb01(trimmed[1]),
      linearToSrgb01(trimmed[2]),
    ];
  } else {
    // 'sdr' — Hable tone map with white-point normalization, per-shot L1 adapted
    enc = [
      linearToSrgb01(toneMapHdrLinear01(lin[0], opts.srcPeakNits, l1)),
      linearToSrgb01(toneMapHdrLinear01(lin[1], opts.srcPeakNits, l1)),
      linearToSrgb01(toneMapHdrLinear01(lin[2], opts.srcPeakNits, l1)),
    ];
  }
  return [
    Math.max(0, Math.min(255, Math.round(enc[0] * 255))),
    Math.max(0, Math.min(255, Math.round(enc[1] * 255))),
    Math.max(0, Math.min(255, Math.round(enc[2] * 255))),
  ];
}

function yuvToRgbPixel(y, u, v, transfer = '', primaries = '', bitsPerSample = 8, opts) {
  const s    = 1 << (bitsPerSample - 8);
  const yLow = 16  * s, yRange = 219 * s;
  const cOff = 128 * s, cRange = 224 * s;
  const yf = clamp01((y - yLow) / yRange);
  const uf = (u - cOff) / cRange;
  const vf = (v - cOff) / cRange;
  // YCbCr matrix selection:
  // Rec.2020 coefficients apply only when primaries explicitly declare BT.2020.
  // P3-D65 (Dolby Vision Profile 8) and all others use BT.709 — empirically correct
  // for most HTJ2K encoders including Dolby's own P3-D65 IMF deliverables.
  const _useRec2020 = /\b2020\b|BT\.2020|REC\.2020/i.test(primaries || '');
  let rP, gP, bP;
  if (_useRec2020) {
    // Rec.2020 narrow-range YCbCr→RGB (only for true BT.2020 primaries content)
    rP = clamp01(yf + 1.4746  * vf);
    gP = clamp01(yf - 0.16455 * uf - 0.57135 * vf);
    bP = clamp01(yf + 1.8814  * uf);
  } else {
    // BT.709 YCbCr→RGB (P3-D65, SDR, and all other primaries)
    rP = clamp01(yf + 1.5748 * vf);
    gP = clamp01(yf - 0.1873 * uf - 0.4681 * vf);
    bP = clamp01(yf + 1.8556 * uf);
  }
  return previewEncodeRgbPrime([rP, gP, bP], transfer, primaries, opts);
}

function frameToRGBA(width, height, componentCount, bitsPerSample, isSigned, pixels, sampleLayout='interleaved', scale=1, colorInfo={}) {
  const useScale = (typeof scale === 'number' && isFinite(scale) && scale > 0 && scale < 1) ? scale : 1;
  const step = useScale < 1 ? Math.max(1, Math.round(1 / useScale)) : 1;
  const outW = Math.max(1, Math.floor(width / step));
  const outH = Math.max(1, Math.floor(height / step));
  const out = new Uint8ClampedArray(outW * outH * 4);

  let pixelData;
  if (bitsPerSample > 8) {
    pixelData = isSigned
      ? new Int16Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 2)
      : new Uint16Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 2);
  } else {
    pixelData = pixels;
  }

  const plane = width * height;
  const shift = bitsPerSample > 8 ? Math.max(0, bitsPerSample - 8) : 0;
  const px = (v) => {
    const n = bitsPerSample > 8 ? (v >> shift) : v;
    return Math.max(0, Math.min(255, n & 0xff));
  };

  // For RGB (non-YUV) paths: normalize to [0,1] and apply the full
  // PQ→linear→tonemap→sRGB chain so HDR content matches Resolve's SDR preview.
  const needsColorMgmt = isPQTransfer(colorInfo && colorInfo.transfer);
  // Signed J2K components have a DC offset of 2^(bits-1); unsigned are full-range [0, 2^bits-1].
  const dcOffset = isSigned ? (1 << (bitsPerSample - 1)) : 0;
  const maxVal   = Math.max(1, (1 << bitsPerSample) - 1);
  const pxColor  = needsColorMgmt
    ? (v) => clamp01((v + dcOffset) / maxVal)
    : null;
  const _encOpts = needsColorMgmt ? { tonemapMode: colorInfo.tonemapMode, srcPeakNits: colorInfo.srcPeakNits, activeL1MaxNits: colorInfo.activeL1MaxNits || 0, dvTrim: colorInfo.dvTrim } : null;
  const encodeRgb = needsColorMgmt
    ? (r, g, b) => previewEncodeRgbPrime([r, g, b], colorInfo.transfer, colorInfo.primaries, _encOpts)
    : null;

  if (sampleLayout === 'yuv420p') {
    const yPlane = plane;
    const cW = Math.max(1, Math.floor(width / 2));
    const cH = Math.max(1, Math.floor(height / 2));
    const uvPlane = cW * cH;
    const uOff = yPlane;
    const vOff = yPlane + uvPlane;
    for (let y = 0; y < outH; y++) {
      const sy = Math.min(height - 1, y * step);
      const cy = Math.min(cH - 1, Math.floor(sy / 2));
      for (let x = 0; x < outW; x++) {
        const sx = Math.min(width - 1, x * step);
        const cx = Math.min(cW - 1, Math.floor(sx / 2));
        const yi = sy * width + sx;
        const ci = cy * cW + cx;
        const o = (y * outW + x) * 4;
        const [r, g, b] = yuvToRgbPixel(pixelData[yi] ?? 0, pixelData[uOff + ci] ?? 128, pixelData[vOff + ci] ?? 128, colorInfo.transfer, colorInfo.primaries, bitsPerSample, _encOpts);
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
      }
    }
    return { out, outW, outH };
  }

  if (sampleLayout === 'yuv422p') {
    const yPlane = plane;
    const cW = Math.max(1, Math.floor(width / 2));
    const uvPlane = cW * height;
    const uOff = yPlane;
    const vOff = yPlane + uvPlane;
    for (let y = 0; y < outH; y++) {
      const sy = Math.min(height - 1, y * step);
      for (let x = 0; x < outW; x++) {
        const sx = Math.min(width - 1, x * step);
        const cx = Math.min(cW - 1, Math.floor(sx / 2));
        const yi = sy * width + sx;
        const ci = sy * cW + cx;
        const o = (y * outW + x) * 4;
        const [r, g, b] = yuvToRgbPixel(pixelData[yi] ?? 0, pixelData[uOff + ci] ?? 128, pixelData[vOff + ci] ?? 128, colorInfo.transfer, colorInfo.primaries, bitsPerSample, _encOpts);
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
      }
    }
    return { out, outW, outH };
  }

  if (sampleLayout === 'planar') {
    const p0 = 0, p1 = plane, p2 = plane * 2, p3 = plane * 3;
    for (let y = 0; y < outH; y++) {
      const sy = Math.min(height - 1, y * step);
      for (let x = 0; x < outW; x++) {
        const sx = Math.min(width - 1, x * step);
        const i = sy * width + sx;
        const o = (y * outW + x) * 4;
        if (componentCount >= 3) {
          if (encodeRgb) {
            const [r, g, b] = encodeRgb(pxColor(pixelData[p0 + i]), pxColor(pixelData[p1 + i]), pxColor(pixelData[p2 + i]));
            out[o] = r; out[o + 1] = g; out[o + 2] = b;
          } else {
            out[o] = px(pixelData[p0 + i]);
            out[o + 1] = px(pixelData[p1 + i]);
            out[o + 2] = px(pixelData[p2 + i]);
          }
          out[o + 3] = componentCount >= 4 ? px(pixelData[p3 + i]) : 255;
        } else {
          const v = px(pixelData[i]);
          out[o] = out[o + 1] = out[o + 2] = v;
          out[o + 3] = 255;
        }
      }
    }
    return { out, outW, outH };
  }

  const comps = Math.max(1, componentCount);
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(height - 1, y * step);
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(width - 1, x * step);
      const si = (sy * width + sx) * comps;
      const o = (y * outW + x) * 4;
      if (componentCount >= 3) {
        if (encodeRgb) {
          const [r, g, b] = encodeRgb(pxColor(pixelData[si]), pxColor(pixelData[si + 1]), pxColor(pixelData[si + 2]));
          out[o] = r; out[o + 1] = g; out[o + 2] = b;
        } else {
          out[o] = px(pixelData[si]);
          out[o + 1] = px(pixelData[si + 1]);
          out[o + 2] = px(pixelData[si + 2]);
        }
        out[o + 3] = componentCount >= 4 ? px(pixelData[si + 3]) : 255;
      } else {
        const v = px(pixelData[si]);
        out[o] = out[o + 1] = out[o + 2] = v;
        out[o + 3] = 255;
      }
    }
  }
  return { out, outW, outH };
}

self.onmessage = async (event) => {
  const data = event.data || {};
  try {
    const pixels = typedArrayFrom(data.pixelsType, data.pixelsBuffer);
    const rgba = frameToRGBA(data.width, data.height, data.componentCount, data.bitsPerSample, data.isSigned, pixels, data.sampleLayout, data.scale, { transfer: data.transfer, primaries: data.primaries, tonemapMode: data.tonemapMode || 'sdr', srcPeakNits: data.srcPeakNits || null, activeL1MaxNits: data.activeL1MaxNits || 0, dvTrim: data.dvTrim || null });

    // Compute frameMaxNits from raw input pixels (before tone mapping).
    // Scan the first component/plane which is Y (YUV) or R (RGB) — good
    // enough for a peak-nits estimate without full decode.
    let frameMaxNits = 0;
    if (data.transfer && /PQ|2084/i.test(data.transfer) && pixels.length > 0) {
      const bps  = data.bitsPerSample || 8;
      const pqFullRange = Math.max(1, (1 << bps) - 1);
      // For YUV limited-range: Y is in [16*s, 235*s] where s = 1<<(bps-8)
      const isYuv = data.sampleLayout === 'yuv420p' || data.sampleLayout === 'yuv422p';
      const s = 1 << (bps - 8);
      const yLow = 16 * s, yHigh = 235 * s;
      // Scan only first plane (Y or R) — stride by componentCount for interleaved
      const comps = Math.max(1, data.componentCount || 1);
      const scanStride = data.sampleLayout === 'interleaved' ? comps : 1;
      const scanLen = data.sampleLayout === 'planar'
        ? Math.floor(pixels.length / comps)
        : (isYuv ? Math.floor(pixels.length / comps) : pixels.length);
      const step = Math.max(1, Math.floor(scanLen / 4000));
      let maxPq = 0;
      for (let i = 0; i < scanLen; i += step * scanStride) {
        const raw = pixels[i] || 0;
        const norm = isYuv
          ? Math.max(0, (raw - yLow) / (yHigh - yLow))
          : (data.isSigned ? (raw + (1 << (bps - 1))) : raw) / pqFullRange;
        if (norm > maxPq) maxPq = norm;
      }
      frameMaxNits = Math.round(pqToLinear01(maxPq) * 10000);
    }

    let bitmap = null;
    if (typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function') {
      const oc = new OffscreenCanvas(rgba.outW, rgba.outH);
      const ctx = oc.getContext('2d', { alpha: false, desynchronized: true });
      const img = new ImageData(rgba.out, rgba.outW, rgba.outH);
      ctx.putImageData(img, 0, 0);
      bitmap = await createImageBitmap(oc);
    }

    let scopeBuffer = null, scopeW = 0, scopeH = 0;
    if (data.needScope !== false) {
      const targetW = Math.min(rgba.outW, 320);
      const targetH = Math.max(1, Math.round(rgba.outH * targetW / rgba.outW));
      if (typeof OffscreenCanvas === 'function') {
        const src = new OffscreenCanvas(rgba.outW, rgba.outH);
        const sctx = src.getContext('2d', { alpha: false, desynchronized: true });
        sctx.putImageData(new ImageData(rgba.out, rgba.outW, rgba.outH), 0, 0);
        const dst = new OffscreenCanvas(targetW, targetH);
        const dctx = dst.getContext('2d', { alpha: false, desynchronized: true });
        dctx.drawImage(src, 0, 0, targetW, targetH);
        const scope = dctx.getImageData(0, 0, targetW, targetH);
        scopeBuffer = scope.data.buffer;
        scopeW = targetW;
        scopeH = targetH;
      } else {
        scopeBuffer = rgba.out.buffer.slice(0);
        scopeW = rgba.outW;
        scopeH = rgba.outH;
      }
    }

    const msg = {
      id: data.id,
      ok: true,
      mode: bitmap ? 'worker-bitmap' : 'worker-rgba',
      scopeBuffer,
      scopeW,
      scopeH,
      frameMaxNits,
    };
    const transfer = [];
    if (bitmap) {
      msg.bitmap = bitmap;
      transfer.push(bitmap);
    } else {
      msg.imageBuffer = rgba.out.buffer;
      msg.imageWidth = rgba.outW;
      msg.imageHeight = rgba.outH;
      transfer.push(rgba.out.buffer);
    }
    if (scopeBuffer) transfer.push(scopeBuffer);
    self.postMessage(msg, transfer);
  } catch (e) {
    self.postMessage({ id: data.id, ok: false, error: e && e.message ? e.message : String(e) });
  }
};
