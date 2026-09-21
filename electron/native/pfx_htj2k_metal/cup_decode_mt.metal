// cup_decode_mt.metal — MILESTONE 2 parallel HTJ2K CUP block decoder.
// One THREADGROUP per codeblock; MANY threadgroups dispatched at once (one per
// codeblock in the whole frame) => genuinely parallel across codeblocks on the
// GPU. Within a codeblock the CUP decode (MEL+VLC+UVLC, then MagSgn) runs in
// thread 0 (the serial HT scan). This is the verified M1 CUP algorithm, made
// per-codeblock via a descriptor array + a single concatenated coded buffer
// (each codeblock is laid out as [PREFIX zero bytes][coded][pad], and `base`
// points at its coded[0]).

#include <metal_stdlib>
using namespace metal;
#define PREFIX 16

struct Desc { uint base, len0, missingMsbs, numPasses, W, H, outBase, stride; };

static inline uint RB(device const uchar* C, int base, int i) { return (uint)C[base + i]; }
static inline uint RL32(device const uchar* C, int base, int i) {
  return RB(C,base,i) | (RB(C,base,i+1)<<8) | (RB(C,base,i+2)<<16) | (RB(C,base,i+3)<<24);
}

struct MelSt { int dataIdx; ulong tmp; int bits; int size; bool unstuff; int k; int num_runs; ulong runs; };
static void mel_read(thread MelSt& m, device const uchar* C, int base) {
  if (m.bits > 32) return;
  uint val = 0xFFFFFFFFu;
  if (m.size > 4) { val = RL32(C,base,m.dataIdx); m.dataIdx += 4; m.size -= 4; }
  else if (m.size > 0) {
    int i = 0;
    while (m.size > 1) { uint v = RB(C,base,m.dataIdx++); uint mm=~(0xFFu<<i); val=(val&mm)|(v<<i); --m.size; i+=8; }
    uint v = RB(C,base,m.dataIdx++); v |= 0xF; uint mm=~(0xFFu<<i); val=(val&mm)|(v<<i); --m.size;
  }
  int bits = 32 - (m.unstuff?1:0);
  uint t = val & 0xFF; bool u=((val&0xFF)==0xFF); bits-=u?1:0; t=t<<(8-(u?1:0));
  t |= (val>>8)&0xFF; u=(((val>>8)&0xFF)==0xFF); bits-=u?1:0; t=t<<(8-(u?1:0));
  t |= (val>>16)&0xFF; u=(((val>>16)&0xFF)==0xFF); bits-=u?1:0; t=t<<(8-(u?1:0));
  t |= (val>>24)&0xFF; m.unstuff=(((val>>24)&0xFF)==0xFF);
  m.tmp |= ((ulong)t) << (64 - bits - m.bits); m.bits += bits;
}
static void mel_decode(thread MelSt& m, device const uchar* C, int base) {
  const int mel_exp[13] = {0,0,0,1,1,1,2,2,2,3,3,4,5};
  if (m.bits < 6) mel_read(m,C,base);
  while (m.bits >= 6 && m.num_runs < 8) {
    int eval = mel_exp[m.k]; int run = 0;
    if (m.tmp & (1ul<<63)) { run=1<<eval; run--; m.k=(m.k+1<12)?m.k+1:12; m.tmp<<=1; m.bits-=1; run=run<<1; }
    else { run=(int)(m.tmp>>(63-eval))&((1<<eval)-1); m.k=(m.k-1>0)?m.k-1:0; m.tmp<<=(eval+1); m.bits-=eval+1; run=(run<<1)+1; }
    eval = m.num_runs*7; m.runs &= ~((ulong)0x3F<<eval); m.runs |= ((ulong)run)<<eval; m.num_runs++;
  }
}
static void mel_init(thread MelSt& m, device const uchar* C, int base, int lcup, int scup) {
  m.dataIdx=lcup-scup; m.bits=0; m.tmp=0; m.unstuff=false; m.size=scup-1; m.k=0; m.num_runs=0; m.runs=0;
  int num = 4 - (m.dataIdx & 3);
  for (int i=0;i<num;++i){ ulong d=(m.size>0)?(ulong)RB(C,base,m.dataIdx):0xFFul; if(m.size==1) d|=0xF; if(m.size>0) m.dataIdx++; m.size--;
    int db=8-(m.unstuff?1:0); m.tmp=(m.tmp<<db)|d; m.bits+=db; m.unstuff=((d&0xFF)==0xFF); }
  m.tmp <<= (64 - m.bits);
}
static int mel_get_run(thread MelSt& m, device const uchar* C, int base) {
  if (m.num_runs==0) mel_decode(m,C,base);
  int t=(int)(m.runs&0x7F); m.runs>>=7; m.num_runs--; return t;
}

struct RevSt { int dataIdx; ulong tmp; uint bits; int size; bool unstuff; };
static void rev_read(thread RevSt& v, device const uchar* C, int base) {
  if (v.bits > 32) return;
  uint val=0;
  if (v.size>3){ val=RL32(C,base,v.dataIdx-3); v.dataIdx-=4; v.size-=4; }
  else if (v.size>0){ int i=24; while(v.size>0){ uint vv=RB(C,base,v.dataIdx--); val|=(vv<<i); --v.size; i-=8; } }
  uint tmp=val>>24; uint bits=8-((v.unstuff&&(((val>>24)&0x7F)==0x7F))?1:0); bool u=(val>>24)>0x8F;
  tmp|=((val>>16)&0xFF)<<bits; bits+=8-((u&&(((val>>16)&0x7F)==0x7F))?1:0); u=((val>>16)&0xFF)>0x8F;
  tmp|=((val>>8)&0xFF)<<bits; bits+=8-((u&&(((val>>8)&0x7F)==0x7F))?1:0); u=((val>>8)&0xFF)>0x8F;
  tmp|=(val&0xFF)<<bits; bits+=8-((u&&((val&0x7F)==0x7F))?1:0); u=(val&0xFF)>0x8F;
  v.tmp|=(ulong)tmp<<v.bits; v.bits+=bits; v.unstuff=u;
}
static void rev_init(thread RevSt& v, device const uchar* C, int base, int lcup, int scup) {
  v.dataIdx=lcup-2; v.size=scup-2; uint d=RB(C,base,v.dataIdx--); v.tmp=d>>4; v.bits=4-(((v.tmp&7)==7)?1:0); v.unstuff=(d|0xF)>0x8F;
  int num=1+(v.dataIdx&3); int tnum=num<v.size?num:v.size;
  for (int i=0;i<tnum;++i){ ulong dd=RB(C,base,v.dataIdx--); uint db=8-((v.unstuff&&((dd&0x7F)==0x7F))?1:0); v.tmp|=dd<<v.bits; v.bits+=db; v.unstuff=dd>0x8F; }
  v.size-=tnum; rev_read(v,C,base);
}
static uint rev_fetch(thread RevSt& v, device const uchar* C, int base){ if(v.bits<32){ rev_read(v,C,base); if(v.bits<32) rev_read(v,C,base);} return (uint)v.tmp; }
static uint rev_advance(thread RevSt& v, uint nb){ v.tmp>>=nb; v.bits-=nb; return (uint)v.tmp; }

struct FrwdSt { int dataIdx; ulong tmp; uint bits; uint unstuff; int size; };
static void frwd_read(thread FrwdSt& s, device const uchar* C, int base) {
  uint val=0;
  if (s.size>3){ val=RL32(C,base,s.dataIdx); s.dataIdx+=4; s.size-=4; }
  else if (s.size>0){ int i=0; val=0xFFFFFFFFu; while(s.size>0){ uint v=RB(C,base,s.dataIdx++); uint m=~(0xFFu<<i); val=(val&m)|(v<<i); --s.size; i+=8; } }
  else val=0xFFFFFFFFu;
  uint bits=8-s.unstuff; uint t=val&0xFF; bool u=((val&0xFF)==0xFF);
  t|=((val>>8)&0xFF)<<bits; bits+=8-(u?1:0); u=(((val>>8)&0xFF)==0xFF);
  t|=((val>>16)&0xFF)<<bits; bits+=8-(u?1:0); u=(((val>>16)&0xFF)==0xFF);
  t|=((val>>24)&0xFF)<<bits; bits+=8-(u?1:0); s.unstuff=(((val>>24)&0xFF)==0xFF)?1u:0u;
  s.tmp|=((ulong)t)<<s.bits; s.bits+=bits;
}
static void frwd_init(thread FrwdSt& s, device const uchar* C, int base, int idx, int size) {
  s.dataIdx=idx; s.tmp=0; s.bits=0; s.unstuff=0; s.size=size;
  int num=4-(idx&3);
  for (int i=0;i<num;++i){ ulong d=(s.size-->0)?(ulong)RB(C,base,s.dataIdx++):0xFFul; s.tmp|=(d<<s.bits); s.bits+=8-s.unstuff; s.unstuff=((d&0xFF)==0xFF)?1u:0u; }
  frwd_read(s,C,base);
}
static void frwd_advance(thread FrwdSt& s, uint nb){ s.tmp>>=nb; s.bits-=nb; }
static uint frwd_fetch(thread FrwdSt& s, device const uchar* C, int base){ if(s.bits<32){ frwd_read(s,C,base); if(s.bits<32) frwd_read(s,C,base);} return (uint)s.tmp; }

// One threadgroup per codeblock. thread 0 decodes the whole CUP block.
kernel void kCUP_mt(device const uchar* C          [[buffer(0)]],
                    device const Desc*  descs      [[buffer(1)]],
                    device uint*        out        [[buffer(2)]],
                    device const ushort* vlc_tbl0  [[buffer(3)]],
                    device const ushort* vlc_tbl1  [[buffer(4)]],
                    device const ushort* uvlc_tbl0 [[buffer(5)]],
                    device const ushort* uvlc_tbl1 [[buffer(6)]],
                    uint tgid [[threadgroup_position_in_grid]],
                    uint lid  [[thread_position_in_threadgroup]])
{
  threadgroup ushort scratch[8*513];
  threadgroup uint   v_n_scratch[512+4];
  if (lid != 0) return;

  Desc D = descs[tgid];
  int base = (int)D.base;
  uint width=D.W, height=D.H, stride=D.stride;
  uint missing_msbs=D.missingMsbs;
  int lcup=(int)D.len0;
  if (lcup < 2) return;
  int scup=(((int)RB(C,base,lcup-1))<<4)+((int)RB(C,base,lcup-2)&0xF);
  uint p=30-missing_msbs; uint mmsbp2=missing_msbs+2;
  uint sstr=((width+2u)+7u)&~7u;
  uint obase=D.outBase;

  for (uint i=0;i<8u*513u;++i) scratch[i]=0;
  for (uint i=0;i<512u+4u;++i) v_n_scratch[i]=0;
  for (uint i=0;i<width*height;++i) out[obase+i]=0;

  // ---- step 1 ----
  {
    MelSt mel; mel_init(mel,C,base,lcup,scup);
    RevSt vlc; rev_init(vlc,C,base,lcup,scup);
    int run=mel_get_run(mel,C,base);
    uint vlc_val, c_q=0; int sp=0;
    for (uint x=0;x<width; sp+=4){
      vlc_val=rev_fetch(vlc,C,base); uint t0=vlc_tbl0[c_q+(vlc_val&0x7F)];
      if (c_q==0){ run-=2; t0=(run==-1)?t0:0; if(run<0) run=mel_get_run(mel,C,base); }
      scratch[sp+0]=(ushort)t0; x+=2;
      c_q=((t0&0x10u)<<3)|((t0&0xE0u)<<2); vlc_val=rev_advance(vlc,t0&0x7);
      uint t1=vlc_tbl0[c_q+(vlc_val&0x7F)];
      if (c_q==0 && x<width){ run-=2; t1=(run==-1)?t1:0; if(run<0) run=mel_get_run(mel,C,base); }
      t1 = x<width?t1:0; scratch[sp+2]=(ushort)t1; x+=2;
      c_q=((t1&0x10u)<<3)|((t1&0xE0u)<<2); vlc_val=rev_advance(vlc,t1&0x7);
      uint uvlc_mode=((t0&0x8u)<<3)|((t1&0x8u)<<4);
      if (uvlc_mode==0xc0){ run-=2; uvlc_mode+=(run==-1)?0x40:0; if(run<0) run=mel_get_run(mel,C,base); }
      uint ue=uvlc_tbl0[uvlc_mode+(vlc_val&0x3F)]; vlc_val=rev_advance(vlc,ue&0x7); ue>>=3;
      uint len=ue&0xF; uint tmp=vlc_val&((1u<<len)-1); vlc_val=rev_advance(vlc,len); ue>>=4;
      len=ue&0x7; ue>>=3; uint u_q=1+(ue&7)+(tmp&~(0xFFu<<len)); scratch[sp+1]=(ushort)u_q;
      u_q=1+(ue>>3)+(tmp>>len); scratch[sp+3]=(ushort)u_q;
    }
    scratch[sp+0]=0; scratch[sp+1]=0;
    for (uint y=2;y<height;y+=2){
      c_q=0; sp=(int)((y>>1)*sstr);
      for (uint x=0;x<width; sp+=4){
        c_q|=((scratch[sp+0-(int)sstr]&0xA0u)<<2); c_q|=((scratch[sp+2-(int)sstr]&0x20u)<<4);
        vlc_val=rev_fetch(vlc,C,base); uint t0=vlc_tbl1[c_q+(vlc_val&0x7F)];
        if (c_q==0){ run-=2; t0=(run==-1)?t0:0; if(run<0) run=mel_get_run(mel,C,base); }
        scratch[sp+0]=(ushort)t0; x+=2;
        c_q=((t0&0x40u)<<2)|((t0&0x80u)<<1); c_q|=scratch[sp+0-(int)sstr]&0x80;
        c_q|=((scratch[sp+2-(int)sstr]&0xA0u)<<2); c_q|=((scratch[sp+4-(int)sstr]&0x20u)<<4);
        vlc_val=rev_advance(vlc,t0&0x7);
        uint t1=vlc_tbl1[c_q+(vlc_val&0x7F)];
        if (c_q==0 && x<width){ run-=2; t1=(run==-1)?t1:0; if(run<0) run=mel_get_run(mel,C,base); }
        t1=x<width?t1:0; scratch[sp+2]=(ushort)t1; x+=2;
        c_q=((t1&0x40u)<<2)|((t1&0x80u)<<1); c_q|=scratch[sp+2-(int)sstr]&0x80;
        vlc_val=rev_advance(vlc,t1&0x7);
        uint uvlc_mode=((t0&0x8u)<<3)|((t1&0x8u)<<4);
        uint ue=uvlc_tbl1[uvlc_mode+(vlc_val&0x3F)]; vlc_val=rev_advance(vlc,ue&0x7); ue>>=3;
        uint len=ue&0xF; uint tmp=vlc_val&((1u<<len)-1); vlc_val=rev_advance(vlc,len); ue>>=4;
        len=ue&0x7; ue>>=3; uint u_q=(ue&7)+(tmp&~(0xFFu<<len)); scratch[sp+1]=(ushort)u_q;
        u_q=(ue>>3)+(tmp>>len); scratch[sp+3]=(ushort)u_q;
      }
      scratch[sp+0]=0; scratch[sp+1]=0;
    }
  }

  // ---- step 2 ----
  {
    FrwdSt magsgn; frwd_init(magsgn,C,base,0,lcup-scup);
    { int sp=0,vp=0,dp=0; uint prev_v_n=0;
      for (uint x=0;x<width; sp+=2,++vp){
        uint inf=scratch[sp+0]; uint U_q=scratch[sp+1]; if(U_q>mmsbp2) return;
        uint v_n; uint val=0; uint bit=0;
        if (inf&(1u<<(4+bit))){ uint ms=frwd_fetch(magsgn,C,base); uint m_n=U_q-((inf>>(12+bit))&1); frwd_advance(magsgn,m_n);
          val=ms<<31; v_n=ms&((1u<<m_n)-1); v_n|=((inf>>(8+bit))&1)<<m_n; v_n|=1; val|=(v_n+2)<<(p-1); }
        out[obase+dp+0]=val;
        v_n=0; val=0; bit=1;
        if (inf&(1u<<(4+bit))){ uint ms=frwd_fetch(magsgn,C,base); uint m_n=U_q-((inf>>(12+bit))&1); frwd_advance(magsgn,m_n);
          val=ms<<31; v_n=ms&((1u<<m_n)-1); v_n|=((inf>>(8+bit))&1)<<m_n; v_n|=1; val|=(v_n+2)<<(p-1); }
        out[obase+dp+stride]=val; v_n_scratch[vp]=prev_v_n|v_n; prev_v_n=0; ++dp;
        if (++x>=width){ ++vp; break; }
        val=0; bit=2;
        if (inf&(1u<<(4+bit))){ uint ms=frwd_fetch(magsgn,C,base); uint m_n=U_q-((inf>>(12+bit))&1); frwd_advance(magsgn,m_n);
          val=ms<<31; v_n=ms&((1u<<m_n)-1); v_n|=((inf>>(8+bit))&1)<<m_n; v_n|=1; val|=(v_n+2)<<(p-1); }
        out[obase+dp+0]=val;
        v_n=0; val=0; bit=3;
        if (inf&(1u<<(4+bit))){ uint ms=frwd_fetch(magsgn,C,base); uint m_n=U_q-((inf>>(12+bit))&1); frwd_advance(magsgn,m_n);
          val=ms<<31; v_n=ms&((1u<<m_n)-1); v_n|=((inf>>(8+bit))&1)<<m_n; v_n|=1; val|=(v_n+2)<<(p-1); }
        out[obase+dp+stride]=val; prev_v_n=v_n; ++dp; ++x;
      }
      v_n_scratch[vp]=prev_v_n;
    }
    for (uint y=2;y<height;y+=2){
      int sp=(int)((y>>1)*sstr); int vp=0; int dp=(int)(y*stride); uint prev_v_n=0;
      for (uint x=0;x<width; sp+=2,++vp){
        uint inf=scratch[sp+0]; uint u_q=scratch[sp+1];
        uint gamma=inf&0xF0; gamma&=gamma-0x10; uint emax=v_n_scratch[vp]|v_n_scratch[vp+1]; emax=31-clz(emax|2);
        uint kappa=gamma?emax:1; uint U_q=u_q+kappa; if(U_q>mmsbp2) return;
        uint v_n; uint val=0; uint bit=0;
        if (inf&(1u<<(4+bit))){ uint ms=frwd_fetch(magsgn,C,base); uint m_n=U_q-((inf>>(12+bit))&1); frwd_advance(magsgn,m_n);
          val=ms<<31; v_n=ms&((1u<<m_n)-1); v_n|=((inf>>(8+bit))&1)<<m_n; v_n|=1; val|=(v_n+2)<<(p-1); }
        out[obase+dp+0]=val;
        v_n=0; val=0; bit=1;
        if (inf&(1u<<(4+bit))){ uint ms=frwd_fetch(magsgn,C,base); uint m_n=U_q-((inf>>(12+bit))&1); frwd_advance(magsgn,m_n);
          val=ms<<31; v_n=ms&((1u<<m_n)-1); v_n|=((inf>>(8+bit))&1)<<m_n; v_n|=1; val|=(v_n+2)<<(p-1); }
        out[obase+dp+stride]=val; v_n_scratch[vp]=prev_v_n|v_n; prev_v_n=0; ++dp;
        if (++x>=width){ ++vp; break; }
        val=0; bit=2;
        if (inf&(1u<<(4+bit))){ uint ms=frwd_fetch(magsgn,C,base); uint m_n=U_q-((inf>>(12+bit))&1); frwd_advance(magsgn,m_n);
          val=ms<<31; v_n=ms&((1u<<m_n)-1); v_n|=((inf>>(8+bit))&1)<<m_n; v_n|=1; val|=(v_n+2)<<(p-1); }
        out[obase+dp+0]=val;
        v_n=0; val=0; bit=3;
        if (inf&(1u<<(4+bit))){ uint ms=frwd_fetch(magsgn,C,base); uint m_n=U_q-((inf>>(12+bit))&1); frwd_advance(magsgn,m_n);
          val=ms<<31; v_n=ms&((1u<<m_n)-1); v_n|=((inf>>(8+bit))&1)<<m_n; v_n|=1; val|=(v_n+2)<<(p-1); }
        out[obase+dp+stride]=val; prev_v_n=v_n; ++dp; ++x;
      }
      v_n_scratch[vp]=prev_v_n;
    }
  }
}

// ---- on-GPU dequant + scatter: sign-mag decode output -> per-subband coeffs ----
// One threadgroup per codeblock (parallel over the frame). Keeps coefficients
// resident on the GPU (no GPU->CPU->GPU round-trip before the IDWT).
struct ScatterDesc { uint outBase, sbOffset, substride, x0, y0, w, h, kmax; float delta; uint reversible; };
kernel void kScatter(device const uint* dec         [[buffer(0)]],
                     device const ScatterDesc* descs [[buffer(1)]],
                     device uint* sb                [[buffer(2)]],
                     uint tgid [[threadgroup_position_in_grid]],
                     uint lid  [[thread_position_in_threadgroup]],
                     uint tgsize [[threads_per_threadgroup]]) {
  ScatterDesc D = descs[tgid];
  uint n = D.w*D.h;
  for (uint i=lid; i<n; i+=tgsize){
    uint yy=i/D.w, xx=i-yy*D.w;
    uint v = dec[D.outBase + i];              // decode wrote with stride = w
    uint outv;
    if (D.reversible){ int mag=(int)((v&0x7FFFFFFFu) >> (31-D.kmax)); int val=(v&0x80000000u)? -mag:mag; outv=as_type<uint>(val); }
    else { float mag=(float)(v&0x7FFFFFFFu)*D.delta; float val=(v&0x80000000u)? -mag:mag; outv=as_type<uint>(val); }
    sb[D.sbOffset + (D.y0+yy)*D.substride + (D.x0+xx)] = outv;
  }
}
