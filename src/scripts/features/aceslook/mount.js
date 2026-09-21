// Dynamic import so any module-chain error is catchable and surfaces visibly
// instead of leaving window.__pfxMountAcesLook silently undefined.
import('./index.js').then(mod => {
  window.__pfxMountAcesLook = mod.mountAcesLook;
  // If the ACES Look tab is already active when the module resolves, mount now.
  const root = document.getElementById('main-aceslook');
  if (root && root.style.display !== 'none' && root.style.display !== '') {
    try { window.__pfxMountAcesLook(); } catch (_) {}
  }
}).catch(err => {
  console.error('[PostFlowX] ACES Look module failed to load:', err);
  window.__pfxAcesLookLoadError = err?.message || String(err);
  // Surface the error in the pane if it's already visible
  const root = document.getElementById('main-aceslook');
  if (root && !root.querySelector('.al2-topbar')) {
    const _escMsg = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    root.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:10px;font-family:system-ui;"><div style="color:#c04050;font-size:14px;font-weight:600;">ACES Look failed to load</div><div style="color:#9a9da3;font-size:11px;max-width:420px;text-align:center;">${_escMsg(err?.message || err)}</div></div>`;
  }
});
