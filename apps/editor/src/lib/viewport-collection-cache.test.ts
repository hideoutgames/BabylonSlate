import { describe, expect, it } from "vitest";
import {
  clearViewportCollectionCache,
  getCachedViewportCollection,
  putCachedViewportCollection,
  type CachedViewportCollection,
} from "./viewport-collection-cache";

function entry(
  textureBytes: Map<string, Uint8Array>,
  encodings: Map<string, string>,
): Omit<CachedViewportCollection, "bytes"> {
  return {
    sprites: new Map(),
    tileContent: { tilemaps: new Map(), tilesets: new Map() },
    waters: new Map(),
    renderTargetAssets: { renderTargets: new Map(), renderTargetTextures: new Map() },
    modelBytes: new Map(),
    modelPayloads: new Map(),
    materials: { documents: new Map(), functions: new Map(), textureGuids: [] },
    textureBytes,
    texturePixelSizes: new Map(),
    fontFacetypeBytes: new Map(),
    areaEmissions: new Map(),
    msdf: { json: new Map(), png: new Map() },
    fontFaceEntries: [],
    payloadRevisions: new Map(),
    encodings,
  };
}

describe("ViewportCollectionCache", () => {
  it("reuses a cached collection when key and texture encodings match, and invalidates on KTX2 commit", () => {
    const registry = {};
    const pngEncodings = new Map([["tex-1", "png:v1"]]);
    const data = entry(new Map([["tex-1", new Uint8Array([1, 2, 3])]]), pngEncodings);
    putCachedViewportCollection(registry, "scene-a", data);

    const hit = getCachedViewportCollection(registry, "scene-a", new Map([["tex-1", "png:v1"]]));
    expect(hit).not.toBeNull();
    expect(hit!.textureBytes.get("tex-1")).toEqual(new Uint8Array([1, 2, 3]));

    // Encoding changed (background KTX2 encode committed): must invalidate and return null.
    const miss = getCachedViewportCollection(registry, "scene-a", new Map([["tex-1", "ktx2:v2"]]));
    expect(miss).toBeNull();
    clearViewportCollectionCache(registry);
  });

  it("evicts least-recently-used entries beyond the 2-scene cap", () => {
    const registry = {};
    const enc = new Map<string, string>();
    putCachedViewportCollection(registry, "scene-1", entry(new Map(), enc));
    putCachedViewportCollection(registry, "scene-2", entry(new Map(), enc));
    // Touch scene-1 so scene-2 becomes LRU.
    expect(getCachedViewportCollection(registry, "scene-1", enc)).not.toBeNull();
    putCachedViewportCollection(registry, "scene-3", entry(new Map(), enc));

    expect(getCachedViewportCollection(registry, "scene-2", enc)).toBeNull();
    expect(getCachedViewportCollection(registry, "scene-1", enc)).not.toBeNull();
    expect(getCachedViewportCollection(registry, "scene-3", enc)).not.toBeNull();
    clearViewportCollectionCache(registry);
  });
});
