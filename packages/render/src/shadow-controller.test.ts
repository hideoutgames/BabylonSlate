import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DirectionalLight,
  MeshBuilder,
  NullEngine,
  PointLight,
  SpotLight,
  RenderTargetTexture,
  Scene,
  UniversalCamera,
  Vector3,
} from "@babylonjs/core";
import { sceneShadowController } from "./shadow-controller";
import {
  sceneRenderingSettings,
  updateSceneRenderingSettings,
} from "./render-settings";
import { normalizeShadowSettings } from "@babylonslate/core";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});
function fixture() {
  const engine = new NullEngine();
  engines.push(engine);
  Object.assign(engine.getCaps(), {
    maxTexturesImageUnits: 16,
    maxTextureSize: 4096,
    maxCubemapTextureSize: 4096,
    textureHalfFloatRender: true,
    textureHalfFloatLinearFiltering: true,
  });
  // Babylon 9.20 NullEngine creates cube InternalTextures but leaves them
  // unattached to the wrapper. Complete that headless GPU boundary so the real
  // generator can expose dimensions and dispose its allocation like WebGL does.
  const createCubeTarget = engine.createRenderTargetCubeTexture.bind(engine);
  engine.createRenderTargetCubeTexture = (...args) => {
    const target = createCubeTarget(...args);
    if (!target.texture) {
      const texture = engine.getLoadedTexturesCache().at(-1);
      if (!texture)
        throw new Error("NullEngine cube allocation has no texture");
      target.setTexture(texture);
    }
    return target;
  };
  // NullEngine also leaves _releaseTexture empty. Match WebGL cache ownership
  // so resource disposal assertions observe the same lifetime as a real GPU.
  engine._releaseTexture = (texture) => {
    const cache = engine.getLoadedTexturesCache();
    const index = cache.indexOf(texture);
    if (index !== -1) cache.splice(index, 1);
  };
  const scene = new Scene(engine);
  scene.activeCamera = new UniversalCamera(
    "camera",
    new Vector3(0, 2, -10),
    scene,
  );
  updateSceneRenderingSettings(scene, {
    shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 1 }),
  });
  return { scene, controller: sceneShadowController(scene) };
}
describe("shared shadow lifecycle", () => {
  it("registers late meshes and releases removed meshes and disabled light allocations", async () => {
    const { scene, controller } = fixture();
    const light = new DirectionalLight("sun", new Vector3(0, -1, 1), scene);
    controller.register(light, true);
    controller.sync();
    const added = new Promise<void>((resolve) =>
      scene.onNewMeshAddedObservable.addOnce(() => resolve()),
    );
    const mesh = MeshBuilder.CreateBox("spawned", {}, scene);
    await added;
    controller.sync();
    expect(controller.generator(light)?.getShadowMap()?.renderList).toContain(
      mesh,
    );
    expect(mesh.receiveShadows).toBe(true);
    controller.setParticipation(mesh, {
      castShadows: false,
      receiveShadows: true,
    });
    controller.sync();
    expect(
      controller.generator(light)?.getShadowMap()?.renderList,
    ).not.toContain(mesh);
    expect(mesh.receiveShadows).toBe(true);
    controller.setParticipation(mesh, {
      castShadows: true,
      receiveShadows: false,
    });
    controller.sync();
    expect(controller.generator(light)?.getShadowMap()?.renderList).toContain(
      mesh,
    );
    expect(mesh.receiveShadows).toBe(false);
    mesh.dispose();
    expect(
      controller.generator(light)?.getShadowMap()?.renderList,
    ).not.toContain(mesh);
    light.setEnabled(false);
    controller.sync();
    expect(controller.generator(light)).toBeNull();
    light.setEnabled(true);
    controller.sync();
    expect(controller.generator(light)).not.toBeNull();
    controller.register(light, false);
    controller.sync();
    expect(controller.generator(light)).toBeNull();
  });
  it("budgets local lights separately and transfers capacity when an owner is disabled", () => {
    const { scene, controller } = fixture();
    const a = new PointLight("a", Vector3.Zero(), scene);
    const b = new PointLight("b", Vector3.Zero(), scene);
    controller.register(a, true);
    controller.register(b, true);
    controller.sync();
    expect(controller.diagnostics().map((light) => light.status)).toEqual([
      "active",
      "budget-limited",
    ]);
    a.setEnabled(false);
    controller.sync();
    expect(controller.diagnostics().map((light) => light.status)).toEqual([
      "disabled",
      "active",
    ]);
    expect(controller.diagnostics()[1]?.passes).toBe(6);
  });
  it("keeps helper meshes out of shadow maps and responds to camera replacement", () => {
    const { scene, controller } = fixture();
    const light = new DirectionalLight("sun", new Vector3(0, -1, 1), scene);
    const helper = MeshBuilder.CreateBox("__helper", {}, scene);
    controller.register(light, true);
    controller.sync();
    expect(
      controller.generator(light)?.getShadowMap()?.renderList,
    ).not.toContain(helper);
    const previous = controller.generator(light);
    scene.activeCamera = new UniversalCamera(
      "possessed",
      Vector3.Zero(),
      scene,
    );
    controller.sync();
    expect(controller.generator(light)).toBe(previous);
    const map = previous?.getShadowMap();
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({
        cascades: 1,
        distance: 100,
        autoBias: false,
        normalBias: 0.025,
        depthBias: 0.002,
        filter: "pcss",
      }),
    });
    controller.sync();
    expect(controller.generator(light)).toBe(previous);
    expect(controller.generator(light)?.getShadowMap()).toBe(map);
    expect(controller.generator(light)?.normalBias).toBe(0.025);
    expect(controller.generator(light)?.bias).toBe(0.002);
  });
  it("retains allocation for small intensity changes but yields to a substantially stronger light or authored priority", () => {
    const { scene, controller } = fixture();
    const a = new PointLight("a", Vector3.Zero(), scene);
    const b = new PointLight("b", Vector3.Zero(), scene);
    controller.register(a, true);
    controller.register(b, true);
    controller.sync();
    b.intensity = 1.05;
    controller.sync();
    expect(controller.generator(a)).not.toBeNull();
    b.intensity = 2;
    controller.sync();
    expect(controller.generator(a)).toBeNull();
    expect(controller.generator(b)).not.toBeNull();
    controller.register(a, true, 1);
    controller.sync();
    expect(controller.generator(a)).not.toBeNull();
    expect(controller.generator(b)).toBeNull();
  });
  it("follows a replacement active camera and preserves deterministic distance hysteresis", () => {
    const { scene, controller } = fixture();
    const a = new PointLight("near-start", new Vector3(0, 0, 0), scene);
    const b = new PointLight("near-destination", new Vector3(100, 0, 0), scene);
    controller.register(a, true);
    controller.register(b, true);
    controller.sync();
    expect(controller.generator(a)).not.toBeNull();
    scene.activeCamera = new UniversalCamera(
      "possessed",
      new Vector3(100, 0, -5),
      scene,
    );
    controller.sync();
    expect(controller.generator(a)).toBeNull();
    const incumbent = controller.generator(b);
    expect(incumbent).not.toBeNull();
    scene.activeCamera.position.x = 50;
    controller.sync();
    expect(controller.generator(b)).toBe(incumbent);
    scene.activeCamera.position.x = 0;
    controller.sync();
    expect(controller.generator(a)).not.toBeNull();
  });
  it("admits point cube memory and faces before construction, then lowers cost after Manual 16 and a Low preset", () => {
    const { scene, controller } = fixture();
    const allocation = vi.spyOn(
      scene.getEngine(),
      "createRenderTargetCubeTexture",
    );
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({
        profile: "ultra",
        maxLocalLights: 16,
        localMapSize: 2048,
      }),
    });
    const points = Array.from(
      { length: 16 },
      (_, i) => new PointLight(`point-${i}`, Vector3.Zero(), scene),
    );
    points.forEach((light) => controller.register(light, true));
    controller.sync();
    const active = points.filter((light) => controller.generator(light));
    expect(active).toHaveLength(8);
    expect(allocation).toHaveBeenCalledTimes(8);
    expect(controller.metrics().passes).toBe(48);
    expect(controller.metrics().bytes).toBeLessThanOrEqual(384 * 1024 ** 2);
    expect(controller.limits()).toContain(
      "point shadows: Poisson filter fallback",
    );
    controller.sync();
    expect(allocation).toHaveBeenCalledTimes(8);
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ profile: "low", maxLocalLights: 16 }),
    });
    controller.sync();
    expect(points.filter((light) => controller.generator(light))).toHaveLength(
      1,
    );
    expect(controller.metrics().passes).toBe(6);
    expect(controller.metrics().bytes).toBe(18 * 1024 ** 2);
  });
  it("charges spot shadows by one face and reserves sampler headroom for materials", () => {
    const { scene, controller } = fixture();
    const caps = scene.getEngine().getCaps();
    caps.maxTexturesImageUnits = 32;
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({
        profile: "ultra",
        maxLocalLights: 16,
        localMapSize: 256,
      }),
    });
    const lights = Array.from(
      { length: 16 },
      (_, i) =>
        new SpotLight(
          `spot-${i}`,
          Vector3.Zero(),
          Vector3.Forward(),
          Math.PI / 2,
          1,
          scene,
        ),
    );
    lights.forEach((light) => controller.register(light, true));
    controller.sync();
    expect(controller.metrics().passes).toBe(16);
    caps.maxTexturesImageUnits = 11;
    controller.sync();
    expect(controller.metrics().passes).toBe(3);
    expect(
      controller
        .diagnostics()
        .filter((light) => light.reason === "material sampler headroom"),
    ).toHaveLength(13);
  });
  it("shares the Engine allowance with previews and releases reservations on scene disposal", () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    const preview = new Scene(engine);
    preview.activeCamera = new UniversalCamera(
      "preview-camera",
      Vector3.Zero(),
      preview,
    );
    const previewController = sceneShadowController(preview);
    for (const [client, owner] of [
      [scene, controller],
      [preview, previewController],
    ] as const) {
      updateSceneRenderingSettings(client, {
        shadows: normalizeShadowSettings({
          profile: "ultra",
          maxLocalLights: 16,
          localMapSize: 2048,
        }),
      });
      for (let i = 0; i < 16; i++)
        owner.register(
          new PointLight(`point-${i}`, Vector3.Zero(), client),
          true,
        );
      owner.sync();
    }
    expect(
      controller.metrics().passes + previewController.metrics().passes,
    ).toBeLessThanOrEqual(64);
    expect(
      controller.metrics().bytes + previewController.metrics().bytes,
    ).toBeLessThanOrEqual(512 * 1024 ** 2);
    expect(previewController.metrics().passes).toBe(12);
    scene.dispose();
    previewController.sync();
    expect(previewController.metrics().passes).toBe(48);
  });
  it("exhausts bounded smaller maps, admits healthy lights and retries after context recovery", async () => {
    const { scene, controller } = fixture();
    const light = new PointLight("point", Vector3.Zero(), scene);
    controller.register(light, true, 1);
    const fallback = new PointLight("fallback", Vector3.Zero(), scene);
    controller.register(fallback, true);
    const engine = scene.getEngine();
    const baselineTextures = [...scene.textures];
    const baselineInternals = [...engine.getLoadedTexturesCache()];
    const baselineWrappers = [...engine._renderTargetWrapperCache];
    const baselineResizeObservers = engine.onResizeObservable.observers.length;
    const baselineRenderPasses = engine.getRenderPassNames().filter(Boolean);
    const allocation = vi.spyOn(engine, "createRenderTargetCubeTexture");
    for (let attempt = 0; attempt < 3; attempt++)
      allocation.mockImplementationOnce(() => {
        throw new Error("allocation failed");
      });
    controller.sync();
    expect(controller.metrics()).toEqual({ bytes: 0, passes: 0 });
    expect(allocation.mock.calls.map(([size]) => size)).toEqual([
      1024, 512, 256,
    ]);
    expect(scene.textures).toEqual(baselineTextures);
    expect(engine.getLoadedTexturesCache()).toEqual(baselineInternals);
    expect(engine._renderTargetWrapperCache).toEqual(baselineWrappers);
    expect(engine.getRenderPassNames().filter(Boolean)).toEqual(
      baselineRenderPasses,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.onResizeObservable.observers).toHaveLength(
      baselineResizeObservers,
    );
    controller.sync();
    controller.sync();
    expect(controller.generator(light)).toBeNull();
    expect(controller.status(light)).toBe("allocation-failed");
    expect(allocation).toHaveBeenCalledTimes(4);
    expect(controller.generator(fallback)).not.toBeNull();
    engine.onContextRestoredObservable.notifyObservers(engine);
    controller.sync();
    expect(controller.generator(light)).not.toBeNull();
    expect(controller.generator(light)?.getShadowMap()?.getRenderSize()).toBe(
      1024,
    );
    expect(controller.generator(fallback)).toBeNull();
  });
  it("releases a partially allocated cube before retrying smaller without changing authored settings", async () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    const preview = new RenderTargetTexture("existing-preview", 256, scene);
    const previewTarget = preview.renderTarget;
    const baselineTextures = [...scene.textures];
    const baselineInternals = [...engine.getLoadedTexturesCache()];
    const baselineWrappers = [...engine._renderTargetWrapperCache];
    const baselineResizeObservers = engine.onResizeObservable.observers.length;
    const authored = structuredClone(sceneRenderingSettings(scene).shadows);
    const light = new PointLight("point", Vector3.Zero(), scene);
    controller.register(light, true);
    const allocate = engine.createRenderTargetCubeTexture.bind(engine);
    let orphanDispose: ReturnType<typeof vi.spyOn> | undefined;
    const allocation = vi
      .spyOn(engine, "createRenderTargetCubeTexture")
      .mockImplementationOnce((...args) => {
        const orphan = allocate(...args);
        orphanDispose = vi.spyOn(orphan.texture!, "dispose");
        throw new Error("driver rejected completed cube");
      });
    controller.sync();
    const retained = controller.generator(light);
    expect(retained?.getShadowMap()?.getRenderSize()).toBe(512);
    expect(controller.metrics()).toEqual({ bytes: 18 * 1024 ** 2, passes: 6 });
    expect(sceneRenderingSettings(scene).shadows).toEqual(authored);
    expect(
      controller.diagnostics().find((entry) => entry.name === "point"),
    ).toMatchObject({
      status: "active",
      reason: "shadow map reduced after allocation failure",
      allocationError: "driver rejected completed cube",
    });
    expect(allocation.mock.calls.map(([size]) => size)).toEqual([1024, 512]);
    expect(orphanDispose).toHaveBeenCalledTimes(1);
    controller.sync();
    expect(controller.generator(light)).toBe(retained);
    expect(allocation).toHaveBeenCalledTimes(2);
    light.setEnabled(false);
    controller.sync();
    expect(scene.textures).toEqual(baselineTextures);
    expect(engine.getLoadedTexturesCache()).toEqual(baselineInternals);
    expect(engine._renderTargetWrapperCache).toEqual(baselineWrappers);
    expect(preview.renderTarget).toBe(previewTarget);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.onResizeObservable.observers).toHaveLength(
      baselineResizeObservers,
    );
    light.setEnabled(true);
    controller.sync();
    expect(controller.generator(light)?.getShadowMap()?.getRenderSize()).toBe(
      512,
    );
    engine.onContextRestoredObservable.notifyObservers(engine);
    controller.sync();
    expect(controller.generator(light)?.getShadowMap()?.getRenderSize()).toBe(
      1024,
    );
    const restoreObservers =
      engine.onContextRestoredObservable.observers.length;
    scene.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.onContextRestoredObservable.observers).toHaveLength(
      restoreObservers - 1,
    );
  });
  it("propagates cleanup failure without attempting another allocation", () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    const light = new PointLight("point", Vector3.Zero(), scene);
    controller.register(light, true);
    const allocate = engine.createRenderTargetCubeTexture.bind(engine);
    let restoreFailedDispose: (() => void) | undefined;
    const allocation = vi
      .spyOn(engine, "createRenderTargetCubeTexture")
      .mockImplementationOnce((...args) => {
        const target = allocate(...args);
        const failedDispose = vi
          .spyOn(target, "dispose")
          .mockImplementationOnce(() => {
            throw new Error("driver cleanup failed");
          });
        restoreFailedDispose = () => failedDispose.mockRestore();
        throw new Error("driver allocation failed");
      });
    try {
      expect(() => controller.sync()).toThrow(
        "Shadow allocation and resource cleanup failed",
      );
      expect(allocation).toHaveBeenCalledTimes(1);
      expect(controller.status(light)).toBe("allocation-failed");
    } finally {
      restoreFailedDispose?.();
    }
  });
});
