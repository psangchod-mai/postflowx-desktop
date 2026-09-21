#!/usr/bin/env bash
# M2 full-frame validation. For each vector, compares the decoded FULL FRAME to
# the ojph_expand oracle (== input for lossless 5/3) bit-exact, in three modes:
#   CPU       : parser + OpenJPH scalar block decode + CPU IDWT/colour
#   GPU       : parser + PARALLEL Metal block decode (many threadgroups) + CPU IDWT/colour
#   GPU-FULL  : + Metal IDWT + Metal inverse-RCT/DC-shift  (whole frame on GPU)
# Also re-runs the M1 single-codeblock vectors as a regression.
set -uo pipefail
cd "$(dirname "$0")"
export DYLD_LIBRARY_PATH=/opt/homebrew/lib
if [ ! -x ./m2_frame_decode ]; then echo "build first: ./build_m2.sh"; exit 2; fi

# name : mode-flag : oracle-file
MONO=(m2_tiny m2_small m2_mono m2_np2)
overall=0
run(){ # $1 label  $2 extra-flags  $3 j2c  $4 oracle  $5 modeflag
  out=$(./m2_frame_decode $2 $5 "$3" "$4" 2>&1)
  echo "$out" | grep -qE 'FRAME PASS' && { printf "  %-9s PASS\n" "$1"; } || { printf "  %-9s FAIL\n" "$1"; echo "$out" | grep -E 'FAIL|SKIP' | sed 's/^/      /'; overall=1; }
}
for v in "${MONO[@]}"; do
  echo "== $v (5/3 mono) =="
  run CPU      "" "vectors/$v.j2c" "vectors/$v.raw" "--mono"
  run GPU      "--gpu" "vectors/$v.j2c" "vectors/$v.raw" "--mono"
  run GPU-FULL "--gpu-full" "vectors/$v.j2c" "vectors/$v.raw" "--mono"
done
echo "== m2_rct (5/3 3-component + RCT) =="
run CPU      "" "vectors/m2_rct.j2c" "vectors/m2_rct.ppm" "--rct"
run GPU      "--gpu" "vectors/m2_rct.j2c" "vectors/m2_rct.ppm" "--rct"
run GPU-FULL "--gpu-full" "vectors/m2_rct.j2c" "vectors/m2_rct.ppm" "--rct"

echo
echo "== falsification sanity (must FAIL) =="
cp vectors/m2_small.j2c /tmp/pfx_corrupt.j2c
python3 -c "d=bytearray(open('/tmp/pfx_corrupt.j2c','rb').read()); d[len(d)//2]^=0xFF; open('/tmp/pfx_corrupt.j2c','wb').write(d)"
if ./m2_frame_decode --gpu-full --mono /tmp/pfx_corrupt.j2c vectors/m2_small.raw 2>&1 | grep -q 'FRAME PASS'; then
  echo "  corrupted-codestream: still PASSed — compare is bogus!"; overall=1
else echo "  corrupted-codestream: correctly did NOT pass (compare is real)"; fi

echo
echo "== M1 regression (single-codeblock, if present) =="
if [ -x ./m1_block_decode ]; then
  for v in cb64_grad cb32_grad cb64_rand cb32_rand cb64_sparse cb32_sparse; do
    if [ -f vectors/$v.j2c ]; then
      ./m1_block_decode vectors/$v.j2c vectors/$v.coeff cup_decode.metal 2>/dev/null | grep -q '\[GPU \] PASS' \
        && printf "  %-12s PASS\n" "$v" || { printf "  %-12s FAIL\n" "$v"; overall=1; }
    fi
  done
else echo "  (m1_block_decode not built — skipping)"; fi

echo
[ "$overall" -eq 0 ] && echo "OVERALL: PASS" || echo "OVERALL: FAIL"
exit $overall
