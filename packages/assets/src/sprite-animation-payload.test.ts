import { describe, expect, it } from "vitest";
import { pngPixelSize } from "./bytes";
import {
  applyTexturePixelSizesToSpriteAnimation,
  createDefaultSpriteAnimationPayload,
  hydrateSpriteAnimationPixelSizes,
  parseSpriteAnimationPayload,
  spriteAnimationDurationMs,
  spriteAnimationFrameAt,
  spriteAnimationTextureGuids,
} from "./sprite-animation-payload";

/** PNG signature + IHDR width/height only — CRC omitted on purpose. */
function pngIhdr(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

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

  it("fills missing frame pixel sizes from a texture guid lookup", () => {
    const payload = parseSpriteAnimationPayload({
      frames: [
        { textureGuid: "wide", durationMs: 40 },
        { textureGuid: "wide", width: 8, height: 8 },
        { textureGuid: "missing" },
      ],
    });
    const sized = applyTexturePixelSizesToSpriteAnimation(payload, (guid) =>
      guid === "wide" ? { width: 200, height: 100 } : null,
    );
    expect(sized.frames[0]).toMatchObject({
      textureGuid: "wide",
      width: 200,
      height: 100,
    });
    expect(sized.frames[1]).toMatchObject({ width: 8, height: 8 });
    expect(sized.frames[2]?.width).toBeUndefined();
    expect(sized.frames[2]?.height).toBeUndefined();
  });

  it("hydrates missing sizes from PNG IHDR bytes keyed by texture guid", () => {
    const payload = createDefaultSpriteAnimationPayload();
    payload.frames[0]!.textureGuid = "hero-tex";
    const hydrated = hydrateSpriteAnimationPixelSizes(
      new Map([["walk", payload]]),
      new Map([["hero-tex", pngIhdr(200, 100)]]),
    );
    expect(hydrated.get("walk")?.frames[0]).toMatchObject({
      textureGuid: "hero-tex",
      width: 200,
      height: 100,
    });
  });
});

describe("pngPixelSize", () => {
  it("reads width and height from a PNG IHDR chunk", () => {
    expect(pngPixelSize(pngIhdr(200, 100))).toEqual({ width: 200, height: 100 });
  });

  it("returns null for non-PNG bytes", () => {
    expect(pngPixelSize(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});
