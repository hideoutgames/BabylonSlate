import { describe, expect, it } from "vitest";
import {
  chunkCoordForTile,
  createDefaultTilemapPayload,
  emptyChunkTiles,
  getTile,
  localIndex,
  normalizeTilemapPayload,
  setTile,
} from "./tilemap-payload";

describe("tilemap payload", () => {
  it("defaults to one collision layer and 32-tile chunks", () => {
    const payload = createDefaultTilemapPayload();
    expect(payload.tilesetGuid).toBeNull();
    expect(payload.tileWidth).toBe(16);
    expect(payload.tileHeight).toBe(16);
    expect(payload.chunkSize).toBe(32);
    expect(payload.layers).toHaveLength(1);
    expect(payload.layers[0]).toMatchObject({
      id: "layer-1",
      name: "Ground",
      visible: true,
      collision: true,
      sortingLayer: "Default",
      orderInLayer: 0,
      parallax: { x: 1, y: 1 },
      chunks: [],
    });
    expect(emptyChunkTiles(32)).toHaveLength(1024);
    expect(emptyChunkTiles(32).every((id) => id === 0)).toBe(true);
  });

  it("indexes local tiles with (0,0) at the chunk bottom-left", () => {
    expect(localIndex(0, 0, 32)).toBe(0);
    expect(localIndex(1, 0, 32)).toBe(1);
    expect(localIndex(0, 1, 32)).toBe(32);
  });

  it("maps world tiles onto chunks, including negatives", () => {
    expect(chunkCoordForTile(0, 0, 32)).toEqual({ cx: 0, cy: 0, lx: 0, ly: 0 });
    expect(chunkCoordForTile(32, 31, 32)).toEqual({
      cx: 1,
      cy: 0,
      lx: 0,
      ly: 31,
    });
    expect(chunkCoordForTile(-1, -1, 32)).toEqual({
      cx: -1,
      cy: -1,
      lx: 31,
      ly: 31,
    });
  });

  it("sets and reads tiles, creating only the affected chunk", () => {
    let map = createDefaultTilemapPayload();
    map = setTile(map, "layer-1", 1, 2, 7);
    expect(getTile(map, "layer-1", 1, 2)).toBe(7);
    expect(getTile(map, "layer-1", 0, 0)).toBe(0);
    expect(map.layers[0]?.chunks).toHaveLength(1);
    expect(map.layers[0]?.chunks[0]).toMatchObject({ cx: 0, cy: 0 });
  });

  it("normalizes missing layers and clamps chunk size", () => {
    const payload = normalizeTilemapPayload({
      chunkSize: 0,
      layers: [{ name: "BG", chunks: [{ cx: 0, cy: 0, tiles: [1] }] }],
    });
    expect(payload.chunkSize).toBe(32);
    expect(payload.layers[0]?.id).toBeTruthy();
    expect(payload.layers[0]?.chunks[0]?.tiles).toHaveLength(32 * 32);
    expect(payload.layers[0]?.chunks[0]?.tiles[0]).toBe(1);
  });
});
