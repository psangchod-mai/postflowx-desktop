// scripts/core/errorBanner.js
// PostFlowX — the transient failure banner that showError() writes into.
//
// WHY THIS FILE EXISTS
// showError() in ui.js has always opened with a lookup and bailed out when it
// came back null:
//
//     const el = $("#errors");
//     if (!el) return;
//
// No element with id="errors" has ever existed. `git log -S 'id="errors"'`
// across every ref finds no commit that added one, nothing assigns that id at
// runtime, and neither src/index.html nor the built dist/desktop/index.html
// contains it. Every one of the 66 showError() call sites in the renderer was
// therefore silent — "Scan a VFX folder first.", "Native VFX Root is
// required.", every export guard and validation failure. The user clicked,
// nothing happened, and there was no way to tell a refused action from a
// broken app.
//
// The banner mounts itself on first use rather than relying on markup, because
// index.html is not shared by the extension target or by the bwav/preflight
// tool pages — adding a div would have fixed one host and left the others
// exactly as broken. A host-supplied #errors still wins where one exists, so
// this cannot displace a page that already has its own slot.
// ─────────────────────────────────────────────────────────────────────────────

const BANNER_ID = 'pfxErrorBanner';
const ON_CLASS = 'pfx-error-banner--on';

/**
 * How long a message stays up, in ms.
 * The old code used a flat 4s. Someone who is not a post engineer reads a
 * two-sentence failure plus its suggested next step more slowly than that, and
 * a message that disappears before it is read is barely better than no message
 * at all. Scale with length, floor it at the old 4s, and cap it so the banner
 * never turns into furniture.
 */
export function dismissDelay(text) {
  const n = String(text == null ? '' : text).length;
  return Math.max(4000, Math.min(15000, 3500 + n * 55));
}

/** Resolve the element to write into, creating one if the page has no slot. */
export function bannerHost(doc) {
  if (!doc || !doc.body) return null;

  const provided = doc.querySelector('#errors');
  if (provided) return provided;

  const existing = doc.getElementById(BANNER_ID);
  if (existing) return existing;

  const el = doc.createElement('div');
  el.id = BANNER_ID;
  el.className = 'pfx-error-banner';
  // Announced by a screen reader the moment it appears. A banner that only
  // sighted users notice is the same defect in a smaller form.
  el.setAttribute('role', 'alert');
  el.setAttribute('aria-live', 'assertive');
  // Translated by the i18n observer, which watches the title attribute.
  el.setAttribute('title', 'Dismiss');

  // Let the user get rid of it early. Only wired on the banner we own — a
  // host-supplied #errors may have handlers of its own.
  try { el.addEventListener('click', () => showErrorBanner('', doc)); } catch (_) {}

  doc.body.appendChild(el);
  return el;
}

let _timer = 0;

/**
 * showErrorBanner(text, doc) → the banner element, or null if there is no DOM.
 * Falsy text hides the banner, which is the contract showError() already had.
 *
 * Text only, never markup: the message routinely carries a filesystem path or
 * raw exception text straight from a catch block, and neither is trusted input.
 */
export function showErrorBanner(text, doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  const el = bannerHost(d);
  if (!el) return null;

  const msg = text == null ? '' : String(text);

  // A second failure while the first is still up replaces it and restarts the
  // clock; otherwise the earlier timeout would cut the new message short.
  if (_timer) { try { clearTimeout(_timer); } catch (_) {} _timer = 0; }

  el.textContent = msg;
  // Inline opacity as well as the class, so a host-supplied #errors with no
  // PostFlowX stylesheet behaves exactly as it did before this file existed.
  el.style.opacity = msg ? '1' : '0';
  try { el.classList.toggle(ON_CLASS, !!msg); } catch (_) {}

  if (msg) {
    _timer = setTimeout(() => {
      _timer = 0;
      el.textContent = '';
      el.style.opacity = '0';
      try { el.classList.remove(ON_CLASS); } catch (_) {}
    }, dismissDelay(msg));
  }

  return el;
}

/** Hide the banner now. */
export function hideErrorBanner(doc) {
  return showErrorBanner('', doc);
}

// Expose for classic-script consumers, matching core/friendlyError.js.
if (typeof window !== 'undefined') {
  window.pfxShowErrorBanner = showErrorBanner;
}
