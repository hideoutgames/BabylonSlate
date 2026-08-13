import { describe, expect, it } from "vitest";
import { NullEngine, Scene, Texture } from "@babylonjs/core";
import {
  applyPixelArtSampling,
  applyPixelArtSamplingToScene,
  pixelPerfectOrthoHalfHeight,
  quantizeZoom,
  snapPointToPixelGrid,
  snapToPixelGrid,
} from "./pixel-perfect";
import { createEditorCamera } from "./editor-camera";

describe("pixelPerfectOrthoHalfHeight", () => {
  it("frames the canvas so one texture pixel covers one device pixel", () => {
    // 600px tall canvas at 100 ppU → 6 world units tall → half-height 3.
    expect(pixelPerfectOrthoHalfHeight(600, 100)).toBe(3);
    expect(pixelPerfectOrthoHalfHeight(600, 100, 2)).toBe(1.5);
  });

  it("rejects non-positive inputs", () => {
    expect(pixelPerfectOrthoHalfHeight(0, 100)).toBe(1);
    expect(pixelPerfectOrthoHalfHeight(600, 0)).toBe(1);
  });
});

describe("quantizeZoom", () => {
  it("snaps to integer scales both above and below 1:1", () => {
    expect(quantizeZoom(1.4)).toBe(1);
    expect(quantizeZoom(1.6)).toBe(2);
    expect(quantizeZoom(0.6)).toBe(0.5);
    expect(quantizeZoom(0.4)).toBeCloseTo(1 / 3, 6);
    expect(quantizeZoom(0)).toBe(1);
  });
});

describe("snapToPixelGrid", () => {
  it("rounds world units to the nearest texture pixel", () => {
    expect(snapToPixelGrid(0.014, 100)).toBeCloseTo(0.01, 6);
    expect(snapToPixelGrid(0.016, 100)).toBeCloseTo(0.02, 6);
    expect(snapPointToPixelGrid({ x: 0.014, y: 0.026, z: 3 }, 100)).toEqual({
      x: 0.01,
      y: 0.03,
      z: 3,
    });
  });
});

describe("editor camera pixel-perfect framing", () => {
  it("derives ortho bounds from the canvas and snaps the target", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = createEditorCamera(scene, { mode: "2d" });
    camera.setCanvasHeight(600);
    camera.setPixelPerfect({ pixelsPerUnit: 100, integerZoomSteps: true });
    camera.camera.target.set(0.014, 0.026, 0);
    camera.pan(0, 0);

    expect(camera.orthoHalfHeight()).toBe(3);
    expect(camera.camera.target.x).toBeCloseTo(0.01, 6);
    expect(camera.camera.target.y).toBeCloseTo(0.03, 6);

    camera.zoom(2);
    expect(camera.pixelZoom()).toBe(2);
    expect(camera.orthoHalfHeight()).toBe(1.5);

    camera.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("accumulates sub-step zoom-in until the next integer scale", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = createEditorCamera(scene, { mode: "2d" });
    camera.setCanvasHeight(600);
    camera.setPixelPerfect({ pixelsPerUnit: 100, integerZoomSteps: true });

    expect(camera.pixelZoom()).toBe(1);
    expect(camera.orthoHalfHeight()).toBe(3);

    // 1.1^4 ≈ 1.46 still rounds to 1×; 1.1^5 ≈ 1.61 rounds to 2×.
    for (let i = 0; i < 4; i++) camera.zoom(1.1);
    expect(camera.pixelZoom()).toBe(1);
    expect(camera.orthoHalfHeight()).toBe(3);

    camera.zoom(1.1);
    expect(camera.pixelZoom()).toBe(2);
    expect(camera.orthoHalfHeight()).toBe(1.5);

    camera.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("accumulates sub-step zoom-out until the next 1/n scale", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = createEditorCamera(scene, { mode: "2d" });
    camera.setCanvasHeight(600);
    camera.setPixelPerfect({ pixelsPerUnit: 100, integerZoomSteps: true });

    for (let i = 0; i < 4; i++) camera.zoom(1 / 1.1);
    expect(camera.pixelZoom()).toBe(1);
    expect(camera.orthoHalfHeight()).toBe(3);

    camera.zoom(1 / 1.1);
    expect(camera.pixelZoom()).toBe(0.5);
    expect(camera.orthoHalfHeight()).toBe(6);

    camera.dispose();
    scene.dispose();
    engine.dispose();
  });
});

describe("applyPixelArtSampling", () => {
  it("sets nearest sampling, clamp wrap and no anisotropy", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const texture = new Texture(null, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
    applyPixelArtSampling(texture);
    expect(texture.wrapU).toBe(Texture.CLAMP_ADDRESSMODE);
    expect(texture.wrapV).toBe(Texture.CLAMP_ADDRESSMODE);
    expect(texture.anisotropicFilteringLevel).toBe(1);
    texture.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("applies nearest sampling to every texture on a scene", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const a = new Texture(null, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
    const b = new Texture(null, scene, true, false, Texture.BILINEAR_SAMPLINGMODE);
    applyPixelArtSamplingToScene(scene);
    expect(a.anisotropicFilteringLevel).toBe(1);
    expect(b.anisotropicFilteringLevel).toBe(1);
    expect(a.wrapU).toBe(Texture.CLAMP_ADDRESSMODE);
    expect(b.wrapV).toBe(Texture.CLAMP_ADDRESSMODE);
    a.dispose();
    b.dispose();
    scene.dispose();
    engine.dispose();
  });
});
