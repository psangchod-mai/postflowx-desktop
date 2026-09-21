#!/usr/bin/env bash
# M0 — Oracle + test vectors for the Metal HTJ2K block decoder.
#
# For each vector we emit:
#   vectors/<name>.raw     : original SIGNED 16-bit LE samples (one component)
#   vectors/<name>.j2c     : HTJ2K codestream, ONE codeblock, NO DWT (-num_decomps 0)
#   vectors/<name>.rt.raw  : ojph_expand round-trip of <name>.j2c
#   vectors/<name>.coeff   : header {u32 W, u32 H} + W*H int32 LE expected coeffs
#
# Why SIGNED raw (not PGM): a JPEG2000 DC level-shift is applied to UNSIGNED
# samples (s -> s - 2^(B-1)). For B=16 an unsigned sample of 0 maps to the
# extreme coefficient -2^15, which OpenJPH does NOT round-trip losslessly
# (it decodes back as 0). With signed input there is NO level shift, so the
# codeblock COEFFICIENT == the input sample exactly, and a zero sample is a
# genuine zero (insignificant) coefficient — ideal for exercising the MEL
# significance-run path. We simply avoid the single unrepresentable value
# -2^(B-1) = -32768.
#
# With -num_decomps 0 + reversible 5/3 there is NO wavelet transform, so the
# decoded subband coefficients equal the input samples. That is the oracle:
# {codestream bytes} must decode to {coeff}, and coeff == original samples.
# OpenJPH always emits HTJ2K (High Throughput); lossless single-layer yields a
# single HT Cleanup (CUP) pass carrying the full magnitude.
set -euo pipefail
cd "$(dirname "$0")"
OUT=vectors
mkdir -p "$OUT"

gen_one () {
  local name="$1" W="$2" H="$3" mode="$4"
  echo "=== vector $name (${W}x${H}, mode=$mode) ==="
  python3 - "$OUT/$name" "$W" "$H" "$mode" <<'PY'
import sys, struct
base, W, H, mode = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
vals=[]
for y in range(H):
    for x in range(W):
        if mode=="grad":
            # signed gradient + spikes + zero regions (MEL runs).  Range kept
            # well inside +-32767 and never -32768.
            v = ((x*37 + y*53) % 4096) - 2048
            if (x % 11 == 0 and y % 7 == 0): v = 12000 + ((x*y) % 15000)
            if (x < 4 and y < 4): v = 0
            if ((x//8 + y//8) % 5 == 0): v = 0
        elif mode=="rand":
            s = (x*2654435761 + y*40503 + 12345) & 0xffffffff
            s ^= (s>>13); s = (s*1274126177) & 0xffffffff; s ^= (s>>16)
            v = (s % 65533) - 32766          # [-32766, 32766], never -32768
            if ((x^y) % 9 == 0): v = 0        # scattered zeros
        elif mode=="sparse":
            # mostly zeros (long MEL zero-runs) with occasional spikes
            v = 0
            if ((x*7 + y*13) % 29 == 0):
                s = (x*2654435761 + y*40503) & 0xffffffff; s ^= (s>>15)
                v = (s % 60000) - 30000
        else:
            v = 0
        if v < -32767: v = -32767
        if v >  32767: v =  32767
        vals.append(v)
open(base+".raw","wb").write(struct.pack("<%dh"%(W*H), *vals))
with open(base+".coeff","wb") as f:
    f.write(struct.pack("<II", W, H))
    f.write(struct.pack("<%di"%(W*H), *vals))
print("  wrote %s.raw / %s.coeff" % (base, base))
PY

  # Compress: ONE codeblock (block_size == image size), NO DWT, reversible.
  ojph_compress -i "$OUT/$name.raw" -o "$OUT/$name.j2c" \
    -num_decomps 0 -reversible true -block_size "{$H,$W}" \
    -dims "{$W,$H}" -num_comps 1 -signed true -bit_depth 16 -downsamp "{1,1}" >/dev/null

  # Round-trip decode (oracle).
  ojph_expand -i "$OUT/$name.j2c" -o "$OUT/$name.rt.raw" >/dev/null

  # Verify the round-trip is bit-exact vs the original signed samples.
  if cmp -s "$OUT/$name.raw" "$OUT/$name.rt.raw"; then
    echo "  round-trip: EXACT   j2c=$(wc -c < "$OUT/$name.j2c") bytes"
  else
    echo "  round-trip: MISMATCH !!!"; cmp "$OUT/$name.raw" "$OUT/$name.rt.raw" || true
  fi
}

gen_one cb64_grad 64 64 grad
gen_one cb32_grad 32 32 grad
gen_one cb64_rand 64 64 rand
gen_one cb32_rand 32 32 rand
gen_one cb64_sparse 64 64 sparse
gen_one cb32_sparse 32 32 sparse

echo
echo "M0 vectors ready in $OUT/"
