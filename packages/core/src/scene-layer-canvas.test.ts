import { describe, expect, it } from "vitest";
import {
  normalizeSceneLayerCanvasDesign,
  sceneLayerAnchorView,
  sceneLayerDesignResolution,
  sceneLayerOutputDesignSize,
  sceneLayerPlayCanvas,
  sceneLayerView,
  type SceneLayerCanvasDesign,
} from "./scene-layer-canvas";

const design = (patch: Partial<SceneLayerCanvasDesign> = {}): SceneLayerCanvasDesign => ({
  ...normalizeSceneLayerCanvasDesign(undefined),
  ...patch,
});

/** Rect equality to 10 decimals: sizes like 19.2 are not exact in binary. */
function expectRect(actual: { width: number; height: number; center: readonly [number, number] }, expected: typeof actual): void {
  expect(actual.width).toBeCloseTo(expected.width, 10);
  expect(actual.height).toBeCloseTo(expected.height, 10);
  expect(actual.center[0]).toBeCloseTo(expected.center[0], 10);
  expect(actual.center[1]).toBeCloseTo(expected.center[1], 10);
}

describe("Scene Layer canvas", () => {
  it("takes the design resolution from Custom Resolution, else 1920 x 1080", () => {
    expect(sceneLayerDesignResolution(undefined)).toEqual({ width: 1920, height: 1080 });
    expect(sceneLayerDesignResolution({ customResolution: false, width: 640, height: 360 })).toEqual({ width: 1920, height: 1080 });
    expect(sceneLayerDesignResolution({ customResolution: true, width: 640, height: 360 })).toEqual({ width: 640, height: 360 });
  });

  it("defaults to Fullscreen, Root Center and Fit To Screen, and drops unknown values", () => {
    expect(normalizeSceneLayerCanvasDesign({ sizeMode: "stretch", rootAnchor: "middle", scaling: "zoom" })).toEqual({
      sizeMode: "fullscreen", rootAnchor: "center", scaling: "fitToScreen", customSizePx: { width: 400, height: 300 },
    });
  });

  it("sizes Fullscreen from the design resolution over Pixels Per Unit, Custom from its pixels, around the Root", () => {
    const context = { resolution: { width: 1920, height: 1080 }, pixelsPerUnit: 100 };
    expectRect(sceneLayerPlayCanvas(design(), context, null), { width: 19.2, height: 10.8, center: [0, 0] });
    expectRect(sceneLayerPlayCanvas(design({ rootAnchor: "topLeft" }), context, null), { width: 19.2, height: 10.8, center: [9.6, -5.4] });
    expectRect(sceneLayerPlayCanvas(design({ sizeMode: "custom", customSizePx: { width: 400, height: 300 }, rootAnchor: "bottomRight" }), context, null), { width: 4, height: 3, center: [-2, 1.5] });
  });

  it("wraps Desired around its content, and stands in the Fullscreen canvas without any", () => {
    const context = { resolution: { width: 1920, height: 1080 }, pixelsPerUnit: 100 };
    expectRect(sceneLayerPlayCanvas(design({ sizeMode: "desired" }), context, { minX: 1, minY: -2, maxX: 5, maxY: 0 }), { width: 4, height: 2, center: [3, -1] });
    expectRect(sceneLayerPlayCanvas(design({ sizeMode: "desired" }), context, null), { width: 19.2, height: 10.8, center: [0, 0] });
  });

  it("draws a 12 px font 12 game pixels tall on a 640 x 360 pixel-art project", () => {
    const resolution = sceneLayerDesignResolution({ customResolution: true, width: 640, height: 360 });
    const canvas = sceneLayerPlayCanvas(design(), { resolution, pixelsPerUnit: 100 }, null);
    // Black Bars: the framebuffer is the design size.
    const locked = sceneLayerOutputDesignSize(resolution, { width: 640, height: 360 }, false);
    const view = sceneLayerView(canvas, design(), { width: locked.width / 100, height: locked.height / 100 });
    expectRect(view, { width: 6.4, height: 3.6, center: [0, 0] });
    expect((0.12 * 360) / view.height).toBeCloseTo(12, 10);
    // Pixelated without Black Bars extends a 1300 x 800 window's framebuffer to 650 x 400 design pixels.
    const extended = sceneLayerOutputDesignSize(resolution, { width: 650, height: 400 }, true);
    expect(extended).toEqual({ width: 650, height: 400 });
    const extendedView = sceneLayerView(canvas, design(), { width: 6.5, height: 4 });
    expect((0.12 * 400) / extendedView.height).toBeCloseTo(12, 10);
    expect((0.12 * 650) / extendedView.width).toBeCloseTo(12, 10);
  });

  it("counts design pixels, not device pixels, on a high-density window", () => {
    expect(sceneLayerOutputDesignSize({ width: 1920, height: 1080 }, { width: 3840, height: 2400 }, false))
      .toEqual({ width: 1920, height: 1200 });
    expect(sceneLayerOutputDesignSize({ width: 1920, height: 1080 }, { width: 3840, height: 2160 }, true))
      .toEqual({ width: 3840, height: 2160 });
  });

  it("fits a Custom canvas to the screen without stretching, lining its Root up with the screen's", () => {
    const screen = { width: 19.2, height: 12 };
    const canvas = { width: 32, height: 18, center: [0, 0] as const };
    expectRect(sceneLayerView(canvas, design({ sizeMode: "custom" }), screen), { width: 32, height: 20, center: [0, 0] });
    const topLeft = { width: 16, height: 9, center: [8, -4.5] as const };
    expectRect(sceneLayerView(topLeft, design({ sizeMode: "custom", rootAnchor: "topLeft" }), { width: 20, height: 10 }), { width: 18, height: 9, center: [9, -4.5] });
  });

  it("shows a True Pixel Size canvas at its pixel size with its Root at the matching screen point", () => {
    const screen = { width: 19.2, height: 10.8 };
    const centred = { width: 4, height: 3, center: [0, 0] as const };
    expectRect(sceneLayerView(centred, design({ sizeMode: "custom", scaling: "truePixelSize" }), screen), { width: 19.2, height: 10.8, center: [0, 0] });
    // Root Top Left: the canvas's top left (the origin) is the screen's top left.
    const topLeft = { width: 4, height: 3, center: [2, -1.5] as const };
    expectRect(sceneLayerView(topLeft, design({ sizeMode: "custom", rootAnchor: "topLeft", scaling: "truePixelSize" }), screen), { width: 19.2, height: 10.8, center: [9.6, -5.4] });
    // Desired: its content's bottom right corner sits in the screen's.
    const content = { width: 2, height: 1, center: [5, 5] as const };
    expectRect(sceneLayerView(content, design({ sizeMode: "desired", rootAnchor: "bottomRight", scaling: "truePixelSize" }), screen), { width: 19.2, height: 10.8, center: [-3.6, 9.9] });
  });

  it("frames the screen for Fullscreen whatever the scaling", () => {
    const canvas = { width: 6.4, height: 3.6, center: [0, 0] as const };
    for (const scaling of ["fitToScreen", "truePixelSize"] as const) {
      expectRect(sceneLayerView(canvas, design({ scaling }), { width: 6.5, height: 4 }), { width: 6.5, height: 4, center: [0, 0] });
    }
  });

  it("anchors onto the view only while the canvas fills it", () => {
    const canvas = { width: 4, height: 3, center: [0, 0] as const };
    const view = { width: 19.2, height: 10.8, center: [0, 0] as const };
    expect(sceneLayerAnchorView(canvas, view, design())).toBe(view);
    expect(sceneLayerAnchorView(canvas, view, design({ sizeMode: "custom" }))).toBe(view);
    expect(sceneLayerAnchorView(canvas, view, design({ sizeMode: "custom", scaling: "truePixelSize" }))).toBe(canvas);
    expect(sceneLayerAnchorView(canvas, view, design({ sizeMode: "desired" }))).toBe(canvas);
  });
});
