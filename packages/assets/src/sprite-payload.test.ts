import { describe, expect, it } from "vitest";
import {
  createDefaultSpritePayload,
  parseSpriteCollision,
  spriteClipFrameAt,
  spriteCollisionToBox2d,
  resizeSpriteCollision,
} from "./sprite-payload";

describe("spriteClipFrameAt", () => {
  it("picks frames by normalised clip time", () => {
    const payload = createDefaultSpritePayload();
    payload.frames = [
      {
        name: "a",
        u: 0,
        v: 0,
        uSize: 0.5,
        vSize: 1,
        durationMs: 100,
        pivot: { x: 0.5, y: 0.5 },
      },
      {
        name: "b",
        u: 0.5,
        v: 0,
        uSize: 0.5,
        vSize: 1,
        durationMs: 100,
        pivot: { x: 0.5, y: 0.5 },
      },
    ];
    payload.clips = [{ name: "Idle", frames: ["a", "b"] }];
    expect(spriteClipFrameAt(payload, "Idle", 0)?.name).toBe("a");
    expect(spriteClipFrameAt(payload, "Idle", 0.75)?.name).toBe("b");
    expect(spriteClipFrameAt(payload, "Idle", 1)?.name).toBe("b");
  });
});

describe("sprite collision", () => {
  it("defaults a missing collision to the full image", () => {
    expect(createDefaultSpritePayload().frames[0]?.collision).toEqual({
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
