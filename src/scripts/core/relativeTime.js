// scripts/core/relativeTime.js
// PostFlowX — "4 minutes ago", in the language the reader chose.
//
// ── What was there ───────────────────────────────────────────────────────────
//
// Four hand-rolled formatters, in four files, with four different sets of rules:
//
//   ui.js               'just now' under 60s, then `${n}m ago`, then `${n}h ago`
//   render_queue.js     'just now' under 5s, then `${n}s ago`, `${n}m ago`, `${n}h ago`
//   projectManager.js   'just now', `${n} min ago`, `${n} hr ago`, 'Yesterday', `${n} days ago`
//   trlconf/index.js    'just now', `${n} minute(s) ago`, `${n} hour(s) ago`, `${n} day(s) ago`
//
// Every one of them is English. Not "not yet translated" — untranslatable in the
// shape they were written, because they build the sentence by gluing a number to
// the word "ago", and that is not how the sentence is built in any of the six
// languages this app ships. Korean puts the marker after the number and the verb
// last; Thai wraps the whole phrase in ที่แล้ว; and the plural rule that
// trlconf hand-codes as `${n === 1 ? '' : 's'}` is an English rule that produces
// nonsense the moment the surrounding words are not English.
//
// They also disagree with each other. The same save, read off two panels five
// seconds apart, was "just now" in one and "5s ago" in the other.
//
// ── Why Intl and not a dictionary ────────────────────────────────────────────
//
// Intl.RelativeTimeFormat is in the runtime already and carries CLDR's rules for
// every locale we ship, including the plural categories Thai and Korean do not
// have and Filipino does. Putting "3 minutes ago" in a dictionary would need one
// row per number per unit per locale to be correct; this needs none, and it is
// right for numbers nobody thought to write a row for.
//
// `numeric: 'auto'` is what makes it say "yesterday" instead of "1 day ago" —
// the idiom, in each language, rather than a literal count.

import { translate } from './friendlyError.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Our language codes are already BCP 47 tags, which is not luck — the picker was
// built on them. Anything unrecognised falls to English rather than throwing,
// because a status pill is the wrong place to take an app down.
function resolveLang(lang) {
  const raw = String(lang || '').trim();
  if (raw) return raw;
  try {
    const fromApp = window.PFX_getLang?.();
    if (fromApp) return String(fromApp);
  } catch { /* no DOM — tests, and the extension's service worker */ }
  return 'en';
}

function rtf(lang) {
  try {
    return new Intl.RelativeTimeFormat(resolveLang(lang), { numeric: 'auto' });
  } catch {
    return new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  }
}

function dtf(lang) {
  try {
    return new Intl.DateTimeFormat(resolveLang(lang), { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' });
  }
}

/**
 * How long ago something happened, said the way the reader's language says it.
 *
 * Anything older than a week becomes a date. A relative label stops being useful
 * long before that — "23 days ago" is a number the reader has to do arithmetic
 * on, and the date they are actually looking for is right there in the timestamp.
 *
 * @param {number} ms Epoch milliseconds of the event, or 0/null if there isn't one.
 * @param {{now?: number, lang?: string}} [opts] `now` is injectable so this is testable.
 * @returns {string} A localised label, or '' when there is no timestamp to describe.
 */
export function relativeTime(ms, opts = {}) {
  const at = Number(ms);
  if (!Number.isFinite(at) || at <= 0) return '';

  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const lang = opts.lang;
  const diff = now - at;

  // A clock that has gone backwards — a resynced machine, a file copied from a
  // laptop in a later timezone — should read as "now", not as a time in the
  // future the reader has no way to act on.
  if (diff < 45_000) return rtf(lang).format(0, 'second');
  if (diff < HOUR) return rtf(lang).format(-Math.floor(diff / MIN), 'minute');
  if (diff < DAY) return rtf(lang).format(-Math.floor(diff / HOUR), 'hour');
  if (diff < 7 * DAY) return rtf(lang).format(-Math.floor(diff / DAY), 'day');
  return dtf(lang).format(new Date(at));
}

/**
 * The exact moment, spelled out — what a relative label hides.
 *
 * The project list puts this in the `title=` of every row, so the reader can
 * hover "3 days ago" and get the timestamp. Hand-rolled, that tooltip carried an
 * English month-name array with no other spelling to offer, and a 24-hour clock
 * for readers whose locale writes 上午/下午.
 *
 * @param {number} ms Epoch milliseconds.
 * @param {{lang?: string}} [opts]
 * @returns {string} A localised date and time, or '' when there is no timestamp.
 */
export function absoluteDateTime(ms, opts = {}) {
  const at = Number(ms);
  if (!Number.isFinite(at) || at <= 0) return '';
  const fmt = (locale) => new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(new Date(at));
  try { return fmt(resolveLang(opts.lang)); }
  catch { return fmt('en'); }
}

/**
 * The save-status pill.
 *
 * The pill used to be built as `'Saved ' + rel`, which is two English decisions
 * in one line: the word, and the fact that the word comes first. It does not
 * come first in Korean or Japanese. The placeholder lets each locale put the
 * time where its own grammar puts it.
 *
 * @param {number} ms Epoch milliseconds of the last successful save.
 * @param {{now?: number, lang?: string}} [opts]
 * @returns {string} The pill text, or '' when nothing has been saved yet.
 */
export function savedLabel(ms, opts = {}) {
  const when = relativeTime(ms, opts);
  if (!when) return '';
  return translate('Saved {when}').replace('{when}', when);
}
