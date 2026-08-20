import { afterEach, describe, expect, it } from "vitest";
import {
  Color3,
  Material,
  NullEngine,
  PBRMaterial,
  Scene,
  StandardMaterial,
  Texture,
} from "@babylonjs/core";
import {
  ENGINE_DEFAULT_CHECKER_TILES,
  ENGINE_DEFAULT_MATERIAL_NAME,
  createEngineDefaultMaterial,
  engineDefaultCheckerRgba,
  installEngineDefaultMaterial,
  isEngineDefaultMaterial,
} from "./default-material";
import { createTestEngine } from "./create-null-engine";
import { createPrimitiveMesh } from "./scene-loader";
import { setupDefaultViewport } from "./viewport";

const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
  [];

afterEach(() => {
  while (handles.length > 0) {
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
  it("is a lit PBR material with new-Material metallic and roughness", () => {
    const scene = rawScene();
    const material = createEngineDefaultMaterial(scene);

    expect(material).toBeInstanceOf(PBRMaterial);
    expect(material.name).toBe(ENGINE_DEFAULT_MATERIAL_NAME);
    expect(material.unlit).toBe(false);
    expect(material.disableLighting).toBe(false);
    expect(material.metallic).toBe(0);
    expect(material.roughness).toBe(0.5);
    expect(material.transparencyMode).toBe(Material.MATERIAL_OPAQUE);
    expect(material.backFaceCulling).toBe(true);
    expect(material.emissiveColor).toEqual(new Color3(0, 0, 0));
    expect(material.albedoColor).toEqual(new Color3(1, 1, 1));
  });

  it("uses a UV-tiled grey checker for albedo", () => {
    const scene = rawScene();
    const material = createEngineDefaultMaterial(scene);
    const albedo = material.albedoTexture;

    expect(albedo).toBeInstanceOf(Texture);
    expect(albedo!.getSize()).toEqual({ width: 2, height: 2 });
    expect(albedo!.wrapU).toBe(Texture.WRAP_ADDRESSMODE);
    expect(albedo!.wrapV).toBe(Texture.WRAP_ADDRESSMODE);
    expect(albedo!.samplingMode).toBe(Texture.NEAREST_SAMPLINGMODE);
    expect(albedo!.uScale).toBe(ENGINE_DEFAULT_CHECKER_TILES);
    expect(albedo!.vScale).toBe(ENGINE_DEFAULT_CHECKER_TILES);
    expect(ENGINE_DEFAULT_CHECKER_TILES).toBe(8);
    // Light 0.8 (user default baseColor) and slightly darker 0.65, as 8-bit sRGB.
    // NullEngine does not retain RawTexture pixel buffers; this is the source
    // createEngineDefaultMaterial uploads.
    expect(Array.from(engineDefaultCheckerRgba())).toEqual([
      204, 204, 204, 255, 166, 166, 166, 255, 166, 166, 166, 255, 204, 204, 204,
      255,
    ]);
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

  it("createTestEngine installs the engine default", () => {
    const handle = createTestEngine();
    handles.push(handle);
    expect(isEngineDefaultMaterial(handle.scene.defaultMaterial)).toBe(true);
  });

  it("setupDefaultViewport installs the engine default on a bare scene", () => {
    const scene = rawScene();
    setupDefaultViewport(scene);
    expect(isEngineDefaultMaterial(scene.defaultMaterial)).toBe(true);
  });
});
