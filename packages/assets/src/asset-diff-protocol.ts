import { AssetVersionCache, diffAssetVersions, type AssetDiff, type AssetVersionSource } from "./asset-diff";

export type DiffSide = "base" | "compare";

/** The main thread asks for a diff; the worker reads through it, since storage and Git live there. */
export type AssetDiffRequestMessage =
  | { type: "diff"; id: number; path: string; base: { key: string | null }; compare: { key: string | null } }
  | { type: "read-result"; id: number; read: number; bytes: Uint8Array | null }
  | { type: "read-error"; id: number; read: number; message: string; code?: string }
  | { type: "cancel"; id: number };

export type AssetDiffReplyMessage =
  | { type: "read"; id: number; read: number; side: DiffSide; blob?: { sha256: string; byteLength: number } }
  | { type: "result"; id: number; diff: AssetDiff }
  | { type: "error"; id: number; message: string; code?: string };

/** An error carried across the worker boundary, with the `SyncError` code it had (`lfs-object-missing`). */
export class AssetDiffError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "AssetDiffError";
    if (code) this.code = code;
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The rasters' buffers, which the reply moves to the main thread without a
 * copy: each diff reads its own and the cache keeps none (`AssetVersion.chunk`).
 * Base and compare share one when the raster did not change.
 */
function rasterBuffers(diff: AssetDiff): Transferable[] {
  if (diff.view.kind !== "texture") return [];
  const buffers = new Set<ArrayBuffer>();
  for (const raster of [diff.view.base, diff.view.compare]) {
    const bytes = raster?.bytes;
    // A view of a larger buffer is cloned with the reply instead (its buffer may hold more).
    if (bytes && bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) buffers.add(bytes.buffer);
  }
  return [...buffers];
}

/**
 * The worker side: decodes and diffs, asking the main thread for each read,
 * and keeps decoded versions of commits (`path@commit`) for the next diff.
 */
export function createAssetDiffHandler(post: (message: AssetDiffReplyMessage, transfer?: Transferable[]) => void, cache = new AssetVersionCache()) {
  let reads = 0;
  const pending = new Map<number, { id: number; resolve: (bytes: Uint8Array | null) => void; reject: (error: Error) => void }>();
  const cancelled = new Set<number>();

  const read = (id: number, side: DiffSide, blob?: { sha256: string; byteLength: number }) =>
    new Promise<Uint8Array | null>((resolve, reject) => {
      if (cancelled.has(id)) {
        reject(new AssetDiffError("Cancelled."));
        return;
      }
      reads += 1;
      pending.set(reads, { id, resolve, reject });
      post({ type: "read", id, read: reads, side, ...(blob ? { blob } : {}) });
    });

  const source = (id: number, side: DiffSide, key: string | null): AssetVersionSource => ({
    key,
    read: () => read(id, side),
    readBlob: async (sha256, byteLength) => {
      const bytes = await read(id, side, { sha256, byteLength });
      if (!bytes) throw new AssetDiffError(`Blob ${sha256} is missing.`, "lfs-object-missing");
      return bytes;
    },
  });

  return (message: AssetDiffRequestMessage): void => {
    switch (message.type) {
      case "diff": {
        const { id } = message;
        diffAssetVersions(message.path, source(id, "base", message.base.key), source(id, "compare", message.compare.key), cache).then(
          (diff) => {
            if (cancelled.delete(id)) return;
            post({ type: "result", id, diff }, rasterBuffers(diff));
          },
          (error: unknown) => {
            if (cancelled.delete(id)) return;
            const code = errorCode(error);
            post({ type: "error", id, message: errorMessage(error), ...(code ? { code } : {}) });
          },
        );
        return;
      }
      case "read-result":
      case "read-error": {
        const waiting = pending.get(message.read);
        if (!waiting) return;
        pending.delete(message.read);
        if (message.type === "read-result") waiting.resolve(message.bytes);
        else waiting.reject(new AssetDiffError(message.message, message.code));
        return;
      }
      case "cancel": {
        cancelled.add(message.id);
        for (const [readId, waiting] of pending) {
          if (waiting.id !== message.id) continue;
          pending.delete(readId);
          waiting.reject(new AssetDiffError("Cancelled."));
        }
        return;
      }
    }
  };
}
