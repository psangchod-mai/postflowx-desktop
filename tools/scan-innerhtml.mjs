#!/usr/bin/env node
// tools/scan-innerhtml.mjs — XSS-sink scanner (audit follow-up / regression guard).
//
// Lists `innerHTML = `...`` template-literal sinks that interpolate a bare
// expression NOT wrapped in a known HTML-escaper. Heuristic (regex, not a full
// parser) — meant to surface candidates for human review, not to be a hard gate.
// Run: node tools/scan-innerhtml.mjs   (or: npm run scan:xss)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src', 'scripts');

// An escaper call ANYWHERE in the expression marks it reviewed-safe (covers
// ternaries like `cond ? _esc(x) : 'y'` and `_esc(a)+b`). Heuristic.
const ESCAPERS = /\b(esc|esc2|escapeHtml|escapeHTML|_esc|_escHtml|_escMsg|_pmEscHtml|_xesc|_pmJ|iconSvg)\s*\(|\.replace\([^)]*&(lt|amp|quot|#39);/;
// --gate mode: flag ONLY interpolations that reference clearly-untrusted data
// (file/error/user-derived). Precise enough to use as a CI gate (no false-
// positive composed fragments). Default mode keeps the broad review heuristic.
const GATE = process.argv.includes('--gate');
// Genuinely-untrusted data tokens. 'label'/'title' excluded — overwhelmingly UI
// constants here; they remain visible in the broad (non-gate) review mode.
const UNTRUSTED = /\b(sourcePath|matchedPath|sourceFile|clipName|fileName|filename|reel|comment|ocr|userMessage|shotName|cameraModel)\b|\.(error|message|name|path|stage|warning)\b/i;
// A pure function call is the escaping boundary's responsibility — `${fn(x.error)}`
// is fn's job, not a direct sink. We only gate DIRECT property interpolation.
const IS_CALL = /^[A-Za-z_$][\w$.]*\([^]*\)$/;

// Exported predicate (the gate's core decision) so it can be unit-tested.
// True = this interpolation expression is a real XSS sink in gate mode.
export function isGatedXssSink(expr) {
  const e = String(expr || '').trim();
  if (!e) return false;
  if (ESCAPERS.test(e)) return false;   // already escaped
  if (IS_CALL.test(e)) return false;    // function call → callee's responsibility
  return UNTRUSTED.test(e);             // direct untrusted property interpolation
}

// Interpolations that are inherently safe to inline.
const SAFE_EXPR = [
  /^['"`]/,                         // string literal
  /^-?\d/,                          // number
  /^(true|false|null|undefined)$/,  // keyword
  /dataurl|datauri|\.src\b|imgsrc|base64|svg|icon/i,  // image/data/icon payloads
  /\bidx?\b|\bi\b|count|index|\.length|num|width|height|pct|percent/i, // numeric-ish
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Pull template literals assigned to innerHTML (handles multi-line, naive on nesting).
const SINK = /\.innerHTML\s*\+?=\s*`/g;
function interpolations(file, text) {
  const hits = [];
  let m;
  while ((m = SINK.exec(text)) !== null) {
    // walk forward to the matching backtick (ignore escaped \`)
    let i = m.index + m[0].length, depth = 0, body = '';
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') { body += c + text[++i]; continue; }
      if (c === '`' && depth === 0) break;
      body += c;
    }
    const line = text.slice(0, m.index).split('\n').length;
    // find ${ ... } (simple, non-nested)
    const re = /\$\{([^}]*)\}/g; let g;
    while ((g = re.exec(body)) !== null) {
      const expr = g[1].trim();
      if (!expr) continue;
      if (ESCAPERS.test(expr)) continue;
      // Gate mode: only DIRECT untrusted-data interpolation is a real finding.
      if (GATE) { if (!isGatedXssSink(expr)) continue; }
      else { if (ESCAPERS.test(expr) || SAFE_EXPR.some(rx => rx.test(expr))) continue; }
      hits.push({ line, expr: expr.length > 60 ? expr.slice(0, 60) + '…' : expr });
    }
  }
  return hits;
}

// CLI entry — skipped when imported (e.g. by the gate's unit tests).
if (process.argv[1]?.endsWith('scan-innerhtml.mjs')) {
  let total = 0;
  const byFile = [];
  for (const f of walk(SRC)) {
    const text = readFileSync(f, 'utf8');
    const hits = interpolations(f, text);
    if (hits.length) { byFile.push([relative(ROOT, f), hits]); total += hits.length; }
  }
  byFile.sort((a, b) => b[1].length - a[1].length);
  for (const [file, hits] of byFile) {
    console.log(`\n${file}  (${hits.length})`);
    for (const h of hits) console.log(`  :${h.line}  \${${h.expr}}`);
  }
  if (GATE) {
    if (total > 0) {
      console.error(`\n✗ XSS GATE: ${total} untrusted value(s) interpolated into innerHTML without an escaper. Wrap each in an escaper.`);
      process.exit(1);
    }
    console.log('\n✓ XSS gate clean — no untrusted data flows into innerHTML unescaped.');
  } else {
    console.log(`\n${total} candidate unescaped innerHTML interpolation(s) across ${byFile.length} file(s).`);
    console.log('Heuristic — review each. Run with --gate for the precise, CI-able check.');
  }
}
