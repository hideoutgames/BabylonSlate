import { encodeAssetDocument, decodeAssetDocument } from "./asset-document";

export const TRACE_ASSET_TYPE = "Trace";
export const TRACE_FILE_EXTENSION = ".babtrace";

export function isTracePath(path: string): boolean {
  return path.endsWith(TRACE_FILE_EXTENSION);
}

/** Encode a recorded session as a Trace document in the .babasset container. */
export async function encodeTraceDocument(document: {
  name: string;
  guid: string;
  payload: Record<string, unknown>;
}): Promise<Uint8Array> {
  return encodeAssetDocument({
    type: TRACE_ASSET_TYPE,
    name: document.name,
    guid: document.guid,
    version: 1,
    payload: document.payload,
  });
}

export async function decodeTraceDocument(
  bytes: Uint8Array,
): Promise<{
  name: string;
  guid: string;
  payload: Record<string, unknown>;
}> {
  const decoded = await decodeAssetDocument(bytes);
  return {
    name: decoded.name,
    guid: decoded.guid,
    payload: decoded.payload,
  };
}
