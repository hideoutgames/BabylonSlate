import { afterEach, expect, it } from "vitest";
import { CubeTexture, NullEngine, Scene, type Texture } from "@babylonjs/core";
import { buildFloatDdsCubeFixture } from "@babylonslate/test-kit";
import { getMaterialTexture, ResourceCache } from "./resource-cache";
import { validMaterialParameterValue } from "./material-parameters";

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
});

it("loads DDS through the prefiltered Blob route and preserves shared Engine ownership", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const cache = new ResourceCache();
  disposers.push(() => {
    cache.dispose();
    scene.dispose();
    engine.dispose();
  });
  const bytes = buildFloatDdsCubeFixture();
  const cube = cache.getTexture("environment", engine, bytes, {
    isCube: true,
  }) as CubeTexture;
  expect(cube.forcedExtension).toBe(".dds");
  expect(cube.gammaSpace).toBe(false);
  expect(cube.isCube).toBe(true);
  expect(cube.getScene()).toBeNull();
  scene.environmentTexture = cube;
  expect(cache.getTexture("environment", engine, bytes, { isCube: true })).toBe(
    cube,
  );
  scene.dispose();
  expect(cube.getInternalTexture()).not.toBeNull();
  cache.releaseGpuTextures();
  expect(cube.getInternalTexture()).toBeNull();
  const recreated = cache.getTexture("environment", engine, bytes, {
    isCube: true,
  }) as CubeTexture;
  expect(recreated).not.toBe(cube);
  expect(recreated.forcedExtension).toBe(".dds");
  expect(recreated.gammaSpace).toBe(false);
});

it("rejects cubes at 2D material and dynamic parameter admission without allocating a 2D wrapper", () => {
  const engine = new NullEngine();
  const cache = new ResourceCache();
  disposers.push(() => {
    cache.dispose();
    engine.dispose();
  });
  const bytes = buildFloatDdsCubeFixture();
  const before = engine.getLoadedTexturesCache().length;
  expect(getMaterialTexture(cache, "environment", engine, bytes)).toBeNull();
  expect(engine.getLoadedTexturesCache()).toHaveLength(before);
  expect(() => cache.getTexture("environment", engine, bytes)).toThrow(/2D/);
  const cube = cache.getTexture("environment", engine, bytes, { isCube: true });
  expect(
    validMaterialParameterValue(
      { kind: "texture", textureAssetGuid: "environment" },
      () => cube as unknown as Texture,
    ),
  ).toBe(false);
});
