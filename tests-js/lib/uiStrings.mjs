// Measure how much of the UI the translation dictionary actually covers.
//
// tests-js/lib/i18nDict.mjs answers "for the keys the dictionary holds, which
// locales are missing one". This answers the complementary and more direct
// question: of the strings a user actually sees, how many has the dictionary
// never heard of? A key that is perfectly translated into six languages does
// nothing if the label on screen is worded differently.
//
// The two halves matter in different ways. A locale gap shows English to one
// audience. A dictionary gap shows English to ALL SIX, in every locale at once,
// and no per-locale scan can see it.
//
// How the app decides what to translate (src/scripts/modules/i18n.js):
//
//   applyI18n() walks document.body and, for every element, translates the
//   title / placeholder / aria-label attributes and <option> text; for every
//   text node it translates the trimmed content. The lookup key comes from
//   toEnglishKey(), which tries six case/whitespace variants of the string
//   against KEY_SET, then the reverse maps, then gives up and returns the
//   string unchanged. An unchanged return means DICT[lang][key] misses and the
//   user reads English.
//
// This module executes that real resolution code rather than approximating it,
// for the same reason i18nDict.mjs does: a gate that re-implements the thing it
// measures drifts away from it. The slice runs to getLang(), the first function
// that needs a browser.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseHTML } from "linkedom";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
export const I18N_PATH = "src/scripts/modules/i18n.js";
export const INDEX_PATH = "src/index.html";

// Everything above this needs no DOM: the dictionaries, the merges, KEY_SET,
// the reverse maps, _candKeys and toEnglishKey. getLang() reads localStorage.
const SLICE_MARKER = "export function getLang";
const DOM_IMPORT = /^import \{ broadcastLang \}/;

/**
 * Execute i18n.js's key-resolution half. Returns the same KEY_SET and
 * toEnglishKey the running app uses to decide whether a string is translatable.
 */
export async function loadResolver(root = REPO_ROOT){
  const lines = readFileSync(join(root, I18N_PATH), "utf8").split("\n");
  const cut = lines.findIndex(l => l.startsWith(SLICE_MARKER));
  if (cut < 0){
    throw new Error(`uiStrings: slice marker ${JSON.stringify(SLICE_MARKER)} not found in ${I18N_PATH}`);
  }
  const head = lines.slice(0, cut).filter(l => !DOM_IMPORT.test(l)).join("\n");
  const mod = head + "\nexport { DICT, KEY_SET, FOLD_INDEX, toEnglishKey };\n";
  const url = "data:text/javascript;base64," + Buffer.from(mod, "utf8").toString("base64");
  return await import(url);
}

/**
 * Is this string prose a human reads, or markup furniture?
 *
 * The walk is deliberately greedy — it collects every text node, exactly like
 * applyI18n does — so this filter is what keeps the result honest. It errs
 * toward keeping things: a false keep shows up as one more baselined string
 * somebody can dismiss in review, while a false drop hides a real gap forever.
 *
 * Excluded, with reasons:
 *   - no two consecutive letters — "6", "+", "▼", "↩", "—", "🇰🇷"
 *   - URLs — "https://docs.google.com/spreadsheets/d/..."
 *   - anything with braces — "{metafier} -e {output} {input}" is a command
 *     template; translating it would break the command
 *   - pure digits and punctuation — "00:00:00:00", "01:00:00:00"
 *   - a bare file extension — ".avi", ".mov"
 *   - a filesystem path — "/Applications/...", "~/Library/..."
 */
export function isProse(s){
  if (!/[A-Za-z]{2}/.test(s)) return false;
  if (/^https?:\/\//.test(s)) return false;
  if (/[{}]/.test(s)) return false;
  if (/^[\d:.,\s]+$/.test(s)) return false;
  if (/^\.[A-Za-z0-9]+$/.test(s)) return false;
  if (/^[/~][^\s]*$/.test(s)) return false;
  return true;
}

/**
 * Walk an HTML document the way applyI18n walks the live one and return
 * Map<key, {kinds:Set<string>}> — every string that will reach a dictionary
 * lookup, tagged with where it came from.
 */
export function scanUI(html, toEnglishKey){
  const { document } = parseHTML(html);
  // linkedom hands back an empty body for a bare "<body>…</body>" fragment
  // rather than erroring, so a caller who forgets the wrapper gets a scan that
  // finds nothing and a gate that reports everything is fine. Refuse instead:
  // a detector that never fires is worse than no detector.
  if (!document.body || document.body.childNodes.length === 0){
    throw new Error('uiStrings: parsed document has an empty body — wrap markup in <html><body>…</body></html>');
  }
  const hits = new Map();
  const add = (kind, raw) => {
    const s = String(raw ?? "").trim();
    if (!s) return;
    const k = toEnglishKey(s);
    if (!k) return;
    const cur = hits.get(k) || { kinds: new Set() };
    cur.kinds.add(kind);
    hits.set(k, cur);
  };
  const stack = [document.body];
  while (stack.length){
    const cur = stack.pop();
    if (!cur) continue;
    if (cur.nodeType === 1){
      const tag = (cur.tagName || "").toLowerCase();
      if (tag === "script" || tag === "style") continue;
      if (cur.hasAttribute?.("placeholder")) add("placeholder", cur.getAttribute("placeholder"));
      if (cur.hasAttribute?.("title")) add("title", cur.getAttribute("title"));
      if (cur.hasAttribute?.("aria-label")) add("aria-label", cur.getAttribute("aria-label"));
      if (tag === "option") add("option", cur.textContent);
    }
    if (cur.nodeType === 3) add("text", cur.textContent);
    if (cur.childNodes){
      for (let i = cur.childNodes.length - 1; i >= 0; i--) stack.push(cur.childNodes[i]);
    }
  }
  return hits;
}

/** Prose strings the UI shows that the dictionary has no key for, sorted. */
export function missingFromDict(hits, KEY_SET, kind = null){
  const out = [];
  for (const [key, meta] of hits){
    if (!isProse(key)) continue;
    if (KEY_SET.has(key)) continue;
    if (kind && !meta.kinds.has(kind)) continue;
    out.push(key);
  }
  out.sort();
  return out;
}
