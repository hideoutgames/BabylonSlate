import { describe, expect, it } from "vitest";
import {
  createDefaultSpriteAnimationPayload,
  flipSpriteAnimationFrame,
  hydrateSpriteAnimations,
  parseSpriteAnimationPayload,
  resolveSpriteAnimation,
  spriteAnimationDependencyGuids,
  spriteAnimationDurationMs,
  spriteAnimationFrameAt,
  spriteAnimationFrameDurationMs,
  spriteAnimationFrameStartMs,
  spriteAnimationPlayhead,
  spriteAnimationSheetCellCount,
  spriteAnimationSheetCellRect,
  spriteAnimationTextureGuids,
  type SpriteAnimationFrame,
} from "./sprite-animation-payload";
import { parseSpritePayload } from "./sprite-payload";

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
    expect(payload.source).toBe("frames");
    expect(payload.sheet).toEqual({ textureGuid: "", cellWidth: 32, cellHeight: 32, margin: 0, spacing: 0 });
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

  it("parses the source, the sheet grid and each frame's Sprite or cell", () => {
    const parsed = parseSpriteAnimationPayload({
      source: "sheet",
      sheet: { textureGuid: "sheet", cellWidth: 24.7, cellHeight: 0, margin: 2, spacing: -1 },
      frames: [{ cell: 3 }, { spriteGuid: "hero", cell: 0 }],
    });
    expect(parsed.source).toBe("sheet");
    expect(parsed.sheet).toEqual({ textureGuid: "sheet", cellWidth: 24, cellHeight: 32, margin: 2, spacing: 0 });
    expect(parsed.frames[0]?.cell).toBe(3);
    expect(parsed.frames[1]).toMatchObject({ spriteGuid: "hero" });
    expect(parsed.frames[1]?.cell).toBeUndefined();
    expect(parseSpriteAnimationPayload({ source: "other" }).source).toBe("frames");
    expect(parseSpriteAnimationPayload({ source: "sheet" }).frames).toEqual([
      expect.objectContaining({ cell: 1 }),
    ]);
  });

  it("collects frame Textures and Sprites, or only the sheet's Texture", () => {
    const frames = parseSpriteAnimationPayload({
      frames: [
        { textureGuid: "tex-a" },
        { textureGuid: "tex-a" },
        { textureGuid: "tex-b" },
        { textureGuid: "" },
        { spriteGuid: "hero", textureGuid: "hero-tex" },
        { spriteGuid: "hero" },
      ],
    });
    expect(spriteAnimationTextureGuids(frames)).toEqual(["tex-a", "tex-b"]);
    expect(spriteAnimationDependencyGuids(frames)).toEqual(["tex-a", "tex-b", "hero"]);
    const sheet = parseSpriteAnimationPayload({
      source: "sheet",
      sheet: { textureGuid: "sheet" },
      frames: [{ textureGuid: "stale", spriteGuid: "stale-sprite", cell: 1 }],
    });
    expect(spriteAnimationDependencyGuids(sheet)).toEqual(["sheet"]);
  });

  it("counts and places sheet cells row by row from the top-left", () => {
    const sheet = { textureGuid: "sheet", cellWidth: 16, cellHeight: 8, margin: 1, spacing: 2 };
    const atlas = { width: 54, height: 30 };
    expect(spriteAnimationSheetCellCount(sheet, atlas)).toBe(9);
    expect(spriteAnimationSheetCellRect(sheet, atlas, 5)).toEqual({ x: 19, y: 11, width: 16, height: 8 });
    expect(spriteAnimationSheetCellRect(sheet, atlas, 10)).toBeNull();
    expect(spriteAnimationSheetCellCount(sheet, { width: 0, height: 0 })).toBe(0);
  });

  it("resolves a sheet cell to the sheet Texture, the cell size and its UVs", () => {
    const payload = parseSpriteAnimationPayload({
      source: "sheet",
      sheet: { textureGuid: "sheet", cellWidth: 16, cellHeight: 16 },
      frames: [{ cell: 2, pivot: { x: 0.5, y: 1 } }, { cell: 9 }],
    });
    const resolved = resolveSpriteAnimation(payload, {
      sprite: () => null,
      textureSize: (guid) => (guid === "sheet" ? { width: 32, height: 32 } : null),
    });
    const [first, outside] = resolved.frames;
    expect(first).toMatchObject({ textureGuid: "sheet", width: 16, height: 16, pivot: { x: 0.5, y: 1 } });
    // Cell 2 is the top-right quarter: GL v is up, inset half a texel.
    expect(first?.uv).toEqual({ u0: 0.5 + 0.5 / 32, v0: 0.5 + 0.5 / 32, u1: 1 - 0.5 / 32, v1: 1 - 0.5 / 32 });
    expect(outside?.textureGuid).toBe("sheet");
    expect(outside?.uv).toBeUndefined();
  });

  it("resolves a Sprite frame to the Sprite's Texture, size, pivot and collision", () => {
    const sprite = parseSpritePayload({
      textureGuid: "hero-tex",
      pivot: { x: 0.5, y: 1 },
      collision: { x: 0.25, y: 0.5, width: 0.5, height: 0.5 },
      width: 10,
      height: 10,
    });
    const payload = parseSpriteAnimationPayload({
      frames: [
        { spriteGuid: "hero", textureGuid: "old", pivot: { x: 0, y: 0 } },
        { spriteGuid: "gone", textureGuid: "kept" },
        { textureGuid: "wide" },
      ],
    });
    const resolved = resolveSpriteAnimation(payload, {
      sprite: (guid) => (guid === "hero" ? sprite : null),
      textureSize: (guid) => (guid === "hero-tex" ? { width: 48, height: 64 } : guid === "wide" ? { width: 200, height: 100 } : null),
    });
    expect(resolved.frames[0]).toMatchObject({
      spriteGuid: "hero",
      textureGuid: "hero-tex",
      width: 48,
      height: 64,
      pivot: { x: 0.5, y: 1 },
      collision: { x: 0.25, y: 0.5, width: 0.5, height: 0.5 },
    });
    expect(resolved.frames[1]).toMatchObject({ spriteGuid: "gone", textureGuid: "kept" });
    expect(resolved.frames[2]).toMatchObject({ textureGuid: "wide", width: 200, height: 100 });
  });

  it("hydrates sizes from catalog sizes first, then texture source bytes, not only PNG", () => {
    const payload = parseSpriteAnimationPayload({
      frames: [{ textureGuid: "hero-tex" }, { textureGuid: "gif-tex" }, { spriteGuid: "hero" }],
    });
    // GIF89a with a 48 x 24 logical screen.
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 48, 0, 24, 0]);
    const hydrated = hydrateSpriteAnimations(new Map([["walk", payload]]), {
      sprites: new Map([["hero", parseSpritePayload({ textureGuid: "hero-tex" })]]),
      textureSizes: new Map([["hero-tex", { width: 64, height: 32 }]]),
      textureBytes: new Map([["hero-tex", pngIhdr(200, 100)], ["gif-tex", gif]]),
    });
    expect(hydrated.get("walk")?.frames).toMatchObject([
      { textureGuid: "hero-tex", width: 64, height: 32 },
      { textureGuid: "gif-tex", width: 48, height: 24 },
      { spriteGuid: "hero", textureGuid: "hero-tex", width: 64, height: 32 },
    ]);
  });
});

describe("flipSpriteAnimationFrame", () => {
  const frame = {
    pivot: { x: 0.25, y: 1 },
    collision: { x: 0.5, y: 0, width: 0.5, height: 0.75 },
    uv: { u0: 0.5, v0: 0, u1: 0.75, v1: 0.5 },
  };

  it("mirrors the pivot, collision box and UVs across the frame", () => {
    expect(flipSpriteAnimationFrame(frame, true, false)).toEqual({
      pivot: { x: 0.75, y: 1 },
      collision: { x: 0, y: 0, width: 0.5, height: 0.75 },
      uv: { u0: 0.75, v0: 0, u1: 0.5, v1: 0.5 },
    });
    expect(flipSpriteAnimationFrame(frame, false, true)).toEqual({
      pivot: { x: 0.25, y: 0 },
      collision: { x: 0.5, y: 0.25, width: 0.5, height: 0.75 },
      uv: { u0: 0.5, v0: 0.5, u1: 0.75, v1: 0 },
    });
  });

  it("mirrors the whole texture for a frame without UVs, and returns an unflipped frame as it is", () => {
    const whole = { pivot: frame.pivot, collision: frame.collision };
    expect(flipSpriteAnimationFrame<Pick<SpriteAnimationFrame, "pivot" | "collision" | "uv">>(whole, true, false).uv)
      .toEqual({ u0: 1, v0: 0, u1: 0, v1: 1 });
    expect(flipSpriteAnimationFrame(frame, false, undefined)).toBe(frame);
  });
});
