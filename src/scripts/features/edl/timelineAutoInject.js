// scripts/app/features/edl/timelineAutoInject.js
// Auto-inject the Timeline Strip above the EDL Converter Event Table.
//
// v2: tolerant discovery + timecode fallbacks
// - Discovers the Event Table by header text heuristics (not strict "Rec In/Rec Out").
// - Uses Rec In/Out OR Src In/Out.
// - If headers are truncated/missing, falls back to finding timecode cells per-row.
// - Keeps selection in sync both ways (timeline → row, row → timeline).

import { createTimeline } from '../../components/timeline/index.js';

const VERSION = 'v2.1.0';
const DEFAULT_FPS = 24;

try {
  window.__MPS_TIMELINE_AUTO_INJECT__ = { version: VERSION };
} catch (_) {}

function log(...args) {
  // Uncomment for debugging
  // console.log('[MPS Timeline]', ...args);
}

function normalizeText(s) {
  return (s || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
}

const TC_EXACT_RE = /^(\d{1,2}):(\d{2}):(\d{2}):(\d{2})$/;
const TC_FIND_RE = /(\d{1,2}:\d{2}:\d{2}:\d{2})/g;

function extractFirstTc(s){
  const m = (s || '').toString().match(/(\d{1,2}:\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : '';
}

function collectTcs(s){
  const out = [];
  const str = (s || '').toString();
  let m;
  while ((m = TC_FIND_RE.exec(str)) !== null){
    out.push(m[1]);
    if (out.length >= 8) break;
  }
  TC_FIND_RE.lastIndex = 0;
  return out;
}


function looksLikeTc(s){
  return !!extractFirstTc(s);
}

function tcToFrames(tc, fps) {
  const tc0 = extractFirstTc(tc);
  const m = (tc0 || '').toString().trim().match(TC_EXACT_RE);
  if (!m) return NaN;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ss = parseInt(m[3], 10);
  const ff = parseInt(m[4], 10);
  return (((hh * 60 + mm) * 60 + ss) * fps + ff);
}

function parseIntLoose(v) {
  const n = parseInt((v || '').toString().trim(), 10);
  return Number.isFinite(n) ? n : NaN;
}

function getHeaderCells(table) {
  // table: <table> | any container
  if (table?.matches?.('table')) {
    const thead = table.querySelector('thead');
    if (thead) {
      const ths = Array.from(thead.querySelectorAll('th,td'));
      if (ths.length) return ths;
    }
    // fallback: first row
    const firstRow = table.querySelector('tr');
    if (firstRow) return Array.from(firstRow.querySelectorAll('th,td'));
    return [];
  }

  // role/grid header cells
  const roleHeaders = Array.from(table.querySelectorAll('[role="columnheader"]'));
  if (roleHeaders.length) return roleHeaders;

  // heuristic header strip: take elements that look like header titles (small set)
  // We keep this conservative to avoid scanning the whole DOM.
  const maybe = Array.from(table.querySelectorAll('.header, .thead, .table-header, .eventTableHeader, .event-table-header'));
  for (const el of maybe) {
    const cells = Array.from(el.querySelectorAll('div,span,th,td')).filter(c => (c.textContent || '').trim().length > 0);
    if (cells.length >= 3) return cells;
  }
  return [];
}

function buildHeaderIndexMap(headers) {
  const map = new Map(); // normalized header -> index
  headers.forEach((el, idx) => {
    const t = normalizeText(el.textContent);
    if (!t) return;
    map.set(t, idx);
  });
  return map;
}

function findColIndex(map, candidates) {
  for (const c of candidates) {
    const key = normalizeText(c);
    for (const [k, idx] of map.entries()) {
      if (k === key || k.includes(key)) return idx;
    }
  }
  return -1;
}

function getRowEls(table) {
  if (table?.matches?.('table')) {
    const tbody = table.querySelector('tbody');
    if (tbody) return Array.from(tbody.querySelectorAll('tr'));
    // fallback: all rows except first
    const rows = Array.from(table.querySelectorAll('tr'));
    return rows.slice(1);
  }
  const roleRows = Array.from(table.querySelectorAll('[role="row"]'));
  // Filter out header rows when possible
  const bodyRows = roleRows.filter(r => !r.querySelector('[role="columnheader"]'));
  if (bodyRows.length) return bodyRows;
  // heuristic rows
  const classRows = Array.from(table.querySelectorAll('.row, .table-row, .eventRow, .event-row'));
  return classRows;
}

function getCellEls(row) {
  if (row?.matches?.('tr')) return Array.from(row.querySelectorAll('td'));
  const roleCells = Array.from(row.querySelectorAll('[role="cell"]'));
  if (roleCells.length) return roleCells;
  // heuristic
  return Array.from(row.children || []);
}

function rowSelected(row) {
  if (!row) return false;
  if (row.matches?.('[aria-selected="true"]')) return true;
  const cls = row.className || '';
  return /\b(selected|is-selected|row-selected|active|focused|focus)\b/i.test(cls);
}

function rowTrack(row, colTrack, cells) {
  const ds = row.dataset || {};
  const byDataset = parseIntLoose(ds.track ?? ds.layer ?? ds.vtrack);
  if (Number.isFinite(byDataset)) return Math.max(1, byDataset);

  if (colTrack >= 0 && cells[colTrack]) {
    const v = parseIntLoose(cells[colTrack].textContent);
    if (Number.isFinite(v)) return Math.max(1, v);
  }
  return 1;
}

function guessTimecodesFromRow(cells, fps, rowEl){
  // Prefer Record timecodes (Rec In/Out) when a row contains multiple timecodes.
  // Typical Event Table order: Src In, Src Out, Rec In, Rec Out.
  // If we see >=2 timecodes, we take the last two as Rec In/Out.
  const parts = [];
  if (rowEl && rowEl.textContent) parts.push(rowEl.textContent);
  for (const c of (cells || [])) parts.push(c.textContent || '');
  const joined = parts.join(' ');
  const tcs = collectTcs(joined);

  if (tcs.length < 2) return { s: NaN, e: NaN, startTC: '', endTC: '' };
  const startTC = tcs[tcs.length - 2];
  const endTC = tcs[tcs.length - 1];

  const s = tcToFrames(startTC, fps);
  const e0 = tcToFrames(endTC, fps);
  const e = Number.isFinite(e0) ? e0 : (Number.isFinite(s) ? (s + 1) : NaN);
  return { s, e, startTC, endTC };
}

function allocateLanes(clips){
  // Greedy lane allocation so overlapping clips are stacked on separate rows.
  // This creates a "video layers" look even when the source interchange
  // doesn't store explicit V-track numbers.
  const lanes = []; // lastEnd per lane
  const out = [];
  const sorted = [...(clips || [])].sort((a,b) => (a.start - b.start) || (a.end - b.end));
  for (const c of sorted){
    let lane = -1;
    for (let i = 0; i < lanes.length; i++){
      if (c.start >= lanes[i]) { lane = i; break; }
    }
    if (lane < 0){ lane = lanes.length; lanes.push(c.end); }
    else { lanes[lane] = Math.max(lanes[lane], c.end); }
    c.track = (c.track && c.track > 0) ? c.track : (lane + 1);
    out.push(c);
  }
  return { clips: out, maxTrack: lanes.length || 1 };
}

function extractClips(table, fps) {
  const headers = getHeaderCells(table);
  const headerMap = buildHeaderIndexMap(headers);

  // Prefer Rec In/Out; fallback to Src In/Out.
  const colRecIn = findColIndex(headerMap, ['rec in', 'record in', 'timeline in']);
  const colRecOut = findColIndex(headerMap, ['rec out', 'record out', 'timeline out']);
  const colSrcIn = findColIndex(headerMap, ['src in', 'source in']);
  const colSrcOut = findColIndex(headerMap, ['src out', 'source out']);

  const colClipName = findColIndex(headerMap, ['clip name', 'clip']);
  const colEvent = findColIndex(headerMap, ['event', 'evt', '#']);
  const colReel = findColIndex(headerMap, ['reel']);
  const colTrack = findColIndex(headerMap, ['track', 'layer', 'v']);

  // Some ingests store record timeline timecode inside a "LOC" column.
  // Example: "LOC : 00:13:20:00".
  const colLoc = findColIndex(headerMap, ['loc', 'locator']);

  const colAdv = findColIndex(headerMap, ['advanced fdl', 'adv fdl', 'adv']);
  const colHandles = findColIndex(headerMap, ['handles', 'handle']);

  const rows = getRowEls(table);
  const clips = [];

  let selectedId = null;
  let minF = Infinity;
  let maxF = -Infinity;
  let maxTrack = 1;

  rows.forEach((row, i) => {
    const cells = getCellEls(row);
    if (!cells.length) return;

    let s = NaN, e = NaN;

    // Choose timing in this priority order:
    // 1) Rec In/Out columns
    // 2) LOC (start) + duration from Src In/Out
    // 3) Src In/Out columns
    // 4) heuristic guess

    const hasRec = colRecIn >= 0 && colRecOut >= 0;
    const hasSrc = colSrcIn >= 0 && colSrcOut >= 0;

    if (hasRec && cells[colRecIn] && cells[colRecOut]) {
      s = tcToFrames((cells[colRecIn].textContent || '').trim(), fps);
      e = tcToFrames((cells[colRecOut].textContent || '').trim(), fps);
    } else {
      // LOC start (if available)
      let locStart = NaN;
      if (colLoc >= 0 && cells[colLoc]){
        const locText = (cells[colLoc].textContent || '').trim();
        const m = locText.match(/(\d{2}:\d{2}:\d{2}:\d{2})/);
        if (m) locStart = tcToFrames(m[1], fps);
      }

      // duration from src in/out
      let dur = NaN;
      if (hasSrc && cells[colSrcIn] && cells[colSrcOut]){
        const ss = tcToFrames((cells[colSrcIn].textContent || '').trim(), fps);
        const ee = tcToFrames((cells[colSrcOut].textContent || '').trim(), fps);
        if (Number.isFinite(ss) && Number.isFinite(ee) && ee > ss) dur = (ee - ss);
      }

      if (Number.isFinite(locStart) && Number.isFinite(dur)){
        s = locStart;
        e = locStart + dur;
      } else if (hasSrc && cells[colSrcIn] && cells[colSrcOut]) {
        s = tcToFrames((cells[colSrcIn].textContent || '').trim(), fps);
        e = tcToFrames((cells[colSrcOut].textContent || '').trim(), fps);
      } else {
        const g = guessTimecodesFromRow(cells, fps, row);
        s = g.s; e = g.e;
      }
    }

    if (!Number.isFinite(s) || !Number.isFinite(e)) {
      const g = guessTimecodesFromRow(cells, fps, row);
      s = g.s; e = g.e;
    }

    if (!Number.isFinite(s) || !Number.isFinite(e)) return;
    if (e <= s) e = s + 1; // avoid zero/negative

    // id + label
    let id = row.dataset?.eventId || row.dataset?.id || '';
    // Stable id: prefer Event number text if available (survives sorting)
    if (!id && colEvent >= 0 && cells[colEvent]) {
      const evTxt = (cells[colEvent].textContent || '').trim();
      if (evTxt) id = `evt-${evTxt}`;
    }
    if (!id) id = `row-${i}`;
    row.__mpsTimelineId = id;

    let label = '';
    if (colEvent >= 0 && cells[colEvent]) label = (cells[colEvent].textContent || '').trim();
    if (!label && colClipName >= 0 && cells[colClipName]) label = (cells[colClipName].textContent || '').trim();
    if (!label && colReel >= 0 && cells[colReel]) label = (cells[colReel].textContent || '').trim();
    if (!label) label = String(i + 1);

    // Cosmetic: shorten very long labels for the timeline bar
    label = label.replace(/\s+/g, ' ').trim();
    label = label.replace(/\.(mov|mp4|mxf|exr|dpx|png|jpg|jpeg|tif|tiff)$/i,'');
    if (label.length > 28) label = label.slice(0, 28) + '…';

    // flags
    const flags = [];
    const advTxt = (cells[colAdv]?.textContent || '').trim();
    if (/needed|yes|true/i.test(advTxt)) flags.push('🎯');

    const handlesTxt = (cells[colHandles]?.textContent || '').trim();
    if (/needed|yes|true/i.test(handlesTxt)) flags.push('🧷');

    let status = null;
    const cls = row.className || '';
    if (/\bupdated\b/i.test(cls)) status = 'ok';
    if (/\bfailed\b/i.test(cls)) status = 'fail';

    const track = rowTrack(row, colTrack, cells);
    maxTrack = Math.max(maxTrack, track);

    clips.push({ id, track, start: s, end: e, label, flags, status });

    minF = Math.min(minF, s);
    maxF = Math.max(maxF, e);

    if (rowSelected(row)) selectedId = id;
  });

  if (!Number.isFinite(minF) || !Number.isFinite(maxF) || maxF <= minF) {
    minF = 0;
    maxF = 1;
  }

  // If we don't have explicit track numbers, stack clips by overlap.
  if (maxTrack <= 1 && clips.length > 1) {
    const stacked = allocateLanes(clips);
    maxTrack = Math.max(maxTrack, stacked.maxTrack);
  }

  return { clips, selectedId, timeStart: minF, timeEnd: maxF, trackCount: maxTrack };
}

function tableLooksLikeEventTable(table) {
  const headers = getHeaderCells(table);
  if (!headers || headers.length < 3) return false;
  const texts = headers.map(h => normalizeText(h.textContent));
  const hasClip = texts.some(t => t.includes('clip name') || t === 'clip');
  const hasEvent = texts.some(t => t === 'event' || t.includes('event'));
  const hasReel = texts.some(t => t === 'reel' || t.includes('reel'));

  // If it has Clip Name + (Event or Reel), it's almost certainly the Event Table.
  return hasClip && (hasEvent || hasReel);
}

function findEventTable() {
  // 1) Prefer classic tables
  const tables = Array.from(document.querySelectorAll('table'));
  for (const t of tables) {
    if (tableLooksLikeEventTable(t)) return t;
  }

  // 2) Role-based tables/grids
  const roleTables = Array.from(document.querySelectorAll('[role="table"], [role="grid"]'));
  for (const t of roleTables) {
    if (tableLooksLikeEventTable(t)) return t;
  }

  // 3) Heuristic container: find an element whose text includes "Clip Name" and "Reel"/"Event"
  // Limited scan to avoid expensive full DOM pass.
  const candidates = Array.from(document.querySelectorAll('div,section,article')).slice(0, 2000);
  for (const el of candidates) {
    const txt = normalizeText(el.textContent);
    if (txt.includes('clip name') && (txt.includes('reel') || txt.includes('event'))) {
      // must have many rows
      const rowCount =
        el.querySelectorAll('tbody tr').length +
        el.querySelectorAll('[role="row"]').length +
        el.querySelectorAll('.row, .table-row, .eventRow, .event-row').length;
      if (rowCount > 5) return el;
    }
  }
  return null;
}

function ensureInjected(table) {
  if (!table) return null;

  // Find a reasonable container to insert timeline above.
  const host = table.parentElement || table;
  if (!host) return null;

  // Avoid duplicates
  if (host.querySelector('.mpsTimelineStrip')) return host.querySelector('.mpsTimelineStrip');

  const wrapper = document.createElement('div');
  wrapper.style.margin = '10px 10px 12px 10px';

  // Insert before table when possible
  if (table.parentElement) table.parentElement.insertBefore(wrapper, table);
  else host.insertBefore(wrapper, host.firstChild);

  const api = createTimeline(wrapper, {
    fps: DEFAULT_FPS,
    heightPx: 220,
    autoFollow: true,
    onSelect: (id) => {
      // Find matching row and click it
      const rows = getRowEls(table);
      const row = rows.find(r => r.__mpsTimelineId === id);
      if (row) {
        row.scrollIntoView?.({ block: 'nearest' });
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
    }
  });

  return api;
}

function attachRowSelectionListener(table, api, fps) {
  const onClick = (ev) => {
    const row = ev.target?.closest?.('tr, [role="row"], .row, .table-row, .eventRow, .event-row');
    if (!row) return;
    const id = row.__mpsTimelineId;
    if (!id) return;
    const data = extractClips(table, fps);
    const clip = data.clips.find(c => c.id === id);
    // Set playheadFrame to clip start — auto-follow will scroll the view
    api.setData({ ...data, selectedId: id, playheadFrame: clip ? clip.start : undefined });
  };
  table.addEventListener('click', onClick, true);
  return () => table.removeEventListener('click', onClick, true);
}

function observeTable(table, api, fps) {
  let _lastSelectedId = null;

  const update = () => {
    const data = extractClips(table, fps);
    if (!data.clips || !data.clips.length) return;

    // When selection changes via DOM (keyboard nav, programmatic), move playhead to clip start
    const extra = {};
    if (data.selectedId && data.selectedId !== _lastSelectedId) {
      const clip = data.clips.find(c => c.id === data.selectedId);
      if (clip) extra.playheadFrame = clip.start;
    }
    _lastSelectedId = data.selectedId || _lastSelectedId;

    api.setData({ ...data, ...extra });
  };

  update();

  const mo = new MutationObserver(() => update());
  mo.observe(table, { childList: true, subtree: true, characterData: true });

  return () => mo.disconnect();
}

function boot() {
  const fps = DEFAULT_FPS;

  let active = {
    table: null,
    api: null,
    teardown: []
  };

  const scan = () => {
    const table = findEventTable();
    if (!table) return;

    if (active.table === table && active.api) {
      // refresh occasionally
      return;
    }

    // cleanup old
    active.teardown.forEach(fn => { try { fn(); } catch (_) {} });
    active.teardown = [];
    active.table = table;

    const api = ensureInjected(table);
    if (!api) return;
    active.api = api;

    active.teardown.push(observeTable(table, api, fps));
    active.teardown.push(attachRowSelectionListener(table, api, fps));

    log('Injected timeline strip', VERSION);
  };

  // Initial scan + observe DOM
  scan();
  const mo = new MutationObserver(() => scan());
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // Safety: rescan occasionally
  const t = setInterval(scan, 1000);

  // Expose api for external access + debugging
  try { window.__mpsTimelineStrip = { rescan: scan, version: VERSION, get api() { return active.api; } }; } catch (_) {}

  return () => {
    mo.disconnect();
    clearInterval(t);
    active.teardown.forEach(fn => { try { fn(); } catch (_) {} });
    active.teardown = [];
    if (active.api?.destroy) active.api.destroy();
  };
}

// Auto-run
try { boot(); } catch (e) { console.warn('[MPS Timeline] boot failed', e); }
