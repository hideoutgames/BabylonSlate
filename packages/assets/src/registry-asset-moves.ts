import { SourceRevisionChangedError } from "@haptic/core";
import { stampDocumentChunkName } from "./asset-document";
import type { BlobStore } from "./blob-store";
import { decodeHasset, encodeHasset, readHassetHeader, type ChunkInput, type HassetHeader } from "./hasset";
import { joinRootPath, parentPath, renamedAssetPath } from "./registry-paths";
import type { IndexedAsset, RegistryHost } from "./registry-types";
import { moveStorageFile } from "./storage-move";

export async function moveAssetUnlocked(host: RegistryHost, guid: string, rootId: string, newRelativePath: string): Promise<IndexedAsset> {
  const asset = host.byGuid.get(guid);
  if (!asset) throw new Error(`Unknown asset ${guid}`);
  if (asset.rootId !== rootId) return moveAssetAcrossRoots(host, asset, rootId, newRelativePath);
  const root = host.getRootOrThrow(rootId);
  host.assertWritable(root);
  const storage = host.storageOf(root);
  const newPath = joinRootPath(root, newRelativePath);
  if (newPath === asset.path) return asset;
  return host.withReservedPath(newPath, `Target path already exists: ${newPath}`, async () => {
    const bytes = await storage.readBinary(asset.path);
    await moveStorageFile(storage, asset.path, newPath, bytes);
    // Keep inbound refs: guid identity is unchanged, only the storage path moves.
    if (host.byPath.get(asset.path) === asset) {
      host.byPath.delete(asset.path);
    }
    // A locator names the old path; the next read resolves the moved file.
    const moved: IndexedAsset = { ...asset, path: newPath, locator: undefined };
    host.byGuid.set(guid, moved);
    host.byPath.set(newPath, moved);
    host.repathGuidConflicts((path) => path === asset.path ? newPath : path);
    host.changed();
    return moved;
  });
}

/**
 * Move a file into another writable content root, keeping its guid so every
 * reference to it still resolves. The bytes are copied as they are; first
 * every chunk is verified and each blob chunk is written to the target
 * root's blob store, so no blob locator dangles there. Then the copy is
 * written, the source removed and the index entry moved to the new root.
 * Blobs stay in the source store, where other assets may share them.
 */
async function moveAssetAcrossRoots(host: RegistryHost, asset: IndexedAsset, rootId: string, newRelativePath: string): Promise<IndexedAsset> {
  if (asset.placeholder) throw new Error(`A missing asset cannot be moved: ${asset.header.guid}`);
  const source = host.getRootOrThrow(asset.rootId);
  const target = host.getRootOrThrow(rootId);
  // A move removes the source file, so both roots must take writes.
  host.assertWritable(source);
  host.assertWritable(target);
  const newPath = joinRootPath(target, newRelativePath);
  const conflict = `Target path already exists: ${newPath}`;
  return host.withReservedPath(newPath, conflict, async () => {
    const sourceStorage = host.storageOf(source);
    const targetStorage = host.storageOf(target);
    if (await targetStorage.exists(newPath)) throw new Error(conflict);
    const bytes = await sourceStorage.readBinary(asset.path);
    const header = await copyBlobChunks(bytes, host.blobsOf(source), host.blobsOf(target));
    if (header.guid !== asset.header.guid) {
      throw new SourceRevisionChangedError(`Asset changed on disk before it could be moved: ${asset.path}`);
    }
    const dir = parentPath(newPath);
    if (dir) await targetStorage.mkdir(dir, true);
    await targetStorage.writeBinary(newPath, bytes);
    // If removal fails, the complete copy remains for recovery.
    await sourceStorage.remove(asset.path);
    host.repathGuidConflicts((path) => path === asset.path ? newPath : path);
    return host.indexHeader(target.id, newPath, header, false, await host.statMtime(targetStorage, newPath));
  });
}

export async function renameAssetUnlocked(host: RegistryHost, guid: string, newName: string): Promise<IndexedAsset> {
  const asset = host.byGuid.get(guid);
  if (!asset) throw new Error(`Unknown asset ${guid}`);
  const root = host.roots.get(asset.rootId);
  if (root) host.assertWritable(root);
  const safe = newName.trim();
  const newPath = renamedAssetPath(asset.path, safe);
  if (newPath === asset.path) return rewriteRenamedAsset(host, asset, safe, newPath);
  return host.withReservedPath(newPath, `Target path already exists: ${newPath}`, () => rewriteRenamedAsset(host, asset, safe, newPath));
}

async function rewriteRenamedAsset(host: RegistryHost, asset: IndexedAsset, safe: string, newPath: string): Promise<IndexedAsset> {
  const storage = host.storageForAsset(asset);
  const blobs = host.blobsForAsset(asset);
  const fileBytes = await storage.readBinary(asset.path);
  const decoded = await decodeHasset(fileBytes, (sha256) =>
    blobs.readBlob(sha256),
  );
  const chunksById = new Map<string, ChunkInput>();
  for (const entry of decoded.header.chunks) {
    const data = decoded.chunks.get(entry.id);
    if (data) {
      chunksById.set(entry.id, {
        id: entry.id,
        kind: entry.kind,
        mime: entry.mime,
        data,
      });
    }
  }
  const { chunks, ...headerRest } = decoded.header;
  void chunks;
  stampDocumentChunkName(chunksById, safe);
  const encoded = await encodeHasset({
    header: { ...headerRest, name: safe },
    chunks: [...chunksById.values()],
    writeBlob: (sha256, data) => blobs.writeBlob(sha256, data),
  });
  if (newPath !== asset.path) {
    await moveStorageFile(storage, asset.path, newPath, fileBytes, encoded);
    host.repathGuidConflicts((path) => path === asset.path ? newPath : path);
    return host.indexHeader(asset.rootId, newPath, readHassetHeader(encoded), false, await host.statMtime(storage, newPath));
  }
  await storage.writeBinary(asset.path, encoded);
  return host.indexHeader(asset.rootId, asset.path, readHassetHeader(encoded), false, await host.statMtime(storage, asset.path));
}

/**
 * Verify every chunk of an asset file read from a root using `from` and write
 * each blob chunk to `to`, so the same bytes read in full from a root using
 * `to`. Returns the file's header. Throws, before any file is written, when a
 * chunk is missing or does not match its recorded length and sha256.
 */
export async function copyBlobChunks(bytes: Uint8Array, from: BlobStore, to: BlobStore): Promise<HassetHeader> {
  const decoded = await decodeHasset(bytes, (sha256) => from.readBlob(sha256));
  for (const entry of decoded.header.chunks) {
    if ("blob" in entry.locator) await to.writeBlob(entry.locator.blob, decoded.chunks.get(entry.id)!);
  }
  return decoded.header;
}
