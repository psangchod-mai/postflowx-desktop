// pfxTransport DOM smoke test (linkedom). Run: node tests-js/pfxTransportDom.test.mjs
// Mounts the shared component against a synthetic adapter and exercises the
// DOM-delegating adapter against fake player markup — no browser needed.
import { parseHTML } from 'linkedom';

const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = document;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent || window.Event;
globalThis.AbortController = globalThis.AbortController || window.AbortController;
// rAF: no-op (we drive refresh() manually so loops never spin in the harness).
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
// linkedom lacks toggleAttribute(name, force) — polyfill it.
if (!window.Element.prototype.toggleAttribute) {
  window.Element.prototype.toggleAttribute = function (n, f) {
    const on = f === undefined ? !this.hasAttribute(n) : !!f;
    if (on) this.setAttribute(n, ''); else this.removeAttribute(n);
    return on;
  };
}

const { mountTransport, makeDelegatingAdapter } = await (async () => {
  const tx = await import('../src/scripts/core/pfxTransport.js');
  const mt = await import('../src/scripts/core/pfxTransportMount.js');
  return { ...tx, ...mt };
})();
const { framesToTC } = await import('../src/scripts/modules/utils_time.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

// ── Part A: component over a synthetic adapter ──────────────────────────────
{
  let frame = 0, playing = false; const calls = [];
  const host = document.createElement('div'); document.body.appendChild(host);
  const adapter = {
    name: 'synthetic', host,
    getFrame: () => frame, getDuration: () => 100, getFps: () => 24,
    seekToFrame: (f) => { frame = f; }, isPlaying: () => playing,
    play: (r) => { calls.push(['play', r]); playing = true; },
    pause: () => { calls.push(['pause']); playing = false; },
    stop() { this.pause(); },
    jumpStart: () => { calls.push(['jumpStart']); frame = 0; },
    jumpEnd: () => { calls.push(['jumpEnd']); frame = 99; },
    items: { type: 'cuts', prev: () => calls.push(['prev']), next: () => calls.push(['next']) },
    inPoint: () => null, outPoint: () => null,
  };
  const ctrl = mountTransport(adapter);
  ok(!!ctrl, 'mount returns a controller');
  ok(!!host.querySelector('.pfx-tx'), 'bar mounted (.pfx-tx)');
  ok(!!host.querySelector('.pfx-tx-scrub'), 'scrub bar present');
  ok(!!host.querySelector('.pfx-tx-navpod'), 'nav pod present');
  eq(host.querySelectorAll('.pfx-tx-btn-row button[data-act]').length, 8, 'navpod(2) + 6 transport buttons = 8 buttons');

  // Render reflects adapter frame/duration.
  frame = 50; ctrl.refresh();
  eq(host.querySelector('.pfx-tx-tc-cur').textContent, framesToTC(50, 24), 'current TC = framesToTC(50,24)');
  eq(host.querySelector('.pfx-tx-tc-dur').textContent, framesToTC(99, 24), 'duration TC = framesToTC(99,24)');
  ok(host.querySelector('.pfx-tx-scrub-fill').style.width.startsWith('50'), 'fill ~50% at frame 50/99');

  // Click play → adapter.play(1), green state.
  const clickAct = (act) => host.querySelector(`[data-act="${act}"]`).dispatchEvent(new window.Event('click', { bubbles: true }));
  clickAct('playFwd');
  ok(calls.some(c => c[0] === 'play' && c[1] === 1), 'play button → adapter.play(1)');
  ok(host.querySelector('.pfx-tx-play').classList.contains('pfx-tx-playing'), 'play button turns green while playing');

  // Click play again while playing → pause.
  clickAct('playFwd');
  ok(calls.some(c => c[0] === 'pause'), 'play again → pause');

  // Jump start → adapter.jumpStart + momentary blue flash class.
  clickAct('jumpStart');
  ok(calls.some(c => c[0] === 'jumpStart'), 'jumpStart button → adapter.jumpStart');
  ok(host.querySelector('.pfx-tx-jstart').classList.contains('pfx-tx-flash'), 'jumpStart flashes blue');

  // Nav pod.
  clickAct('nextItem');
  ok(calls.some(c => c[0] === 'next'), 'nav pod › → items.next');

  // ◀ click = CONTINUOUS reverse playback (blue while active).
  adapter.seekToFrame(50);
  clickAct('playBack');
  ok(calls.some(c => c[0] === 'play' && c[1] === -1), '◀ click → adapter.play(-1) (continuous reverse)');
  ok(host.querySelector('.pfx-tx-back').classList.contains('pfx-tx-active'), '◀ engages blue reverse-active state');

  // Idempotent re-mount (identity check; don't stringify the DOM).
  ok(mountTransport(adapter) === ctrl, 're-mount returns same controller (idempotent)');
  ok(host.querySelectorAll('.pfx-tx').length === 1, 'no duplicate bar after re-mount');
}

// ── Part B: DOM-delegating adapter (slider-backed player, no <video>) ───────
{
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="pm-controls">
      <input id="pmScrub" type="range" min="0" max="200" value="0">
      <button id="pmPlayBtn">▶</button>
      <button id="pmTlGoStartBtn">|<</button>
      <button id="pmPrevEventBtn">‹</button>
      <button id="pmNextEventBtn">›</button>
    </div>`;
  document.body.appendChild(wrap);
  let playClicks = 0, prevClicks = 0;
  wrap.querySelector('#pmPlayBtn').addEventListener('click', () => playClicks++);
  wrap.querySelector('#pmPrevEventBtn').addEventListener('click', () => prevClicks++);

  const cfg = {
    name: 'prepmark-test', slider: '#pmScrub', video: ['pmVideoMissing'],
    itemsType: 'markers',
    btn: { play: '#pmPlayBtn', start: '#pmTlGoStartBtn', prevItem: '#pmPrevEventBtn', nextItem: '#pmNextEventBtn' },
  };
  const a = makeDelegatingAdapter(cfg);
  a.host = document.createElement('div');

  eq(a.getDuration(), 201, 'slider max 200 → duration 201 frames');
  eq(a.getFrame(), 0, 'slider value 0 → frame 0');
  a.seekToFrame(50);
  eq(document.getElementById('pmScrub').value, '50', 'seekToFrame(50) sets slider value');
  eq(a.getFrame(), 50, 'getFrame reflects new slider value');

  a.play(1);
  eq(playClicks, 1, 'play(1) on a paused slider player clicks the play button');
  a.items.prev();
  eq(prevClicks, 1, 'items.prev() clicks the prev-item button');

  a.jumpStart();          // start button present → clicks it (no seek assertion needed)
  ok(true, 'jumpStart delegates without throwing');
}

// ── Part C: loop toggle — delegation, <video> fallback, and dead-control hide ─
{
  // C1 — IMF-style delegated loop button (#imfTbLoop toggles .is-active).
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="imf-transport-btns-v2">
      <button id="imfBtnPlay">▶</button>
      <button id="imfTbLoop" class="imf-tbtn2">⟳</button>
    </div>`;
  document.body.appendChild(wrap);
  const loopBtn = wrap.querySelector('#imfTbLoop');
  loopBtn.addEventListener('click', () => {            // emulate imf_player.js
    const on = !loopBtn.classList.contains('is-active');
    loopBtn.classList.toggle('is-active', on);
    loopBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const a = makeDelegatingAdapter({ name: 'imf-test', video: [], btn: { play: '#imfBtnPlay', loop: '#imfTbLoop' } });
  a.host = document.createElement('div');
  eq(a.canLoop(), true, 'canLoop true when a loop button is mapped');
  eq(a.loop(), false, 'loop() false initially');
  a.setLoop(true);
  eq(a.loop(), true, 'setLoop → delegated #imfTbLoop toggles is-active → loop() true');
  a.setLoop(false);
  eq(a.loop(), false, 'setLoop again → loop() false');

  // C2 — <video> fallback: no loop button, but a <video> to loop.
  const vid = document.createElement('video'); vid.id = 'pmVideoLoopTest';
  document.body.appendChild(vid);
  const b = makeDelegatingAdapter({ name: 'vfx-test', video: ['pmVideoLoopTest'], btn: { play: '#noPlay' } });
  b.host = document.createElement('div');
  eq(b.canLoop(), true, 'canLoop true when a <video> is present (fallback loop source)');
  eq(b.loop(), false, 'video.loop false initially');
  b.setLoop(true);
  eq(b.loop(), true, 'setLoop(true) sets video.loop → loop() true');

  // C3 — no loop source (slider-only): capability false, button hidden on mount.
  const host = document.createElement('div'); document.body.appendChild(host);
  const c = makeDelegatingAdapter({ name: 'vfxws-test', slider: '#vfxwsSliderMissing', video: [], btn: { play: '#noPlay2' } });
  c.host = host;
  mountTransport(c);
  eq(c.canLoop(), false, 'canLoop false when no video and no loop button');
  const loopEl = host.querySelector('.pfx-tx-loop');
  ok(loopEl && loopEl.style.display === 'none', 'loop button hidden when adapter cannot loop');
}

// ── Part D: active loop swaps the glyph (colour alone read as too subtle) ────
{
  let looping = false;
  const host = document.createElement('div'); document.body.appendChild(host);
  const adapter = {
    name: 'loopicon-test', host,
    getFrame: () => 0, getDuration: () => 100, getFps: () => 24,
    seekToFrame: () => {}, isPlaying: () => false,
    play: () => {}, pause: () => {}, stop() {},
    jumpStart: () => {}, jumpEnd: () => {},
    items: { type: 'cuts', prev: () => {}, next: () => {} },
    inPoint: () => null, outPoint: () => null,
    loop: () => looping, setLoop: (on) => { looping = on == null ? !looping : !!on; },
  };
  mountTransport(adapter);
  const loopEl = host.querySelector('.pfx-tx-loop');
  ok(!!loopEl?.querySelector('.pfx-tx-glyph-loop'), 'loop button renders the masked loop glyph');
  ok(!loopEl.classList.contains('pfx-tx-loop-on'), 'loop button not marked active when off');
  loopEl.dispatchEvent(new window.Event('click', { bubbles: true }));   // toggle via the bar
  ok(loopEl.classList.contains('pfx-tx-loop-on'), 'clicking loop marks it active (recolours the glyph)');
  ok(!!loopEl.querySelector('.pfx-tx-glyph-loop'), 'active state keeps the same masked glyph');
  loopEl.dispatchEvent(new window.Event('click', { bubbles: true }));   // toggle back off
  ok(!loopEl.classList.contains('pfx-tx-loop-on'), 'toggling loop off clears the active state');
}

// ── Part E: prefer the active AVFoundation monitor over a dormant video ─────
{
  const wrap = document.createElement('div');
  wrap.innerHTML = `<video id="cmpDormant"></video><video id="programNative"></video>`;
  document.body.appendChild(wrap);
  let nativePaused = 0;
  const native = {
    fps: 24, duration: 5, currentFrame: 12, isPlaying: true,
    pause() { nativePaused++; this.isPlaying = false; },
    play() { this.isPlaying = true; },
    seekFrame() {},
  };
  document.getElementById('programNative')._pfxNativeEngine = native;
  const a = makeDelegatingAdapter({
    name: 'native-preference-test',
    video: ['cmpDormant', 'programNative'],
    btn: { play: '#missingNativePlay' },
  });
  a.host = document.createElement('div');
  eq(a.getFrame(), 12, 'adapter selects the AVFoundation-backed monitor over an earlier dormant video');
  eq(a.isPlaying(), true, 'native monitor supplies authoritative playing state');
  a.stop();
  eq(nativePaused, 1, 'Stop pauses the active AVFoundation engine');
  eq(a.isPlaying(), false, 'native monitor reports paused after Stop');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
