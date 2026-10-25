import { SourceRevisionChangedError } from "@haptic/core";
import type { ContentRoot } from "./content-root";
import type { HassetHeader } from "./hasset";
import { copyBlobChunks } from "./registry-asset-moves";
import { isWithinFolder, joinRelative, joinRootPath } from "./registry-paths";
import { FOLDER_MARKER_NAME, type RegistryHost } from "./registry-types";
import { copyStorageTree, moveStorageTree } from "./storage-move";

export async function deleteFolderUnlocked(host: RegistryHost, rootId: string, relativeFolder: string): Promise<void> {
  const root = host.getRootOrThrow(rootId);
  host.assertWritable(root);
  const storage = host.storageOf(root);
  const folderPath = joinRootPath(root, relativeFolder);
  // The recursive remove below would also delete files the index does not show.
  const hidden = [...host.guidConflicts.values()].find((conflict) =>
    conflict.rootId === rootId && isWithinFolder(conflict.path, folderPath));
  if (hidden) {
    throw new Error(`Cannot delete ${folderPath}: it holds ${hidden.path}, which is not listed because ${hidden.indexedPath} has the same asset id. Remove that file outside the editor first.`);
  }
  for (const asset of [...host.byGuid.values()]) {
    if (asset.rootId === rootId && isWithinFolder(asset.path, folderPath)) {
      await host.deleteAssetUnlocked(asset.header.guid);
    }
  }
  await storage.remove(folderPath);
  for (const known of [...host.knownFolders]) {
    if (isWithinFolder(known, folderPath)) {
      host.removeKnownFolder(known);
    }
  }
}

export async function createFolderUnlocked(host: RegistryHost, rootId: string, relativeFolder: string): Promise<void> {
  const root = host.getRootOrThrow(rootId);
  host.assertWritable(root);
  const folderPath = joinRootPath(root, relativeFolder);
  if (!relativeFolder.replace(/^\/+|\/+$/g, "")) {
    throw new Error("Cannot create the assets root folder");
  }
  const conflict = `Folder already exists: ${folderPath}`;
  if (host.knownFolders.has(folderPath)) throw new Error(conflict);
  return host.withReservedPath(folderPath, conflict, () => writeCreatedFolder(host, root, folderPath, conflict));
}

export async function writeCreatedFolder(host: RegistryHost, root: ContentRoot, folderPath: string, conflict: string): Promise<void> {
  const storage = host.storageOf(root);
  if (await storage.exists(folderPath)) throw new Error(conflict);
  await storage.mkdir(folderPath, true);
  await storage.writeText(
    `${folderPath}/${FOLDER_MARKER_NAME}`,
    "# Haptic folder marker\n",
  );
  host.addKnownFolder(folderPath);
  // Ensure parent folders are visible even without their own markers.
  let parent = folderPath.includes("/")
    ? folderPath.slice(0, folderPath.lastIndexOf("/"))
    : "";
  while (parent && parent.startsWith(root.pathPrefix)) {
    host.addKnownFolder(parent);
    if (parent === root.pathPrefix) break;
    parent = parent.includes("/")
      ? parent.slice(0, parent.lastIndexOf("/"))
      : "";
  }
}

export async function moveFolderUnlocked(host: RegistryHost, rootId: string, relativeFolder: string, newParentRelative: string, newName: string | undefined, targetRootId: string): Promise<void> {
  const root = host.getRootOrThrow(rootId);
  host.assertWritable(root);
  if (targetRootId !== rootId) {
    return moveFolderAcrossRoots(host, root, host.getRootOrThrow(targetRootId), relativeFolder, newParentRelative, newName);
  }
  const storage = host.storageOf(root);
  const fromPath = joinRootPath(root, relativeFolder);
  const currentName = relativeFolder.includes("/")
    ? relativeFolder.slice(relativeFolder.lastIndexOf("/") + 1)
    : relativeFolder;
  const folderName = newName?.trim() || currentName;
  const toRelative = joinRelative(newParentRelative, folderName);
  const toPath = joinRootPath(root, toRelative);
  if (fromPath === toPath) return;
  if (isWithinFolder(toPath, fromPath)) {
    throw new Error("Cannot move a folder into itself");
  }

  const assets = [...host.byGuid.values()].filter(
    (asset) =>
      asset.rootId === rootId && isWithinFolder(asset.path, fromPath),
  );
  const folders = await moveStorageTree(storage, fromPath, toPath);
  const relocate = (path: string) => isWithinFolder(path, fromPath) ? `${toPath}${path.slice(fromPath.length)}` : path;
  for (const asset of assets) {
    const path = relocate(asset.path);
    host.byPath.delete(asset.path);
    // A locator names the old path; the next read resolves the moved file.
    const moved = { ...asset, path, locator: undefined };
    host.byGuid.set(asset.header.guid, moved);
    host.byPath.set(path, moved);
  }
  host.repathGuidConflicts(relocate);
  if (assets.length > 0) host.changed();
  for (const folder of [...host.knownFolders]) {
    if (isWithinFolder(folder, fromPath)) host.removeKnownFolder(folder);
  }
  for (const folder of folders) host.addKnownFolder(folder ? `${toPath}/${folder}` : toPath);
}

/**
 * A folder move into another root: the blob chunks of every listed asset
 * in the folder are verified and written to the target root's blob store,
 * then the whole tree (markers and unlisted files included) is copied and
 * the source removed. Guids stay unchanged. A failed copy removes the
 * partial destination and leaves the source as it was.
 */
async function moveFolderAcrossRoots(host: RegistryHost, source: ContentRoot, target: ContentRoot, relativeFolder: string, newParentRelative: string, newName?: string): Promise<void> {
  host.assertWritable(target);
  const relative = relativeFolder.replace(/^\/+|\/+$/g, "");
  if (!relative) throw new Error("Cannot move the assets root folder");
  const fromPath = joinRootPath(source, relative);
  const folderName = newName?.trim() || relative.slice(relative.lastIndexOf("/") + 1);
  const toPath = joinRootPath(target, joinRelative(newParentRelative, folderName));
  // The copy would carry an unlisted file whose guid another file holds.
  const hidden = [...host.guidConflicts.values()].find((conflict) =>
    conflict.rootId === source.id && isWithinFolder(conflict.path, fromPath));
  if (hidden) {
    throw new Error(`Cannot move ${fromPath} to another content root: it holds ${hidden.path}, which is not listed because ${hidden.indexedPath} has the same asset id. Remove that file outside the editor first.`);
  }
  const sourceStorage = host.storageOf(source);
  const targetStorage = host.storageOf(target);
  if (!host.knownFolders.has(fromPath) && !(await sourceStorage.exists(fromPath))) {
    throw new Error(`Unknown folder ${relativeFolder}`);
  }
  if (host.isPathReserved(toPath) || host.knownFolders.has(toPath) || await targetStorage.exists(toPath)) {
    throw new Error(`Target path already exists: ${toPath}`);
  }
  const assets = [...host.byGuid.values()].filter(
    (asset) => asset.rootId === source.id && isWithinFolder(asset.path, fromPath),
  );
  const sourceBlobs = host.blobsOf(source);
  const targetBlobs = host.blobsOf(target);
  const headers = new Map<string, HassetHeader>();
  for (const asset of assets) {
    const header = await copyBlobChunks(await sourceStorage.readBinary(asset.path), sourceBlobs, targetBlobs);
    if (header.guid !== asset.header.guid) {
      throw new SourceRevisionChangedError(`Asset changed on disk before it could be moved: ${asset.path}`);
    }
    headers.set(asset.path, header);
  }
  let folders: string[];
  try {
    folders = await copyStorageTree(sourceStorage, fromPath, toPath, targetStorage);
  } catch (error) {
    try { await targetStorage.remove(toPath); } catch { /* The source is intact; a leftover copy is only clutter. */ }
    throw error;
  }
  // If removal fails, the complete copy remains for recovery.
  await sourceStorage.remove(fromPath);
  const relocate = (path: string) => isWithinFolder(path, fromPath) ? `${toPath}${path.slice(fromPath.length)}` : path;
  for (const asset of assets) {
    const path = relocate(asset.path);
    host.indexHeader(target.id, path, headers.get(asset.path)!, false, await host.statMtime(targetStorage, path));
  }
  host.repathGuidConflicts(relocate);
  for (const folder of [...host.knownFolders]) {
    if (isWithinFolder(folder, fromPath)) host.removeKnownFolder(folder);
  }
  for (const folder of folders) host.addKnownFolder(folder ? `${toPath}/${folder}` : toPath);
}
