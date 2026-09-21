import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'src/index.html'), 'utf8');
const source = readFileSync(join(ROOT, 'src/scripts/prep_mark.js'), 'utf8');
const healthSource = readFileSync(join(ROOT, 'src/scripts/core/pullPrepHealth.js'), 'utf8');
const css = readFileSync(join(ROOT, 'src/styles/main.css'), 'utf8');
const vfxPanel = readFileSync(join(ROOT, 'src/scripts/features/vfxPull/vfxPullPanel.js'), 'utf8');

test('Pull Prep presents a compact Smart VFX Editor command layer', () => {
  assert.match(html, /id="pmVfxEditorRibbon"/);
  assert.match(html, />SMART VFX EDITOR</);
  assert.match(html, /Shots · versions · QC · handoffs · final delivery/);
  for (const id of ['pmVeTracked', 'pmVeAttention', 'pmVeOverdue', 'pmVeApproved', 'pmVePriority']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(css, /PULL PREP — SMART VFX EDITOR 2026\.08/);
  assert.match(css, /\.pm-ve-ribbon/);
});

test('selected shots own version, status, delivery, owner, vendor, QC, handoffs, and notes', () => {
  assert.match(html, /id="pmVfxShotControl"/);
  assert.match(source, /const _PM_VE_STAGES = \['turnover', 'vendor', 'review', 'approved', 'final'\]/);
  assert.match(source, /const _PM_VE_QC_KEYS = \['frames', 'timing', 'resolution', 'color', 'handles'\]/);
  assert.match(source, /const _PM_VE_HANDOFF_KEYS = \['editorial', 'vfx', 'color', 'online', 'sound'\]/);
  for (const field of ['stage', 'version', 'due', 'owner', 'vendor', 'note']) {
    assert.match(source, new RegExp(`data-ve-field=\\"${field}\\"`));
  }
  assert.match(source, /data-ve-qc/);
  assert.match(source, /data-ve-handoff/);
});

test('marker workflow shows one smart next task and progressively discloses production details', () => {
  assert.match(source, /const _pmVfxDetailsOpen = new Set\(\)/);
  assert.match(source, /class="pm-ve-smart-row"/);
  assert.match(source, /data-ve-next-task/);
  assert.match(source, /data-ve-details-toggle aria-expanded=/);
  assert.match(source, /class="pm-ve-details\$\{detailsOpen \? ' is-open' : ''\}"/);
  assert.match(source, /if \(key === 'mark'\) _pmProJumpNextAttention\(\)/);
  assert.match(css, /PULL PREP — SMART MARKER TASK CARD 2026\.08/);
  assert.match(css, /\.pm-ve-shot-control \{[\s\S]*max-height: 84px/);
  assert.match(css, /\.pm-ve-shot-control\.is-details-open \{[\s\S]*max-height: 232px/);
  assert.match(css, /\.pm-ve-details \{ display: none/);
  assert.match(css, /\.pm-ve-details\.is-open \{ display: block/);
});

test('selected-shot rendering owns its HTML escaping and cannot fail on an active shot', () => {
  const start = source.indexOf('function _pmRenderVfxEditorDesk()');
  const end = source.indexOf('function _pmSetProView(', start);
  assert.ok(start >= 0 && end > start, 'selected-shot renderer exists');
  const renderer = source.slice(start, end);
  assert.match(renderer, /const htmlEsc = value =>/);
  assert.doesNotMatch(renderer, /\$\{esc\(/, 'renderer must not call a function-local esc helper from another scope');
});

test('the VFX worklist detects delivery and technical risk and drives next attention', () => {
  assert.match(source, /function _pmVfxEditorIssues\(ev, idx\)/);
  assert.match(source, /Delivery overdue/);
  assert.match(source, /QC failed:/);
  assert.match(source, /Finish QC:/);
  assert.match(source, /Confirm final online handoff/);
  assert.match(healthSource, /key: 'vfx-attention'/);
  assert.match(source, /case 'vfx-attention': _pmProJumpNextAttention\(\)/);
  for (const filter of ['qc', 'due', 'approved']) {
    assert.match(html, new RegExp(`data-pm-filter="${filter}"`));
  }
});

test('VFX Editor state persists with the project and remains visible in the Shot List', () => {
  assert.match(source, /let _pmVfxEditorMap = new Map\(\)/);
  assert.match(source, /vfxEditorDesk\.v1/);
  assert.match(source, /vfxEditor: _pmObjectFromMap\(_pmVfxEditorMap\)/);
  assert.match(source, /prepMark\.vfxEditor/);
  assert.match(source, /pm-ve-row-/);
  assert.match(css, /\.pm-ve-row-approved/);
  assert.match(css, /\.pm-ve-row\.needs-attention/);
});

test('VFX Pull upgrades the legacy surface into one guided OCF workflow', () => {
  assert.match(vfxPanel, /ws\?\.dataset\.smartWorkspace === '1'/);
  assert.match(vfxPanel, /ws\.dataset\.smartWorkspace = '1'/);
  assert.doesNotMatch(vfxPanel, /function _injectVfxWorkspace\(\) \{\s*if \(document\.getElementById\('pmVfxWorkspace'\)\) return/);
  assert.match(vfxPanel, /id="pmWsSmartBar"/);
  assert.match(vfxPanel, /id="pmWsNextAction"/);
  assert.match(vfxPanel, /1 Link OCF[\s\S]*2 Check changes[\s\S]*3 Approve/);
  assert.doesNotMatch(vfxPanel, /id="pmWsAutoVerifyAll"/);
  assert.doesNotMatch(vfxPanel, /id="pmWsAutoVerifyBtn"/);
  assert.doesNotMatch(vfxPanel, /id="pmWsApproveLinkBtn"/);
});

test('VFX Pull explains OCF, speed-retime, and size before technical detail', () => {
  assert.match(vfxPanel, /class="pm-vfx-ws-change-summary"/);
  assert.match(vfxPanel, /'Camera file'/);
  assert.match(vfxPanel, /'Speed \/ retime'/);
  assert.match(vfxPanel, /'Size \/ framing'/);
  assert.match(vfxPanel, /Variable speed ramp/);
  assert.match(vfxPanel, /Resize \/ reframe/);
  assert.match(vfxPanel, /<details class="pm-vfx-ws-tech-details">/);
});

test('VFX Pull previews dynamic ramps from the explicit frame map', () => {
  assert.match(vfxPanel, /function _wsFrameForPos\(posKey, row = \{\}, job = \{\}\)/);
  assert.match(vfxPanel, /_wsRecordFrameForPos\(posKey, row, job\)/);
  assert.match(vfxPanel, /const frameMap = job\?\.retime\?\.sourceFrameMap/);
  assert.match(vfxPanel, /recF - t\.recInF \+ handles/);
  assert.match(vfxPanel, /frameMap\[mapIndex\]\?\.sourceFrame/);
});

test('specialist relink and compare controls use progressive disclosure', () => {
  assert.match(source, /const _showOcfTools = _isVfxPull && row\.classList\.contains\('pm-qs-expanded'\)/);
  assert.match(source, /if \(_ocfSmart\) _ocfSmart\.style\.display = 'none'/);
  assert.match(source, /_pmSetVfxWorkspaceVisible\(true\)/);
  assert.match(vfxPanel, /class="pm-vfx-ws-mode is-more" data-ws-mode="qt_ref"/);
  assert.match(vfxPanel, /id="pmWsMoreModes"/);
  assert.match(vfxPanel, /show-more-modes/);
});
