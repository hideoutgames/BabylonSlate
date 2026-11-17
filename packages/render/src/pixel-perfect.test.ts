import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import {
  pixelPerfectOrthoBounds,
  pixelPerfectOrthoHalfHeight,
  pixelZoomDetent,
  snapToPixelGrid,
} from "./pixel-perfect";
import { createEditorCamera } from "./editor-camera";

describe("pixelPerfectOrthoHalfHeight", () => {
  it("frames the canvas so one texture pixel covers the given whole number of canvas pixels", () => {
    // 600px tall canvas at 100 ppU → 6 world units tall → half-height 3.
    expect(pixelPerfectOrthoHalfHeight(600, 100)).toBe(3);
    expect(pixelPerfectOrthoHalfHeight(600, 100, 2)).toBe(1.5);
    expect(pixelPerfectOrthoHalfHeight(600, 100, 1 / 2)).toBe(6);
  });

  it("rejects non-positive inputs", () => {
    expect(pixelPerfectOrthoHalfHeight(0, 100)).toBe(1);
    expect(pixelPerfectOrthoHalfHeight(600, 0)).toBe(1);
  });
});

describe("pixelPerfectOrthoBounds", () => {
  it("puts the frustum's edges on whole canvas pixels of the world grid wherever the centre is", () => {
    // 3 x 2 canvas pixels at 100 ppU and 1 pixel per texel: 0.03 x 0.02 units, edges on multiples of 0.01.
    const bounds = pixelPerfectOrthoBounds({ x: 0.0012, y: 0.0047 }, { width: 3, height: 2 }, 100, 1);
    expect(bounds.left + 0.0012).toBeCloseTo(-0.01, 9);
    expect(bounds.right + 0.0012).toBeCloseTo(0.02, 9);
    expect(bounds.bottom + 0.0047).toBeCloseTo(-0.01, 9);
    expect(bounds.top + 0.0047).toBeCloseTo(0.01, 9);
    // At 2 canvas pixels per texel the grid is half a texel.
    const doubled = pixelPerfectOrthoBounds({ x: 0.0012, y: 0 }, { width: 4, height: 4 }, 100, 2);
    expect(doubled.left + 0.0012).toBeCloseTo(-0.01, 9);
    expect(doubled.right - doubled.left).toBeCloseTo(0.02, 9);
  });
});

describe("snapToPixelGrid", () => {
  it("rounds world units to the nearest texture pixel", () => {
    expect(snapToPixelGrid(0.014, 100)).toBeCloseTo(0.01, 6);
    expect(snapToPixelGrid(0.016, 100)).toBeCloseTo(0.02, 6);
  });
});

function pixelCamera(pixelRatio?: number) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = createEditorCamera(scene, { mode: "2d" });
  camera.setCanvasHeight(600);
  camera.updateOrthoBounds(800 / 600);
  camera.setPixelPerfect({ pixelsPerUnit: 100, pixelRatio });
  return { camera, dispose: () => { camera.dispose(); scene.dispose(); engine.dispose(); } };
}

describe("editor camera pixel-perfect framing", () => {
  it("derives ortho bounds from the canvas without moving the editor target, its edges on the pixel grid", () => {
    const { camera, dispose } = pixelCamera();
    camera.camera.target.set(0.014, 0.026, 0);
    camera.pan(0, 0);
    camera.camera.getViewMatrix(true);

    expect(camera.orthoHalfHeight()).toBe(3);
    expect(camera.camera.target.x).toBeCloseTo(0.014, 6);
    expect(camera.camera.target.y).toBeCloseTo(0.026, 6);
    // 800 x 600 pixels at 0.01 units each, the left and bottom edges on whole pixels.
    expect(camera.camera.orthoLeft! + 0.014).toBeCloseTo(-3.99, 9);
    expect(camera.camera.orthoRight! - camera.camera.orthoLeft!).toBeCloseTo(8, 9);
    expect(camera.camera.orthoBottom! + 0.026).toBeCloseTo(-2.97, 9);
    expect(camera.camera.orthoTop! - camera.camera.orthoBottom!).toBeCloseTo(6, 9);

    camera.zoom(2);
    expect(camera.pixelZoom()).toBe(2);
    expect(camera.pixelsPerTexel()).toBe(2);
    expect(camera.orthoHalfHeight()).toBe(1.5);
    dispose();
  });

  it("zooms smoothly by wheel steps, settling on whole levels it passes near and leaving them on the next step", () => {
    const { camera, dispose } = pixelCamera();
    const shown: number[] = [];
    for (let tick = 0; tick < 8; tick += 1) {
      camera.zoom(1.1);
      shown.push(Number(camera.pixelsPerTexel().toFixed(4)));
    }
    // 1.1^7 = 1.9487 is within 6% of 2 and shows as 2; every other step shows its own scale.
    expect(shown).toEqual([1.1, 1.21, 1.331, 1.4641, 1.6105, 1.7716, 2, 2.1436]);
    expect(camera.pixelZoom()).toBeCloseTo(1.1 ** 8, 5);
    // Back down: 1.1^7 settles on 2 again, then each step leaves.
    camera.zoom(1 / 1.1);
    expect(camera.pixelsPerTexel()).toBe(2);
    expect(camera.orthoHalfHeight()).toBe(1.5);
    camera.zoom(1 / 1.1);
    expect(camera.pixelsPerTexel()).toBeCloseTo(1.1 ** 6, 9);
    dispose();
  });

  it("settles on whole fractions zoomed out", () => {
    const { camera, dispose } = pixelCamera();
    camera.zoom(0.51);
    expect(camera.pixelsPerTexel()).toBe(1 / 2);
    expect(camera.orthoHalfHeight()).toBe(6);
    camera.zoom(0.9);
    expect(camera.pixelsPerTexel()).toBeCloseTo(0.459, 9);
    dispose();
  });

  it("shows one texel per CSS pixel at zoom 1: whole on a 2x screen, the continuous scale on a 1.25x one", () => {
    const retina = pixelCamera(2);
    expect(retina.camera.pixelsPerTexel()).toBe(2);
    expect(retina.camera.orthoHalfHeight()).toBe(1.5);
    retina.dispose();
    const scaled = pixelCamera(1.25);
    expect(scaled.camera.pixelsPerTexel()).toBe(1.25);
    scaled.dispose();
  });
});

describe("pixelZoomDetent", () => {
  it("settles within 6% of a whole level and passes other scales through", () => {
    expect([1.05, 0.95, 1.07, 2.1, 2.2, 1 / 3 * 1.05, 0.4].map((scale) => Number(pixelZoomDetent(scale).toFixed(4))))
      .toEqual([1, 1, 1.07, 2, 2.2, 0.3333, 0.4]);
    expect(pixelZoomDetent(0)).toBe(1);
  });
});
