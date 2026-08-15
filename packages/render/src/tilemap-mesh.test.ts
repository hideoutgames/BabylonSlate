import { NullEngine, Scene, VertexBuffer } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDefaultTilemapPayload,
  normalizeTilesetPayload,
  setTile,
} from "@babylonslate/assets";
import { applyTilemapParallaxToMesh, createTilemapMeshes } from "./tilemap-mesh";

describe("createTilemapMeshes", () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeEach(() => {
    engine = new NullEngine({
      renderWidth: 64,
      renderHeight: 64,
      textureSize: 4,
      deterministicLockstep: false,
      lockstepMaxSteps: 1,
    });
    scene = new Scene(engine);
  });

  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  it("creates one child mesh per non-empty chunk", () => {
    const tileset = normalizeTilesetPayload({
      atlasWidth: 16,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
    });
    let tilemap = createDefaultTilemapPayload();
    tilemap = { ...tilemap, chunkSize: 2 };
    tilemap = setTile(tilemap, "layer-1", 0, 0, 1);
    const root = createTilemapMeshes(scene, "actor-0", tilemap, tileset, 1, 1);
    expect(root.name).toBe("actor-0");
    expect(root.getChildren()).toHaveLength(1);
    const child = root.getChildren()[0] as unknown as {
      getVerticesData: (kind: string) => number[] | null;
    };
    const positions = child.getVerticesData(VertexBuffer.PositionKind);
    expect(Array.from(positions ?? [])).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  });

  it("applies per-layer sorting to chunk meshes", () => {
    const tileset = normalizeTilesetPayload({
      atlasWidth: 16,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
    });
    let tilemap = createDefaultTilemapPayload();
    tilemap = { ...tilemap, chunkSize: 2 };
    tilemap = {
      ...tilemap,
      layers: tilemap.layers.map((layer) => ({
        ...layer,
        sortingLayer: "Foreground",
        orderInLayer: 7,
      })),
    };
    tilemap = setTile(tilemap, "layer-1", 0, 0, 1);
    const root = createTilemapMeshes(scene, "actor-0", tilemap, tileset, 1, 1);
    const child = root.getChildMeshes()[0]!;
    expect(child.renderingGroupId).toBe(2);
    expect(child.alphaIndex).toBeGreaterThan(0);
  });

  it("draws animated tiles as a separate child mesh", () => {
    const tileset = normalizeTilesetPayload({
      atlasWidth: 32,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
      tiles: [
        { id: 1, animation: [] },
        { id: 2, animation: [2, 1] },
      ],
    });
    let tilemap = createDefaultTilemapPayload();
    tilemap = { ...tilemap, chunkSize: 2 };
    tilemap = setTile(tilemap, "layer-1", 0, 0, 1);
    tilemap = setTile(tilemap, "layer-1", 1, 0, 2);
    const root = createTilemapMeshes(scene, "actor-0", tilemap, tileset, 1, 1);
    const names = root.getChildMeshes().map((mesh) => mesh.name);
    expect(names.some((name) => name.endsWith(":anim"))).toBe(true);
    expect(names.some((name) => !name.endsWith(":anim"))).toBe(true);
  });

  it("stores per-layer parallax on chunk meshes", () => {
    const tileset = normalizeTilesetPayload({
      atlasWidth: 16,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
    });
    let tilemap = createDefaultTilemapPayload();
    tilemap = { ...tilemap, chunkSize: 2 };
    tilemap = {
      ...tilemap,
      layers: tilemap.layers.map((layer) => ({
        ...layer,
        parallax: { x: 0.5, y: 0.25 },
      })),
    };
    tilemap = setTile(tilemap, "layer-1", 0, 0, 1);
    const root = createTilemapMeshes(scene, "actor-0", tilemap, tileset, 1, 1);
    const child = root.getChildMeshes()[0]!;
    expect(child.metadata?.tilemapParallax).toEqual({ x: 0.5, y: 0.25 });
    applyTilemapParallaxToMesh(root, { position: { x: 10, y: 4 } });
    expect(child.position.x).toBeCloseTo(5, 6);
    expect(child.position.y).toBeCloseTo(3, 6);
  });

  it("skips hidden layers", () => {
    const tileset = normalizeTilesetPayload({
      atlasWidth: 16,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
    });
    let tilemap = createDefaultTilemapPayload();
    tilemap = { ...tilemap, chunkSize: 2 };
    tilemap = {
      ...tilemap,
      layers: tilemap.layers.map((layer) => ({ ...layer, visible: false })),
    };
    tilemap = setTile(tilemap, "layer-1", 0, 0, 1);
    const root = createTilemapMeshes(scene, "actor-0", tilemap, tileset, 1, 1);
    expect(root.getChildMeshes()).toHaveLength(0);
  });
});
