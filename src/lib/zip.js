// lib/zip.js — tiny ZIP reader using DecompressionStream
//
// Notes:
// - We keep this intentionally small.
// - For large ZIP “bundle” formats (.fcpxmld/.xmld), callers should prefer `unzipOne()`
//   to avoid inflating huge resource folders.

export function strFromU8(u8){ return new TextDecoder().decode(u8); }

function dv(u8){ return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
function U32(d,o){ return d.getUint32(o,true); }
function U16(d,o){ return d.getUint16(o,true); }

async function inflateRawMaybe(u8){
  if (typeof DecompressionStream !== 'function') throw new Error('DecompressionStream not available');

  // ZIP DEFLATE payloads are usually raw-deflate, but some exporters can be inconsistent.
  // Try deflate-raw first, then fall back to deflate.
  try{
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    const ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }catch(err){
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    const ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }
}

function findEOCD(d, u8len){
  const SIG_EOCD=0x06054b50;
  let eocd=-1; const tail=Math.max(0, u8len-66000);
  for(let i=u8len-22;i>=tail;i--){
    if(U32(d,i)===SIG_EOCD){ eocd=i; break; }
  }
  return eocd;
}

function iterCentralDirectory(d, u8, cb){
  const SIG_CD=0x02014b50;
  const eocd = findEOCD(d, u8.length);
  if(eocd<0) throw new Error('ZIP EOCD not found');

  const cdsz=U32(d,eocd+12), cdoff=U32(d,eocd+16);
  let p=cdoff;
  while(p < cdoff+cdsz){
    if(U32(d,p)!==SIG_CD) break;

    const comp=U16(d,p+10);
    const csize=U32(d,p+20);
    const usize=U32(d,p+24);
    const nlen=U16(d,p+28);
    const xlen=U16(d,p+30);
    const clen=U16(d,p+32);
    const lhoff=U32(d,p+42);

    const name=strFromU8(u8.slice(p+46, p+46+nlen));
    const next = p + 46 + nlen + xlen + clen;

    const stop = cb({ name, comp, csize, usize, lhoff, cdOffset:p });
    if(stop) return;

    p = next;
  }
}

async function readLocalFile(d, u8, entry){
  const SIG_LH=0x04034b50;
  let q=entry.lhoff;
  if(U32(d,q)!==SIG_LH) throw new Error('Bad Local Header');

  const lcomp=U16(d,q+8);
  const ln=U16(d,q+26);
  const lx=U16(d,q+28);
  const csizeLH=U32(d,q+18);

  const start = q + 30 + ln + lx;
  const sizeUse = (csizeLH || entry.csize) >>> 0;
  const compData = u8.slice(start, start + sizeUse);

  if(lcomp===0) return compData;
  if(lcomp===8) return await inflateRawMaybe(compData);

  throw new Error('Unsupported ZIP compression method: '+lcomp);
}

// Return ONLY the first matching file from the ZIP (avoids inflating huge bundles).
// pick(name) should return true for the desired entry.
export async function unzipOne(u8, pick){
  const d = dv(u8);
  let hit = null;
  iterCentralDirectory(d, u8, (e)=>{
    try{
      if(!pick) return false;
      if(pick(e.name)) { hit = e; return true; }
    }catch{}
    return false;
  });
  if(!hit) return null;
  const bytes = await readLocalFile(d, u8, hit);
  return { name: hit.name, bytes };
}

// Inflate all entries (use sparingly; can be heavy on large ZIP bundles)
export async function unzip(u8){
  const d = dv(u8);
  const out = {};
  const entries = [];
  iterCentralDirectory(d, u8, (e)=>{ entries.push(e); return false; });
  for(const e of entries){
    try{
      out[e.name] = await readLocalFile(d, u8, e);
    }catch{
      // skip unsupported entries
    }
  }
  return out;
}
