import { describe, expect, it } from "vitest";
import {
  createDefaultTilesetPayload,
  normalizeTilesetPayload,
  tilesetAtlasColumns,
  tilesetTileUv,
} from "./tileset-payload";

describe("tileset payload", () => {
  it("defaults to a 16px grid with tile 1 and no collision", () => {
    const payload = createDefaultTilesetPayload();
    expect(payload.textureGuid).toBeNull();
    expect(payload.atlasWidth).toBe(16);
    expect(payload.atlasHeight).toBe(16);
    expect(payload.tileWidth).toBe(16);
    expect(payload.tileHeight).toBe(16);
    expect(payload.margin).toBe(0);
    expect(payload.spacing).toBe(0);
    expect(payload.tiles).toEqual([
      { id: 1, collision: "none", flags: 0, animation: [] },
    ]);
  });

  it("normalizes invalid sizes and drops tile id 0", () => {
    const payload = normalizeTilesetPayload({
      tileWidth: 0,
      tileHeight: -4,
      margin: -1,
      spacing: -2,
      atlasWidth: 0,
      tiles: [
        { id: 0, collision: "full" },
        { id: 2, collision: "full", flags: 3 },
        { id: 2, collision: "none" },
      ],
    });
    expect(payload.tileWidth).toBe(16);
    expect(payload.tileHeight).toBe(16);
    expect(payload.margin).toBe(0);
    expect(payload.spacing).toBe(0);
    expect(payload.atlasWidth).toBe(16);
    expect(payload.tiles.map((tile) => tile.id)).toEqual([2]);
    expect(payload.tiles[0]?.collision).toBe("full");
    expect(payload.tiles[0]?.flags).toBe(3);
  });

  it("computes GL UVs with image-space row 0 at the top", () => {
    const tileset = normalizeTilesetPayload({
      atlasWidth: 64,
      atlasHeight: 32,
      tileWidth: 16,
      tileHeight: 16,
    });
    expect(tilesetAtlasColumns(tileset)).toBe(4);
    expect(tilesetTileUv(tileset, 0)).toBeNull();
    expect(tilesetTileUv(tileset, 1)).toEqual({
      u0: 0,
      v0: 0.5,
      u1: 0.25,
      v1: 1,
    });
    expect(tilesetTileUv(tileset, 5)).toEqual({
      u0: 0,
      v0: 0,
      u1: 0.25,
      v1: 0.5,
    });
  });
});
