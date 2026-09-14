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
import { createDefaultScene } from "@babylonslate/core";
import { applySceneEnvironment } from "./scene-illumination";
import { setSceneRenderSettings } from "./scene-render-mode";
import { isSceneFrameReady } from "./scene-perf";
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

function fixture(suppliedIrradiance = true) {
  const engine = new NullEngine();
  const cache = new ResourceCache();
  // NullEngine has no cube upload IO. Keep actual InternalTexture cache,
  // CubeTexture clone/serialization, Scene and ResourceCache ownership.
  const upload = vi
    .spyOn(engine, "createPrefilteredCubeTexture")
    .mockImplementation((url) => {
      const internal = engine.createTexture(url, false, false, null);
      internal.isCube = true;
      if (suppliedIrradiance)
        internal._sphericalPolynomial = new SphericalPolynomial();
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
  expect(isSceneFrameReady(a)).toBe(false);
  fail!("Invalid environment pixels");
  expect(() => isEnvironmentLightingReady(a)).toThrow(
    "Invalid environment pixels",
  );
  expect(() => isSceneFrameReady(a)).toThrow("Invalid environment pixels");
  applyEnvironmentLighting(a, "replacement", {
    ...assets,
    textureBytes: new Map([
      ["replacement", buildFloatDdsCubeFixture({ color: [1, 0, 0, 1] })],
    ]),
  });
  fail!("Obsolete failure");
  expect(isEnvironmentLightingReady(a)).toBe(true);
});

it("applies serialized Scene overrides and live project updates through the existing renderer entry points", () => {
  const { a, assets } = fixture();
  const document = createDefaultScene();
  document.settings.environmentTextureGuid = "environment";
  document.settings.environmentLighting = {
    intensity: 2,
    rotationYDegrees: -90,
  };
  setSceneRenderSettings(a, {
    environmentLighting: normalizeEnvironmentLightingSettings({ intensity: 3 }),
  });
  applySceneEnvironment(a, document, { assets });
  expect(a.iblIntensity).toBe(2);
  const view = a.environmentTexture as CubeTexture;
  expect(view.rotationY).toBeCloseTo(-Math.PI / 2);
  delete document.settings.environmentLighting.intensity;
  applySceneEnvironment(a, document, { assets });
  expect(a.iblIntensity).toBe(3);
  setSceneRenderSettings(a, {
    environmentLighting: normalizeEnvironmentLightingSettings({ intensity: 4 }),
  });
  expect(a.iblIntensity).toBe(4);
  expect(a.environmentTexture).toBe(view);
});

it("shares bounded irradiance readback, survives one view closing, and retains a constant linear environment", async () => {
  const { engine, cache, a, b, bytes, assets } = fixture(false);
  const source = cache.getTexture("environment", engine, bytes, {
    isCube: true,
  }) as CubeTexture;
  const internal = source.getInternalTexture()!;
  internal.width = internal.height = 64;
  const finish: Array<(pixels: Float32Array) => void> = [];
  const read = vi
    .spyOn(source, "readPixels")
    .mockImplementation(
      () => new Promise<Float32Array>((resolve) => finish.push(resolve)),
    );
  applyEnvironmentLighting(a, "environment", assets);
  applyEnvironmentLighting(b, "environment", assets);
  cache.release(source);
  expect(isEnvironmentLightingReady(a)).toBe(false);
  expect(isEnvironmentLightingReady(b)).toBe(false);
  const av = a.environmentTexture!;
  expect(av.sphericalPolynomial).toBeNull();
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(6);
  for (let face = 0; face < 6; face++)
    expect(read).toHaveBeenCalledWith(face, 1, undefined, false);
  a.dispose();
  expect(av.sphericalPolynomial).toBeNull();
  const pixels = new Float32Array(32 * 32 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([0, 2, 0, 1], i);
  for (const resolve of finish) resolve(pixels);
  await vi.waitFor(() => expect(isEnvironmentLightingReady(b)).toBe(true));
  const polynomial = b.environmentTexture!.sphericalPolynomial!;
  expect(polynomial.yy.y).toBeCloseTo(2, 2);
  expect(polynomial.yy.x).toBe(0);
  expect(polynomial.yy.z).toBe(0);
  expect(internal._sphericalPolynomial).toBeNull(); // No shared source mutation.
  b.dispose();
  cache.flushUnreferenced();
  expect(source.getInternalTexture()).toBeNull();
});

it("keeps all pending face reads alive after rejection and ignores obsolete work after a scene swaps environments", async () => {
  const { engine, cache, upload, a, bytes, assets } = fixture(false);
  const source = cache.getTexture("environment", engine, bytes, {
    isCube: true,
  }) as CubeTexture;
  source.getInternalTexture()!.width = source.getInternalTexture()!.height = 2;
  const finish: Array<(pixels: Float32Array) => void> = [];
  vi.spyOn(source, "readPixels").mockImplementation((face) =>
    face === 0
      ? Promise.reject(new Error("readback rejected"))
      : new Promise<Float32Array>((resolve) => finish.push(resolve)),
  );
  applyEnvironmentLighting(a, "environment", assets);
  cache.release(source);
  expect(isEnvironmentLightingReady(a)).toBe(false);
  await Promise.resolve();
  upload.mockImplementationOnce((url) => {
    const texture = engine.createTexture(url, false, false, null);
    texture.isCube = true;
    texture._sphericalPolynomial = new SphericalPolynomial();
    return texture;
  });
  applyEnvironmentLighting(a, "replacement", {
    ...assets,
    textureBytes: new Map([["replacement", bytes]]),
  });
  cache.flushUnreferenced();
  expect(source.getInternalTexture()).not.toBeNull();
  expect(isEnvironmentLightingReady(a)).toBe(true);
  for (const resolve of finish) resolve(new Float32Array(16));
  await vi.waitFor(() => {
    cache.flushUnreferenced();
    expect(source.getInternalTexture()).toBeNull();
  });
  expect(isEnvironmentLightingReady(a)).toBe(true);
});

it("decodes RGBD fallback radiance and exposes readback failures to the owning scene", async () => {
  const { engine, cache, a, b, bytes, assets } = fixture(false);
  engine.useExactSrgbConversions = true;
  const source = cache.getTexture("environment", engine, bytes, {
    isCube: true,
  }) as CubeTexture;
  source.getInternalTexture()!.width = source.getInternalTexture()!.height = 2;
  source.isRGBD = true;
  const pixels = new Uint8Array(16);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([0, 128, 0, 64], i);
  vi.spyOn(source, "readPixels").mockResolvedValue(pixels);
  applyEnvironmentLighting(a, "environment", assets);
  expect(isEnvironmentLightingReady(a)).toBe(false);
  await vi.waitFor(() => expect(isEnvironmentLightingReady(a)).toBe(true));
  expect(a.environmentTexture!.sphericalPolynomial!.yy.y).toBeCloseTo(
    ((128 / 255 + 0.055) / 1.055) ** 2.4 / (64 / 255),
    2,
  );
  const broken = cache.getTexture("broken", engine, bytes, {
    isCube: true,
  }) as CubeTexture;
  vi.spyOn(broken, "readPixels").mockRejectedValue(
    new Error("GPU read failed"),
  );
  applyEnvironmentLighting(b, "broken", {
    ...assets,
    textureBytes: new Map([["broken", bytes]]),
  });
  expect(isEnvironmentLightingReady(b)).toBe(false);
  await vi.waitFor(() =>
    expect(() => isEnvironmentLightingReady(b)).toThrow(
      "Environment irradiance preparation failed",
    ),
  );
  expect(isEnvironmentLightingReady(a)).toBe(true);
  cache.release(source);
  cache.release(broken);
});
