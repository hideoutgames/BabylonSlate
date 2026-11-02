import { describe, expect, it } from "vitest";
import {
  clampRenderResolution,
  fitContainedRect,
  fitWholeMultipleRect,
  pixelatedExtend,
  pixelatedLensExtent,
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
  const bars = { customResolution: true, width: 320, height: 180, blackBars: true, upscaling: "pixelated" as const };
  const extend = { ...bars, blackBars: false };

  it("fits the largest whole multiple of the frame in device pixels", () => {
    // 1366 x 768 CSS pixels at 1x: x4 of 320 x 180.
    expect(fitWholeMultipleRect(1366, 768, 320, 180)).toEqual({ width: 1280, height: 720 });
    // An iPad's 1180 x 820 CSS pixels at 2x are 2360 x 1640 device pixels: x7 is 2240 x 1260, 1120 x 630 CSS pixels.
    expect(fitWholeMultipleRect(1180, 820, 320, 180, 2)).toEqual({ width: 1120, height: 630 });
    // Smaller than the frame: fitted instead.
    expect(fitWholeMultipleRect(200, 200, 320, 180)).toEqual(fitContainedRect(200, 200, 320, 180));
    expect(fitWholeMultipleRect(0, 768, 320, 180)).toEqual({ width: 0, height: 0 });
  });

  it("applies with Custom Resolution and Pixelated, with Black Bars or extended", () => {
    expect([
      pixelatedUpscaling(bars),
      pixelatedUpscaling(extend),
      pixelatedUpscaling({ ...bars, customResolution: false }),
      pixelatedUpscaling({ ...bars, upscaling: "smooth" }),
    ]).toEqual([true, true, false, false]);
    expect([pixelatedExtend(bars), pixelatedExtend(extend)]).toEqual([false, true]);
  });

  it("locks the design size with Black Bars at a whole multiple", () => {
    const container = { width: 1366, height: 768 };
    const framebuffer = playFramebufferSize(bars, null, container)!;
    expect(framebuffer).toEqual({ width: 320, height: 180 });
    expect(presentedFramebufferStyle(bars, framebuffer, container)).toEqual({ width: 1280, height: 720, imageRendering: "pixelated" });
    expect(presentedFramebufferStyle({ ...bars, upscaling: "smooth" }, framebuffer, container))
      .toEqual({ width: 1365, height: 768, imageRendering: "" });
    expect(pixelatedLensExtent(bars, framebuffer)).toBe(1);
  });

  it("extends the framebuffer past the design size to fill the window without Black Bars", () => {
    // x4 of 320 x 180 fits 1366 x 768; the framebuffer covers the window at x4: 342 x 192, shown at 1368 x 768.
    const container = { width: 1366, height: 768 };
    expect(playFramebufferSize(extend, null, null)).toBeNull();
    const framebuffer = playFramebufferSize(extend, null, container)!;
    expect(framebuffer).toEqual({ width: 342, height: 192 });
    expect(presentedFramebufferStyle(extend, framebuffer, container)).toEqual({ width: 1368, height: 768, imageRendering: "pixelated" });
    // Cameras show 192 / 180 of the design height, so the design size keeps its scale.
    expect(pixelatedLensExtent(extend, framebuffer)).toBeCloseTo(192 / 180);
    // A 2x display counts device pixels: 1180 x 820 is 2360 x 1640, where x7 fits (the width limits it).
    expect(playFramebufferSize(extend, null, { width: 1180, height: 820, devicePixelRatio: 2 })).toEqual({ width: 338, height: 235 });
    // A window smaller than the design size shows it fitted, as Black Bars would.
    expect(playFramebufferSize(extend, null, { width: 200, height: 100 })).toEqual({ width: 320, height: 180 });
    // A live Set Render Resolution still locks.
    expect(playFramebufferSize(extend, { width: 400, height: 300 }, container)).toEqual({ width: 400, height: 300 });
  });
});
