import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CascadedShadowGenerator,
  InternalTexture,
  InternalTextureSource,
  DirectionalLight,
  MeshBuilder,
  NullEngine,
  PointLight,
  SpotLight,
  RenderTargetTexture,
  Scene,
  ShadowGenerator,
  UniversalCamera,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { sceneShadowController } from "./shadow-controller";
import {
  sceneRenderingSettings,
  updateSceneRenderingSettings,
} from "./render-settings";
import { normalizeShadowSettings, qualityPresetPatch } from "@babylonslate/core";
import { otherShadowReservations } from "./shadow-admission";

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

/** Run real RTT preparation/clear callbacks; NullEngine still does not prove pixels. */
function prepareShadowLayers(generator: ShadowGenerator): void {
  const scene = generator.getLight().getScene();
  scene.incrementRenderId();
  const map = generator.getShadowMap()!;
  map.render();
}

function enableHeadlessCascades(scene: Scene): void {
  const engine = scene.getEngine();
  engine._features.supportCSM = true;
  engine._features.supportShadowSamplers = true;
  vi.spyOn(engine, "createDepthStencilTexture").mockImplementation((size, options) => {
    const texture = new InternalTexture(engine, InternalTextureSource.DepthStencil);
    const dimensions = typeof size === "number" ? { width: size, height: size } : size;
    texture.width = texture.baseWidth = dimensions.width;
    texture.height = texture.baseHeight = dimensions.height;
    texture.depth = texture.baseDepth = dimensions.layers ?? 0;
    texture.is2DArray = texture.depth > 0;
    texture.format = options.depthTextureFormat ?? 14;
    texture.isReady = true;
    engine.getLoadedTexturesCache().push(texture);
    return texture;
  });
}

describe("shared shadow lifecycle", () => {
  it("downsizes an oversized Ultra sun within conservative memory admission while retaining requested settings", () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    engine._features.supportCSM = true;
    // NullEngine supplies ordinary RTT color storage but has no depth-array GPU
    // implementation. Complete that I/O boundary while retaining the real CSM
    // constructor, admission, dimensions, native ownership and disposal.
    vi.spyOn(engine, "createDepthStencilTexture").mockImplementation((size, options) => {
      const texture = new InternalTexture(engine, InternalTextureSource.DepthStencil);
      const dimensions = typeof size === "number" ? { width: size, height: size } : size;
      texture.width = texture.baseWidth = dimensions.width;
      texture.height = texture.baseHeight = dimensions.height;
      texture.depth = texture.baseDepth = dimensions.layers ?? 0;
      texture.is2DArray = texture.depth > 0;
      texture.format = options.depthTextureFormat ?? 14;
      texture.isReady = true;
      engine.getLoadedTexturesCache().push(texture);
      return texture;
    });
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings(qualityPresetPatch("ultra").shadows) });
    const sun = new DirectionalLight("sun", Vector3.Down(), scene);
    controller.register(sun, true);
    controller.sync();
    expect(controller.generator(sun), JSON.stringify(controller.diagnostics())).not.toBeNull();
    expect(controller.diagnostics().find((entry) => entry.name === "sun")).toMatchObject({ status: "active", mapSize: 2048 });
    expect(controller.metrics().bytes).toBeLessThanOrEqual(384 * 1024 ** 2);
    expect(sceneRenderingSettings(scene).shadows).toMatchObject({ profile: "ultra", preset: "ultra", mapSize: 4096, cascades: 4, maxLocalLights: 8 });
  });
  it.each([
    {
      ownerSupport: true,
      latestSupport: false,
      reason: "Babylon constructor capability",
    },
    {
      ownerSupport: false,
      latestSupport: true,
      reason: "device capability",
    },
  ])(
    "keeps directional shadows when CSM is blocked by $reason across engines",
    ({ ownerSupport, latestSupport, reason }) => {
      const { scene, controller } = fixture();
      const owner = scene.getEngine();
      owner._features.supportCSM = ownerSupport;
      updateSceneRenderingSettings(scene, {
        shadows: normalizeShadowSettings({ mapSize: 512, cascades: 4 }),
      });
      const authored = structuredClone(sceneRenderingSettings(scene).shadows);
      const light = new DirectionalLight("sun", Vector3.Down(), scene);
      controller.register(light, true);
      const latest = new NullEngine();
      engines.push(latest);
      latest._features.supportCSM = latestSupport;

      controller.sync();
      const generator = controller.generator(light);
      expect(generator).not.toBeNull();
      expect(generator).not.toBeInstanceOf(CascadedShadowGenerator);
      expect(controller.status(light)).toBe("active");
      expect(controller.diagnostics()[0]).toMatchObject({
        passes: 1,
        mapSize: 512,
        allocationError: null,
        reason: `cascades: ${reason}; using single-map directional shadows`,
      });
      expect(controller.metrics()).toEqual({ bytes: 3 * 1024 ** 2, passes: 1 });
      const preview = new Scene(owner);
      expect(otherShadowReservations(preview)).toMatchObject({
        bytes: 3 * 1024 ** 2,
        passes: 1,
      });
      controller.sync();
      expect(controller.generator(light)).toBe(generator);
      expect(sceneRenderingSettings(scene).shadows).toEqual(authored);
      expect(owner._features.supportCSM).toBe(ownerSupport);
      expect(latest._features.supportCSM).toBe(latestSupport);
      prepareShadowLayers(generator!);
      expect(generator!.bias).toBeGreaterThan(authored.depthBias);
      expect(generator!.normalBias).toBe(authored.normalBias);
      expect(controller.effectiveBias(light)[0]).toMatchObject({
        mode: "directional-auto",
        depthBias: generator!.bias,
      });
      expect(sceneRenderingSettings(scene).shadows).toEqual(authored);
    },
  );

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
  it("adapts Low to admitted map dimensions and updates projection and allocation in the current draw", () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    engine.getCaps().maxTextureSize = 256;
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings(qualityPresetPatch("low").shadows),
    });
    const light = new DirectionalLight("sun", new Vector3(0, -1, 1), scene);
    controller.register(light, true);
    controller.sync();
    const generator = controller.generator(light)!;
    expect(generator.getShadowMap()!.getSize().width).toBe(256);
    expect(generator.usePoissonSampling).toBe(true);
    prepareShadowLayers(generator);
    expect(controller.effectiveBias(light)[0].worldTexelSize).toBeCloseTo(0.625, 8);
    expect(generator.bias).toBeCloseTo(0.0078125, 8);
    expect(generator.normalBias).toBe(0.005);
    expect(sceneRenderingSettings(scene).shadows.mapSize).toBe(1024);

    updateSceneRenderingSettings(scene, { shadows: { distance: 160 } });
    controller.sync();
    prepareShadowLayers(generator);
    expect(controller.effectiveBias(light)[0].worldTexelSize).toBeCloseTo(1.25, 8);
    // Poisson uses its effective radius, not requested PCF quality.
    generator.blurScale = 0.5;
    prepareShadowLayers(generator);
    expect(generator.bias).toBeCloseTo(0.001953125, 8);

    engine.getCaps().maxTextureSize = 4096;
    controller.sync();
    const recovered = controller.generator(light)!;
    expect(recovered).not.toBe(generator);
    expect(recovered.getShadowMap()!.getSize().width).toBe(1024);
    prepareShadowLayers(recovered);
    expect(controller.effectiveBias(light)[0].worldTexelSize).toBeCloseTo(0.3125, 8);
    expect(recovered.bias).toBeCloseTo(0.001953125, 8);
  });

  it("reads the replacement camera projection before deriving directional bias", () => {
    const { scene, controller } = fixture();
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ cascades: 1, distance: 10, mapSize: 512 }),
    });
    const light = new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    controller.register(light, true);
    controller.sync();
    const generator = controller.generator(light)!;
    prepareShadowLayers(generator);
    expect(controller.effectiveBias(light)[0].worldTexelSize).toBeCloseTo(20 / 512, 8);
    const replacement = new UniversalCamera("orthographic", new Vector3(4, 3, -8), scene);
    replacement.mode = 1;
    replacement.orthoLeft = -40;
    replacement.orthoRight = 40;
    replacement.orthoBottom = -20;
    replacement.orthoTop = 20;
    scene.activeCamera = replacement;
    controller.sync();
    prepareShadowLayers(generator);
    expect(controller.generator(light)).toBe(generator);
    expect(controller.effectiveBias(light)[0].worldTexelSize).toBeCloseTo(80 / 512, 8);
  });

  it("derives each cascade from its current extents and restores exact manual bias", () => {
    const { scene, controller } = fixture();
    enableHeadlessCascades(scene);
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({
        cascades: 2, distance: 40, mapSize: 1024, filterQuality: "low",
        depthBias: 0, normalBias: 0.001,
      }),
    });
    const caster = MeshBuilder.CreateBox("caster", { size: 5 }, scene);
    controller.setParticipation(caster, { castShadows: true, receiveShadows: true });
    const light = new DirectionalLight("sun", new Vector3(0.4, -1, 0.6), scene);
    controller.register(light, true);
    controller.sync();
    const generator = controller.generator(light) as CascadedShadowGenerator;
    expect(generator).toBeInstanceOf(CascadedShadowGenerator);
    prepareShadowLayers(generator);
    const effective = controller.effectiveBias(light).map((value) => ({ ...value }));
    expect(effective).toHaveLength(2);
    expect(effective[1].worldTexelSize).toBeGreaterThan(effective[0].worldTexelSize);
    for (let layer = 0; layer < 2; layer++) {
      const min = generator.getCascadeMinExtents(layer)!;
      const max = generator.getCascadeMaxExtents(layer)!;
      const texel = Math.max(max.x - min.x, max.y - min.y) / 1024;
      expect(effective[layer].worldTexelSize).toBeCloseTo(texel, 8);
      expect(effective[layer].depthBias).toBeCloseTo(Math.min(0.05, (texel / 2) / (max.z - min.z) / 1.5), 8);
      expect(effective[layer].normalBias).toBe(0.001);
    }
    scene.activeCamera!.position.x += 6;
    scene.activeCamera!.getViewMatrix(true);
    prepareShadowLayers(generator);
    expect(controller.effectiveBias(light)[0].worldTexelSize).toBeCloseTo(effective[0].worldTexelSize, 8);

    updateSceneRenderingSettings(scene, { shadows: { autoBias: false, depthBias: 0.002, normalBias: 0.025 } });
    controller.sync();
    prepareShadowLayers(generator);
    expect(generator.bias).toBe(0.002);
    expect(generator.normalBias).toBe(0.025);
    expect(controller.effectiveBias(light).map(({ mode, depthBias, normalBias }) => ({ mode, depthBias, normalBias })))
      .toEqual([{ mode: "manual", depthBias: 0.002, normalBias: 0.025 }, { mode: "manual", depthBias: 0.002, normalBias: 0.025 }]);
    expect(sceneRenderingSettings(scene).shadows).toMatchObject({ autoBias: false, depthBias: 0.002, normalBias: 0.025 });
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
  it("selects nearest shadows independently of intensity and honors explicit priority immediately", () => {
    const { scene, controller } = fixture();
    const a = new PointLight("a", Vector3.Zero(), scene);
    const b = new PointLight("b", new Vector3(20, 0, 0), scene);
    controller.register(a, true);
    controller.register(b, true);
    controller.sync();
    b.intensity = 1.05;
    controller.sync();
    expect(controller.generator(a)).not.toBeNull();
    b.intensity = 100;
    controller.sync();
    expect(controller.generator(a)).not.toBeNull();
    expect(controller.generator(b)).toBeNull();
    controller.register(b, true, 1);
    controller.sync();
    expect(controller.generator(a)).toBeNull();
    expect(controller.generator(b)).not.toBeNull();
  });
  it("follows a replacement active camera and preserves deterministic distance hysteresis", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
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
    clock.mockReturnValue(100);
    controller.sync();
    expect(controller.generator(b)).toBe(incumbent);
    scene.activeCamera.position.x = 0;
    controller.sync();
    expect(controller.generator(b)).toBe(incumbent);
    clock.mockReturnValue(300);
    controller.sync();
    expect(controller.generator(a)).not.toBeNull();
    } finally { clock.mockRestore(); }
  });

  it("keeps newly selected maps resident across motion but releases ineligible owners immediately", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const { scene, controller } = fixture();
      const a = new PointLight("start", Vector3.Zero(), scene);
      const b = new PointLight("destination", new Vector3(100, 0, 0), scene);
      controller.register(a, true);
      controller.register(b, true);
      controller.sync();
      const original = controller.generator(a);
      expect(original).not.toBeNull();
      scene.activeCamera!.position.x = 100;
      clock.mockReturnValue(100);
      controller.sync();
      expect(controller.generator(a)).toBe(original);
      clock.mockReturnValue(300);
      controller.sync();
      const promoted = controller.generator(b);
      expect(promoted).not.toBeNull();
      expect(controller.generator(a)).toBeNull();
      scene.activeCamera!.position.x = 0;
      clock.mockReturnValue(350);
      controller.sync();
      expect(controller.generator(b)).toBe(promoted);
      b.intensity = 0;
      controller.sync();
      expect(controller.generator(b)).toBeNull();
      expect(controller.generator(a)).not.toBeNull();
    } finally { clock.mockRestore(); }
  });

  it("refreshes parented and detached light positions before shadow selection", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const { scene, controller } = fixture();
      scene.activeCamera!.position.set(0, 0, 0);
      const parent = new TransformNode("parent", scene);
      parent.position.x = -200;
      const a = new PointLight("parented", new Vector3(100, 0, 0), scene);
      a.parent = parent;
      const b = new PointLight("other", new Vector3(50, 0, 0), scene);
      controller.register(a, true);
      controller.register(b, true);
      controller.sync();
      expect(controller.generator(a)).toBeNull();
      expect(controller.generator(b)).not.toBeNull();
      parent.position.x = -90;
      clock.mockReturnValue(300);
      controller.sync();
      expect(controller.generator(a)).not.toBeNull();
      expect(controller.generator(b)).toBeNull();
      a.parent = null;
      clock.mockReturnValue(600);
      controller.sync();
      expect(controller.generator(a)).toBeNull();
      expect(controller.generator(b)).not.toBeNull();
    } finally { clock.mockRestore(); }
  });

  it("promotes a nearer sub-unit light after residency expires", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const { scene, controller } = fixture();
      scene.activeCamera!.position.set(0, 0, 0);
      const a = new PointLight("incumbent", new Vector3(0.9, 0, 0), scene);
      const b = new PointLight("nearer", new Vector3(0.1, 0, 0), scene);
      controller.register(a, true);
      controller.sync();
      const initial = controller.generator(a);
      controller.register(b, true);
      clock.mockReturnValue(100);
      controller.sync();
      expect(controller.generator(a)).toBe(initial);
      clock.mockReturnValue(300);
      controller.sync();
      expect(controller.generator(a)).toBeNull();
      expect(controller.generator(b)).not.toBeNull();
    } finally { clock.mockRestore(); }
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
  it("releases a non-throwing WebGL allocation failure and retains the validated smaller cube", () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    const authored = structuredClone(sceneRenderingSettings(scene).shadows);
    const light = new PointLight("point", Vector3.Zero(), scene);
    controller.register(light, true);
    const errors: number[] = [];
    const framebuffers = new Set<unknown>();
    const textures = new Set<unknown>();
    const renderbuffers = new Set<unknown>();
    const previousFramebuffer = {};
    let framebuffer: unknown = previousFramebuffer;
    const gl = {
      NO_ERROR: 0,
      OUT_OF_MEMORY: 0x0505,
      CONTEXT_LOST_WEBGL: 0x9242,
      FRAMEBUFFER: 0x8d40,
      FRAMEBUFFER_BINDING: 0x8ca6,
      FRAMEBUFFER_COMPLETE: 0x8cd5,
      COLOR_ATTACHMENT0: 0x8ce0,
      DEPTH_ATTACHMENT: 0x8d00,
      DEPTH_STENCIL_ATTACHMENT: 0x821a,
      RENDERBUFFER: 0x8d41,
      TEXTURE_2D: 0x0de1,
      TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515,
      getError: vi.fn(() => errors.shift() ?? 0),
      isContextLost: () => false,
      isTexture: (resource: unknown) => textures.has(resource),
      isFramebuffer: (resource: unknown) => framebuffers.has(resource),
      isRenderbuffer: (resource: unknown) => renderbuffers.has(resource),
      getParameter: () => framebuffer,
      createFramebuffer: () => ({}),
      deleteFramebuffer: vi.fn(),
      bindFramebuffer: (_target: number, resource: unknown) => {
        framebuffer = resource;
      },
      framebufferTexture2D: vi.fn(),
      framebufferRenderbuffer: vi.fn(),
      checkFramebufferStatus: () => 0x8cd5,
    };
    const engineGl = Object.getOwnPropertyDescriptor(engine, "_gl");
    Object.defineProperty(engine, "_gl", { configurable: true, value: gl });
    const allocate = engine.createRenderTargetCubeTexture.bind(engine);
    let rejectedDispose: ReturnType<typeof vi.spyOn> | undefined;
    const allocation = vi
      .spyOn(engine, "createRenderTargetCubeTexture")
      .mockImplementation((...args) => {
        const target = allocate(...args);
        const targetFramebuffer = {};
        const depth = {};
        Object.assign(target, {
          _framebuffer: targetFramebuffer,
          _depthStencilBuffer: depth,
        });
        framebuffers.add(targetFramebuffer);
        renderbuffers.add(depth);
        textures.add(target.texture!._hardwareTexture!.underlyingResource);
        if (!rejectedDispose) {
          rejectedDispose = vi.spyOn(target.texture!, "dispose");
          // Babylon still returns a ready InternalTexture when the driver reports
          // OOM through its error flag instead of throwing from texImage2D.
          errors.push(gl.OUT_OF_MEMORY);
        }
        return target;
      });
    try {
      controller.sync();
      const retained = controller.generator(light);
      expect(retained?.getShadowMap()?.getRenderSize()).toBe(512);
      expect(allocation.mock.calls.map(([size]) => size)).toEqual([1024, 512]);
      expect(rejectedDispose).toHaveBeenCalledTimes(1);
      expect(controller.diagnostics()[0]).toMatchObject({
        status: "active",
        allocationError: "Shadow allocation WebGL errors: 0x505",
      });
      expect(controller.metrics()).toEqual({ bytes: 18 * 1024 ** 2, passes: 6 });
      expect(sceneRenderingSettings(scene).shadows).toEqual(authored);
      expect(framebuffer).toBe(previousFramebuffer);
      const errorReads = gl.getError.mock.calls.length;
      controller.sync();
      expect(controller.generator(light)).toBe(retained);
      expect(allocation).toHaveBeenCalledTimes(2);
      expect(gl.getError).toHaveBeenCalledTimes(errorReads);
    } finally {
      if (engineGl) Object.defineProperty(engine, "_gl", engineGl);
      else Reflect.deleteProperty(engine, "_gl");
    }
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
