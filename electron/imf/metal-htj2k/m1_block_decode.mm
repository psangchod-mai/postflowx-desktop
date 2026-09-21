// m1_block_decode.mm
// -----------------------------------------------------------------------------
// Milestone 1 of a native Apple-Metal HTJ2K decoder for PostFlowX.
//
// Smallest end-to-end, Bash-verifiable slice:
//   * CPU front-end: parse the JPEG2000/HTJ2K codestream markers we need
//     (SOC/SIZ/CAP/COD/QCD/SOT/SOD) + the single packet header, recovering the
//     ONE codeblock's descriptor (CUP byte range, missing MSBs, num passes,
//     pass lengths, width/height, K_max).
//   * CPU reference: hand the descriptor + codeblock bytes to OpenJPH's exported
//     scalar HT block decoder (ojph_decode_codeblock32, BSD-2) and dequantize
//     (gen_rev_tx_from_cb32). This independently VALIDATES the marker/packet
//     parsing against the M0 oracle.
//   * Metal: runtime-compile MSL (no offline metallib available on this box),
//     run a GPU port of the CUP (cleanup-pass) HT block decoder, and compare
//     bit-exact to the oracle + CPU reference.
//
// Build:   ./build.sh        Validate: ./validate.sh
// -----------------------------------------------------------------------------

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <vector>
#include <string>

// ---- OpenJPH exported scalar HT block decoder (from libopenjph.dylib) --------
// Declared here so we don't need the private coding/ headers. BSD-2 licensed.
namespace ojph { namespace local {
  bool ojph_decode_codeblock32(uint8_t* coded_data, uint32_t* decoded_data,
      uint32_t missing_msbs, uint32_t num_passes,
      uint32_t lengths1, uint32_t lengths2,
      uint32_t width, uint32_t height, uint32_t stride, bool stripe_causal);
  // OpenJPH's runtime-initialized VLC/UVLC decode tables (exported globals).
  extern uint16_t vlc_tbl0[1024];
  extern uint16_t vlc_tbl1[1024];
  extern uint16_t uvlc_tbl0[256+64];
  extern uint16_t uvlc_tbl1[256];
}}

#define GPU_PREFIX 16

typedef uint8_t  u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef int32_t  i32;

// =============================================================================
// Codestream parsing
// =============================================================================
struct CbDescriptor {
  u32 W=0, H=0;            // codeblock (== image) dims
  bool isSigned=false;
  u32 bitDepth=0;
  u32 numComps=0;
  u32 numDecomps=99;
  u32 cbW=0, cbH=0;
  u32 cbStyle=0;
  u32 transform=0;        // 1 = reversible 5/3
  u32 guardBits=0;
  u32 exponent=0;
  u32 Kmax=0;
  // packet-header-recovered:
  u32 missingMsbs=0;
  u32 numPasses=0;
  u32 passLen0=0, passLen1=0;
  // codeblock bytes (pass0 + pass1), padded with a few zero bytes as the
  // decoder may read up to 2 bytes past the end.
  std::vector<u8> coded;
};

static u32 rd16(const u8* p){ return (u32(p[0])<<8)|p[1]; }
static u32 rd32(const u8* p){ return (u32(p[0])<<24)|(u32(p[1])<<16)|(u32(p[2])<<8)|p[3]; }

// ---- minimal packet-header bit reader (mirrors OpenJPH bb_* with 0xFF stuffing)
struct BitRd {
  const u8* d; size_t n; size_t pos;
  u32 tmp; int avail; bool unstuff;
  BitRd(const u8* d_, size_t n_):d(d_),n(n_),pos(0),tmp(0),avail(0),unstuff(false){}
  bool fill(){
    if (pos < n){ u32 t=d[pos++]; tmp=t; avail=8-(unstuff?1:0); unstuff=(t==0xFF); return true; }
    tmp=0; avail=8-(unstuff?1:0); unstuff=false; return false;
  }
  u32 bit(){ if(avail==0) fill(); return (tmp >> (--avail)) & 1u; }
  u32 bits(int nb){ u32 r=0; while(nb){ if(avail==0) fill(); int t = avail<nb?avail:nb; r=(r<<t); avail-=t; nb-=t; r |= (tmp>>avail)&((1u<<t)-1); } return r; }
  void terminate(){ if(unstuff) fill(); tmp=0; avail=0; }
};

static bool parseCodestream(const std::vector<u8>& f, CbDescriptor& cb, std::string& err){
  const u8* d = f.data(); size_t N = f.size();
  if (N < 4 || rd16(d)!=0xFF4F){ err="no SOC"; return false; }
  size_t i=2;
  size_t sodOff=0, sotOff=0; u32 psot=0;
  while (i+2 <= N){
    u32 m = rd16(d+i);
    if (m==0xFF93){ sodOff=i; break; }             // SOD -> data follows
    if (m==0xFFD9){ break; }                        // EOC
    if (m<0xFF00){ err="bad marker align"; return false; }
    u32 L = rd16(d+i+2);
    const u8* seg = d+i+4;                           // payload
    switch(m){
      case 0xFF51: { // SIZ
        cb.W = rd32(seg+2) - rd32(seg+10);          // Xsiz - XOsiz
        cb.H = rd32(seg+6) - rd32(seg+14);          // Ysiz - YOsiz
        cb.numComps = rd16(seg+34);
        u8 ssiz = seg[36];
        cb.isSigned = (ssiz & 0x80)!=0;
        cb.bitDepth = (ssiz & 0x7F)+1;
        break; }
      case 0xFF52: { // COD
        u8 scod = seg[0];
        cb.numDecomps = seg[5];
        cb.cbW = 1u << ((seg[6]&0x0F)+2);
        cb.cbH = 1u << ((seg[7]&0x0F)+2);
        cb.cbStyle = seg[8];
        cb.transform = seg[9];
        (void)scod;
        break; }
      case 0xFF5C: { // QCD
        u8 sqcd = seg[0];
        cb.guardBits = sqcd>>5;
        u32 qstyle = sqcd & 0x1F;                    // 0 => reversible
        u8 spq = seg[1];                             // first subband (LL)
        if (qstyle==0) cb.exponent = spq>>3;         // reversible exponent
        else           cb.exponent = (rd16(seg+1)>>11);
        break; }
      case 0xFF90: { // SOT
        sotOff=i; psot = rd32(seg+2);               // Psot
        break; }
      default: break;
    }
    i += 2 + L;
  }
  if (!sodOff){ err="no SOD"; return false; }

  // K_max (reversible): num_bits = exponent-1 (if exponent>0), + guard bits.
  u32 numBits = cb.exponent==0 ? 0 : (cb.exponent-1);
  cb.Kmax = numBits + cb.guardBits;

  // ---- packet data range ----
  size_t dataStart = sodOff + 2;
  size_t dataEnd;
  if (psot){ dataEnd = sotOff + psot; if (dataEnd>N) dataEnd=N; }
  else     { dataEnd = N; }
  // drop trailing EOC if present
  if (dataEnd>=2 && rd16(d+dataEnd-2)==0xFFD9) dataEnd-=2;
  if (dataEnd <= dataStart){ err="empty tile data"; return false; }

  // ---- parse the single packet header (RPCL, 1 layer/res/comp/precinct/cb) ---
  // Single codeblock => tag-tree num_levels = 1; parsing collapses to:
  //   [empty-packet bit=1] [inclusion bit=1] [ zero-bitplanes: run of 0s ended
  //   by 1 ] [num-passes code] [Lblock increment 1s ended by 0] [len bits].
  BitRd br(d+dataStart, dataEnd-dataStart);
  if (br.bit()==0){ err="unexpected empty packet"; return false; }   // non-empty
  if (br.bit()==0){ err="codeblock not included"; return false; }    // inclusion (first layer)

  // zero bit-planes (missing msbs): count leading zero-bits until a 1.
  u32 mmsbs=0; while (br.bit()==0) mmsbs++;
  cb.missingMsbs = mmsbs;

  // number of coding passes (JPEG2000 packet-header code, mirrors OpenJPH).
  u32 numPasses=1, bit;
  bit=br.bit();
  if (bit){ numPasses=2; bit=br.bit();
    if (bit){ bit=br.bits(2); numPasses=3+bit;
      if (bit==3){ bit=br.bits(5); numPasses=6+bit;
        if (bit==31){ bit=br.bits(7); numPasses=37+bit; } } } }

  // placeholder-pass handling (HT): fold multiples of 3 into missing msbs.
  u32 numPhld = (numPasses-1)/3;
  cb.missingMsbs += numPhld;
  u32 numPhld3 = numPhld*3;
  cb.numPasses = numPasses - numPhld3;

  // Lblock
  int Lblock=3; while (br.bit()) Lblock++;

  // length of cleanup (pass0)
  int clz = __builtin_clz(numPhld+1);
  int lbits = Lblock + 31 - clz;
  cb.passLen0 = br.bits(lbits);

  if (cb.numPasses>1){
    int lbits2 = Lblock + (cb.numPasses>2 ? 1:0);
    cb.passLen1 = br.bits(lbits2);
  }
  br.terminate();

  // ---- codeblock bytes follow the packet header ----
  size_t pkHdrBytes = br.pos;                        // bytes consumed by header
  size_t cbStart = dataStart + pkHdrBytes;
  size_t cbBytes = cb.passLen0 + cb.passLen1;
  if (cbStart + cbBytes > N){ err="cb data overruns file"; return false; }
  cb.coded.assign(d+cbStart, d+cbStart+cbBytes);
  cb.coded.resize(cbBytes+8, 0);                     // pad for decoder over-read
  return true;
}

// =============================================================================
// Dequant: OpenJPH gen_rev_tx_from_cb32  (sign-magnitude -> signed coeff)
// =============================================================================
static void dequantRev(const u32* sp, i32* dp, u32 Kmax, u32 count){
  u32 shift = 31 - Kmax;
  for (u32 i=0;i<count;i++){
    u32 v = sp[i];
    i32 val = (i32)((v & 0x7FFFFFFFu) >> shift);
    dp[i] = (v & 0x80000000u) ? -val : val;
  }
}

// =============================================================================
// Oracle loading + compare
// =============================================================================
static bool loadCoeff(const char* path, u32& W, u32& H, std::vector<i32>& out){
  FILE* fp=fopen(path,"rb"); if(!fp) return false;
  u32 hdr[2]; if(fread(hdr,4,2,fp)!=2){fclose(fp);return false;}
  W=hdr[0]; H=hdr[1]; out.resize((size_t)W*H);
  size_t got=fread(out.data(),4,out.size(),fp); fclose(fp);
  return got==out.size();
}

static u32 compare(const std::vector<i32>& a, const i32* b, u32 W, u32 H, u32 stride,
                   int* firstX, int* firstY, i32* exp, i32* got){
  u32 ndiff=0;
  for (u32 y=0;y<H;y++) for(u32 x=0;x<W;x++){
    i32 e=a[(size_t)y*W+x]; i32 g=b[(size_t)y*stride+x];
    if (e!=g){ if(ndiff==0){*firstX=x;*firstY=y;*exp=e;*got=g;} ndiff++; }
  }
  return ndiff;
}

// =============================================================================
// Metal harness
// =============================================================================
static NSString* loadMSL(const char* path){
  NSString* p=[NSString stringWithUTF8String:path];
  NSError* e=nil;
  NSString* s=[NSString stringWithContentsOfFile:p encoding:NSUTF8StringEncoding error:&e];
  if(!s){ fprintf(stderr,"cannot read MSL %s: %s\n",path,e.localizedDescription.UTF8String); }
  return s;
}

// Runs the Metal CUP decoder. Returns true if kernel executed; fills `outMag`
// (raw sign-magnitude u32, width*height, tightly packed).
static bool runMetal(const char* mslPath, const CbDescriptor& cb,
                     std::vector<u32>& outMag, std::string& err){
  @autoreleasepool {
    id<MTLDevice> dev = MTLCreateSystemDefaultDevice();
    if(!dev){ err="no Metal device"; return false; }
    NSString* src = loadMSL(mslPath);
    if(!src){ err="MSL load failed"; return false; }
    NSError* e=nil;
    MTLCompileOptions* opt=[MTLCompileOptions new];
    id<MTLLibrary> lib=[dev newLibraryWithSource:src options:opt error:&e];
    if(!lib){ err=std::string("MSL compile failed: ")+e.localizedDescription.UTF8String; return false; }
    id<MTLFunction> fn=[lib newFunctionWithName:@"kCUP_decode"];
    if(!fn){ err="kernel kCUP_decode not found"; return false; }
    id<MTLComputePipelineState> pso=[dev newComputePipelineStateWithFunction:fn error:&e];
    if(!pso){ err=std::string("pipeline failed: ")+e.localizedDescription.UTF8String; return false; }
    id<MTLCommandQueue> q=[dev newCommandQueue];

    // coded buffer with GPU_PREFIX zero bytes prepended (safe backward/over-read)
    std::vector<u8> padded(GPU_PREFIX + cb.coded.size(), 0);
    memcpy(padded.data()+GPU_PREFIX, cb.coded.data(), cb.coded.size());
    id<MTLBuffer> bCoded=[dev newBufferWithBytes:padded.data() length:padded.size() options:MTLResourceStorageModeShared];
    struct Params { u32 W,H,missingMsbs,numPasses,len0,len1,Kmax,stride; } prm;
    prm.W=cb.W; prm.H=cb.H; prm.missingMsbs=cb.missingMsbs; prm.numPasses=cb.numPasses;
    prm.len0=cb.passLen0; prm.len1=cb.passLen1; prm.Kmax=cb.Kmax; prm.stride=cb.W;
    id<MTLBuffer> bPrm=[dev newBufferWithBytes:&prm length:sizeof(prm) options:MTLResourceStorageModeShared];
    size_t outN=(size_t)cb.W*cb.H;
    id<MTLBuffer> bOut=[dev newBufferWithLength:outN*sizeof(u32) options:MTLResourceStorageModeShared];
    memset(bOut.contents,0,outN*sizeof(u32));
    // OpenJPH decode tables -> GPU buffers (bit-identical to CPU reference)
    id<MTLBuffer> bV0=[dev newBufferWithBytes:ojph::local::vlc_tbl0  length:sizeof(ojph::local::vlc_tbl0)  options:MTLResourceStorageModeShared];
    id<MTLBuffer> bV1=[dev newBufferWithBytes:ojph::local::vlc_tbl1  length:sizeof(ojph::local::vlc_tbl1)  options:MTLResourceStorageModeShared];
    id<MTLBuffer> bU0=[dev newBufferWithBytes:ojph::local::uvlc_tbl0 length:sizeof(ojph::local::uvlc_tbl0) options:MTLResourceStorageModeShared];
    id<MTLBuffer> bU1=[dev newBufferWithBytes:ojph::local::uvlc_tbl1 length:sizeof(ojph::local::uvlc_tbl1) options:MTLResourceStorageModeShared];

    id<MTLCommandBuffer> cbuf=[q commandBuffer];
    id<MTLComputeCommandEncoder> enc=[cbuf computeCommandEncoder];
    [enc setComputePipelineState:pso];
    [enc setBuffer:bCoded offset:0 atIndex:0];
    [enc setBuffer:bPrm offset:0 atIndex:1];
    [enc setBuffer:bOut offset:0 atIndex:2];
    [enc setBuffer:bV0 offset:0 atIndex:3];
    [enc setBuffer:bV1 offset:0 atIndex:4];
    [enc setBuffer:bU0 offset:0 atIndex:5];
    [enc setBuffer:bU1 offset:0 atIndex:6];
    // single threadgroup, correctness-first (M1). One thread does the block.
    [enc dispatchThreadgroups:MTLSizeMake(1,1,1) threadsPerThreadgroup:MTLSizeMake(1,1,1)];
    [enc endEncoding];
    [cbuf commit];
    [cbuf waitUntilCompleted];
    if (cbuf.status==MTLCommandBufferStatusError){ err=std::string("GPU error: ")+cbuf.error.localizedDescription.UTF8String; return false; }

    outMag.resize(outN);
    memcpy(outMag.data(), bOut.contents, outN*sizeof(u32));
    return true;
  }
}

// =============================================================================
int main(int argc, char** argv){
  if (argc<3){ fprintf(stderr,"usage: %s <file.j2c> <file.coeff> [msl_path]\n",argv[0]); return 2; }
  const char* j2cPath=argv[1]; const char* coeffPath=argv[2];
  const char* mslPath = argc>3?argv[3]:"cup_decode.metal";

  // read file
  FILE* fp=fopen(j2cPath,"rb"); if(!fp){fprintf(stderr,"open %s failed\n",j2cPath);return 2;}
  fseek(fp,0,SEEK_END); long sz=ftell(fp); fseek(fp,0,SEEK_SET);
  std::vector<u8> f(sz); if(fread(f.data(),1,sz,fp)!=(size_t)sz){fclose(fp);return 2;} fclose(fp);

  CbDescriptor cb; std::string err;
  if (!parseCodestream(f, cb, err)){ fprintf(stderr,"PARSE FAIL: %s\n",err.c_str()); return 2; }

  printf("[parse] %ux%u signed=%d bd=%u comps=%u ndecomp=%u cb=%ux%u style=0x%X tx=%u\n",
         cb.W,cb.H,cb.isSigned,cb.bitDepth,cb.numComps,cb.numDecomps,cb.cbW,cb.cbH,cb.cbStyle,cb.transform);
  printf("[parse] Kmax=%u guard=%u exp=%u | missingMsbs=%u numPasses=%u len0=%u len1=%u cbBytes=%zu\n",
         cb.Kmax,cb.guardBits,cb.exponent,cb.missingMsbs,cb.numPasses,cb.passLen0,cb.passLen1,cb.coded.size()-8);

  // oracle
  u32 W,H; std::vector<i32> oracle;
  if (!loadCoeff(coeffPath,W,H,oracle)){ fprintf(stderr,"load coeff failed\n"); return 2; }
  if (W!=cb.W||H!=cb.H){ fprintf(stderr,"dim mismatch coeff\n"); return 2; }

  int rc=0;
  u32 stride = cb.W;

  // ---- CPU reference (OpenJPH scalar) ----
  {
    std::vector<u32> dec((size_t)stride*cb.H, 0);
    bool ok = ojph::local::ojph_decode_codeblock32(cb.coded.data(), dec.data(),
                 cb.missingMsbs, cb.numPasses, cb.passLen0, cb.passLen1,
                 cb.W, cb.H, stride, false);
    if (!ok){ printf("[CPU ] decoder returned false\n"); rc=1; }
    else {
      std::vector<i32> coeff((size_t)stride*cb.H, 0);
      // dequant per row (respect stride)
      for (u32 y=0;y<cb.H;y++)
        dequantRev(dec.data()+ (size_t)y*stride, coeff.data()+(size_t)y*stride, cb.Kmax, cb.W);
      int fx,fy; i32 ev,gv;
      u32 nd=compare(oracle, coeff.data(), cb.W, cb.H, stride, &fx,&fy,&ev,&gv);
      if (nd==0) printf("[CPU ] PASS  (bit-exact vs oracle)\n");
      else { printf("[CPU ] FAIL  %u diffs; first @(%d,%d) exp=%d got=%d\n",nd,fx,fy,ev,gv); rc=1; }
    }
  }

  // ---- Metal GPU CUP decode ----
  {
    std::vector<u32> mag; std::string me;
    bool ok = runMetal(mslPath, cb, mag, me);
    if (!ok){ printf("[GPU ] SKIP/FAIL: %s\n", me.c_str()); rc=1; }
    else {
      std::vector<i32> coeff((size_t)cb.W*cb.H,0);
      dequantRev(mag.data(), coeff.data(), cb.Kmax, cb.W*cb.H);
      int fx,fy; i32 ev,gv;
      u32 nd=compare(oracle, coeff.data(), cb.W, cb.H, cb.W, &fx,&fy,&ev,&gv);
      if (nd==0) printf("[GPU ] PASS  (bit-exact vs oracle)\n");
      else { printf("[GPU ] FAIL  %u diffs; first @(%d,%d) exp=%d got=%d\n",nd,fx,fy,ev,gv); rc=1; }
    }
  }
  return rc;
}
