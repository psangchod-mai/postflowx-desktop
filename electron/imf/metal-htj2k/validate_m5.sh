#!/usr/bin/env bash
# M5: real IMF codestream STRUCTURE. Two kinds of validation:
#  A) structural parse of a REAL Meridian frame (Part-1 MQ — pixels NOT decoded,
#     structure only): dims, tile-parts, CPRL, precincts, cb, per-res precinct counts.
#  B) end-to-end decode of structure-matched HTJ2K vectors (same CPRL + explicit
#     precincts + 3 tile-parts as Meridian) — bit-exact(5/3)/PSNR(9/7), full & reduced.
# Pass string 'FRAME PASS'.
set -uo pipefail
cd "$(dirname "$0")"
export DYLD_LIBRARY_PATH=/opt/homebrew/lib
if [ ! -x ./m2_frame_decode ]; then echo "build first: ./build_m2.sh"; exit 2; fi
OJE=/opt/homebrew/bin/ojph_expand
overall=0
chk(){ echo "$1" | grep -q 'FRAME PASS' && printf "  %-30s PASS\n" "$2" || { printf "  %-30s FAIL\n" "$2"; echo "$1"|grep -E 'FAIL|SKIP|PSNR'|sed 's/^/     /'; overall=1; }; }
has(){ echo "$1" | grep -q "$2" && printf "     ok: %s\n" "$2" || { printf "     MISSING: %s\n" "$2"; overall=1; }; }

echo "== A. REAL Meridian structural parse (Part-1 MQ; pixels NOT decoded) =="
MXF="/Users/psangchod/Movies/NMD/20230311_IMF Sample for Backlot New UI/2_video supplemental/Meridian_tst_HD_23.976fps_HDRIAB_video supplemental/VIDEO_88cc5a7d-9969-43f0-a5b7-d870fb603ac0.mxf"
FF=../../../bin/ffmpeg
MER=/tmp/imf_f001.j2k
if [ ! -f "$MER" ] && [ -f "$MXF" ] && [ -x "$FF" ]; then
  "$FF" -i "$MXF" -c:v copy -frames:v 1 -f image2 /tmp/imf_f%03d.j2k >/dev/null 2>&1 || true
fi
if [ -f "$MER" ]; then
  D=$(./m2_frame_decode --parse-only "$MER")
  echo "$D" | sed 's/^/  /'
  has "$D" "1920 x 1080"
  has "$D" "components     : 3"
  has "$D" "Part-1 MQ"
  has "$D" "tile-parts     : 3"
  has "$D" "progression    : CPRL"
  has "$D" "res 0: 60x34  precinct=128x128"
  has "$D" "res 5: 1920x1080  precinct=256x256"
  has "$D" "precincts=8x5=40"
else
  echo "  (Meridian MXF not available — skipping real-frame structural check)"
fi

echo "== B. structure-matched HTJ2K (CPRL + precincts 128/256 + 3 tile-parts) =="
echo "  -- full-res --"
chk "$(./m2_frame_decode --gpu-full --rct vectors/m5_rct.j2c    vectors/m5_rct.ppm)"                 "m5_rct 512 5/3 RCT (bit-exact)"
chk "$(./m2_frame_decode --gpu-full --ict vectors/m5_ict.j2c    vectors/m5_ict.rt.ppm --psnr 60)"    "m5_ict 512 9/7 ICT (PSNR)"
chk "$(./m2_frame_decode --gpu-full --rct vectors/m5_hd_rct.j2c vectors/m5_hd_rct.ppm)"              "m5_hd_rct 1080p 5/3 RCT (bit-exact)"
chk "$(./m2_frame_decode --gpu-full --ict vectors/m5_hd_ict.j2c vectors/m5_hd_ict.rt.ppm --psnr 60)" "m5_hd_ict 1080p 9/7 ICT (PSNR)"
echo "  -- reduced-res (vs ojph_expand -skip_res N,N) --"
for N in 1 2; do
  $OJE -i vectors/m5_rct.j2c    -o vectors/m5_rct.skip$N.ppm    -skip_res $N,$N >/dev/null 2>&1
  $OJE -i vectors/m5_hd_rct.j2c -o vectors/m5_hd_rct.skip$N.ppm -skip_res $N,$N >/dev/null 2>&1
  $OJE -i vectors/m5_ict.j2c    -o vectors/m5_ict.skip$N.ppm    -skip_res $N,$N >/dev/null 2>&1
  chk "$(./m2_frame_decode --gpu-full --rct --skip $N vectors/m5_rct.j2c    vectors/m5_rct.skip$N.ppm)"              "m5_rct RCT skip$N (bit-exact)"
  chk "$(./m2_frame_decode --gpu-full --rct --skip $N vectors/m5_hd_rct.j2c vectors/m5_hd_rct.skip$N.ppm)"           "m5_hd_rct RCT skip$N (bit-exact)"
  chk "$(./m2_frame_decode --gpu-full --ict --skip $N vectors/m5_ict.j2c    vectors/m5_ict.skip$N.ppm --psnr 60)"    "m5_ict ICT skip$N (PSNR)"
done

echo "== C. non-CPRL progression orders (5/3 RCT, bit-exact) — guards untested-order regressions =="
for P in rpcl pcrl lrcp rlcp; do
  chk "$(./m2_frame_decode --gpu-full --rct vectors/m5_$P.j2c vectors/m5_$P.ppm)" "m5_$P 512 5/3 RCT (bit-exact)"
done

echo
[ "$overall" -eq 0 ] && echo "OVERALL: PASS" || echo "OVERALL: FAIL"
exit $overall
