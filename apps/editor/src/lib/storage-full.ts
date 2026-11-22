/**
 * Whether `error` (or the error it wraps) says the device or browser storage
 * is full: `QuotaExceededError` (OPFS, IndexedDB, localStorage), `ENOSPC` /
 * `EDQUOT` (Node and Electron, Android's `IOException` text), or the iOS
 * Foundation message a Capacitor write passes on ("…there isn't enough space").
 */
export function isStorageFull(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 4; depth++) {
    const record = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if (record.name === "QuotaExceededError" || record.name === "StorageFullError") return true;
    if (record.code === "ENOSPC" || record.code === "EDQUOT") return true;
    if (typeof record.message === "string" && STORAGE_FULL_TEXT.test(record.message)) return true;
    current = record.cause;
  }
  return false;
}

const STORAGE_FULL_TEXT = /\b(?:ENOSPC|EDQUOT)\b|no space left|not enough (?:free )?(?:space|storage)|isn[’']t enough space|out of (?:disk )?space|quota (?:has been )?exceeded|disk (?:is )?full/i;

export const STORAGE_FULL_MESSAGE =
  "There is not enough storage space on this device. Free some space, then save again; unsaved changes stay open in the editor.";

/** A storage-full failure as the message the editor shows (`… Failed: <message>`), or null for any other error. */
export function storageFullError(error: unknown): Error | null {
  if (!isStorageFull(error)) return null;
  const full = new Error(STORAGE_FULL_MESSAGE, { cause: error });
  full.name = "StorageFullError";
  return full;
}
