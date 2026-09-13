import { afterEach, expect, it, vi } from "vitest";
import { CubeTexture, NullEngine, Scene, type Texture } from "@babylonjs/core";
import { buildFloatDdsCubeFixture } from "@babylonslate/test-kit/environment-fixtures";
import { getMaterialTexture, ResourceCache } from "./resource-cache";
import { validMaterialParameterValue } from "./material-parameters";

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  vi.restoreAllMocks();
});

function nullHost() {
  const engine = new NullEngine();
  // NullEngine has no XHR/GPU cube upload. Preserve its real InternalTexture
  // cache/disposal boundary and all real CubeTexture wrapper behavior; browser
  // coverage exercises native DDS/ENV loading and reads actual face texels.
  vi.spyOn(engine, "createPrefilteredCubeTexture").mockImplementation((url) => {
    const texture = engine.createTexture(url, false, false, null);
    texture.isCube = true;
    return texture;
  });
  return engine;
}

it("loads DDS through the prefiltered Blob route and preserves shared Engine ownership", () => {
  const engine = nullHost();
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
  const engine = nullHost();
  const cache = new ResourceCache();
  disposers.push(() => {
    cache.dispose();
    engine.dispose();
  });
  const bytes = buildFloatDdsCubeFixture();
  const before = engine.getLoadedTexturesCache().length;
  expect(() =>
    cache.getTexture("unknown-blob", engine, new Blob([bytes]), {
      isCube: true,
    }),
  ).toThrow(/MIME/);
  expect(getMaterialTexture(cache, "environment", engine, bytes)).toBeNull();
  expect(engine.getLoadedTexturesCache()).toHaveLength(before);
  expect(() => cache.getTexture("environment", engine, bytes)).toThrow(/2D/);
  const cube = cache.getTexture("environment", engine, bytes, { isCube: true });
  const blobCube = cache.getTexture(
    "typed-blob",
    engine,
    new Blob([bytes], { type: "image/vnd-ms.dds" }),
    { isCube: true },
  ) as CubeTexture;
  expect(blobCube.forcedExtension).toBe(".dds");
  expect(blobCube.gammaSpace).toBe(false);
  expect(
    validMaterialParameterValue(
      { kind: "texture", textureAssetGuid: "environment" },
      () => cube as unknown as Texture,
    ),
  ).toBe(false);
});
