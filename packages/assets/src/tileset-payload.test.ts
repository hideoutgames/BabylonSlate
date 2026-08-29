import { describe, expect, it } from "vitest";
import {
  atlasCellAt,
  createDefaultTilesetPayload,
  ensureTilesetTiles,
  normalizeTilesetPayload,
  tilesetAtlasColumns,
  tilesetAtlasRows,
  tilesetTileRect,
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

  it("fills missing atlas cells so every tile can be authored", () => {
    const tileset = ensureTilesetTiles(
      normalizeTilesetPayload({
        atlasWidth: 32,
        atlasHeight: 16,
        tileWidth: 16,
        tileHeight: 16,
        tiles: [{ id: 1, collision: "full", flags: 2, animation: [1, 2] }],
      }),
    );
    expect(tilesetAtlasRows(tileset)).toBe(1);
    expect(tileset.tiles.map((tile) => tile.id)).toEqual([1, 2]);
    expect(tileset.tiles[0]).toMatchObject({
      collision: "full",
      flags: 2,
      animation: [1, 2],
    });
    expect(tileset.tiles[1]).toMatchObject({
      id: 2,
      collision: "none",
      flags: 0,
      animation: [],
    });
  });

  it("returns image-space atlas rects with row 0 at the top", () => {
    const tileset = normalizeTilesetPayload({
      atlasWidth: 40,
      atlasHeight: 20,
      tileWidth: 16,
      tileHeight: 16,
      margin: 2,
      spacing: 2,
    });
    expect(tilesetTileRect(tileset, 0)).toBeNull();
    expect(tilesetTileRect(tileset, 1)).toEqual({
      x: 2,
      y: 2,
      width: 16,
      height: 16,
    });
    expect(tilesetTileRect(tileset, 2)).toEqual({
      x: 20,
      y: 2,
      width: 16,
      height: 16,
    });
  });

  it("maps a pointer on a displayed atlas onto a 1-based tile id", () => {
    const tileset = normalizeTilesetPayload({
      atlasWidth: 32,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
    });
    expect(
      atlasCellAt({
        localX: 8,
        localY: 8,
        imageX: 0,
        imageY: 0,
        imageWidth: 32,
        imageHeight: 16,
        tileset,
      }),
    ).toBe(1);
    expect(
      atlasCellAt({
        localX: 24,
        localY: 8,
        imageX: 0,
        imageY: 0,
        imageWidth: 32,
        imageHeight: 16,
        tileset,
      }),
    ).toBe(2);
    expect(
      atlasCellAt({
        localX: -1,
        localY: 8,
        imageX: 0,
        imageY: 0,
        imageWidth: 32,
        imageHeight: 16,
        tileset,
      }),
    ).toBe(0);
  });
});
