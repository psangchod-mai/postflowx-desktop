#!/usr/bin/env bash
# M5 structure-matched vectors: mirror REAL Meridian IMF structure (CPRL, explicit
# precincts 128/256, 3 tile-parts, 5 decomps, 32x32 cb, 12-bit 3-comp colour) but
# as HTJ2K so they decode end-to-end through the new parser paths. Both a small
# 512x512 debug size and a Meridian-size 1920x1080 (exercises 40 precincts @ res5).
set -euo pipefail
cd "$(dirname "$0")"
OUT=vectors; mkdir -p "$OUT"
OJ=/opt/homebrew/bin

gen () { # name W H reversible
  local name="$1" W="$2" H="$3" rev="$4"
  python3 - "$OUT/$name.ppm" "$W" "$H" <<'PY'
import sys,struct
path,W,H=sys.argv[1],int(sys.argv[2]),int(sys.argv[3])
out=bytearray(("P6\n%d %d\n4095\n"%(W,H)).encode())  # maxval 4095 -> 12-bit
for y in range(H):
    for x in range(W):
        r=100+((x*7+y*11)%3800); g=50+((x*13+y*3)%3900); b=200+((x^y)%3500)
        if (x*3+y*5)%29==0: r=g=b=2048
        for v in (r,g,b): out+=struct.pack(">H",v)
open(path,"wb").write(out)
PY
  # CPRL, explicit precincts 128 then 256x5, 32x32 codeblocks, 3 tile-parts (per component)
  $OJ/ojph_compress -i "$OUT/$name.ppm" -o "$OUT/$name.j2c" \
    -num_decomps 5 -reversible "$rev" -colour_trans true \
    -prog_order CPRL -block_size "{32,32}" \
    -precincts "{128,128},{256,256},{256,256},{256,256},{256,256},{256,256}" -tileparts C >/dev/null
  $OJ/ojph_expand -i "$OUT/$name.j2c" -o "$OUT/$name.rt.ppm" >/dev/null
  echo "  $name ${W}x${H} rev=$rev j2c=$(wc -c < "$OUT/$name.j2c")"
}

gen_prog () { # name W H reversible progorder  — same structure as gen() but explicit progression
  local name="$1" W="$2" H="$3" rev="$4" prog="$5"
  python3 - "$OUT/$name.ppm" "$W" "$H" <<'PY'
import sys,struct
path,W,H=sys.argv[1],int(sys.argv[2]),int(sys.argv[3])
out=bytearray(("P6\n%d %d\n4095\n"%(W,H)).encode())
for y in range(H):
    for x in range(W):
        r=100+((x*7+y*11)%3800); g=50+((x*13+y*3)%3900); b=200+((x^y)%3500)
        if (x*3+y*5)%29==0: r=g=b=2048
        for v in (r,g,b): out+=struct.pack(">H",v)
open(path,"wb").write(out)
PY
  $OJ/ojph_compress -i "$OUT/$name.ppm" -o "$OUT/$name.j2c" \
    -num_decomps 5 -reversible "$rev" -colour_trans true \
    -prog_order "$prog" -block_size "{32,32}" \
    -precincts "{128,128},{256,256},{256,256},{256,256},{256,256},{256,256}" -tileparts C >/dev/null
  $OJ/ojph_expand -i "$OUT/$name.j2c" -o "$OUT/$name.rt.ppm" >/dev/null
  echo "  $name ${W}x${H} rev=$rev prog=$prog j2c=$(wc -c < "$OUT/$name.j2c")"
}

gen m5_rct     512  512  true    # 5/3 RCT  (lossless: oracle = input .ppm)
gen m5_ict     512  512  false   # 9/7 ICT  (lossy:    oracle = .rt.ppm, PSNR)
gen m5_hd_rct  1920 1080 true     # Meridian-size 5/3 RCT
gen m5_hd_ict  1920 1080 false    # Meridian-size 9/7 ICT
# Non-CPRL progression orders (5/3 RCT, bit-exact) — guard the untested-order coverage hole
gen_prog m5_rpcl 512 512 true RPCL
gen_prog m5_pcrl 512 512 true PCRL
gen_prog m5_lrcp 512 512 true LRCP
gen_prog m5_rlcp 512 512 true RLCP
echo "M5 vectors ready."
