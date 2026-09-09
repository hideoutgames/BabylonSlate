import { Color3, Material, Mesh, StandardMaterial, VertexBuffer } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createMeshComponent } from "@babylonslate/core";
import { createDefaultTilemapPayload, normalizeTilesetPayload, setTile } from "@babylonslate/assets";
import { createTestEngine } from "./create-null-engine";
import { EditorSceneSync } from "./editor-scene-sync";
import type { MeshAssetContext } from "./mesh-assets";
import { ResourceCache } from "./resource-cache";
import { createActorMesh } from "./scene-loader";
import { applyAssignMaterial, applyAssignMesh, createSnapshotSceneBinding } from "./snapshot-apply";

describe("tilemap rendering", () => {
  let handle: ReturnType<typeof createTestEngine>;
  let cache: ResourceCache;

  beforeEach(() => {
    handle = createTestEngine();
    cache = new ResourceCache();
  });

  afterEach(() => {
    cache.dispose();
    handle.scene.dispose();
    handle.engine.dispose();
  });

  function content() {
    const tileset = normalizeTilesetPayload({
      textureGuid: "atlas",
      atlasWidth: 32,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
    });
    const tilemap = setTile({
      ...createDefaultTilemapPayload(),
      chunkSize: 2,
      tilesetGuid: "tileset",
      tilesets: [{ guid: "tileset", firstGid: 1, tileCount: 2 }],
    }, "layer-1", 0, 0, 1);
    const assets: MeshAssetContext = {
      resourceCache: cache,
      textureBytes: new Map([["atlas", new Uint8Array([1, 2, 3, 4])]]),
      tilemaps: new Map([["tilemap", tilemap]]),
      tilesets: new Map([["tileset", tileset]]),
    };
    const actor = createActor("ground", "Ground", {
      components: [{
        id: "tilemap-component",
        classId: "TilemapComponent",
        properties: { assetGuid: "tilemap" },
      }],
    });
    return { assets, actor, tilemap, tileset };
  }

  function chunk(root: Mesh) {
    return root.getChildMeshes().find((child) =>
      child.metadata?.tilemapTextureGuid === "atlas",
    )!;
  }

  it("keeps atlas colors unlit and visible from either side in a lit 3D scene", () => {
    const { assets, actor } = content();
    handle.scene.ambientColor = new Color3(1, 0, 0);
    handle.scene.fogMode = 3;
    handle.scene.imageProcessingConfiguration.toneMappingEnabled = true;
    handle.scene.imageProcessingConfiguration.exposure = 0.1;

    const root = createActorMesh(handle.scene, actor, assets);
    const material = chunk(root).material as StandardMaterial;

    expect(material.diffuseTexture).toBeTruthy();
    expect(material.disableLighting).toBe(true);
    expect(material.backFaceCulling).toBe(false);
    expect(material.fogEnabled).toBe(false);
    expect(material.imageProcessingConfiguration.isEnabled).toBe(false);
    expect(material.transparencyMode).toBe(Material.MATERIAL_ALPHATEST);
  });

  it.each(["component", "model slot"])("preserves a nested tilemap atlas under a parent mesh %s material", (source) => {
    const { assets, actor } = content();
    const parentMesh = createMeshComponent("mesh", "box");
    if (source === "component") {
      parentMesh.properties.materialGuid = "lit-material";
    } else {
      parentMesh.properties.assetGuid = "model";
      assets.modelPayloads = new Map([["model", {
        materialSlots: [{ index: 0, name: "slot", materialGuid: "lit-material" }],
        clipNames: [], skeletonGuid: null, importScale: 1, simpleColliders: [],
      }]]);
    }
    actor.components = [parentMesh, { ...actor.components[0]!, parentId: "mesh" }];
    const lit = new StandardMaterial("lit", handle.scene);
    const sync = new EditorSceneSync(handle.scene, undefined, { resolveMaterial: () => lit });
    sync.setMeshAssets(assets);
    sync.apply({ ...createDefaultScene(), actors: [actor] });

    const material = chunk(sync.meshForActor(actor.id)!).material as StandardMaterial;
    expect(material).not.toBe(lit);
    expect(material.diffuseTexture).toBeTruthy();
    expect(material.disableLighting).toBe(true);
    sync.dispose();
  });

  it("preserves tilemap atlas materials through Play actor material assignments and clearing", () => {
    const { assets } = content();
    const binding = Object.assign(createSnapshotSceneBinding(), assets);
    const lit = new StandardMaterial("lit", handle.scene);
    binding.resolveMaterial = () => lit;
    applyAssignMesh(handle.scene, binding, {
      type: "assignMesh", slotId: 0, meshKind: "tilemap", meshAssetGuid: "tilemap",
    });
    const tile = chunk(binding.meshes.get(0)!);
    const atlasMaterial = tile.material;

    for (const materialAssetGuid of ["lit-material", null]) {
      applyAssignMaterial(handle.scene, binding, { type: "assignMaterial", slotId: 0, materialAssetGuid });
      expect(tile.material === atlasMaterial).toBe(true);
    }
  });

  it("refreshes painted tiles and layer visibility without changing asset GUIDs", () => {
    const { assets, actor, tilemap } = content();
    const sync = new EditorSceneSync(handle.scene);
    sync.setMeshAssets(assets);
    sync.apply({ ...createDefaultScene(), actors: [actor] });
    const painted = setTile(tilemap, "layer-1", 1, 0, 2);

    sync.setMeshAssets({ ...assets, tilemaps: new Map([["tilemap", painted]]) });
    expect(chunk(sync.meshForActor(actor.id)!).getTotalVertices()).toBe(8);
    sync.setMeshAssets({ ...assets, tilemaps: new Map([["tilemap", {
      ...painted, layers: painted.layers.map((layer) => ({ ...layer, visible: false })),
    }]]) });
    expect(sync.meshForActor(actor.id)!.getChildMeshes()).toHaveLength(0);
    sync.dispose();
  });

  it("refreshes atlas UVs after a tileset grid edit and reuses equivalent payloads", () => {
    const { assets, actor, tileset, tilemap } = content();
    const sync = new EditorSceneSync(handle.scene);
    sync.setMeshAssets(assets);
    sync.apply({ ...createDefaultScene(), actors: [actor] });
    const before = chunk(sync.meshForActor(actor.id)!).getVerticesData(VertexBuffer.UVKind);
    const resized = normalizeTilesetPayload({ ...tileset, tileWidth: 8 });
    sync.setMeshAssets({ ...assets, tilesets: new Map([["tileset", resized]]) });
    const root = sync.meshForActor(actor.id)!;
    expect(chunk(root).getVerticesData(VertexBuffer.UVKind)).not.toEqual(before);

    sync.setMeshAssets({
      ...assets,
      tilemaps: new Map([["tilemap", structuredClone(tilemap)]]),
      tilesets: new Map([["tileset", structuredClone(resized)]]),
    });
    expect(sync.meshForActor(actor.id)).toBe(root);
    sync.dispose();
  });
});
