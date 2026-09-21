#!/usr/bin/env bash
# M3 oracle vectors:
#  - 9/7 IRREVERSIBLE (lossy): mono (signed raw) + colour (PPM, ICT). Oracle is
#    the ojph_expand DECODE (not the input); compared by PSNR.
#  - reduced-resolution references via ojph_expand -skip_res N (built in validate).
#  - large 5/3 vectors (2K, UHD) for performance measurement.
set -euo pipefail
cd "$(dirname "$0")"
OUT=vectors; mkdir -p "$OUT"

# signed-raw mono generator (content), reversible flag param
gen_raw () { # name W H decomps reversible
  local name="$1" W="$2" H="$3" dec="$4" rev="$5"
  python3 - "$OUT/$name.raw" "$W" "$H" <<'PY'
import sys,struct
path,W,H=sys.argv[1],int(sys.argv[2]),int(sys.argv[3])
buf=bytearray()
for y in range(H):
    for x in range(W):
        v=((x*17+y*11)%8000)-3000
        v+=(((x>>3)^(y>>3))*37)%900
        if (x*7+y*5)%23==0: v=0
        if (x%64<2) and (y%64<2): v+=12000
        v=max(-32000,min(32000,v))
        buf+=struct.pack("<h",v)
open(path,"wb").write(buf)
PY
  ojph_compress -i "$OUT/$name.raw" -o "$OUT/$name.j2c" \
    -num_decomps "$dec" -reversible "$rev" \
    -dims "{$W,$H}" -num_comps 1 -signed true -bit_depth 16 -downsamp "{1,1}" >/dev/null
  ojph_expand -i "$OUT/$name.j2c" -o "$OUT/$name.rt.raw" >/dev/null
  echo "  $name ${W}x${H} dec=$dec rev=$rev j2c=$(wc -c < "$OUT/$name.j2c")"
}

gen_ppm () { # name W H decomps reversible  (16-bit PPM RGB, colour transform)
  local name="$1" W="$2" H="$3" dec="$4" rev="$5"
  python3 - "$OUT/$name.ppm" "$W" "$H" <<'PY'
import sys,struct
path,W,H=sys.argv[1],int(sys.argv[2]),int(sys.argv[3])
out=bytearray(("P6\n%d %d\n65535\n"%(W,H)).encode())
for y in range(H):
    for x in range(W):
        r=1000+((x*17+y*11)%60000); g=1+((x*7+y*13)%65000); b=2000+((x^y)%50000)
        if (x*3+y*5)%29==0: r=g=b=32768
        for v in (r,g,b): out+=struct.pack(">H",v)
open(path,"wb").write(out)
PY
  ojph_compress -i "$OUT/$name.ppm" -o "$OUT/$name.j2c" \
    -num_decomps "$dec" -reversible "$rev" -colour_trans true >/dev/null
  ojph_expand -i "$OUT/$name.j2c" -o "$OUT/$name.rt.ppm" >/dev/null
  echo "  $name ${W}x${H} dec=$dec rev=$rev PPM j2c=$(wc -c < "$OUT/$name.j2c")"
}

echo "== 9/7 irreversible =="
gen_raw m3_97_tiny  32  32  2 false
gen_raw m3_97_mono  512 512 5 false
gen_raw m3_97_2k    2048 1080 5 false   # large 9/7: guards isyn97 large-width (half-width 1024 > old [512])
gen_ppm m3_97_ict   512 512 5 false

echo "== large 5/3 for perf =="
gen_raw m3_2k   2048 1080 5 true
gen_raw m3_uhd  3840 2160 5 true

echo "M3 vectors ready."
