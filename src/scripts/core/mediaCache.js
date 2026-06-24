// PostFlowX shared media cache
// Reuses File reads + blob URLs across tabs to reduce reload/relink cost.

const __pfxFilePromiseByHandle = new WeakMap();
const __pfxFileByHandle = new WeakMap();
const __pfxUrlBySig = new Map();
const __pfxSigByUrl = new Map();
const __pfxRefBySig = new Map();
const __pfxLastUsedBySig = new Map();
const __PFX_MAX_URLS = 48;

export function pfxFileSig(file){
  try{
    if (!file) return '';
    const name = String(file.name || '');
    const size = Number(file.size) || 0;
    const lm = Number(file.lastModified) || 0;
    const type = String(file.type || '');
    return `${name}::${size}::${lm}::${type}`;
  }catch{ return ''; }
}

function __pfxTouch(sig){
  try{ if (sig) __pfxLastUsedBySig.set(sig, Date.now()); }catch{}
}

function __pfxEvict(){
  try{
    if (__pfxUrlBySig.size <= __PFX_MAX_URLS) return;
    const rows = Array.from(__pfxLastUsedBySig.entries()).sort((a,b)=>(Number(a[1])||0) - (Number(b[1])||0));
    for (const [sig] of rows){
      const refs = Number(__pfxRefBySig.get(sig)) || 0;
      if (refs > 0) continue;
      const url = __pfxUrlBySig.get(sig);
      if (url){ try{ URL.revokeObjectURL(url); }catch{} }
      __pfxUrlBySig.delete(sig);
      if (url) __pfxSigByUrl.delete(url);
      __pfxRefBySig.delete(sig);
      __pfxLastUsedBySig.delete(sig);
      if (__pfxUrlBySig.size <= __PFX_MAX_URLS) break;
    }
  }catch{}
}

export async function pfxGetHandleFile(handle, opts = {}){
  try{
    if (!handle || typeof handle.getFile !== 'function') return null;
    const force = !!opts.force;
    if (!force){
      const cached = __pfxFileByHandle.get(handle);
      if (cached) return cached;
      const pending = __pfxFilePromiseByHandle.get(handle);
      if (pending) return await pending;
    }
    const p = Promise.resolve().then(() => handle.getFile()).then((file) => {
      __pfxFilePromiseByHandle.delete(handle);
      if (file) __pfxFileByHandle.set(handle, file);
      return file || null;
    }).catch((err) => {
      __pfxFilePromiseByHandle.delete(handle);
      throw err;
    });
    __pfxFilePromiseByHandle.set(handle, p);
    return await p;
  }catch{ return null; }
}

export function pfxAcquireObjectUrl(file){
  try{
    if (!file) return '';
    const sig = pfxFileSig(file);
    if (!sig) return '';
    let url = __pfxUrlBySig.get(sig) || '';
    if (!url){
      url = URL.createObjectURL(file);
      __pfxUrlBySig.set(sig, url);
      __pfxSigByUrl.set(url, sig);
      __pfxRefBySig.set(sig, 0);
    }
    __pfxRefBySig.set(sig, (Number(__pfxRefBySig.get(sig)) || 0) + 1);
    __pfxTouch(sig);
    __pfxEvict();
    return url;
  }catch{ return ''; }
}

export function pfxReleaseObjectUrl(url){
  try{
    const u = String(url || '');
    if (!u) return;
    const sig = __pfxSigByUrl.get(u);
    if (!sig){
      try{ URL.revokeObjectURL(u); }catch{}
      return;
    }
    const next = Math.max(0, (Number(__pfxRefBySig.get(sig)) || 0) - 1);
    __pfxRefBySig.set(sig, next);
    __pfxTouch(sig);
    if (next === 0 && __pfxUrlBySig.size > __PFX_MAX_URLS){
      const live = __pfxUrlBySig.get(sig);
      if (live){ try{ URL.revokeObjectURL(live); }catch{} }
      __pfxUrlBySig.delete(sig);
      if (live) __pfxSigByUrl.delete(live);
      __pfxRefBySig.delete(sig);
      __pfxLastUsedBySig.delete(sig);
    }
  }catch{}
}

export function pfxPeekObjectUrl(file){
  try{
    const sig = pfxFileSig(file);
    if (!sig) return '';
    const url = __pfxUrlBySig.get(sig) || '';
    if (url) __pfxTouch(sig);
    return url;
  }catch{ return ''; }
}

export function pfxClearMediaCache(){
  try{
    for (const url of __pfxUrlBySig.values()){
      try{ URL.revokeObjectURL(url); }catch{}
    }
  }catch{}
  __pfxUrlBySig.clear();
  __pfxSigByUrl.clear();
  __pfxRefBySig.clear();
  __pfxLastUsedBySig.clear();
}
