import type { StorageRangeRead, StorageReadMetrics } from "@babylonslate/core";

/** Shared validation only; adapters must perform their own bounded I/O. */
export function validateStorageRange(offset: number, length: number, totalSize?: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
      !Number.isSafeInteger(offset + length)) throw new RangeError("Invalid storage byte range");
  if (totalSize !== undefined && (!Number.isSafeInteger(totalSize) || totalSize < 0 || offset + length > totalSize)) {
    throw new RangeError(`Storage byte range ${offset}+${length} exceeds file size ${totalSize}`);
  }
}

export function checkStorageRevision(path: string, revision: string, expectedRevision?: string): void {
  if (!revision || (expectedRevision !== undefined && expectedRevision !== revision)) {
    throw new Error(`Source revision changed: ${path}`);
  }
}

export function validateStorageRangeResult(path: string, offset: number, length: number,
  result: StorageRangeRead, expectedRevision?: string): StorageRangeRead {
  validateStorageRange(offset, length, result.totalSize);
  checkStorageRevision(path, result.revision, expectedRevision);
  if (result.bytes.byteLength !== length || !Number.isSafeInteger(result.actualBytesRead) || result.actualBytesRead < length) {
    throw new Error(`Invalid storage range response: ${path}`);
  }
  return result;
}

export class StorageReadCounter {
  private readonly metrics: StorageReadMetrics = { operations: 0, fullReads: 0, rangeReads: 0, requestedBytes: 0, actualBytesRead: 0 };
  record(kind: "full" | "range", requestedBytes: number, actualBytesRead = requestedBytes): void {
    if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 0 || !Number.isSafeInteger(actualBytesRead) || actualBytesRead < 0) {
      throw new Error("Invalid storage byte accounting");
    }
    this.metrics.operations++;
    this.metrics[kind === "full" ? "fullReads" : "rangeReads"]++;
    this.metrics.requestedBytes += requestedBytes;
    this.metrics.actualBytesRead += actualBytesRead;
  }
  async range<T extends { actualBytesRead: number }>(requestedBytes: number, operation: () => Promise<T>): Promise<T> {
    let result: T;
    try { result = await operation(); }
    catch (error) {
      // Capacitor preserves rejection data; Node can report the same value
      // directly. Bytes read before a failed revision check still count.
      let actualBytesRead = 0;
      let cause: unknown = error;
      for (let depth = 0; depth < 5 && cause && typeof cause === "object"; depth++) {
        const failure = cause as { actualBytesRead?: unknown; data?: { actualBytesRead?: unknown }; cause?: unknown };
        const actual = failure.actualBytesRead ?? failure.data?.actualBytesRead;
        if (typeof actual === "number" && Number.isSafeInteger(actual) && actual >= 0) { actualBytesRead = actual; break; }
        cause = failure.cause;
      }
      this.record("range", requestedBytes, actualBytesRead);
      throw error;
    }
    this.record("range", requestedBytes, result.actualBytesRead);
    return result;
  }
  snapshot(): StorageReadMetrics { return { ...this.metrics }; }
}
