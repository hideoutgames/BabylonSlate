import { afterEach, describe, expect, it } from "vitest";
import {
  NullEngine,
  Scene,
  StandardMaterial,
  Texture,
} from "@babylonjs/core";
import {
  ENGINE_DEFAULT_CHECKER_TILES,
  createEngineDefaultMaterial,
  engineDefaultCheckerRgba,
  installEngineDefaultMaterial,
  isEngineDefaultMaterial,
} from "./default-material";
import { createPrimitiveMesh } from "./scene-loader";

const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
  [];

afterEach(() => {
  while (handles.length > 0) {
import { applySceneEnvironment } from "./scene-illumination";
import { createDefaultScene } from "@babylonslate/core";
    const handle = handles.pop();
    handle?.scene.dispose();
    handle?.engine.dispose();
  }
});

function rawScene(): Scene {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  handles.push({ engine, scene });
  return scene;
}

describe("engine default material", () => {
  it("uses a UV-tiled grey checker for albedo", () => {
    const scene = rawScene();
    const material = createEngineDefaultMaterial(scene);
    const albedo = material.albedoTexture;

    expect(albedo).toBeInstanceOf(Texture);
    const tiled = albedo as Texture;
    expect(tiled.getSize()).toEqual({ width: 2, height: 2 });
    expect(tiled.wrapU).toBe(Texture.WRAP_ADDRESSMODE);
    expect(tiled.wrapV).toBe(Texture.WRAP_ADDRESSMODE);
    expect(tiled.samplingMode).toBe(Texture.NEAREST_SAMPLINGMODE);
    expect(tiled.uScale).toBe(ENGINE_DEFAULT_CHECKER_TILES);
    expect(tiled.vScale).toBe(ENGINE_DEFAULT_CHECKER_TILES);
    expect(ENGINE_DEFAULT_CHECKER_TILES).toBe(8);
    // Light 0.8 (user default baseColor) and slightly darker 0.65, as 8-bit sRGB.
    // NullEngine does not retain RawTexture pixel buffers; this is the source
    // createEngineDefaultMaterial uploads.
    expect(Array.from(engineDefaultCheckerRgba())).toEqual([
      204, 204, 204, 255, 166, 166, 166, 255, 166, 166, 166, 255, 204, 204, 204,
      255,
    ]);
  });

  it("emits its checker in a 2D scene, which has no lights, and not in 3D", () => {
    const scene = rawScene();
    const material = installEngineDefaultMaterial(scene);
    material.freeze();
    applySceneEnvironment(scene, createDefaultScene("2d"));
    expect(material.emissiveTexture).toBe(material.albedoTexture);
    expect(material.emissiveColor).toEqual(new Color3(1, 1, 1));
    expect(material.isFrozen).toBe(true);
    expect(material.unlit).toBe(false);
    applySceneEnvironment(scene, createDefaultScene("3d"));
    expect(material.emissiveTexture).toBeNull();
    expect(material.emissiveColor).toEqual(new Color3(0, 0, 0));
  });

  it("installs as scene.defaultMaterial and reuses the same instance", () => {
    const scene = rawScene();
    const first = installEngineDefaultMaterial(scene);
    const second = installEngineDefaultMaterial(scene);

    expect(scene.defaultMaterial).toBe(first);
    expect(second).toBe(first);
    expect(isEngineDefaultMaterial(scene.defaultMaterial)).toBe(true);
  });

  it("replaces Babylon's Standard default material", () => {
    const scene = rawScene();
    const previous = scene.defaultMaterial;
    expect(previous).toBeInstanceOf(StandardMaterial);
    expect(previous.name).toBe("default material");

    const installed = installEngineDefaultMaterial(scene);
    expect(scene.defaultMaterial).toBe(installed);
    expect(installed).not.toBe(previous);
    expect(isEngineDefaultMaterial(previous)).toBe(false);
  });

  it("leaves a primitive mesh with no authored material on the engine default", () => {
    const scene = rawScene();
    installEngineDefaultMaterial(scene);
    const mesh = createPrimitiveMesh(scene, "box", "box");

    expect(mesh.material).toBeNull();
    expect(isEngineDefaultMaterial(scene.defaultMaterial)).toBe(true);
  });

  it("does not replace a pivot marker's explicit material", () => {
    const scene = rawScene();
    installEngineDefaultMaterial(scene);
    const pivot = createPrimitiveMesh(scene, "origin", "pivot");

    expect(pivot.material).not.toBeNull();
    expect(isEngineDefaultMaterial(pivot.material)).toBe(false);
    expect((pivot.material as StandardMaterial).disableLighting).toBe(true);
  });

  it("does not replace an already assigned sprite-style material", () => {
    const scene = rawScene();
    installEngineDefaultMaterial(scene);
    const mesh = createPrimitiveMesh(scene, "sprite", "box");
    const spriteMat = new StandardMaterial("albedo:tex", scene);
    spriteMat.disableLighting = true;
    mesh.material = spriteMat;
    installEngineDefaultMaterial(scene);

    expect(mesh.material).toBe(spriteMat);
    expect(isEngineDefaultMaterial(mesh.material)).toBe(false);
  });
});
