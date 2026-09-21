// idwt_color.metal — Milestone 2 inverse 5/3 DWT + inverse RCT as Metal compute
// passes. Bit-exact integer lifting (matches the verified CPU reference and
// OpenJPH gen_rev_horz_syn / rev_vert_step). even=true (origin 0).
//
// Per resolution level: kHorz (one thread per row: combine LL+HL and LH+HH into
// full-width low-vertical / high-vertical rows) then kVert (one thread per
// column: combine those into the level's LL). kColor does inverse RCT + DC shift.

#include <metal_stdlib>
using namespace metal;

// 1D reversible 5/3 synthesis (even=true). low[0..nl-1], high[0..nh-1] -> out[n].
// Reads/writes device memory with given strides; uses small thread scratch.
// In-place 5/3 synthesis with NO thread-local arrays (works for ANY size, and
// avoids per-thread register/stack pressure). Updated low is stored at the even
// output positions and read back for the predict step. Matches OpenJPH exactly:
//   step0 (update):  low[i]  -= (2 + high[i-1] + high[i]) >> 2   (high[-1]=high[0])
//   step1 (predict): high[i] += (low[i] + low[i+1]) >> 1         (low[nl]=low[nl-1])
//   interleave (even): out[2i]=low[i], out[2i+1]=high[i]
static void isyn53(device const int* low, uint lstride,
                   device const int* high, uint hstride,
                   uint nl, uint nh,
                   device int* out, uint ostride) {
  uint n = nl + nh;
  if (n == 1) { out[0] = low[0]; return; }
  for (uint i=0;i<nl;i++){
    int hL = high[(i==0?0:i-1)*hstride];
    int hR = high[(i<nh?i:nh-1)*hstride];
    out[(2*i)*ostride] = low[i*lstride] - ((2 + hL + hR) >> 2);
  }
  for (uint i=0;i<nh;i++){
    int lL = out[(2*i)*ostride];
    uint i2 = (i+1<nl)? i+1 : nl-1;
    int lR = out[(2*i2)*ostride];
    out[(2*i+1)*ostride] = high[i*hstride] + ((lL + lR) >> 1);
  }
}

struct LvlParams { uint rw, rh, lw, hw, lh, hh; };

// Horizontal pass. One thread per row y (0..max(lh,hh)-1).
kernel void kHorz(device const int* LL [[buffer(0)]],
                  device const int* HL [[buffer(1)]],
                  device const int* LH [[buffer(2)]],
                  device const int* HH [[buffer(3)]],
                  device int* Lrow      [[buffer(4)]],
                  device int* Hrow      [[buffer(5)]],
                  constant LvlParams& P [[buffer(6)]],
                  uint y [[thread_position_in_grid]]) {
  if (y < P.lh) // low-vertical row: combine LL(row,lw) + HL(row,hw) -> Lrow(row,rw)
    isyn53(LL + (uint)y*P.lw, 1, HL + (uint)y*P.hw, 1, P.lw, P.hw, Lrow + (uint)y*P.rw, 1);
  if (y < P.hh) // high-vertical row: combine LH + HH -> Hrow
    isyn53(LH + (uint)y*P.lw, 1, HH + (uint)y*P.hw, 1, P.lw, P.hw, Hrow + (uint)y*P.rw, 1);
}

// Vertical pass. One thread per column x (0..rw-1).
kernel void kVert(device const int* Lrow [[buffer(0)]],
                  device const int* Hrow [[buffer(1)]],
                  device int* out         [[buffer(2)]],
                  constant LvlParams& P   [[buffer(3)]],
                  uint x [[thread_position_in_grid]]) {
  if (x >= P.rw) return;
  isyn53(Lrow + x, P.rw, Hrow + x, P.rw, P.lh, P.hh, out + x, P.rw);
}

struct ColorParams { uint px; int rct; int shift0, shift1, shift2; };
// Inverse RCT (if rct) + DC level shift per component. comp0/1/2 in place.
kernel void kColor(device int* c0 [[buffer(0)]],
                   device int* c1 [[buffer(1)]],
                   device int* c2 [[buffer(2)]],
                   constant ColorParams& P [[buffer(3)]],
                   uint i [[thread_position_in_grid]]) {
  if (i >= P.px) return;
  if (P.rct) {
    int Y=c0[i], Cb=c1[i], Cr=c2[i];
    int G = Y - ((Cb + Cr) >> 2);
    c0[i] = Cr + G + P.shift0;
    c1[i] = G + P.shift1;
    c2[i] = Cb + G + P.shift2;
  } else {
    c0[i] += P.shift0;
  }
}

// ===================== 9/7 irreversible (float) =============================
// In-place 9/7 synthesis, NO thread-local arrays (works for any size). Even (E)
// samples live at out[2i], odd (O) at out[2i+1]. Matches OpenJPH gen_irv_horz_syn
// (K scale of low, K_inv of high, then 4 alternating lifting steps):
//   step0(delta): E[i] -= d*(O[i-1]+O[i])      step1(gamma): O[i] -= g*(E[i]+E[i+1])
//   step2(beta):  E[i] -= b*(O[i-1]+O[i])      step3(alpha): O[i] -= a*(E[i]+E[i+1])
// with symmetric extension O[-1]=O[0],O[nh]=O[nh-1] and E[nl]=E[nl-1].
static void isyn97(device const float* low, uint lstride,
                   device const float* high, uint hstride,
                   uint nl, uint nh, device float* out, uint ostride) {
  const float K=1.230174104914001f, Kinv=1.0f/K;
  const float d=0.443506852043971f, g=0.882911075530934f, b=-0.052980118572961f, a=-1.586134342059924f;
  uint n=nl+nh;
  if (n==1){ out[0]=low[0]; return; }
  for (uint i=0;i<nl;i++) out[(2*i)*ostride]     = low[i*lstride]*K;
  for (uint i=0;i<nh;i++) out[(2*i+1)*ostride]   = high[i*hstride]*Kinv;
  // step0 + step2 share the E-from-O pattern; step1 + step3 the O-from-E pattern.
  for (uint i=0;i<nl;i++){ float Ol=out[((i==0)?1:2*i-1)*ostride]; float Or=out[((i<nh)?2*i+1:2*nh-1)*ostride]; out[(2*i)*ostride]-=d*(Ol+Or); }
  for (uint i=0;i<nh;i++){ float El=out[(2*i)*ostride]; uint i2=(i+1<nl)?i+1:nl-1; float Er=out[(2*i2)*ostride]; out[(2*i+1)*ostride]-=g*(El+Er); }
  for (uint i=0;i<nl;i++){ float Ol=out[((i==0)?1:2*i-1)*ostride]; float Or=out[((i<nh)?2*i+1:2*nh-1)*ostride]; out[(2*i)*ostride]-=b*(Ol+Or); }
  for (uint i=0;i<nh;i++){ float El=out[(2*i)*ostride]; uint i2=(i+1<nl)?i+1:nl-1; float Er=out[(2*i2)*ostride]; out[(2*i+1)*ostride]-=a*(El+Er); }
}

kernel void kHorz97(device const float* LL [[buffer(0)]],
                    device const float* HL [[buffer(1)]],
                    device const float* LH [[buffer(2)]],
                    device const float* HH [[buffer(3)]],
                    device float* Lrow      [[buffer(4)]],
                    device float* Hrow      [[buffer(5)]],
                    constant LvlParams& P   [[buffer(6)]],
                    uint y [[thread_position_in_grid]]) {
  if (y < P.lh) isyn97(LL + (uint)y*P.lw, 1, HL + (uint)y*P.hw, 1, P.lw, P.hw, Lrow + (uint)y*P.rw, 1);
  if (y < P.hh) isyn97(LH + (uint)y*P.lw, 1, HH + (uint)y*P.hw, 1, P.lw, P.hw, Hrow + (uint)y*P.rw, 1);
}
kernel void kVert97(device const float* Lrow [[buffer(0)]],
                    device const float* Hrow [[buffer(1)]],
                    device float* out         [[buffer(2)]],
                    constant LvlParams& P     [[buffer(3)]],
                    uint x [[thread_position_in_grid]]) {
  if (x >= P.rw) return;
  isyn97(Lrow + x, P.rw, Hrow + x, P.rw, P.lh, P.hh, out + x, P.rw);
}
struct ICTP { uint px; };
kernel void kICT(device float* c0 [[buffer(0)]],
                 device float* c1 [[buffer(1)]],
                 device float* c2 [[buffer(2)]],
                 constant ICTP& P  [[buffer(3)]],
                 uint i [[thread_position_in_grid]]) {
  if (i >= P.px) return;
  float Y=c0[i], Cb=c1[i], Cr=c2[i];
  c0[i]=Y+1.402f*Cr; c1[i]=Y-0.344136f*Cb-0.714136f*Cr; c2[i]=Y+1.772f*Cb;
}
