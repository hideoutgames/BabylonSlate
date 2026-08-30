import { describe, expect, it } from "vitest";
import { NullEngine, PBRMaterial, Scene, Texture } from "@babylonjs/core";
import {
  applyPixelArtSampling,
  applyPixelArtSamplingToScene,
  pixelPerfectOrthoHalfHeight,
  quantizeZoom,
  snapPointToPixelGrid,
  snapToPixelGrid,
} from "./pixel-perfect";
import { createEditorCamera } from "./editor-camera";
import { ResourceCache } from "./resource-cache";

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
  it("derives ortho bounds from the canvas without snapping the editor target", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = createEditorCamera(scene, { mode: "2d" });
    camera.setCanvasHeight(600);
    camera.setPixelPerfect({ pixelsPerUnit: 100, integerZoomSteps: true });
    camera.camera.target.set(0.014, 0.026, 0);
    camera.pan(0, 0);

    expect(camera.orthoHalfHeight()).toBe(3);
    expect(camera.camera.target.x).toBeCloseTo(0.014, 6);
    expect(camera.camera.target.y).toBeCloseTo(0.026, 6);

    camera.zoom(2);
    expect(camera.pixelZoom()).toBe(2);
    expect(camera.orthoHalfHeight()).toBe(1.5);

    camera.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("zooms smoothly in sub-integer steps even when integer zoom steps is on", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = createEditorCamera(scene, { mode: "2d" });
    camera.setCanvasHeight(600);
    camera.setPixelPerfect({ pixelsPerUnit: 100, integerZoomSteps: true });

    expect(camera.pixelZoom()).toBe(1);
    expect(camera.orthoHalfHeight()).toBe(3);

    camera.zoom(1.1);
    expect(camera.pixelZoom()).toBeCloseTo(1.1, 5);
    expect(camera.orthoHalfHeight()).toBeCloseTo(3 / 1.1, 5);

    camera.zoom(1.1);
    expect(camera.pixelZoom()).toBeCloseTo(1.21, 5);
    expect(camera.orthoHalfHeight()).toBeCloseTo(3 / 1.21, 5);

    camera.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("zooms out smoothly in sub-integer steps even when integer zoom steps is on", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = createEditorCamera(scene, { mode: "2d" });
    camera.setCanvasHeight(600);
    camera.setPixelPerfect({ pixelsPerUnit: 100, integerZoomSteps: true });

    camera.zoom(1 / 1.1);
    expect(camera.pixelZoom()).toBeCloseTo(1 / 1.1, 5);
    expect(camera.orthoHalfHeight()).toBeCloseTo(3 * 1.1, 5);

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

  it("skips engine-owned ResourceCache textures registered on the scene", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const owned = cache.getTexture(
      "tex",
      engine,
      new Uint8Array([1, 2, 3, 4]),
      { samplingMode: Texture.TRILINEAR_SAMPLINGMODE },
    );
    const local = new Texture(
      null,
      scene,
      true,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
    );
    scene.textures.push(owned);
    applyPixelArtSamplingToScene(scene);
    expect(owned.samplingMode).toBe(Texture.TRILINEAR_SAMPLINGMODE);
    expect(local.wrapU).toBe(Texture.CLAMP_ADDRESSMODE);
    local.dispose();
    cache.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("does not clamp a scene-owned PBR construction albedo", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const albedo = new Texture(
      null,
      scene,
      true,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
    );
    albedo.wrapU = Texture.WRAP_ADDRESSMODE;
    albedo.wrapV = Texture.WRAP_ADDRESSMODE;
    const material = new PBRMaterial("glb", scene);
    material.albedoTexture = albedo;
    applyPixelArtSamplingToScene(scene);
    expect(albedo.wrapU).toBe(Texture.WRAP_ADDRESSMODE);
    expect(albedo.samplingMode).toBe(Texture.TRILINEAR_SAMPLINGMODE);
    material.dispose();
    albedo.dispose();
    scene.dispose();
    engine.dispose();
  });
});
