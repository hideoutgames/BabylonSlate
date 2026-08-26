import {
  FONT_FACETYPE_CHUNK_ID,
  FONT_MSDF_CHUNK_ID,
  FONT_MSDF_PNG_CHUNK_ID,
  compileText2DFontStacks,
  normalizeFontPayload,
} from "@babylonslate/assets";
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

export function collectFontCssStacks(
  assets: readonly FontAssetSource[],
  settings?: { defaultFontGuid?: string | null; globalFallback?: string },
): { fontCssStack: string; fontCssStackByGuid: Map<string, string> } {
  const compiled = compileText2DFontStacks({
    fonts: assets
      .filter((asset) => asset.type === "Font")
      .map((asset) => {
        const payload = normalizeFontPayload(asset.payload, "Custom Font");
        return {
          guid: asset.guid,
          family: payload.family,
          fallbackGuids: payload.fallbackGuids,
        };
      }),
    defaultFontGuid: settings?.defaultFontGuid,
    globalFallback: settings?.globalFallback,
  });
  return {
    fontCssStack: compiled.defaultStack,
    fontCssStackByGuid: compiled.byGuid,
  };
}

export function fontAssetHasFacetype(payload: unknown): boolean {
  return normalizeFontPayload(payload, "").representations.facetype === true;
}

export function fontAssetHasMsdfJson(payload: unknown): boolean {
  return normalizeFontPayload(payload, "").representations.msdfJson === true;
}

export function fontAssetHasMsdfPng(payload: unknown): boolean {
  return normalizeFontPayload(payload, "").representations.msdfPng === true;
}

export function fontAssetHasMsdfPair(payload: unknown): boolean {
  return normalizeFontPayload(payload, "").representations.msdf === true;
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

export type FontMsdfPair = {
  json: Uint8Array;
  png: Uint8Array;
};

/** Load MSDF JSON + atlas PNG only when both chunks exist. */
export async function collectFontMsdfPair(
  assets: readonly FontAssetSource[],
  fontGuids: readonly string[],
  readChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>,
): Promise<Map<string, FontMsdfPair>> {
  const wanted = new Set(fontGuids.filter((guid) => guid.trim()));
  const pairs = new Map<string, FontMsdfPair>();
  if (wanted.size === 0) return pairs;
  for (const asset of assets) {
    if (asset.type !== "Font" || !wanted.has(asset.guid)) continue;
    const json = await readChunk(asset.path, FONT_MSDF_CHUNK_ID);
    const png = await readChunk(asset.path, FONT_MSDF_PNG_CHUNK_ID);
    if (!json || json.byteLength === 0 || !png || png.byteLength === 0) continue;
    pairs.set(asset.guid, { json, png });
  }
  return pairs;
}

export function fontMsdfMapsFromPairs(
  pairs: ReadonlyMap<string, FontMsdfPair>,
): { json: Map<string, Uint8Array>; png: Map<string, Uint8Array> } {
  const json = new Map<string, Uint8Array>();
  const png = new Map<string, Uint8Array>();
  for (const [guid, pair] of pairs) {
    json.set(guid, pair.json);
    png.set(guid, pair.png);
  }
  return { json, png };
}
