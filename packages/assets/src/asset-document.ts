import { ENGINE_VERSION, type ProjectStorage } from "@babylonslate/core";
import {
  decodeBabassetChunk,
  encodeBabasset,
  readBabassetHeader,
  type BabassetHeader,
  type ChunkInput,
  type DecodedBabasset,
  type EncodableChunk,
} from "./babasset";
import type { BlobStore } from "./blob-store";
import { AccountedPayloadLoader, readAssetCatalog } from "./payload-loader";
import { stableStringify } from "./bytes";
import { collectAssetDependencyMetadata, type AssetDependencyContext, type AssetDependencyMetadata } from "./asset-dependencies";
import { ATLAS_REFERRER_TYPES, ATLAS_TEXTURES_META, atlasTextureGuids } from "./atlas-textures";

/** Editor documents keep their JSON body in one chunk so headers stay cheap to scan. */
export const DOCUMENT_CHUNK_ID = "document";

export interface AssetDocument {
  type: string;
  name: string;
  guid: string;
  version: number;
  payload: Record<string, unknown>;
}

/**
 * Non-document chunks (font source, pixels, audio, …) to keep when an editor
 * document save rewrites the JSON body. Every one listed in the header must
 * have its bytes: a save must never drop a chunk it could not load.
 */
export function extraChunksFromDecoded(
  decoded: DecodedBabasset,
): ChunkInput[] {
  const extra: ChunkInput[] = [];
  for (const entry of decoded.header.chunks) {
    if (entry.id === DOCUMENT_CHUNK_ID) continue;
    const data = decoded.chunks.get(entry.id);
    if (!data) throw new Error(`Chunk ${entry.id} was not loaded; refusing to drop it on save`);
    extra.push({
      id: entry.id,
      kind: entry.kind,
      mime: entry.mime,
      data,
    });
  }
  return extra;
}

export async function encodeAssetDocument(
  document: AssetDocument,
  options: {
    engineVersion?: string;
    blobs?: BlobStore;
    /** Chunks beside the document body; carried ones keep their stored digest instead of being hashed again. */
    extraChunks?: readonly EncodableChunk[];
    parentClass?: string | null;
    headerPayload?: Record<string, unknown>;
    /** Merged into the header payload without switching to header-only mode. */
    headerMeta?: Record<string, unknown>;
    /** Outbound asset guids stored on the scanned header. */
    dependencies?: readonly string[];
    dependencyContext?: AssetDependencyContext;
    dependencyMetadata?: AssetDependencyMetadata;
  } = {},
): Promise<Uint8Array> {
  const body = new TextEncoder().encode(stableStringify(document.payload));
  const extra = options.extraChunks ?? [];
  const storeInHeader = options.headerPayload !== undefined;
  return encodeBabasset({
    header: {
      ...(options.dependencyMetadata ?? collectAssetDependencyMetadata(document.type, document.payload, {
        ...options.dependencyContext,
        parentClass: options.parentClass,
        dependencies: options.dependencies,
      })),
      engineVersion: options.engineVersion ?? ENGINE_VERSION,
      guid: document.guid,
      mode: "thin",
      name: document.name,
      parentClass: options.parentClass ?? null,
      payload: {
        ...(options.headerPayload ?? {}),
        // The registry reads a referrer's atlases from its header, never its document.
        ...(ATLAS_REFERRER_TYPES.has(document.type)
          ? { [ATLAS_TEXTURES_META]: atlasTextureGuids(document.type, document.payload) }
          : {}),
        ...(options.headerMeta ?? {}),
      },
      type: document.type,
      version: document.version,
    },
    chunks: storeInHeader
      ? [...extra]
      : [
          {
            id: DOCUMENT_CHUNK_ID,
            kind: "document",
            mime: "application/json",
            data: body,
          },
          ...extra,
        ],
    writeBlob: options.blobs
      ? (sha256, data) => options.blobs!.writeBlob(sha256, data)
      : undefined,
  });
}

/**
 * The document of a `.babasset`: its `document` chunk, else its header
 * payload. Only that chunk is read and verified; other chunks (source bytes,
 * bakes, encodes) are neither loaded from blobs nor hashed.
 */
export async function decodeAssetDocument(
  bytes: Uint8Array,
  options: { blobs?: BlobStore } = {},
): Promise<AssetDocument> {
  const header = readBabassetHeader(bytes);
  const body = await decodeBabassetChunk(
    bytes,
    DOCUMENT_CHUNK_ID,
    options.blobs ? (sha256) => options.blobs!.readBlob(sha256) : undefined,
  );
  return assetDocumentFrom(header, body);
}

/**
 * {@link decodeAssetDocument} for a file in storage, reading only its header
 * and `document` chunk, so a Scene's navmesh or reverb bake stays on disk.
 * The read is not charged to any registry's payload account.
 */
export async function readStoredAssetDocument(
  storage: ProjectStorage,
  path: string,
  options: { blobs?: BlobStore } = {},
): Promise<AssetDocument> {
  const { header, locator } = await readAssetCatalog(storage, path);
  const entry = header.chunks.find((chunk) => chunk.id === DOCUMENT_CHUNK_ID);
  const loader = new AccountedPayloadLoader(storage, { blobs: options.blobs });
  const body = entry ? await loader.loadChunk(locator, entry) : null;
  return assetDocumentFrom(header, body);
}

function assetDocumentFrom(
  header: BabassetHeader,
  body: Uint8Array | null,
): AssetDocument {
  const headerPayload = header.payload;
  let payload: Record<string, unknown>;
  if (body) {
    payload = JSON.parse(new TextDecoder().decode(body)) as Record<
      string,
      unknown
    >;
  } else if (
    headerPayload &&
    (Object.keys(headerPayload).length > 0 || header.type === "Audio")
  ) {
    payload = headerPayload;
  } else {
    throw new Error(
      `Asset is missing its "${DOCUMENT_CHUNK_ID}" chunk or header payload`,
    );
  }
  return {
    type: header.type,
    name: header.name,
    guid: header.guid,
    version: header.version,
    payload,
  };
}

/** Rewrite payload `name` in the document JSON chunk (Scene rename/duplicate). */
export function stampDocumentChunkName(
  chunks: Map<string, ChunkInput>,
  name: string,
): void {
  const chunk = chunks.get(DOCUMENT_CHUNK_ID);
  if (!chunk) return;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(chunk.data));
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return;
  }
  (payload as Record<string, unknown>).name = name;
  chunks.set(DOCUMENT_CHUNK_ID, {
    ...chunk,
    data: new TextEncoder().encode(JSON.stringify(payload)),
  });
}

/** Header-only read for registry indexing: never touches chunk payloads. */
export function readAssetDocumentHeader(bytes: Uint8Array) {
  return readBabassetHeader(bytes);
}

export function isAssetDocumentPath(path: string): boolean {
  return path.endsWith(".babasset");
}
