import { afterEach, expect, it, vi } from "vitest";
import { CubeTexture, NullEngine, PBRMaterial, Scene, SphericalPolynomial } from "@babylonjs/core";
import { createDefaultScene } from "@haptic/core";
import { buildFloatDdsCubeFixture } from "@haptic/test-kit/environment-fixtures";
import { ResourceCache, type ResourceLease } from "./resource-cache";
import { applySceneEnvironment } from "./scene-illumination";
import { createSkyboxMesh } from "./skybox";
import { isEnvironmentLightingReady } from "./environment-lighting";
import { retainFilteredEnvironment, type FilteredEnvironment } from "./environment-prefilter";

// The GGX pass needs a GPU; the controller's use of its result is what this covers.
vi.mock("./environment-prefilter", () => ({ retainFilteredEnvironment: vi.fn() }));

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  vi.restoreAllMocks();
});

function fixture() {
  const engine = new NullEngine();
  const cache = new ResourceCache();
  vi.spyOn(engine, "createPrefilteredCubeTexture").mockImplementation((url) => {
    const internal = engine.createTexture(url, false, false, null);
    internal.isCube = true;
    internal._sphericalPolynomial = new SphericalPolynomial();
    return internal;
  });
  const scene = new Scene(engine);
  const assets = { resourceCache: cache, textureBytes: new Map<string, Uint8Array>() };
  const sky = createSkyboxMesh(scene, "Sky", cache.acquireTexture("sky", engine, buildFloatDdsCubeFixture(), { isCube: true }) as ResourceLease<CubeTexture>);
  const skyCube = (sky.material as PBRMaterial).reflectionTexture as CubeTexture;
  disposers.push(() => { scene.dispose(); cache.dispose(); engine.dispose(); });
  return { engine, cache, scene, assets, sky, skyCube };
}

/** A filter whose completion the test controls, counting held handles. */
function controlledFilter(engine: NullEngine) {
  const internal = engine.createTexture("filtered", false, false, null);
  internal.isCube = true;
  internal._sphericalPolynomial = new SphericalPolynomial();
  const cube = new CubeTexture("", engine);
  cube._texture = internal;
  cube.gammaSpace = false;
  let finish!: () => void, fail!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  let held = 0;
  vi.mocked(retainFilteredEnvironment).mockImplementation(() => {
    held++;
    let released = false;
    return { cube, ready, release: () => { if (!released) { released = true; held--; } } } satisfies FilteredEnvironment;
  });
  return { cube, finish, fail, held: () => held };
}

it("holds readiness while the sky filters, then lights from the filtered cube and releases it with the sky", async () => {
  const { engine, scene, assets, sky } = fixture();
  const filter = controlledFilter(engine);
  applySceneEnvironment(scene, createDefaultScene(), { assets });
  expect(scene.environmentTexture).toBeNull();
  expect(isEnvironmentLightingReady(scene)).toBe(false);

  filter.finish();
  await vi.waitFor(() => expect(scene.environmentTexture).not.toBeNull());
  const view = scene.environmentTexture as CubeTexture;
  expect(view.getInternalTexture()).toBe(filter.cube.getInternalTexture());
  expect(view.gammaSpace).toBe(false);
  expect(isEnvironmentLightingReady(scene)).toBe(true);

  sky.dispose();
  expect(isEnvironmentLightingReady(scene)).toBe(true);
  expect(scene.environmentTexture).toBeNull();
  expect(filter.held()).toBe(0);
});

it("lights from the unfiltered sky when filtering fails", async () => {
  const { engine, scene, assets, skyCube } = fixture();
  const filter = controlledFilter(engine);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  applySceneEnvironment(scene, createDefaultScene(), { assets });
  filter.fail(new Error("controlled filter failure"));
  await vi.waitFor(() => expect(scene.environmentTexture).not.toBeNull());
  expect(scene.environmentTexture!.getInternalTexture()).toBe(skyCube.getInternalTexture());
  expect(isEnvironmentLightingReady(scene)).toBe(true);
  expect(error).toHaveBeenCalledOnce();
  expect(filter.held()).toBe(0);
});
