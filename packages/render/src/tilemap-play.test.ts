import { VertexBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultTilemapPayload, normalizeTilesetPayload, setTile } from "@babylonslate/assets";
import { createTestEngine } from "./create-null-engine";
import { applyAssignMesh, applySnapshotToScene, createSnapshotSceneBinding, migratePlaySlotVisual } from "./snapshot-apply";

describe("Tilemap Play presentation", () => {
  const handles: ReturnType<typeof createTestEngine>[] = [];
  afterEach(() => { for (const { scene, engine } of handles.splice(0)) { scene.dispose(); engine.dispose(); } });

  it("seeks newly built and migrated animated chunks to the retained simulation clock", () => {
    const world = createTestEngine();
    const overlay = createTestEngine();
    handles.push(world, overlay);
    const binding = createSnapshotSceneBinding();
    const map = { ...setTile(createDefaultTilemapPayload(), "layer-1", 0, 0, 1), tilesetGuid: "atlas" };
    binding.tilemapPayloads = new Map([["map", map]]);
    binding.tilesetPayloads = new Map([["atlas", normalizeTilesetPayload({ atlasWidth: 32, tiles: [{ id: 1, animation: [1, 2] }] })]]);
    applyAssignMesh(world.scene, binding, { type: "assignMesh", slotId: 1, meshKind: "tilemap", meshAssetGuid: "map" });
    const first = [...binding.meshes.get(1)!.getChildMeshes()[0]!.getVerticesData(VertexBuffer.UVKind)!];
    const snapshot = { frameId: 1, tickIndex: 1, alpha: 1, actors: [{ slotId: 1, flags: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } }] };
    binding.tilemapAnimationTimeMs = 100;
    applySnapshotToScene(world.scene, binding, snapshot);
    const second = [...binding.meshes.get(1)!.getChildMeshes()[0]!.getVerticesData(VertexBuffer.UVKind)!];
    expect(second).not.toEqual(first);
    applySnapshotToScene(world.scene, binding, snapshot);
    expect([...binding.meshes.get(1)!.getChildMeshes()[0]!.getVerticesData(VertexBuffer.UVKind)!]).toEqual(second);
    binding.isOverlaySlot = () => true;
    binding.sceneForSlot = () => overlay.scene;
    migratePlaySlotVisual(overlay.scene, binding, 1);
    applySnapshotToScene(world.scene, binding, snapshot);
    expect(binding.meshes.get(1)!.getScene()).toBe(overlay.scene);
    expect([...binding.meshes.get(1)!.getChildMeshes()[0]!.getVerticesData(VertexBuffer.UVKind)!]).toEqual(second);
  });
});
