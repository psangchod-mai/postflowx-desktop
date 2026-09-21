// scripts/core/tabGroupFit.js
// Keeps the workspace toolbar's group labels (Prep/Review/Delivery/Color/System)
// from ever overflowing the no-wrap tab strip. The labels are decorative, so on a
// narrow window we simply hide them and fall back to the plain tab row.
//
// Classic script (no import/export) — loaded with `defer` after the toolbar exists.
// Anti-oscillation: labels are always revealed *before* measuring, so the decision
// reflects the labels-on width and is stable (no show/hide feedback loop).
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  var SLACK = 2; // px tolerance

  function bar() { return document.querySelector('.tabs.mac-workspace-toolbar'); }
  function labels(b) { return b ? b.querySelectorAll('.tab-group-label') : []; }

  function fit() {
    var b = bar();
    if (!b) return;
    var ls = labels(b);
    if (!ls.length) return;

    // Reveal, then measure (reading scrollWidth forces synchronous layout).
    for (var i = 0; i < ls.length; i++) ls[i].style.display = 'flex';
    var overflow = b.scrollWidth > b.clientWidth + SLACK;

    if (overflow) {
      for (var j = 0; j < ls.length; j++) ls[j].style.display = 'none';
    }
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () { scheduled = false; fit(); });
  }

  function init() {
    schedule();
    window.addEventListener('resize', schedule, { passive: true });
    try {
      var b = bar();
      if (b && 'ResizeObserver' in window) {
        var ro = new ResizeObserver(schedule);
        ro.observe(b);
      }
    } catch (_) {}
    // Re-fit after late layout (fonts, permission-gated tab hide/show, tab reorder).
    setTimeout(schedule, 600);
    setTimeout(schedule, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Allow other code (e.g. after toggling movable tabs) to request a re-fit.
  window.pfxTabGroupFit = schedule;
})();
