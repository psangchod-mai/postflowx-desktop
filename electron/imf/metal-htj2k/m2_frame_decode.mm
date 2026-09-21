// m2_frame_decode.mm — Milestone 2: decode a WHOLE HTJ2K frame, bit-exact.
// -----------------------------------------------------------------------------
// parse (multi-res / multi-subband / multi-codeblock, real tag-tree packet
//        headers, RPCL order)
//   -> per-codeblock HT decode  (CPU: OpenJPH scalar ref; GPU: parallel Metal)
//   -> inverse quant (reversible = sign-mag -> signed, shift 31-Kmax)
//   -> inverse 5/3 DWT (bit-exact integer lifting), coarse->fine
//   -> inverse RCT + DC level shift (3-component / unsigned)
//   -> full frame, compared bit-exact to the ojph_expand oracle (== input for
//      lossless).
// Same toolchain as M1 (runtime-compiled MSL; clang++ ObjC++; arm64).
// -----------------------------------------------------------------------------
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <mach-o/dyld.h>
#include <unistd.h>
#include <cerrno>
#include <sys/mman.h>
#include <fcntl.h>
#include <dirent.h>
#include <signal.h>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <cmath>
#include <ctime>
#include <climits>
#include <vector>
#include <string>
#include <array>
#include <algorithm>

namespace ojph { namespace local {
  bool ojph_decode_codeblock32(uint8_t* coded_data, uint32_t* decoded_data,
      uint32_t missing_msbs, uint32_t num_passes,
      uint32_t lengths1, uint32_t lengths2,
      uint32_t width, uint32_t height, uint32_t stride, bool stripe_causal);
  extern uint16_t vlc_tbl0[1024];
  extern uint16_t vlc_tbl1[1024];
  extern uint16_t uvlc_tbl0[256+64];
  extern uint16_t uvlc_tbl1[256];
}}
#define GPU_PREFIX 16

typedef uint8_t u8; typedef uint16_t u16; typedef uint32_t u32; typedef int32_t i32; typedef int16_t i16; typedef uint64_t u64;

static u32 rd16(const u8* p){ return (u32(p[0])<<8)|p[1]; }
static u32 rd32(const u8* p){ return (u32(p[0])<<24)|(u32(p[1])<<16)|(u32(p[2])<<8)|p[3]; }
static u32 ceildiv_pow2(u32 x, u32 s){ return (x + (1u<<s) - 1u) >> s; }

// ================================ bit reader ================================
struct BitRd {
  const u8* d; size_t n; size_t pos; u32 tmp; int avail; bool unstuff;
  void init(const u8* d_, size_t n_){ d=d_; n=n_; pos=0; tmp=0; avail=0; unstuff=false; }
  bool fill(){ if(pos<n){ u32 t=d[pos++]; tmp=t; avail=8-(unstuff?1:0); unstuff=(t==0xFF); return true;} tmp=0; avail=8-(unstuff?1:0); unstuff=false; return false; }
  u32 bit(){ if(avail==0) fill(); return (tmp >> (--avail)) & 1u; }
  u32 bits(int nb){ u32 r=0; while(nb){ if(avail==0) fill(); int t=avail<nb?avail:nb; r=(r<<t); avail-=t; nb-=t; r |= (tmp>>avail)&((1u<<t)-1);} return r; }
  void terminate(){ if(unstuff) fill(); tmp=0; avail=0; }
  void seekByte(size_t p){ pos=p; tmp=0; avail=0; unstuff=false; }
};

// ================================ tag tree ==================================
struct TagTree {
  u32 W,H,levels; std::vector<std::vector<u8>> val, flag;
  static u32 log2ceil(u32 x){ if(x<=1) return 0; u32 t=31-__builtin_clz(x); return t + ((x&(x-1))?1:0); }
  u32 widthAt(u32 l){ return (W + (1u<<l) - 1) >> l; }
  void init(u32 nbw, u32 nbh){
    W=nbw; H=nbh; levels = 1 + std::max(log2ceil(nbw), log2ceil(nbh));
    val.assign(levels+1, {}); flag.assign(levels+1, {});
    for (u32 l=0;l<=levels;l++){ u32 w=(W+(1u<<l)-1)>>l, h=(H+(1u<<l)-1)>>l; val[l].assign((size_t)w*h,0); flag[l].assign((size_t)w*h,0);} }
  u8& v(u32 x,u32 y,u32 l){ return val[l][(size_t)y*widthAt(l)+x]; }
  u8& f(u32 x,u32 y,u32 l){ return flag[l][(size_t)y*widthAt(l)+x]; }
};

// ============================ structures ====================================
struct CB { u32 comp,res,band,x0,y0,w,h,Kmax,missingMsbs,numPasses,len0,len1; float delta; size_t codedOff; };
struct SubbandBuf { u32 w=0,h=0; std::vector<i32> coeff; std::vector<float> coeffF; };
struct Frame {
  u32 W=0,H=0,numComps=0,numDecomps=0; bool colourTrans=false; bool reversible=true; u32 qstyle=0;
  std::vector<u8> isSigned, bitDepth;
  u32 cbW=64,cbH=64, guardBits=0; std::vector<u8> spqcd;
  u32 progOrder=2;                 // 0=LRCP 1=RLCP 2=RPCL 3=PCRL 4=CPRL
  bool explicitPrec=false;
  std::vector<u8> ppwExp, pphExp;  // per-resolution precinct exponents (log2)
  u32 numTileParts=0;
  std::vector<u8> stream;          // concatenated packet body across all tile-parts
  size_t dataStart=0, dataEnd=0;
  u32 skipRes=0;   // reduced-resolution: skip this many finest levels
  std::vector<std::vector<std::array<SubbandBuf,4>>> sb;
  std::vector<CB> cbs;
};

// precinct exponents for resolution r
static u32 ppw(const Frame& f,u32 r){ return f.explicitPrec ? f.ppwExp[r<f.ppwExp.size()?r:f.ppwExp.size()-1] : 15; }
static u32 pph(const Frame& f,u32 r){ return f.explicitPrec ? f.pphExp[r<f.pphExp.size()?r:f.pphExp.size()-1] : 15; }

// ============================ geometry ======================================
static u32 resW(const Frame& f,u32 r){ return ceildiv_pow2(f.W, f.numDecomps-r); }
static u32 resH(const Frame& f,u32 r){ return ceildiv_pow2(f.H, f.numDecomps-r); }
static void bandDims(const Frame& f,u32 r,u32 band,u32& bw,u32& bh){
  if (r==0){ bw=resW(f,0); bh=resH(f,0); return; }
  u32 lw=resW(f,r-1),hw=resW(f,r)-lw,lh=resH(f,r-1),hh=resH(f,r)-lh;
  switch(band){ case 1: bw=hw;bh=lh;break; case 2: bw=lw;bh=hh;break; case 3: bw=hw;bh=hh;break; default: bw=bh=0; }
}
static u32 subIdx(u32 r,u32 band){ return (r==0)?0:((r-1)*3+band); }
static u32 kmaxFor(const Frame& f,u32 r,u32 band){
  u32 idx=subIdx(r,band);
  if (f.reversible){ u32 exp=(idx<f.spqcd.size())?(f.spqcd[idx]>>3):0; u32 numBits=exp==0?0:exp-1; return numBits+f.guardBits; }
  // irreversible expounded: SPqcd is u16 big-endian per subband
  u32 e = (idx*2+1<f.spqcd.size()) ? ((u32(f.spqcd[idx*2])<<8)|f.spqcd[idx*2+1]) : 0;
  u32 eps = e>>11; return (eps==0?0:eps-1)+f.guardBits;
}
// irreversible dequant delta = step / 2^(31-Kmax)  (matches OpenJPH subband.cpp)
static float deltaFor(const Frame& f,u32 r,u32 band){
  u32 idx=subIdx(r,band);
  u32 e = (idx*2+1<f.spqcd.size()) ? ((u32(f.spqcd[idx*2])<<8)|f.spqcd[idx*2+1]) : 0;
  u32 eps=e>>11, man=e&0x7FF; float arr[4]={1.f,2.f,2.f,4.f};
  float step = (float)((man|0x800)) * arr[band] / (float)(1u<<11) / (float)(1u<<eps);
  u32 Kmax = kmaxFor(f,r,band);
  return step / (float)(1u<<(31-Kmax));
}

// element offset of subband (r,band) inside a component's concatenated coeff
// buffer; order: (0,0), then (r,1),(r,2),(r,3) for r=1..D.
static size_t sbElemOffset(const Frame& f, u32 r, u32 band){
  size_t off=0; u32 bw,bh;
  if (r==0 && band==0) return 0;
  bandDims(f,0,0,bw,bh); off+=(size_t)bw*bh;
  for (u32 rr=1;rr<=f.numDecomps;++rr) for (u32 bb=1;bb<=3;++bb){
    if (rr==r && bb==band) return off;
    bandDims(f,rr,bb,bw,bh); off+=(size_t)bw*bh;
  }
  return off;
}
static size_t sbCompElems(const Frame& f){
  size_t off=0; u32 bw,bh; bandDims(f,0,0,bw,bh); off+=(size_t)bw*bh;
  for (u32 rr=1;rr<=f.numDecomps;++rr) for (u32 bb=1;bb<=3;++bb){ bandDims(f,rr,bb,bw,bh); off+=(size_t)bw*bh; }
  return off;
}

// ---- precinct / codeblock-index geometry (mirrors OpenJPH subband::get_cb_indices) ----
static u32 numPrecX(const Frame& f,u32 r){ u32 rw=resW(f,r); if(rw==0)return 0; u32 P=ppw(f,r); return (rw + (1u<<P) - 1) >> P; }
static u32 numPrecY(const Frame& f,u32 r){ u32 rh=resH(f,r); if(rh==0)return 0; u32 P=pph(f,r); return (rh + (1u<<P) - 1) >> P; }

struct CbGrid { std::vector<u32> colOrg,colSiz,rowOrg,rowSiz; u32 xcb=5,ycb=5; };
static CbGrid cbGrid(const Frame& f,u32 r,u32 band){
  CbGrid g;
  u32 rw=resW(f,r), rh=resH(f,r);
  u32 PPw=ppw(f,r), PPh=pph(f,r);
  u32 xsh=(r>0)?1:0, ysh=(r>0)?1:0;
  u32 cbExpW=(u32)__builtin_ctz(f.cbW), cbExpH=(u32)__builtin_ctz(f.cbH);
  g.xcb=std::min(cbExpW, PPw-xsh); g.ycb=std::min(cbExpH, PPh-ysh);
  u32 npx=numPrecX(f,r), npy=numPrecY(f,r);
  u32 acc=0; g.colOrg.resize(npx); g.colSiz.resize(npx);
  for (u32 px=0;px<npx;px++){
    u32 pcx0=std::max<u32>(0, px<<PPw), pcx1=std::min(rw, (px+1)<<PPw);
    pcx0=(pcx0-(band&1)+(1u<<xsh)-1)>>xsh; pcx1=(pcx1-(band&1)+(1u<<xsh)-1)>>xsh;
    u32 xb=((pcx1+(1u<<g.xcb)-1)>>g.xcb) - (pcx0>>g.xcb);
    g.colOrg[px]=acc; g.colSiz[px]=xb; acc+=xb;
  }
  acc=0; g.rowOrg.resize(npy); g.rowSiz.resize(npy);
  for (u32 py=0;py<npy;py++){
    u32 pcy0=std::max<u32>(0, py<<PPh), pcy1=std::min(rh, (py+1)<<PPh);
    pcy0=(pcy0-(band>>1)+(1u<<ysh)-1)>>ysh; pcy1=(pcy1-(band>>1)+(1u<<ysh)-1)>>ysh;
    u32 yb=((pcy1+(1u<<g.ycb)-1)>>g.ycb) - (pcy0>>g.ycb);
    g.rowOrg[py]=acc; g.rowSiz[py]=yb; acc+=yb;
  }
  return g;
}

// Parse ONE packet = one precinct (px,py) of resolution r, component c, from the
// (concatenated) packet stream. Appends codeblock descriptors and advances br.
static void parsePacketPrec(Frame& f, BitRd& br, u32 c, u32 r, u32 px, u32 py){
  u32 present[4]; int nb=0;
  if (r==0) present[nb++]=0; else { present[nb++]=1; present[nb++]=2; present[nb++]=3; }
  size_t cbStart=f.cbs.size();
  bool empty_packet=true, ended=false;
  for (int si=0; si<nb && !ended; ++si){
    u32 band=present[si]; SubbandBuf& sb=f.sb[c][r][band]; if (sb.w==0||sb.h==0) continue;
    CbGrid g=cbGrid(f,r,band);
    u32 orgx=g.colOrg[px], sizw=g.colSiz[px], orgy=g.rowOrg[py], sizh=g.rowSiz[py];
    if (sizw==0||sizh==0) continue;
    u32 cbW=1u<<g.xcb, cbH=1u<<g.ycb;
    if (empty_packet){ if (br.bit()==0){ ended=true; break; } empty_packet=false; }
    TagTree inc,mmsb; inc.init(sizw,sizh); mmsb.init(sizw,sizh);
    for (u32 y=0;y<sizh;y++) for (u32 x=0;x<sizw;x++){
      bool empty_cb=false;
      for (u32 cl=inc.levels; cl>0; --cl){ u32 cur=cl-1;
        empty_cb=inc.v(x>>cur,y>>cur,cur)==1; if(empty_cb)break;
        if (inc.f(x>>cur,y>>cur,cur)==0){ u32 b=br.bit(); empty_cb=(b==0); inc.v(x>>cur,y>>cur,cur)=(u8)(1-b); inc.f(x>>cur,y>>cur,cur)=1; }
        if (empty_cb) break; }
      if (empty_cb) continue;
      u32 mm=0;
      for (u32 levp1=mmsb.levels; levp1>0; --levp1){ u32 cur=levp1-1;
        mm=mmsb.v(x>>levp1,y>>levp1,levp1);
        if (mmsb.f(x>>cur,y>>cur,cur)==0){ u32 b=0; while(b==0){ b=br.bit(); mm+=1-b; } mmsb.v(x>>cur,y>>cur,cur)=(u8)mm; mmsb.f(x>>cur,y>>cur,cur)=1; } }
      u32 numPasses=1,b=br.bit();
      if (b){ numPasses=2; b=br.bit(); if(b){ b=br.bits(2); numPasses=3+b; if(b==3){ b=br.bits(5); numPasses=6+b; if(b==31){ b=br.bits(7); numPasses=37+b; } } } }
      u32 numPhld=(numPasses-1)/3; mm+=numPhld; u32 passes=numPasses-numPhld*3;
      int Lblock=3; while(br.bit()) Lblock++;
      int lbits=Lblock+31-__builtin_clz(numPhld+1);
      u32 len0=br.bits(lbits), len1=0;
      if (passes>1){ int lb2=Lblock+(passes>2?1:0); len1=br.bits(lb2); }
      u32 gx=orgx+x, gy=orgy+y;
      CB cb; cb.comp=c; cb.res=r; cb.band=band;
      cb.x0=gx*cbW; cb.y0=gy*cbH; cb.w=std::min(cbW,sb.w-gx*cbW); cb.h=std::min(cbH,sb.h-gy*cbH);
      cb.Kmax=kmaxFor(f,r,band); cb.delta=f.reversible?0.f:deltaFor(f,r,band);
      cb.missingMsbs=mm; cb.numPasses=passes; cb.len0=len0; cb.len1=len1; cb.codedOff=0;
      f.cbs.push_back(cb);
    }
  }
  if (empty_packet) br.bit();   // all-empty packet still consumes one bit
  br.terminate();
  size_t cur=br.pos;
  for (size_t k=cbStart;k<f.cbs.size();++k){ f.cbs[k].codedOff=cur; cur+=f.cbs[k].len0+f.cbs[k].len1; }
  br.seekByte(cur);
}

// ============================ parser ========================================
static bool parseFrame(const std::vector<u8>& file, Frame& f, std::string& err, bool structOnly=false){
  const u8* d=file.data(); size_t N=file.size();
  if (N<4||rd16(d)!=0xFF4F){ err="no SOC"; return false; }
  // ---- main header: parse markers until first SOT ----
  size_t i=2; size_t firstSot=0;
  while (i+2<=N){
    u32 m=rd16(d+i);
    if (m==0xFF90){ firstSot=i; break; }
    if (m==0xFFD9){ break; }
    if (m<0xFF00){ err="bad marker"; return false; }
    u32 L=rd16(d+i+2); const u8* seg=d+i+4;
    switch(m){
      case 0xFF51: { f.W=rd32(seg+2)-rd32(seg+10); f.H=rd32(seg+6)-rd32(seg+14);
        f.numComps=rd16(seg+34); f.isSigned.resize(f.numComps); f.bitDepth.resize(f.numComps);
        for (u32 c=0;c<f.numComps;c++){ u8 ss=seg[36+c*3]; f.isSigned[c]=(ss&0x80)!=0; f.bitDepth[c]=(ss&0x7F)+1; } break; }
      case 0xFF52: { // COD: Scod[0] SGcod{prog[1],layers[2..3],MCT[4]} SPcod{ndec[5],cbw[6],cbh[7],cbsty[8],tx[9],[prec@10..]}
        u8 Scod=seg[0]; f.progOrder=seg[1]; f.numDecomps=seg[5];
        f.cbW=1u<<((seg[6]&0x0F)+2); f.cbH=1u<<((seg[7]&0x0F)+2);
        f.colourTrans=(seg[4]&0x01)!=0; f.reversible=(seg[9]==1);
        f.explicitPrec=(Scod&0x01)!=0;
        if (f.explicitPrec){ const u8* pb=seg+10; u32 np=f.numDecomps+1;
          // precinct list is ordered coarsest->finest (res 0 .. numDecomps)
          f.ppwExp.resize(np); f.pphExp.resize(np);
          for (u32 r=0;r<np;r++){ u8 pv=pb[r]; f.ppwExp[r]=pv&0x0F; f.pphExp[r]=(pv>>4)&0x0F; } }
        break; }
      case 0xFF5C: { u8 sqcd=seg[0]; f.guardBits=sqcd>>5; f.qstyle=sqcd&0x1F; f.spqcd.assign(seg+1, seg+L-2); break; }
      default: break;
    }
    i+=2+L;
  }
  if (!firstSot){ err="no SOT"; return false; }

  // ---- enumerate ALL tile-parts; concatenate their post-SOD packet bodies ----
  f.dataStart=firstSot; size_t tp=firstSot; f.numTileParts=0;
  while (tp+2<=N && rd16(d+tp)==0xFF90){
    u32 Lsot=rd16(d+tp+2); u32 Psot=rd32(d+tp+6); // Isot@+4, Psot@+6, TPsot@+10, TNsot@+11
    size_t sotEnd = Psot ? std::min<size_t>(tp+Psot, N) : N;
    // find SOD within this tile-part header
    size_t j=tp+2+Lsot; size_t sod=0;
    while (j+2<=sotEnd){ u32 mm=rd16(d+j); if (mm==0xFF93){ sod=j; break; } if(mm<0xFF00){break;} u32 LL=rd16(d+j+2); j+=2+LL; }
    if (!sod){ err="no SOD in tile-part"; return false; }
    size_t bodyStart=sod+2, bodyEnd=sotEnd;
    if (bodyEnd>=2 && rd16(d+bodyEnd-2)==0xFFD9) bodyEnd-=2;   // strip EOC (last part)
    f.stream.insert(f.stream.end(), d+bodyStart, d+bodyEnd);
    f.numTileParts++;
    if (!Psot) break;                    // Psot==0 => extends to EOC (single part)
    tp += Psot;
  }

  f.sb.assign(f.numComps, {});
  for (u32 c=0;c<f.numComps;c++){ f.sb[c].assign(f.numDecomps+1, {});
    for (u32 r=0;r<=f.numDecomps;r++) for (u32 b=0;b<4;b++)
      if ((r==0&&b==0)||(r>0&&b>=1&&b<=3)){ u32 bw,bh; bandDims(f,r,b,bw,bh);
        f.sb[c][r][b].w=bw; f.sb[c][r][b].h=bh;
        if (f.reversible) f.sb[c][r][b].coeff.assign((size_t)bw*bh,0);
        else f.sb[c][r][b].coeffF.assign((size_t)bw*bh,0.f);} }

  // Meridian is Part-1 MQ/EBCOT — we CANNOT parse its packet bodies as HTJ2K.
  // structOnly stops after marker+tile-part+precinct structure is recovered.
  if (structOnly) return true;

  // ---- packet iteration in progression order over the concatenated stream ----
  BitRd br; br.init(f.stream.data(), f.stream.size());
  u32 D=f.numDecomps, C=f.numComps;
  std::vector<std::vector<u32>> cur(C, std::vector<u32>(D+1,0));   // per (c,r) precinct cursor
  auto nprec=[&](u32 r){ return numPrecX(f,r)*numPrecY(f,r); };
  auto imgPt=[&](u32 r,u32 pidx,u64& iy,u64& ix){ u32 npx=numPrecX(f,r); u32 px=pidx%npx, py=pidx/npx;
      u64 ds=1ull<<(D-r); ix=ds*((u64)px<<ppw(f,r)); iy=ds*((u64)py<<pph(f,r)); };
  auto parseNext=[&](u32 c,u32 r){ u32 pidx=cur[c][r]; u32 npx=numPrecX(f,r); parsePacketPrec(f,br,c,r,pidx%npx,pidx/npx); cur[c][r]++; };

  if (f.progOrder==0 || f.progOrder==1){          // LRCP / RLCP (1 layer): R,C, all precincts
    for (u32 r=0;r<=D;++r) for (u32 c=0;c<C;++c) while (cur[c][r]<nprec(r)) parseNext(c,r);
  } else if (f.progOrder==2){                      // RPCL: for r, merge comps by precinct position
    for (u32 r=0;r<=D;++r) while (true){
      bool found=false; u32 bc=0; u64 by=~0ull,bx=~0ull;
      for (u32 c=0;c<C;++c){ if (cur[c][r]>=nprec(r)) continue; u64 iy,ix; imgPt(r,cur[c][r],iy,ix);
        if (!found || iy<by || (iy==by && ix<bx)){ found=true; by=iy; bx=ix; bc=c; } }
      if (!found) break; parseNext(bc,r);
    }
  } else if (f.progOrder==4){                       // CPRL: for c, merge resolutions by position
    for (u32 c=0;c<C;++c) while (true){
      bool found=false; u32 br_=0; u64 by=~0ull,bx=~0ull;
      for (u32 r=0;r<=D;++r){ if (cur[c][r]>=nprec(r)) continue; u64 iy,ix; imgPt(r,cur[c][r],iy,ix);
        if (!found || iy<by || (iy==by && ix<bx)){ found=true; by=iy; bx=ix; br_=r; } }
      if (!found) break; parseNext(c,br_);
    }
  } else if (f.progOrder==3){                        // PCRL: merge all (c,r) by position
    while (true){ bool found=false; u32 bc=0,br_=0; u64 by=~0ull,bx=~0ull;
      for (u32 c=0;c<C;++c) for (u32 r=0;r<=D;++r){ if (cur[c][r]>=nprec(r)) continue; u64 iy,ix; imgPt(r,cur[c][r],iy,ix);
        if (!found || iy<by || (iy==by && ix<bx)){ found=true; by=iy; bx=ix; bc=c; br_=r; } }
      if (!found) break; parseNext(bc,br_);
    }
  } else { err="unsupported progression order"; return false; }
  return true;
}

static void dequantRev(const u32* sp, i32* dp, u32 Kmax, u32 count){
  u32 shift = 31 - Kmax;
  for (u32 i=0;i<count;i++){ u32 v=sp[i]; i32 val=(i32)((v&0x7FFFFFFFu)>>shift); dp[i]=(v&0x80000000u)?-val:val; }
}

// ============================ block decode (CPU ref) ========================
static void decodeAllCPU(const std::vector<u8>& file, Frame& f){
  (void)file; const u8* base = f.stream.data();   // concatenated tile-part bodies
  u32 top=f.numDecomps - f.skipRes;
  for (const CB& cb : f.cbs){
    if (cb.len0==0 || cb.res>top) continue;   // reduced-res: skip finest levels
    std::vector<u8> coded(base+cb.codedOff, base+cb.codedOff+cb.len0+cb.len1);
    coded.resize(coded.size()+8,0);
    // HT decoder writes dp[stride] for the bottom row of every quad -> for odd
    // heights it writes one row past cb.h. Over-allocate to even height.
    u32 evenH = (cb.h + 1u) & ~1u;
    std::vector<u32> dec((size_t)cb.w*evenH,0);
    bool ok=ojph::local::ojph_decode_codeblock32(coded.data(), dec.data(),
      cb.missingMsbs, cb.numPasses, cb.len0, cb.len1, cb.w, cb.h, cb.w, false);
    if (!ok) continue;
    SubbandBuf& sbuf=f.sb[cb.comp][cb.res][cb.band];
    if (f.reversible){
      std::vector<i32> sm((size_t)cb.w*cb.h,0);
      dequantRev(dec.data(), sm.data(), cb.Kmax, cb.w*cb.h);
      for (u32 yy=0; yy<cb.h; ++yy) for (u32 xx=0; xx<cb.w; ++xx)
        sbuf.coeff[(size_t)(cb.y0+yy)*sbuf.w + (cb.x0+xx)] = sm[(size_t)yy*cb.w+xx];
    } else {
      for (u32 yy=0; yy<cb.h; ++yy) for (u32 xx=0; xx<cb.w; ++xx){
        u32 v=dec[(size_t)yy*cb.w+xx]; float mag=(float)(v&0x7FFFFFFFu)*cb.delta;
        sbuf.coeffF[(size_t)(cb.y0+yy)*sbuf.w+(cb.x0+xx)] = (v&0x80000000u)?-mag:mag;
      }
    }
  }
}

// ============================ block decode (GPU parallel) ===================
struct GDesc { u32 base, len0, missingMsbs, numPasses, W, H, outBase, stride; };
// Resolve an MSL file. Packaged apps have an unknown cwd, so we search, in order:
//   $PFX_MSL_DIR/<name>, <executable-dir>/<name>, then bare <name> (cwd, harness).
static NSString* mslPath(const char* name){
  const char* env=getenv("PFX_MSL_DIR");
  if (env && *env){ NSString* p=[NSString stringWithFormat:@"%s/%s",env,name];
    if ([[NSFileManager defaultManager] fileExistsAtPath:p]) return p; }
  char buf[4096]; uint32_t sz=sizeof(buf);
  if (_NSGetExecutablePath(buf, &sz)==0){
    NSString* exe=[NSString stringWithUTF8String:buf];
    NSString* dir=[exe stringByDeletingLastPathComponent];
    NSString* p=[dir stringByAppendingPathComponent:[NSString stringWithUTF8String:name]];
    if ([[NSFileManager defaultManager] fileExistsAtPath:p]) return p;
  }
  return [NSString stringWithUTF8String:name];  // fallback: cwd (harness dir)
}
static NSString* loadFile(const char* p){ NSError* e=nil; NSString* s=[NSString stringWithContentsOfFile:mslPath(p) encoding:NSUTF8StringEncoding error:&e]; return s; }

// Decodes ALL codeblocks in parallel on the GPU (one threadgroup per codeblock,
// many threadgroups dispatched). Fills f.sb exactly like decodeAllCPU. Returns
// false (with msg) if Metal is unavailable so the caller can report honestly.
// Cached Metal objects (compile MSL once — repeated calls reflect compute cost).
static id<MTLDevice> gDev=nil; static id<MTLCommandQueue> gQ=nil;
static id<MTLComputePipelineState> gPsoMT=nil, gPsoScatter=nil;
static id<MTLBuffer> gV0=nil,gV1=nil,gU0=nil,gU1=nil;
// GPU-resident subband coefficients (filled by kScatter, read by the IDWT).
static id<MTLBuffer> gSubbandBuf=nil; static size_t gCompElems=0; static bool gResident=false;
struct SDesc { u32 outBase, sbOffset, substride, x0, y0, w, h, kmax; float delta; u32 reversible; };
double g_t_decode_ms=0, g_t_idwt_ms=0, g_t_scatter_ms=0;   // last GPU submit→complete timings
static double nowms(){ struct timespec ts; clock_gettime(CLOCK_MONOTONIC,&ts); return ts.tv_sec*1000.0+ts.tv_nsec/1e6; }

static bool decodeAllGPU(const std::vector<u8>& file, Frame& f, std::string& err, bool resident=false){
 @autoreleasepool {
  if (!gDev){ gDev=MTLCreateSystemDefaultDevice(); if(!gDev){ err="no Metal device"; return false; } gQ=[gDev newCommandQueue];
    NSString* src=loadFile("cup_decode_mt.metal"); if(!src){ err="cannot read cup_decode_mt.metal"; return false; }
    NSError* e=nil; id<MTLLibrary> lib=[gDev newLibraryWithSource:src options:[MTLCompileOptions new] error:&e];
    if(!lib){ err=std::string("MSL compile: ")+e.localizedDescription.UTF8String; return false; }
    gPsoMT=[gDev newComputePipelineStateWithFunction:[lib newFunctionWithName:@"kCUP_mt"] error:&e];
    gPsoScatter=[gDev newComputePipelineStateWithFunction:[lib newFunctionWithName:@"kScatter"] error:&e];
    if(!gPsoMT||!gPsoScatter){ err="pipeline"; return false; }
    gV0=[gDev newBufferWithBytes:ojph::local::vlc_tbl0 length:sizeof(ojph::local::vlc_tbl0) options:MTLResourceStorageModeShared];
    gV1=[gDev newBufferWithBytes:ojph::local::vlc_tbl1 length:sizeof(ojph::local::vlc_tbl1) options:MTLResourceStorageModeShared];
    gU0=[gDev newBufferWithBytes:ojph::local::uvlc_tbl0 length:sizeof(ojph::local::uvlc_tbl0) options:MTLResourceStorageModeShared];
    gU1=[gDev newBufferWithBytes:ojph::local::uvlc_tbl1 length:sizeof(ojph::local::uvlc_tbl1) options:MTLResourceStorageModeShared];
  }
  id<MTLDevice> dev=gDev; id<MTLCommandQueue> q=gQ; id<MTLComputePipelineState> pso=gPsoMT;

  const u8* dbase=f.stream.data();   // concatenated tile-part bodies
  // build concatenated coded buffer: per cb [16 prefix][coded][8 pad]; base->coded[0]
  std::vector<u8> coded; std::vector<GDesc> descs; std::vector<SDesc> sdescs; coded.reserve(1<<20);
  size_t outTotal=0;
  u32 topR=f.numDecomps - f.skipRes;   // reduced-res: only build/dispatch retained levels
  size_t compElems = resident ? sbCompElems(f) : 0;
  std::vector<size_t> outOff(f.cbs.size(), (size_t)-1);
  for (size_t k=0;k<f.cbs.size();++k){ const CB& cb=f.cbs[k];
    if (cb.res>topR || cb.len0==0) continue;    // skip finest levels -> fewer threadgroups
    u32 evenH=(cb.h+1u)&~1u; outOff[k]=outTotal; outTotal += (size_t)cb.w*evenH;
    for (int i=0;i<GPU_PREFIX;i++) coded.push_back(0);
    u32 base=(u32)coded.size();
    size_t nbytes=cb.len0+cb.len1;
    for (size_t i=0;i<nbytes;i++) coded.push_back(dbase[cb.codedOff+i]);
    for (int i=0;i<8;i++) coded.push_back(0);
    GDesc d; d.base=base; d.len0=cb.len0; d.missingMsbs=cb.missingMsbs; d.numPasses=cb.numPasses;
    d.W=cb.w; d.H=cb.h; d.outBase=(u32)outOff[k]; d.stride=cb.w; descs.push_back(d);
    if (resident){ SDesc s; s.outBase=(u32)outOff[k];
      s.sbOffset=(u32)(cb.comp*compElems + sbElemOffset(f,cb.res,cb.band));
      s.substride=f.sb[cb.comp][cb.res][cb.band].w; s.x0=cb.x0; s.y0=cb.y0; s.w=cb.w; s.h=cb.h;
      s.kmax=cb.Kmax; s.delta=cb.delta; s.reversible=f.reversible?1u:0u; sdescs.push_back(s); }
  }
  if (descs.empty()){ err="no codeblocks"; return false; }

  id<MTLBuffer> bC=[dev newBufferWithBytes:coded.data() length:coded.size() options:MTLResourceStorageModeShared];
  id<MTLBuffer> bD=[dev newBufferWithBytes:descs.data() length:descs.size()*sizeof(GDesc) options:MTLResourceStorageModeShared];
  id<MTLBuffer> bO=[dev newBufferWithLength:std::max<size_t>(outTotal,1)*sizeof(u32) options:MTLResourceStorageModeShared];
  memset(bO.contents,0,std::max<size_t>(outTotal,1)*sizeof(u32));

  double t0=nowms();
  id<MTLCommandBuffer> cbuf=[q commandBuffer];
  id<MTLComputeCommandEncoder> enc=[cbuf computeCommandEncoder];
  [enc setComputePipelineState:pso];
  [enc setBuffer:bC offset:0 atIndex:0]; [enc setBuffer:bD offset:0 atIndex:1]; [enc setBuffer:bO offset:0 atIndex:2];
  [enc setBuffer:gV0 offset:0 atIndex:3]; [enc setBuffer:gV1 offset:0 atIndex:4]; [enc setBuffer:gU0 offset:0 atIndex:5]; [enc setBuffer:gU1 offset:0 atIndex:6];
  [enc dispatchThreadgroups:MTLSizeMake(descs.size(),1,1) threadsPerThreadgroup:MTLSizeMake(1,1,1)];
  [enc endEncoding]; [cbuf commit]; [cbuf waitUntilCompleted];
  g_t_decode_ms = nowms()-t0;
  if (cbuf.status==MTLCommandBufferStatusError){ err=std::string("GPU error: ")+cbuf.error.localizedDescription.UTF8String; return false; }

  u32 top=f.numDecomps - f.skipRes;
  if (resident){
    // dequant + scatter into GPU-resident subband buffer (no CPU round-trip)
    gCompElems=compElems; gResident=true;
    size_t sbBytes=(size_t)f.numComps*compElems*sizeof(u32);
    if (!gSubbandBuf || (size_t)gSubbandBuf.length < sbBytes)
      gSubbandBuf=[dev newBufferWithLength:std::max<size_t>(sbBytes,4) options:MTLResourceStorageModeShared];
    memset(gSubbandBuf.contents,0,sbBytes);
    id<MTLBuffer> bSD=[dev newBufferWithBytes:sdescs.data() length:sdescs.size()*sizeof(SDesc) options:MTLResourceStorageModeShared];
    double ts=nowms();
    id<MTLCommandBuffer> sc=[q commandBuffer]; id<MTLComputeCommandEncoder> se=[sc computeCommandEncoder];
    [se setComputePipelineState:gPsoScatter];
    [se setBuffer:bO offset:0 atIndex:0]; [se setBuffer:bSD offset:0 atIndex:1]; [se setBuffer:gSubbandBuf offset:0 atIndex:2];
    [se dispatchThreadgroups:MTLSizeMake(sdescs.size(),1,1) threadsPerThreadgroup:MTLSizeMake(64,1,1)];
    [se endEncoding]; [sc commit]; [sc waitUntilCompleted];
    g_t_scatter_ms = nowms()-ts;
    if (sc.status==MTLCommandBufferStatusError){ err=std::string("GPU scatter: ")+sc.error.localizedDescription.UTF8String; return false; }
    return true;
  }
  gResident=false;
  const u32* outp=(const u32*)bO.contents;
  double tsc=nowms();
  for (size_t k=0;k<f.cbs.size();++k){ const CB& cb=f.cbs[k]; if (cb.len0==0||cb.res>top) continue;
    SubbandBuf& sbuf=f.sb[cb.comp][cb.res][cb.band];
    if (f.reversible){
      std::vector<i32> sm((size_t)cb.w*cb.h,0);
      dequantRev(outp+outOff[k], sm.data(), cb.Kmax, cb.w*cb.h);
      for (u32 yy=0;yy<cb.h;++yy) for (u32 xx=0;xx<cb.w;++xx)
        sbuf.coeff[(size_t)(cb.y0+yy)*sbuf.w+(cb.x0+xx)] = sm[(size_t)yy*cb.w+xx];
    } else {
      for (u32 yy=0;yy<cb.h;++yy) for (u32 xx=0;xx<cb.w;++xx){
        u32 v=outp[outOff[k]+(size_t)yy*cb.w+xx]; float mag=(float)(v&0x7FFFFFFFu)*cb.delta;
        sbuf.coeffF[(size_t)(cb.y0+yy)*sbuf.w+(cb.x0+xx)]=(v&0x80000000u)?-mag:mag;
      }
    }
  }
  g_t_scatter_ms = nowms()-tsc;
  return true;
 }
}

// ============================ inverse 5/3 DWT ===============================
// 1D reversible 5/3 synthesis (even=true, origin 0). low[0..nl-1], high[0..nh-1]
// -> out[0..n-1], n=nl+nh, nl=ceil(n/2). Matches OpenJPH gen_rev_horz_syn.
static void isyn53(const i32* low,const i32* high,u32 nl,u32 nh,i32* out){
  u32 n=nl+nh;
  if (n==1){ out[0]=low[0]; return; }
  std::vector<i32> L(low,low+nl), Hh(high,high+nh);
  // step0 update (a=1,b=2,e=2): L[i] -= (2 + H[i-1]+H[i])>>2 , H[-1]=H[0]
  for (u32 i=0;i<nl;i++){ i32 hl = (i==0)?Hh[0]:Hh[i-1]; i32 hr = (i<nh)?Hh[i]:Hh[nh-1]; L[i]-=(2 + hl + hr)>>2; }
  // step1 predict (a=-1,b=1,e=1): H[i] += (L[i]+L[i+1])>>1 , L[nl]=L[nl-1]
  for (u32 i=0;i<nh;i++){ i32 ll=L[i]; i32 lr=(i+1<nl)?L[i+1]:L[nl-1]; Hh[i]+=(ll+lr)>>1; }
  for (u32 i=0;i<n;i++) out[i]= (i&1)? Hh[i>>1] : L[i>>1];
}

// One 2D inverse level. HORIZONTAL first then VERTICAL, matching OpenJPH
// resolution::pull_line (rev_horz_syn LL+HL and LH+HH per row, then rev_vert_step).
static void inverseLevel(const SubbandBuf& LL,const SubbandBuf& HL,const SubbandBuf& LH,const SubbandBuf& HH,
                         u32 rw,u32 rh, SubbandBuf& out){
  u32 lw=LL.w, hw=rw-lw, lh=LL.h, hh=rh-lh;
  out.w=rw; out.h=rh; out.coeff.assign((size_t)rw*rh,0);
  // horizontal: low-vert rows (lh) = LL+HL; high-vert rows (hh) = LH+HH
  std::vector<i32> Lrow((size_t)rw*lh), Hrow((size_t)rw*hh);
  std::vector<i32> rlo(lw), rhi(hw), ro(rw);
  for (u32 y=0;y<lh;y++){
    for (u32 x=0;x<lw;x++) rlo[x]=LL.coeff[(size_t)y*lw+x];
    for (u32 x=0;x<hw;x++) rhi[x]=HL.coeff[(size_t)y*hw+x];
    isyn53(rlo.data(),rhi.data(),lw,hw,ro.data());
    for (u32 x=0;x<rw;x++) Lrow[(size_t)y*rw+x]=ro[x];
  }
  for (u32 y=0;y<hh;y++){
    for (u32 x=0;x<lw;x++) rlo[x]=LH.coeff[(size_t)y*lw+x];
    for (u32 x=0;x<hw;x++) rhi[x]=HH.coeff[(size_t)y*hw+x];
    isyn53(rlo.data(),rhi.data(),lw,hw,ro.data());
    for (u32 x=0;x<rw;x++) Hrow[(size_t)y*rw+x]=ro[x];
  }
  // vertical: per column combine Lrow(lh) + Hrow(hh)
  std::vector<i32> clo(lh), chi(hh), co(rh);
  for (u32 x=0;x<rw;x++){
    for (u32 y=0;y<lh;y++) clo[y]=Lrow[(size_t)y*rw+x];
    for (u32 y=0;y<hh;y++) chi[y]=Hrow[(size_t)y*rw+x];
    isyn53(clo.data(),chi.data(),lh,hh,co.data());
    for (u32 y=0;y<rh;y++) out.coeff[(size_t)y*rw+x]=co[y];
  }
}

// ---- 9/7 irreversible 1D synthesis (float, K scaling + 4 lifting steps) ----
// Mirrors OpenJPH gen_irv_horz_syn (even=true).
static void isyn97(const float* low,const float* high,u32 nl,u32 nh,float* out){
  const float K=1.230174104914001f, Kinv=1.0f/K;
  const float A[4]={0.443506852043971f,0.882911075530934f,-0.052980118572961f,-1.586134342059924f};
  u32 n=nl+nh;
  if (n==1){ out[0]=low[0]; return; }
  // padded buffers, index base 1 so [-1] and [width] are valid
  std::vector<float> A0(nl+2,0.f), A1(nh+2,0.f);
  for (u32 i=0;i<nl;i++) A0[i+1]=low[i]*K;
  for (u32 i=0;i<nh;i++) A1[i+1]=high[i]*Kinv;
  float* aug=A0.data()+1; u32 augw=nl; float* oth=A1.data()+1; u32 othw=nh; bool ev=true;
  for (int j=0;j<4;j++){
    oth[-1]=oth[0]; oth[othw]=oth[othw-1];
    const float* sp=oth+(ev?0:1); float* dp=aug; float a=A[j];
    for (u32 i=0;i<augw;i++,sp++,dp++) *dp -= a*(sp[-1]+sp[0]);
    float* t=aug; aug=oth; oth=t; ev=!ev; u32 w=augw; augw=othw; othw=w;
  }
  // combine: even -> low,high,low,high...  low=A0+1, high=A1+1
  const float* spl=A0.data()+1; const float* sph=A1.data()+1;
  for (u32 i=0;i<n;i++) out[i]=(i&1)? sph[i>>1] : spl[i>>1];
}
static void inverseLevel97(const SubbandBuf& LL,const SubbandBuf& HL,const SubbandBuf& LH,const SubbandBuf& HH,
                           u32 rw,u32 rh, SubbandBuf& out){
  u32 lw=LL.w, hw=rw-lw, lh=LL.h, hh=rh-lh;
  out.w=rw; out.h=rh; out.coeffF.assign((size_t)rw*rh,0.f);
  std::vector<float> Lrow((size_t)rw*lh), Hrow((size_t)rw*hh), rlo(lw), rhi(hw), ro(rw);
  for (u32 y=0;y<lh;y++){ for(u32 x=0;x<lw;x++) rlo[x]=LL.coeffF[(size_t)y*lw+x]; for(u32 x=0;x<hw;x++) rhi[x]=HL.coeffF[(size_t)y*hw+x];
    isyn97(rlo.data(),rhi.data(),lw,hw,ro.data()); for(u32 x=0;x<rw;x++) Lrow[(size_t)y*rw+x]=ro[x]; }
  for (u32 y=0;y<hh;y++){ for(u32 x=0;x<lw;x++) rlo[x]=LH.coeffF[(size_t)y*lw+x]; for(u32 x=0;x<hw;x++) rhi[x]=HH.coeffF[(size_t)y*hw+x];
    isyn97(rlo.data(),rhi.data(),lw,hw,ro.data()); for(u32 x=0;x<rw;x++) Hrow[(size_t)y*rw+x]=ro[x]; }
  std::vector<float> clo(lh), chi(hh), co(rh);
  for (u32 x=0;x<rw;x++){ for(u32 y=0;y<lh;y++) clo[y]=Lrow[(size_t)y*rw+x]; for(u32 y=0;y<hh;y++) chi[y]=Hrow[(size_t)y*rw+x];
    isyn97(clo.data(),chi.data(),lh,hh,co.data()); for(u32 y=0;y<rh;y++) out.coeffF[(size_t)y*rw+x]=co[y]; }
}
static void idwtComponent97(const Frame& f,u32 c, std::vector<float>& outFull){
  SubbandBuf cur=f.sb[c][0][0]; u32 top=f.numDecomps - f.skipRes;
  for (u32 r=1;r<=top;++r){ SubbandBuf next; inverseLevel97(cur,f.sb[c][r][1],f.sb[c][r][2],f.sb[c][r][3],resW(f,r),resH(f,r),next); cur=std::move(next); }
  outFull=std::move(cur.coeffF);
}

// Reconstruct one component -> full-res signed samples.
static void idwtComponent(const Frame& f,u32 c, std::vector<i32>& outFull){
  SubbandBuf cur = f.sb[c][0][0];   // LL0
  u32 top=f.numDecomps - f.skipRes;
  for (u32 r=1;r<=top;++r){ SubbandBuf next; inverseLevel(cur, f.sb[c][r][1], f.sb[c][r][2], f.sb[c][r][3], resW(f,r), resH(f,r), next); cur=std::move(next); }
  outFull=std::move(cur.coeff);
}

// ============================ GPU IDWT + colour =============================
// Reconstructs every component with Metal compute passes (kHorz/kVert per level)
// and applies inverse RCT + DC shift (kColor). f.sb must already be filled.
// Cached IDWT/colour library + pipelines (compile idwt_color.metal ONCE).
static id<MTLLibrary> gIdwtLib=nil;
static id<MTLComputePipelineState> gPsoH=nil,gPsoV=nil,gPsoC=nil,gPsoH97=nil,gPsoV97=nil,gPsoICT=nil;
static bool ensureIdwtLib(std::string& err){
  if (!gDev){ gDev=MTLCreateSystemDefaultDevice(); if(!gDev){ err="no Metal device"; return false; } gQ=[gDev newCommandQueue]; }
  if (gIdwtLib) return true;
  NSString* src=loadFile("idwt_color.metal"); if(!src){ err="cannot read idwt_color.metal"; return false; }
  NSError* e=nil; gIdwtLib=[gDev newLibraryWithSource:src options:[MTLCompileOptions new] error:&e];
  if(!gIdwtLib){ err=std::string("MSL compile: ")+e.localizedDescription.UTF8String; return false; }
  gPsoH=[gDev newComputePipelineStateWithFunction:[gIdwtLib newFunctionWithName:@"kHorz"] error:&e];
  gPsoV=[gDev newComputePipelineStateWithFunction:[gIdwtLib newFunctionWithName:@"kVert"] error:&e];
  gPsoC=[gDev newComputePipelineStateWithFunction:[gIdwtLib newFunctionWithName:@"kColor"] error:&e];
  gPsoH97=[gDev newComputePipelineStateWithFunction:[gIdwtLib newFunctionWithName:@"kHorz97"] error:&e];
  gPsoV97=[gDev newComputePipelineStateWithFunction:[gIdwtLib newFunctionWithName:@"kVert97"] error:&e];
  gPsoICT=[gDev newComputePipelineStateWithFunction:[gIdwtLib newFunctionWithName:@"kICT"] error:&e];
  if(!gPsoH||!gPsoV||!gPsoC||!gPsoH97||!gPsoV97||!gPsoICT){ err="idwt pipeline build failed"; return false; }
  return true;
}

static bool gpuIDWTColor(const Frame& f, const char* mode, std::vector<std::vector<i32>>& comp, std::string& err){
 @autoreleasepool {
  if(!ensureIdwtLib(err)) return false;
  id<MTLDevice> dev=gDev; id<MTLCommandQueue> q=gQ;
  id<MTLComputePipelineState> psoH=gPsoH, psoV=gPsoV, psoC=gPsoC;
  auto buf=[&](const std::vector<i32>& v){ size_t n=std::max<size_t>(v.size(),1); id<MTLBuffer> b=[dev newBufferWithLength:n*4 options:MTLResourceStorageModeShared]; if(!v.empty()) memcpy(b.contents,v.data(),v.size()*4); return b; };

  comp.assign(f.numComps,{});
  u32 top=f.numDecomps-f.skipRes; u32 ow=resW(f,top), oh=resH(f,top); size_t opx=(size_t)ow*oh;
  bool res=gResident;   // read decoded subbands straight from the GPU buffer
  double tI0=nowms();
  for (u32 c=0;c<f.numComps;c++){
    // (buffer, byteOffset) for an input subband
    auto sbIn=[&](u32 r,u32 band)->std::pair<id<MTLBuffer>,NSUInteger>{
      if (res) return { gSubbandBuf, (NSUInteger)((c*gCompElems + sbElemOffset(f,r,band))*4) };
      return { buf(f.sb[c][r][band].coeff), 0 };
    };
    auto cur = sbIn(0,0);
    for (u32 r=1;r<=top;++r){
      u32 rw=resW(f,r), rh=resH(f,r), lw=resW(f,r-1), hw=rw-lw, lh=resH(f,r-1), hh=rh-lh;
      auto HL=sbIn(r,1), LH=sbIn(r,2), HH=sbIn(r,3);
      id<MTLBuffer> bLrow=[dev newBufferWithLength:std::max<size_t>((size_t)rw*lh,1)*4 options:MTLResourceStorageModeShared];
      id<MTLBuffer> bHrow=[dev newBufferWithLength:std::max<size_t>((size_t)rw*hh,1)*4 options:MTLResourceStorageModeShared];
      id<MTLBuffer> bOut =[dev newBufferWithLength:(size_t)rw*rh*4 options:MTLResourceStorageModeShared];
      struct LvlParams{u32 rw,rh,lw,hw,lh,hh;} lp{rw,rh,lw,hw,lh,hh};
      id<MTLBuffer> bP=[dev newBufferWithBytes:&lp length:sizeof(lp) options:MTLResourceStorageModeShared];
      id<MTLCommandBuffer> cb=[q commandBuffer]; id<MTLComputeCommandEncoder> enc=[cb computeCommandEncoder];
      [enc setComputePipelineState:psoH];
      [enc setBuffer:cur.first offset:cur.second atIndex:0]; [enc setBuffer:HL.first offset:HL.second atIndex:1]; [enc setBuffer:LH.first offset:LH.second atIndex:2]; [enc setBuffer:HH.first offset:HH.second atIndex:3];
      [enc setBuffer:bLrow offset:0 atIndex:4]; [enc setBuffer:bHrow offset:0 atIndex:5]; [enc setBuffer:bP offset:0 atIndex:6];
      u32 nrows=std::max(lh,hh); [enc dispatchThreads:MTLSizeMake(nrows,1,1) threadsPerThreadgroup:MTLSizeMake(std::min<u32>(nrows,64),1,1)];
      [enc setComputePipelineState:psoV];
      [enc setBuffer:bLrow offset:0 atIndex:0]; [enc setBuffer:bHrow offset:0 atIndex:1]; [enc setBuffer:bOut offset:0 atIndex:2]; [enc setBuffer:bP offset:0 atIndex:3];
      [enc dispatchThreads:MTLSizeMake(rw,1,1) threadsPerThreadgroup:MTLSizeMake(std::min<u32>(rw,64),1,1)];
      [enc endEncoding]; [cb commit]; [cb waitUntilCompleted];
      if (cb.status==MTLCommandBufferStatusError){ err=std::string("GPU idwt: ")+cb.error.localizedDescription.UTF8String; return false; }
      cur={bOut,0};
    }
    comp[c].resize(opx); memcpy(comp[c].data(), (const u8*)cur.first.contents+cur.second, opx*4);
  }
  // colour + DC shift on GPU
  size_t px=opx;
  bool rct = std::string(mode)=="rct" && f.numComps==3;
  id<MTLBuffer> b0=buf(comp[0]);
  id<MTLBuffer> b1=(f.numComps>1)?buf(comp[1]):buf(std::vector<i32>(px,0));
  id<MTLBuffer> b2=(f.numComps>2)?buf(comp[2]):buf(std::vector<i32>(px,0));
  struct ColorParams{u32 px;int rct,s0,s1,s2;} cp;
  cp.px=(u32)px; cp.rct=rct?1:0;
  cp.s0=f.isSigned[0]?0:(1<<(f.bitDepth[0]-1));
  cp.s1=(f.numComps>1 && !f.isSigned[1])?(1<<(f.bitDepth[1]-1)):0;
  cp.s2=(f.numComps>2 && !f.isSigned[2])?(1<<(f.bitDepth[2]-1)):0;
  id<MTLBuffer> bcp=[dev newBufferWithBytes:&cp length:sizeof(cp) options:MTLResourceStorageModeShared];
  id<MTLCommandBuffer> cb=[q commandBuffer]; id<MTLComputeCommandEncoder> enc=[cb computeCommandEncoder];
  [enc setComputePipelineState:psoC];
  [enc setBuffer:b0 offset:0 atIndex:0]; [enc setBuffer:b1 offset:0 atIndex:1]; [enc setBuffer:b2 offset:0 atIndex:2]; [enc setBuffer:bcp offset:0 atIndex:3];
  [enc dispatchThreads:MTLSizeMake(px,1,1) threadsPerThreadgroup:MTLSizeMake(256,1,1)];
  [enc endEncoding]; [cb commit]; [cb waitUntilCompleted];
  memcpy(comp[0].data(), b0.contents, px*4);
  if (f.numComps>1) memcpy(comp[1].data(), b1.contents, px*4);
  if (f.numComps>2) memcpy(comp[2].data(), b2.contents, px*4);
  g_t_idwt_ms = nowms()-tI0;
  return true;
 }
}

static bool gpuIDWTColor97(const Frame& f, bool ict, std::vector<std::vector<float>>& cf, std::string& err); // fwd

// True if a CAP marker (0xFF50) is present in the main header => HTJ2K.
// Absent => Part-1 MQ/EBCOT (e.g. Meridian) which this decoder CANNOT decode.
static bool hasCAP(const std::vector<u8>& file){
  size_t j=2, N=file.size();
  while (j+2<=N){ u32 m=rd16(file.data()+j); if(m==0xFF90||m==0xFF93) break; if(m==0xFF50) return true;
    if(m<0xFF00){ j++; continue; } j+=2+rd16(file.data()+j+2); }
  return false;
}

// Full GPU-FULL reconstruction to final integer RGB samples (auto colour), with
// range clamp. Mirrors main()'s --gpu-full path exactly (see reconstruction block).
static bool decodeToRGB(Frame& f, std::vector<std::vector<i32>>& comp, std::string& err){
  static std::vector<u8> dummy;
  u32 top=f.numDecomps-f.skipRes; size_t px=(size_t)resW(f,top)*resH(f,top);
  bool ict = f.colourTrans && f.numComps==3 && !f.reversible;
  bool rct = f.colourTrans && f.numComps==3 && f.reversible;
  if (!decodeAllGPU(dummy,f,err,true)) return false;
  comp.assign(f.numComps,{});
  if (f.reversible){
    if (!gpuIDWTColor(f, rct?"rct":"mono", comp, err)) return false;
  } else {
    std::vector<std::vector<float>> cf;
    if (!gpuIDWTColor97(f, ict, cf, err)) return false;
    for (u32 c=0;c<f.numComps;c++){ comp[c].resize(px); u32 bd=f.bitDepth[c]; float mul=(float)(1ull<<bd);
      i32 lo=(i32)(INT_MIN>>(32-bd)), hi=(i32)(INT_MAX>>(32-bd)); i32 half=f.isSigned[c]?0:(1<<(bd-1));
      for (size_t i=0;i<px;i++){ float t=cf[c][i]*mul; i32 v=(i32)(t+(t>=0?0.5f:-0.5f)); v=v<lo?lo:(v>hi?hi:v); comp[c][i]=v+half; } }
  }
  for (u32 c=0;c<f.numComps;c++){ i32 lo,hi; if (f.isSigned[c]){hi=(1<<(f.bitDepth[c]-1))-1;lo=-(1<<(f.bitDepth[c]-1));} else {hi=(1<<f.bitDepth[c])-1;lo=0;}
    for (size_t i=0;i<px;i++){ i32 v=comp[c][i]; comp[c][i]=v<lo?lo:(v>hi?hi:v); } }
  return true;
}

// Interleave planar comp[] -> interleaved integer samples at the source bit depth
// (matches imf_j2k.js WASM shape: pixelsType u8/u16/i16, sampleLayout 'interleaved').
static std::vector<u8> serializeInterleaved(const Frame& f, const std::vector<std::vector<i32>>& comp,
                                            u32 outW, u32 outH, const char*& pixelsType, u32& bytesPer){
  u32 C=f.numComps; u32 bd=f.bitDepth[0]; bool sgn=f.isSigned[0];
  bytesPer = bd>8 ? 2 : 1;
  pixelsType = bd>8 ? (sgn?"i16":"u16") : "u8";
  size_t px=(size_t)outW*outH;
  std::vector<u8> out(px*C*bytesPer);
  for (size_t i=0;i<px;i++) for (u32 c=0;c<C;c++){
    i32 v=comp[c][i]; size_t o=(i*C+c)*bytesPer;
    if (bytesPer==2){ out[o]=(u8)(v&0xFF); out[o+1]=(u8)((v>>8)&0xFF); } // little-endian
    else out[o]=(u8)v;
  }
  return out;
}

// ---- tiny JSON field extractors (protocol is simple; we own both ends) ----
static std::string jStr(const std::string& s, const char* key){
  std::string k=std::string("\"")+key+"\""; size_t p=s.find(k); if(p==std::string::npos) return "";
  p=s.find(':',p+k.size()); if(p==std::string::npos) return ""; p++;
  while(p<s.size()&&(s[p]==' '||s[p]=='"')) p++;
  size_t e=p; while(e<s.size()&&s[e]!='"'&&s[e]!=','&&s[e]!='}') e++;
  std::string v=s.substr(p,e-p); while(!v.empty()&&(v.back()==' ')) v.pop_back(); return v;
}
static long jInt(const std::string& s, const char* key, long def){
  std::string v=jStr(s,key); if(v.empty()) return def; return atol(v.c_str());
}

// ---- reusable mmap'd temp-file pixel ring ----------------------------------
// Chosen over POSIX shm_open because: macOS has no /dev/shm path (Node cannot
// mmap shm_open names without a native addon), and orphaned shm segments are a
// known macOS leak. A plain temp file mmap'd MAP_SHARED is coherent across the
// helper (mmap-writes) and Node (reads the same file) via the unified buffer
// cache, needs no native addon, and on crash leaves only a sweepable /tmp file
// (no persistent segment leak). Slot layout: [u64 seq][u64 byteLength][payload].
// The reader checks seq (written LAST, after a barrier) => never a torn frame.
static int    g_ringFd=-1;
static u8*    g_ringMap=nullptr;
static size_t g_ringMapBytes=0, g_ringSlot=0;
static int    g_ringN=4, g_ringNext=0, g_ringGen=0;
static char   g_ringPath[256]={0};
static u64    g_ringSeq=0;

static void ringCleanup(){
  if (g_ringMap && g_ringMap!=MAP_FAILED){ munmap(g_ringMap,g_ringMapBytes); }
  g_ringMap=nullptr;
  if (g_ringFd>=0){ close(g_ringFd); g_ringFd=-1; }
  if (g_ringPath[0]){ unlink(g_ringPath); g_ringPath[0]=0; }
}
static void ringSignal(int){ ringCleanup(); _exit(1); }
static void ringSweepStale(){
  DIR* d=opendir("/tmp"); if(!d) return; struct dirent* e;
  while ((e=readdir(d))){ if (strncmp(e->d_name,"pfx_htj2k_ring_",15)) continue;
    int pid=atoi(e->d_name+15);
    if (pid>0 && kill(pid,0)!=0 && errno==ESRCH){ char p[300]; snprintf(p,sizeof(p),"/tmp/%s",e->d_name); unlink(p); } }
  closedir(d);
}
static bool ringEnsure(size_t payloadBytes){
  size_t need=((16+payloadBytes)+4095)&~size_t(4095);   // page-align each slot
  if (g_ringMap && need<=g_ringSlot) return true;
  ringCleanup();
  g_ringSlot=need; g_ringMapBytes=g_ringSlot*(size_t)g_ringN;
  // Unique path per (re)creation so the reader always reopens a resized ring and
  // never reads a stale (unlinked) inode via a cached fd. pid stays first field
  // after the prefix so ringSweepStale() can still parse it.
  snprintf(g_ringPath,sizeof(g_ringPath),"/tmp/pfx_htj2k_ring_%d_%d.bin",(int)getpid(),++g_ringGen);
  g_ringFd=open(g_ringPath,O_RDWR|O_CREAT|O_TRUNC,0600);
  if (g_ringFd<0){ g_ringPath[0]=0; return false; }
  if (ftruncate(g_ringFd,(off_t)g_ringMapBytes)!=0){ ringCleanup(); return false; }
  g_ringMap=(u8*)mmap(nullptr,g_ringMapBytes,PROT_READ|PROT_WRITE,MAP_SHARED,g_ringFd,0);
  if (g_ringMap==MAP_FAILED){ g_ringMap=nullptr; ringCleanup(); return false; }
  g_ringNext=0; return true;
}
static bool ringWrite(const u8* payload,size_t bytes,int& slot,u64& seq,size_t& slotSizeOut){
  if (getenv("PFX_HTJ2K_NO_RING")) return false;    // force M6a temp-file path (A/B)
  if (!ringEnsure(bytes)) return false;
  slot=g_ringNext; g_ringNext=(g_ringNext+1)%g_ringN;
  u8* base=g_ringMap+(size_t)slot*g_ringSlot;
  memcpy(base+16,payload,bytes);
  u64 len=bytes; memcpy(base+8,&len,8);
  __sync_synchronize();
  seq=++g_ringSeq; memcpy(base+0,&seq,8);   // ready flag written LAST
  __sync_synchronize();
  slotSizeOut=g_ringSlot; return true;
}

static int runIpc(){
  setvbuf(stdout, nullptr, _IONBF, 0);
  ringSweepStale();
  signal(SIGTERM,ringSignal); signal(SIGINT,ringSignal); signal(SIGHUP,ringSignal);
  atexit(ringCleanup);
  std::string buf; char rd[8192];
  while (true){
    // read() returns as soon as >=1 byte is available (unlike fread, which blocks
    // until the whole buffer fills) — required for a live newline-delimited pipe.
    ssize_t n=read(0, rd, sizeof(rd));
    if (n<0){ if(errno==EINTR) continue; break; }
    if (n==0) break;   // EOF
    buf.append(rd,(size_t)n);
    size_t nl;
    while ((nl=buf.find('\n'))!=std::string::npos){
      std::string line=buf.substr(0,nl); buf.erase(0,nl+1);
      if (line.empty()) continue;
      long id=jInt(line,"id",0); std::string cmd=jStr(line,"cmd");
      if (cmd=="ping"){
        printf("{\"id\":%ld,\"ok\":true,\"version\":\"pfx-htj2k-metal 1.0\",\"metal\":%s}\n",
               id, MTLCreateSystemDefaultDevice()?"true":"false");
        continue;
      }
      if (cmd=="decode"){
        std::string j2c=jStr(line,"j2cPath"); long skip=jInt(line,"skip",0);
        FILE* fp=fopen(j2c.c_str(),"rb");
        if(!fp){ printf("{\"id\":%ld,\"ok\":false,\"code\":\"DECODE_FAILED\",\"error\":\"open\"}\n",id); continue; }
        fseek(fp,0,SEEK_END); long sz=ftell(fp); fseek(fp,0,SEEK_SET);
        std::vector<u8> file(sz>0?sz:0); if(sz>0 && fread(file.data(),1,sz,fp)!=(size_t)sz){ fclose(fp); printf("{\"id\":%ld,\"ok\":false,\"code\":\"DECODE_FAILED\",\"error\":\"read\"}\n",id); continue; }
        fclose(fp);
        if (!hasCAP(file)){ printf("{\"id\":%ld,\"ok\":false,\"code\":\"NOT_HTJ2K\"}\n",id); continue; }
        Frame f; std::string err;
        if (!parseFrame(file,f,err)){ printf("{\"id\":%ld,\"ok\":false,\"code\":\"DECODE_FAILED\",\"error\":\"parse:%s\"}\n",id,err.c_str()); continue; }
        if ((u32)skip>f.numDecomps) skip=f.numDecomps; f.skipRes=(u32)skip;
        u32 top=f.numDecomps-f.skipRes, outW=resW(f,top), outH=resH(f,top);
        std::vector<std::vector<i32>> comp;
        if (!decodeToRGB(f,comp,err)){ printf("{\"id\":%ld,\"ok\":false,\"code\":\"DECODE_FAILED\",\"error\":\"%s\"}\n",id,err.c_str()); continue; }
        const char* ptype; u32 bytesPer;
        std::vector<u8> px=serializeInterleaved(f,comp,outW,outH,ptype,bytesPer);
        // Pixel channel: prefer the mmap'd ring (no per-frame file churn); fall
        // back to a per-frame temp file if the ring can't be created.
        int slot; u64 seq; size_t slotSize;
        if (ringWrite(px.data(),px.size(),slot,seq,slotSize)){
          printf("{\"id\":%ld,\"ok\":true,\"ring\":true,\"ringPath\":\"%s\",\"slot\":%d,\"slotSize\":%zu,\"ringN\":%d,\"seq\":%llu,"
                 "\"width\":%u,\"height\":%u,\"componentCount\":%u,\"bitsPerSample\":%u,\"isSigned\":%s,"
                 "\"pixelsType\":\"%s\",\"sampleLayout\":\"interleaved\",\"byteLength\":%zu}\n",
                 id,g_ringPath,slot,slotSize,g_ringN,(unsigned long long)seq,
                 outW,outH,f.numComps,f.bitDepth[0], f.isSigned[0]?"true":"false", ptype, px.size());
          continue;
        }
        char tmpl[]="/tmp/pfx_htj2k_XXXXXX"; int fd=mkstemp(tmpl);
        if (fd<0){ printf("{\"id\":%ld,\"ok\":false,\"code\":\"DECODE_FAILED\",\"error\":\"tmp\"}\n",id); continue; }
        FILE* of=fdopen(fd,"wb"); fwrite(px.data(),1,px.size(),of); fclose(of);
        printf("{\"id\":%ld,\"ok\":true,\"width\":%u,\"height\":%u,\"componentCount\":%u,"
               "\"bitsPerSample\":%u,\"isSigned\":%s,\"pixelsType\":\"%s\",\"sampleLayout\":\"interleaved\","
               "\"path\":\"%s\",\"byteLength\":%zu}\n",
               id,outW,outH,f.numComps,f.bitDepth[0], f.isSigned[0]?"true":"false", ptype, tmpl, px.size());
        continue;
      }
      printf("{\"id\":%ld,\"ok\":false,\"error\":\"unknown cmd\"}\n",id);
    }
  }
  return 0;
}

// ============================ output / compare ==============================
int main(int argc, char** argv){
  for (int a=1;a<argc;a++){ std::string s=argv[a];
    if (s=="--version"){ printf("pfx-htj2k-metal version 1.0\n"); return 0; }
    if (s=="--ipc"){ return runIpc(); }
  }
  bool useGPU=false, useGPUfull=false; const char* path=nullptr; const char* oraclePath=nullptr; const char* mode="mono";
  u32 skip=0; double psnrThresh=60.0; int bench=0; bool parseOnly=false;
  for (int a=1;a<argc;a++){ std::string s=argv[a];
    if (s=="--gpu") useGPU=true; else if (s=="--gpu-full"){ useGPU=true; useGPUfull=true; }
    else if (s=="--mono") mode="mono"; else if(s=="--rct") mode="rct"; else if(s=="--ict") mode="ict";
    else if (s=="--skip"){ skip=(u32)atoi(argv[++a]); }
    else if (s=="--psnr"){ psnrThresh=atof(argv[++a]); }
    else if (s=="--bench"){ bench=atoi(argv[++a]); useGPU=true; useGPUfull=true; }
    else if (s=="--parse-only") parseOnly=true;
    else if (!path) path=argv[a]; else oraclePath=argv[a]; }
  if (!path || (!oraclePath && !bench && !parseOnly)){ fprintf(stderr,"usage: %s [--gpu|--gpu-full|--parse-only] [--mono|--rct|--ict] [--skip N] [--bench K] <file.j2c> [oracle]\n",argv[0]); return 2; }

  FILE* fp=fopen(path,"rb"); if(!fp){fprintf(stderr,"open %s\n",path);return 2;}
  fseek(fp,0,SEEK_END); long sz=ftell(fp); fseek(fp,0,SEEK_SET);
  std::vector<u8> file(sz); if(fread(file.data(),1,sz,fp)!=(size_t)sz){fclose(fp);return 2;} fclose(fp);

  // --parse-only: structural dump (also works on Part-1/MQ codestreams like
  // Meridian, whose PIXELS we cannot decode — HTJ2K-only — but whose STRUCTURE
  // we recover: dims, tile-parts, progression, precincts, codeblock count).
  if (parseOnly){
    Frame f; std::string err;
    if (!parseFrame(file,f,err,/*structOnly*/true)){ fprintf(stderr,"PARSE FAIL: %s\n",err.c_str()); return 2; }
    const char* pn[]={"LRCP","RLCP","RPCL","PCRL","CPRL"};
    bool hasCAP=false; { size_t j=2; while(j+2<file.size()){ u32 m=rd16(file.data()+j); if(m==0xFF90||m==0xFF93)break; if(m==0xFF50){hasCAP=true;break;} if(m<0xFF00){j++;continue;} j+=2+rd16(file.data()+j+2);} }
    printf("=== structural parse: %s ===\n", path);
    printf("  dims           : %u x %u\n", f.W, f.H);
    printf("  components     : %u  (bit-depth %u, %s)\n", f.numComps, f.numComps?f.bitDepth[0]:0, f.numComps&&f.isSigned[0]?"signed":"unsigned");
    printf("  transform      : %s  (CAP=%s => %s)\n", f.reversible?"5/3 rev":"9/7 irrev", hasCAP?"yes":"no", hasCAP?"HTJ2K":"Part-1 MQ (pixels NOT decodable here)");
    printf("  colour xform   : %s\n", f.colourTrans?"yes (RCT/ICT)":"no");
    printf("  decomp levels  : %u\n", f.numDecomps);
    printf("  codeblock      : %u x %u\n", f.cbW, f.cbH);
    printf("  tile-parts     : %u\n", f.numTileParts);
    printf("  progression    : %s (%u)\n", f.progOrder<5?pn[f.progOrder]:"?", f.progOrder);
    printf("  explicit prec  : %s\n", f.explicitPrec?"yes":"no");
    size_t totalCb=0;
    for (u32 r=0;r<=f.numDecomps;++r){
      u32 npx=numPrecX(f,r), npy=numPrecY(f,r);
      printf("  res %u: %ux%u  precinct=%ux%u (2^%u,2^%u)  precincts=%ux%u=%u\n",
        r, resW(f,r),resH(f,r), 1u<<ppw(f,r),1u<<pph(f,r), ppw(f,r),pph(f,r), npx,npy, npx*npy);
      u32 nb=0; int bs=(r==0)?0:1, be=(r==0)?0:3;
      for (int b=bs;b<=be;++b){ CbGrid g=cbGrid(f,r,b); u32 w=0,h=0; for(auto v:g.colSiz)w+=v; for(auto v:g.rowSiz)h+=v; nb+= w*h; }
      totalCb += (size_t)nb * f.numComps;
    }
    printf("  total codeblocks (all comps, from geometry): %zu\n", totalCb);
    return 0;
  }

  Frame f; std::string err;
  if (!parseFrame(file,f,err)){ fprintf(stderr,"PARSE FAIL: %s\n",err.c_str()); return 2; }
  if (skip>f.numDecomps) skip=f.numDecomps; f.skipRes=skip;
  u32 top=f.numDecomps-f.skipRes, outW=resW(f,top), outH=resH(f,top);
  size_t px=(size_t)outW*outH;
  printf("[parse] %ux%u comps=%u decomps=%u %s cb=%ux%u colour=%d cbs=%zu skip=%u -> out %ux%u\n",
         f.W,f.H,f.numComps,f.numDecomps, f.reversible?"5/3":"9/7", f.cbW,f.cbH,(int)f.colourTrans,f.cbs.size(),f.skipRes,outW,outH);

  // count codeblocks actually decoded (evidence reduced-res skips work)
  { u32 dec=0; for (auto&cb:f.cbs) if (cb.len0 && cb.res<=top) dec++;
    if (f.skipRes) printf("[skip ] decoding %u of %zu codeblocks (skipping %u finest level(s))\n", dec, f.cbs.size(), f.skipRes); }

  // ---- PERF BENCHMARK (GPU pipeline only; never runs CPU ref on big frames) ----
  if (bench>0){
    bool ict = (std::string(mode)=="ict") && f.numComps==3;
    printf("[bench] %ux%u %s skip=%u  warm+%d iters (GPU block-decode + IDWT/colour)\n",
           outW,outH, f.reversible?"5/3":"9/7", f.skipRes, bench);
    fflush(stdout);
    double sdec=0, sidwt=0, stot=0; int measured=0;
    int total = bench + 1;                       // 1 warmup + bench measured
    for (int it=0; it<total; ++it){
      std::string derr; double w0=nowms();
      if (!decodeAllGPU(file,f,derr,true)){ printf("[bench] decode FAIL: %s\n",derr.c_str()); return 1; }
      std::vector<std::vector<i32>> ci; std::vector<std::vector<float>> cff; std::string ge;
      bool ok = f.reversible ? gpuIDWTColor(f,mode,ci,ge) : gpuIDWTColor97(f,ict,cff,ge);
      if (!ok){ printf("[bench] idwt FAIL: %s\n",ge.c_str()); return 1; }
      double w1=nowms();
      const char* phase = (it==0)?"warmup":"iter";
      printf("[bench] %-6s %2d: total=%.2f ms  (gpu block-decode=%.2f  idwt/colour=%.2f)\n",
             phase, it, w1-w0, g_t_decode_ms, g_t_idwt_ms); if(it==0)printf("[bench]        gpu dequant+scatter=%.2f ms (resident; replaces the old ~9 ms CPU round-trip)\n",g_t_scatter_ms); fflush(stdout);
      if (it>0){ sdec+=g_t_decode_ms; sidwt+=g_t_idwt_ms; stot+=(w1-w0); measured++; }
    }
    double avg = stot/measured;
    printf("[bench] AVG over %d iters: total=%.2f ms/frame  (%.1f fps)  | decode=%.2f idwt=%.2f\n",
           measured, avg, 1000.0/avg, sdec/measured, sidwt/measured);
    return 0;
  }

  if (useGPU){ std::string derr; if(!decodeAllGPU(file,f,derr, useGPUfull)){ printf("[GPU ] block-decode SKIP/FAIL: %s\n",derr.c_str()); return 1; } }
  else decodeAllCPU(file,f);

  // reconstruct + colour -> final integer samples per component (size px)
  std::vector<std::vector<i32>> comp(f.numComps);
  const char* tag = useGPU? "GPU " : "CPU ";

  if (f.reversible){
    if (useGPUfull){ std::string ge; if(!gpuIDWTColor(f,mode,comp,ge)){ printf("[%s] IDWT/colour SKIP/FAIL: %s\n",tag,ge.c_str()); return 1; } }
    else {
      for (u32 c=0;c<f.numComps;c++) idwtComponent(f,c,comp[c]);
      if ((std::string(mode)=="rct") && f.numComps==3)
        for (size_t i=0;i<px;i++){ i32 Y=comp[0][i],Cb=comp[1][i],Cr=comp[2][i]; i32 G=Y-((Cb+Cr)>>2); comp[0][i]=Cr+G; comp[1][i]=G; comp[2][i]=Cb+G; }
      for (u32 c=0;c<f.numComps;c++) if (!f.isSigned[c]){ i32 sh=1<<(f.bitDepth[c]-1); for (size_t i=0;i<px;i++) comp[c][i]+=sh; }
    }
  } else {
    // 9/7 float reconstruction
    std::vector<std::vector<float>> cf(f.numComps);
    bool ict = (std::string(mode)=="ict") && f.numComps==3;
    if (useGPUfull){ std::string ge; if(!gpuIDWTColor97(f,ict,cf,ge)){ printf("[%s] IDWT97/colour SKIP/FAIL: %s\n",tag,ge.c_str()); return 1; } }
    else {
      for (u32 c=0;c<f.numComps;c++) idwtComponent97(f,c,cf[c]);
      if (ict) for (size_t i=0;i<px;i++){ float Y=cf[0][i],Cb=cf[1][i],Cr=cf[2][i];
        cf[0][i]=Y+1.402f*Cr; cf[1][i]=Y-0.344136f*Cb-0.714136f*Cr; cf[2][i]=Y+1.772f*Cb; }
    }
    // convert float -> integer samples (matches OpenJPH irv_convert_to_integer)
    for (u32 c=0;c<f.numComps;c++){ comp[c].resize(px); u32 bd=f.bitDepth[c]; float mul=(float)(1ull<<bd);
      i32 lo=(i32)(INT_MIN>>(32-bd)), hi=(i32)(INT_MAX>>(32-bd)); i32 half=f.isSigned[c]?0:(1<<(bd-1));
      for (size_t i=0;i<px;i++){ float t=cf[c][i]*mul; i32 v=(i32)(t+(t>=0?0.5f:-0.5f)); v=v<lo?lo:(v>hi?hi:v); comp[c][i]=v+half; } }
  }

  // Clamp reconstructed samples to each component's representable range, exactly
  // as OpenJPH's file writers do (ppm/pgm: [0,2^bd-1]; raw signed: [-2^(bd-1),
  // 2^(bd-1)-1]). At full-res lossless this is a no-op; at REDUCED resolution the
  // low-pass reconstruction (esp. after inverse RCT) can exceed range, so the
  // clamp is required for bit-exactness vs `ojph_expand -skip_res`.
  for (u32 c=0;c<f.numComps;c++){
    i32 lo, hi;
    if (f.isSigned[c]){ hi=(1<<(f.bitDepth[c]-1))-1; lo=-(1<<(f.bitDepth[c]-1)); }
    else             { hi=(1<<f.bitDepth[c])-1;      lo=0; }
    for (size_t i=0;i<px;i++){ i32 v=comp[c][i]; comp[c][i]= v<lo?lo:(v>hi?hi:v); }
  }

  // load oracle (reduced-res aware) & compare
  FILE* op=fopen(oraclePath,"rb"); if(!op){fprintf(stderr,"open oracle\n");return 2;}
  std::string ors(oraclePath); bool isPPM = ors.size()>4 && ors.substr(ors.size()-4)==".ppm";
  std::vector<i32> oracle(px*f.numComps);
  if (isPPM){ char hdr[64]; int W2,H2,mv; if(fscanf(op,"%2s %d %d %d",hdr,&W2,&H2,&mv)!=4){fclose(op);return 2;} fgetc(op);
    if ((u32)W2!=outW||(u32)H2!=outH) printf("[warn ] oracle %dx%d vs out %ux%u\n",W2,H2,outW,outH);
    std::vector<u8> raw((size_t)W2*H2*3*2); fread(raw.data(),1,raw.size(),op);
    for (size_t i=0;i<px;i++) for(int c=0;c<3;c++){ size_t k=(i*3+c)*2; oracle[c*px+i]=(raw[k]<<8)|raw[k+1]; }
  } else {
    std::vector<u8> raw(px*f.numComps*2); fread(raw.data(),1,raw.size(),op);
    for (size_t i=0;i<px*f.numComps;i++){ i32 v=(i16)((raw[i*2+1]<<8)|raw[i*2]); oracle[i]=v; }
  }
  fclose(op);

  if (f.reversible){
    u32 ndiff=0; int fx=-1,fy=-1,fc=-1; i32 ev=0,gv=0;
    for (u32 c=0;c<f.numComps;c++) for (size_t i=0;i<px;i++){ i32 got=comp[c][i], exp=oracle[c*px+i];
      if (got!=exp){ if(!ndiff){ fc=c; fx=(int)(i%outW); fy=(int)(i/outW); ev=exp; gv=got; } ndiff++; } }
    if (ndiff==0) printf("[%s] FRAME PASS (bit-exact vs oracle)\n", tag);
    else printf("[%s] FRAME FAIL %u diffs; first comp=%d (%d,%d) exp=%d got=%d\n", tag, ndiff, fc, fx, fy, ev, gv);
    return ndiff==0?0:1;
  } else {
    // PSNR vs ojph_expand decode
    double mse=0; u32 maxv=(1u<<f.bitDepth[0])-1;
    for (u32 c=0;c<f.numComps;c++) for (size_t i=0;i<px;i++){ double d=(double)comp[c][i]-oracle[c*px+i]; mse+=d*d; }
    mse/=(double)(px*f.numComps);
    double psnr = mse<=0 ? 999.0 : 10.0*log10((double)maxv*maxv/mse);
    bool pass = psnr>=psnrThresh;
    printf("[%s] FRAME %s  PSNR=%.2f dB (threshold %.1f) mse=%.4f vs ojph_expand\n", tag, pass?"PASS":"FAIL", psnr, psnrThresh, mse);
    return pass?0:1;
  }
}

// ============================ GPU 9/7 IDWT + ICT ============================
struct LvlP97 { uint rw,rh,lw,hw,lh,hh; };
static bool gpuIDWTColor97(const Frame& f, bool ict, std::vector<std::vector<float>>& cf, std::string& err){
 @autoreleasepool {
  if(!ensureIdwtLib(err)) return false;
  id<MTLDevice> dev=gDev; id<MTLCommandQueue> q=gQ;
  id<MTLComputePipelineState> psoH=gPsoH97, psoV=gPsoV97, psoC=gPsoICT;
  auto bufF=[&](const std::vector<float>& v){ size_t n=std::max<size_t>(v.size(),1); id<MTLBuffer> b=[dev newBufferWithLength:n*4 options:MTLResourceStorageModeShared]; if(!v.empty()) memcpy(b.contents,v.data(),v.size()*4); return b; };
  u32 top=f.numDecomps-f.skipRes;
  cf.assign(f.numComps,{});
  std::vector<id<MTLBuffer>> full(f.numComps);
  bool res=gResident;
  double tI0=nowms();
  for (u32 c=0;c<f.numComps;c++){
    auto sbIn=[&](u32 r,u32 band)->std::pair<id<MTLBuffer>,NSUInteger>{
      if (res) return { gSubbandBuf, (NSUInteger)((c*gCompElems + sbElemOffset(f,r,band))*4) };
      return { bufF(f.sb[c][r][band].coeffF), 0 };
    };
    auto cur=sbIn(0,0);
    for (u32 r=1;r<=top;++r){ u32 rw=resW(f,r),rh=resH(f,r),lw=resW(f,r-1),hw=rw-lw,lh=resH(f,r-1),hh=rh-lh;
      auto HL=sbIn(r,1), LH=sbIn(r,2), HH=sbIn(r,3);
      id<MTLBuffer> bLrow=[dev newBufferWithLength:std::max<size_t>((size_t)rw*lh,1)*4 options:MTLResourceStorageModeShared];
      id<MTLBuffer> bHrow=[dev newBufferWithLength:std::max<size_t>((size_t)rw*hh,1)*4 options:MTLResourceStorageModeShared];
      id<MTLBuffer> bOut =[dev newBufferWithLength:(size_t)rw*rh*4 options:MTLResourceStorageModeShared];
      LvlP97 lp{rw,rh,lw,hw,lh,hh}; id<MTLBuffer> bP=[dev newBufferWithBytes:&lp length:sizeof(lp) options:MTLResourceStorageModeShared];
      id<MTLCommandBuffer> cb=[q commandBuffer]; id<MTLComputeCommandEncoder> enc=[cb computeCommandEncoder];
      [enc setComputePipelineState:psoH];
      [enc setBuffer:cur.first offset:cur.second atIndex:0];[enc setBuffer:HL.first offset:HL.second atIndex:1];[enc setBuffer:LH.first offset:LH.second atIndex:2];[enc setBuffer:HH.first offset:HH.second atIndex:3];
      [enc setBuffer:bLrow offset:0 atIndex:4];[enc setBuffer:bHrow offset:0 atIndex:5];[enc setBuffer:bP offset:0 atIndex:6];
      u32 nr=std::max(lh,hh); [enc dispatchThreads:MTLSizeMake(nr,1,1) threadsPerThreadgroup:MTLSizeMake(std::min<u32>(nr,64),1,1)];
      [enc setComputePipelineState:psoV];
      [enc setBuffer:bLrow offset:0 atIndex:0];[enc setBuffer:bHrow offset:0 atIndex:1];[enc setBuffer:bOut offset:0 atIndex:2];[enc setBuffer:bP offset:0 atIndex:3];
      [enc dispatchThreads:MTLSizeMake(rw,1,1) threadsPerThreadgroup:MTLSizeMake(std::min<u32>(rw,64),1,1)];
      [enc endEncoding];[cb commit];[cb waitUntilCompleted];
      if (cb.status==MTLCommandBufferStatusError){ err=std::string("GPU idwt97: ")+cb.error.localizedDescription.UTF8String; return false; }
      cur={bOut,0};
    }
    full[c]=cur.first;   // top>=1 for all tested vectors => cur is a fresh level output (offset 0)
  }
  u32 ow=resW(f,top), oh=resH(f,top); size_t px=(size_t)ow*oh;
  if (ict && f.numComps==3){
    struct ICTP{uint px;} ip{(u32)px}; id<MTLBuffer> bP=[dev newBufferWithBytes:&ip length:sizeof(ip) options:MTLResourceStorageModeShared];
    id<MTLCommandBuffer> cb=[q commandBuffer]; id<MTLComputeCommandEncoder> enc=[cb computeCommandEncoder];
    [enc setComputePipelineState:psoC];
    [enc setBuffer:full[0] offset:0 atIndex:0];[enc setBuffer:full[1] offset:0 atIndex:1];[enc setBuffer:full[2] offset:0 atIndex:2];[enc setBuffer:bP offset:0 atIndex:3];
    [enc dispatchThreads:MTLSizeMake(px,1,1) threadsPerThreadgroup:MTLSizeMake(256,1,1)];
    [enc endEncoding];[cb commit];[cb waitUntilCompleted];
  }
  for (u32 c=0;c<f.numComps;c++){ cf[c].resize(px); memcpy(cf[c].data(), full[c].contents, px*4); }
  g_t_idwt_ms = nowms()-tI0;
  return true;
 }
}
