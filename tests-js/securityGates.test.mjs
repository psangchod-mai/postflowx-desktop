// Meta-tests for the security gate detectors. Run: node tests-js/securityGates.test.mjs
// Locks the XSS/XXE/fail-open gate logic so a future regex weakening can't silently
// let sinks through — or, worse, let a gate report success without running.
import { isGatedXssSink } from '../tools/scan-innerhtml.mjs';
import { isRawXmlParse, stripPy } from '../tools/scan-rawxml.mjs';
import { isFailOpenCatch, isFailOpenScript, catchBlocks } from '../tools/scan-failopen.mjs';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

// ── XSS gate: must FLAG direct untrusted property interpolation ──
ok(isGatedXssSink('r.error'), 'flags r.error');
ok(isGatedXssSink('ev.clipName'), 'flags ev.clipName');
ok(isGatedXssSink('shot.sourcePath'), 'flags shot.sourcePath');
ok(isGatedXssSink('x.message'), 'flags x.message');
ok(isGatedXssSink('row.warning'), 'flags row.warning');
ok(isGatedXssSink('meta.cameraModel'), 'flags cameraModel');

// ── XSS gate: must NOT flag (escaped / call / constant / numeric) ──
ok(!isGatedXssSink('_esc(r.error)'), 'escaped via _esc → safe');
ok(!isGatedXssSink('escapeHtml(r.name)'), 'escaped via escapeHtml → safe');
ok(!isGatedXssSink('escapeHTML(m.shotName)'), 'escaped via escapeHTML (capital) → safe');
ok(!isGatedXssSink('fn(x.error)'), 'function-call wrapper → callee responsibility');
ok(!isGatedXssSink('pos.label'), 'pos.label → not gated (UI constant)');
ok(!isGatedXssSink('totalClips'), 'plain identifier → safe');
ok(!isGatedXssSink('123'), 'number → safe');
ok(!isGatedXssSink("a ? 'x' : 'y'"), 'constant ternary → safe');
ok(!isGatedXssSink(''), 'empty → safe');
ok(!isGatedXssSink("String(f||'').replace(/</g,'&lt;')"), 'manual <-escape → safe');

// ── XXE gate: must FLAG raw parse entrypoints ──
ok(isRawXmlParse('root = ET.fromstring(text)'), 'flags ET.fromstring');
ok(isRawXmlParse('tree = ET.parse(path)'), 'flags ET.parse');
ok(isRawXmlParse('d = minidom.parseString(s)'), 'flags minidom.parseString');
ok(isRawXmlParse('from lxml import etree'), 'flags lxml import');
ok(isRawXmlParse('import xml.sax'), 'flags xml.sax');

// ── XXE gate: must NOT flag the safe wrapper or unrelated code ──
ok(!isRawXmlParse('root = safe_xml.fromstring(text)'), 'safe_xml.fromstring → safe');
ok(!isRawXmlParse('tree = safe_xml.parse_path(p)'), 'safe_xml.parse_path → safe');
ok(!isRawXmlParse('return _ET.fromstring(text)'), 'aliased _ET (inside safe_xml) not matched by ET. token');
ok(!isRawXmlParse('x = json.loads(s)'), 'json.loads → safe');

// ── stripPy removes comments/docstrings (so a docstring mention never trips the gate) ──
ok(!stripPy('"""Drop-in for ET.parse(path)."""').includes('ET.parse'), 'docstring ET.parse stripped');
ok(!stripPy('x = 1  # ET.fromstring(y)').includes('ET.fromstring'), 'line-comment stripped');
ok(stripPy('root = ET.fromstring(s)').includes('ET.fromstring'), 'real code preserved');

// ── Fail-open gate: must FLAG a check that reports success while not running ──
// Both literals below are the exact code this gate was written to kill: four
// tests-js files wrapped a require() of the first-party imf_direct_engine in a
// catch that exited 0, so a syntax error in the engine deleted 76 assertions
// while `test:js` still printed green.
//
// These literals ARE fail-open code, so the gate flags them when it scans this
// file — hence the annotations. They suppress the scanner only; the assertions
// pass each literal to catchBlocks as its own source, where no annotation is in
// scope, so the must-flag checks below are still real.
// fail-open-ok: test fixture — this string is the defect the gate detects
const preFixExit = `try { engine = require(p); }
catch (e) { console.error('SKIP - could not load imf_direct_engine:', e.message); process.exit(0); }`;
// fail-open-ok: test fixture — this string is the defect the gate detects
const preFixReturn = `try { engine = require(p); }
catch (e) { console.log('SKIP - engine not loadable for poll contract:', e.message); return; }`;
ok(catchBlocks(preFixExit).some(b => isFailOpenCatch(b.body, b)), 'flags catch → process.exit(0)');
ok(catchBlocks(preFixReturn).some(b => isFailOpenCatch(b.body, b)), 'flags catch → SKIP log + bare return');
ok(isFailOpenScript('node tools/x.mjs || true'), 'flags npm script with || true');
ok(isFailOpenScript('pytest -q || exit 0'), 'flags npm script with || exit 0');

// ── Fail-open gate: must NOT flag loud failure, annotated skips, or fallbacks ──
const postFix = `catch (e) { console.error('FAIL - engine failed to load:', e.stack); process.exit(1); }`;
const annotated = `// fail-open-ok: openjphjs is a build-time asset, absent in a fresh checkout
catch (e) { console.log('SKIP - no wasm decoder'); return; }`;
ok(!catchBlocks(postFix).some(b => isFailOpenCatch(b.body, b)), 'exit(1) on catch → loud, safe');
ok(!catchBlocks(annotated).some(b => isFailOpenCatch(b.body, b)), 'annotated optional dep → safe');
ok(!isFailOpenCatch('return null;'), 'catch returning a fallback value → safe');
ok(!isFailOpenCatch("console.warn('parse failed'); return [];"), 'catch with non-SKIP warn + return → safe');
ok(!isFailOpenScript('for f in tests-js/*.test.mjs; do node "$f" || exit 1; done'),
   'the real test:js loop (|| exit 1) → safe');
ok(!isFailOpenScript('node --test test/parsers/*.test.mjs'), 'plain test command → safe');
// The whole point is a testable predicate, so prove the extractor pairs bodies
// with the right catch — two catches, only the first is fail-open.
// fail-open-ok: test fixture — this string is the defect the gate detects
const mixed =`catch (e) { process.exit(0); }\nfunction f(){}\ncatch (e) { process.exit(1); }`;
ok(catchBlocks(mixed).length === 2, 'catchBlocks finds both catch bodies');
ok(catchBlocks(mixed).filter(b => isFailOpenCatch(b.body, b)).length === 1, 'only the exit(0) catch is flagged');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
