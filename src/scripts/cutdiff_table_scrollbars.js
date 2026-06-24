/*
  Cut Diff Event Table overlay scrollbars (vertical + horizontal)
  - Always visible (like vis-timeline)
  - Mirrors scroll position of #cutdiffTableWrapper
  - Drag thumb to scroll

  CSS classes:
    .mps-cd-vscroll .mps-cd-vthumb
    .mps-cd-hscroll .mps-cd-hthumb
*/

(function(){
  function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

  function ensure(parent, id, cls){
    let el = document.getElementById(id);
    if(!el){
      el = document.createElement('div');
      el.id = id;
      if(cls) el.className = cls;
      parent.appendChild(el);
    }
    return el;
  }

  function init(){
    const scroller = document.getElementById('cutdiffTableWrapper');
    if(!scroller) return;

    const container = scroller; // position:relative (already)

    const vScroll = ensure(container, 'cutdiffTableVScroll', 'mps-cd-vscroll');
    const vThumb  = ensure(vScroll,  'cutdiffTableVThumb',  'mps-cd-vthumb');

    const hScroll = ensure(container, 'cutdiffTableHScroll', 'mps-cd-hscroll');
    const hThumb  = ensure(hScroll,  'cutdiffTableHThumb',  'mps-cd-hthumb');

    function sync(){
      // Vertical
      const ch = scroller.clientHeight;
      const sh = scroller.scrollHeight;
      const st = scroller.scrollTop;
      const trackH = vScroll.clientHeight;
      const needsV = sh > ch + 1;
      vScroll.style.display = needsV ? 'block' : 'none';
      if(needsV){
        const thumbH = clamp(Math.round((ch / sh) * trackH), 28, trackH);
        const maxTop = Math.max(0, trackH - thumbH);
        const top = (st / Math.max(1, (sh - ch))) * maxTop;
        vThumb.style.height = thumbH + 'px';
        vThumb.style.top = Math.round(top) + 'px';
      }

      // Horizontal
      const cw = scroller.clientWidth;
      const sw = scroller.scrollWidth;
      const sl = scroller.scrollLeft;
      const trackW = hScroll.clientWidth;
      const needsH = sw > cw + 1;
      hScroll.style.display = needsH ? 'block' : 'none';
      if(needsH){
        const thumbW = clamp(Math.round((cw / sw) * trackW), 32, trackW);
        const maxLeft = Math.max(0, trackW - thumbW);
        const left = (sl / Math.max(1, (sw - cw))) * maxLeft;
        hThumb.style.width = thumbW + 'px';
        hThumb.style.left = Math.round(left) + 'px';
      }
    }

    let draggingV = false;
    let dragStartY = 0;
    let dragStartTop = 0;

    vThumb.addEventListener('mousedown', (e)=>{
      draggingV = true;
      dragStartY = e.clientY;
      dragStartTop = parseInt(vThumb.style.top || '0', 10);
      e.preventDefault();
      e.stopPropagation();
    });

    let draggingH = false;
    let dragStartX = 0;
    let dragStartLeft = 0;

    hThumb.addEventListener('mousedown', (e)=>{
      draggingH = true;
      dragStartX = e.clientX;
      dragStartLeft = parseInt(hThumb.style.left || '0', 10);
      e.preventDefault();
      e.stopPropagation();
    });

    window.addEventListener('mousemove', (e)=>{
      if(draggingV){
        const trackH = vScroll.clientHeight;
        const thumbH = vThumb.offsetHeight;
        const maxTop = Math.max(0, trackH - thumbH);
        const nextTop = clamp(dragStartTop + (e.clientY - dragStartY), 0, maxTop);
        const sh = scroller.scrollHeight;
        const ch = scroller.clientHeight;
        scroller.scrollTop = (nextTop / Math.max(1, maxTop)) * Math.max(0, (sh - ch));
      }
      if(draggingH){
        const trackW = hScroll.clientWidth;
        const thumbW = hThumb.offsetWidth;
        const maxLeft = Math.max(0, trackW - thumbW);
        const nextLeft = clamp(dragStartLeft + (e.clientX - dragStartX), 0, maxLeft);
        const sw = scroller.scrollWidth;
        const cw = scroller.clientWidth;
        scroller.scrollLeft = (nextLeft / Math.max(1, maxLeft)) * Math.max(0, (sw - cw));
      }
    });

    window.addEventListener('mouseup', ()=>{
      draggingV = false;
      draggingH = false;
    });

    // Click track to jump
    vScroll.addEventListener('mousedown', (e)=>{
      if(e.target === vThumb) return;
      const rect = vScroll.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const thumbH = vThumb.offsetHeight;
      const trackH = vScroll.clientHeight;
      const maxTop = Math.max(0, trackH - thumbH);
      const nextTop = clamp(y - thumbH/2, 0, maxTop);
      const sh = scroller.scrollHeight;
      const ch = scroller.clientHeight;
      scroller.scrollTop = (nextTop / Math.max(1, maxTop)) * Math.max(0, (sh - ch));
    });
    hScroll.addEventListener('mousedown', (e)=>{
      if(e.target === hThumb) return;
      const rect = hScroll.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const thumbW = hThumb.offsetWidth;
      const trackW = hScroll.clientWidth;
      const maxLeft = Math.max(0, trackW - thumbW);
      const nextLeft = clamp(x - thumbW/2, 0, maxLeft);
      const sw = scroller.scrollWidth;
      const cw = scroller.clientWidth;
      scroller.scrollLeft = (nextLeft / Math.max(1, maxLeft)) * Math.max(0, (sw - cw));
    });

    scroller.addEventListener('scroll', sync, {passive:true});
    window.addEventListener('resize', sync);

    // Initial + after table renders
    sync();
    setTimeout(sync, 0);
    setTimeout(sync, 150);
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
