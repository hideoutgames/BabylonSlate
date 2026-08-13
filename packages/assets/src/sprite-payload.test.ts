import { describe, expect, it } from "vitest";
import {
  createDefaultSpritePayload,
  spriteClipFrameAt,
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
