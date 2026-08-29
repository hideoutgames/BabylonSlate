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
    const overlap = 0.5 / 16;
    const positions = child.getVerticesData(VertexBuffer.PositionKind);
    expect(Array.from(positions ?? [])).toEqual([
      -overlap,
      -overlap,
      0,
      1 + overlap,
      -overlap,
      0,
      1 + overlap,
      1 + overlap,
      0,
      -overlap,
      1 + overlap,
      0,
    ]);
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

  it("splits a chunk into one child mesh per atlas", () => {
    const ground = normalizeTilesetPayload({
      textureGuid: "ground-tex",
      atlasWidth: 16,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
    });
    const deco = normalizeTilesetPayload({
      textureGuid: "deco-tex",
      atlasWidth: 16,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
    });
    let tilemap = createDefaultTilemapPayload();
    tilemap = {
      ...tilemap,
      chunkSize: 2,
      tilesetGuid: "ground",
      tilesets: [
        { guid: "ground", firstGid: 1, tileCount: 1 },
        { guid: "deco", firstGid: 2, tileCount: 1 },
      ],
    };
    tilemap = setTile(tilemap, "layer-1", 0, 0, 1);
    tilemap = setTile(tilemap, "layer-1", 1, 0, 2);
    const root = createTilemapMeshes(
      scene,
      "actor-0",
      tilemap,
      new Map([
        ["ground", ground],
        ["deco", deco],
      ]),
      1,
      1,
    );
    const children = root.getChildMeshes();
    expect(children).toHaveLength(2);
    const textures = children.map(
      (mesh) => mesh.metadata?.tilemapTextureGuid as string,
    );
    expect(textures.sort()).toEqual(["deco-tex", "ground-tex"]);
  });
});
