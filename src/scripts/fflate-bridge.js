// scripts/fflate-bridge.js — V 2026.02.18 (hotfix 2)
// ZIP helpers used by PostFlowX (Chrome Extension)
//
// ✅ Supported:
//   • .fcpxmld          (FCPXML bundle-as-zip)  → returns inner .fcpxml text
//   • .xmld             (generic XML bundle)    → returns inner .fcpxml OR .xml text
//   • .otioz            (OTIO bundle-as-zip)    → returns parsed OTIO JSON object
//
// Implementation note:
// - We avoid heavyweight ZIP libraries.
// - Uses a tiny ZIP reader (lib/zip.js) powered by DecompressionStream.
// - IMPORTANT: bundle zips can be huge; we only extract the one file we need.

import { unzipOne, strFromU8 } from "../lib/zip.js";

function isZip(u8){
  return !!(u8 && u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4B && u8[2] === 0x03 && u8[3] === 0x04);
}

async function readFileU8(file){
  if (!file) throw new Error("Missing file");
  if (file instanceof Uint8Array) return file;
  if (file.arrayBuffer){
    const ab = await file.arrayBuffer();
    return new Uint8Array(ab);
  }
  // Fallback (rare): try text → bytes
  if (file.text){
    const txt = await file.text();
    return new TextEncoder().encode(txt);
  }
  throw new Error("Invalid file input");
}

function extractJsonLoose(txt){
  const s = String(txt || "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) return s.slice(a, b + 1);
  return s;
}

async function extractPreferredTextFromZip(u8, preferExtsLower){
  // Prefer exact-ish common names first (Info/Index), then first match by extension order.
  const preferNames = [
    "info.fcpxml", "Info.fcpxml", "index.fcpxml", "Index.fcpxml",
    "content.fcpxml", "Content.fcpxml",
    "content.xml", "Content.xml", "index.xml", "Index.xml",
  ].map(s=>s.toLowerCase());

  // 1) Try preferred names
  for (const pn of preferNames){
    const hit = await unzipOne(u8, (name)=>{
      const lname = String(name).toLowerCase();
      if (lname.endsWith('/')) return false;
      return lname.endsWith(pn);
    });
    if (hit) return strFromU8(hit.bytes);
  }

  // 2) Try by extension preference order
  for (const ext of preferExtsLower){
    const hit = await unzipOne(u8, (name)=>{
      const lname = String(name).toLowerCase();
      if (lname.endsWith('/')) return false;
      return lname.endsWith(ext);
    });
    if (hit) return strFromU8(hit.bytes);
  }

  return null;
}

// .fcpxmld (FCPXML bundle)
export async function loadFCPXMLD(file){
  const u8 = await readFileU8(file);

  // Not a ZIP: treat as plain xml text
  if (!isZip(u8)) return strFromU8(u8);

  const txt = await extractPreferredTextFromZip(u8, ['.fcpxml']);
  if (!txt) throw new Error("No .fcpxml found in .fcpxmld package");
  return txt;
}

// .xmld (generic “XML bundle”): may contain .fcpxml OR .xml
export async function loadXMLD(file){
  const u8 = await readFileU8(file);
  if (!isZip(u8)) return strFromU8(u8);

  const txt = await extractPreferredTextFromZip(u8, ['.fcpxml', '.xml']);
  if (!txt) throw new Error("No .fcpxml/.xml found in .xmld package");
  return txt;
}

export async function loadOTIOZ(file){
  const u8 = await readFileU8(file);

  // Not a ZIP: try JSON anyway (sometimes a .otio gets renamed to .otioz)
  if (!isZip(u8)){
    const txt = strFromU8(u8);
    try { return JSON.parse(extractJsonLoose(txt)); }
    catch { throw new Error("File does not contain valid OTIO JSON"); }
  }

  const hit = await unzipOne(u8, (name)=> String(name).toLowerCase().endsWith('.otio'));
  if (!hit) throw new Error("OTIOZ does not contain a .otio file");

  const txt = strFromU8(hit.bytes);
  try { return JSON.parse(extractJsonLoose(txt)); }
  catch { throw new Error("OTIOZ contains malformed OTIO JSON"); }
}
