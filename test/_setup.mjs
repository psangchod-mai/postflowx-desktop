// test/_setup.mjs — install the browser globals the renderer parsers expect,
// BEFORE any parser module is imported. Import this first in every test file.
//
// The parsers run in Electron's renderer (real browser APIs). For Node tests we
// shim only what they touch: DOMParser (linkedom — supports querySelector, which
// @xmldom/xmldom does not) and chrome.runtime.getURL (otio/edl dynamic-import).
// These shims are TEST-ONLY and must never be imported by shipped code.
import { DOMParser } from 'linkedom';

if (!globalThis.DOMParser) globalThis.DOMParser = DOMParser;
if (!globalThis.chrome) {
  globalThis.chrome = { runtime: { getURL: (p) => new URL(p, import.meta.url).href } };
}
