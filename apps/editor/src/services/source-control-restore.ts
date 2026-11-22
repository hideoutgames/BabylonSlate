import { readHassetHeader } from "@haptic/assets/hasset";
import type { ProjectStorage } from "@haptic/core";
import type { LfsFile, SyncPort } from "@haptic/source-control";
import { assetBlobFolder } from "../lib/source-control-changes";

function parentOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/**
 * Makes the working copy's `path` what `commit` holds: the file and every
 * blob its chunks are stored in, or no file when the commit has none. Blobs
 * the copy lacks (or holds at another size) are downloaded straight into
 * their files first (`SyncPort.downloadLfsObjects`: natively on a device, so
 * their bytes never enter JavaScript), and the asset is written only once
 * every one is there, so it never names a blob that is not. A blob already
 * present keeps its file (it never changes under its name). A blob that
 * cannot be had rejects with the asset untouched; blobs that did arrive stay,
 * untracked. Returns the asset paths written or removed.
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
  const blobs = new Map<string, LfsFile>();
  const folder = path.endsWith(".hasset") ? assetBlobFolder(path) : null;
  if (folder) {
    for (const chunk of readHassetHeader(bytes).chunks) {
      if (!("blob" in chunk.locator)) continue;
      const blobPath = `${folder}/${chunk.locator.blob}`;
      blobs.set(blobPath, { path: blobPath, size: chunk.byteLength });
    }
  }
  if (blobs.size > 0) {
    await storage.mkdir(folder!, true);
    await port.downloadLfsObjects([...blobs.values()], signal ? { signal } : {});
  }
  signal?.throwIfAborted();
  const parent = parentOf(path);
  if (parent !== "") await storage.mkdir(parent, true);
  await storage.writeBinary(path, bytes);
  return [path];
}
