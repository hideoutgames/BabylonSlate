import { classIdForAssetPath, ENGINE_VERSION } from "@haptic/core";
import { collectAssetDependencyMetadata, type AssetDependencyClass } from "./asset-dependencies";
import { DOCUMENT_CHUNK_ID } from "./asset-document";
import { stableStringify } from "./bytes";
import type { ContentRoot } from "./content-root";
import { mergeFontAttachPayload } from "./font-payload";
import { decodeHasset, encodeHasset, readHassetHeader, type ChunkInput } from "./hasset";
import { remapImportResultGuids, type ImportOptions, type ImportResult } from "./importers";
import { joinRelative, joinRootPath, parentPath, sanitizeFileName } from "./registry-paths";
import { alignCreatedTextures, maybeEnqueueTextureEncode } from "./registry-texture-encoding";
import type { AssetImportControl, IndexedAsset, RegistryHost } from "./registry-types";
import { DEFAULT_THUMBNAIL_MAX_EDGE, generateThumbnailBytes } from "./thumbnails";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export async function createAssetUnlocked(host: RegistryHost, rootId: string, relativePath: string, result: ImportResult): Promise<IndexedAsset> {
  const root = host.getRootOrThrow(rootId);
  host.assertWritable(root);
  const path = joinRootPath(root, relativePath);
  const conflict = `Asset already exists: ${path}`;
  return host.withReservedPath(path, conflict, () => writeCreatedAsset(host, root, path, result, conflict));
}

async function writeCreatedAsset(host: RegistryHost, root: ContentRoot, path: string, result: ImportResult, conflict: string): Promise<IndexedAsset> {
  const storage = host.storageOf(root);
  if (await storage.exists(path)) throw new Error(conflict);
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (dir) {
    await storage.mkdir(dir, true);
  }

  const body = result.chunks.find((chunk) => chunk.id === DOCUMENT_CHUNK_ID);
  const dependencyPayload = body
    ? JSON.parse(textDecoder.decode(body.data)) as Record<string, unknown>
    : result.payload;
  const classes: AssetDependencyClass[] = host.list()
    .filter((asset) => asset.header.type === "Class")
    .map((asset) => ({
      guid: asset.header.guid,
      classId: typeof asset.header.payload.classId === "string" ? asset.header.payload.classId
        : classIdForAssetPath(asset.path),
      parentClassId: asset.header.parentClass,
      requiredVariableNames: asset.header.requiredVariableNames,
      members: Array.isArray(asset.header.payload.members) ? asset.header.payload.members as AssetDependencyClass["members"]
        : Array.isArray(asset.header.payload.variables) ? asset.header.payload.variables.map((variable) => ({ ...(variable as Record<string, unknown>), kind: "variable" })) as unknown as AssetDependencyClass["members"] : undefined,
    }));
  const dependencies = collectAssetDependencyMetadata(result.type, dependencyPayload, {
    dependencies: result.dependencies, parentClass: result.parentClass, classes,
  });
  if (result.dependencyMetadataVersion === dependencies.dependencyMetadataVersion && result.requiredVariableNames) {
    dependencies.requiredVariableNames = [...new Set([...(dependencies.requiredVariableNames ?? []), ...result.requiredVariableNames])].sort();
  }
  if (result.dependencyMetadataVersion === dependencies.dependencyMetadataVersion && result.requiredDependencies) {
    dependencies.requiredDependencies = [...new Set([...dependencies.requiredDependencies, ...result.requiredDependencies])].sort();
    dependencies.dependencies = [...new Set([...dependencies.dependencies, ...result.requiredDependencies])].sort();
  }

  const bytes = await encodeHasset({
    header: {
      guid: result.guid,
      type: result.type,
      name: result.name,
      engineVersion: ENGINE_VERSION,
      version: result.version,
      mode: "thin",
      ...dependencies,
      parentClass: result.parentClass ?? null,
      payload: result.payload,
    },
    chunks: result.chunks,
    writeBlob: (sha256, data) => host.blobsOf(root).writeBlob(sha256, data),
  });
  await storage.writeBinary(path, bytes);
  const header = readHassetHeader(bytes);
  const mtime = await host.statMtime(storage, path);
  return host.indexCreatedHeader(root.id, path, header, mtime);
}

/** What `importFile` takes besides the file: its importer's options, progress and cancellation. */
export type ImportFileExtras = AssetImportControl & {
  modelImportScale?: number;
  sidecars?: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>;
  attachToGuid?: string;
  /** Largest cube face for an `.hdr` panorama (128, 256 or 512). */
  hdrFaceSize?: number;
};

export async function importFile(
  host: RegistryHost,
  rootId: string,
  folderRelative: string,
  fileName: string,
  bytes: Uint8Array,
  extras?: ImportFileExtras,
): Promise<IndexedAsset[]> {
  const signal = extras?.signal;
  signal?.throwIfAborted();
  host.assertWritable(host.getRootOrThrow(rootId));
  const options: ImportOptions = {
    fileName,
    existingGuids: new Set(host.byGuid.keys()),
    fontGuidsByName: fontGuidsByName(host, rootId, folderRelative),
    modelImportScale: extras?.modelImportScale,
    sidecars: extras?.sidecars,
    attachToGuid: extras?.attachToGuid,
    hdrFaceSize: extras?.hdrFaceSize,
    signal,
    onProgress: extras?.onProgress,
  };
  const rawResults = await host.runImport(fileName, bytes, options);
  // Nothing is written for an import cancelled during its conversion.
  signal?.throwIfAborted();
  const results = remapImportResultGuids(rawResults, options.existingGuids).map(
    (result) =>
      extras?.attachToGuid
        ? { ...result, attachToGuid: extras.attachToGuid, guid: extras.attachToGuid }
        : result,
  );

  const created: Array<{ asset: IndexedAsset; result: ImportResult }> = [];
  try {
    for (const result of results) {
      if (result.attachToGuid) {
        await attachToExistingAsset(host, result.attachToGuid, result);
        continue;
      }
      const relativePath = joinRelative(folderRelative, `${sanitizeFileName(result.name)}.hasset`);
      created.push({ asset: await host.createAsset(rootId, relativePath, result), result });
      signal?.throwIfAborted();
    }
  } catch (error) {
    // A file imports whole or not at all: a cancel or failure partway removes its assets.
    for (const { asset } of created.reverse()) {
      try { await host.deleteAsset(asset.header.guid); } catch { /* Already gone or unwritable; the import still fails. */ }
    }
    throw error;
  }
  for (const { asset, result } of created) {
    await maybeWriteThumbnail(host, asset, result);
    await maybeEnqueueTextureEncode(host, asset);
  }
  const assets = created.map(({ asset }) => asset);
  // After every result is indexed, so a bundled Tileset counts.
  await alignCreatedTextures(host, assets);
  return assets;
}

async function maybeWriteThumbnail(
  host: RegistryHost,
  asset: IndexedAsset,
  result: ImportResult,
): Promise<void> {
  if (!host.thumbnailWriter()) return;
  if (asset.header.type !== "Texture") return;
  const pixels = result.chunks.find(
    (chunk) => chunk.id === "pixels" || chunk.kind === "pixels",
  );
  if (!pixels?.data?.byteLength) return;
  const thumb = await generateThumbnailBytes(
    pixels.data,
    DEFAULT_THUMBNAIL_MAX_EDGE,
    pixels.mime,
  );
  if (!thumb) return;
  await host.writeThumbnail(asset.header.guid, thumb);
}

/**
 * The Font each family name attaches an imported representation to: the
 * Font of that name in the import folder, else the only one in the import's
 * root. A name several Fonts there share attaches to none, so the import
 * makes its own Font rather than joining whichever one the index lists last.
 */
function fontGuidsByName(host: RegistryHost, rootId: string, folderRelative: string): Map<string, string> {
  const root = host.roots.get(rootId);
  const folder = root ? joinRootPath(root, folderRelative) : null;
  const byName = new Map<string, IndexedAsset[]>();
  for (const asset of host.byGuid.values()) {
    if (asset.placeholder || asset.header.type !== "Font" || asset.rootId !== rootId) continue;
    const fonts = byName.get(asset.header.name) ?? [];
    fonts.push(asset);
    byName.set(asset.header.name, fonts);
  }
  const map = new Map<string, string>();
  for (const [name, fonts] of byName) {
    const local = fonts.filter((font) => parentPath(font.path) === folder);
    const font = local.length > 0 ? (local.length === 1 ? local[0] : undefined) : fonts.length === 1 ? fonts[0] : undefined;
    if (font) map.set(name, font.header.guid);
  }
  return map;
}

/** Attach a representation chunk (facetype / msdf) to an existing Font asset. */
async function attachToExistingAsset(host: RegistryHost, guid: string, result: ImportResult): Promise<void> {
  return host.withAssetWrite(guid, () => attachToExistingAssetUnlocked(host, guid, result));
}

async function attachToExistingAssetUnlocked(host: RegistryHost, guid: string, result: ImportResult): Promise<void> {
  const asset = host.byGuid.get(guid);
  if (!asset || asset.placeholder) {
    throw new Error(`Cannot attach representation: no asset for guid ${guid}`);
  }
  // The target's own root decides, whatever root the import was started in.
  host.assertWritable(host.getRootOrThrow(asset.rootId));
  const storage = host.storageForAsset(asset);
  const blobs = host.blobsForAsset(asset);
  const fileBytes = await storage.readBinary(asset.path);
  const decoded = await decodeHasset(fileBytes, (sha256) => blobs.readBlob(sha256));

  const chunksById = new Map<string, ChunkInput>();
  for (const entry of decoded.header.chunks) {
    const data = decoded.chunks.get(entry.id);
    if (data) {
      chunksById.set(entry.id, { id: entry.id, kind: entry.kind, mime: entry.mime, data });
    }
  }
  for (const chunk of result.chunks) {
    chunksById.set(chunk.id, chunk);
  }

  const { chunks, ...headerRest } = decoded.header;
  void chunks;
  // A Font saved from its editor keeps its payload in the document chunk,
  // which readers prefer: merge into that payload and store it there too.
  const documentChunk = chunksById.get(DOCUMENT_CHUNK_ID);
  const current = documentChunk
    ? JSON.parse(textDecoder.decode(documentChunk.data)) as Record<string, unknown>
    : headerRest.payload;
  const familyFallback = typeof current.family === "string" ? current.family : asset.header.name;
  const merged =
    asset.header.type === "Font"
      ? (mergeFontAttachPayload(current, result.payload, familyFallback) as unknown as Record<string, unknown>)
      : { ...current, ...result.payload };
  if (documentChunk) {
    chunksById.set(DOCUMENT_CHUNK_ID, { ...documentChunk, data: textEncoder.encode(stableStringify(merged)) });
  }
  const bytes = await encodeHasset({
    // Header readers (font stacks, an open Font editor) see the same payload.
    header: { ...headerRest, payload: { ...headerRest.payload, ...merged } },
    chunks: [...chunksById.values()],
    writeBlob: (sha256, data) => blobs.writeBlob(sha256, data),
  });
  await storage.writeBinary(asset.path, bytes);
  const header = readHassetHeader(bytes);
  host.indexHeader(asset.rootId, asset.path, header, false, await host.statMtime(storage, asset.path));
}
