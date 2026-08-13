import { normalizeFontPayload } from "@babylonslate/assets";
import type { FontAssetEntry } from "@babylonslate/render";

export interface FontAssetSource {
  guid: string;
  path: string;
  type: string;
  payload?: unknown;
}

/** Load Font `source` chunks for Play / designer ADT registration. */
export async function collectFontAssetEntries(
  assets: readonly FontAssetSource[],
  readChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>,
): Promise<FontAssetEntry[]> {
  const entries: FontAssetEntry[] = [];
  for (const asset of assets) {
    if (asset.type !== "Font") continue;
    const bytes = await readChunk(asset.path, "source");
    if (!bytes || bytes.byteLength === 0) continue;
    const payload = normalizeFontPayload(asset.payload, "Custom Font");
    entries.push({
      guid: asset.guid,
      family: payload.family,
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      weight: payload.weight,
      style: payload.style,
    });
  }
  return entries;
}
