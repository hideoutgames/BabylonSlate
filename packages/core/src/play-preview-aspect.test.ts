import { describe, expect, it } from "vitest";
import {
  clampRenderResolution,
  fitContainedRect,
  playFramebufferSize,
} from "./play-preview-aspect";

describe("fitContainedRect", () => {
  it("fills a matching 16:9 container", () => {
    expect(fitContainedRect(1920, 1080, 16, 9)).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it("letterboxes 16:9 inside a 4:3 window", () => {
    expect(fitContainedRect(1600, 1200, 16, 9)).toEqual({
      width: 1600,
      height: 900,
    });
  });
});

describe("playFramebufferSize", () => {
  it("returns null when custom resolution is off", () => {
    expect(
      playFramebufferSize({
        customResolution: false,
        width: 1920,
        height: 1080,
        blackBars: false,
      }),
    ).toBeNull();
  });

  it("does not lock WxH when custom resolution is on and black bars are off", () => {
    expect(
      playFramebufferSize({
        customResolution: true,
        width: 1920,
        height: 1080,
        blackBars: false,
      }),
    ).toBeNull();
  });

  it("returns locked WxH when black bars are on, preferring a live override", () => {
    expect(
      playFramebufferSize({
        customResolution: true,
        width: 1280,
        height: 720,
        blackBars: true,
      }),
    ).toEqual({ width: 1280, height: 720 });
    expect(
      playFramebufferSize(
        {
          customResolution: true,
          width: 1920,
          height: 1080,
          blackBars: false,
        },
        { width: 800, height: 600 },
      ),
    ).toEqual({ width: 800, height: 600 });
  });
});

describe("clampRenderResolution", () => {
  it("clamps to 1..8192", () => {
    expect(clampRenderResolution(0)).toBe(1);
    expect(clampRenderResolution(1920.4)).toBe(1920);
    expect(clampRenderResolution(20_000)).toBe(8192);
  });
});
