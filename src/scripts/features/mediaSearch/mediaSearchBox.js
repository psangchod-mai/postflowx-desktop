// mediaSearchBox.js — media-library search box (PFXMAC Sprint 3, user-facing).
//
// Self-contained widget: a debounced search input + an absolutely-positioned
// results dropdown. Queries the native SQLite media DB through the existing
// nativeEngine bridge (`db.search`). Desktop-only; no-ops gracefully when the
// native engine isn't present (extension build / engine offline).
'use strict';

async function _search(term) {
  const eng = (typeof window !== 'undefined') ? window.pfxPlatform?.nativeEngine : null;
  if (!eng || typeof eng.command !== 'function') {
    return { error: 'Media database unavailable (native engine not running).' };
  }
  try {
    const rows = await eng.command('db.search', { term, limit: 50 });
    return { rows: Array.isArray(rows) ? rows : [] };
  } catch (e) {
    return { error: e?.message || 'Search failed' };
  }
}

function _injectStyle() {
  if (document.getElementById('pfx-mediasearch-style')) return;
  const st = document.createElement('style');
  st.id = 'pfx-mediasearch-style';
  st.textContent = `
  .pfx-msrch { position:relative; padding:4px 8px 6px; }
  .pfx-msrch input { width:100%; box-sizing:border-box; background:#0d0d14; border:1px solid #2a2a38;
    border-radius:5px; color:#ddd; font-size:11px; padding:5px 8px; outline:none; }
  .pfx-msrch input:focus { border-color:#5aa7ff; }
  .pfx-msrch-results { position:absolute; left:8px; right:8px; top:36px; z-index:60; max-height:208px;
    overflow:auto; background:#14141c; border:1px solid #3a3a4e; border-radius:6px;
    box-shadow:0 10px 28px rgba(0,0,0,.7); display:none; }
  .pfx-msrch-results.open { display:block; }
  .pfx-msrch-count { padding:4px 9px; font-size:9px; color:#8a8a9a; background:#10101a;
    border-bottom:1px solid #20202a; position:sticky; top:0; }
  .pfx-msrch-item { padding:6px 9px; border-bottom:1px solid #20202a; cursor:pointer; }
  .pfx-msrch-item:last-child { border-bottom:0; }
  .pfx-msrch-item:hover { background:#1d1d28; }
  .pfx-msrch-fn { font-size:11px; color:#fff; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pfx-msrch-meta { font-size:9px; color:#8a8a9a; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pfx-msrch-empty { padding:8px 9px; font-size:10px; color:#777; }
  `;
  document.head.appendChild(st);
}

const _esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Mount the search box into `host` (e.g. the Assets section). Idempotent.
 * @param {HTMLElement} host
 * @param {(record:object)=>void} [onPick] optional: called when a result is clicked.
 */
export function mountMediaSearch(host, onPick) {
  if (!host || host.dataset.pfxMsrchMounted) return;   // once per host; multiple hosts allowed
  host.dataset.pfxMsrchMounted = '1';
  _injectStyle();

  const wrap = document.createElement('div');
  wrap.className = 'pfx-msrch';
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Search media library…';
  input.setAttribute('aria-label', 'Search media library');
  const results = document.createElement('div');
  results.className = 'pfx-msrch-results';
  wrap.appendChild(input);
  wrap.appendChild(results);

  // Sit just below the panel/section header when present, else at the top of host.
  const hdr = host.querySelector('.imf-left-sec-hdr, .pfx-vfx-ws-panel-hdr');
  if (hdr && hdr.nextSibling) host.insertBefore(wrap, hdr.nextSibling);
  else host.insertBefore(wrap, host.firstChild);

  let lastRows = [];
  const render = (state, term) => {
    if (!term) { results.classList.remove('open'); results.innerHTML = ''; lastRows = []; return; }
    if (state.error) {
      results.innerHTML = `<div class="pfx-msrch-empty">${_esc(state.error)}</div>`;
      lastRows = [];
    } else if (!state.rows.length) {
      results.innerHTML = `<div class="pfx-msrch-empty">No matches for “${_esc(term)}”.</div>`;
      lastRows = [];
    } else {
      lastRows = state.rows;
      const hint = (typeof onPick === 'function') ? ' · click to link to its shot' : '';
      const header = `<div class="pfx-msrch-count">${state.rows.length} result${state.rows.length === 1 ? '' : 's'}${hint}</div>`;
      results.innerHTML = header + state.rows.map((r, i) => {
        const dims = (r.width && r.height) ? `${r.width}×${r.height}` : '';
        const meta = [dims, r.codec, (r.format || '').toUpperCase()].filter(Boolean).join(' · ');
        return `<div class="pfx-msrch-item" data-i="${i}">
                  <div class="pfx-msrch-fn">${_esc(r.filename || r.path)}</div>
                  <div class="pfx-msrch-meta">${_esc(meta)}${meta ? ' — ' : ''}${_esc(r.path)}</div>
                </div>`;
      }).join('');
    }
    results.classList.add('open');
  };

  let timer = null;
  let seq = 0;
  input.addEventListener('input', () => {
    const term = input.value.trim();
    const mySeq = ++seq;
    clearTimeout(timer);
    if (!term) { render({ rows: [] }, ''); return; }
    timer = setTimeout(async () => {
      const state = await _search(term);
      // A newer keystroke may have started its own search while this one was
      // in flight; clearTimeout only cancels timers, not in-flight IPC calls,
      // so a slower earlier search can otherwise resolve after a faster later
      // one and clobber the dropdown/lastRows with stale results.
      if (mySeq !== seq) return;
      render(state, term);
    }, 200);
  });
  input.addEventListener('focus', () => { if (input.value.trim() && results.innerHTML) results.classList.add('open'); });
  input.addEventListener('blur', () => setTimeout(() => results.classList.remove('open'), 160));
  results.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.pfx-msrch-item');
    if (!item) return;
    const rec = lastRows[Number(item.dataset.i)];
    if (rec) {
      input.value = rec.filename || rec.path || '';
      results.classList.remove('open');
      if (typeof onPick === 'function') { try { onPick(rec); } catch {} }
    }
  });
}
