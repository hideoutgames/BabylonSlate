import type { FontAssetEntry } from "@haptic/render";
import type {
  RenderTargetPayload,
  RenderTargetTexturePayload,
  WaterDefinition,
} from "@haptic/core";
import type {
  AreaEmissionPixels,
  ModelPayload,
  SpritePayload,
  TilemapPayload,
  TilesetPayload,
} from "@haptic/assets";
import type { MaterialDocument, MaterialFunctionDocument } from "@haptic/shader-graph";
import { changedTextureEncodings } from "./scene-viewport-assets";

/** Max cached scene collections per AssetRegistry (covers active Scene + Play round-trip / sibling tab). */
const MAX_ENTRIES_PER_REGISTRY = 2;
/** Max retained raw binary bytes across cached viewport collections per registry. */
const MAX_BYTES_PER_REGISTRY = 128 * 1024 * 1024;

export interface CachedViewportCollection {
  sprites: Map<string, SpritePayload>;
  tileContent: {
    tilemaps: Map<string, TilemapPayload>;
    tilesets: Map<string, TilesetPayload>;
  };
  waters: Map<string, WaterDefinition>;
  renderTargetAssets: {
    renderTargets: Map<string, RenderTargetPayload>;
    renderTargetTextures: Map<string, RenderTargetTexturePayload>;
  };
  modelBytes: Map<string, Uint8Array>;
  modelPayloads: Map<string, ModelPayload>;
  materials: {
    documents: Map<string, MaterialDocument>;
    functions: Map<string, MaterialFunctionDocument>;
    textureGuids: string[];
  };
  textureBytes: Map<string, Uint8Array>;
  texturePixelSizes: Map<string, { width: number; height: number }>;
  fontFacetypeBytes: Map<string, Uint8Array>;
  areaEmissions: Map<string, AreaEmissionPixels>;
  msdf: {
    json: Map<string, Uint8Array>;
    png: Map<string, Uint8Array>;
  };
  fontFaceEntries: FontAssetEntry[];
  payloadRevisions: Map<string, string>;
  /** Texture encodings active when this collection was captured. */
  encodings: Map<string, string>;
  /** Estimated raw binary bytes retained by this collection. */
  bytes: number;
}

type RegistryCache = {
  entries: Map<string, CachedViewportCollection>;
  bytes: number;
};

const registryCaches = new WeakMap<object, RegistryCache>();

function byteMapSize(map: ReadonlyMap<string, Uint8Array>): number {
  let total = 0;
  for (const buf of map.values()) total += buf.byteLength;
  return total;
}

export function estimateViewportCollectionBytes(
  entry: Pick<
    CachedViewportCollection,
    "modelBytes" | "textureBytes" | "fontFacetypeBytes" | "msdf" | "fontFaceEntries"
  >,
): number {
  let total =
    byteMapSize(entry.modelBytes) +
    byteMapSize(entry.textureBytes) +
    byteMapSize(entry.fontFacetypeBytes) +
    byteMapSize(entry.msdf.json) +
    byteMapSize(entry.msdf.png);
  for (const font of entry.fontFaceEntries) total += font.bytes.byteLength;
  return total;
}

export function getCachedViewportCollection(
  registry: object | null | undefined,
  key: string,
  currentEncodings: ReadonlyMap<string, string>,
): CachedViewportCollection | null {
  if (!registry) return null;
  const cache = registryCaches.get(registry);
  if (!cache) return null;
  const entry = cache.entries.get(key);
  if (!entry) return null;
  // If any texture's stored encoding committed (e.g. PNG -> KTX2 while Play ran), miss and re-collect.
  if (changedTextureEncodings(entry.encodings, currentEncodings).length > 0) {
    cache.bytes -= entry.bytes;
    cache.entries.delete(key);
    return null;
  }
  // Touch LRU order.
  cache.entries.delete(key);
  cache.entries.set(key, entry);
  return entry;
}

export function putCachedViewportCollection(
  registry: object | null | undefined,
  key: string,
  entry: Omit<CachedViewportCollection, "bytes">,
): void {
  if (!registry) return;
  const bytes = estimateViewportCollectionBytes(entry);
  if (bytes > MAX_BYTES_PER_REGISTRY) return;
  let cache = registryCaches.get(registry);
  if (!cache) {
    cache = { entries: new Map(), bytes: 0 };
    registryCaches.set(registry, cache);
  }
  const existing = cache.entries.get(key);
  if (existing) {
    cache.bytes -= existing.bytes;
    cache.entries.delete(key);
  }
  while (
    (cache.entries.size >= MAX_ENTRIES_PER_REGISTRY || cache.bytes + bytes > MAX_BYTES_PER_REGISTRY) &&
    cache.entries.size > 0
  ) {
    const oldestKey = cache.entries.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = cache.entries.get(oldestKey)!;
    cache.bytes -= oldest.bytes;
    cache.entries.delete(oldestKey);
  }
  cache.entries.set(key, { ...entry, bytes });
  cache.bytes += bytes;
}

/** Test seam: drop cached collections for `registry`. */
export function clearViewportCollectionCache(registry: object | null | undefined): void {
  if (!registry) return;
  registryCaches.delete(registry);
}
