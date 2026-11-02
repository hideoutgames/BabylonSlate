import { describe, expect, it } from "vitest";
import {
  applyTexturePixelSizeToSprite,
  createDefaultSpritePayload,
  parseSpriteCollision,
  parseSpritePayload,
  spriteCollisionToBox2d,
  spriteWorldSize,
  resizeSpriteCollision,
} from "./sprite-payload";

describe("parseSpritePayload", () => {
  it("reads a stored Sprite and defaults missing or invalid fields", () => {
    expect(parseSpritePayload({
      textureGuid: "hero",
      pixelsPerUnit: 32,
      pivot: { x: 0.25, y: 1 },
      collision: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
    })).toEqual({
      textureGuid: "hero",
      pixelsPerUnit: 32,
      pivot: { x: 0.25, y: 1 },
      collision: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
    });
    expect(parseSpritePayload({ textureGuid: "", pixelsPerUnit: -4, pivot: "centre" })).toEqual(createDefaultSpritePayload());
    expect(parseSpritePayload(null)).toEqual(createDefaultSpritePayload());
  });
});

describe("Sprite size from its Texture", () => {
  it("takes the Texture's pixel size, replacing a stale one, and keeps the Sprite when the size is unknown", () => {
    const sprite = { ...createDefaultSpritePayload(), textureGuid: "hero", width: 10, height: 10 };
    const sized = applyTexturePixelSizeToSprite(sprite, (guid) => (guid === "hero" ? { width: 64, height: 32 } : null));
    expect([sized.width, sized.height]).toEqual([64, 32]);
    expect(applyTexturePixelSizeToSprite(sprite, () => null)).toBe(sprite);
    expect(applyTexturePixelSizeToSprite(createDefaultSpritePayload(), () => ({ width: 8, height: 8 })).width).toBeUndefined();
  });

  it("sizes the quad from pixels over Pixels Per Unit, with 100 px for an unknown size", () => {
    expect(spriteWorldSize({ pixelsPerUnit: 32, width: 64, height: 16 })).toEqual({ width: 2, height: 0.5 });
    expect(spriteWorldSize({ pixelsPerUnit: 50 })).toEqual({ width: 2, height: 2 });
  });
});

describe("sprite collision", () => {
  it("defaults a missing collision to the full image", () => {
    expect(createDefaultSpritePayload().collision).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    expect(parseSpriteCollision(undefined)).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    expect(parseSpriteCollision({ x: 0.25, y: 0.1, width: 0.5, height: 0.4 })).toEqual({
      x: 0.25,
      y: 0.1,
      width: 0.5,
      height: 0.4,
    });
  });

  it("maps a full-image AABB at a centered pivot to a centered box2d collider", () => {
    expect(
      spriteCollisionToBox2d({
        collision: { x: 0, y: 0, width: 1, height: 1 },
        pivot: { x: 0.5, y: 0.5 },
        pixelWidth: 100,
        pixelHeight: 50,
        pixelsPerUnit: 100,
      }),
    ).toEqual({
      translation: { x: 0, y: 0 },
      halfExtents: { x: 0.5, y: 0.25 },
    });
  });

  it("offsets box2d translation when the AABB is not the full image", () => {
    const mapped = spriteCollisionToBox2d({
      collision: { x: 0, y: 0, width: 0.5, height: 1 },
      pivot: { x: 0.5, y: 0.5 },
      pixelWidth: 100,
      pixelHeight: 100,
      pixelsPerUnit: 100,
    });
    expect(mapped.halfExtents).toEqual({ x: 0.25, y: 0.5 });
    expect(mapped.translation.x).toBeCloseTo(-0.25);
    expect(mapped.translation.y).toBeCloseTo(0);
  });

  it("resizes an AABB from an east-handle pointer", () => {
    expect(
      resizeSpriteCollision(
        { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
        "e",
        { x: 0.9, y: 0.5 },
        { x: 0.75, y: 0.5 },
      ),
    ).toMatchObject({ x: 0.25, width: 0.65 });
  });
});
