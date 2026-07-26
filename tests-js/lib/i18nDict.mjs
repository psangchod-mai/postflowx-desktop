// Load the renderer's merged translation dictionary the way the app builds it.
//
// src/scripts/modules/i18n.js assembles DICT from four literal dictionaries
// (DICT, EXTRA_DICT, LOCALE_FULL_DICT, ERROR_DICT) plus a parity backfill, each
// folded in by its own merge loop. Re-deriving that by parsing the source would
// mean re-implementing the merges, and a gate that re-implements the thing it
// measures drifts away from it. So we execute the real code instead: take the
// source up to the point where the merges are finished, drop the one relative
// import (it pulls in DOM-dependent modules), append an export, and import it.
//
// The slice boundary is the "Build key set" comment — everything above it is
// dictionary construction, everything below it needs a browser.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
export const I18N_PATH = "src/scripts/modules/i18n.js";

// Everything above this line is dictionary literals + merge loops.
const SLICE_MARKER = "// Build key set + reverse maps";
// The file's only relative import, and the only line that needs the DOM.
const DOM_IMPORT = /^import \{ broadcastLang \}/;

export function readI18nSource(root = REPO_ROOT){
  return readFileSync(join(root, I18N_PATH), "utf8");
}

/**
 * Execute i18n.js's dictionary-construction half and hand back the merged DICT.
 * Returns the same object the app's t() reads from.
 */
export async function loadDict(root = REPO_ROOT){
  const src = readI18nSource(root);
  const lines = src.split("\n");
  const cut = lines.findIndex(l => l.startsWith(SLICE_MARKER));
  if (cut < 0){
    throw new Error(`i18nDict: slice marker ${JSON.stringify(SLICE_MARKER)} not found in ${I18N_PATH}`);
  }
  const head = lines.slice(0, cut).filter(l => !DOM_IMPORT.test(l)).join("\n");
  const mod = head + "\nexport { DICT };\n";
  // A data: URL keeps this side-effect free — no temp files, no import cache to bust.
  const url = "data:text/javascript;base64," + Buffer.from(mod, "utf8").toString("base64");
  const { DICT } = await import(url);
  return DICT;
}

/** Every key any locale carries. English is the key space itself, so it has no entries. */
export function allKeys(dict){
  const keys = new Set();
  for (const map of Object.values(dict)){
    for (const k of Object.keys(map || {})) keys.add(k);
  }
  return keys;
}

/**
 * A key is "proven translatable" for locale L when some OTHER locale renders it
 * as something other than the English key. That is the honest bar: it means a
 * human already decided this string can be said in another language, so L
 * falling back to English is a gap rather than a deliberate loanword.
 *
 * Without this filter the scan would demand Tagalog for "Lens Flare" and
 * Indonesian for "VFX Marker" — terms those locales keep in English on purpose,
 * as their own existing entries show.
 */
export function provablyTranslatable(dict, locale, key, locales){
  for (const other of locales){
    if (other === locale) continue;
    const v = dict[other] && dict[other][key];
    if (typeof v === "string" && v.trim() && v !== key) return true;
  }
  return false;
}

/**
 * Split a locale's shortfall into the two species this repo distinguishes:
 *
 *   absent   — no entry at all, so t() returns the English key. Always a defect
 *              when the key is provably translatable.
 *   identity — an entry whose value equals its key. Sometimes correct (a locale
 *              deliberately keeping a proper noun in English), sometimes a
 *              silent no-op. Recorded, not assumed to be a bug.
 */
export function untranslated(dict, locale, locales){
  const absent = [];
  const identity = [];
  for (const key of allKeys(dict)){
    if (!provablyTranslatable(dict, locale, key, locales)) continue;
    const map = dict[locale] || {};
    if (!(key in map)) absent.push(key);
    else if (map[key] === key) identity.push(key);
  }
  absent.sort();
  identity.sort();
  return { absent, identity };
}
