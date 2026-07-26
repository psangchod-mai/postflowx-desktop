// scripts/core/paneLang.js
// PostFlowX — push the app's language choice into the tool panes.
//
// WHY THIS FILE EXISTS
// Two of the workspace panes are iframes with documents of their own:
//
//     src/index.html:4895  tools/bwav/app.html            (BWAV Inspector)
//     src/index.html:4905  tools/preflight/app/index.html (Preflight Validator)
//
// modules/i18n.js drives translation with a MutationObserver on the *host*
// document.body. An observer cannot see into another document, so the flag
// selector in the title bar has never had any effect on either pane. Both
// panes ship their own translations and both were built expecting a
// `localeSelect` element to switch them — bwav/app.js:730 and
// preflight/app/app.js:502 both read one. Neither page contains that element,
// and `git log -S localeSelect` finds no commit on any ref that ever added it
// to either HTML file. So:
//
//   • BWAV has ~92 strings in ja/ko/th/id/zh-TW and reaches them only by
//     accident, when navigator.language happens to match.
//   • Preflight has 18 locale files (~148K of translated check text and fix
//     guidance) and is pinned to "en" — settings.locale defaults to "en" at
//     app.js:398 and nothing reachable ever writes it.
//
// The fix is not to add the two missing pickers. Three language controls in
// one window is three ways for them to disagree, and a user who set the app to
// Thai has already said what they want. The title-bar selector is made
// authoritative and its choice is pushed across the frame boundary.
//
// Delivery is postMessage rather than shared localStorage because the renderer
// is loaded with loadFile() (electron/main.js:212) — a file:// document, where
// storage sharing between frames is a platform detail we would rather not
// depend on. Panes still read localStorage as a fallback at startup; this is
// the channel that is guaranteed to work.
// ─────────────────────────────────────────────────────────────────────────────

export const LANG_MESSAGE = 'pfx:lang';

let _current = '';
const _wired = new WeakSet();

/**
 * The iframes we are willing to talk to: same-origin ones only.
 *
 * Reading contentDocument throws (or yields null) for a cross-origin frame, so
 * it doubles as the origin test. The Fun Box pane can hold a YouTube embed, and
 * a language code is not something to post at a third party just because it is
 * cheap to do so.
 */
export function paneFrames(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d || typeof d.querySelectorAll !== 'function') return [];
  const out = [];
  for (const f of Array.prototype.slice.call(d.querySelectorAll('iframe'))) {
    try {
      if (f.contentDocument) out.push(f);
    } catch (_) {
      // cross-origin — not ours to translate
    }
  }
  return out;
}

/**
 * broadcastLang(lang, doc) → number of frames messaged.
 *
 * Also arms a one-time load handler per frame. A pane that has not finished
 * loading has a blank document whose window discards the message on navigation,
 * and both panes are lazily shown — so at the moment the app first applies its
 * language, neither frame is necessarily ready. Re-sending on load is what makes
 * the order of those two events stop mattering.
 */
export function broadcastLang(lang, doc) {
  const v = lang == null ? '' : String(lang);
  if (!v) return 0;
  _current = v;

  let sent = 0;
  for (const f of paneFrames(doc)) {
    if (!_wired.has(f)) {
      _wired.add(f);
      try {
        f.addEventListener('load', () => {
          try { f.contentWindow?.postMessage({ type: LANG_MESSAGE, lang: _current }, '*'); } catch (_) {}
        });
      } catch (_) {}
    }
    try {
      const w = f.contentWindow;
      if (w) { w.postMessage({ type: LANG_MESSAGE, lang: v }, '*'); sent++; }
    } catch (_) {}
  }
  return sent;
}

/** The language last broadcast, for a pane that loads late and wants to ask. */
export function currentPaneLang() {
  return _current;
}

if (typeof window !== 'undefined') {
  window.pfxBroadcastLang = broadcastLang;
}
