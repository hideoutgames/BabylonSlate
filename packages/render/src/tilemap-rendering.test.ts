import { Color3 } from "@babylonjs/core/Maths/math.color";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createMeshComponent } from "@haptic/core";
import { createDefaultSpritePayload, createDefaultTilemapPayload, normalizeTilesetPayload, setTile, type TilemapPayload } from "@haptic/assets";
import { createTestEngine } from "./test-support/test-engine";
import { EditorSceneSync } from "./editor-scene-sync";
import { applyTilemapAlbedoTextures, type MeshAssetContext } from "./mesh-assets";
import { isDisposedGpuTexture } from "./gpu-resource-live";
import { ResourceCache } from "./resource-cache";
import { createActorMesh } from "./scene-loader";
import { applyAssignMaterial, applyAssignMesh, createSnapshotSceneBinding } from "./snapshot-apply";
import { isUnlitMaterial } from "./unlit-material";
import { unlitBinding } from "./unlit-material-blocks";

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

  function content(textureGuid: string | null = "atlas") {
    const tileset = normalizeTilesetPayload({
      textureGuid,
      atlasWidth: 32,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
    });
    const tilemap = setTile({
      ...createDefaultTilemapPayload(),
      chunkSize: 2,
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
    const tile = chunk(root);
    const material = tile.material!;

    expect(unlitBinding(tile).texture).toBeTruthy();
    expect(isUnlitMaterial(material)).toBe(true);
    expect(material.backFaceCulling).toBe(false);
    expect(material.fogEnabled).toBe(false);
    expect((material as NodeMaterial).imageProcessingConfiguration.isEnabled).toBe(false);
    expect(material.needAlphaTestingForMesh(tile)).toBe(true);
  });

  it("draws a Tileset without an atlas image unlit with one placeholder colour per tile", async () => {
    const { assets, actor, tilemap } = content(null);
    const { scene } = handle;
    new HemisphericLight("sun", new Vector3(0, 1, 0), scene);
    scene.fogMode = 3;
    // Five cells across three chunks of 2x2 cells.
    let painted = tilemap;
    for (const [x, y, id] of [[1, 0, 2], [0, 2, 1], [1, 2, 2], [3, 3, 1]] as const) painted = setTile(painted, "layer-1", x, y, id);
    assets.tilemaps = new Map([["tilemap", painted]]);

    const root = createActorMesh(scene, actor, assets);
    const chunks = root.getChildMeshes();
    expect(chunks).toHaveLength(3);
    expect(chunks.reduce((vertices, tile) => vertices + tile.getTotalVertices(), 0)).toBe(5 * 4);
    const material = chunks[0]!.material as NodeMaterial;
    expect(chunks.every((tile) => tile.material === material)).toBe(true);
    expect(unlitBinding(chunks[0]!).texture).toBeNull();
    expect(isUnlitMaterial(material)).toBe(true);
    expect(material.backFaceCulling).toBe(false);
    expect(material.fogEnabled).toBe(false);
    expect(material.imageProcessingConfiguration.isEnabled).toBe(false);

    // hsl(47 55% 48%) and hsl(94 55% 48%), the paint canvas colours of tiles 1 and 2.
    const colors = chunks.find((tile) => tile.getTotalVertices() === 8)!.getVerticesData(VertexBuffer.ColorKind)!;
    expect(colors).toHaveLength(8 * 4);
    [0.744, 0.6296, 0.216, 1, 0.4448, 0.744, 0.216, 1].forEach((value, index) => {
      expect(colors[(index < 4 ? 0 : 16) + (index % 4)]).toBeCloseTo(value, 5);
    });

    const tile = chunks[0]!;
    scene.incrementRenderId();
    await material.forceCompilationAsync(tile);
    const subMesh = tile.subMeshes![0]!;
    expect(material.isReadyForSubMesh(tile, subMesh)).toBe(true);
    const defines = subMesh.effect!.defines;
    expect(defines).toContain("#define VERTEXCOLOR");
    expect(defines).not.toContain("#define LIGHT0");
  });

  it("decodes atlas colors once for a Scene Linear display stage, still without scene image processing", async () => {
    const { assets, actor } = content();
    const { scene } = handle;
    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.exposure = 0.1;
    const tile = chunk(createActorMesh(scene, actor, assets));
    const material = tile.material!;
    const displayStages = async () => {
      // A new frame: readiness is cached per render id.
      scene.incrementRenderId();
      await material.forceCompilationAsync(tile);
      const subMesh = tile.subMeshes![0]!;
      expect(material.isReadyForSubMesh(tile, subMesh)).toBe(true);
      return subMesh.effect!.defines.match(/^#define (IMAGEPROCESSING(POSTPROCESS)?|EXPOSURE|TONEMAPPING [1-9])$/gm) ?? [];
    };
    // Legacy Display writes the atlas's display colors unchanged.
    expect(await displayStages()).toEqual([]);
    // Scene Linear: the linear decode Standard's was, so the Display Color stage
    // encodes the tile once.
    scene.imageProcessingConfiguration.applyByPostProcess = true;
    expect(await displayStages()).toEqual(["#define IMAGEPROCESSINGPOSTPROCESS"]);
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
        skeletonGuid: null, importScale: 1, simpleColliders: [], autoLod: true,
      }]]);
    }
    actor.components = [parentMesh, { ...actor.components[0]!, parentId: "mesh" }];
    const lit = new StandardMaterial("lit", handle.scene);
    const sync = new EditorSceneSync(handle.scene, undefined, { resolveMaterial: () => lit });
    sync.setMeshAssets(assets);
    sync.apply({ ...createDefaultScene(), actors: [actor] });

    const tile = chunk(sync.meshForActor(actor.id)!);
    expect(tile.material).not.toBe(lit);
    expect(unlitBinding(tile).texture).toBeTruthy();
    expect(isUnlitMaterial(tile.material)).toBe(true);
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

  it("refreshes painted tiles and layer visibility without changing asset GUIDs", async () => {
    const { assets, actor, tilemap } = content();
    const sync = new EditorSceneSync(handle.scene);
    sync.setMeshAssets(assets);
    sync.apply({ ...createDefaultScene(), actors: [actor] });
    const painted = setTile(tilemap, "layer-1", 1, 0, 2);

    sync.setMeshAssets({ ...assets, tilemaps: new Map([["tilemap", painted]]) });
    await sync.whenEditorModelsReady();
    expect(chunk(sync.meshForActor(actor.id)!).getTotalVertices()).toBe(8);
    sync.setMeshAssets({ ...assets, tilemaps: new Map([["tilemap", {
      ...painted, layers: painted.layers.map((layer) => ({ ...layer, visible: false })),
    }]]) });
    await sync.whenEditorModelsReady();
    expect(sync.meshForActor(actor.id)!.getChildMeshes()).toHaveLength(0);
    sync.dispose();
  });

  it("releases old tilemap and sprite materials when painted content rebuilds", async () => {
    const { assets, actor, tilemap } = content();
    const sprite = { ...createDefaultSpritePayload(), textureGuid: "atlas" };
    assets.spritePayloads = new Map([["sprite", sprite]]);
    const spriteActor = createActor("sprite", "Sprite", {
      components: [{
        id: "sprite-component", classId: "SpriteComponent",
        properties: { assetGuid: "sprite" },
      }],
    });
    const sync = new EditorSceneSync(handle.scene);
    sync.setMeshAssets(assets);
    sync.apply({ ...createDefaultScene(), actors: [actor, spriteActor] });
    const count = handle.scene.materials.length;

    for (const tileId of [2, 1, 2]) {
      const updated = setTile(tilemap, "layer-1", 1, 0, tileId);
      sync.setMeshAssets({ ...assets, tilemaps: new Map([["tilemap", updated]]) });
      await sync.whenEditorModelsReady();
      expect(handle.scene.materials).toHaveLength(count);
    }
    sync.dispose();
  });

  it("reuses owned atlas materials and preserves another texture owner", async () => {
    const { assets, actor } = content();
    const root = createActorMesh(handle.scene, actor, assets);
    const tile = chunk(root);
    const previous = tile.material!;
    const texture = unlitBinding(tile).texture!;
    const count = handle.scene.materials.length;

    applyTilemapAlbedoTextures(root, handle.scene, assets);
    expect(tile.material).toBe(previous);
    expect(handle.scene.materials).toHaveLength(count);
    const borrowed = cache.acquireExisting(texture);
    await borrowed.ready;
    const current = tile.material;
    root.dispose();
    // The Scene's unlit Material outlives the tilemap; it no longer samples its atlas.
    expect(current!.getActiveTextures()).not.toContain(texture);
    expect(isDisposedGpuTexture(texture)).toBe(false);
    borrowed.release();
  });

  it("shows a live Tilemap edit by rebuilding only its changed chunk meshes, and an install of the same content changes nothing", async () => {
    const { assets, actor, tilemap } = content();
    // Chunk 0, 0 and chunk 1, 0 (chunk size 2) both have a tile.
    const map = setTile(tilemap, "layer-1", 2, 0, 1);
    const box = createActor("box", "Box", { components: [createMeshComponent("mesh", "box")] });
    const installed: MeshAssetContext = { ...assets, tilemaps: new Map([["tilemap", map]]), payloadRevisions: new Map([["tilemap", "saved:1"]]) };
    const sync = new EditorSceneSync(handle.scene);
    sync.setMeshAssets(installed);
    sync.apply({ ...createDefaultScene(), actors: [actor, box] });
    const root = sync.meshForActor(actor.id)!;
    const boxRoot = sync.meshForActor(box.id)!;
    const chunkMesh = (cx: number) => root.getChildMeshes().find((mesh) => mesh.name.endsWith(`:layer-1:${cx}:0`))!;
    const first = chunkMesh(0);
    const second = chunkMesh(1);

    const painted = setTile(map, "layer-1", 1, 0, 2);
    sync.setLiveTilemap("tilemap", painted, "open:1");
    expect(sync.meshForActor(actor.id)).toBe(root);
    expect(sync.meshForActor(box.id)).toBe(boxRoot);
    expect(first.isDisposed()).toBe(true);
    expect(chunkMesh(1)).toBe(second);
    expect(chunkMesh(0).getTotalVertices()).toBe(8);
    expect(isUnlitMaterial(chunkMesh(0).material)).toBe(true);
    expect(unlitBinding(chunkMesh(0)).texture).toBeTruthy();

    // A Tilemap tab opened after the Scene read the file holds equal cells in other arrays: no chunk rebuilds.
    const patched = chunkMesh(0);
    sync.setLiveTilemap("tilemap", structuredClone(painted), "open:copy");
    expect(chunkMesh(0)).toBe(patched);
    expect(chunkMesh(1)).toBe(second);
    sync.setLiveTilemap("tilemap", painted, "open:1");

    // A save collects the same content under the same revision: nothing rebuilds.
    expect(sync.setMeshAssets({ ...installed, tilemaps: new Map([["tilemap", structuredClone(painted)]]), payloadRevisions: new Map([["tilemap", "open:1"]]) })).toBe(false);
    expect(sync.meshForActor(actor.id)).toBe(root);
    expect(chunkMesh(1)).toBe(second);

    // A collection that ran during a later edit carries the older map; the live edit stays shown.
    const later = setTile(painted, "layer-1", 3, 0, 2);
    sync.setLiveTilemap("tilemap", later, "open:2");
    expect(sync.setMeshAssets({ ...installed, tilemaps: new Map([["tilemap", painted]]), payloadRevisions: new Map() })).toBe(false);
    expect(chunkMesh(1).getTotalVertices()).toBe(8);

    // Hiding a layer changes what every chunk draws with: only this actor's visual rebuilds.
    sync.setLiveTilemap("tilemap", { ...later, layers: later.layers.map((layer) => ({ ...layer, visible: false })) }, "open:3");
    await sync.whenEditorModelsReady();
    expect(sync.meshForActor(actor.id)).not.toBe(root);
    expect(sync.meshForActor(actor.id)!.getChildMeshes()).toHaveLength(0);
    expect(sync.meshForActor(box.id)).toBe(boxRoot);
    sync.dispose();
  });

  it("patches an unbounded map's negative chunks under its pivot, and rebuilds the actor's visual when the pivot moves", async () => {
    const { assets, actor, tilemap } = content();
    const map: TilemapPayload = setTile({ ...tilemap, unbounded: true, pivot: { x: 0, y: 0 } }, "layer-1", -1, 0, 1);
    const sync = new EditorSceneSync(handle.scene);
    sync.setMeshAssets({ ...assets, pixelsPerUnit: 16, tilemaps: new Map([["tilemap", map]]), payloadRevisions: new Map([["tilemap", "saved:1"]]) });
    sync.apply({ ...createDefaultScene(), actors: [actor] });
    const root = sync.meshForActor(actor.id)!;
    const chunkAt = (cx: number) => sync.meshForActor(actor.id)!.getChildMeshes().find((mesh) => mesh.name.endsWith(`:layer-1:${cx}:0`))!;
    const worldMinX = (mesh: AbstractMesh) => {
      mesh.computeWorldMatrix(true);
      return Math.round(mesh.getBoundingInfo().boundingBox.minimumWorld.x * 1000) / 1000;
    };
    const negative = chunkAt(-1);
    expect(worldMinX(negative)).toBe(-1);
    const kept = chunkAt(0);

    // A cell in the negative chunk rebuilds that chunk only, under the pivot node.
    sync.setLiveTilemap("tilemap", setTile(map, "layer-1", -2, 0, 2), "open:1");
    expect(sync.meshForActor(actor.id)).toBe(root);
    expect(negative.isDisposed()).toBe(true);
    expect(chunkAt(-1).parent?.name).toMatch(/:pivot$/);
    expect(chunkAt(0)).toBe(kept);

    // A pivot change moves every chunk: this actor's visual rebuilds, its tiles one cell to the left.
    sync.setLiveTilemap("tilemap", { ...setTile(map, "layer-1", -2, 0, 2), pivot: { x: 1, y: 0 } }, "open:2");
    await sync.whenEditorModelsReady();
    expect(sync.meshForActor(actor.id)).not.toBe(root);
    expect(worldMinX(chunkAt(-1))).toBe(-3);
    sync.dispose();
  });

  it("gives chunk quads their constant normal and keeps static chunk buffers static", () => {
    const { assets, actor, tilemap, tileset } = content();
    const animated = normalizeTilesetPayload({ ...tileset, tiles: [{ id: 2, animation: [1, 2] }] });
    assets.tilesets = new Map([["tileset", animated]]);
    assets.tilemaps = new Map([["tilemap", setTile(tilemap, "layer-1", 1, 0, 2)]]);
    const root = createActorMesh(handle.scene, actor, assets);
    const [still, moving] = [root.getChildMeshes().find((mesh) => !mesh.name.endsWith(":anim"))!, root.getChildMeshes().find((mesh) => mesh.name.endsWith(":anim"))!];
    expect([...still.getVerticesData(VertexBuffer.NormalKind)!]).toEqual([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]);
    expect(still.getVertexBuffer(VertexBuffer.PositionKind)!.isUpdatable()).toBe(false);
    expect(moving.getVertexBuffer(VertexBuffer.UVKind)!.isUpdatable()).toBe(true);
    root.dispose();
  });

  it("refreshes atlas UVs after a tileset grid edit and reuses equivalent payloads", async () => {
    const { assets, actor, tileset, tilemap } = content();
    const sync = new EditorSceneSync(handle.scene);
    sync.setMeshAssets(assets);
    sync.apply({ ...createDefaultScene(), actors: [actor] });
    const before = chunk(sync.meshForActor(actor.id)!).getVerticesData(VertexBuffer.UVKind);
    const resized = normalizeTilesetPayload({ ...tileset, tileWidth: 8 });
    sync.setMeshAssets({ ...assets, tilesets: new Map([["tileset", resized]]) });
    await sync.whenEditorModelsReady();
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
