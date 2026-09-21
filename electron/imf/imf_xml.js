'use strict';

/**
 * imf_xml.js — Minimal namespace-agnostic XML text extractor for Node.js.
 *
 * IMF XML uses arbitrary namespace prefixes (r0:, dcml:, etc.). This module
 * matches elements by local name only, ignoring prefixes.
 *
 * No external dependencies — uses string/regex operations only.
 */

// ── Core helpers ──────────────────────────────────────────────────────────────

/**
 * Return the text content of the FIRST child element matching `localName`
 * anywhere in `xml`. Handles namespace prefixes.
 */
function getText(xml, localName) {
  // Matches <prefix:LocalName ...>text</prefix:LocalName> or <LocalName>text</LocalName>.
  // The content group allows CDATA sections (which begin with '<') as well as plain
  // text — a plain `[^<]*` capture stopped at the '<' of '<![CDATA[' and silently
  // dropped CDATA-wrapped values (titles with special chars).
  const re = new RegExp(
    `<(?:[a-zA-Z][a-zA-Z0-9_]*:)?${localName}(?:\\s[^>]*)?>((?:<!\\[CDATA\\[[\\s\\S]*?\\]\\]>|[^<])*)</(?:[a-zA-Z][a-zA-Z0-9_]*:)?${localName}>`,
    'i',
  );
  const m = xml.match(re);
  if (!m) return '';
  // Strip any CDATA wrappers (handles pure and mixed text+CDATA content).
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

/**
 * Return array of inner-XML strings for ALL elements matching `localName`.
 * Works for flat lists (Asset, Reel, Resource) where elements don't nest same-name.
 */
function getAllBlocks(xml, localName) {
  const openRe = new RegExp(
    `<(?:[a-zA-Z][a-zA-Z0-9_]*:)?${localName}(?:\\s[^>]*)?>`,
    'g',
  );
  const closeRe = new RegExp(
    `</(?:[a-zA-Z][a-zA-Z0-9_]*:)?${localName}>`,
    'g',
  );
  const results = [];
  let m;
  openRe.lastIndex = 0;
  while ((m = openRe.exec(xml)) !== null) {
    const contentStart = m.index + m[0].length;
    closeRe.lastIndex = contentStart;
    const closeM = closeRe.exec(xml);
    if (!closeM) break;
    results.push(xml.slice(contentStart, closeM.index));
    // Advance past this block so the next open-tag search starts after it
    openRe.lastIndex = closeM.index + closeM[0].length;
  }
  return results;
}

/**
 * Return the FIRST block matching `localName` or '' if none.
 */
function getFirstBlock(xml, localName) {
  return getAllBlocks(xml, localName)[0] || '';
}

/**
 * Deep search: return text content of the first `localName` element
 * found anywhere in `xml` (recursively, any depth).
 * Same as getText but doesn't require the tag to be a direct child.
 */
function deepText(xml, localName) {
  return getText(xml, localName);
}

/**
 * Parse an IMF EditRate string "24000 1001" or "24" into a float.
 * Returns NaN if input is invalid.
 */
function parseEditRate(s) {
  if (!s) return NaN;
  const parts = s.trim().split(/\s+/);
  if (parts.length === 2) {
    const n = Number(parts[0]);
    const d = Number(parts[1]);
    return d > 0 ? n / d : NaN;
  }
  return Number(parts[0]) || NaN;
}

/**
 * Normalise a UUID string: strip "urn:uuid:" prefix, lowercase.
 */
function normaliseUuid(s) {
  return (s || '').replace(/^urn:uuid:/i, '').trim().toLowerCase();
}

module.exports = { getText, getAllBlocks, getFirstBlock, deepText, parseEditRate, normaliseUuid };
