import type { AbstractMesh } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultTilemapPayload, normalizeTilesetPayload, setTile } from "@babylonslate/assets";
import { createActor, createDefaultScene } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { EditorSceneSync } from "./editor-scene-sync";
import { applySceneToBabylonScene, editorComponentMeshName } from "./scene-loader";
import { applyAssignMesh, createSnapshotSceneBinding, migratePlaySlotVisual } from "./snapshot-apply";
import { compareAlphaTestDraws, resolveSortingLayer } from "./sorting";

const layers = ["Background", "Default", "Decals", "Props", "Foreground", "UI"];
function assets() {
  const base = setTile(createDefaultTilemapPayload(), "layer-1", 0, 0, 1);
  const map = { ...base, tilesetGuid: "atlas", layers: [
    { ...base.layers[0]!, id: "front", sortingLayer: "Props", orderInLayer: -2 },
    { ...base.layers[0]!, id: "back", sortingLayer: "Decals", orderInLayer: 10 },
  ] };
  return { sortingLayers: layers, tilemaps: new Map([["map", map]]), tilesets: new Map([["atlas", normalizeTilesetPayload({})]]) };
}
function ordered(meshes: AbstractMesh[]) {
  return meshes.flatMap((mesh) => mesh.subMeshes).sort(compareAlphaTestDraws).map((sub) => sub.getMesh());
}

describe("Tilemap component sorting groups", () => {
  const handles: ReturnType<typeof createTestEngine>[] = [];
  afterEach(() => { for (const { scene, engine } of handles.splice(0)) { scene.dispose(); engine.dispose(); } });

  it("keeps asset layers internal and refreshes custom ordering without rebuilding editor geometry", () => {
    const handle = createTestEngine(); handles.push(handle);
    const content = assets();
    const actor = createActor("actor", "Map and sprite", { components: [
      { id: "map", classId: "TilemapComponent", properties: { assetGuid: "map", sortingLayer: "Default", orderInLayer: 5 } },
      { id: "sprite", classId: "SpriteComponent", properties: { sortingLayer: "Props", orderInLayer: 8 } },
    ] });
    const data = { ...createDefaultScene("2d"), actors: [actor] };
    applySceneToBabylonScene(handle.scene, data, content);
    const full = handle.scene.getMeshByName(editorComponentMeshName("actor", "map"))!;
    expect(full.getChildMeshes().every((child) => child.alphaIndex === resolveSortingLayer(layers, "Default", 5).sortKey)).toBe(true);
    const sync = new EditorSceneSync(handle.scene);
    sync.setMeshAssets(content); sync.apply(data);
    const root = sync.meshForActor("actor")!;
    const map = root.getChildMeshes().find((child) => child.name === editorComponentMeshName("actor", "map"))!;
    const sprite = root.getChildMeshes().find((child) => child.name === editorComponentMeshName("actor", "sprite"))!;
    expect(sprite.alphaIndex).toBe(resolveSortingLayer(layers, "Props", 8).sortKey);
    const chunks = map.getChildMeshes();
    expect(ordered(chunks).map((mesh) => mesh.metadata.tilemapLayer.name)).toEqual(["Decals", "Props"]);
    expect(chunks.every((chunk) => chunk.renderingGroupId === 1 && chunk.alphaIndex === map.alphaIndex)).toBe(true);
    sync.setSortingLayers(["Default", "Props", "Decals"]);
    expect(sync.meshForActor("actor")).toBe(root);
    expect(ordered(chunks).map((mesh) => mesh.metadata.tilemapLayer.name)).toEqual(["Props", "Decals"]);
    sync.dispose();
  });

  it("retains each Play component's sorting across migration and never interleaves tied groups", () => {
    const world = createTestEngine(); const overlay = createTestEngine(); handles.push(world, overlay);
    const binding = Object.assign(createSnapshotSceneBinding(), assets());
    applyAssignMesh(world.scene, binding, {
      type: "assignMesh", slotId: 1, actorGuid: "actor", meshKind: "tilemap", meshAssetGuid: "map",
      sortingLayer: "UI", orderInLayer: 99,
      parts: [
        { componentId: "map", meshKind: "tilemap", meshAssetGuid: "map", sortingLayer: "Default", orderInLayer: 4, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        { componentId: "sprite", meshKind: "sprite", meshAssetGuid: null, sortingLayer: "Props", orderInLayer: 8, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      ],
    });
    for (const target of [world.scene, overlay.scene]) {
      migratePlaySlotVisual(target, binding, 1);
      const root = binding.meshes.get(1)!;
      const map = root.getChildMeshes().find((child) => child.metadata?.sortingGroupId === "actor|map")!;
      const sprite = root.getChildMeshes().find((child) => child.metadata?.sortingGroupId === "actor|sprite")!;
      expect(map.alphaIndex).toBe(resolveSortingLayer(layers, "Default", 4).sortKey);
      expect(sprite.alphaIndex).toBe(resolveSortingLayer(layers, "Props", 8).sortKey);
      expect(ordered(map.getChildMeshes()).map((mesh) => mesh.metadata.tilemapLayer.name)).toEqual(["Decals", "Props"]);
    }
    applyAssignMesh(overlay.scene, binding, { type: "assignMesh", slotId: 2, actorGuid: "other", meshKind: "tilemap", meshAssetGuid: "map", sortingLayer: "Default", orderInLayer: 4 });
    const all = [...binding.meshes.values()].flatMap((root) => root.getChildMeshes()).filter((mesh) => mesh.metadata?.tilemapLayer);
    expect(ordered(all).map((mesh) => mesh.metadata.sortingGroupId)).toEqual(["actor|map", "actor|map", "other|", "other|"]);
  });
});
