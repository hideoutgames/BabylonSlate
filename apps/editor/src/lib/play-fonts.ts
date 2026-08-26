import { FONT_FACETYPE_CHUNK_ID, normalizeFontPayload } from "@babylonslate/assets";
import type { FontAssetEntry } from "@babylonslate/render";

export interface FontAssetSource {
  guid: string;
  path: string;
  type: string;
  payload?: unknown;
}

/** Load Font `source` chunks for Play FontFace registration. */
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
    const copy = new Uint8Array(bytes);
    entries.push({
      guid: asset.guid,
      family: payload.family,
      bytes: copy.buffer,
      weight: payload.weight,
      style: payload.style,
    });
  }
  return entries;
}

export function fontAssetHasFacetype(payload: unknown): boolean {
  return normalizeFontPayload(payload, "").representations.facetype === true;
}

export function fontAssetHasMsdfJson(payload: unknown): boolean {
  const representations =
    payload && typeof payload === "object"
      ? ((payload as { representations?: Record<string, unknown> }).representations ??
        {})
      : {};
  return representations.msdfJson === true;
}

export function fontAssetHasMsdfPng(payload: unknown): boolean {
  const representations =
    payload && typeof payload === "object"
      ? ((payload as { representations?: Record<string, unknown> }).representations ??
        {})
      : {};
  return representations.msdfPng === true;
}

export function fontAssetHasMsdfPair(payload: unknown): boolean {
  return fontAssetHasMsdfJson(payload) && fontAssetHasMsdfPng(payload);
}

/** Load facetype JSON for 3D Text, keyed by Font asset guid. */
export async function collectFontFacetypeBytes(
  assets: readonly FontAssetSource[],
  fontGuids: readonly string[],
  readChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>,
): Promise<Map<string, Uint8Array>> {
  const wanted = new Set(fontGuids.filter((guid) => guid.trim()));
  const bytes = new Map<string, Uint8Array>();
  if (wanted.size === 0) return bytes;
  for (const asset of assets) {
    if (asset.type !== "Font" || !wanted.has(asset.guid)) continue;
    const chunk = await readChunk(asset.path, FONT_FACETYPE_CHUNK_ID);
    if (!chunk || chunk.byteLength === 0) continue;
    bytes.set(asset.guid, chunk);
  }
  return bytes;
}
