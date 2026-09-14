import { afterEach, expect, it, vi } from "vitest";
import {
  BaseTexture,
  CubeTexture,
  NullEngine,
  Scene,
  SphericalPolynomial,
  Vector3,
} from "@babylonjs/core";
import { normalizeEnvironmentLightingSettings } from "@babylonslate/core";
import { buildFloatDdsCubeFixture } from "@babylonslate/test-kit/environment-fixtures";
import { ResourceCache } from "./resource-cache";
import { updateSceneRenderingSettings } from "./render-settings";
import {
  applyEnvironmentLighting,
  isEnvironmentLightingReady,
  retainEnvironmentSample,
  syncEnvironmentLighting,
} from "./environment-lighting";

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  vi.restoreAllMocks();
});

function fixture() {
  const engine = new NullEngine();
  const cache = new ResourceCache();
  // NullEngine has no cube upload IO. Keep actual InternalTexture cache,
  // CubeTexture clone/serialization, Scene and ResourceCache ownership.
  const upload = vi
    .spyOn(engine, "createPrefilteredCubeTexture")
    .mockImplementation((url) => {
      const internal = engine.createTexture(url, false, false, null);
      internal.isCube = true;
      return internal;
    });
  const a = new Scene(engine),
    b = new Scene(engine);
  const bytes = buildFloatDdsCubeFixture();
  const assets = {
    resourceCache: cache,
    textureBytes: new Map([["environment", bytes]]),
  };
  disposers.push(() => {
    a.dispose();
    b.dispose();
    cache.dispose();
    engine.dispose();
  });
  return { engine, cache, upload, a, b, bytes, assets };
}

it("isolates reflection matrices and intensity while sharing uploaded radiance and irradiance through either scene's disposal", () => {
  const { engine, cache, upload, a, b, bytes, assets } = fixture();
  const source = cache.getTexture("environment", engine, bytes, {
    isCube: true,
  }) as CubeTexture;
  const irradiance = new BaseTexture(
    engine,
    engine.createTexture("irradiance", false, false, null),
  );
  source.irradianceTexture = irradiance;
  source.sphericalPolynomial = new SphericalPolynomial();
  const polynomial = source.sphericalPolynomial;
  updateSceneRenderingSettings(a, {
    environmentLighting: normalizeEnvironmentLightingSettings({
      intensity: 2,
      rotationYDegrees: 90,
    }),
  });
  updateSceneRenderingSettings(b, {
    environmentLighting: normalizeEnvironmentLightingSettings({
      intensity: 0.5,
    }),
  });
  applyEnvironmentLighting(a, "environment", assets);
  applyEnvironmentLighting(b, "environment", assets);
  const av = a.environmentTexture as CubeTexture,
    bv = b.environmentTexture as CubeTexture;
  expect(av).not.toBe(bv);
  expect(av.getInternalTexture()).toBe(source.getInternalTexture());
  expect(bv.getInternalTexture()).toBe(source.getInternalTexture());
  expect(upload).toHaveBeenCalledTimes(1);
  expect(source.irradianceTexture).toBe(irradiance);
  expect(av.irradianceTexture).toBe(irradiance);
  expect(bv.sphericalPolynomial).toBe(polynomial);
  expect(source.getReflectionTextureMatrix().isIdentity()).toBe(true);
  expect(bv.getReflectionTextureMatrix().isIdentity()).toBe(true);
  const rotated = Vector3.TransformNormal(
    Vector3.Right(),
    av.getReflectionTextureMatrix(),
  );
  expect(rotated.x).toBeCloseTo(0);
  expect(rotated.z).toBeCloseTo(-1);
  expect(a.iblIntensity).toBe(2);
  expect(b.iblIntensity).toBe(0.5);
  a.dispose();
  expect(av.getInternalTexture()).toBeNull();
  expect(bv.isReady()).toBe(true);
  expect(bv.irradianceTexture?.getInternalTexture()).not.toBeNull();
  expect(source.sphericalPolynomial).toBe(polynomial);
  b.dispose();
  expect(source.getInternalTexture()).not.toBeNull();
  cache.release(source);
  cache.flushUnreferenced();
  expect(source.getInternalTexture()).toBeNull();
});

it("admits no cube for disabled IBL unless an explicit raw sample consumes it, then releases the final consumer", () => {
  const { cache, upload, a, assets } = fixture();
  updateSceneRenderingSettings(a, {
    environmentLighting: normalizeEnvironmentLightingSettings({
      enabled: false,
      intensity: 4,
      rotationYDegrees: -45,
    }),
  });
  applyEnvironmentLighting(a, "environment", assets);
  expect(upload).not.toHaveBeenCalled();
  expect(a.environmentTexture).toBeNull();
  expect(isEnvironmentLightingReady(a)).toBe(true);
  const release = retainEnvironmentSample(a, {});
  const view = a.environmentTexture as CubeTexture;
  expect(view.isReady()).toBe(true);
  expect(a.iblIntensity).toBe(0);
  expect(view.level).toBe(1); // Raw samples never receive automatic IBL intensity.
  expect(view.rotationY).toBeCloseTo(-Math.PI / 4);
  release();
  expect(a.environmentTexture).toBeNull();
  expect(view.getInternalTexture()).toBeNull();
  cache.flushUnreferenced();
  expect(cache.accountedBytes()).toBe(0);
});

it("reuses the view across repeated asset collection and balances every source lease after disabling", () => {
  const { cache, upload, a, bytes, assets } = fixture();
  applyEnvironmentLighting(a, "environment", assets);
  const view = a.environmentTexture as CubeTexture;
  for (let i = 0; i < 8; i++)
    applyEnvironmentLighting(a, "environment", {
      ...assets,
      textureBytes: new Map([["environment", bytes.slice()]]),
    });
  expect(a.environmentTexture).toBe(view);
  expect(upload).toHaveBeenCalledTimes(1);
  updateSceneRenderingSettings(a, undefined, undefined, undefined, {
    enabled: false,
  });
  syncEnvironmentLighting(a);
  cache.flushUnreferenced();
  expect(view.getInternalTexture()).toBeNull();
  expect(cache.accountedBytes()).toBe(0);
  updateSceneRenderingSettings(a, undefined, undefined, undefined, {});
  syncEnvironmentLighting(a);
  expect(a.environmentTexture?.isReady()).toBe(true);
  expect(a.environmentTexture).not.toBe(view);
});

it("blocks pending uploads and exposes the current source failure without letting a stale upload poison its replacement", () => {
  const { engine, upload, a, assets } = fixture();
  let fail: ((message?: string, exception?: unknown) => void) | undefined;
  upload.mockImplementationOnce(
    (url, _scene, _scale, _offset, _load, onError) => {
      fail = onError ?? undefined;
      const internal = engine.createTexture(url, false, false, null);
      internal.isCube = true;
      internal.isReady = false;
      return internal;
    },
  );
  applyEnvironmentLighting(a, "environment", assets);
  expect(isEnvironmentLightingReady(a)).toBe(false);
  fail!("Invalid environment pixels");
  expect(() => isEnvironmentLightingReady(a)).toThrow(
    "Invalid environment pixels",
  );
  applyEnvironmentLighting(a, "replacement", {
    ...assets,
    textureBytes: new Map([
      ["replacement", buildFloatDdsCubeFixture({ color: [1, 0, 0, 1] })],
    ]),
  });
  fail!("Obsolete failure");
  expect(isEnvironmentLightingReady(a)).toBe(true);
});
