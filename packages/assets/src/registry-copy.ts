import { classIdForAssetPath } from "@haptic/core";
import { DOCUMENT_CHUNK_ID, stampDocumentChunkName } from "./asset-document";
import { stableStringify } from "./bytes";
import { replaceClassAssetReferences, type ClassAssetReplacement } from "./class-asset-refs";
import type { DataDefinitionFieldsResolver } from "./data-asset-refs";
import { newAssetGuid } from "./guid";
import { decodeHasset, encodeHasset, readHassetHeader, type ChunkInput, type HassetHeader } from "./hasset";
import { applyImportGuidRemap, type ImportResult } from "./importers";
import { writeCreatedFolder } from "./registry-folders";
import { isWithinFolder, joinRelative, joinRootPath, sanitizeFileName } from "./registry-paths";
import { alignCreatedTextures } from "./registry-texture-encoding";
import type { AssetCopyOptions, IndexedAsset, RegistryHost } from "./registry-types";
import { assetFileSuffix, nextCopyName, stripAssetFileSuffix } from "./unique-names";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export async function duplicateAssetUnlocked(host: RegistryHost, guid: string, rootId: string, targetFolderRelative: string, signal?: AbortSignal): Promise<IndexedAsset> {
  signal?.throwIfAborted();
  const asset = host.byGuid.get(guid);
  if (!asset) throw new Error(`Unknown asset ${guid}`);
  const root = host.getRootOrThrow(rootId);
  host.assertWritable(root);
  const sourceStorage = host.storageForAsset(asset);
  const sourceBlobs = host.blobsForAsset(asset);
  const destStorage = host.storageOf(root);
  const destBlobs = host.blobsOf(root);
  const fileBytes = await sourceStorage.readBinary(asset.path);
  const decoded = await decodeHasset(fileBytes, (sha256) =>
    sourceBlobs.readBlob(sha256),
  );
  signal?.throwIfAborted();
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
  const newGuid = newAssetGuid();
  const fileName = asset.path.includes("/")
    ? asset.path.slice(asset.path.lastIndexOf("/") + 1)
    : asset.path;
  const suffix = assetFileSuffix(fileName);
  const stemSource = sanitizeFileName(
    stripAssetFileSuffix(fileName) || decoded.header.name || "asset",
  );
  const targetFolderPath = joinRootPath(root, targetFolderRelative);
  const siblingStems: string[] = [];
  for (const other of host.byPath.values()) {
    if (other.rootId !== rootId) continue;
    const parent = other.path.includes("/")
      ? other.path.slice(0, other.path.lastIndexOf("/"))
      : "";
    if (parent !== targetFolderPath) continue;
    const otherFile = other.path.includes("/")
      ? other.path.slice(other.path.lastIndexOf("/") + 1)
      : other.path;
    siblingStems.push(stripAssetFileSuffix(otherFile));
  }
  // A Class's file stem is its class id, which no other Class in any root may use.
  const classIds = decoded.header.type === "Class"
    ? new Set([...host.byGuid.values()]
      .filter((other) => !other.placeholder && other.header.type === "Class")
      .map((other) => classIdForAssetPath(other.path)))
    : null;
  // Pick and claim the copy's name together, skipping names another write
  // holds and unindexed files already on disk.
  let uniqueName: string;
  let candidate: string;
  let release: () => void;
  for (;;) {
    uniqueName = nextCopyName(stemSource, siblingStems);
    candidate = joinRootPath(root, joinRelative(targetFolderRelative, `${uniqueName}${suffix}`));
    siblingStems.push(uniqueName);
    if (host.isPathReserved(candidate) || host.byPath.has(candidate)) continue;
    if (classIds?.has(classIdForAssetPath(candidate))) continue;
    release = host.reservePath(candidate, `Asset already exists: ${candidate}`);
    let free = false;
    try {
      free = !(await destStorage.exists(candidate));
    } finally {
      if (!free) release();
    }
    if (free) break;
  }
  try {
    const { chunks, ...headerRest } = decoded.header;
    void chunks;
    stampDocumentChunkName(chunksById, uniqueName);
    const encoded = await encodeHasset({
      header: { ...headerRest, guid: newGuid, name: uniqueName },
      chunks: [...chunksById.values()],
      writeBlob: (sha256, data) => destBlobs.writeBlob(sha256, data),
    });
    signal?.throwIfAborted();
    const dir = candidate.includes("/")
      ? candidate.slice(0, candidate.lastIndexOf("/"))
      : "";
    if (dir) await destStorage.mkdir(dir, true);
    await destStorage.writeBinary(candidate, encoded);
    return host.indexCreatedHeader(rootId, candidate, readHassetHeader(encoded), await host.statMtime(destStorage, candidate));
  } finally {
    release();
  }
}

/** See `AssetRegistry.copyFolder`. */
export async function copyFolder(
  host: RegistryHost,
  rootId: string,
  relativeFolder: string,
  targetParentRelative: string,
  options: AssetCopyOptions = {},
): Promise<string> {
  const { signal, onProgress } = options;
  signal?.throwIfAborted();
  const root = host.getRootOrThrow(rootId);
  host.assertWritable(root);
  const storage = host.storageOf(root);
  const fromPath = joinRootPath(root, relativeFolder);
  if (
    !host.knownFolders.has(fromPath) &&
    !(await storage.exists(fromPath))
  ) {
    throw new Error(`Unknown folder ${relativeFolder}`);
  }
  const folderName = relativeFolder.includes("/")
    ? relativeFolder.slice(relativeFolder.lastIndexOf("/") + 1)
    : relativeFolder;
  const destParentPath = joinRootPath(root, targetParentRelative);
  const siblingNames: string[] = [];
  for (const folder of host.knownFolders) {
    const parent = folder.includes("/")
      ? folder.slice(0, folder.lastIndexOf("/"))
      : "";
    if (parent === destParentPath) {
      siblingNames.push(folder.slice(folder.lastIndexOf("/") + 1));
    }
  }
  if (isWithinFolder(destParentPath, fromPath)) {
    throw new Error("Cannot copy a folder into itself");
  }
  // Pick and claim the copy's name together, skipping names another copy
  // holds and folders on disk the index does not know (made outside the
  // editor since the scan), as Duplicate does for files.
  let destRelative: string;
  let destPath: string;
  let release: () => void;
  for (;;) {
    const uniqueName = nextCopyName(folderName, siblingNames);
    siblingNames.push(uniqueName);
    destRelative = joinRelative(targetParentRelative, uniqueName);
    destPath = joinRootPath(root, destRelative);
    if (host.isPathReserved(destPath) || host.knownFolders.has(destPath)) continue;
    release = host.reservePath(destPath, `Folder already exists: ${destPath}`);
    let free = false;
    try {
      free = !(await storage.exists(destPath));
    } finally {
      if (!free) release();
    }
    if (free) break;
  }
  try {
    const conflict = `Folder already exists: ${destPath}`;
    await host.withCreationWrite(() => writeCreatedFolder(host, root, destPath, conflict));
  } finally {
    release();
  }

  const assets = [...host.byGuid.values()].filter(
    (asset) =>
      asset.rootId === rootId && isWithinFolder(asset.path, fromPath),
  );
  try {
    const nested = [...host.knownFolders].filter(
      (folder) => folder !== fromPath && isWithinFolder(folder, fromPath),
    );
    nested.sort((a, b) => a.length - b.length);
    for (const folder of nested) {
      signal?.throwIfAborted();
      const suffix = folder.slice(fromPath.length + 1);
      await host.createFolder(rootId, joinRelative(destRelative, suffix));
    }

    const copies: Array<{ source: IndexedAsset; copy: IndexedAsset }> = [];
    onProgress?.(0, assets.length);
    for (const asset of assets) {
      const parent = asset.path.includes("/")
        ? asset.path.slice(0, asset.path.lastIndexOf("/"))
        : "";
      const suffix =
        parent === fromPath ? "" : parent.slice(fromPath.length + 1);
      const destFolder = suffix
        ? joinRelative(destRelative, suffix)
        : destRelative;
      const copy = await host.withCreationWrite(() => duplicateAssetUnlocked(host, asset.header.guid, rootId, destFolder, signal));
      copies.push({ source: asset, copy });
      onProgress?.(copies.length, assets.length);
    }
    signal?.throwIfAborted();
    const remapped = await remapFolderCopyReferences(host, copies);
    // After the remap, so a copied Sprite or Tileset already samples its copied Texture.
    await alignCreatedTextures(host, remapped);
  } catch (error) {
    if (signal?.aborted) await host.deleteFolder(rootId, destRelative);
    throw error;
  }
  return destRelative;
}

/**
 * Point each folder copy's references to another asset in the copied folder
 * at that asset's copy (guids, and Class ids, which follow the copies' file
 * stems), as a `.hasset` import does for colliding guids. References to
 * assets outside the folder are left as they were.
 */
async function remapFolderCopyReferences(
  host: RegistryHost,
  copies: ReadonlyArray<{ source: IndexedAsset; copy: IndexedAsset }>,
): Promise<IndexedAsset[]> {
  const guids = new Map(copies.map(({ source, copy }) => [source.header.guid, copy.header.guid]));
  const classes: ClassAssetReplacement[] = copies
    .filter(({ source }) => source.header.type === "Class")
    .map(({ source, copy }) => ({
      guid: source.header.guid,
      classId: classIdForAssetPath(source.path),
      replacement: { guid: copy.header.guid, classId: classIdForAssetPath(copy.path) },
    }));
  const classIds = new Map(classes.map((entry) => [entry.classId, entry.replacement!.classId]));
  // Definitions keep a header snapshot of their fields; the copies' Data
  // values name originals until remapped and copies after.
  const definitionFields: DataDefinitionFieldsResolver = (guid) => {
    const header = host.byGuid.get(guid)?.header;
    return header && (header.type === "DataDefinition" || header.type === "Structure") && Array.isArray(header.payload.fields)
      ? header.payload.fields : undefined;
  };
  const remapped: IndexedAsset[] = [];
  for (const { copy } of copies) {
    const guid = copy.header.guid;
    remapped.push(await host.withAssetWrite(guid, () => rewriteCopiedReferences(host, guid, guids, classes, classIds, definitionFields)));
  }
  return remapped;
}

async function rewriteCopiedReferences(
  host: RegistryHost,
  guid: string,
  guids: ReadonlyMap<string, string>,
  classes: readonly ClassAssetReplacement[],
  classIds: ReadonlyMap<string, string>,
  definitionFields: DataDefinitionFieldsResolver,
): Promise<IndexedAsset> {
  const asset = host.byGuid.get(guid);
  if (!asset) throw new Error(`Unknown asset ${guid}`);
  const storage = host.storageForAsset(asset);
  const blobs = host.blobsForAsset(asset);
  const decoded = await decodeHasset(await storage.readBinary(asset.path), (sha256) => blobs.readBlob(sha256));
  const { chunks: entries, ...header } = decoded.header;
  const chunks: ChunkInput[] = entries.flatMap((entry) => {
    const data = decoded.chunks.get(entry.id);
    return data ? [{ id: entry.id, kind: entry.kind, mime: entry.mime, data }] : [];
  });
  let result: ImportResult;
  try {
    [result] = applyImportGuidRemap([{
      type: header.type,
      name: header.name,
      guid: header.guid,
      version: header.version,
      dependencies: header.dependencies,
      requiredDependencies: header.requiredDependencies,
      classReferences: header.classReferences,
      requiredClassReferences: header.requiredClassReferences,
      payload: header.payload,
      chunks,
    }], guids, definitionFields) as [ImportResult];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Copied ${asset.path}, but could not point its references at the folder's copies: ${reason}`, { cause: error });
  }
  const replaceClasses = <T>(value: T): T =>
    classes.length > 0 ? replaceClassAssetReferences(value, classes, definitionFields).value : value;
  const classIdsOf = (entries: readonly string[] | undefined) => entries?.map((entry) => classIds.get(entry) ?? entry);
  const next: Omit<HassetHeader, "chunks"> = {
    ...header,
    dependencies: result.dependencies,
    ...(result.requiredDependencies ? { requiredDependencies: result.requiredDependencies } : {}),
    ...(result.classReferences ? { classReferences: classIdsOf(result.classReferences) } : {}),
    ...(result.requiredClassReferences ? { requiredClassReferences: classIdsOf(result.requiredClassReferences) } : {}),
    ...(header.parentClass != null ? { parentClass: replaceClasses({ parentClass: header.parentClass }).parentClass } : {}),
    payload: replaceClasses(result.payload),
  };
  let changed = stableStringify(next) !== stableStringify(header);
  const nextChunks = result.chunks.map((chunk, index) => {
    if (chunk.id !== DOCUMENT_CHUNK_ID) return chunk;
    const original = chunks[index]!;
    const decode = (data: Uint8Array): unknown => JSON.parse(textDecoder.decode(data));
    const document = replaceClasses(decode(chunk.data));
    // Keep the copied bytes when nothing in the document named the folder's assets.
    if (stableStringify(document) === stableStringify(decode(original.data))) return original;
    changed = true;
    return { ...chunk, data: textEncoder.encode(JSON.stringify(document)) };
  });
  if (!changed) return asset;
  const encoded = await encodeHasset({
    header: next,
    chunks: nextChunks,
    writeBlob: (sha256, data) => blobs.writeBlob(sha256, data),
  });
  await storage.writeBinary(asset.path, encoded);
  return host.indexHeader(asset.rootId, asset.path, readHassetHeader(encoded), false, await host.statMtime(storage, asset.path));
}
