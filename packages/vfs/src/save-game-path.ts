/** Filesystem-neutral keys retain case and Unicode identity on every host. */
export function saveGameSegments(key: string, allowRoot = false): string[] {
  if (typeof key !== "string" || key.includes("\\") || key.includes("\0")) throw new Error("Invalid save storage key");
  if (key === "" && allowRoot) return [];
  const parts = key.replace(/\/$/, "").split("/");
  if (parts.some(part => !part || part === "." || part === ".." || new TextEncoder().encode(part).length > 120)) {
    throw new Error("Invalid save storage key");
  }
  return parts;
}

export function encodeSaveGameSegment(segment: string): string {
  return `k${Array.from(new TextEncoder().encode(segment), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function decodeSaveGameSegment(segment: string): string | null {
  if (!/^k(?:[0-9a-f]{2})+$/.test(segment)) return null;
  try {
    const bytes = Uint8Array.from(segment.slice(1).match(/../g)!, byte => parseInt(byte, 16));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { return null; }
}

export function saveGameErrorCode(error: unknown): string {
  return String((error as { code?: unknown } | null)?.code ?? "");
}

export function isSaveGameMissing(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "NotFoundError" ||
    ["ENOENT", "OS-PLUG-FILE-0008"].includes(saveGameErrorCode(error));
}

export function normalizeSaveGameStorageError(error: unknown): never {
  const code = saveGameErrorCode(error);
  const message = String((error as { message?: unknown } | null)?.message ?? error);
  if (["ENOSPC", "EDQUOT"].includes(code) || /\b(?:ENOSPC|no space left on device|disk full)\b/i.test(message)) {
    const full = new Error("Save storage is full", { cause: error });
    full.name = "StorageFullError";
    throw full;
  }
  throw error;
}

/** No unlocked fallback: otherwise separate contexts could commit the same generation. */
export function withSaveGameWebLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks) return Promise.reject(new Error("This host does not support safe save storage locking"));
  return locks.request(`babylonslate:game-saves:${key}`, { mode: "exclusive" }, operation);
}
