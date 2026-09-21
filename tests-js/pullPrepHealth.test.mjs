import test from 'node:test';
import assert from 'node:assert/strict';
import { derivePullPrepHealth, localizePullPrepHealth } from '../src/scripts/core/pullPrepHealth.js';

test('Pull Prep health gives one deterministic action for every workflow stage', () => {
  assert.equal(derivePullPrepHealth().action.key, 'timeline');
  assert.equal(derivePullPrepHealth({ timelineCount: 4 }).action.key, 'video');
  assert.equal(derivePullPrepHealth({ timelineCount: 4, hasVideo: true }).action.key, 'review');
  assert.equal(derivePullPrepHealth({ timelineCount: 4, hasVideo: true, markerCount: 2, linkedCount: 1 }).action.key, 'link');
  assert.equal(derivePullPrepHealth({
    timelineCount: 4, hasVideo: true, markerCount: 2, linkedCount: 2,
    trackedCount: 2, attentionCount: 1,
  }).action.key, 'vfx-attention');
  assert.equal(derivePullPrepHealth({
    timelineCount: 4, hasVideo: true, markerCount: 2, linkedCount: 2,
    trackedCount: 2, approvedCount: 2,
  }).action.key, 'export');
});

test('Pull Prep health counts concrete blockers without double-counting missing setup', () => {
  const empty = derivePullPrepHealth();
  assert.equal(empty.blockerCount, 1);
  assert.deepEqual(empty.blockers.map(item => item.code), ['timeline']);

  const review = derivePullPrepHealth({
    timelineCount: 10,
    hasVideo: true,
    markerCount: 4,
    linkedCount: 3,
    trackedCount: 3,
    attentionCount: 5,
    overdueCount: 1,
    qcCount: 2,
  });
  assert.equal(review.blockerCount, 6);
  assert.deepEqual(review.blockers.map(item => item.code), ['unlinked-marker', 'overdue', 'qc', 'review']);
});

test('Pull Prep health clamps malformed counts and coverage safely', () => {
  const health = derivePullPrepHealth({
    timelineCount: 2,
    hasVideo: true,
    markerCount: -9,
    linkedCount: 99,
    taggedEventCount: 99,
  });
  assert.equal(health.counts.markerCount, 0);
  assert.equal(health.counts.linkedCount, 0);
  assert.equal(health.counts.coverage, 100);
  assert.equal(health.action.key, 'review');
});

test('Pull Prep health keeps risky editorial changes in review before any VFX marker exists', () => {
  const health = derivePullPrepHealth({
    timelineCount: 8,
    hasVideo: true,
    attentionCount: 3,
    retimeCount: 2,
    resizeCount: 1,
  });
  assert.equal(health.stage, 'review');
  assert.equal(health.tone, 'warn');
  assert.match(health.title, /3 editorial changes/);
  assert.match(health.detail, /2 retime · 1 resize/);
});

test('Pull Prep health localizes dynamic Thai counts without changing workflow decisions', () => {
  const health = derivePullPrepHealth({
    timelineCount: 8,
    hasVideo: true,
    markerCount: 3,
    linkedCount: 3,
    trackedCount: 3,
    attentionCount: 2,
    overdueCount: 1,
    approvedCount: 1,
    qcCount: 1,
    unmarkedCount: 5,
  });
  const thai = localizePullPrepHealth(health, 'th-TH');
  assert.equal(thai.action.key, 'vfx-attention');
  assert.equal(thai.action.label, 'ตรวจรายการงาน VFX');
  assert.match(thai.title, /VFX 3 ช็อต/);
  assert.match(thai.detail, /1 ปัญหา QC/);
  assert.equal(thai.openItemsText, 'มีงานค้าง 2 รายการ');
  assert.equal(thai.blockerCount, health.blockerCount);
});

test('Pull Prep health has native dynamic copy for every app locale', () => {
  const health = derivePullPrepHealth({ timelineCount: 4 });
  const labels = new Map();
  for (const locale of ['en', 'th', 'zh-TW', 'ja', 'ko', 'id', 'fil']) {
    const localized = localizePullPrepHealth(health, locale);
    assert.equal(localized.locale, locale);
    assert.equal(localized.action.key, 'video');
    assert.ok(localized.title);
    assert.ok(localized.detail);
    assert.ok(localized.action.label);
    labels.set(locale, localized.action.label);
  }
  assert.equal(labels.size, 7);
  assert.notEqual(labels.get('th'), labels.get('en'));
  assert.notEqual(labels.get('zh-TW'), labels.get('en'));
});

test('Pull Prep health falls back to English for unsupported locales', () => {
  const health = derivePullPrepHealth();
  const fallback = localizePullPrepHealth(health, 'fr-FR');
  assert.equal(fallback.locale, 'en');
  assert.equal(fallback.action.label, 'Import timeline');
  assert.equal(fallback.openItemsText, '1 open item.');
});
