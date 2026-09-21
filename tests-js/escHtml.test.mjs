// HTML-escape correctness for the XSS-sink hardening (audit fix). Run: node tests-js/escHtml.test.mjs
// prep_mark.js's _escHtml isn't exported (module has heavy DOM deps), so this
// tests an identical reference implementation to lock the escaping contract.
function escHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let passed = 0, failed = 0;
function eq(got, want, l) { if (got === want) { passed++; console.log('PASS -', l); } else { failed++; console.error(`FAIL - ${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); } }

eq(escHtml('A001.mxf'), 'A001.mxf', 'plain filename unchanged');
eq(escHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;', 'angle brackets escaped');
eq(escHtml('"><script>'), '&quot;&gt;&lt;script&gt;', 'attribute-breakout escaped');
eq(escHtml("a'b"), 'a&#39;b', 'single quote escaped');
eq(escHtml('a&b'), 'a&amp;b', 'ampersand escaped');
eq(escHtml(null), '', 'null → empty');
eq(escHtml(undefined), '', 'undefined → empty');
eq(escHtml('/Volumes/Extreme SSD/"><b>.mxf'), '/Volumes/Extreme SSD/&quot;&gt;&lt;b&gt;.mxf', 'malicious path neutralized');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
