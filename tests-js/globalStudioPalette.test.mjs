import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../src/styles/main.css', import.meta.url), 'utf8');
const home = fs.readFileSync(new URL('../src/scripts/features/home/homeScreen.js', import.meta.url), 'utf8');
const marker = 'POSTFLOWX — NETFLIX STUDIO GLOBAL PALETTE 2026.08';
const start = css.lastIndexOf(marker);

assert.ok(start >= 0, 'global Studio Neutral palette is present');

const globalPalette = css.slice(start);

for (const token of [
  '--pfx-canvas: #000000',
  '--pfx-primary: #e50914',
  '--pfx-success: #46d38f',
  '--pfx-warning: #e2b656',
  '--pfx-danger: #ff5f6d',
]) {
  assert.ok(globalPalette.includes(token), `global palette declares ${token}`);
}

assert.match(
  globalPalette,
  /\.mac-workspace-toolbar \.tab\.active[\s\S]*?box-shadow:\s*inset 0 -2px 0 var\(--pfx-primary\)/,
  'active workspace uses Netflix red as the primary colour',
);
assert.ok(
  globalPalette.includes('--hwk-blue500: var(--pfx-primary)'),
  'legacy Hawkins components inherit the global primary colour',
);
assert.ok(
  globalPalette.includes('body::before { display: none !important; }'),
  'legacy ambient colour layer is disabled',
);
assert.ok(
  globalPalette.includes('@media (prefers-reduced-motion: reduce)'),
  'global polish respects reduced motion',
);
assert.ok(home.includes('background: #000;'), 'Home uses Netflix black');
assert.match(home, /\.hs-card:hover[\s\S]*?border-color: var\(--card-accent\);/, 'Home cards use their semantic accent for interaction');
assert.match(home, /\.hs-status-dot\.ok\s+\{ background: #46d38f; \}/, 'Home reserves green for readiness');
assert.ok(globalPalette.includes('#main-about .pfx-fb-btn-primary'), 'Settings feedback follows the same primary colour');
assert.ok(css.includes('POSTFLOWX — NETFLIX STUDIO WORKSPACE ACCENTS 2026.08'), 'feature workspaces receive the Netflix accent pass');

for (const accent of [
  '#ff3f5f',
  '#32c9ff',
  '#ffb23e',
  '#b987ff',
  '#4edb96',
  '#75a5ff',
]) {
  assert.ok(home.includes(`--card-accent: ${accent}`), `Home workspace palette includes ${accent}`);
}
assert.match(home, /\.hs-card::before[\s\S]*?linear-gradient\(90deg, var\(--card-accent\)/, 'workspace cards expose their accent without relying on hover');
assert.match(home, /#hs-root #hs-btn-new-project[\s\S]*?linear-gradient\(135deg, #ff2533, var\(--hs-red\)\) !important/, 'primary Home CTA keeps Netflix red above the global theme');
assert.match(home, /\.hs-card-icon\s*\{[\s\S]*?width: 52px;[\s\S]*?height: 52px;/, 'workspace icons are large enough to scan quickly');
assert.match(home, /\.hs-card \.hs-card-icon svg\s*\{[\s\S]*?width: 28px;[\s\S]*?height: 28px;/, 'workspace glyphs scale with their icon tiles');
assert.match(home, /@keyframes hs-icon-sweep/, 'workspace icons have a brief focus and hover highlight');
assert.match(home, /prefers-reduced-motion: reduce[\s\S]*?\.hs-card-icon::after[\s\S]*?animation: none !important;/, 'smart icon motion respects reduced-motion preferences');

assert.match(home, /PostFlowX command center/, 'Home opens as a clear command center');
assert.match(home, /From locked cut to final delivery, in one flow\./, 'Home hero explains the outcome in plain language');
assert.match(home, /id="hs-flow-visual"[\s\S]*>Import<[\s\S]*>Review<[\s\S]*>Deliver</, 'Home visualises the three-stage workflow');
assert.match(
  home,
  /<!-- Hero -->[\s\S]*?<div id="hs-hero">[\s\S]*?id="hs-system-resource"[\s\S]*?<!-- Secondary quick actions -->/,
  'system health occupies the hero-side position',
);
assert.match(
  home,
  /<!-- Bottom: continue working \+ workflow -->[\s\S]*?id="hs-recents-list"[\s\S]*?id="hs-flow-visual"/,
  'workflow occupies the bottom position beside recent projects',
);
assert.equal((home.match(/id="hs-btn-new-project"/g) || []).length, 1, 'Home has one primary start action');
assert.equal((home.match(/id="hs-btn-import-timeline"/g) || []).length, 1, 'Home has one timeline import action');

for (const id of ['hs-system-resource', 'hs-status-list', 'hs-flow-visual']) {
  assert.equal((home.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} remains unique after the swap`);
}

for (const id of [
  'hs-btn-open-project',
  'hs-btn-open-vfx-pull',
  'hs-btn-tl-convert',
  'hs-btn-setup-guide',
  'hs-btn-tour',
  'hs-btn-open-site',
]) {
  assert.equal((home.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} remains unique`);
}

assert.match(home, /Continue working[\s\S]*id="hs-recents-list"/, 'recent projects are grouped as the continue workflow');
assert.match(home, /System health[\s\S]*id="hs-status-list"/, 'system readiness remains visible');
assert.match(home, /Guides &amp; release notes/, 'official guidance remains available');
assert.ok(home.includes('@media (max-width: 900px)'), 'Home adapts to compact windows');
assert.ok(home.includes('@media (prefers-reduced-motion: reduce)'), 'Home respects reduced motion');

console.log('globalStudioPalette.test.mjs passed');
