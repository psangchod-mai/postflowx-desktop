// imf_gl_present.js SDR-passthrough parity test.
// Run: node tests-js/imfGlPresentSdrPassthrough.test.mjs
//
// The GPU SDR-passthrough branch (u_colorMode == 0) is a GLSL port of
// frameToRGBA()'s px(v) = (v >> shift) & 0xff in imf_render_worker.js. There's
// no WebGL context in this test environment, so instead of running the real
// shader we extract the actual shipped GLSL expression from the fragment
// shader source string and evaluate it with the same arithmetic GLSL uses
// (floor-based mod), then compare against the CPU reference for the same
// inputs — including negative signed samples, where a naive clamp() (instead
// of a wraparound mod()) clips to 0 instead of reproducing the & 0xff
// two's-complement truncation.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, '../src/scripts/modules/imf/imf_gl_present.js');
const src = readFileSync(srcPath, 'utf8');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

const m = src.match(/if \(u_colorMode == 0\) \{[\s\S]*?vec3 c = (.+?);\s*\n\s*fragColor = vec4\(c, 1\.0\);/);
if (!m) {
  console.error('FAIL - could not locate the SDR-passthrough expression in imf_gl_present.js (file structure changed?)');
  process.exit(1);
}
const expr = m[1];

function glslMod(a, b) { return a - b * Math.floor(a / b); }
function glslClamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

// Translate the tiny GLSL arithmetic subset used here into JS. Order matters:
// function names before the bare `s`/`u_sdrDiv` identifiers they contain.
function evalPassthrough(sVal, sdrDiv) {
  const jsExpr = expr
    .replace(/\bfloor\(/g, 'Math.floor(')
    .replace(/\bclamp\(/g, 'glslClamp(')
    .replace(/\bmod\(/g, 'glslMod(')
    .replace(/\bu_sdrDiv\b/g, 'sdrDiv')
    .replace(/\bs\b/g, 'sVal');
  const fn = new Function('sVal', 'sdrDiv', 'glslClamp', 'glslMod', `return ${jsExpr};`);
  return fn(sVal, sdrDiv, glslClamp, glslMod);
}

// CPU reference, mirroring frameToRGBA()'s px()/shift/dcOffset-free passthrough.
function cpuPx(v, bitsPerSample) {
  const shift = bitsPerSample > 8 ? Math.max(0, bitsPerSample - 8) : 0;
  const n = bitsPerSample > 8 ? (v >> shift) : v;
  return Math.max(0, Math.min(255, n & 0xff));
}

const cases = [
  { label: '8-bit unsigned, mid-range value', bits: 8, v: 200 },
  { label: '16-bit unsigned, byte-aligned value', bits: 16, v: 51200 },
  { label: '12-bit signed, negative sample (the reported failure case)', bits: 12, v: -100 },
  { label: '16-bit signed, negative sample', bits: 16, v: -30000 },
];

for (const { label, bits, v } of cases) {
  const sdrDiv = bits > 8 ? Math.pow(2, bits - 8) : 1;
  const expected = cpuPx(v, bits);
  const got = Math.round(evalPassthrough(v, sdrDiv) * 255);
  ok(got === expected, `${label}: shader expr(${v}, div=${sdrDiv}) = ${got}, want ${expected} (matches CPU px())`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
