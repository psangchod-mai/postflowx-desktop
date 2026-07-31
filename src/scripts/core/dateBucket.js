// scripts/core/dateBucket.js
// PostFlowX — the group headings in the project list.
//
// Iteration 157 localised the dates *inside* the project list: the rows now say
// "3 days ago" and hover to a tooltip with the reader's own month names. The
// headings those rows sit under did not move, so the panel ended up in two
// languages at once — an English word in bold, with correctly-localised rows
// indented beneath it. That reads worse than when the whole panel was English,
// because now the seam is visible inside one view.
//
// Unlike the dates, these are labels and not formatted values: Intl has nothing
// to say about the phrase "Previous 7 Days". So they are dictionary rows, and
// this module is what makes them scannable — the bucket decision is separated
// from the words, so the decision can be unit-tested with no DOM and the words
// can be found by the i18n scanner.

import { translate } from './friendlyError.js';

const DAY_MS = 86_400_000;

/**
 * Local-midnight day number. Days, not hours: two timestamps eleven hours apart
 * can be on different days, and two timestamps twenty-five hours apart can be on
 * the same one, which is the whole reason this is not `Math.floor(ms / DAY_MS)`.
 */
export function dayIndex(ms) {
  const d = new Date(Number(ms));
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / DAY_MS);
}

/**
 * Which group a row belongs in.
 *
 * Returns a stable `key`, not a label. The label is a translation and therefore
 * changes with the language; the grouping must not, or a list re-rendered after
 * a language switch would break its runs at different points.
 *
 * @param {number} ms Epoch milliseconds of the row's date.
 * @param {number} [now] Injectable, so "is this today" is testable at all.
 * @returns {{order: number, key: string}}
 */
export function dateBucket(ms, now) {
  const at = Number(ms);
  if (!Number.isFinite(at) || at <= 0) return { order: 4, key: 'undated' };

  const today = dayIndex(Number.isFinite(now) ? now : Date.now());
  const d = dayIndex(at);

  // A file stamped in the future — a machine with a fast clock, a file copied
  // from a later timezone — belongs at the top with today's work, not in a
  // group of its own that sorts below "Older".
  if (d >= today) return { order: 0, key: 'today' };
  if (d === today - 1) return { order: 1, key: 'yesterday' };
  if (today - d < 7) return { order: 2, key: 'week' };
  return { order: 3, key: 'older' };
}

/**
 * The heading a reader sees for a bucket key.
 *
 * @param {string} key A key from `dateBucket`.
 * @returns {string} The heading, translated; '' for a key that is not a bucket.
 */
export function bucketLabel(key) {
  switch (key) {
    case 'today': return translate('Today');
    case 'yesterday': return translate('Yesterday');
    case 'week': return translate('Previous 7 Days');
    case 'older': return translate('Older');
    case 'undated': return translate('No date');
    default: return '';
  }
}
