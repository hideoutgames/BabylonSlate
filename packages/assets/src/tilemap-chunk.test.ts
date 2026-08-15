import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  normalizeGoldenText,
  readGolden,
  writeGolden,
} from "@babylonslate/test-kit";
import { tilemapChunkVertexData, tilemapParallaxOffset } from "./tilemap-chunk";
import { emptyChunkTiles } from "./tilemap-payload";
import { normalizeTilesetPayload } from "./tileset-payload";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const UPDATE = process.env.UPDATE_GOLDENS === "1";

describe("tilemapChunkVertexData", () => {
  it("skips empty tile 0 and emits one XY quad in BL-BR-TR-TL order", () => {
    const tileset = normalizeTilesetPayload({
      atlasWidth: 16,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
    });
    const tiles = emptyChunkTiles(2);
    tiles[0] = 1;
    const data = tilemapChunkVertexData({
      tiles,
      chunkSize: 2,
      chunkX: 0,
      chunkY: 0,
      tileset,
      worldTileWidth: 1,
      worldTileHeight: 1,
    });
    expect(data.positions).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    expect(data.uvs).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
    expect(data.indices).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it("is golden-stable for a two-tile chunk with margin and spacing", () => {
    const tileset = normalizeTilesetPayload({
      atlasWidth: 40,
      atlasHeight: 20,
      tileWidth: 16,
      tileHeight: 16,
      margin: 2,
      spacing: 2,
    });
    const tiles = emptyChunkTiles(2);
    tiles[0] = 1;
    tiles[3] = 2;
    const data = tilemapChunkVertexData({
      tiles,
      chunkSize: 2,
      chunkX: 1,
      chunkY: 0,
      tileset,
      worldTileWidth: 0.16,
      worldTileHeight: 0.16,
    });
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    const relative = "__fixtures__/tilemap-chunk.golden.json";
    if (UPDATE) {
      writeGolden(FIXTURE_DIR, relative, serialized);
    }
    expect(normalizeGoldenText(serialized)).toBe(
      normalizeGoldenText(readGolden(FIXTURE_DIR, relative)),
    );
  });

  it("keeps animated tiles out of the static chunk and in the animated set", () => {
    const tileset = normalizeTilesetPayload({
      atlasWidth: 32,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
      tiles: [
        { id: 1, collision: "none", animation: [] },
        { id: 2, collision: "none", animation: [2, 3] },
      ],
    });
    const tiles = emptyChunkTiles(2);
    tiles[0] = 1;
    tiles[1] = 2;
    const staticData = tilemapChunkVertexData({
      tiles,
      chunkSize: 2,
      chunkX: 0,
      chunkY: 0,
      tileset,
      worldTileWidth: 1,
      worldTileHeight: 1,
      kind: "static",
    });
    const animatedData = tilemapChunkVertexData({
      tiles,
      chunkSize: 2,
      chunkX: 0,
      chunkY: 0,
      tileset,
      worldTileWidth: 1,
      worldTileHeight: 1,
      kind: "animated",
    });
    expect(staticData.positions).toHaveLength(12);
    expect(animatedData.positions).toHaveLength(12);
    expect(staticData.positions[0]).toBe(0);
    expect(animatedData.positions[0]).toBe(1);
  });
});

describe("tilemapParallaxOffset", () => {
  it("keeps world lock at 1 and tracks the camera at 0", () => {
    expect(tilemapParallaxOffset({ x: 1, y: 1 }, { x: 10, y: 4 })).toEqual({
      x: 0,
      y: 0,
    });
    expect(tilemapParallaxOffset({ x: 0, y: 0.5 }, { x: 10, y: 4 })).toEqual({
      x: 10,
      y: 2,
    });
  });
});
