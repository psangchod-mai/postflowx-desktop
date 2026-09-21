#!/usr/bin/env bash
# M3 validation: 9/7 irreversible (PSNR) + reduced-resolution (vs ojph_expand
# -skip_res). GPU-FULL path. Pass string is 'FRAME PASS'.
set -uo pipefail
cd "$(dirname "$0")"
export DYLD_LIBRARY_PATH=/opt/homebrew/lib
if [ ! -x ./m2_frame_decode ]; then echo "build first: ./build_m2.sh"; exit 2; fi
overall=0
chk(){ echo "$1" | grep -q 'FRAME PASS' && { printf "  %-28s PASS\n" "$2"; } || { printf "  %-28s FAIL\n" "$2"; echo "$1" | grep -E 'FAIL|SKIP|PSNR' | sed 's/^/      /'; overall=1; }; }

echo "== Part 1: 9/7 irreversible (GPU-FULL, PSNR vs ojph_expand decode) =="
chk "$(./m2_frame_decode --gpu-full --mono           vectors/m3_97_tiny.j2c vectors/m3_97_tiny.rt.raw --psnr 300)" "m3_97_tiny  mono"   # bit-identical: mse==0 (999 dB)
chk "$(./m2_frame_decode --gpu-full --mono           vectors/m3_97_mono.j2c vectors/m3_97_mono.rt.raw --psnr 300)" "m3_97_mono  mono"   # bit-identical: mse==0 (999 dB)
chk "$(./m2_frame_decode --gpu-full --ict            vectors/m3_97_ict.j2c  vectors/m3_97_ict.rt.ppm  --psnr 60)" "m3_97_ict   ICT colour"

echo "== Part 2: reduced-resolution (GPU-FULL vs ojph_expand -skip_res N) =="
for N in 1 2; do
  # 5/3 bit-exact
  ojph_expand -i vectors/m2_mono.j2c -o vectors/m2_mono.skip$N.raw -skip_res $N,$N >/dev/null 2>&1
  out=$(./m2_frame_decode --gpu-full --mono --skip $N vectors/m2_mono.j2c vectors/m2_mono.skip$N.raw)
  echo "$out" | grep -E "skip \]" | sed 's/^/  /'
  chk "$out" "m2_mono 5/3 skip$N (bit-exact)"
  # 9/7 PSNR
  ojph_expand -i vectors/m3_97_mono.j2c -o vectors/m3_97_mono.skip$N.raw -skip_res $N,$N >/dev/null 2>&1
  out=$(./m2_frame_decode --gpu-full --mono --skip $N vectors/m3_97_mono.j2c vectors/m3_97_mono.skip$N.raw --psnr 300)
  chk "$out" "m3_97_mono 9/7 skip$N (PSNR)"
  # 3-component reversible RCT + skip (bit-exact) — guards colour+reduced-res regressions
  ojph_expand -i vectors/m2_rct.j2c -o vectors/m2_rct.skip$N.ppm -skip_res $N,$N >/dev/null 2>&1
  out=$(./m2_frame_decode --gpu-full --rct --skip $N vectors/m2_rct.j2c vectors/m2_rct.skip$N.ppm)
  chk "$out" "m2_rct 5/3 RCT skip$N (bit-exact)"
  # 3-component 9/7 ICT + skip (PSNR)
  ojph_expand -i vectors/m3_97_ict.j2c -o vectors/m3_97_ict.skip$N.ppm -skip_res $N,$N >/dev/null 2>&1
  out=$(./m2_frame_decode --gpu-full --ict --skip $N vectors/m3_97_ict.j2c vectors/m3_97_ict.skip$N.ppm --psnr 60)
  chk "$out" "m3_97_ict 9/7 ICT skip$N (PSNR)"
done

echo "== Part 3: large full-res correctness (GPU-FULL, guards IDWT array-size bug) =="
chk "$(./m2_frame_decode --gpu-full --mono vectors/m3_2k.j2c  vectors/m3_2k.raw)"  "m3_2k   2048x1080 5/3 full"
chk "$(./m2_frame_decode --gpu-full --mono vectors/m3_uhd.j2c vectors/m3_uhd.raw)" "m3_uhd  3840x2160 5/3 full"
chk "$(./m2_frame_decode --gpu-full --mono vectors/m3_97_2k.j2c vectors/m3_97_2k.rt.raw --psnr 300)" "m3_97_2k 2048x1080 9/7 full (guards isyn97 large-width)"

echo
[ "$overall" -eq 0 ] && echo "OVERALL: PASS" || echo "OVERALL: FAIL"
exit $overall
