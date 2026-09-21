import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';
import { parseXMEML } from '../src/scripts/parsers/xml.js';

if (!globalThis.DOMParser) globalThis.DOMParser = DOMParser;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'src/scripts/features/trlconf/index.js'), 'utf8');
const css = readFileSync(join(ROOT, 'src/styles/main.css'), 'utf8');

test('Trailer Conform exposes the V1.4 picture evidence contract', () => {
  assert.match(source, /PICTURE CONFORM V1\.4/);
  assert.match(source, /const visualDistance = regionalDistances\.length \? Math\.round\(_median\(regionalDistances\)\) : null/);
  assert.match(source, /visualStatus === 'NO_MATCH'[\s\S]*?'FAIL'[\s\S]*?visualStatus === 'REVIEW'[\s\S]*?'REVIEW'/);
  assert.match(source, /OK ≤80 · REVIEW ≤200 · NO MATCH &gt;200/);
  assert.match(source, /V1\.4\+continuous-pixel/);
  assert.match(source, /Pixel agreement/);
  assert.match(source, /Math\.min\(rawVisualConfidence, visualPixelSimilarity\)/);
  assert.match(source, /pixelStatus === 'NO_MATCH'/);
});

test('frame search re-ranks tolerant hash candidates using actual pixels', () => {
  assert.match(source, /const rerankCandidates = async \(candidates\)/);
  assert.match(source, /robustPixelSimilarity\(refPixelData, masterPixels/);
  assert.match(source, /0\.70 \* pixelSimilarity \+ 0\.30 \* regionalConfidence/);
  assert.match(source, /localPixelsWeak/);
});

test('event start boundary is pixel-validated before SAFE status', () => {
  assert.match(source, /async function _refineSourceInBoundary/);
  assert.match(source, /delta <= 12/);
  assert.match(source, /Math\.min\(visualPixelSimilarity, startRefine\.pixelSimilarity\)/);
  assert.match(source, /boundaryPixelSimilarity: startRefine\?\.pixelSimilarity/);
  assert.match(source, /startBoundaryRefined: !!startRefine\?\.refined/);
});

test('review cockpit has a complete attention-queue interaction', () => {
  for (const id of [
    'trcBtnPrevReview',
    'trcBtnNextReview',
    'trcBtnNextAttention',
    'trcReviewCounter',
    'trcReviewReadinessPct',
    'trcReviewReadinessFill',
    'trcBtnOpenAttention',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `${id} is missing from markup`);
    assert.match(source, new RegExp(`_\\$\\('${id}'\\)`), `${id} is not wired`);
  }
  assert.match(source, /meta\.decision = 'approved'/);
  assert.match(source, /meta\.decision = 'rejected'/);
});

test('simple review mode focuses the videos and has two reliable exit paths', () => {
  assert.match(source, /classList\.toggle\('trc-review-focus', shouldFocus\)/);
  assert.match(source, /&#8592; Results/);
  assert.match(source, /window\.addEventListener\('keydown',[\s\S]*?key === 'escape'[\s\S]*?trcCloseVerify/);
  assert.match(css, /\.trc-simple-mode\.trc-review-focus/);
  assert.match(css, /\.trc-simple-mode\.trc-review-focus[\s\S]*?\.trc-frame-canvas[\s\S]*?object-fit:\s*contain/);
});

test('professional evidence and readiness styling ships with the renderer', () => {
  for (const className of [
    'trc-engine-badge',
    'trc-evidence-grid',
    'trc-distance-scale',
    'trc-review-nav',
    'trc-review-readiness',
  ]) {
    assert.match(css, new RegExp(`\\.${className}\\b`), `${className} styling is missing`);
  }
});

test('guided NLE workflow is readable, navigable, and fast to review', () => {
  for (const id of [
    'trcPanelInputs', 'trcPanelMatch', 'trcPanelResults', 'trcPanelExport',
    'trcBtnAutoNext', 'trcBtnUndoDecision', 'trcBtnModeToggle',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `${id} is missing from markup`);
  }
  assert.match(source, /data-stage="load"[\s\S]*?data-stage="match"[\s\S]*?data-stage="review"[\s\S]*?data-stage="export"/);
  assert.match(source, /autoAdvanceReview:\s+true/);
  assert.match(source, /function _advanceAfterDecision/);
  assert.match(source, /_advanceAfterDecision\(decidedEvId\)/);
  assert.match(source, /key === ' ' \|\| key === 'spacebar'/);
  assert.match(source, /key === 'arrowleft'/);
  assert.match(source, /key === 'j'/);
  assert.match(source, /key === 'k'/);
  assert.match(source, /key === 'l'/);
  assert.match(source, /key === 'a'/);
  assert.match(source, /key === 'x'/);
  assert.match(source, /key === 'd'/);
  assert.match(source, /Complete — \$\{corrCount\}\/\$\{totalEvents\} events analyzed/);
  assert.match(css, /\.trc-workspace-tab\b/);
  assert.match(css, /\.trc-auto-next\.is-active\b/);
  assert.match(css, /\.trc-shortcut-help\b/);
});

test('media pool exposes live readiness, next action, and direct ProRes preparation', () => {
  for (const id of [
    'trcMediaReadyCount', 'trcMediaNextTitle', 'trcMediaNextText',
    'trcBtnMediaNext', 'trcCutState', 'trcRefState', 'trcSourceState',
    'trcMediaStepCut', 'trcMediaStepRef', 'trcMediaStepSource',
    'trcMatchReadiness',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `${id} is missing from markup`);
  }
  assert.match(source, /function _updateMediaPoolUI/);
  assert.match(source, /Number\(hasCut\) \+ Number\(hasRef\) \+ Number\(mastersReady\)/);
  assert.match(source, /Opening originals directly with AVFoundation — no proxy/);
  assert.match(source, /_getVisibleEvents\(\)\.length} timeline shots/);
  assert.match(source, /item\.ready \? 'READY' : item\.preparing \? 'PREPARING' : isActive \? 'NEXT' : 'WAITING'/);
  assert.match(source, /trcBtnMediaNext'\)\?\.addEventListener/);
  assert.match(css, /\.trc-media-guide\b/);
  assert.match(css, /\.trc-media-meter > i\.is-ready\b/);
  assert.match(css, /\.trc-icard\.is-active\b/);
  assert.match(css, /\.trc-media-card-state\.is-preparing\b/);
  assert.match(css, /\.trc-match-readiness\.is-ready\b/);
});

test('review cockpit supports undo, loop playback, and visible compare modes', () => {
  assert.match(source, /reviewHistory:\s+\[\]/);
  assert.match(source, /loopPlayback:\s+false/);
  assert.match(source, /function _recordDecisionHistory/);
  assert.match(source, /function _undoLastDecision/);
  assert.match(source, /_recordDecisionHistory\(decidedEvId\)/);
  assert.match(source, /id="trcNleLoop"/);
  assert.match(source, /if \(state\.loopPlayback\)/);
  assert.match(source, /startWall = performance\.now\(\)/);
  assert.match(source, /key === 'u'/);
  assert.match(source, /e\.shiftKey[\s\S]*?trcNleLoop/);
  assert.match(source, /data-mode="side"[\s\S]*?data-mode="wipe"[\s\S]*?data-mode="overlay"[\s\S]*?data-mode="diff"/);
  assert.match(source, /setAttribute\('aria-pressed', 'false'\)/);
  assert.match(css, /\.trc-review-undo\b/);
  assert.match(css, /\.trc-nle-loop\.is-active\b/);
  assert.match(css, /\.trc-simple-mode\.trc-review-focus \.trc-view-modes/);
});

test('NLE monitor timeline supports direct ganged scrubbing and boundary transport', () => {
  for (const id of ['trcNleGoStart', 'trcNleGoEnd', 'trcNleLanes']) {
    assert.match(source, new RegExp(`id="${id}"`), `${id} is missing from markup`);
    assert.match(source, new RegExp(`_\\$\\('${id}'\\)`), `${id} is not wired`);
  }
  assert.match(source, /role="slider"[\s\S]*?Click or drag to scrub both monitors/);
  assert.match(source, /async function _seekVerifyProgress/);
  assert.match(source, /_verifySourceDelta\(refDelta\)/);
  assert.match(source, /addEventListener\('pointerdown'/);
  assert.match(source, /addEventListener\('pointermove'/);
  assert.match(source, /aria-valuetext/);
  assert.match(source, /The monitor timeline represents the selected shot/);
  assert.match(css, /\.trc-nle-lanes\[role="slider"\]/);
  assert.match(css, /\.trc-nle-scrub-hint\b/);
});

test('full master-library fallback is automatic, bounded, and cancellable', () => {
  assert.match(source, /searchProfile === 'library' \? 12 : 2/);
  assert.match(source, /if \(shouldCancel\(\)\) throw new Error\('Conform stopped'\)/);
  assert.match(source, /isEpisodeLibraryEvent\(ev\) && shouldSearchAllMasters/);
  assert.match(source, /searchProfile: 'library'/);
  assert.match(source, /multiMasterFallback:\s*true/);
  assert.match(source, /aiAutoFallback:\s*false/);
  assert.match(source, /id="trcOptDeepSearch" checked/);
  assert.match(source, /state\.multiMasterFallback = enabled/);
  assert.match(css, /\.trc-deep-search-opt\b/);
});

test('master selection loads a complete folder and native ProRes review really plays', () => {
  assert.match(source, /_wireDropZone\('trcDropMasters',[\s\S]*?'folder', _onSourceFiles\)/);
  assert.match(source, /_openFilePicker\('folder', _onSourceFiles\)/);
  assert.match(source, /window\.pfxPlatform\?\.listMediaFolder/);
  assert.match(source, /function _verifySourceDelta/);
  assert.match(source, /ref\?\._pfxNativeFrameSource \|\| src\?\._pfxNativeFrameSource/);
  assert.match(source, /await Promise\.all\(\[[\s\S]*?_seekVideo\(ref, refTime\)[\s\S]*?_seekVideo\(src, srcTime\)/);
  assert.match(source, /_verifyRedrawFrame\(\);[\s\S]*?_updateVerifyPlayhead\(refTime\)/);
  assert.match(source, /lastFrameDelta = Math\.max\(0, shotDuration - frameSec\)/);
  assert.match(source, /Playback reached the last frame of this shot\./);
  assert.match(source, /syncScrub:\s*true/);
  assert.match(source, /<b>GANG ON<\/b><small>REFERENCE \+ MASTER<\/small>/);
  assert.match(source, /aria-label="Play both ganged monitors"/);
  assert.match(source, /GANG ON · Trailer Reference and Original Master are playing together/);
  assert.match(source, /src && state\.syncScrub \? _seekVideo\(src, srcTime\)/);
  assert.match(source, /id="trcNlePosition" aria-live="polite"/);
  assert.match(css, /\.trc-nle-position\b/);
  assert.match(css, /\.trc-gang-toggle\.is-active\b/);
  assert.match(css, /\.trc-nle-play-main\b/);
});

test('Premiere speed maps, resize metadata, and editorial overlays parse correctly', () => {
  const xml = `<?xml version="1.0"?><xmeml version="4"><sequence><name>Test</name><rate><timebase>24</timebase><ntsc>FALSE</ntsc></rate><timecode><string>01:00:00:00</string></timecode><media><video>
    <track><clipitem><name>The_Show_Season_2_Episode_2.mov</name><start>0</start><end>60</end><in>1875</in><out>1935</out><file id="f1"><name>The_Show_Season_2_Episode_2.mov</name><rate><timebase>24</timebase><ntsc>FALSE</ntsc></rate></file>
      <filter><effect><name>Basic Motion</name><parameter><parameterid>scale</parameterid><value>50</value></parameter><parameter><parameterid>center</parameterid><value><horiz>0</horiz><vert>0</vert></value></parameter></effect></filter>
      <filter><effect><name>Time Remap</name><parameter><parameterid>variablespeed</parameterid><value>1</value></parameter><parameter><parameterid>speed</parameterid><value>122.486</value></parameter><parameter><parameterid>graphdict</parameterid><keyframe><when>1875</when><value>1875</value></keyframe><keyframe><when>1935</when><value>2124</value></keyframe></parameter></effect></filter>
    </clipitem></track>
    <track><clipitem><name>Adjustment Layer</name><start>5</start><end>10</end><in>0</in><out>5</out><file id="f2"><name>Adjustment Layer</name></file></clipitem></track>
  </video></media></sequence></xmeml>`;
  const parsed = parseXMEML(xml);
  const shot = parsed.events.find(event => event.clipName.includes('Season_2'));
  const layer = parsed.events.find(event => event.clipName === 'Adjustment Layer');
  assert.equal(shot.transform.scale, 50);
  assert.deepEqual(shot.transform.position, [0, 0]);
  assert.equal(shot.nominalSpeedPercent, 122.486);
  assert.deepEqual(shot.speedKeys, [{ when: 1875, value: 1875 }, { when: 1935, value: 2124 }]);
  assert.equal(layer.autoPreserve, true);
  assert.equal(layer.preserveReason, 'Adjustment layer');
});

test('Episode 2 naming, effect-preserving export, and NLE review UI are shipped', () => {
  assert.match(source, /season\[_\\s-\]\*\(\\d\+\).*?episode/);
  assert.match(source, /metrics\.dynamicSpeed[\s\S]*?graphdict/);
  assert.match(source, /new XMLSerializer\(\)\.serializeToString\(doc\)/);
  assert.match(source, /editorial overlay/);
  for (const id of [
    'trcNleInspector', 'trcNleTrack', 'trcNleRecord', 'trcNleSource',
    'trcNleSpeed', 'trcNleTransform', 'trcNleGoStart', 'trcNleStepBack', 'trcNlePlay',
    'trcNleStepForward', 'trcNleGoEnd', 'trcNleLanes', 'trcNleClipV1', 'trcNleClipV2', 'trcNlePlayhead',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), `${id} is missing from markup`);
  }
  assert.match(source, /Speed ramp ·/);
  assert.match(source, /const dynamicReview = metrics\.dynamicSpeed/);
  assert.match(source, /pixelGateOk && !metrics\.dynamicSpeed/);
  assert.match(source, /trc-simple-mode trc-nle-workspace/);
  assert.match(source, /trc-nle-workspace-strip/);
  assert.match(source, /SOURCE \/ RECORD MONITORS/);
  assert.match(source, /CONFORM TIMELINE/);
  assert.match(source, /function _transformDescriptor/);
  assert.match(css, /\.trc-nle-timeline\b/);
  assert.match(css, /\.trc-nle-playhead\b/);
  assert.match(css, /grid-template-areas:[\s\S]*?"media monitors"[\s\S]*?"timeline timeline"/);
});
