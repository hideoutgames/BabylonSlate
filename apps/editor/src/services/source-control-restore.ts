import { readHassetHeader } from "@haptic/assets";
import { isStorageNotFound, type ProjectStorage } from "@haptic/core";
import type { SyncPort } from "@haptic/source-control";

/** The blob folder of the content root an asset sits in (`assets/.blobs`, `plugins/<name>/assets/.blobs`), or null outside one. */
export function assetBlobFolder(path: string): string | null {
  const root = /^((?:plugins\/[^/]+\/)?assets)\//.exec(path);
  return root ? `${root[1]}/.blobs` : null;
}

function parentOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

async function write(storage: ProjectStorage, path: string, bytes: Uint8Array): Promise<void> {
  const parent = parentOf(path);
  if (parent !== "") await storage.mkdir(parent, true);
  await storage.writeBinary(path, bytes);
}

async function sizeOf(storage: ProjectStorage, path: string): Promise<number | null> {
  try {
    return (await storage.stat(path)).size ?? null;
  } catch (error) {
    if (isStorageNotFound(error)) return null;
    throw error;
  }
}

/**
 * Makes the working copy's `path` what `commit` holds: the file and every
 * blob its chunks are stored in, or no file when the commit has none. Blobs
 * the copy lacks are downloaded before anything is written, and written
 * before the asset, so the asset never names a blob that is not there. A
 * blob already present keeps its file (it never changes under its name).
 * Returns the asset paths written or removed.
 */
export async function restoreVersion({ port, storage, path, commit, signal }: {
  port: SyncPort;
  storage: ProjectStorage;
  path: string;
  /** Null for a version with no commit (no remote branch yet): the asset is absent there. */
  commit: string | null;
  signal?: AbortSignal;
}): Promise<string[]> {
  const bytes = commit ? await port.readFile(path, commit) : null;
  if (!bytes) {
    if (await storage.exists(path)) await storage.remove(path);
    return [path];
  }
  const blobs: { path: string; bytes: Uint8Array }[] = [];
  if (path.endsWith(".hasset")) {
    const folder = assetBlobFolder(path);
    for (const chunk of readHassetHeader(bytes).chunks) {
      if (!("blob" in chunk.locator) || !folder) continue;
      const blobPath = `${folder}/${chunk.locator.blob}`;
      if (blobs.some((blob) => blob.path === blobPath) || (await sizeOf(storage, blobPath)) === chunk.byteLength) continue;
      blobs.push({ path: blobPath, bytes: await port.readLfsObject(blobPath, chunk.byteLength, signal ? { signal } : {}) });
    }
  }
  signal?.throwIfAborted();
  for (const blob of blobs) await write(storage, blob.path, blob.bytes);
  await write(storage, path, bytes);
  return [path];
}
