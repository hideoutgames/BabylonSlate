import { describe, expect, it } from "vitest";
import { pngPixelSize } from "./bytes";
import {
  applyTexturePixelSizesToSpriteAnimation,
  createDefaultSpriteAnimationPayload,
  hydrateSpriteAnimationPixelSizes,
  parseSpriteAnimationPayload,
  spriteAnimationDurationMs,
  spriteAnimationFrameAt,
  spriteAnimationFrameDurationMs,
  spriteAnimationFrameStartMs,
  spriteAnimationPlayhead,
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
    expect(payload.frameDurationMs).toBe(100);
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

  it("uses payload frameDurationMs for every frame that does not override", () => {
    const payload = parseSpriteAnimationPayload({
      frameDurationMs: 40,
      frames: [{ textureGuid: "a" }, { textureGuid: "b" }],
    });
    expect(payload.frameDurationMs).toBe(40);
    expect(spriteAnimationFrameDurationMs(payload, payload.frames[0]!)).toBe(40);
    expect(spriteAnimationDurationMs(payload)).toBe(80);
    expect(spriteAnimationFrameStartMs(payload, 1)).toBe(40);
    expect(spriteAnimationFrameAt(payload, 0.75)?.textureGuid).toBe("b");
    expect(spriteAnimationPlayhead(payload, 50, true)).toEqual({
      index: 1,
      timeMs: 50,
      finished: false,
    });
  });

  it("uses a frame durationMs only when durationMsOverride is true", () => {
    const payload = parseSpriteAnimationPayload({
      frameDurationMs: 40,
      frames: [
        { textureGuid: "a" },
        { textureGuid: "b", durationMsOverride: true, durationMs: 120 },
      ],
    });
    expect(spriteAnimationFrameDurationMs(payload, payload.frames[0]!)).toBe(40);
    expect(spriteAnimationFrameDurationMs(payload, payload.frames[1]!)).toBe(120);
    expect(spriteAnimationDurationMs(payload)).toBe(160);
    expect(spriteAnimationFrameStartMs(payload, 1)).toBe(40);
    expect(spriteAnimationPlayhead(payload, 50, true).index).toBe(1);
    expect(spriteAnimationFrameAt(payload, 0.2)?.textureGuid).toBe("a");
    expect(spriteAnimationFrameAt(payload, 0.5)?.textureGuid).toBe("b");
  });

  it("plays frames at frameDurationMs unless they set durationMsOverride", () => {
    const authored = parseSpriteAnimationPayload({
      frameDurationMs: 50,
      frames: [{ durationMs: 100 }, { durationMs: 150 }],
    });
    expect(authored.frames.map((frame) => frame.durationMsOverride)).toEqual([undefined, undefined]);
    expect(spriteAnimationDurationMs(authored)).toBe(100);
    // Without frameDurationMs the default applies; frame durations are never promoted.
    const unset = parseSpriteAnimationPayload({ frames: [{ durationMs: 40 }, { durationMs: 150, durationMsOverride: true }] });
    expect(unset.frameDurationMs).toBe(100);
    expect(spriteAnimationDurationMs(unset)).toBe(250);
  });

  it("picks the frame at normalised time and sums clip duration", () => {
    const payload = parseSpriteAnimationPayload({
      frameDurationMs: 100,
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

  it("maps elapsed time onto a looping or finishing playhead", () => {
    const payload = parseSpriteAnimationPayload({
      frameDurationMs: 100,
      frames: [
        { textureGuid: "a", durationMs: 100 },
        { textureGuid: "b", durationMs: 100 },
      ],
    });
    expect(spriteAnimationFrameStartMs(payload, 1)).toBe(100);
    expect(spriteAnimationPlayhead(payload, 0, true)).toEqual({
      index: 0,
      timeMs: 0,
      finished: false,
    });
    expect(spriteAnimationPlayhead(payload, 150, true)).toEqual({
      index: 1,
      timeMs: 150,
      finished: false,
    });
    expect(spriteAnimationPlayhead(payload, 200, true)).toEqual({
      index: 0,
      timeMs: 0,
      finished: false,
    });
    expect(spriteAnimationPlayhead(payload, 250, false)).toEqual({
      index: 1,
      timeMs: 200,
      finished: true,
    });
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

  it("hydrates missing sizes from texture source bytes keyed by guid, not only PNG", () => {
    const payload = parseSpriteAnimationPayload({
      frames: [{ textureGuid: "hero-tex" }, { textureGuid: "gif-tex" }],
    });
    // GIF89a with a 48 x 24 logical screen.
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 48, 0, 24, 0]);
    const hydrated = hydrateSpriteAnimationPixelSizes(
      new Map([["walk", payload]]),
      new Map([["hero-tex", pngIhdr(200, 100)], ["gif-tex", gif]]),
    );
    expect(hydrated.get("walk")?.frames).toMatchObject([
      { textureGuid: "hero-tex", width: 200, height: 100 },
      { textureGuid: "gif-tex", width: 48, height: 24 },
    ]);
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
