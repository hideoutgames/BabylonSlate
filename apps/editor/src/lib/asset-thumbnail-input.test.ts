import { describe, expect, it, vi } from "vitest";
import { createDefaultSpritePayload, type IndexedAsset } from "@babylonslate/assets";
import { createMeshComponent, identitySerializedTransform } from "@babylonslate/core";
import { createDefaultMaterialDocument, createDefaultMaterialFunctionDocument } from "@babylonslate/shader-graph";
import { prepareAssetThumbnailInput } from "./asset-thumbnail-input";

function asset(guid: string, type: string, payload: Record<string, unknown> = {}, parentClass?: string): IndexedAsset {
  return {
    rootId: "project",
    path: `Content/${guid}.${type.toLowerCase()}.babasset`,
    header: {
      guid, type, name: guid, parentClass, payload,
      engineVersion: "0.0.0", version: 1, mode: "thin", dependencies: [], chunks: [],
    },
  };
}

function saved(entry: IndexedAsset, content: unknown, bytes: Map<string, Uint8Array>): IndexedAsset {
  entry.header.chunks.push({
    id: "document", kind: "document", mime: "application/json", sha256: `${entry.header.guid}-saved`,
    locator: { blob: `${entry.header.guid}-saved` },
  });
  bytes.set(`${entry.path}/document`, new TextEncoder().encode(JSON.stringify(content)));
  return entry;
}

function fixture(assets: IndexedAsset[], bytes = new Map<string, Uint8Array>()) {
  return {
    registry: {
      list: () => assets,
      getByGuid: (guid: string) => assets.find((entry) => entry.header.guid === guid),
    },
    readAssetChunk: vi.fn(async (path: string, id: string) => bytes.get(`${path}/${id}`) ?? null),
    collectTextureBytes: vi.fn(async (guids: readonly string[]) =>
      new Map(guids.map((guid) => [guid, new Uint8Array([7])])),
    ),
  };
}

function node(id: string, properties: Record<string, unknown>) {
  return { id, type: "function.call", position: { x: 0, y: 0 }, properties };
}

describe("prepareAssetThumbnailInput", () => {
  it("loads the saved material and transitive function textures without unrelated documents or preview models", async () => {
    const bytes = new Map<string, Uint8Array>();
    const material = createDefaultMaterialDocument("Saved Material");
    material.preview = { mesh: "custom", customMeshGuid: "unused-model" };
    material.nodes.push(node("outer", { functionGuid: "outer" }));
    const outer = createDefaultMaterialFunctionDocument("Outer");
    outer.nodes.push(node("inner", { functionGuid: "inner" }));
    const inner = createDefaultMaterialFunctionDocument("Inner");
    inner.nodes.push(node("texture", { textureGuid: "texture", functionGuid: "outer" }));
    const selected = saved(asset("material", "Material", { name: "Stale Header" }), material, bytes);
    const inputs = fixture([
      selected,
      saved(asset("outer", "MaterialFunction"), outer, bytes),
      saved(asset("inner", "MaterialFunction"), inner, bytes),
      asset("unused-material", "Material"),
      asset("unused-model", "Model"),
      asset("texture", "Texture", { width: 4096, height: 2048 }),
    ], bytes);

    const result = await prepareAssetThumbnailInput({ asset: selected, ...inputs });

    expect(result?.kind).toBe("Material");
    expect(result?.materials.get("material")?.name).toBe("Saved Material");
    expect([...result!.materials.keys()]).toEqual(["material"]);
    expect(Object.keys(result!.functions!)).toEqual(["outer", "inner"]);
    expect([...result!.assets!.textureBytes!.keys()]).toEqual(["texture"]);
    expect(result?.assets?.texturePixelSizes?.get("texture")).toEqual({ width: 4096, height: 2048 });
    expect(inputs.collectTextureBytes).toHaveBeenCalledWith(["texture"]);
    expect(inputs.readAssetChunk.mock.calls.map(([path]) => path)).toEqual([
      "Content/material.material.babasset",
      "Content/outer.materialfunction.babasset",
      "Content/inner.materialfunction.babasset",
    ]);
  });

  it("captures inherited saved prefab transforms with model slot materials and sprite textures", async () => {
    const bytes = new Map<string, Uint8Array>();
    const parentMesh = createMeshComponent("mesh", "box");
    const childMesh = {
      ...parentMesh,
      properties: { ...parentMesh.properties, meshKind: "model", assetGuid: "model" },
      transform: { ...identitySerializedTransform(), position: [2, 3, 4] },
    };
    const parent = saved(asset("Parent", "Class", {}, "Actor"), {
      nodes: [], edges: [], components: [parentMesh, {
        id: "sprite", classId: "SpriteComponent", parentId: "mesh",
        transform: identitySerializedTransform(), properties: { assetGuid: "sprite" },
      }],
    }, bytes);
    const selected = saved(asset("Child", "Class", {}, "Parent"), {
      nodes: [], edges: [], components: [childMesh],
    }, bytes);
    const model = asset("model", "Model", {
      materialSlots: [{ index: 0, name: "Surface", materialGuid: "slot-material" }],
      importScale: 0.5,
    });
    model.header.chunks.push({ id: "source", kind: "source", mime: "model/gltf-binary", sha256: "model", locator: { blob: "model" } });
    bytes.set(`${model.path}/source`, new Uint8Array([1, 2, 3]));
    const inputs = fixture([
      selected, parent, model,
      asset("sprite", "Sprite", { ...createDefaultSpritePayload(), textureGuid: "atlas" }),
      asset("atlas", "Texture", { width: 512, height: 256 }),
      saved(asset("slot-material", "Material"), createDefaultMaterialDocument("Slot"), bytes),
      saved(asset("unrelated", "Class", {}, "Actor"), { nodes: [], edges: [] }, bytes),
    ], bytes);

    const result = await prepareAssetThumbnailInput({ asset: selected, ...inputs, pixelsPerUnit: 64 });

    expect(result?.kind).toBe("ActorPrefab");
    if (result?.kind !== "ActorPrefab") throw new Error("Expected an Actor Prefab");
    expect(result.prefab.actors.find((actor) => actor.id === "mesh")?.transform.position).toEqual([2, 3, 4]);
    expect(result.prefab.actors.find((actor) => actor.id === "sprite")?.parentId).toBe("mesh");
    expect(result.assets?.modelBytes?.get("model")).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.assets?.modelPayloads?.get("model")).toMatchObject({ importScale: 0.5, autoLod: false });
    expect([...result.materials.keys()]).toEqual(["slot-material"]);
    expect(result.assets?.spritePayloads?.get("sprite")?.textureGuid).toBe("atlas");
    expect(result.assets?.texturePixelSizes?.get("atlas")).toEqual({ width: 512, height: 256 });
    expect(result.assets?.pixelsPerUnit).toBe(64);
    expect(inputs.collectTextureBytes).toHaveBeenCalledWith(["atlas"]);
    expect(inputs.readAssetChunk.mock.calls.some(([path]) => path.includes("unrelated"))).toBe(false);
  });

  it("stops loading dependencies when the tile is cancelled during a saved document read", async () => {
    const bytes = new Map<string, Uint8Array>();
    const material = createDefaultMaterialDocument();
    material.nodes.push(node("nested", { functionGuid: "nested", textureGuid: "texture" }));
    const selected = saved(asset("material", "Material"), material, bytes);
    const inputs = fixture([selected, asset("nested", "MaterialFunction")], bytes);
    let active = true;
    inputs.readAssetChunk.mockImplementation(async (path, id) => {
      active = false;
      return bytes.get(`${path}/${id}`) ?? null;
    });

    expect(await prepareAssetThumbnailInput({ asset: selected, ...inputs, shouldContinue: () => active })).toBeNull();
    expect(inputs.readAssetChunk).toHaveBeenCalledTimes(1);
    expect(inputs.collectTextureBytes).not.toHaveBeenCalled();
  });

  it("prepares legacy Graph prefabs with an omitted parent as Actor descendants", async () => {
    const selected = asset("legacy", "Graph", { nodes: [], edges: [], components: [createMeshComponent("mesh", "sphere")] });
    const result = await prepareAssetThumbnailInput({ asset: selected, ...fixture([selected]) });

    expect(result?.kind).toBe("ActorPrefab");
    if (result?.kind !== "ActorPrefab") throw new Error("Expected an Actor Prefab");
    expect(result.prefab.actors.find((actor) => actor.id === "mesh")?.components[0]?.properties.meshKind).toBe("sphere");
  });

  it("selects a front-facing capture for a sprite-only prefab", async () => {
    const selected = asset("prefab", "Class", { components: [{
      id: "sprite", classId: "SpriteComponent", properties: { assetGuid: "sprite" },
      transform: identitySerializedTransform(),
    }] }, "Actor");
    const sprite = asset("sprite", "Sprite", { ...createDefaultSpritePayload() });
    const result = await prepareAssetThumbnailInput({ asset: selected, ...fixture([selected, sprite]) });

    expect(result?.kind).toBe("ActorPrefab");
    if (result?.kind !== "ActorPrefab") throw new Error("Expected an Actor Prefab");
    expect(result.prefab.settings.physicsWorld).toBe("2d");
  });

  it("does not capture an editor placeholder when a referenced Model source is missing", async () => {
    const component = createMeshComponent("mesh", "box");
    component.properties.assetGuid = "model";
    const selected = asset("prefab", "Class", { components: [component] }, "Actor");
    const model = asset("model", "Model");
    model.header.chunks.push({ id: "source", kind: "source", mime: "model/gltf-binary", sha256: "missing", locator: { blob: "missing" } });
    const inputs = fixture([selected, model]);

    expect(await prepareAssetThumbnailInput({ asset: selected, ...inputs })).toBeNull();
    expect(inputs.collectTextureBytes).not.toHaveBeenCalled();
  });

  it("does not read non-Actor classes or cyclic inheritance", async () => {
    const ordinary = asset("ordinary", "Class", {}, "BObject");
    const cycleA = asset("cycleA", "Class", {}, "cycleB");
    const cycleB = asset("cycleB", "Graph", {}, "cycleA");
    const inputs = fixture([ordinary, cycleA, cycleB]);

    expect(await prepareAssetThumbnailInput({ asset: ordinary, ...inputs })).toBeNull();
    expect(await prepareAssetThumbnailInput({ asset: cycleA, ...inputs })).toBeNull();
    expect(inputs.readAssetChunk).not.toHaveBeenCalled();
    expect(inputs.collectTextureBytes).not.toHaveBeenCalled();
  });
});
