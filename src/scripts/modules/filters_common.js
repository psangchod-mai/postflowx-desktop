export function tc(x, fps=24){
  const s = String(x||"");
  const m = s.match(/^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/);
  if(m) return s;
  if(/^\-?\d+\/\d+s$/.test(s)){
    const [num, den] = s.replace('s','').split('/').map(n=>parseInt(n,10));
    if (den === 0) return "00:00:00:00";
    const fr = Math.round(num/den * fps);
    const hh = String(Math.floor(fr/(fps*3600))).padStart(2,'0');
    const mm = String(Math.floor((fr%(fps*3600))/(fps*60))).padStart(2,'0');
    const ss = String(Math.floor((fr% (fps*60))/fps)).padStart(2,'0');
    const ff = String(fr % fps).padStart(2,'0');
    return `${hh}:${mm}:${ss}:${ff}`;
  }
  const m2 = s.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if(m2) return `${m2[1]}:${m2[2]}:${m2[3]}:00`;
  return "00:00:00:00";
}
export function stemNoExt(path=""){
  const s = String(path||""); const i = s.lastIndexOf(".");
  return i>0 ? s.slice(0,i) : s;
}