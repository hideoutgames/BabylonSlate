import { describe, expect, it } from "vitest";
import { readThumbnail, writeThumbnail, type IndexedAsset } from "@babylonslate/assets";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { createAssetThumbnailRevisionIndex } from "./asset-thumbnail-revision";

function asset(guid: string, type: string, header: Partial<IndexedAsset["header"]> = {}): IndexedAsset {
  return {
    rootId: "project",
    path: `Content/${guid}.${type.toLowerCase()}.babasset`,
    header: {
      guid, type, name: guid, version: 1, engineVersion: "1", mode: "thin",
      payload: {}, dependencies: [], chunks: [], ...header,
    },
  };
}

function documentChunk(hash: string): IndexedAsset["header"]["chunks"] {
  return [{
    id: "document", kind: "document", mime: "application/json", sha256: hash,
    locator: { inline: { offset: 0, length: 12 } },
  }];
}

describe("saved asset thumbnail revisions", () => {
  it("refreshes prefab scale after pixels-per-unit changes while reusing material spheres", async () => {
    const assets = [asset("actor", "Class", { parentClass: "Actor" }), asset("paint", "Material")];
    const original = createAssetThumbnailRevisionIndex(assets, 100);
    const rescaled = createAssetThumbnailRevisionIndex(assets, 200);
    expect(original.matches(assets, 200)).toBe(false);
    expect(await rescaled.cacheKey("actor")).not.toBe(await original.cacheKey("actor"));
    expect(await rescaled.cacheKey("paint")).toBe(await original.cacheKey("paint"));
  });

  it("does not reuse a persisted material thumbnail after a transitive texture or material edit", async () => {
    const material = asset("material", "Material", {
      dependencies: ["function"], chunks: documentChunk("material-before"),
    });
    const materialFunction = asset("function", "MaterialFunction", { dependencies: ["texture"] });
    const texture = asset("texture", "Texture", { chunks: documentChunk("texture-before") });
    const original = createAssetThumbnailRevisionIndex([material, materialFunction, texture]);
    const originalKey = await original.cacheKey("material");
    expect(originalKey).not.toBeNull();
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("thumbnail-revisions");
    await writeThumbnail(storage, "project", originalKey!, new Uint8Array([1, 2, 3]));

    for (const assets of [
      [material, materialFunction, asset("texture", "Texture", { chunks: documentChunk("texture-after") })],
      [asset("material", "Material", { ...material.header, chunks: documentChunk("material-after") }), materialFunction, texture],
    ]) {
      const key = await createAssetThumbnailRevisionIndex(assets).cacheKey("material");
      expect(key).not.toBe(originalKey);
      await expect(readThumbnail(storage, "project", key!)).resolves.toBeNull();
    }
  });

  it("keeps the cached capture through unrelated edits, asset moves, and dependency ordering", async () => {
    const material = asset("material", "Material", {
      dependencies: ["texture", "function"], payload: { roughness: 0.5, metallic: 0.2 },
    });
    const texture = asset("texture", "Texture", { chunks: documentChunk("texture") });
    const materialFunction = asset("function", "MaterialFunction");
    const first = createAssetThumbnailRevisionIndex([material, texture, materialFunction]);
    const second = createAssetThumbnailRevisionIndex([
      asset("unrelated", "Material", { chunks: documentChunk("edited") }),
      materialFunction,
      { ...material, path: "Content/Moved/Surface.material.babasset", mtime: 123, header: {
        ...material.header, dependencies: ["function", "texture"], payload: { metallic: 0.2, roughness: 0.5 },
      } },
      texture,
    ]);
    expect(await second.cacheKey("material")).toBe(await first.cacheKey("material"));
  });

  it("invalidates inherited prefab geometry even when an older header omitted the parent dependency", async () => {
    const parent = asset("BaseActor", "Class", { parentClass: "Actor", chunks: documentChunk("base-before") });
    const child = asset("ChildActor", "Class", { parentClass: "BaseActor" });
    const before = createAssetThumbnailRevisionIndex([parent, child]);
    const after = createAssetThumbnailRevisionIndex([
      asset("BaseActor", "Class", { ...parent.header, chunks: documentChunk("base-after") }), child,
    ]);
    expect(await before.cacheKey("ChildActor")).not.toBeNull();
    expect(await after.cacheKey("ChildActor")).not.toBe(await before.cacheKey("ChildActor"));
  });

  it("handles cyclic references and regenerates when a missing dependency becomes available", async () => {
    const material = asset("material", "Material", { dependencies: ["function"] });
    const fn = asset("function", "MaterialFunction", { dependencies: ["material", "missing"] });
    const missing = createAssetThumbnailRevisionIndex([material, fn]);
    const restored = createAssetThumbnailRevisionIndex([material, fn, asset("missing", "Texture")]);
    expect(await missing.cacheKey("material")).not.toBeNull();
    expect(await restored.cacheKey("material")).not.toBe(await missing.cacheKey("material"));
  });

  it("captures actor classes and legacy actor graphs while leaving ordinary classes as icons", async () => {
    const revisions = createAssetThumbnailRevisionIndex([
      asset("actor", "Class", { parentClass: "Actor" }),
      asset("legacy", "Graph"),
      asset("object", "Class", { parentClass: "BObject" }),
      asset("component", "Class", { parentClass: "MeshComponent" }),
    ]);
    expect(await revisions.cacheKey("actor")).not.toBeNull();
    expect(await revisions.cacheKey("legacy")).not.toBeNull();
    expect(await revisions.cacheKey("object")).toBeNull();
    expect(await revisions.cacheKey("component")).toBeNull();
  });
});
