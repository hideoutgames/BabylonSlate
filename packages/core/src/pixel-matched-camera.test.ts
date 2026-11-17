import { describe, expect, it } from "vitest";
import { pixelMatchedDesignFrame, pixelMatchedScale, pixelMatchedView, wholePixelScale } from "./pixel-matched-camera";
import { playFramebufferSize, type PlayOutputSettings } from "./play-preview-aspect";
import { sceneLayerOutputDesignSize } from "./scene-layer-canvas";

describe("wholePixelScale", () => {
  it("rounds to whole multiples from 1 up and to whole fractions below 1", () => {
    expect([1, 1.2, 1.49, 1.5, 2.6, 3].map(wholePixelScale)).toEqual([1, 1, 1, 2, 3, 3]);
    // 1/0.8 = 1.25 → 1; 1/0.6 ≈ 1.67 → 1/2; 1/0.3 ≈ 3.33 → 1/3.
    expect([0.8, 0.6, 0.3].map(wholePixelScale)).toEqual([1, 1 / 2, 1 / 3]);
    expect([0, -1, Number.NaN, Number.POSITIVE_INFINITY].map(wholePixelScale)).toEqual([1, 1, 1, 1]);
  });
});

describe("pixelMatchedScale", () => {
  it("picks the whole ratio nearest what the authored height would frame over the design area", () => {
    // 360 design rows at 100 Pixels Per Unit are 3.6 units: Orthographic Size 1.8 frames them at one texel per pixel.
    expect(pixelMatchedScale(3.6, 360, 100)).toBe(1);
    expect(pixelMatchedScale(1.8, 360, 100)).toBe(2);
    expect(pixelMatchedScale(2.6, 360, 100)).toBe(1);
    // The default Orthographic Size 5 (10 units) is nearest three texels per design pixel.
    expect(pixelMatchedScale(10, 360, 100)).toBe(1 / 3);
    // 180 rows at 16 Pixels Per Unit are 11.25 units: a 16 x 9 Layer Camera frames them at one texel per pixel.
    expect(pixelMatchedScale(9, 180, 16)).toBe(1);
  });
});

/** Play's output in design pixels for a window, as the compositor sizes Scene Layers (`create-engine.ts`). */
function outputDesign(render: PlayOutputSettings, window: { width: number; height: number }) {
  const design = { width: render.width, height: render.height };
  const framebuffer = playFramebufferSize(render, null, window);
  const extended = render.upscaling === "pixelated" && !render.blackBars;
  return sceneLayerOutputDesignSize(design, framebuffer ?? window, extended);
}

const WINDOWS = { "16:9": { width: 1920, height: 1080 }, "21:9": { width: 2560, height: 1080 }, "4:3": { width: 1024, height: 768 } };

describe("pixelMatchedView", () => {
  it("frames exactly the design resolution with Black Bars, Pixelated or Smooth, in every window", () => {
    for (const [width, height] of [[640, 360], [320, 180]]) {
      for (const upscaling of ["pixelated", "smooth"] as const) {
        for (const window of Object.values(WINDOWS)) {
          const render = { customResolution: true, width, height, blackBars: true, upscaling };
          const view = pixelMatchedView(height / 100, { design: { width, height }, output: outputDesign(render, window), pixelsPerUnit: 100 });
          expect(view).toEqual({ width: width / 100, height: height / 100, scale: 1 });
        }
      }
    }
  });

  it("keeps the pixel scale and shows more world on the extended sides without Black Bars", () => {
    const rows: Array<[number, number, "pixelated" | "smooth", keyof typeof WINDOWS, number, number]> = [
      // 640 x 360 in 2560 x 1080 (21:9): Pixelated enlarges by 3 and extends to ceil(2560 / 3) = 854 design pixels.
      [640, 360, "pixelated", "21:9", 8.54, 3.6],
      // Smooth widens the design size to the window's aspect: 360 x 2560 / 1080.
      [640, 360, "smooth", "21:9", 360 * 2560 / 1080 / 100, 3.6],
      // 1024 x 768 (4:3) fits 640 x 360 once: Pixelated extends both ways to the window's pixels.
      [640, 360, "pixelated", "4:3", 10.24, 7.68],
      // Smooth keeps the design width and heightens it to 4:3.
      [640, 360, "smooth", "4:3", 6.4, 4.8],
      [640, 360, "pixelated", "16:9", 6.4, 3.6],
      [640, 360, "smooth", "16:9", 6.4, 3.6],
      // 320 x 180: × 6 in 16:9, × 6 with 2560 / 6 = 426.67 → 427 columns in 21:9, × 3 in 4:3 (342 x 256).
      [320, 180, "pixelated", "16:9", 3.2, 1.8],
      [320, 180, "pixelated", "21:9", 4.27, 1.8],
      [320, 180, "smooth", "21:9", 180 * 2560 / 1080 / 100, 1.8],
      [320, 180, "pixelated", "4:3", 3.42, 2.56],
      [320, 180, "smooth", "4:3", 3.2, 2.4],
    ];
    for (const [width, height, upscaling, window, viewWidth, viewHeight] of rows) {
      const render = { customResolution: true, width, height, blackBars: false, upscaling };
      const view = pixelMatchedView(height / 100, { design: { width, height }, output: outputDesign(render, WINDOWS[window]), pixelsPerUnit: 100 });
      expect([view.width, view.height, view.scale], `${width}x${height} ${upscaling} ${window}`).toEqual([
        expect.closeTo(viewWidth, 9), expect.closeTo(viewHeight, 9), 1,
      ]);
    }
  });

  it("zooms in whole steps, the extension scaling with it", () => {
    const context = { design: { width: 640, height: 360 }, output: { width: 854, height: 360 }, pixelsPerUnit: 100 };
    expect(pixelMatchedView(1.8, context)).toEqual({ width: 4.27, height: 1.8, scale: 2 });
    expect(pixelMatchedView(10, context)).toEqual({ width: expect.closeTo(25.62, 9), height: expect.closeTo(10.8, 9), scale: 1 / 3 });
    // The editor's outline is the design area alone.
    expect(pixelMatchedDesignFrame(1.8, context)).toEqual({ width: 3.2, height: 1.8, scale: 2 });
  });
});
