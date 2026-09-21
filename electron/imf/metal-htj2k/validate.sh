#!/usr/bin/env bash
# validate.sh — end-to-end M1 validation.
# For each M0 vector: parse -> CPU reference decode (OpenJPH scalar) -> Metal GPU
# decode -> compare BOTH bit-exact to the oracle coefficients. Prints PASS/FAIL
# per vector and per stage, plus an overall result.
set -uo pipefail
cd "$(dirname "$0")"

if [ ! -x ./m1_block_decode ]; then echo "build first: ./build.sh"; exit 2; fi
if [ ! -d vectors ] || [ -z "$(ls vectors/*.j2c 2>/dev/null)" ]; then
  echo "no vectors; run ./make_vectors.sh first"; exit 2; fi

export DYLD_LIBRARY_PATH=/opt/homebrew/lib
VECS=(cb64_grad cb32_grad cb64_rand cb32_rand cb64_sparse cb32_sparse)
overall=0
for v in "${VECS[@]}"; do
  echo "================ $v ================"
  out=$(./m1_block_decode "vectors/$v.j2c" "vectors/$v.coeff" cup_decode.metal 2>&1)
  echo "$out" | grep -E '^\[parse|^\[CPU|^\[GPU'
  echo "$out" | grep -q '\[CPU \] PASS' || { echo ">> CPU FAIL for $v"; overall=1; }
  echo "$out" | grep -q '\[GPU \] PASS' || { echo ">> GPU FAIL for $v"; overall=1; }
done

echo
if [ "$overall" -eq 0 ]; then
  echo "OVERALL: PASS — CPU reference AND Metal GPU decoder are bit-exact vs the OpenJPH oracle on all vectors."
else
  echo "OVERALL: FAIL — see per-vector output above."
fi
exit $overall
