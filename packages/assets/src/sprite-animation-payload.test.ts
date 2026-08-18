import { describe, expect, it } from "vitest";
import {
  createDefaultSpriteAnimationPayload,
  parseSpriteAnimationPayload,
  spriteAnimationDurationMs,
  spriteAnimationFrameAt,
  spriteAnimationTextureGuids,
} from "./sprite-animation-payload";

describe("SpriteAnimation payload", () => {
  it("defaults to one empty frame with a centered pivot and full-image collision", () => {
    const payload = createDefaultSpriteAnimationPayload();
    expect(payload.frames).toHaveLength(1);
    expect(payload.frames[0]).toEqual({
      textureGuid: "",
      durationMs: 100,
      pivot: { x: 0.5, y: 0.5 },
      collision: { x: 0, y: 0, width: 1, height: 1 },
    });
  });

  it("fills missing frame fields when parsing a sparse document", () => {
    const parsed = parseSpriteAnimationPayload({
      frames: [{ textureGuid: "tex-1" }, { durationMs: 40 }],
    });
    expect(parsed.frames[0]).toMatchObject({
      textureGuid: "tex-1",
      durationMs: 100,
      pivot: { x: 0.5, y: 0.5 },
      collision: { x: 0, y: 0, width: 1, height: 1 },
    });
    expect(parsed.frames[1]).toMatchObject({
      textureGuid: "",
      durationMs: 40,
    });
  });

  it("picks the frame at normalised time and sums clip duration", () => {
    const payload = parseSpriteAnimationPayload({
      frames: [
        { textureGuid: "a", durationMs: 100 },
        { textureGuid: "b", durationMs: 100 },
      ],
    });
    expect(spriteAnimationDurationMs(payload)).toBe(200);
    expect(spriteAnimationFrameAt(payload, 0)?.textureGuid).toBe("a");
    expect(spriteAnimationFrameAt(payload, 0.75)?.textureGuid).toBe("b");
    expect(spriteAnimationFrameAt(payload, 1)?.textureGuid).toBe("b");
  });

  it("collects unique texture guids from frames", () => {
    const payload = parseSpriteAnimationPayload({
      frames: [
        { textureGuid: "tex-a" },
        { textureGuid: "tex-a" },
        { textureGuid: "tex-b" },
        { textureGuid: "" },
      ],
    });
    expect(spriteAnimationTextureGuids(payload)).toEqual(["tex-a", "tex-b"]);
  });

  it("defaults a missing or empty document instead of throwing", () => {
    expect(parseSpriteAnimationPayload(null).frames).toHaveLength(1);
    expect(parseSpriteAnimationPayload({}).frames).toHaveLength(1);
    expect(parseSpriteAnimationPayload({ frames: [] }).frames).toHaveLength(1);
    expect(parseSpriteAnimationPayload("walk").frames[0]?.textureGuid).toBe("");
  });

  it("clamps non-finite normalised time onto the first frame", () => {
    const payload = parseSpriteAnimationPayload({
      frames: [
        { textureGuid: "a", durationMs: 100 },
        { textureGuid: "b", durationMs: 100 },
      ],
    });
    expect(spriteAnimationFrameAt(payload, Number.NaN)?.textureGuid).toBe("a");
    expect(spriteAnimationFrameAt(payload, -2)?.textureGuid).toBe("a");
    expect(spriteAnimationFrameAt({ frames: [] }, 0.5)).toBeNull();
  });
});
