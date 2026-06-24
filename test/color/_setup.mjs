// test/color/_setup.mjs — browser globals the color services expect under Node.
// DOMParser via linkedom (amfBuilder/amfReader/exportClf build & parse XML);
// crypto is already global in Node 20+ (used for AMF uuids). Test-only.
import { DOMParser } from 'linkedom';
if (!globalThis.DOMParser) globalThis.DOMParser = DOMParser;
// Node ≥ 20 has globalThis.crypto (webcrypto); guard for older runners.
if (!globalThis.crypto) {
  const { webcrypto } = await import('node:crypto');
  globalThis.crypto = webcrypto;
}
