"use strict";

console.log('[J2K-SBX] sandbox decoder boot v27');

let htModulePromise = null;
let htModuleInstance = null;
let classicModulePromise = null;
let classicDecoder = null;
let pureFallbackPromise = null;
let pureFallback = null;
const bootState = { classicReady: false, htReady: false, bootReported: false };

function postBootState(target = window.parent) {
  try {
    target?.postMessage({
      source: 'PFX_J2K_SANDBOX',
      type: (bootState.classicReady || bootState.htReady) ? 'PFX_J2K_SANDBOX_READY' : 'PFX_J2K_SANDBOX_ERROR',
      classicReady: !!bootState.classicReady,
      htReady: !!bootState.htReady,
      error: (bootState.classicReady || bootState.htReady) ? undefined : 'No decoder backend initialized',
    }, '*');
  } catch (_) {}
}

function loadHTModule() {
  if (htModulePromise) return htModulePromise;
  htModulePromise = new Promise((resolve) => {
    try {
      // Pre-fetch WASM bytes via XHR before loading openjphjs.js.
      // openjphjs.js uses fetch(wasmBinaryFile, {credentials:'same-origin'}) internally,
      // which fails for file:// URLs inside Electron asar packages (Electron 42+).
      // XHR works for asar file:// — same pattern openjpeg_port.js (classic decoder) uses.
      // Injecting Module.wasmBinary before the script runs causes openjphjs.js line 311
      // (if (Module['wasmBinary']) wasmBinary = ...) to capture the bytes, short-circuiting
      // both getBinaryPromise() fetch paths (lines 789 and 868 both gate on !wasmBinary).
      const wasmXhr = new XMLHttpRequest();
      wasmXhr.open('GET', '../assets/imf/openjphjs.wasm', true);
      wasmXhr.responseType = 'arraybuffer';
      wasmXhr.onload = () => {
        if (wasmXhr.status !== 200 && wasmXhr.status !== 0) {
          console.warn('[J2K-SBX] OpenJPH WASM XHR failed, status:', wasmXhr.status);
          resolve(null);
          return;
        }
        _loadHTScript(new Uint8Array(wasmXhr.response), resolve);
      };
      wasmXhr.onerror = () => {
        console.warn('[J2K-SBX] OpenJPH WASM XHR error');
        resolve(null);
      };
      wasmXhr.send();
    } catch (e) {
      console.warn('[J2K-SBX] OpenJPH load error', e);
      resolve(null);
    }
  });
  return htModulePromise;
}

function _loadHTScript(wasmBytes, resolve) {
  try {
    const prevModule = window.Module;
    const script = document.createElement('script');
    script.src = '../assets/imf/openjphjs.js?v=2026-04-07-sbx-v21';
    script.onload = () => {
      // openjphjs.js structure: var Module = (() => { return (function(Module) {...}); })()
      // The IIFE sets window.Module to a factory function and takes NO input from window.Module.
      // wasmBinary must be passed as an argument to the factory — NOT pre-injected into window.Module.
      const exported = window.Module;
      window.Module = prevModule;

      const finalize = (m) => {
        if (!m) {
          console.warn('[J2K-SBX] OpenJPH module missing after load');
          resolve(null);
          return;
        }
        htModuleInstance = m;
        try {
          console.log(`[J2K-SBX] OpenJPH ready v${m.getVersion?.() ?? '?'} (HTJ2K)`);
        } catch (_) {
          console.log('[J2K-SBX] OpenJPH ready (HTJ2K)');
        }
        resolve(m);
      };

      try {
        if (typeof exported === 'function') {
          // Pass wasmBinary directly to the factory so line 311 inside the factory
          // (if (Module['wasmBinary']) wasmBinary = Module['wasmBinary']) picks it up,
          // which gates out both fetch() branches in getBinaryPromise() (lines 789, 868).
          const ready = exported({
            locateFile: (path) => path.endsWith('.wasm') ? '../assets/imf/openjphjs.wasm' : path,
            wasmBinary: wasmBytes,
          });
          Promise.resolve(ready).then(finalize).catch((e) => {
            console.warn('[J2K-SBX] OpenJPH factory init failed', e);
            resolve(null);
          });
          return;
        }

        if (exported && typeof exported.then === 'function') {
          Promise.resolve(exported).then(finalize).catch((e) => {
            console.warn('[J2K-SBX] OpenJPH promise init failed', e);
            resolve(null);
          });
          return;
        }

        if (exported && exported.ready && typeof exported.ready.then === 'function') {
          Promise.resolve(exported.ready).then(() => finalize(exported)).catch((e) => {
            console.warn('[J2K-SBX] OpenJPH ready() init failed', e);
            resolve(null);
          });
          return;
        }

        if (exported && typeof exported === 'object') {
          finalize(exported);
          return;
        }

        console.warn('[J2K-SBX] OpenJPH export missing/unknown', typeof exported);
        resolve(null);
      } catch (e) {
        console.warn('[J2K-SBX] OpenJPH init failed', e);
        resolve(null);
      }
    };
    script.onerror = (e) => {
      console.warn('[J2K-SBX] OpenJPH script load failed', e);
      window.Module = prevModule;
      resolve(null);
    };
    document.head.appendChild(script);
  } catch (e) {
    console.warn('[J2K-SBX] OpenJPH load error', e);
    resolve(null);
  }
}

function loadClassicModule() {
  if (classicModulePromise) return classicModulePromise;
  classicModulePromise = new Promise((resolve) => {
    try {
      const script = document.createElement('script');
      script.src = '../assets/imf/openjpeg_port.js?v=2026-04-07-openjpeg-v23';
      script.onload = () => {
        if (typeof window.openjpeg === 'function') {
          classicDecoder = window.openjpeg;
          console.log('[J2K-SBX] Classic OpenJPEG decoder ready (j2k.js port)');
          resolve(classicDecoder);
        } else {
          console.warn('[J2K-SBX] Classic OpenJPEG decoder missing global');
          resolve(null);
        }
      };
      script.onerror = (e) => {
        console.warn('[J2K-SBX] Classic OpenJPEG script load failed', e);
        resolve(null);
      };
      document.head.appendChild(script);
    } catch (e) {
      console.warn('[J2K-SBX] Classic OpenJPEG load error', e);
      resolve(null);
    }
  });
  return classicModulePromise;
}

async function loadPureFallback() {
  if (pureFallbackPromise) return pureFallbackPromise;
  pureFallbackPromise = import('../assets/imf/jpeg2000_pure.js?v=2026-04-07-fallback-v19')
    .then((m) => {
      pureFallback = m;
      console.log('[J2K-SBX] Pure JS fallback decoder ready');
      return m;
    })
    .catch((e) => {
      console.warn('[J2K-SBX] Pure JS fallback import failed', e);
      return null;
    });
  return pureFallbackPromise;
}

function readUint16BE(bytes, off) {
  return ((bytes[off] & 0xff) << 8) | (bytes[off + 1] & 0xff);
}

function sniffCodestream(bytes) {
  const info = { kind: 'unknown', rsiz: null, markerOffset: -1 };
  if (!bytes || bytes.length < 8) return info;
  if (bytes[0] !== 0xFF || bytes[1] !== 0x4F) return info;
  const lim = Math.min(bytes.length - 6, 8192);
  for (let i = 2; i < lim; i++) {
    if (bytes[i] === 0xFF && bytes[i + 1] === 0x51) {
      const rsiz = readUint16BE(bytes, i + 4);
      info.rsiz = rsiz;
      info.markerOffset = i;
      info.kind = (rsiz & 0x4000) ? 'htj2k' : 'j2k';
      return info;
    }
  }
  info.kind = 'j2k';
  return info;
}

function trimToCodestream(bytes) {
  if (!bytes || bytes.length < 4) return bytes;
  let start = 0;
  for (let i = 0; i + 1 < Math.min(bytes.length, 4096); i++) {
    if (bytes[i] === 0xFF && bytes[i + 1] === 0x4F) { start = i; break; }
  }
  let end = bytes.length;
  for (let i = start + 2; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0xFF && bytes[i + 1] === 0xD9) { end = i + 2; break; }
  }
  return bytes.slice(start, end);
}


function parseSIZ(bytes) {
  const info = { width: null, height: null, componentCount: null, bitsPerSample: null, isSigned: false };
  if (!bytes || bytes.length < 48 || bytes[0] !== 0xFF || bytes[1] !== 0x4F) return info;
  const lim = Math.min(bytes.length - 36, 65536);
  for (let i = 2; i < lim; i++) {
    if (bytes[i] === 0xFF && bytes[i + 1] === 0x51) {
      const lsiz = readUint16BE(bytes, i + 2);
      const xsiz = (bytes[i + 6] << 24) | (bytes[i + 7] << 16) | (bytes[i + 8] << 8) | bytes[i + 9];
      const ysiz = (bytes[i + 10] << 24) | (bytes[i + 11] << 16) | (bytes[i + 12] << 8) | bytes[i + 13];
      const xosiz = (bytes[i + 14] << 24) | (bytes[i + 15] << 16) | (bytes[i + 16] << 8) | bytes[i + 17];
      const yosiz = (bytes[i + 18] << 24) | (bytes[i + 19] << 16) | (bytes[i + 20] << 8) | bytes[i + 21];
      const csiz = readUint16BE(bytes, i + 38);
      let ssiz = 7;
      if (i + 41 < bytes.length) ssiz = bytes[i + 40];
      info.width = (xsiz - xosiz) >>> 0;
      info.height = (ysiz - yosiz) >>> 0;
      info.componentCount = csiz;
      info.bitsPerSample = (ssiz & 0x7F) + 1;
      info.isSigned = !!(ssiz & 0x80);
      info.markerLength = lsiz;
      return info;
    }
  }
  return info;
}

function decodeHTBytes(bytes, reduceLevel = 0) {
  if (!htModuleInstance) throw new Error('HTJ2K decoder module unavailable');
  const reduce = Math.max(0, reduceLevel | 0);
  const decoder = new htModuleInstance.HTJ2KDecoder();
  const buf = decoder.getEncodedBuffer(bytes.length);
  buf.set(bytes);
  decoder.readHeader();
  decoder.decodeSubResolution(reduce);
  const frameInfo = decoder.getFrameInfo();
  const rawBuf = decoder.getDecodedBuffer();

  let pixels;
  let pixelsType = 'u8';
  if (frameInfo.bitsPerSample > 8) {
    const src = new (frameInfo.isSigned ? Int16Array : Uint16Array)(
      rawBuf.buffer,
      rawBuf.byteOffset,
      rawBuf.byteLength / 2,
    );
    pixels = new (frameInfo.isSigned ? Int16Array : Uint16Array)(src);
    pixelsType = frameInfo.isSigned ? 'i16' : 'u16';
  } else {
    const src = new Uint8Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength);
    pixels = new Uint8Array(src);
    pixelsType = 'u8';
  }

  return {
    decoderKind: 'htj2k-openjph',
    width: frameInfo.width,
    height: frameInfo.height,
    componentCount: frameInfo.componentCount,
    bitsPerSample: frameInfo.bitsPerSample,
    isSigned: frameInfo.isSigned,
    isUsingColorTransform: frameInfo.isUsingColorTransform,
    pixelsType,
    sampleLayout: 'interleaved',
    pixels,
    nativeReduced: reduce > 0,
    nativeReduceLevel: reduce,
  };
}

function planarToInterleaved(data, width, height) {
  const pixels = new Uint8Array(width * height * 3);
  const plane = width * height;
  for (let i = 0; i < plane; i++) {
    const d = i * 3;
    pixels[d] = data[i] ?? 0;
    pixels[d + 1] = data[i + plane] ?? data[i] ?? 0;
    pixels[d + 2] = data[i + plane * 2] ?? data[i] ?? 0;
  }
  return pixels;
}

function _downsampleFrame(frame, scale) {
  const useScale = (typeof scale === 'number' && isFinite(scale) && scale > 0 && scale < 1) ? scale : 1;
  if (useScale >= 1) return frame;
  const step = useScale <= 0.25 ? 4 : 2;
  const outW = Math.max(1, Math.floor(frame.width / step));
  const outH = Math.max(1, Math.floor(frame.height / step));
  const comps = Math.max(1, frame.componentCount | 0);
  const Typed = frame.pixels.constructor;
  const plane = frame.width * frame.height;
  const layout = frame.sampleLayout || 'interleaved';
  let out;

  if (layout === 'yuv420p') {
    const outPlane = outW * outH;
    const srcCW = Math.max(1, Math.floor(frame.width / 2));
    const srcCH = Math.max(1, Math.floor(frame.height / 2));
    const dstCW = Math.max(1, Math.floor(outW / 2));
    const dstCH = Math.max(1, Math.floor(outH / 2));
    const srcUV = srcCW * srcCH;
    const dstUV = dstCW * dstCH;
    const yOff = 0;
    const uOff = plane;
    const vOff = plane + srcUV;
    out = new Typed(outPlane + dstUV * 2);
    for (let y = 0; y < outH; y++) {
      const sy = Math.min(frame.height - 1, y * step);
      for (let x = 0; x < outW; x++) {
        const sx = Math.min(frame.width - 1, x * step);
        out[y * outW + x] = frame.pixels[yOff + sy * frame.width + sx];
      }
    }
    const outUOff = outPlane;
    const outVOff = outPlane + dstUV;
    for (let y = 0; y < dstCH; y++) {
      const sy = Math.min(srcCH - 1, y * step);
      for (let x = 0; x < dstCW; x++) {
        const sx = Math.min(srcCW - 1, x * step);
        out[outUOff + y * dstCW + x] = frame.pixels[uOff + sy * srcCW + sx];
        out[outVOff + y * dstCW + x] = frame.pixels[vOff + sy * srcCW + sx];
      }
    }
    console.log(`[J2K-SBX] preview downsample yuv420p ${frame.width}x${frame.height} -> ${outW}x${outH} scale=${useScale}`);
    return { ...frame, width: outW, height: outH, pixels: out };
  }

  if (layout === 'yuv422p') {
    const outPlane = outW * outH;
    const srcCW = Math.max(1, Math.floor(frame.width / 2));
    const dstCW = Math.max(1, Math.floor(outW / 2));
    const srcUV = srcCW * frame.height;
    const dstUV = dstCW * outH;
    const yOff = 0;
    const uOff = plane;
    const vOff = plane + srcUV;
    out = new Typed(outPlane + dstUV * 2);
    for (let y = 0; y < outH; y++) {
      const sy = Math.min(frame.height - 1, y * step);
      for (let x = 0; x < outW; x++) {
        const sx = Math.min(frame.width - 1, x * step);
        out[y * outW + x] = frame.pixels[yOff + sy * frame.width + sx];
      }
      for (let x = 0; x < dstCW; x++) {
        const sx = Math.min(srcCW - 1, x * step);
        out[outPlane + y * dstCW + x] = frame.pixels[uOff + sy * srcCW + sx];
        out[outPlane + dstUV + y * dstCW + x] = frame.pixels[vOff + sy * srcCW + sx];
      }
    }
    console.log(`[J2K-SBX] preview downsample yuv422p ${frame.width}x${frame.height} -> ${outW}x${outH} scale=${useScale}`);
    return { ...frame, width: outW, height: outH, pixels: out };
  }

  if (layout === 'planar') {
    const outPlane = outW * outH;
    out = new Typed(outPlane * comps);
    for (let c = 0; c < comps; c++) {
      const srcBase = c * plane;
      const dstBase = c * outPlane;
      for (let y = 0; y < outH; y++) {
        const sy = Math.min(frame.height - 1, y * step);
        for (let x = 0; x < outW; x++) {
          const sx = Math.min(frame.width - 1, x * step);
          out[dstBase + y * outW + x] = frame.pixels[srcBase + sy * frame.width + sx];
        }
      }
    }
  } else {
    out = new Typed(outW * outH * comps);
    for (let y = 0; y < outH; y++) {
      const sy = Math.min(frame.height - 1, y * step);
      for (let x = 0; x < outW; x++) {
        const sx = Math.min(frame.width - 1, x * step);
        const src = (sy * frame.width + sx) * comps;
        const dst = (y * outW + x) * comps;
        for (let c = 0; c < comps; c++) out[dst + c] = frame.pixels[src + c];
      }
    }
  }
  console.log(`[J2K-SBX] preview downsample ${frame.width}x${frame.height} -> ${outW}x${outH} scale=${useScale}`);
  return { ...frame, width: outW, height: outH, pixels: out };
}

function _reduceLevelFromScale(scale) {
  if (!(typeof scale === 'number' && isFinite(scale) && scale > 0 && scale < 1)) return 0;
  if (scale <= 0.25) return 2;
  return 1;
}

function decodeClassicBytes(bytes, reduceLevel = 0) {
  if (!classicDecoder) throw new Error('Classic OpenJPEG decoder unavailable');
  const trimmed = trimToCodestream(bytes);
  const siz = parseSIZ(trimmed);
  const reduce = Math.max(0, reduceLevel | 0);
  const result = classicDecoder(Array.from(trimmed), 'j2k', reduce);
  if (!result || !result.width || !result.height || !result.data) {
    throw new Error('Classic OpenJPEG decoder returned incomplete frame');
  }
  const width = result.width | 0;
  const height = result.height | 0;
  const plane = width * height;
  let data = result.data;
  if (Array.isArray(data)) data = Uint8Array.from(data);
  else if (data instanceof ArrayBuffer) data = new Uint8Array(data);
  else if (!(data instanceof Uint8Array)) data = new Uint8Array(data.buffer || data);

  const hintedComps = Math.max(1, Math.min(4, siz.componentCount || 0)) || 0;
  const hintedBits = siz.bitsPerSample || 0;
  const bytesPerPixel = plane > 0 ? (data.length / plane) : 0;

  let componentCount = hintedComps || 3;
  let bitsPerSample = hintedBits || 8;
  let pixelsType = 'u8';
  let sampleLayout = 'interleaved';
  let pixels = null;

  const is420 = plane > 0 && (data.length === Math.floor(plane * 3 / 2) || data.length === Math.ceil(plane * 3 / 2));
  const is422 = plane > 0 && data.length === plane * 2;
  if (is420) {
    componentCount = 3;
    bitsPerSample = hintedBits && hintedBits <= 8 ? hintedBits : 8;
    pixels = new Uint8Array(data.length);
    pixels.set(data);
    pixelsType = 'u8';
    sampleLayout = 'yuv420p';
    console.log(`[J2K-SBX] classic metadata interpreted as yuv420p ${width}x${height} bytes=${data.length} hintedComps=${hintedComps || '?'} hintedBits=${hintedBits || '?'} `);
  } else if (is422) {
    componentCount = 3;
    bitsPerSample = hintedBits && hintedBits <= 8 ? hintedBits : 8;
    pixels = new Uint8Array(data.length);
    pixels.set(data);
    pixelsType = 'u8';
    sampleLayout = 'yuv422p';
    console.log(`[J2K-SBX] classic metadata interpreted as yuv422p ${width}x${height} bytes=${data.length} hintedComps=${hintedComps || '?'} hintedBits=${hintedBits || '?'} `);
  } else if (hintedComps && hintedBits && bitsPerSample > 8 && Math.round(bytesPerPixel) === hintedComps * 2) {
    const sampleCount = Math.floor(data.byteLength / 2);
    const out = new Uint16Array(sampleCount);
    for (let i = 0, j = 0; i < sampleCount; i++, j += 2) {
      out[i] = ((data[j] & 0xff) << 8) | (data[j + 1] & 0xff);
    }
    pixels = out;
    pixelsType = 'u16';
    sampleLayout = componentCount > 1 ? 'planar' : 'interleaved';
    let maxv = 0;
    let minv = 65535;
    const probe = Math.min(out.length, 4096);
    for (let i = 0; i < probe; i++) {
      const v = out[i];
      if (v > maxv) maxv = v;
      if (v < minv) minv = v;
    }
    console.log(`[J2K-SBX] classic metadata SIZ ${width}x${height} comps=${componentCount} bits=${bitsPerSample} layout=${pixelsType}-${sampleLayout}-be bytes=${data.length} probeRange=${minv}-${maxv}`);
  } else if (hintedComps && hintedBits && bitsPerSample <= 8 && Math.round(bytesPerPixel) === hintedComps) {
    pixels = new Uint8Array(data.length);
    pixels.set(data);
    pixelsType = 'u8';
    sampleLayout = componentCount > 1 ? 'planar' : 'interleaved';
    console.log(`[J2K-SBX] classic metadata SIZ ${width}x${height} comps=${componentCount} bits=${bitsPerSample} layout=${pixelsType}-${sampleLayout} bytes=${data.length}`);
  } else if (data.length === plane) {
    componentCount = 1;
    bitsPerSample = 8;
    pixels = new Uint8Array(plane);
    pixels.set(data.subarray(0, plane));
  } else if (data.length === plane * 3) {
    componentCount = 3;
    bitsPerSample = 8;
    pixels = new Uint8Array(data.length);
    pixels.set(data);
  } else if (data.length === plane * 4) {
    componentCount = 4;
    bitsPerSample = 8;
    pixels = new Uint8Array(data.length);
    pixels.set(data);
  } else {
    componentCount = Math.max(1, Math.min(4, Math.floor(data.length / Math.max(1, plane))));
    bitsPerSample = 8;
    if (componentCount === 1) {
      pixels = new Uint8Array(plane);
      pixels.set(data.subarray(0, plane));
    } else if (componentCount === 4) {
      pixels = new Uint8Array(plane * 4);
      for (let i = 0; i < plane; i++) {
        pixels[i * 4] = data[i] ?? 0;
        pixels[i * 4 + 1] = data[i + plane] ?? 0;
        pixels[i * 4 + 2] = data[i + plane * 2] ?? 0;
        pixels[i * 4 + 3] = data[i + plane * 3] ?? 255;
      }
    } else {
      pixels = new Uint8Array(plane * 3);
      for (let i = 0; i < plane; i++) {
        pixels[i * 3] = data[i] ?? 0;
        pixels[i * 3 + 1] = data[i + plane] ?? data[i] ?? 0;
        pixels[i * 3 + 2] = data[i + plane * 2] ?? data[i] ?? 0;
      }
    }
    console.warn(`[J2K-SBX] classic layout fell back to heuristic comps=${componentCount} bytes=${data.length} bpp=${bitsPerSample}`);
  }

  console.log(`[J2K-SBX] classic frame decoded ${width}x${height} comps=${componentCount} bits=${bitsPerSample} bytes=${data.length} reduce=${reduce}`);
  return {
    decoderKind: 'j2k-openjpeg',
    width,
    height,
    componentCount,
    bitsPerSample,
    isSigned: !!siz.isSigned,
    isUsingColorTransform: false,
    pixelsType,
    sampleLayout,
    pixels,
  };
}

function composeFallbackFrame(jpx) {
  const width = jpx.width | 0;
  const height = jpx.height | 0;
  const comps = jpx.componentsCount | 0;
  const outComps = comps >= 4 ? 4 : (comps >= 3 ? 3 : 1);
  const out = new Uint8Array(width * height * outComps);
  const tiles = Array.isArray(jpx.tiles) ? jpx.tiles : [];
  for (const tile of tiles) {
    const tileComps = comps;
    const src = tile.items;
    for (let ty = 0; ty < tile.height; ty++) {
      const dstRow = ((tile.top + ty) * width + tile.left) * outComps;
      const srcRow = ty * tile.width * tileComps;
      for (let tx = 0; tx < tile.width; tx++) {
        const s = srcRow + tx * tileComps;
        const d = dstRow + tx * outComps;
        if (outComps === 1) {
          out[d] = src[s];
        } else if (outComps === 3) {
          out[d] = src[s];
          out[d + 1] = src[s + 1] ?? src[s];
          out[d + 2] = src[s + 2] ?? src[s];
        } else {
          out[d] = src[s];
          out[d + 1] = src[s + 1] ?? src[s];
          out[d + 2] = src[s + 2] ?? src[s];
          out[d + 3] = src[s + 3] ?? 255;
        }
      }
    }
  }
  return {
    decoderKind: 'j2k-fallback',
    width,
    height,
    componentCount: outComps,
    bitsPerSample: 8,
    isSigned: false,
    isUsingColorTransform: false,
    pixelsType: 'u8',
    pixels: out,
  };
}

async function decodeFallbackBytes(bytes) {
  const m = await loadPureFallback();
  if (!m || typeof m.JpxImage !== 'function') throw new Error('Pure JS fallback decoder unavailable');
  const jpx = new m.JpxImage();
  jpx.parse(bytes);
  if (!jpx.width || !jpx.height || !Array.isArray(jpx.tiles)) {
    throw new Error('Pure JS fallback parser returned incomplete frame');
  }
  return composeFallbackFrame(jpx);
}

window.addEventListener('message', async (event) => {
  // Only accept messages from the extension's own origin.
  // Rejects external pages that embed this sandbox via web_accessible_resources.
  const expectedOrigin = location.origin; // chrome-extension://<id>
  if (!event.origin || event.origin !== expectedOrigin) return;

  const msg = event.data;
  if (!msg || msg.source !== 'PFX_IMF_J2K_BRIDGE') return;

  if (msg.type === 'PFX_J2K_PING') {
    if (bootState.classicReady || bootState.htReady) {
      postBootState(event.source);
    } else {
      event.source?.postMessage({ source: 'PFX_J2K_SANDBOX', type: 'PFX_J2K_PONG' }, '*');
    }
    return;
  }

  if (msg.type !== 'PFX_J2K_DECODE') return;

  const reply = { source: 'PFX_J2K_SANDBOX', type: 'PFX_J2K_DECODE_RESULT', id: msg.id, ok: false };
  try {
    const bytes = new Uint8Array(msg.buffer);
    const sniff = sniffCodestream(bytes);
    console.log(`[J2K-SBX] routing ${sniff.kind} rsiz=${sniff.rsiz ?? 'n/a'} bytes=${bytes.length}`);
    let frame;
    if (sniff.kind === 'htj2k') {
      const reduceLevel = _reduceLevelFromScale(msg.scale);
      const mod = await loadHTModule();
      if (!mod) throw new Error('HTJ2K decoder not ready');
      frame = decodeHTBytes(trimToCodestream(bytes), reduceLevel);
      console.log(`[J2K-SBX] ht frame decoded ${frame.width}x${frame.height} comps=${frame.componentCount} reduce=${reduceLevel}`);
    } else {
      const reduceLevel = _reduceLevelFromScale(msg.scale);
      await loadClassicModule();
      try {
        frame = decodeClassicBytes(bytes, reduceLevel);
      } catch (openjpegErr) {
        console.warn('[J2K-SBX] OpenJPEG classic decode failed, falling back', openjpegErr);
        frame = await decodeFallbackBytes(bytes);
      }
    }
    if (msg.scale && msg.scale < 1 && !frame.nativeReduced) frame = _downsampleFrame(frame, msg.scale);
    reply.ok = true;
    reply.frame = {
      decoderKind: frame.decoderKind,
      width: frame.width,
      height: frame.height,
      componentCount: frame.componentCount,
      bitsPerSample: frame.bitsPerSample,
      isSigned: frame.isSigned,
      isUsingColorTransform: frame.isUsingColorTransform,
      pixelsType: frame.pixelsType,
      sampleLayout: frame.sampleLayout || 'interleaved',
      pixelsBuffer: frame.pixels.buffer,
    };
    event.source?.postMessage(reply, '*', [frame.pixels.buffer]);
  } catch (e) {
    console.warn('[J2K-SBX] decode failed', e);
    reply.error = e?.message || String(e);
    event.source?.postMessage(reply, '*');
  }
});

Promise.allSettled([loadClassicModule()]).then((results) => {
  bootState.classicReady = results[0]?.status === 'fulfilled' && !!results[0]?.value;
  bootState.htReady = false;
  bootState.bootReported = true;
  // HTJ2K background pre-warm removed: concurrent WASM instantiation across
  // multiple sandbox iframes triggers a Chromium renderer crash (exitCode 11).
  // HTJ2K module loads lazily on first decode request instead.
  postBootState();
}).catch((e) => {
  bootState.bootReported = true;
  try { window.parent?.postMessage({ source: 'PFX_J2K_SANDBOX', type: 'PFX_J2K_SANDBOX_ERROR', error: String(e) }, '*'); } catch (_) {}
});
