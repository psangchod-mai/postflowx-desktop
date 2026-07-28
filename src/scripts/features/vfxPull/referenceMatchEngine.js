/**
 * referenceMatchEngine.js
 * PostFlowX — VFX Pull
 *
 * Browser-side visual frame comparison engine (Canvas API, no external deps).
 * All image inputs are raw RGBA Uint8ClampedArray from ImageData.
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Average-pool RGBA pixel buffer down to targetW × targetH.
 * Returns a Float32Array of length targetW * targetH * 4 (RGBA).
 */
function _averagePool(rgba, srcW, srcH, targetW, targetH) {
  const out = new Float32Array(targetW * targetH * 4);
  const scaleX = srcW / targetW;
  const scaleY = srcH / targetH;

  for (let ty = 0; ty < targetH; ty++) {
    for (let tx = 0; tx < targetW; tx++) {
      const x0 = Math.floor(tx * scaleX);
      const x1 = Math.min(Math.ceil((tx + 1) * scaleX), srcW);
      const y0 = Math.floor(ty * scaleY);
      const y1 = Math.min(Math.ceil((ty + 1) * scaleY), srcH);

      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const idx = (sy * srcW + sx) * 4;
          r += rgba[idx];
          g += rgba[idx + 1];
          b += rgba[idx + 2];
          a += rgba[idx + 3];
          count++;
        }
      }
      const base = (ty * targetW + tx) * 4;
      out[base]     = r / count;
      out[base + 1] = g / count;
      out[base + 2] = b / count;
      out[base + 3] = a / count;
    }
  }
  return out;
}

/**
 * Convert RGBA Float32Array to grayscale Float32Array (luma BT.709).
 */
function _toGrayscale(rgba, len) {
  const gray = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const base = i * 4;
    gray[i] = 0.2126 * rgba[base] + 0.7152 * rgba[base + 1] + 0.0722 * rgba[base + 2];
  }
  return gray;
}

/**
 * 1D DCT-II on a Float32Array of length N, returns Float32Array of N coefficients.
 */
function _dct1d(signal) {
  const N = signal.length;
  const out = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    let sum = 0;
    for (let n = 0; n < N; n++) {
      sum += signal[n] * Math.cos((Math.PI / N) * (n + 0.5) * k);
    }
    out[k] = sum;
  }
  return out;
}

/**
 * Compute row-wise DCT on a W×H grayscale Float32Array.
 * Returns a Float32Array of same size with each row DCT-transformed.
 */
function _rowDCT(gray, W, H) {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = gray.subarray(y * W, y * W + W);
    const dctRow = _dct1d(row);
    out.set(dctRow, y * W);
  }
  return out;
}

/**
 * Count set bits in a BigInt (popcount for 64-bit value).
 */
function _popcount64(n) {
  let count = 0;
  let v = n < 0n ? -n : n; // treat as unsigned
  // XOR result is always positive for our use case, but guard anyway
  while (v > 0n) {
    v &= (v - 1n);
    count++;
  }
  return count;
}

/**
 * Median of a plain number array (modifies a copy).
 */
function _median(arr) {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Sobel magnitude at pixel (x, y) in a grayscale Uint8ClampedArray / array.
 * Requires access to the full buffer.
 */
function _sobelAt(gray, x, y, W, H) {
  // Clamp helpers
  const px = (cx, cy) => {
    const sx = Math.max(0, Math.min(cx, W - 1));
    const sy = Math.max(0, Math.min(cy, H - 1));
    return gray[sy * W + sx];
  };
  const gx =
    -px(x - 1, y - 1) + px(x + 1, y - 1) +
    -2 * px(x - 1, y) + 2 * px(x + 1, y) +
    -px(x - 1, y + 1) + px(x + 1, y + 1);
  const gy =
    -px(x - 1, y - 1) - 2 * px(x, y - 1) - px(x + 1, y - 1) +
     px(x - 1, y + 1) + 2 * px(x, y + 1) + px(x + 1, y + 1);
  return Math.sqrt(gx * gx + gy * gy);
}

/**
 * Compute luma value (BT.709) for an RGBA pixel at byte offset.
 */
function _lumaAt(rgba, offset) {
  return 0.2126 * rgba[offset] + 0.7152 * rgba[offset + 1] + 0.0722 * rgba[offset + 2];
}

/**
 * Row average luma for a single row in the image.
 */
function _rowAvgLuma(rgba, y, width) {
  let sum = 0;
  for (let x = 0; x < width; x++) {
    sum += _lumaAt(rgba, (y * width + x) * 4);
  }
  return sum / width;
}

/**
 * Column average luma for a single column.
 */
function _colAvgLuma(rgba, x, width, height) {
  let sum = 0;
  for (let y = 0; y < height; y++) {
    sum += _lumaAt(rgba, (y * width + x) * 4);
  }
  return sum / height;
}

/**
 * Compute median R, G, B of a rectangular patch (no alloc-heavy sorting —
 * uses a simple selection on collected samples).
 */
function _patchMedianRGB(rgba, px, py, pw, ph, imgW) {
  const rs = [], gs = [], bs = [];
  for (let y = py; y < py + ph; y++) {
    for (let x = px; x < px + pw; x++) {
      const idx = (y * imgW + x) * 4;
      rs.push(rgba[idx]);
      gs.push(rgba[idx + 1]);
      bs.push(rgba[idx + 2]);
    }
  }
  return [_median(rs), _median(gs), _median(bs)];
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/**
 * Build a perceptual fingerprint for a frame.
 *
 * @param {Uint8ClampedArray} imageData - Raw RGBA bytes
 * @param {number} width
 * @param {number} height
 * @returns {{ lumaHist, rgbHist, pHash, edgeHash, activeArea }}
 */
export function buildFrameFingerprint(imageData, width, height) {
  // --- Luma histogram (64 buckets) ---
  const lumaHistRaw = new Float32Array(64);
  for (let i = 0; i < width * height; i++) {
    const base = i * 4;
    const luma = _lumaAt(imageData, base);
    const bucket = Math.min(63, Math.floor(luma / 4)); // 256/64 = 4
    lumaHistRaw[bucket]++;
  }
  const totalPx = width * height;
  const lumaHist = Array.from(lumaHistRaw).map(v => v / totalPx);

  // --- RGB histograms (32 buckets each) ---
  const rRaw = new Float32Array(32);
  const gRaw = new Float32Array(32);
  const bRaw = new Float32Array(32);
  for (let i = 0; i < totalPx; i++) {
    const base = i * 4;
    rRaw[Math.min(31, imageData[base]     >> 3)]++;
    gRaw[Math.min(31, imageData[base + 1] >> 3)]++;
    bRaw[Math.min(31, imageData[base + 2] >> 3)]++;
  }
  const rgbHist = {
    r: Array.from(rRaw).map(v => v / totalPx),
    g: Array.from(gRaw).map(v => v / totalPx),
    b: Array.from(bRaw).map(v => v / totalPx),
  };

  // --- pHash ---
  // 1. Average-pool to 32×32
  const pooled32 = _averagePool(imageData, width, height, 32, 32);
  // 2. Grayscale
  const gray32 = _toGrayscale(pooled32, 32 * 32);
  // 3. Row DCT (8 terms per row)
  const dctBuf = _rowDCT(gray32, 32, 32);
  // 4. Collect first 64 DCT coefficients (first 2 terms of each row, 32 rows)
  const dctVals = new Float32Array(64);
  for (let row = 0; row < 32; row++) {
    if (row * 2 >= 64) break;
    dctVals[row * 2]     = dctBuf[row * 32 + 1]; // skip DC (index 0)
    dctVals[row * 2 + 1] = dctBuf[row * 32 + 2];
  }
  const dctMedian = _median(Array.from(dctVals));
  let pHash = 0n;
  for (let i = 0; i < 64; i++) {
    if (dctVals[i] > dctMedian) {
      pHash |= (1n << BigInt(i));
    }
  }

  // --- edgeHash (32-bit, 4×4 grid of Sobel-quantized regions) ---
  // Build grayscale luma buffer at full resolution for Sobel
  const grayFull = new Float32Array(totalPx);
  for (let i = 0; i < totalPx; i++) {
    grayFull[i] = _lumaAt(imageData, i * 4);
  }
  const regionW = Math.floor(width / 4);
  const regionH = Math.floor(height / 4);
  let edgeHash = 0;
  for (let ry = 0; ry < 4; ry++) {
    for (let rx = 0; rx < 4; rx++) {
      let sobelSum = 0;
      let sobelCount = 0;
      const x0 = rx * regionW;
      const y0 = ry * regionH;
      // Sample every 4th pixel to keep it fast
      for (let sy = y0; sy < y0 + regionH; sy += 4) {
        for (let sx = x0; sx < x0 + regionW; sx += 4) {
          sobelSum += _sobelAt(grayFull, sx, sy, width, height);
          sobelCount++;
        }
      }
      const avgSobel = sobelCount > 0 ? sobelSum / sobelCount : 0;
      // Quantize to 2 bits (0-3)
      let qval;
      if (avgSobel < 10)      qval = 0;
      else if (avgSobel < 25) qval = 1;
      else if (avgSobel < 50) qval = 2;
      else                    qval = 3;
      edgeHash |= (qval << ((ry * 4 + rx) * 2));
    }
  }

  // --- Active area (exclude black bars) ---
  const lb = detectLetterboxPillarbox(imageData, width, height);
  const activeArea = {
    x: lb.leftBlackCols,
    y: lb.topBlackRows,
    w: width  - lb.leftBlackCols - lb.rightBlackCols,
    h: height - lb.topBlackRows  - lb.bottomBlackRows,
  };

  return { lumaHist, rgbHist, pHash, edgeHash, activeArea };
}

/**
 * Compare two fingerprints and return similarity scores.
 *
 * @param {{ lumaHist, rgbHist, pHash, edgeHash }} fpA
 * @param {{ lumaHist, rgbHist, pHash, edgeHash }} fpB
 * @returns {{ score, lumaScore, rgbScore, phashScore, edgeScore }}
 */
export function compareFingerprints(fpA, fpB) {
  // Luma histogram intersection
  let lumaIntersect = 0;
  for (let i = 0; i < 64; i++) {
    lumaIntersect += Math.min(fpA.lumaHist[i], fpB.lumaHist[i]);
  }
  const lumaScore = lumaIntersect * 100; // already normalized 0-1 each bucket

  // RGB histogram intersection
  const channels = ['r', 'g', 'b'];
  let rgbSum = 0;
  for (const ch of channels) {
    let inter = 0;
    for (let i = 0; i < 32; i++) {
      inter += Math.min(fpA.rgbHist[ch][i], fpB.rgbHist[ch][i]);
    }
    rgbSum += inter * 100;
  }
  const rgbScore = rgbSum / 3;

  // pHash Hamming distance
  const xorVal = fpA.pHash ^ fpB.pHash;
  const hammingDist = _popcount64(xorVal);
  const phashScore = 100 - (hammingDist / 64) * 100;

  // edgeHash bit match percentage
  const edgeXor = (fpA.edgeHash ^ fpB.edgeHash) >>> 0;
  let edgeMismatch = 0;
  let v = edgeXor;
  while (v) {
    v &= (v - 1);
    edgeMismatch++;
  }
  const edgeScore = 100 - (edgeMismatch / 32) * 100;

  const score =
    lumaScore  * 0.30 +
    rgbScore   * 0.35 +
    phashScore * 0.25 +
    edgeScore  * 0.10;

  return {
    score:      Math.max(0, Math.min(100, score)),
    lumaScore:  Math.max(0, Math.min(100, lumaScore)),
    rgbScore:   Math.max(0, Math.min(100, rgbScore)),
    phashScore: Math.max(0, Math.min(100, phashScore)),
    edgeScore:  Math.max(0, Math.min(100, edgeScore)),
  };
}

/**
 * Detect letterbox and/or pillarbox black bars.
 *
 * @param {Uint8ClampedArray} imageData
 * @param {number} width
 * @param {number} height
 * @returns {{ hasLetterbox, hasPillarbox, topBlackRows, bottomBlackRows,
 *             leftBlackCols, rightBlackCols, activeCrop: [x,y,w,h] }}
 */
export function detectLetterboxPillarbox(imageData, width, height) {
  const BLACK_THRESH = 12;

  let topBlackRows = 0;
  for (let y = 0; y < height; y++) {
    if (_rowAvgLuma(imageData, y, width) < BLACK_THRESH) topBlackRows++;
    else break;
  }

  let bottomBlackRows = 0;
  for (let y = height - 1; y >= 0; y--) {
    if (_rowAvgLuma(imageData, y, width) < BLACK_THRESH) bottomBlackRows++;
    else break;
  }

  let leftBlackCols = 0;
  for (let x = 0; x < width; x++) {
    if (_colAvgLuma(imageData, x, width, height) < BLACK_THRESH) leftBlackCols++;
    else break;
  }

  let rightBlackCols = 0;
  for (let x = width - 1; x >= 0; x--) {
    if (_colAvgLuma(imageData, x, width, height) < BLACK_THRESH) rightBlackCols++;
    else break;
  }

  // An all-black frame (fade, slate, black handle) makes both directional scans
  // count the full dimension, which would yield a negative active crop and a
  // negative reformat scale downstream. Treat it as "no bars" / full frame.
  if (topBlackRows + bottomBlackRows >= height) { topBlackRows = 0; bottomBlackRows = 0; }
  if (leftBlackCols + rightBlackCols >= width)  { leftBlackCols = 0; rightBlackCols = 0; }

  const hasLetterbox = (topBlackRows + bottomBlackRows) > height * 0.05;
  const hasPillarbox = (leftBlackCols + rightBlackCols) > width * 0.05;

  const activeCrop = [
    leftBlackCols,
    topBlackRows,
    width  - leftBlackCols - rightBlackCols,
    height - topBlackRows  - bottomBlackRows,
  ];

  return {
    hasLetterbox,
    hasPillarbox,
    topBlackRows,
    bottomBlackRows,
    leftBlackCols,
    rightBlackCols,
    activeCrop,
  };
}

/**
 * Compute reformat (scale + crop) parameters to match OCF to a reference frame.
 *
 * @param {number} refWidth
 * @param {number} refHeight
 * @param {number} ocfWidth
 * @param {number} ocfHeight
 * @param {object} letterboxInfo - result of detectLetterboxPillarbox on the OCF frame
 * @returns {{ scale, cropBox, fit, notes }}
 */
export function computeReformatParams(refWidth, refHeight, ocfWidth, ocfHeight, letterboxInfo) {
  let cropBox;
  let activeOcfWidth  = ocfWidth;
  let activeOcfHeight = ocfHeight;

  if (letterboxInfo && letterboxInfo.activeCrop) {
    const [cx, cy, cw, ch] = letterboxInfo.activeCrop;
    cropBox = [cx, cy, cx + cw, cy + ch];
    activeOcfWidth  = cw;
    activeOcfHeight = ch;
  } else {
    cropBox = [0, 0, ocfWidth, ocfHeight];
  }

  const scaleW = refWidth  / activeOcfWidth;
  const scaleH = refHeight / activeOcfHeight;

  const ocfAR = ocfWidth / ocfHeight;
  const refAR = refWidth / refHeight;
  const fit   = ocfAR >= refAR ? 'centerCrop' : 'fit';

  // centerCrop must cover the reference on both axes (the larger scale factor,
  // cropping the excess); fit must contain the OCF within it (the smaller factor).
  const scale = fit === 'centerCrop' ? Math.max(scaleW, scaleH) : Math.min(scaleW, scaleH);

  const scaleStr = scale.toFixed(3);
  const notes =
    `OCF ${ocfWidth}×${ocfHeight} (active ${activeOcfWidth}×${activeOcfHeight}) → Ref ${refWidth}×${refHeight}` +
    ` (scale ${scaleStr}), ${fit === 'centerCrop' ? 'center crop to' : 'fit to'} ` +
    `${(refWidth / refHeight).toFixed(2).replace('.', ':')} AR`;

  return { scale, cropBox, fit, notes };
}

/**
 * Estimate CDL (SOP + saturation) correction from reference vs OCF frames.
 *
 * @param {Uint8ClampedArray} refImageData
 * @param {Uint8ClampedArray} ocfImageData
 * @param {number} refWidth
 * @param {number} refHeight
 * @param {number} ocfWidth
 * @param {number} ocfHeight
 * @returns {{ slope, offset, power, sat, confidence, warnings }}
 */
export function estimateCDL(
  refImageData, ocfImageData,
  refWidth, refHeight,
  ocfWidth, ocfHeight
) {
  const warnings = [];
  const clampSlope = v => Math.max(0.25, Math.min(4.0, Number(v) || 1));
  const clampOffset = v => Math.max(-0.25, Math.min(0.25, Number(v) || 0));
  const IDENTITY = {
    slope:      [1, 1, 1],
    offset:     [0, 0, 0],
    power:      [1, 1, 1],
    sat:        1.0,
    confidence: 0,
    warnings,
  };

  warnings.push('Reference match CDL is a preview only — not a final DI grade.');

  if (ocfWidth === refWidth && ocfHeight === refHeight) {
    warnings.push(
      'OCF and reference share identical resolution — this may be a proxy reference; CDL may not reflect true OCF color.'
    );
  }

  // Check for burn-in (high-contrast patterns in corners)
  const cornerSize5PctW = Math.floor(refWidth  * 0.05);
  const cornerSize5PctH = Math.floor(refHeight * 0.05);
  const corners = [
    [0, 0],
    [refWidth - cornerSize5PctW, 0],
    [0, refHeight - cornerSize5PctH],
    [refWidth - cornerSize5PctW, refHeight - cornerSize5PctH],
  ];
  for (const [cx, cy] of corners) {
    const pw = Math.max(1, cornerSize5PctW);
    const ph = Math.max(1, cornerSize5PctH);
    // Measure variance in patch — high variance → text/burn-in
    let lumaSamples = [];
    for (let y = cy; y < cy + ph && y < refHeight; y++) {
      for (let x = cx; x < cx + pw && x < refWidth; x++) {
        lumaSamples.push(_lumaAt(refImageData, (y * refWidth + x) * 4));
      }
    }
    if (lumaSamples.length > 0) {
      const mean = lumaSamples.reduce((a, b) => a + b, 0) / lumaSamples.length;
      const variance = lumaSamples.reduce((a, v) => a + (v - mean) ** 2, 0) / lumaSamples.length;
      if (variance > 1200) { // std-dev > ~34 — strongly mixed bright/dark = text
        warnings.push(
          'Possible burn-in detected in reference frame corner — CDL may be skewed by overlaid text or timecode.'
        );
        break;
      }
    }
  }

  // Build 5×5 sampling grid, avoid outer 10%
  const marginRefX = Math.floor(refWidth  * 0.10);
  const marginRefY = Math.floor(refHeight * 0.10);
  const activeRefW = refWidth  - 2 * marginRefX;
  const activeRefH = refHeight - 2 * marginRefY;
  const patchW_ref = Math.max(4, Math.floor(activeRefW / 5));
  const patchH_ref = Math.max(4, Math.floor(activeRefH / 5));

  const marginOcfX = Math.floor(ocfWidth  * 0.10);
  const marginOcfY = Math.floor(ocfHeight * 0.10);
  const activeOcfW = ocfWidth  - 2 * marginOcfX;
  const activeOcfH = ocfHeight - 2 * marginOcfY;
  const patchW_ocf = Math.max(4, Math.floor(activeOcfW / 5));
  const patchH_ocf = Math.max(4, Math.floor(activeOcfH / 5));

  const slopes_r  = [], slopes_g  = [], slopes_b  = [];
  const offsets_r = [], offsets_g = [], offsets_b = [];
  // Normalised (0–1) per-patch medians kept so power (gamma) and saturation
  // can be solved after the SOP slope/offset medians are known.
  const refN_r = [], refN_g = [], refN_b = [];
  const ocfN_r = [], ocfN_g = [], ocfN_b = [];
  let validPatches = 0;

  for (let gy = 0; gy < 5; gy++) {
    for (let gx = 0; gx < 5; gx++) {
      const rpx = marginRefX + Math.floor(gx * (activeRefW / 5));
      const rpy = marginRefY + Math.floor(gy * (activeRefH / 5));
      const opx = marginOcfX + Math.floor(gx * (activeOcfW / 5));
      const opy = marginOcfY + Math.floor(gy * (activeOcfH / 5));

      const [rR, rG, rB] = _patchMedianRGB(refImageData, rpx, rpy, patchW_ref, patchH_ref, refWidth);
      const [oR, oG, oB] = _patchMedianRGB(ocfImageData, opx, opy, patchW_ocf, patchH_ocf, ocfWidth);

      // Filter overexposed / underexposed
      if (
        Math.max(rR, rG, rB) > 240 || Math.min(rR, rG, rB) < 8 ||
        Math.max(oR, oG, oB) > 240 || Math.min(oR, oG, oB) < 8
      ) continue;

      validPatches++;

      // slope = ref / ocf  (we want to bring OCF into ref color space)
      const sR = oR > 0 ? clampSlope(rR / oR) : 1;
      const sG = oG > 0 ? clampSlope(rG / oG) : 1;
      const sB = oB > 0 ? clampSlope(rB / oB) : 1;

      slopes_r.push(sR); slopes_g.push(sG); slopes_b.push(sB);

      // offset = ref_channel - slope * ocf_channel
      offsets_r.push(clampOffset(rR / 255 - sR * oR / 255));
      offsets_g.push(clampOffset(rG / 255 - sG * oG / 255));
      offsets_b.push(clampOffset(rB / 255 - sB * oB / 255));

      // Keep normalised medians for the power/saturation solve below.
      refN_r.push(rR / 255); refN_g.push(rG / 255); refN_b.push(rB / 255);
      ocfN_r.push(oR / 255); ocfN_g.push(oG / 255); ocfN_b.push(oB / 255);
    }
  }

  if (validPatches < 4) {
    warnings.push(
      `Only ${validPatches} valid patch(es) found (need ≥ 4) — returning identity CDL with confidence 0.`
    );
    return IDENTITY;
  }

  const slope_r = _median(slopes_r);
  const slope_g = _median(slopes_g);
  const slope_b = _median(slopes_b);

  const offset_r = _median(offsets_r);
  const offset_g = _median(offsets_g);
  const offset_b = _median(offsets_b);

  // ── Power (gamma) solve ──────────────────────────────────────────────────
  // CDL applies out = (in·slope + offset)^power. After the median slope/offset
  // bring the OCF into range, any residual mid-tone bias is corrected by power.
  // Solve per channel: power = ln(ref) / ln(SOP-corrected OCF), using only
  // mid-range patches (extremes make the log unstable), then take the median.
  const _clamp01 = v => Math.min(0.999, Math.max(0.001, v));
  const solvePower = (refN, ocfN, slope, offset) => {
    const ps = [];
    for (let i = 0; i < refN.length; i++) {
      const corr = _clamp01(ocfN[i] * slope + offset);
      const tgt  = _clamp01(refN[i]);
      // Skip near-black / near-white where small errors blow up the exponent.
      if (corr < 0.06 || corr > 0.94 || tgt < 0.06 || tgt > 0.94) continue;
      const p = Math.log(tgt) / Math.log(corr);
      if (Number.isFinite(p) && p > 0) ps.push(p);
    }
    if (ps.length < 3) return 1.0;          // not enough mid-range data — identity
    return Math.max(0.5, Math.min(2.0, _median(ps)));
  };
  const power_r = solvePower(refN_r, ocfN_r, slope_r, offset_r);
  const power_g = solvePower(refN_g, ocfN_g, slope_g, offset_g);
  const power_b = solvePower(refN_b, ocfN_b, slope_b, offset_b);

  // ── Saturation solve ─────────────────────────────────────────────────────
  // Compare the chroma spread (distance of RGB from its Rec.709 luma) of the
  // reference vs the SOP-corrected OCF. sat = median(refChroma / corrChroma)
  // over patches with meaningful chroma (skips near-neutral patches).
  const LR = 0.2126, LG = 0.7152, LB = 0.0722;
  const satRatios = [];
  for (let i = 0; i < refN_r.length; i++) {
    const rL = LR * refN_r[i] + LG * refN_g[i] + LB * refN_b[i];
    const cr = _clamp01(ocfN_r[i] * slope_r + offset_r);
    const cg = _clamp01(ocfN_g[i] * slope_g + offset_g);
    const cb = _clamp01(ocfN_b[i] * slope_b + offset_b);
    const cL = LR * cr + LG * cg + LB * cb;
    const refChroma  = Math.hypot(refN_r[i] - rL, refN_g[i] - rL, refN_b[i] - rL);
    const corrChroma = Math.hypot(cr - cL, cg - cL, cb - cL);
    if (corrChroma > 0.02) satRatios.push(refChroma / corrChroma);
  }
  const sat = satRatios.length >= 3
    ? Math.max(0.5, Math.min(1.8, _median(satRatios)))
    : 1.0;

  const powerSolved = (power_r !== 1.0 || power_g !== 1.0 || power_b !== 1.0);
  const satSolved   = (sat !== 1.0);
  if (!powerSolved && !satSolved) {
    warnings.push('Power/saturation left at identity — not enough mid-range/chromatic patches to solve them.');
  }

  // Confidence: scale by patch count (max 25) and slope consistency (low std-dev = good)
  const patchScore = Math.min(100, (validPatches / 25) * 60); // up to 60 points for patch coverage
  const slopeStdR = _stdDev(slopes_r, slope_r);
  const slopeStdG = _stdDev(slopes_g, slope_g);
  const slopeStdB = _stdDev(slopes_b, slope_b);
  const avgStd = (slopeStdR + slopeStdG + slopeStdB) / 3;
  // Lower std-dev = higher consistency score (up to 40 points)
  const consistencyScore = Math.max(0, 40 - avgStd * 200);
  const confidence = Math.round(Math.min(100, patchScore + consistencyScore));

  return {
    slope:  [slope_r, slope_g, slope_b],
    offset: [offset_r, offset_g, offset_b],
    power:  [power_r, power_g, power_b],
    sat,
    confidence,
    warnings,
  };
}

/**
 * Find the best frame offset between reference keyframes and OCF keyframes.
 *
 * @param {Array} refFingerprints  - Array of fingerprints at reference keyframes
 * @param {Array} ocfFingerprints  - Array of fingerprints at OCF keyframes
 * @param {number} [searchWindowFrames=48]
 * @returns {{ offsetFrames, confidence, searchRange }}
 */
export function findBestFrameOffset(refFingerprints, ocfFingerprints, searchWindowFrames = 48) {
  const refLen = refFingerprints.length;
  const ocfLen = ocfFingerprints.length;

  let bestOffset = 0;
  let bestScore  = -1;

  for (let offset = -searchWindowFrames; offset <= searchWindowFrames; offset++) {
    let totalScore = 0;
    let pairs = 0;

    for (let ri = 0; ri < refLen; ri++) {
      const oi = ri + offset;
      if (oi < 0 || oi >= ocfLen) continue;
      const cmp = compareFingerprints(refFingerprints[ri], ocfFingerprints[oi]);
      totalScore += cmp.score;
      pairs++;
    }

    if (pairs === 0) continue;
    const avgScore = totalScore / pairs;
    if (avgScore > bestScore) {
      bestScore  = avgScore;
      bestOffset = offset;
    }
  }

  return {
    offsetFrames: bestOffset,
    confidence:   Math.max(0, Math.min(100, bestScore)),
    searchRange:  [-searchWindowFrames, searchWindowFrames],
  };
}

/**
 * Pick the best OCF candidate from visual-similarity scores, with a margin
 * guard so an ambiguous tie never auto-relinks. Pure / unit-testable.
 *
 * @param {Array<{index:number, score:number, label?:string}>} scored
 * @param {{minScore?:number, minMargin?:number}} [opts]
 *   minScore  — the winner must reach this similarity (default 60)
 *   minMargin — the winner must beat the runner-up by this much (default 8)
 * @returns {{ best, runnerUp, confident:boolean, margin:number, ranked, reason }}
 */
export function pickVisualMatch(scored, opts = {}) {
  const minScore  = opts.minScore  ?? 60;
  const minMargin = opts.minMargin ?? 8;
  const ranked = (Array.isArray(scored) ? scored.filter(s => s && Number.isFinite(Number(s.score))) : [])
    .map(s => ({ ...s, score: Number(s.score) }))
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return { best: null, runnerUp: null, confident: false, margin: 0, ranked, reason: 'No candidates to compare.' };
  }
  const best     = ranked[0];
  const runnerUp = ranked[1] || null;
  const margin   = runnerUp ? best.score - runnerUp.score : best.score;

  let confident = true;
  let reason = `Image match ${Math.round(best.score)}%`;
  if (best.score < minScore) {
    confident = false;
    reason = `Top image match only ${Math.round(best.score)}% (need ≥ ${minScore}%) — verify manually.`;
  } else if (runnerUp && margin < minMargin) {
    confident = false;
    reason = `Ambiguous: top two candidates within ${Math.round(margin)}% — verify manually.`;
  }
  return { best, runnerUp, confident, margin, ranked, reason };
}

/**
 * Extract luma histogram from a region of a canvas (fast helper).
 *
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @returns {Uint32Array} 256-bucket luma histogram (not normalized)
 */
export function buildFrameHistogramFromCanvas(canvas, ctx, x, y, w, h) {
  const hist = new Uint32Array(256);
  const imageData = ctx.getImageData(x, y, w, h);
  const data = imageData.data;
  const total = w * h;
  for (let i = 0; i < total; i++) {
    const base = i * 4;
    const luma = Math.round(
      0.2126 * data[base] + 0.7152 * data[base + 1] + 0.0722 * data[base + 2]
    );
    hist[Math.max(0, Math.min(255, luma))]++;
  }
  return hist;
}

// ---------------------------------------------------------------------------
// Private helper used only in estimateCDL
// ---------------------------------------------------------------------------

function _stdDev(arr, mean) {
  if (arr.length < 2) return 0;
  const variance = arr.reduce((acc, v) => acc + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}
