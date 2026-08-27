import { afterEach, describe, expect, it } from "vitest";
import { NodeMaterial, NullEngine, Scene, Texture } from "@babylonjs/core";
import {
  isDisposedGpuTexture,
  isDisposedNodeMaterial,
  isEngineOwnedGpuTexture,
} from "./gpu-resource-live";

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

describe("isDisposedGpuTexture", () => {
  it("treats a mock with isDisposed() as disposed when that returns true", () => {
    expect(isDisposedGpuTexture({ isDisposed: () => true })).toBe(true);
    expect(isDisposedGpuTexture({ isDisposed: () => false })).toBe(false);
  });

  it("detects a disposed scene-owned Texture that never had an InternalTexture", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    disposers.push(() => {
      scene.dispose();
      engine.dispose();
    });
    const texture = new Texture(null, scene, true, false);
    expect(isDisposedGpuTexture(texture)).toBe(false);
    texture.dispose();
    expect(isDisposedGpuTexture(texture)).toBe(true);
  });

  it("detects a disposed engine-owned Texture used by ResourceCache", () => {
    const engine = new NullEngine();
    disposers.push(() => engine.dispose());
    const texture = new Texture("data:image/png;base64,aa", engine, {
      noMipmap: true,
      invertY: false,
    });
    expect(isDisposedGpuTexture(texture)).toBe(false);
    texture.dispose();
    expect(isDisposedGpuTexture(texture)).toBe(true);
  });
});

describe("isEngineOwnedGpuTexture", () => {
  it("is true for ResourceCache-style engine textures and false for scene-owned ones", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    disposers.push(() => {
      scene.dispose();
      engine.dispose();
    });
    const engineOwned = new Texture("data:image/png;base64,aa", engine, {
      noMipmap: true,
      invertY: false,
    });
    const sceneOwned = new Texture(null, scene, true, false);
    expect(isEngineOwnedGpuTexture(engineOwned)).toBe(true);
    expect(isEngineOwnedGpuTexture(sceneOwned)).toBe(false);
  });
});

describe("isDisposedNodeMaterial", () => {
  it("is true after NodeMaterial.dispose removes it from the scene", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    disposers.push(() => {
      scene.dispose();
      engine.dispose();
    });
    const material = new NodeMaterial("n", scene);
    expect(isDisposedNodeMaterial(material, scene)).toBe(false);
    material.dispose();
    expect(isDisposedNodeMaterial(material, scene)).toBe(true);
  });
});
