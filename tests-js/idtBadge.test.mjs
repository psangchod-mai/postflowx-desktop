// VFX Pull IDT badge builder (OCF auto-detect aware). Run: node tests-js/idtBadge.test.mjs
import { buildIdtBadgeHtml, idtShortToken } from '../src/scripts/features/vfxPull/idtBadge.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

// ── idtShortToken ──
eq(idtShortToken('ARRI LogC3 / AWG3'), 'AWG3', 'short token from ARRI label');
eq(idtShortToken('Sony S-Log3 / S-Gamut3.Cine'), 'S-Gamut3.Cine', 'short token from Sony label');
eq(idtShortToken('ARRI LogC3 (EI800)'), 'ARRI LogC3', 'parens stripped');
eq(idtShortToken(''), '', 'empty label → empty token');

// ── auto-detected badge → 🎬 + --auto class + tooltip note ──
const auto = buildIdtBadgeHtml({ idtName: 'ARRI LogC3 / AWG3', idtAutoDetected: true });
ok(auto.includes('🎬'), 'auto badge shows 🎬');
ok(auto.includes('pm-vfx-pull-badge--auto'), 'auto badge has --auto class');
ok(auto.includes('auto-detected from OCF'), 'auto badge tooltip notes OCF');
ok(auto.includes('>🎬 AWG3<'), 'auto badge text is 🎬 + short token');

// ── manual (not auto) → no 🎬, no --auto ──
const man = buildIdtBadgeHtml({ idtName: 'ARRI LogC3 / AWG3' });
ok(!man.includes('🎬'), 'manual badge has no 🎬');
ok(!man.includes('--auto'), 'manual badge has no --auto class');
ok(man.includes('title="IDT: ARRI LogC3 / AWG3"'), 'manual badge tooltip is the IDT label');

// ── warning surfaced in tooltip ──
const warn = buildIdtBadgeHtml({ idtName: 'Rec.709', idtAutoDetected: true, idtWarning: 'verify color space' });
ok(warn.includes('⚠ verify color space'), 'warning shown in tooltip');

// ── escaping: a malicious IDT name cannot break out of the markup ──
const evil = buildIdtBadgeHtml({ idtName: '"><img src=x onerror=alert(1)> / X3' });
ok(!evil.includes('<img'), 'IDT name is HTML-escaped (no raw <img>)');
ok(evil.includes('&lt;') || evil.includes('&quot;'), 'escaped entities present');

// ── no IDT → empty ──
eq(buildIdtBadgeHtml({ idtName: '' }), '', 'no idtName → empty badge');
eq(buildIdtBadgeHtml(null), '', 'null colorPlan → empty badge');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
