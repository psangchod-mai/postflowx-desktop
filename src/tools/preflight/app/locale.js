// tools/preflight/app/locale.js
// Which language the Preflight pane renders in, and how a host language code
// becomes one.
//
// WHY THIS EXISTS
// The pane ships 21 config files — ui_strings, checks.i18n and requirements.i18n
// in seven languages, roughly 148K of translated check text and fix guidance —
// and until now every one of them except English was unreachable.
//
// `settings.locale` defaults to "en" (app.js:398) and the only code that ever
// wrote it hung off `qs("localeSelect")` (app.js:502). No element with that id
// exists in app/index.html, and `git log -S localeSelect` finds no commit on any
// ref that ever added one. So the listener was never attached, the locale never
// changed, and six translations sat on disk being shipped and never shown. The
// neighbouring `setText("lLanguage", ...)` targets a label for the same absent
// control.
//
// The fix is not to add the missing picker. The app already has one language
// control in the title bar, and a second one inside a pane is a second way for
// them to disagree — a user who set the app to Thai has already answered the
// question. scripts/core/paneLang.js broadcasts that choice across the iframe
// boundary; this module is the receiving end's vocabulary.
//
// WHY NOT location.reload()
// The dead handler ended in `location.reload()`, and it is worth being precise
// about why that is the wrong shape even though it never ran. `state.files`
// holds the File objects the user picked; it is deliberately not persisted,
// because File handles do not survive serialisation. A reload therefore drops
// the user's entire scope on the floor. What comes back is `pfx_last_run` — a
// *stored* run whose card titles were baked at scan time in the previous
// language — so the reload would have cost the user their files and still shown
// them stale text.
//
// Re-localising in place is strictly better on both counts: the chrome is
// re-read from the new config at render time (ui.js reads state.config.ui.labels
// on every render), and because the files are still in memory the run can
// actually be redone in the new language.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The locales with a complete config set on disk. Every one of these has all
 * three of ui_strings / checks.i18n / requirements.i18n — checked, not assumed:
 * a locale listed here with a missing file would fall back per-file inside
 * loadConfig and render half-translated, which is worse than plain English.
 */
export const PREFLIGHT_LOCALES = ['en', 'ja', 'ko', 'zh-TW', 'th', 'id', 'fil'];

export const DEFAULT_LOCALE = 'en';

/**
 * A host language code → a locale this pane can actually load.
 *
 * The host offers exactly the same seven languages, so this is close to an
 * identity map. It is still worth writing down, because "close to identity" is
 * where the interesting failures live: `zh-TW` must survive its region suffix
 * while `en-GB` must lose one, and anything unrecognised has to land on English
 * rather than on a locale whose files do not exist. Loading a missing locale is
 * not loud — loadConfig's safeJson swallows the 404 and returns an empty
 * dictionary, and the pane renders blank labels.
 */
export function normalizeLocale(raw) {
  if (!raw) return DEFAULT_LOCALE;
  const s = String(raw).trim();
  if (!s) return DEFAULT_LOCALE;

  // Exact match first, case-insensitively — this is the common path.
  const exact = PREFLIGHT_LOCALES.find((l) => l.toLowerCase() === s.toLowerCase());
  if (exact) return exact;

  const lower = s.toLowerCase().replace(/_/g, '-');

  // Chinese is the one that needs real rules. Only Traditional is translated,
  // so Simplified must not be silently served Traditional text — zh-CN falls
  // back to English, which is honest, rather than to a script the reader may
  // not use.
  if (lower.startsWith('zh')) {
    if (/hant|-tw|-hk|-mo/.test(lower)) return 'zh-TW';
    return DEFAULT_LOCALE;
  }

  // Tagalog and Filipino are the same language under two codes; the host sends
  // "fil" but a browser may report "tl".
  if (lower.startsWith('fil') || lower.startsWith('tl')) return 'fil';

  // Indonesian changed code in 1989; some platforms still emit the old one.
  if (lower.startsWith('id') || lower.startsWith('in-')) return 'id';

  // Everything else: match on the primary subtag, so en-GB → en, ja-JP → ja.
  const primary = lower.split('-')[0];
  const byPrimary = PREFLIGHT_LOCALES.find((l) => l.toLowerCase().split('-')[0] === primary);
  return byPrimary || DEFAULT_LOCALE;
}

/**
 * The language to start in, most-authoritative source first.
 *
 *   1. mps.lang       — what the user chose in the title bar. Their stated intent.
 *   2. settings.locale — what this pane last ran as. Only meaningful once (1)
 *                        has been honoured at least one time.
 *   3. navigator.language — the OS guess, better than nothing.
 *
 * Reading localStorage is a startup convenience only. The renderer is loaded
 * with loadFile() (electron/main.js:212), a file:// document, and storage
 * sharing between file:// frames is a platform detail rather than a guarantee —
 * which is exactly why paneLang.js delivers by postMessage. If the read fails,
 * the postMessage still arrives and corrects us.
 */
export function preferredLocale(settingsLocale, storage, nav) {
  const store = storage === undefined
    ? (typeof localStorage !== 'undefined' ? localStorage : null)
    : storage;
  try {
    const host = store && store.getItem('mps.lang');
    if (host) return normalizeLocale(host);
  } catch (_) {
    // file:// storage can throw outright; fall through to the next source
  }
  if (settingsLocale) return normalizeLocale(settingsLocale);
  const n = nav === undefined ? (typeof navigator !== 'undefined' ? navigator : null) : nav;
  return normalizeLocale(n && n.language);
}
