import {
  decodeBabasset,
  encodeBabasset,
  readBabassetHeader,
  type ChunkInput,
  type DecodedBabasset,
} from "./babasset";
import type { BlobStore } from "./blob-store";
import { stableStringify } from "./bytes";

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
 * document save rewrites the JSON body.
 */
export function extraChunksFromDecoded(
  decoded: DecodedBabasset,
): ChunkInput[] {
  const extra: ChunkInput[] = [];
  for (const entry of decoded.header.chunks) {
    if (entry.id === DOCUMENT_CHUNK_ID) continue;
    const data = decoded.chunks.get(entry.id);
    if (!data) continue;
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
    extraChunks?: readonly ChunkInput[];
    parentClass?: string | null;
    headerPayload?: Record<string, unknown>;
    /** Merged into the header payload without switching to header-only mode. */
    headerMeta?: Record<string, unknown>;
    /** Outbound asset guids stored on the scanned header. */
    dependencies?: readonly string[];
  } = {},
): Promise<Uint8Array> {
  const body = new TextEncoder().encode(stableStringify(document.payload));
  const extra = options.extraChunks ?? [];
  const storeInHeader = options.headerPayload !== undefined;
  return encodeBabasset({
    header: {
      dependencies: [...(options.dependencies ?? [])],
      engineVersion: options.engineVersion ?? "0.0.0",
      guid: document.guid,
      mode: "thin",
      name: document.name,
      parentClass: options.parentClass ?? null,
      payload: {
        ...(options.headerPayload ?? {}),
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

export async function decodeAssetDocument(
  bytes: Uint8Array,
  options: { blobs?: BlobStore } = {},
): Promise<AssetDocument> {
  const decoded = await decodeBabasset(
    bytes,
    options.blobs ? (sha256) => options.blobs!.readBlob(sha256) : undefined,
  );
  const body = decoded.chunks.get(DOCUMENT_CHUNK_ID);
  const headerPayload = decoded.header.payload;
  let payload: Record<string, unknown>;
  if (body) {
    payload = JSON.parse(new TextDecoder().decode(body)) as Record<
      string,
      unknown
    >;
  } else if (headerPayload && Object.keys(headerPayload).length > 0) {
    payload = headerPayload;
  } else {
    throw new Error(
      `Asset is missing its "${DOCUMENT_CHUNK_ID}" chunk or header payload`,
    );
  }
  return {
    type: decoded.header.type,
    name: decoded.header.name,
    guid: decoded.header.guid,
    version: decoded.header.version,
    payload,
  };
}

/** Header-only read for registry indexing: never touches chunk payloads. */
export function readAssetDocumentHeader(bytes: Uint8Array) {
  return readBabassetHeader(bytes);
}

export function isAssetDocumentPath(path: string): boolean {
  return path.endsWith(".babasset");
}
