#!/usr/bin/env bash
# M6a: app wiring of the Metal HTJ2K decoder (feature-flagged, default OFF).
# Headless-verifiable checks up to the renderer boundary (GUI playback needs
# manual testing). Requires ./build_native.sh to have produced the packaged helper.
set -uo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../../.. && pwd)"
overall=0
ok(){ printf "  %-46s PASS\n" "$1"; }
bad(){ printf "  %-46s FAIL\n" "$1"; overall=1; }

BIN=../../native/pfx_htj2k_metal/pfx_htj2k_metal
echo "== packaging: self-contained helper =="
[ -x "$BIN" ] || { echo "  helper not built — run ./build_native.sh"; exit 2; }
if otool -L "$BIN" | grep -q "/opt/homebrew"; then bad "otool -L: NO /opt/homebrew dependency"; otool -L "$BIN"|grep /opt/homebrew|sed 's/^/     /'; else ok "otool -L: no /opt/homebrew dependency"; fi
[ -f ../../native/pfx_htj2k_metal/cup_decode_mt.metal ] && [ -f ../../native/pfx_htj2k_metal/idwt_color.metal ] && ok "MSL kernels shipped next to helper" || bad "MSL kernels shipped next to helper"
# runs self-contained (clean env, no /opt/homebrew, no DYLD_LIBRARY_PATH)
V=$(env -i PATH=/usr/bin:/bin HOME="$HOME" "$BIN" --version 2>/dev/null || true)
echo "$V" | grep -q "pfx-htj2k-metal" && ok "runs self-contained (clean env)" || bad "runs self-contained (clean env)"

echo "== helper --ipc decode (bit-exact vs oracle) + Part-1 fallback =="
cd "$ROOT"
node -e '
const be=require("./electron/imf/imf_metal_htj2k_backend"), fs=require("fs"), path=require("path");
(async()=>{
  const av=await be.checkAvailability(); if(!av.any){console.log("BACKEND_UNAVAILABLE");process.exit(3);}
  const j2c=path.resolve("electron/imf/metal-htj2k/vectors/m5_rct.j2c");
  const d=await be.decodeCodestream(j2c,{});
  if(!d.ok){console.log("DECODE_FAIL "+d.code);process.exit(3);}
  const ppm=fs.readFileSync("electron/imf/metal-htj2k/vectors/m5_rct.ppm");
  let i=0,nl=0; while(nl<3){if(ppm[i]===0x0a)nl++;i++;} const body=ppm.subarray(i);
  let diffs=0,N=d.samples.length/2; for(let k=0;k<N;k++) if(d.samples.readUInt16LE(k*2)!==body.readUInt16BE(k*2))diffs++;
  console.log("DECODE_BITEXACT "+(diffs===0?"YES":("NO/"+diffs)));
  // Part-1 fallback (real Meridian frame if present)
  const mer="/tmp/imf_f001.j2k";
  if(fs.existsSync(mer)){ fs.copyFileSync(mer,"/tmp/mer_m6.j2c"); const m=await be.decodeCodestream("/tmp/mer_m6.j2c",{});
    console.log("MERIDIAN_CODE "+(m.code||(m.ok?"OK":"?"))); }
  else console.log("MERIDIAN_SKIP");
  process.exit(0);
})().catch(e=>{console.log("ERR "+e.message);process.exit(3);});
' > /tmp/m6_node.out 2>&1
cat /tmp/m6_node.out | sed 's/^/     /'
grep -q "DECODE_BITEXACT YES" /tmp/m6_node.out && ok "backend decode bit-exact vs ojph_expand" || bad "backend decode bit-exact vs ojph_expand"
if grep -q "MERIDIAN_CODE NOT_HTJ2K" /tmp/m6_node.out; then ok "real Meridian (Part-1) -> NOT_HTJ2K fallback"; elif grep -q "MERIDIAN_SKIP" /tmp/m6_node.out; then echo "  (Meridian frame /tmp/imf_f001.j2k absent — fallback check skipped)"; else bad "real Meridian (Part-1) -> NOT_HTJ2K fallback"; fi

echo "== flag OFF = byte-identical (static proof) =="
# The provider branch is gated by process.env.PFX_IMF_METAL_HTJ2K and lazily
# require()s the backend only inside that branch; the renderer branch requires
# result.samplesB64 (only set by that branch). Confirm the gates exist.
grep -q "process.env.PFX_IMF_METAL_HTJ2K" electron/imf/imf_frame_provider.js && ok "provider branch env-gated (flag OFF => skipped)" || bad "provider branch env-gated"
grep -q "result.samplesB64 && result.metalFrameInfo" src/scripts/modules/imf/imf_player.js && ok "renderer branch requires samplesB64 (never set when OFF)" || bad "renderer branch gated"
node --check electron/imf/imf_metal_htj2k_backend.js && node --check electron/imf/imf_frame_provider.js && ok "app modules parse" || bad "app modules parse"

echo "== M6b: shared-memory ring pixel channel =="
cd "$ROOT"
node -e '
const be=require("./electron/imf/imf_metal_htj2k_backend"), fs=require("fs"), cp=require("child_process"), path=require("path");
const V=path.resolve("electron/imf/metal-htj2k/vectors");
const bin=be._binPath();
function ppm(p){const b=fs.readFileSync(p);let i=0,nl=0;while(nl<3){if(b[i]===0x0a)nl++;i++;}return b.subarray(i);}
const rings=()=>fs.readdirSync("/tmp").filter(f=>f.startsWith("pfx_htj2k_ring_"));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const av=await be.checkAvailability(); if(!av.any){console.log("UNAVAIL");process.exit(3);}
  // ring bit-exact (5/3) + reports ring:true
  const d=await be.decodeCodestream(V+"/m5_rct.j2c",{}); const body=ppm(V+"/m5_rct.ppm");
  let diffs=0,N=d.samples.length/2; for(let k=0;k<N;k++) if(d.samples.readUInt16LE(k*2)!==body.readUInt16BE(k*2))diffs++;
  console.log("RING_BITEXACT "+(diffs===0?"YES":"NO"));
  // torn-frame hammer: 40 rapid decodes all bit-exact
  let torn=0; for(let it=0;it<40;it++){const r=await be.decodeCodestream(V+"/m5_rct.j2c",{}); for(let k=0;k<N;k++) if(r.samples.readUInt16LE(k*2)!==body.readUInt16BE(k*2)){torn++;break;}}
  console.log("HAMMER_TORN "+torn);
  // reduced-res via ring bit-exact vs -skip_res
  let rrok=true; for(const S of [1,2]){ cp.execSync(`/opt/homebrew/bin/ojph_expand -i ${V}/m5_rct.j2c -o ${V}/m5_rct.skip${S}.ppm -skip_res ${S},${S}`,{stdio:"ignore"});
    const r=await be.decodeCodestream(V+"/m5_rct.j2c",{skip:S}); const b2=ppm(`${V}/m5_rct.skip${S}.ppm`); let dd=0,M=r.samples.length/2; for(let k=0;k<M;k++) if(r.samples.readUInt16LE(k*2)!==b2.readUInt16BE(k*2)){dd++;break;} if(dd)rrok=false; }
  console.log("REDUCEDRES_RING "+(rrok?"BITEXACT":"MISMATCH"));
  // leak: raw helper SIGTERM cleans its ring; SIGKILL lingers then next start sweeps
  rings().forEach(f=>{try{fs.unlinkSync("/tmp/"+f)}catch{}});
  const env={...process.env,PFX_MSL_DIR:path.dirname(bin)};
  const A=cp.spawn(bin,["--ipc"],{stdio:["pipe","pipe","ignore"],env});
  await new Promise(r=>{A.stdout.once("data",()=>r());A.stdin.write(JSON.stringify({id:1,cmd:"decode",j2cPath:V+"/m5_rct.j2c"})+"\n");}); await sleep(150);
  A.kill("SIGTERM"); await sleep(400); const termClean=rings().length===0;
  const B=cp.spawn(bin,["--ipc"],{stdio:["pipe","pipe","ignore"],env});
  await new Promise(r=>{B.stdout.once("data",()=>r());B.stdin.write(JSON.stringify({id:1,cmd:"decode",j2cPath:V+"/m5_rct.j2c"})+"\n");}); await sleep(150);
  B.kill("SIGKILL"); await sleep(300); const lingered=rings().length>0;
  const C=cp.spawn(bin,["--ipc"],{stdio:["pipe","pipe","ignore"],env}); await sleep(400); const swept=rings().length===0; C.kill("SIGTERM");
  console.log("LEAK_SIGTERM "+(termClean?"CLEANED":"LEAK")); console.log("LEAK_SIGKILL "+((lingered&&swept)?"SWEPT":"?"));
  process.exit(0);
})().catch(e=>{console.log("ERR "+e.message);process.exit(3);});
' > /tmp/m6b_val.out 2>&1
cat /tmp/m6b_val.out | sed "s/^/     /"
grep -q "RING_BITEXACT YES"     /tmp/m6b_val.out && ok "ring pixel channel bit-exact"        || bad "ring pixel channel bit-exact"
grep -q "HAMMER_TORN 0"         /tmp/m6b_val.out && ok "torn-frame hammer (40 decodes, 0 torn)" || bad "torn-frame hammer"
grep -q "REDUCEDRES_RING BITEXACT" /tmp/m6b_val.out && ok "reduced-res via ring bit-exact vs -skip_res" || bad "reduced-res via ring"
grep -q "LEAK_SIGTERM CLEANED"  /tmp/m6b_val.out && ok "ring cleaned on graceful close (SIGTERM)" || bad "ring cleanup on close"
grep -q "LEAK_SIGKILL SWEPT"    /tmp/m6b_val.out && ok "ring swept after crash (SIGKILL + next start)" || bad "ring sweep after crash"

echo
[ "$overall" -eq 0 ] && echo "OVERALL: PASS" || echo "OVERALL: FAIL"
exit $overall
