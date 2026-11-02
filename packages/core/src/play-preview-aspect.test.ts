import { describe, expect, it } from "vitest";
import {
  clampRenderResolution,
  fitContainedRect,
  fitWholeMultipleRect,
  pixelatedUpscaling,
  playFramebufferSize,
  presentedFramebufferStyle,
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

  it("keeps a locked framebuffer within the 8192 side limit", () => {
    expect(
      playFramebufferSize({
        customResolution: true,
        width: 20_000,
        height: 9000,
        blackBars: true,
      }),
    ).toEqual({ width: 8192, height: 8192 });
    expect(playFramebufferSize(null, { width: 16_384, height: 720 })).toEqual({ width: 8192, height: 720 });
  });
});

describe("clampRenderResolution", () => {
  it("clamps to 1..8192", () => {
    expect(clampRenderResolution(0)).toBe(1);
    expect(clampRenderResolution(1920.4)).toBe(1920);
    expect(clampRenderResolution(20_000)).toBe(8192);
  });
});

describe("pixelated upscaling", () => {
  it("fits the largest whole multiple of the frame in device pixels", () => {
    // 1366 x 768 CSS pixels at 1x: x4 of 320 x 180.
    expect(fitWholeMultipleRect(1366, 768, 320, 180)).toEqual({ width: 1280, height: 720 });
    // An iPad's 1180 x 820 CSS pixels at 2x are 2360 x 1640 device pixels: x7 is 2240 x 1260, 1120 x 630 CSS pixels.
    expect(fitWholeMultipleRect(1180, 820, 320, 180, 2)).toEqual({ width: 1120, height: 630 });
    // Smaller than the frame: fitted instead.
    expect(fitWholeMultipleRect(200, 200, 320, 180)).toEqual(fitContainedRect(200, 200, 320, 180));
    expect(fitWholeMultipleRect(0, 768, 320, 180)).toEqual({ width: 0, height: 0 });
  });

  it("applies only with Custom Resolution, Black Bars and Pixelated", () => {
    const render = { customResolution: true, blackBars: true, upscaling: "pixelated" as const };
    expect([
      pixelatedUpscaling(render),
      pixelatedUpscaling({ ...render, blackBars: false }),
      pixelatedUpscaling({ ...render, customResolution: false }),
      pixelatedUpscaling({ ...render, upscaling: "smooth" }),
    ]).toEqual([true, false, false, false]);
    expect(presentedFramebufferStyle(render, { width: 320, height: 180 }, { width: 1366, height: 768 }))
      .toEqual({ width: 1280, height: 720, imageRendering: "pixelated" });
    expect(presentedFramebufferStyle({ ...render, upscaling: "smooth" }, { width: 320, height: 180 }, { width: 1366, height: 768 }))
      .toEqual({ width: 1365, height: 768, imageRendering: "" });
  });
});
