#!/usr/bin/env bash
# M2 oracle vectors: multi-decomposition, many codeblocks across all subbands,
# plus a 3-component (RCT) vector. For LOSSLESS 5/3 the decoded full frame equals
# the input, so the input .raw IS the full-frame oracle; ojph_expand round-trip
# (cmp) confirms the codestream is valid.
#
# Files per vector:
#   vectors/<name>.raw    original signed 16-bit LE samples (planar for 3-comp)
#   vectors/<name>.j2c    HTJ2K codestream (multi-decomp)
#   vectors/<name>.rt.raw ojph_expand round-trip  (== .raw for lossless)
set -euo pipefail
cd "$(dirname "$0")"
OUT=vectors; mkdir -p "$OUT"

gen () { # name W H comps decomps reversible colour
  local name="$1" W="$2" H="$3" comps="$4" dec="$5" rev="$6" col="${7:-false}"
  echo "=== $name ${W}x${H} comps=$comps dec=$dec rev=$rev col=$col ==="
  python3 - "$OUT/$name.raw" "$W" "$H" "$comps" <<'PY'
import sys,struct
path,W,H,C=sys.argv[1],int(sys.argv[2]),int(sys.argv[3]),int(sys.argv[4])
def val(x,y,c):
    v = ((x*17 + y*11 + c*3001) % 8000) - 3000          # smooth-ish
    v += (((x>>3) ^ (y>>3)) * 37) % 900                 # block texture
    if (x*7+y*5+c) % 23 == 0: v = 0                     # scattered zeros
    if (x % 64 < 2) and (y % 64 < 2): v += 12000        # cb-corner spikes
    if v < -32000: v = -32000
    if v >  32000: v =  32000
    return v
buf=bytearray()
for c in range(C):                                      # planar
    for y in range(H):
        for x in range(W):
            buf += struct.pack("<h", val(x,y,c))
open(path,"wb").write(buf)
print("  wrote %s (%d bytes)"%(path,len(buf)))
PY
  local sfl="" bl="" dl=""
  for ((i=0;i<comps;i++)); do sfl+="${sfl:+,}true"; bl+="${bl:+,}16"; dl+="${dl:+,}{1,1}"; done
  local colarg=(); [ "$col" = "true" ] && colarg=(-colour_trans true)
  ojph_compress -i "$OUT/$name.raw" -o "$OUT/$name.j2c" \
    -num_decomps "$dec" -reversible "$rev" ${colarg[@]+"${colarg[@]}"} \
    -dims "{$W,$H}" -num_comps "$comps" -signed "$sfl" -bit_depth "$bl" -downsamp "$dl" >/dev/null
  ojph_expand -i "$OUT/$name.j2c" -o "$OUT/$name.rt.raw" >/dev/null
  if cmp -s "$OUT/$name.raw" "$OUT/$name.rt.raw"; then
    echo "  round-trip: EXACT   j2c=$(wc -c < "$OUT/$name.j2c")"
  else
    echo "  round-trip: (not bit-exact — expected only for 9/7 lossy)"
  fi
}

gen_ppm () { # name W H decomps  (16-bit PPM RGB, unsigned, RCT)
  local name="$1" W="$2" H="$3" dec="$4"
  echo "=== $name ${W}x${H} PPM RGB dec=$dec RCT ==="
  python3 - "$OUT/$name.ppm" "$W" "$H" <<'PY'
import sys,struct
path,W,H=sys.argv[1],int(sys.argv[2]),int(sys.argv[3])
out=bytearray(("P6\n%d %d\n65535\n"%(W,H)).encode())
for y in range(H):
    for x in range(W):
        r=1000+((x*17+y*11)%60000)
        g=1+((x*7+y*13)%65000)
        b=2000+((x^y)%50000)
        if (x*3+y*5)%29==0: r=g=b=32768   # neutral zeros after DC shift
        for v in (r,g,b): out+=struct.pack(">H",v)
open(path,"wb").write(out)
print("  wrote %s (%d bytes)"%(path,len(out)))
PY
  ojph_compress -i "$OUT/$name.ppm" -o "$OUT/$name.j2c" \
    -num_decomps "$dec" -reversible true -colour_trans true >/dev/null
  ojph_expand -i "$OUT/$name.j2c" -o "$OUT/$name.rt.ppm" >/dev/null
  cmp -s "$OUT/$name.ppm" "$OUT/$name.rt.ppm" \
    && echo "  round-trip: EXACT   j2c=$(wc -c < "$OUT/$name.j2c")" \
    || echo "  round-trip: DIFF !!!"
}

# debug (small) reversible mono
gen m2_tiny   16  16  1 2 true
gen m2_small  64  64  1 3 true
# main reversible mono
gen m2_mono   512 512 1 5 true
# non-power-of-2 reversible mono
gen m2_np2    640 360 1 5 true
# 3-component reversible with RCT (PPM RGB, unsigned 16-bit)
gen_ppm m2_rct 512 512 5
# 9/7 irreversible (PSNR target)
gen m2_97     512 512 1 5 false

echo; echo "M2 vectors ready."
