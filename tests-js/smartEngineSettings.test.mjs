// Settings › Resolve Engine panel (linkedom). Run: node --test tests-js/smartEngineSettings.test.mjs
//
// This panel is where four of friendlyError's sixteen hints send the user, so
// it is the end of the trail for someone whose export just failed. It had two
// defects that only show up from that seat:
//
//   1. Repair Engines was a silent no-op on three of the four log tabs. It
//      wrote its instructions to _logsData['playback'] and then called
//      _renderActiveLogTab(), which resolves its channel from whichever tab
//      carries .is-active. Select IMF, Proxy or Resolve and the text went to a
//      channel nobody was looking at: the button did nothing, visibly. Select
//      Playback and it did work — by overwriting the log that had just been
//      fetched. A write to a fixed channel read back from the active one.
//
//   2. Seven status lines printed raw exception text (`FAILED: ENOENT: no such
//      file or directory, open '/Volumes/…'`), on the screen whose whole job is
//      to be the plain-language answer to that.
//
// Both are invisible in a passing build — the first prints nothing, the second
// prints something. Hence this file. It drives the real init() wiring against a
// fixture rather than calling internals, because the tab handler and the render
// are half of what went wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MODULE_SRC = readFileSync(ROOT + 'src/scripts/modules/smart_engine_settings.js', 'utf8');
const INDEX_SRC  = readFileSync(ROOT + 'src/index.html', 'utf8');

// The ids and the four data-log channels, exactly as index.html spells them.
// Kept as data so the fixture below can be checked against the real markup —
// a fixture that has drifted from index.html passes tests the app fails.
const IDS = [
  'smartEngineStatusList', 'smartEngineCheckBtn', 'smartEngineDecodeTestBtn',
  'smartEngineImfDecodeBtn', 'smartEngineProxyTestBtn', 'smartEngineShowLogsBtn',
  'smartEngineRepairBtn', 'smartEngineDecodeResult', 'smartEngineDecodeLabel',
  'smartEngineDecodeImg', 'smartEngineLogsPanel', 'smartEngineLogsTabs',
  'smartEngineLogsContent',
];
const CHANNELS = ['playback', 'imf', 'proxy', 'resolve'];

const FIXTURE = `
<div id="smartEnginePanel">
  <div id="smartEngineStatusList"></div>
  <button id="smartEngineCheckBtn">Check Engines</button>
  <button id="smartEngineDecodeTestBtn">Decode Test Frame</button>
  <button id="smartEngineImfDecodeBtn">IMF Decode Test</button>
  <button id="smartEngineProxyTestBtn">Generate Test Proxy</button>
  <button id="smartEngineShowLogsBtn">Show Logs</button>
  <button id="smartEngineRepairBtn">Repair Engines</button>
  <div id="smartEngineDecodeResult" style="display:none;">
    <div id="smartEngineDecodeLabel"></div>
    <img id="smartEngineDecodeImg">
  </div>
  <div id="smartEngineLogsPanel" style="display:none;">
    <div id="smartEngineLogsTabs">
      ${CHANNELS.map((c, i) =>
        `<button class="smart-log-tab${i === 0 ? ' is-active' : ''}" data-log="${c}">${c}</button>`,
      ).join('\n      ')}
    </div>
    <pre id="smartEngineLogsContent"></pre>
  </div>
</div>`;

// A fresh document per test: init() attaches listeners to the elements it finds
// at call time, and _logsData lives at module scope, so a panel left over from
// the previous case would let the next one pass on stale state.
function mount({ smartMedia = {} } = {}) {
  const { window, document } = parseHTML(`<!doctype html><html><body>${FIXTURE}</body></html>`);
  globalThis.window = window;
  globalThis.document = document;
  window.__PFX_IS_ELECTRON = true;
  window.pfxPlatform = { smartMedia };
  return { window, document };
}
mount();

const { init } = await import('../src/scripts/modules/smart_engine_settings.js');

const click = (el) => el.dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
const selectTab = (document, channel) => {
  const tab = document.querySelector(`.smart-log-tab[data-log="${channel}"]`);
  assert.ok(tab, `fixture has no ${channel} tab`);
  click(tab);
};

// ── The fixture has to be the real panel ─────────────────────────────────────

test('every id the fixture provides is a real id in index.html', () => {
  const missing = IDS.filter((id) => !INDEX_SRC.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `fixture invents ids the app does not have:\n  ${missing.join('\n  ')}`);
});

test('the panel really does have four log channels, playback active', () => {
  // The whole defect below depends on there being more than one channel and on
  // the default not being the only one. If index.html ever drops to a single
  // tab these tests would still pass while testing nothing.
  const tabs = [...INDEX_SRC.matchAll(/class="[^"]*smart-log-tab[^"]*"[^>]*data-log="([a-z]+)"/g)]
    .map((m) => m[1]);
  assert.deepEqual(tabs, CHANNELS, 'the log tabs in index.html no longer match this fixture');
  const active = INDEX_SRC.match(/class="[^"]*smart-log-tab[^"]*is-active[^"]*"[^>]*data-log="([a-z]+)"/);
  assert.equal(active?.[1], 'playback', 'the default-active log tab moved');
});

// ── (1) Repair Engines must show up on whichever tab is open ─────────────────

for (const channel of CHANNELS) {
  test(`Repair Engines prints the instructions with the ${channel} tab active`, () => {
    const { document } = mount();
    init();
    selectTab(document, channel);

    click(document.getElementById('smartEngineRepairBtn'));

    const content = document.getElementById('smartEngineLogsContent');
    const panel   = document.getElementById('smartEngineLogsPanel');
    assert.notEqual(panel.style.display, 'none', 'the logs panel stayed hidden');
    assert.match(content.textContent, /brew install ffmpeg/,
      `Repair Engines printed nothing on the ${channel} tab`);
  });
}

test('Repair Engines does not overwrite the logs that were fetched', () => {
  const logs = {
    playback: 'PLAYBACK-LOG-LINE',
    imf: 'IMF-LOG-LINE',
    proxy: 'PROXY-LOG-LINE',
    resolve: 'RESOLVE-LOG-LINE',
  };
  const { document } = mount({ smartMedia: { showLogs: async () => ({ logs }) } });
  init();

  return (async () => {
    click(document.getElementById('smartEngineShowLogsBtn'));
    await new Promise((r) => setTimeout(r, 0));
    const content = document.getElementById('smartEngineLogsContent');
    assert.equal(content.textContent, 'PLAYBACK-LOG-LINE', 'showLogs did not load the playback log');

    click(document.getElementById('smartEngineRepairBtn'));
    assert.match(content.textContent, /brew install ffmpeg/);

    // Clicking any tab has to hand the panel back to the real logs. This is
    // what makes writing to the element instead of the channel safe, and it is
    // also the half the old version could not do: it had already destroyed the
    // playback log to make room for the instructions.
    for (const channel of CHANNELS) {
      selectTab(document, channel);
      assert.equal(content.textContent, logs[channel],
        `after Repair Engines, the ${channel} tab no longer shows its log`);
    }
  })();
});

test('the instructions lead with what this is before any command', () => {
  // A non-technical reader who clicked a button called Repair Engines gets a
  // Terminal transcript. The words before the first `brew` line are the only
  // thing standing between them and giving up, so their absence is a defect.
  const { document } = mount();
  init();
  click(document.getElementById('smartEngineRepairBtn'));
  const text = document.getElementById('smartEngineLogsContent').textContent;

  const lead = text.slice(0, text.indexOf('brew install ffmpeg'));
  assert.ok(lead.length > 400, 'the brew commands arrive with almost no explanation in front of them');
  assert.match(lead, /Terminal/, 'never says where these lines are meant to be typed');
  assert.match(lead, /Homebrew/, 'never names Homebrew or says what to do when brew is missing');
  assert.match(lead, /Check Engines/, 'never tells the reader how to confirm it worked');
  assert.match(text, /password/i, 'no warning that a password prompt shows nothing while you type');
});

// ── (2) No raw exception text on this screen ─────────────────────────────────

test('every failure line in this panel goes through friendlyStatus', () => {
  // Enumerated as constructs, not as the wordings that exist today: a rewrite
  // that renames "Decode test failed" must not slip past by changing a literal.
  // Any write of `.message` or a raw error/stderr value into an element has to
  // have friendlyStatus somewhere in the same statement.
  const raw = /(?:\.textContent\s*=|_setStatusText\s*\(|\.innerHTML\s*=)[^;]*?(?:\berr(?:or)?\.message\b|\$\{\s*msg\s*\}|\bstderr\b)/g;
  const hits = [];
  for (const line of MODULE_SRC.split('\n')) {
    for (const m of line.matchAll(raw)) hits.push({ line: line.trim(), stmt: m[0] });
  }
  // Without this the scan is free to pass by matching nothing at all, which is
  // how two earlier iterations of this project fooled themselves.
  assert.ok(hits.length >= 5, `the scan found only ${hits.length} error-text writes — did it stop matching?`);

  const offenders = hits.filter((h) => !/friendlyStatus|friendlyText|friendlyAlert/.test(h.stmt)).map((h) => h.line);
  assert.deepEqual(offenders, [], `raw error text written to the panel:\n  ${offenders.join('\n  ')}`);
});

test('the humanized line is passed with an operation prefix friendlyStatus can keep', () => {
  // friendlyStatus only preserves a prefix when the part before the colon
  // contains a space (`^([^:]{1,40}\s[^:]{0,40}):`). "FAILED: …" does not, so
  // it would silently lose the label and print the humanized tail alone.
  const calls = [...MODULE_SRC.matchAll(/friendlyStatus\(`([^`]*)`\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 6, `expected the panel's failure sites, found ${calls.length}`);
  for (const c of calls) {
    const prefix = c.split(':')[0];
    assert.ok(/\S\s\S/.test(prefix), `"${prefix}:" has no space, so friendlyStatus will drop it`);
    assert.match(prefix, /fail/i, `"${prefix}" does not say that something failed`);
  }
});

test('a humanized failure keeps its advice on its own line', () => {
  // friendlyStatus joins message and hint with a newline (iteration 22). The
  // elements it lands in are plain <div>s with default white-space, where that
  // newline collapses back into the run-on line the newline was added to fix.
  const { document } = mount({
    smartMedia: { decodeFrame: async () => { throw new Error("ENOENT: no such file or directory, open '/Volumes/SHOW DRIVE 01/a.ari'"); } },
  });
  globalThis.window.pfxPlatform.pickFile = async () => '/Volumes/SHOW DRIVE 01/a.ari';
  init();

  return (async () => {
    click(document.getElementById('smartEngineDecodeTestBtn'));
    await new Promise((r) => setTimeout(r, 0));
    const label = document.getElementById('smartEngineDecodeLabel');
    assert.match(label.textContent, /^Decode test failed: /, 'lost the operation label');
    assert.doesNotMatch(label.textContent, /ENOENT/, 'still showing the raw errno');
    assert.ok(label.textContent.includes('\n'), 'the advice is not on its own line');
    assert.equal(label.style.whiteSpace, 'pre-wrap', 'the newline will collapse when rendered');
  })();
});

test('a failure with no detail says so rather than saying "unknown"', () => {
  // `Proxy failed: unknown` read as if the app knew something and would not
  // say. Grep for the old word rather than the new sentence: the point is that
  // it is gone, whatever replaced it.
  assert.doesNotMatch(MODULE_SRC, /\|\|\s*'unknown'/, "still falling back to the word 'unknown'");
});

// ── The comment that described a behaviour the function does not have ────────

test('the header no longer claims Repair Engines opens a browser', () => {
  const header = MODULE_SRC.slice(0, MODULE_SRC.indexOf('*/'));
  assert.doesNotMatch(header, /external browser/,
    'the header still says Repair Engines opens a browser; it writes into the logs panel');
  assert.doesNotMatch(MODULE_SRC, /openExternal|shell\.open|window\.open/,
    'if a browser is opened now, the corrected comment is the thing that is wrong');
});
