import { NullEngine, Scene, VertexBuffer } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDefaultTilemapPayload,
  normalizeTilesetPayload,
  setTile,
} from "@babylonslate/assets";
import { createTilemapMeshes } from "./tilemap-mesh";

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
});
