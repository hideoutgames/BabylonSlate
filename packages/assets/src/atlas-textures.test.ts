import { describe, expect, it } from "vitest";
import { atlasTextureGuids } from "./atlas-textures";

describe("atlasTextureGuids", () => {
  it("names the textures Tilesets, Sprites and Sprite Animations sample as atlases", () => {
    expect(atlasTextureGuids("Tileset", { textureGuid: "tiles", tileWidth: 16 })).toEqual(["tiles"]);
    expect(atlasTextureGuids("Tileset", { textureGuid: null })).toEqual([]);
    // Every Sprite counts, including a single whole-texture frame.
    expect(atlasTextureGuids("Sprite", {
      textureGuid: "hero",
      frames: [{ name: "idle", u: 0, v: 0, uSize: 1, vSize: 1, durationMs: 100, pivot: { x: 0.5, y: 0.5 } }],
    })).toEqual(["hero"]);
    expect(atlasTextureGuids("Sprite", { textureGuid: "" })).toEqual([]);
    expect(atlasTextureGuids("SpriteAnimation", {
      frameDurationMs: 100,
      frames: [{ textureGuid: "walk-1" }, { textureGuid: "walk-2" }, { textureGuid: "walk-1" }, { textureGuid: "" }],
    })).toEqual(["walk-1", "walk-2"]);
  });

  it("ignores texture references of other asset types", () => {
    expect(atlasTextureGuids("Material", { textureGuid: "tiles" })).toEqual([]);
    expect(atlasTextureGuids("Tilemap", { textureGuid: "tiles" })).toEqual([]);
  });
});
