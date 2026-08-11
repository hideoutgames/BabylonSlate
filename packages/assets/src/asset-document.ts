import { decodeBabasset, encodeBabasset, readBabassetHeader } from "./babasset";
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

export async function encodeAssetDocument(
  document: AssetDocument,
  options: { engineVersion?: string; blobs?: BlobStore } = {},
): Promise<Uint8Array> {
  const body = new TextEncoder().encode(stableStringify(document.payload));
  return encodeBabasset({
    header: {
      dependencies: [],
      engineVersion: options.engineVersion ?? "0.0.0",
      guid: document.guid,
      mode: "thin",
      name: document.name,
      parentClass: null,
      payload: {},
      type: document.type,
      version: document.version,
    },
    chunks: [
      {
        id: DOCUMENT_CHUNK_ID,
        kind: "document",
        mime: "application/json",
        data: body,
      },
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
  if (!body) {
    throw new Error(`Asset is missing its "${DOCUMENT_CHUNK_ID}" chunk`);
  }
  return {
    type: decoded.header.type,
    name: decoded.header.name,
    guid: decoded.header.guid,
    version: decoded.header.version,
    payload: JSON.parse(new TextDecoder().decode(body)) as Record<
      string,
      unknown
    >,
  };
}

/** Header-only read for registry indexing: never touches chunk payloads. */
export function readAssetDocumentHeader(bytes: Uint8Array) {
  return readBabassetHeader(bytes);
}

export function isAssetDocumentPath(path: string): boolean {
  return path.endsWith(".babasset");
}
