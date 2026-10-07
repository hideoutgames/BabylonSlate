import type { StorageRangeRead, StorageReadMetrics } from "@babylonslate/core";
import { SourceRevisionChangedError } from "@babylonslate/core";

/** Shared validation only; adapters must perform their own bounded I/O. */
export function validateStorageRange(offset: number, length: number, totalSize?: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
      !Number.isSafeInteger(offset + length)) throw new RangeError("Invalid storage byte range");
  if (totalSize !== undefined && (!Number.isSafeInteger(totalSize) || totalSize < 0 || offset + length > totalSize)) {
    throw new RangeError(`Storage byte range ${offset}+${length} exceeds file size ${totalSize}`);
  }
}

export function checkStorageRevision(path: string, revision: string, expectedRevision?: string): void {
  if (!revision) throw new Error(`Storage did not provide a source revision: ${path}`);
  if (expectedRevision !== undefined && expectedRevision !== revision) throw new SourceRevisionChangedError(`Source revision changed: ${path}`);
}

/** Native plugins use an explicit revision code; other I/O failures stay intact. */
export function rethrowNativeStorageRangeError(error: unknown, path: string): never {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "REVISION_CHANGED") {
    throw Object.assign(new SourceRevisionChangedError(`Source revision changed: ${path}`), { cause: error });
  }
  throw error;
}

/** Keep discarded bytes visible through read-only/mounted adapter boundaries. */
export function rethrowStorageReadFailure(error: unknown, actualBytesRead: number): never {
  if (typeof error === "object" && error !== null) {
    try { Object.assign(error, { actualBytesRead }); }
    catch {
      const wrapped = error instanceof SourceRevisionChangedError
        ? new SourceRevisionChangedError(error.message)
        : new Error(error instanceof Error ? error.message : String(error));
      throw Object.assign(wrapped, { actualBytesRead, cause: error });
    }
    throw error;
  }
  throw Object.assign(new Error(String(error), { cause: error }), { actualBytesRead });
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

function failedReadBytes(error: unknown): number {
  let cause: unknown = error;
  for (let depth = 0; depth < 5 && cause && typeof cause === "object"; depth++) {
    const failure = cause as { actualBytesRead?: unknown; data?: { actualBytesRead?: unknown }; cause?: unknown };
    const actual = failure.actualBytesRead ?? failure.data?.actualBytesRead;
    if (typeof actual === "number" && Number.isSafeInteger(actual) && actual >= 0) return actual;
    cause = failure.cause;
  }
  return 0;
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
      this.record("range", requestedBytes, failedReadBytes(error));
      throw error;
    }
    this.record("range", requestedBytes, result.actualBytesRead);
    return result;
  }
  async full(requestedBytes: number, operation: () => Promise<Uint8Array>): Promise<Uint8Array> {
    let bytes: Uint8Array;
    try { bytes = await operation(); }
    catch (error) {
      this.record("full", requestedBytes, failedReadBytes(error));
      throw error;
    }
    this.record("full", requestedBytes, bytes.byteLength);
    return bytes;
  }
  snapshot(): StorageReadMetrics { return { ...this.metrics }; }
}
