#!/usr/bin/env node
// tools/scan-rawxml.mjs — XXE regression gate for the Python companion.
//
// All untrusted XML (CPL/PKL/ASSETMAP, DoVi, FCPXML, ADM…) must go through
// safe_xml.py, which rejects DOCTYPE/ENTITY declarations. This gate fails the
// build if any companion file parses XML with a raw stdlib/lxml entrypoint
// (ET.fromstring / ET.parse / minidom.parse / lxml / xml.sax / etree.parse),
// which would bypass the XXE/entity-expansion protection.
// Run: node tools/scan-rawxml.mjs            (report)
//      node tools/scan-rawxml.mjs --gate     (CI: exit 1 on any finding)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'companion', 'src');
const GATE = process.argv.includes('--gate');

// safe_xml.py IS the sanctioned wrapper (uses the stdlib internally, guarded).
const ALLOW = new Set(['safe_xml.py']);

// Raw XML parse entrypoints that take (potentially untrusted) input.
const RAW = /\bET\.(fromstring|parse)\s*\(|\bminidom\.parse(?:String)?\s*\(|\bfrom\s+lxml\b|\blxml\.etree\b|\bxml\.sax\b|\betree\.parse\s*\(/;
// Strip comments/docstrings cheaply (line comments + triple-quoted blocks).
export function stripPy(t) {
  return t.replace(/"""[^]*?"""/g, '').replace(/'''[^]*?'''/g, '').replace(/#.*$/gm, '');
}

// Exported predicate so the gate's detection logic can be unit-tested.
export function isRawXmlParse(codeLine) {
  return RAW.test(String(codeLine || ''));
}

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n); const s = statSync(p);
    if (s.isDirectory()) { if (n !== '__pycache__') walk(p, out); }
    else if (n.endsWith('.py')) out.push(p);
  }
  return out;
}

// CLI entry — skipped when imported (e.g. by the gate's unit tests).
if (process.argv[1]?.endsWith('scan-rawxml.mjs')) {
  let total = 0; const found = [];
  for (const f of walk(SRC)) {
    if (ALLOW.has(basename(f))) continue;
    const code = stripPy(readFileSync(f, 'utf8'));
    code.split('\n').forEach((line, i) => {
      if (isRawXmlParse(line)) { found.push(`${relative(ROOT, f)}:${i + 1}  ${line.trim().slice(0, 80)}`); total++; }
    });
  }
  for (const h of found) console.log('  ' + h);
  if (GATE) {
    if (total > 0) {
      console.error(`\n✗ XXE GATE: ${total} raw XML parse(s) bypassing safe_xml. Route through safe_xml (fromstring/read_xml/parse_path).`);
      process.exit(1);
    }
    console.log('✓ XXE gate clean — all companion XML parsing routes through safe_xml.');
  } else {
    console.log(`\n${total} raw XML parse entrypoint(s) found.`);
  }
}
