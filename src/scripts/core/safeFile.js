// ─────────────────────────────────────────────────────────────────────────────
// safeFile.js — crash-safe, corruption-resilient text/JSON file IO.
//
// Professional-grade data integrity for project saves. Every write:
//   1. snapshots the current good copy to "<name>.bak" before overwriting,
//   2. writes the new content,
//   3. reads it back and verifies it committed byte-for-byte,
//   4. on mismatch, restores the backup and throws — so a save NEVER silently
//      replaces good data with a truncated/corrupt file.
// Reads transparently fall back to "<name>.bak" when the primary is missing,
// empty, or unparseable, so the last good save is always recoverable.
//
// The directory handle is injected (a FileSystemDirectoryHandle, or any object
// exposing getFileHandle/createWritable/getFile), which keeps this module pure
// and unit-testable in Node with an in-memory mock.
// ─────────────────────────────────────────────────────────────────────────────

export const BAK_SUFFIX = '.bak';

async function readHandleText(fileHandle) {
  const file = await fileHandle.getFile();
  return await file.text();
}

/** Read a file's text, or null if it doesn't exist / can't be read. */
export async function readTextIfExists(dirHandle, filename) {
  try {
    const fh = await dirHandle.getFileHandle(filename, { create: false });
    return await readHandleText(fh);
  } catch {
    return null;
  }
}

async function writeRaw(dirHandle, filename, text) {
  const fh = await dirHandle.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

/**
 * Crash-safe text write with backup + read-back verification.
 * Throws if the written bytes don't match (after restoring the prior copy).
 */
export async function safeWriteText(dirHandle, filename, text) {
  const str = String(text ?? '');

  // 1. Snapshot the current good copy → "<name>.bak" (best-effort).
  try {
    const prev = await readTextIfExists(dirHandle, filename);
    if (prev != null && prev.length) {
      await writeRaw(dirHandle, filename + BAK_SUFFIX, prev);
    }
  } catch { /* backup is best-effort; never block the write on it */ }

  // 2. Write the new content.
  await writeRaw(dirHandle, filename, str);

  // 3. Verify it committed intact.
  const back = await readTextIfExists(dirHandle, filename);
  if (back !== str) {
    // 4. Corrupt/partial write — restore the previous good copy and fail loudly
    //    so the caller reports an error instead of a false success.
    try {
      const prev = await readTextIfExists(dirHandle, filename + BAK_SUFFIX);
      if (prev != null) await writeRaw(dirHandle, filename, prev);
    } catch { /* ignore restore failure — we still throw below */ }
    throw new Error(`safeWriteText: verification failed for "${filename}" (restored previous version)`);
  }

  return true;
}

/**
 * Read + JSON.parse, falling back to "<name>.bak" if the primary is
 * missing / empty / unparseable. Returns null if neither is usable.
 * `onRecover(filename)` is invoked when the backup is used.
 */
export async function safeReadJSON(dirHandle, filename, onRecover) {
  // Primary
  try {
    const fh = await dirHandle.getFileHandle(filename, { create: false });
    const text = await readHandleText(fh);
    return JSON.parse(text);
  } catch { /* fall through to backup */ }

  // Backup
  try {
    const bh = await dirHandle.getFileHandle(filename + BAK_SUFFIX, { create: false });
    const text = await readHandleText(bh);
    const parsed = JSON.parse(text);
    try { if (typeof onRecover === 'function') onRecover(filename); } catch { /* noop */ }
    return parsed;
  } catch {
    return null;
  }
}
