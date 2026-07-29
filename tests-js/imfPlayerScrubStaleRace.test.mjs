// IMFPlayer._scrubFrame() stale-draw race. Run: node tests-js/imfPlayerScrubStaleRace.test.mjs
//
// _scrubFrame() debounces scrubber-drag calls with a 30ms setTimeout, but that
// only stops a *pending* (not-yet-fired) timer. Once a timeout callback has
// started its await fetch(...)/createImageBitmap(...) chain, a later scrub's
// callback can start and finish first. Without a generation-token guard, the
// earlier (now-stale) callback's drawImage() call can land last and paint an
// old frame over the canvas after a newer scrub already drew the right one.

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// One deferred fetch response per frame, so the test controls resolution order.
const gates = { 1: deferred(), 2: deferred() };

// Each fake ArrayBuffer is one byte holding its own frame number, so the
// frame identity survives the real new Uint8Array(ab) / new Blob([...]) calls
// inside _scrubFrame() unmodified — no need to stub those built-ins.
globalThis.window = { pfxPlatform: {} };
globalThis.fetch = async (url) => {
  const frame = Number(url.split('/').pop());
  await gates[frame].promise;
  const ab = new ArrayBuffer(1);
  new Uint8Array(ab)[0] = frame;
  return { ok: true, arrayBuffer: async () => ab };
};
globalThis.Blob = class { constructor(parts) { this.frame = parts[0][0]; } };
globalThis.createImageBitmap = async (blob) => ({ frame: blob.frame, close() {} });

const { createIMFPlayer } = await import('../src/scripts/modules/imf/imf_player_engine.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

const drawLog = [];
const canvas = {
  width: 100,
  height: 100,
  getContext: () => ({
    drawImage: (bm) => drawLog.push(bm.frame),
    clearRect() {},
  }),
};

const player = createIMFPlayer(canvas, {});
player._packageId = 'pkg1';
player._cplId = 'cpl1';
player._sessionId = 'sess1';
player._frameUrl = 'https://cdn.example.com/imf/frame/sess1';

player._scrubFrame(1);
await new Promise((r) => setTimeout(r, 40)); // let scrub(1)'s 30ms debounce fire; its fetch is now pending on gates[1]

const seqAfterFirst = player._scrubSeq;
ok(seqAfterFirst === 1, '_scrubFrame(1) bumped _scrubSeq before scheduling');

player._scrubFrame(2);
await new Promise((r) => setTimeout(r, 40)); // let scrub(2)'s debounce fire too — now both fetches are in flight

ok(player._scrubSeq === 2, '_scrubFrame(2) bumped _scrubSeq again while scrub(1) was still in flight');

// Resolve the newer scrub's fetch first (simulating it being faster), then the stale one.
gates[2].resolve();
await new Promise((r) => setTimeout(r, 10));
ok(drawLog.length === 1 && drawLog[0] === 2, `fresh scrub(2) drew immediately, got [${drawLog.join(', ')}]`);

gates[1].resolve();
await new Promise((r) => setTimeout(r, 10));

ok(drawLog.length === 1 && drawLog[0] === 2,
  `stale scrub(1) must not draw after scrub(2) already won, got [${drawLog.join(', ')}]`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
