// P0-RT-REDUCED fps proof: the reduced-resolution (`-lowres`) J2K DWT decode ladder
// must actually cut decode cost and let HD sustain real-time. This drives the SAME
// tools/imf_rt_bench.mjs --j2k path used for the manual benchmark: it encodes a
// representative jpeg2000 clip with the bundled ffmpeg, then decodes it at lowres
// 0/1/2 and measures true fps. Self-skips cleanly when a jpeg2000-capable ffmpeg
// isn't present (e.g. CI without the bundled binary), so it never flakes the suite.
import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Resolve an ffmpeg with a working jpeg2000 encoder, else skip.
function resolveJ2kFfmpeg() {
  const candidates = [path.join(root, 'bin/ffmpeg'), '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'];
  for (const ff of candidates) {
    if (ff !== 'ffmpeg' && !fs.existsSync(ff)) continue;
    // Probe a 1-frame jpeg2000 encode to null — cheap capability check.
    const r = spawnSync(ff, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=24',
      '-frames:v', '1', '-c:v', 'jpeg2000', '-f', 'null', '-',
    ], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 15000 });
    if (r.status === 0) return ff;
  }
  return null;
}

const FF = resolveJ2kFfmpeg();

test('P0-RT-REDUCED: J2K -lowres ladder cuts decode cost and clears 24fps (HD)',
  { skip: !FF ? 'no jpeg2000-capable ffmpeg available' : false },
  () => {
    const r = spawnSync('node', [
      path.join(root, 'tools/imf_rt_bench.mjs'),
      '--j2k', '--res', 'hd', '--frames', '24', '--json',
    ], { encoding: 'utf8', timeout: 120000 });
    assert.strictEqual(r.status, 0, `bench exited ${r.status}: ${r.stderr}`);

    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.mode, 'synthetic-j2k');
    const byLowres = new Map(out.results.map(x => [x.lowres, x]));
    const full = byLowres.get(0), half = byLowres.get(1), quarter = byLowres.get(2);
    for (const lvl of [full, half, quarter]) {
      assert.ok(lvl && lvl.ok, `level lowres=${lvl?.lowres} did not decode`);
    }

    // The reduced levels must clear real-time cadence on HD.
    assert.ok(half.fps    >= 24, `half (lowres1) ${half.fps.toFixed(1)}fps < 24`);
    assert.ok(quarter.fps >= 24, `quarter (lowres2) ${quarter.fps.toFixed(1)}fps < 24`);

    // The ladder must genuinely reduce decode cost: each coarser level is faster.
    assert.ok(half.seconds    <= full.seconds + 1e-6, `lowres1 (${half.seconds}s) not faster than full (${full.seconds}s)`);
    assert.ok(quarter.seconds <= half.seconds + 1e-6, `lowres2 (${quarter.seconds}s) not faster than lowres1 (${half.seconds}s)`);
  });
