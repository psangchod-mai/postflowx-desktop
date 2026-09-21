import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pullDurationMatches } from '../src/scripts/features/vfxPull/pullJobModel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'src/index.html'), 'utf8');
const source = readFileSync(join(ROOT, 'src/scripts/prep_mark.js'), 'utf8');
const healthSource = readFileSync(join(ROOT, 'src/scripts/core/pullPrepHealth.js'), 'utf8');
const css = readFileSync(join(ROOT, 'src/styles/main.css'), 'utf8');
const homeSource = readFileSync(join(ROOT, 'src/scripts/features/home/homeScreen.js'), 'utf8');

test('Pull Prep presents a four-stage professional workflow with one next action', () => {
  assert.match(html, /id="pmProBar"/);
  assert.match(html, /data-step="media"[\s\S]*data-step="review"[\s\S]*data-step="mark"[\s\S]*data-step="deliver"/);
  assert.match(html, /id="pmProNextBtn"/);
  assert.match(source, /function _pmProNextAction\(\)/);
  assert.match(source, /derivePullPrepHealth/);
  assert.match(source, /localizePullPrepHealth/);
  assert.match(source, /window\.PFX_getLang\?\.\(\) \|\| 'en'/);
  assert.match(healthSource, /Import timeline/);
  assert.match(healthSource, /Add reference video/);
  assert.match(healthSource, /Review first shot/);
  assert.match(healthSource, /Link unmatched markers/);
  assert.match(healthSource, /Export pull package/);
});

test('Pull Prep refreshes dynamic Project Health copy immediately after a language change', () => {
  const i18nSource = readFileSync(join(ROOT, 'src/scripts/modules/i18n.js'), 'utf8');
  assert.match(i18nSource, /new CustomEvent\('pfx:languagechange'/);
  assert.match(source, /window\.addEventListener\('pfx:languagechange', _pmUpdateProWorkspace\)/);
  assert.match(source, /healthModel\.openItemsText/);
});

test('Pull Prep supports persistent NLE list, split, and review focus modes', () => {
  assert.match(html, /data-pm-view="list"[\s\S]*data-pm-view="split"[\s\S]*data-pm-view="review"/);
  assert.match(source, /const _PM_PRO_VIEW_KEY = 'pfx\.prepmark\.proView\.v1'/);
  assert.match(source, /function _pmSetProView\(view = 'split'/);
  assert.match(css, /#main-prepmark\.pm-pro-view-review \.pm-left/);
  assert.match(css, /#main-prepmark\.pm-pro-view-list \.pm-left/);
  assert.match(css, /flex-basis: clamp\(520px, 46%, 900px\)/);
  assert.match(css, /#main-prepmark\.pm-pro-view-review \.pm-left \{[\s\S]*flex-basis: 320px/);
  assert.match(css, /#main-prepmark\.pm-pro-view-list \.pm-left \{[\s\S]*flex-basis: clamp\(720px, 74%, 1200px\)/);
});

test('Pull Prep provides a persistent keyboard-accessible NLE panel divider', () => {
  assert.match(html, /id="pmPanelDivider"[\s\S]*role="separator"/);
  assert.match(html, /aria-label="Resize Shot List"/);
  assert.match(source, /const _PM_PRO_WIDTH_KEY = 'pfx\.prepmark\.shotListRatio\.v1'/);
  assert.match(source, /function _pmApplyShotListRatio\(ratio/);
  assert.match(source, /function _pmWirePanelDivider\(\)/);
  assert.match(source, /divider\.addEventListener\('pointerdown'/);
  assert.match(source, /divider\.addEventListener\('dblclick'/);
  assert.match(source, /const left = e\.key === 'ArrowLeft' \|\| e\.key === 'Left'/);
  assert.match(source, /const right = e\.key === 'ArrowRight' \|\| e\.key === 'Right'/);
  assert.match(source, /_pmApplyShotListRatio\([^\n]+\{ persist: true \}/);
  assert.match(css, /\.pm-panel-divider \{/);
  assert.match(css, /#main-prepmark\.pm-pro-custom-width \.pm-left/);
});

test('Pull Prep reports real timeline, video, marker, link, and coverage state', () => {
  assert.match(source, /const hasTimeline = _pmEvents\.length > 0/);
  assert.match(source, /const hasVideo = _pmProHasVideo\(\)/);
  assert.match(source, /const orphanCount = Math\.max\(0, markerCount - linked\)/);
  assert.match(source, /const coverage = hasTimeline \? Math\.round/);
  assert.match(source, /_pmUpdateProWorkspace\(\)/);
  assert.match(css, /\.pm-pro-health\[data-tone="good"\]/);
  assert.match(css, /\.pm-pro-health\[data-tone="warn"\]/);
});

test('Pull Prep monitor explicitly communicates direct AVFoundation review', () => {
  assert.match(html, /PROGRAM MONITOR/);
  assert.match(html, /id="pmProAvfBadge">AVFoundation/);
  assert.match(html, /Add reference video/);
  assert.match(html, /<video id="pmVideo"[^>]*aria-hidden="true"/);
  assert.match(source, /_pmNativeAssetId \|\| pmVideo\?\._pfxNativeEngine \|\| pmVideo\?\.currentSrc/);
  assert.match(css, /\.pm-pro-monitor-head/);
});

test('Pull Prep provides searchable editorial triage and next-attention review', () => {
  for (const filter of ['all', 'attention', 'retime', 'resize', 'marked', 'unmarked']) {
    assert.match(html, new RegExp(`data-pm-filter="${filter}"`));
  }
  assert.match(html, /id="pmProSearch"/);
  assert.match(html, /id="pmProNextAttention"/);
  assert.match(source, /function _pmProEventSignals\(ev, idx\)/);
  assert.match(source, /function _pmApplyProListFilter\(\)/);
  assert.match(source, /function _pmProJumpNextAttention\(\)/);
  assert.match(source, /function _pmProIssueForIndex\(idx\)/);
  assert.match(source, /function _pmProAttentionQueue\(\)/);
  assert.match(source, /Check speed change/);
  assert.match(source, /Check resize \/ reframe/);
  assert.match(html, /id="pmProNextAttentionReason">Nothing to review/);
  assert.match(css, /#pmEventBody tr\.pm-pro-filtered-out/);
});

test('Pull Prep keeps common filters visible and moves specialist filters into one menu', () => {
  assert.match(html, /id="pmProMoreFilters" class="pm-pro-filter-more"/);
  assert.match(html, /id="pmProMoreFilters"[\s\S]*data-pm-filter="qc"[\s\S]*data-pm-filter="due"[\s\S]*data-pm-filter="approved"[\s\S]*data-pm-filter="unmarked"/);
  assert.match(source, /btn\.closest\('details'\)\?\.removeAttribute\('open'\)/);
  assert.match(css, /#main-prepmark \.pm-pro-filter-more > div/);
});

test('Pull Prep refreshes smart counts and the active filter after every flag toggle', () => {
  const vfxFlagHandler = source.match(/\/\/ VFX flag toggles \(Retime \/ Stabilize \/ Resize\)[\s\S]*?\/\/ TC and SoW inputs/)?.[0] || '';
  const tableFlagHandler = source.match(/\/\/ \.pm-flag-chip — RT\/ST\/RS toggle[\s\S]*?\/\/ \.pm-mk-add-btn/)?.[0] || '';
  assert.match(vfxFlagHandler, /_pmRenderEventTable\(\);[\s\S]*_pmUpdateProWorkspace\(\);/);
  assert.match(tableFlagHandler, /_pmUpdateProWorkspace\(\);[\s\S]*MPS_markProjectDirty/);
});

test('Pull Prep undo clears manual flags that are absent from the restored snapshot', () => {
  assert.match(source, /function _pmClearManualMetaFromEvents\(\)[\s\S]*delete ev\._pmRetime;[\s\S]*delete ev\._pmResize;/);
  const restore = source.match(/function _pmSlyRestoreSnapshot\(snap\)[\s\S]*?\/\/ ── Full project reset/)?.[0] || '';
  assert.match(restore, /_pmClearManualMetaFromEvents\(\);[\s\S]*_pmApplyMetaToEvents\(\)/);
});

test('Pull Prep verifies normal pull duration with inclusive ends and handles', () => {
  assert.equal(pullDurationMatches({ eventFrames: 1944, jobFrames: 1961, handleFrames: 8 }), true);
  assert.equal(pullDurationMatches({ eventFrames: 1944, jobFrames: 1944, handleFrames: 8 }), false);
  assert.equal(pullDurationMatches({ eventFrames: 100, jobFrames: 80, handleFrames: 8, hasSpeedChange: true }), null);
  assert.equal(pullDurationMatches({ eventFrames: 100, jobFrames: 3, hasSpeedChange: true, sourceFrameMap: [10, 11, 12] }), true);
});

test('Pull Prep exposes the Studio NLE visual hierarchy and guided empty state', () => {
  assert.match(html, /STEP 1 · EDIT TIMELINE/);
  assert.match(html, />Add your timeline</);
  assert.match(html, />Choose timeline</);
  assert.match(html, /data-pm-view="list"[^>]*>Shot List</);
  assert.match(html, /data-pm-view="review"[^>]*>Monitor</);
  assert.match(css, /PULL PREP — STUDIO NLE POLISH 2026\.08/);
  assert.match(css, /--pm-studio-blue: #e50914/);
  assert.match(css, /#main-prepmark \.pm-event-table thead \{[\s\S]*position: sticky/);
  assert.match(css, /\.pm-drop-hint-eyebrow/);
  assert.match(css, /STEP 2 · REFERENCE MEDIA/);
  assert.match(source, /if \(t\) t\.textContent = 'Add your timeline'/);
});

test('Pull Prep uses a compact progressive command deck before media is loaded', () => {
  assert.match(css, /PULL PREP — COMPACT SMART VFX COMMAND DECK 2026\.08/);
  assert.match(css, /#main-prepmark:not\(\.pm-pro-has-timeline\) \.pm-pro-view/);
  assert.match(css, /#main-prepmark:not\(\.pm-pro-has-timeline\) \.pm-st-kpi/);
  assert.match(css, /#main-prepmark:not\(\.pm-pro-has-timeline\) \.pm-ve-metrics/);
  assert.match(css, /#main-prepmark \.pm-pro-bar \{[\s\S]*min-height: 48px/);
  assert.match(css, /#main-prepmark \.pm-ve-ribbon \{[\s\S]*min-height: 38px/);
});

test('Pull Prep merges setup, progress, action, and VFX queue into one adaptive NLE strip', () => {
  assert.match(html, /id="pmSmartCommandDeck" class="pm-smart-command-deck"/);
  assert.match(html, /id="pmSmartCommandDeck"[\s\S]*id="pmQsRow"[\s\S]*id="pmProBar"[\s\S]*id="pmVfxEditorRibbon"[\s\S]*<!-- Issue Inbox -->/);
  assert.match(css, /PULL PREP — UNIFIED SMART COMMAND BAR 2026\.08/);
  assert.match(css, /#main-prepmark \.pm-smart-command-deck \{[\s\S]*min-height: 42px/);
  assert.match(css, /#main-prepmark \{[\s\S]*grid-template-rows: auto auto auto minmax\(0, 1fr\) 220px/);
  assert.match(css, /#main-prepmark > \.pm-body \{ grid-row: 4; \}/);
  assert.match(css, /#main-prepmark > \.pm-timeline-strip \{ grid-row: 5; \}/);
  assert.match(css, /\.pm-smart-command-deck > \.pm-qs-row,[\s\S]*\.pm-smart-command-deck > \.pm-pro-bar,[\s\S]*\.pm-smart-command-deck > \.pm-ve-ribbon \{[\s\S]*height: 34px/);
  assert.match(css, /\.pm-smart-command-deck \.pm-pro-health,[\s\S]*\.pm-smart-command-deck \.pm-pro-view \{ display: none; \}/);
  assert.match(css, /not\(\.pm-pro-has-timeline\) \.pm-smart-command-deck > \.pm-ve-ribbon,[\s\S]*\.pm-st-kpi \{[\s\S]*display: none/);
});

test('Pull Prep removes competing toolbar actions without removing their functions', () => {
  assert.match(html, /id="pmToolsMenu" class="pm-tools-wrap"/);
  assert.match(html, /Tools <span aria-hidden="true">/);
  assert.match(html, /id="pmToolsMenu"[\s\S]*id="pmCtxVoiceBtn"[\s\S]*id="pmCtxAiBtn"[\s\S]*id="pmAutoLinkBtn"[\s\S]*id="pmAleMatchBtn"[\s\S]*id="pmMarkerMatchBtn"/);
  assert.match(html, /id="pmExportBtn"[^>]*>Deliver/);
  assert.match(html, /id="pmImportEdlBtn"[^>]*>Add timeline/);
  assert.match(html, /data-key="clear"[^>]*>[\s\S]*Defaults/);
  assert.match(html, /id="pmQsOptionsToggle"[^>]*title="Show or hide advanced workflow options"/);
  assert.match(source, /function _wireToolsMenu\(\)/);
  assert.match(source, /menu\.open && !menu\.contains\(event\.target\)/);
  assert.match(css, /#main-prepmark \.pm-ctx-bar \{[\s\S]*flex-wrap: nowrap/);
  assert.match(css, /#main-prepmark \.pm-tools-menu \{[\s\S]*width: 248px/);
});

test('Pull Prep workflow toggles and shot flags are real keyboard-operable buttons', () => {
  for (const key of ['clear', 'conform', 'vfxmarker', 'merge', 'flatten', 'decompose', 'metadata', 'autosplit', 'df', 'extra']) {
    assert.match(html, new RegExp(`<button[^>]+class="pm-qs-btn[^>]+data-key="${key}"[^>]+aria-pressed="false"`));
  }
  assert.match(source, /<button type="button" class="pm-flag-chip pm-flag-rt/);
  assert.match(source, /<button type="button" class="pm-flag-chip pm-flag-st/);
  assert.match(source, /<button type="button" class="pm-flag-chip pm-flag-rs/);
  assert.match(source, /btn\.setAttribute\('aria-pressed', on \? 'true' : 'false'\)/);
  assert.match(css, /\.pm-flag-chip \{[\s\S]*appearance: none;[\s\S]*font: inherit;/);
  assert.match(css, /\.pm-qs-btn \{[\s\S]*appearance: none;[\s\S]*font: inherit;/);
});

test('Home promotes the most recent project as the primary next action', () => {
  assert.match(homeSource, /id="hs-primary-action-label"/);
  assert.match(homeSource, /function _setHeroProjectAction\(project = null\)/);
  assert.match(homeSource, /primary\.dataset\.action = 'continue'/);
  assert.match(homeSource, /_setHeroProjectAction\(limited\[0\]\)/);
  assert.match(homeSource, /id="hs-btn-new-project-secondary" hidden/);
  assert.match(homeSource, /if \(typeof project === 'string'\) return project\.trim\(\)/);
  assert.match(homeSource, /const name = _recentName\(proj, idx\)/);
});
