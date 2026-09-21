// Shot Index + Bin Filters — aggregates shots from all PostFlowX data sources.
// Exposes: window.PFX_buildShotIndex, window.PFX_filterShotIndex, window.PFX_exportShotIndexCSV
(function () {
  'use strict';

  // ── Normalizers ──────────────────────────────────────────────────────────

  function _fromEdl(ev, i) {
    return {
      id: `edl_${i}`,
      source: 'pull_prep',
      shotName:  String(ev.vfxId || ev.shotId || ev.clipName || ev.sourceName || '').trim(),
      clipName:  String(ev.clipName || ev.sourceName || '').trim(),
      reel:      String(ev.reel || ev.reelName || ev.tape || '').trim(),
      camera:    String(ev.camera || ev.camRoll || '').trim(),
      scene:     String(ev.scene || '').trim(),
      take:      String(ev.take || '').trim(),
      recIn:     String(ev.recIn || ev.recordIn || ev.inTimecode || '').trim(),
      recOut:    String(ev.recOut || ev.recordOut || ev.outTimecode || '').trim(),
      srcIn:     String(ev.srcIn || ev.sourceIn || '').trim(),
      srcOut:    String(ev.srcOut || ev.sourceOut || '').trim(),
      duration:  String(ev.duration || '').trim(),
      fps:       Number(ev.fps || ev.frameRate || 0),
      status:    String(ev.status || 'active'),
      qcSeverity: null,
      noteCount:  0,
      hasROI:    false,
      hasMedia:  !!(ev.proxyPath || ev.mediaPath || ev.hasProxy || ev.streamUrl),
      hasTimeline: true,
      tags:      [],
      raw:       ev,
    };
  }

  function _fromMarker(mk, i) {
    return {
      id: `mk_${mk.id || i}`,
      source: 'markers',
      shotName:  String(mk.shotName || mk.name || mk.vfxId || mk.label || '').trim(),
      clipName:  String(mk.clipName || mk.sourceName || '').trim(),
      reel:      String(mk.reel || '').trim(),
      camera:    String(mk.camera || '').trim(),
      scene:     String(mk.scene || '').trim(),
      take:      String(mk.take || '').trim(),
      recIn:     String(mk.tc || mk.timecode || mk.inPoint || mk.startTime || '').trim(),
      recOut:    String(mk.outPoint || mk.endTime || '').trim(),
      srcIn:     '',
      srcOut:    '',
      duration:  String(mk.duration || '').trim(),
      fps:       Number(mk.fps || 0),
      status:    String(mk.status || 'active'),
      qcSeverity: null,
      noteCount:  Number(mk.notes?.length || (mk.note ? 1 : 0)),
      hasROI:    !!(mk.roi || mk.regions?.length),
      hasMedia:  !!(mk.thumbUrl || mk.thumbnailUrl || mk.videoPath),
      hasTimeline: false,
      tags:      Array.isArray(mk.tags) ? mk.tags : [],
      raw:       mk,
    };
  }

  function _fromReview(rv, i) {
    return {
      id: `rv_${rv.id || i}`,
      source: 'review',
      shotName:  String(rv.shotName || rv.name || rv.clipName || '').trim(),
      clipName:  String(rv.clipName || '').trim(),
      reel:      String(rv.reel || '').trim(),
      camera:    '',
      scene:     '',
      take:      '',
      recIn:     String(rv.timecode || rv.tc || rv.startTimecode || '').trim(),
      recOut:    '',
      srcIn:     '',
      srcOut:    '',
      duration:  '',
      fps:       0,
      status:    String(rv.status || 'open'),
      qcSeverity: rv.severity || rv.priority || null,
      noteCount:  Number(rv.notes?.length || rv.noteCount || 1),
      hasROI:    !!(rv.roi || rv.regions?.length || rv.hasROI),
      hasMedia:  !!(rv.thumbnailUrl || rv.frameUrl || rv.thumbDataUrl),
      hasTimeline: false,
      tags:      Array.isArray(rv.tags) ? rv.tags : [],
      raw:       rv,
    };
  }

  function _fromIMF(tr, i) {
    return {
      id: `imf_${i}`,
      source: 'imf',
      shotName:  String(tr.assetTitle || tr.id || tr.clipName || tr.fileName || '').trim(),
      clipName:  String(tr.clipName || tr.fileName || '').trim(),
      reel:      String(tr.reelNumber || tr.reel || '').trim(),
      camera:    '',
      scene:     '',
      take:      '',
      recIn:     String(tr.tcIn || tr.editRateIn || tr.entryPoint || '').trim(),
      recOut:    String(tr.tcOut || tr.editRateOut || '').trim(),
      srcIn:     '',
      srcOut:    '',
      duration:  String(tr.duration || tr.sourceDuration || '').trim(),
      fps:       Number(tr.editRate || tr.frameRate || 0),
      status:    String(tr.validationStatus || tr.status || 'unknown'),
      qcSeverity: tr.severity || null,
      noteCount:  Number(tr.issues?.length || 0),
      hasROI:    false,
      hasMedia:  !!(tr.localPath || tr.mxfPath || tr.proxyPath),
      hasTimeline: true,
      tags:      ['imf'],
      raw:       tr,
    };
  }

  function _fromPlate(pl, i) {
    return {
      id: `pl_${i}`,
      source: 'plate_link',
      shotName:  String(pl.shotName || pl.vfxId || pl.name || '').trim(),
      clipName:  String(pl.clipName || '').trim(),
      reel:      String(pl.reel || '').trim(),
      camera:    String(pl.camera || '').trim(),
      scene:     String(pl.scene || '').trim(),
      take:      String(pl.take || '').trim(),
      recIn:     '',
      recOut:    '',
      srcIn:     '',
      srcOut:    '',
      duration:  '',
      fps:       0,
      status:    String(pl.status || 'active'),
      qcSeverity: null,
      noteCount:  0,
      hasROI:    false,
      hasMedia:  !!(pl.mediaPath || pl.proxyPath || pl.filePath),
      hasTimeline: false,
      tags:      ['plate'],
      raw:       pl,
    };
  }

  function _fromCutDiff(ev, i) {
    return {
      id: `cd_${i}`,
      source: 'cut_diff',
      shotName:  String(ev.shotName || ev.vfxId || ev.clipName || '').trim(),
      clipName:  String(ev.clipName || '').trim(),
      reel:      String(ev.reel || '').trim(),
      camera:    '',
      scene:     '',
      take:      '',
      recIn:     String(ev.recIn || '').trim(),
      recOut:    String(ev.recOut || '').trim(),
      srcIn:     '',
      srcOut:    '',
      duration:  '',
      fps:       0,
      status:    ev.changeType ? 'changed' : 'active',
      qcSeverity: null,
      noteCount:  0,
      hasROI:    false,
      hasMedia:  false,
      hasTimeline: false,
      tags:      [ev.changeType || 'cut_diff'].filter(Boolean),
      raw:       ev,
    };
  }

  // ── Aggregation ──────────────────────────────────────────────────────────

  function PFX_buildShotIndex() {
    const rows = [];
    const seen = new Set();

    function push(r) {
      if (!r || !r.id || seen.has(r.id)) return;
      seen.add(r.id);
      rows.push(r);
    }

    try {
      const edl = window.__MPS_EDL_RAW;
      const evs = edl?.events || edl?.cuts || edl?.shots || (Array.isArray(edl) ? edl : null);
      if (Array.isArray(evs)) evs.forEach((e, i) => push(_fromEdl(e, i)));
    } catch {}

    try {
      const sm = window.__MPS_SM_SNAPSHOT;
      const mks = sm?.markers || sm?.events || sm?.shots || (Array.isArray(sm) ? sm : null);
      if (Array.isArray(mks)) mks.forEach((m, i) => push(_fromMarker(m, i)));
    } catch {}

    try {
      const rv = (typeof window.PFX_exportReviewsState === 'function')
        ? window.PFX_exportReviewsState() : window.__PFX_REVIEWS_STATE;
      const items = rv?.notes || rv?.items || rv?.reviews || rv?.annotations
        || (Array.isArray(rv) ? rv : null);
      if (Array.isArray(items)) items.forEach((r, i) => push(_fromReview(r, i)));
    } catch {}

    try {
      const imf = (typeof window.PFX_exportIMFState === 'function')
        ? window.PFX_exportIMFState() : window.__PFX_IMF_STATE;
      const tks = imf?.tracks || imf?.assets || imf?.trackFiles
        || imf?.cpl?.trackFileList || (Array.isArray(imf) ? imf : null);
      if (Array.isArray(tks)) tks.forEach((t, i) => push(_fromIMF(t, i)));
    } catch {}

    try {
      const amf = window.__MPS_AMF_STATE;
      const shots = amf?.shots || amf?.mappings || amf?.vfxShots || amf?.entries
        || (Array.isArray(amf) ? amf : null);
      if (Array.isArray(shots)) shots.forEach((s, i) => push(_fromPlate(s, i)));
    } catch {}

    try {
      const cd = window.__MPS_CD_SNAPSHOT;
      const evs = cd?.events || cd?.cuts || cd?.changes || (Array.isArray(cd) ? cd : null);
      if (Array.isArray(evs)) evs.forEach((e, i) => push(_fromCutDiff(e, i)));
    } catch {}

    return rows;
  }

  // ── Filtering ────────────────────────────────────────────────────────────

  function _tcSec(tc) {
    if (!tc) return -1;
    const p = String(tc).split(/[:;]/).map(Number);
    if (p.length === 4) return p[0]*3600 + p[1]*60 + p[2] + p[3]/30;
    if (p.length === 3) return p[0]*3600 + p[1]*60 + p[2];
    return -1;
  }

  function PFX_filterShotIndex(rows, query) {
    if (!Array.isArray(rows) || !query || !query.trim()) return rows;
    const q = query.trim().toLowerCase();
    const dir = {};
    const free = q.replace(/\b(shot|camera|qc|reel|status|source|has|duration):(\S+)/gi, (_, k, v) => {
      dir[k.toLowerCase()] = v.toLowerCase(); return '';
    }).trim();

    return rows.filter(r => {
      if (dir.shot   && !r.shotName.toLowerCase().includes(dir.shot))   return false;
      if (dir.camera && !r.camera.toLowerCase().includes(dir.camera))   return false;
      if (dir.reel   && !r.reel.toLowerCase().includes(dir.reel))       return false;
      if (dir.source && !r.source.toLowerCase().includes(dir.source))   return false;
      if (dir.status) {
        if (dir.status === 'missing-media') { if (r.hasMedia) return false; }
        else if (!r.status.toLowerCase().includes(dir.status)) return false;
      }
      if (dir.qc) {
        if (dir.qc === 'open') { if (r.status !== 'open') return false; }
        else if (!(r.qcSeverity || '').toLowerCase().includes(dir.qc)) return false;
      }
      if (dir.has) {
        if (dir.has === 'roi'      && !r.hasROI)     return false;
        if (dir.has === 'media'    && !r.hasMedia)   return false;
        if (dir.has === 'timeline' && !r.hasTimeline) return false;
      }
      if (dir.duration) {
        const dm = dir.duration.match(/^([<>])(\d{1,2}:\d{2}:\d{2}(?::\d{2})?)$/);
        if (dm) {
          const thresh = _tcSec(dm[2]); const dur = _tcSec(r.duration);
          if (dur < 0) return false;
          if (dm[1] === '>' && dur <= thresh) return false;
          if (dm[1] === '<' && dur >= thresh) return false;
        }
      }
      if (free) {
        const hay = [r.shotName,r.clipName,r.reel,r.camera,r.scene,r.take,r.source,...(r.tags||[])].join(' ').toLowerCase();
        if (!hay.includes(free)) return false;
      }
      return true;
    });
  }

  // ── CSV Export ───────────────────────────────────────────────────────────

  function PFX_exportShotIndexCSV(rows) {
    const cols = ['id','source','shotName','clipName','reel','camera','scene','take',
                  'recIn','recOut','srcIn','srcOut','duration','fps','status',
                  'qcSeverity','noteCount','hasROI','hasMedia','hasTimeline','tags'];
    const esc = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
    const lines = [cols.join(',')];
    (rows || []).forEach(r => lines.push(cols.map(c =>
      c === 'tags' ? esc((r.tags||[]).join('|')) : esc(r[c])
    ).join(',')));
    return lines.join('\n') + '\n';
  }

  // ── UI ────────────────────────────────────────────────────────────────────

  const CHIPS = [
    { id:'all',           label:'All',           fn: ()=>true },
    { id:'missing-media', label:'Missing Media',  fn: r=>!r.hasMedia },
    { id:'qc-open',       label:'QC Open',        fn: r=>r.status==='open'||r.qcSeverity!=null },
    { id:'changed',       label:'Changed',        fn: r=>r.tags.includes('changed')||r.status==='changed' },
    { id:'imf',           label:'IMF',            fn: r=>r.source==='imf' },
    { id:'markers',       label:'Markers',        fn: r=>r.source==='markers' },
    { id:'pull-prep',     label:'Pull Prep',      fn: r=>r.source==='pull_prep' },
    { id:'reviews',       label:'Reviews',        fn: r=>r.source==='review' },
  ];

  let _rows=[], _filtered=[], _chip='all', _q='';

  function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function _dl(name, text, mime){
    const b=new Blob([text],{type:mime}), u=URL.createObjectURL(b);
    const a=Object.assign(document.createElement('a'),{href:u,download:name});
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(u),5000);
  }

  function _render(){
    const pane = document.getElementById('main-shotindex');
    if(!pane) return;

    const chipCounts = {};
    CHIPS.forEach(c=>{ chipCounts[c.id]=_rows.filter(c.fn).length; });

    const chipHtml = CHIPS.map(c=>`
      <button class="pfx-si-chip${_chip===c.id?' is-active':''}" data-si-chip="${c.id}">
        ${_esc(c.label)}<span class="pfx-si-chip-ct">${chipCounts[c.id]}</span>
      </button>`).join('');

    const ths = ['#','Src','Shot Name','Clip','Reel','Cam','Rec In','Rec Out','Dur','FPS','Status','QC Sev','Notes','ROI','Media','TL']
      .map(h=>`<th class="pfx-si-th">${h}</th>`).join('');

    const tbody = _filtered.length
      ? _filtered.map((r,i)=>`
        <tr class="pfx-si-tr${r.hasROI?' has-roi':''}${!r.hasMedia?' no-media':''}"
            data-si-id="${_esc(r.id)}" tabindex="0" role="button">
          <td class="pfx-si-td pfx-si-idx">${i+1}</td>
          <td class="pfx-si-td"><span class="pfx-si-src pfx-si-src-${_esc(r.source.replace(/_/g,'-'))}">${_esc(r.source.replace(/_/g,' '))}</span></td>
          <td class="pfx-si-td pfx-si-name" title="${_esc(r.shotName)}">${_esc(r.shotName||'—')}</td>
          <td class="pfx-si-td pfx-si-clip" title="${_esc(r.clipName)}">${_esc(r.clipName||'—')}</td>
          <td class="pfx-si-td">${_esc(r.reel||'—')}</td>
          <td class="pfx-si-td">${_esc(r.camera||'—')}</td>
          <td class="pfx-si-td pfx-si-tc">${_esc(r.recIn||'—')}</td>
          <td class="pfx-si-td pfx-si-tc">${_esc(r.recOut||'—')}</td>
          <td class="pfx-si-td pfx-si-tc">${_esc(r.duration||'—')}</td>
          <td class="pfx-si-td">${r.fps>0?r.fps:'—'}</td>
          <td class="pfx-si-td"><span class="pfx-si-status pfx-si-st-${_esc(r.status)}">${_esc(r.status||'—')}</span></td>
          <td class="pfx-si-td">${r.qcSeverity?`<span class="pfx-si-qc pfx-si-qc-${_esc(r.qcSeverity)}">${_esc(r.qcSeverity)}</span>`:'—'}</td>
          <td class="pfx-si-td">${r.noteCount>0?r.noteCount:'—'}</td>
          <td class="pfx-si-td">${r.hasROI?'<span class="pfx-si-dot pfx-si-dot-y">●</span>':'—'}</td>
          <td class="pfx-si-td">${r.hasMedia?'<span class="pfx-si-dot pfx-si-dot-y">●</span>':'<span class="pfx-si-dot pfx-si-dot-n">○</span>'}</td>
          <td class="pfx-si-td">${r.hasTimeline?'<span class="pfx-si-dot pfx-si-dot-y">●</span>':'—'}</td>
        </tr>`)
        .join('')
      : `<tr><td colspan="16" class="pfx-si-empty">${_rows.length?'No shots match the current filter.':'No data yet — load a project or EDL to populate.'}</td></tr>`;

    pane.innerHTML = `<div class="pfx-shot-index">
      <div class="pfx-si-head">
        <div class="pfx-si-title-row">
          <h2 class="pfx-si-title">Shot Index</h2>
          <span class="pfx-si-count">${_filtered.length} of ${_rows.length} shots</span>
          <div class="pfx-si-head-acts">
            <button class="pfx-si-btn" id="pfxSiRefresh">↺ Refresh</button>
            <button class="pfx-si-btn pfx-si-btn-accent" id="pfxSiCsv">⬇ CSV</button>
          </div>
        </div>
        <input class="pfx-si-search" id="pfxSiSearch" type="search"
          placeholder="Search… (shot:LMP101  camera:A  reel:A001  qc:open  has:media  status:missing-media  duration:>00:00:05)"
          value="${_esc(_q)}" autocomplete="off" spellcheck="false"/>
        <div class="pfx-si-chips">${chipHtml}</div>
      </div>
      <div class="pfx-si-table-wrap">
        <table class="pfx-si-table"><thead><tr>${ths}</tr></thead><tbody>${tbody}</tbody></table>
      </div>
    </div>`;

    document.getElementById('pfxSiRefresh')?.addEventListener('click',_refresh);
    document.getElementById('pfxSiCsv')?.addEventListener('click',()=>_dl('shot_index.csv',PFX_exportShotIndexCSV(_filtered),'text/csv'));
    document.getElementById('pfxSiSearch')?.addEventListener('input',e=>{ _q=e.target.value; _apply(); });
    pane.querySelectorAll('[data-si-chip]').forEach(b=>b.addEventListener('click',()=>{ _chip=b.dataset.siChip; _apply(); }));
    pane.querySelectorAll('.pfx-si-tr[data-si-id]').forEach(tr=>{
      const fire=()=>{ const r=_filtered.find(x=>x.id===tr.dataset.siId); if(r) window.dispatchEvent(new CustomEvent('pfx:shot-index-select',{detail:r,bubbles:true})); };
      tr.addEventListener('click',fire);
      tr.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' ') fire(); });
    });
  }

  function _apply(){
    const chipFn = CHIPS.find(c=>c.id===_chip)?.fn||(()=>true);
    _filtered = PFX_filterShotIndex(_rows.filter(chipFn), _q);
    _render();
  }

  function _refresh(){
    _rows = PFX_buildShotIndex();
    _apply();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  window.PFX_buildShotIndex     = PFX_buildShotIndex;
  window.PFX_filterShotIndex    = PFX_filterShotIndex;
  window.PFX_exportShotIndexCSV = PFX_exportShotIndexCSV;

  // ── Init ─────────────────────────────────────────────────────────────────

  function _init(){
    document.addEventListener('pfx:tab-activated', e=>{
      if(e.detail?.tab==='shotindex') _refresh();
    });
    document.addEventListener('pfx:project-applied', ()=>{
      const p=document.getElementById('main-shotindex');
      if(p&&p.style.display!=='none') _refresh();
    });
    _render();
  }

  document.readyState==='loading'
    ? document.addEventListener('DOMContentLoaded',_init)
    : _init();
})();
