// modules/filters_vfxRename.js
// -----------------------------------------------------------------------------
// VFX Rename filter for PostFlowX
// - ใช้กับ Quick Settings: VFX Rename
// - แสดงเฉพาะ event ที่ "clipName ถูก rename" จาก OCF name
//   • ocfStem = stem(srcFile) หรือ stem(reel) ถ้าไม่มี srcFile
//   • clipStem = stem(clipName)
//   • include เฉพาะกรณี clipStem !== ocfStem
// - ตัดชื่อ/ชนิดที่ดูเหมือน Nested / Compound / Multicam / Sequence ออก
// - เตรียมข้อมูล locator ไว้สำหรับ EDL Export (ตัว EDL exporter จะเขียน LOC เอง)
// -----------------------------------------------------------------------------

/**
 * ตัดนามสกุลออก เหลือแต่ชื่อไฟล์
 */
function stemNoExt(path = "") {
  const s = String(path || "");
  const i = s.lastIndexOf(".");
  return i > 0 ? s.slice(0, i) : s;
}

/**
 * clip ที่ไม่ต้องการในโหมด VFX Rename:
 *   - มีคำว่า compound / nested / multicam / sequence / sub-sequence / sub timeline
 */
const NESTED_LIKE = /(compound|nested|multicam|sequence|sub[-\s]?sequence|sub[-\s]?timeline)/i;

/**
 * ตรวจว่า event ดูเหมือน nested/compound/multicam/sequence หรือไม่
 */
function isNestedLike(ev) {
  const name = String(ev.clipName || ev.reel || "").toLowerCase();
  const role = String(ev.role || ev.videoRole || "").toLowerCase();
  return NESTED_LIKE.test(name) || NESTED_LIKE.test(role);
}

/**
 * สร้าง locator text มาตรฐาน สำหรับ VFX Rename
 * NOTE: TC here is the raw (pre-rebuild) recIn. The actual EDL uses
 * ev._recInFixed (rebuilt sequential TC) via locatorLine() in edl_export.js.
 * This field is used for reference / display only.
 */
function buildVfxRenameLocator(ev) {
  const tc   = ev.recIn || ev.srcIn || "00:00:00:00";
  const clip = stemNoExt(ev.clipName || "CLIP");
  return `LOC: ${tc} RED ${clip}`;
}

/**
 * onlyVfxRename(events)
 *  - คืน array ใหม่ ที่มีเฉพาะ event ที่ clipName ถูก rename จาก OCF
 *  - ใส่ field helper:
 *      • ev.vfxRename = true
 *      • ev.locatorVFX = "LOC: .. GREEN .."
 */
export function onlyVfxRename(events = []) {
  if (!Array.isArray(events) || !events.length) return [];

  const out = [];

  events.forEach((ev, idx) => {
    const srcStem =
      stemNoExt(ev.srcFile || "") ||
      stemNoExt(ev.reel || "") ||
      "";

    const clipStem = stemNoExt(ev.clipName || "");

    // ถ้าไม่มีทั้ง srcStem และ clipStem → ไม่มีข้อมูลพอ จะไม่ดึงมา
    if (!srcStem || !clipStem) return;

    // ถ้า clipStem == srcStem → ยังไม่ถือว่า rename → skip
    if (clipStem === srcStem) return;

    // ถ้าเป็นชื่อที่ดูเหมือน nested/compound/multicam → skip
    if (isNestedLike(ev)) return;

    const loc = buildVfxRenameLocator(ev);

    out.push({
      ...ev,
      id: typeof ev.id === "number" ? ev.id : idx,
      vfxRename: true,
      locatorVFX: loc
    });
  });

  return out;
}

// default export เพื่อให้ import * as VFXRename ใช้ได้
export default {
  onlyVfxRename
};
