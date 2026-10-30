import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CascadedShadowGenerator,
  InternalTexture,
  DirectionalLight,
  HemisphericLight,
  MeshBuilder,
  MaterialDefines,
  NullEngine,
  PointLight,
  SpotLight,
  RenderTargetTexture,
  Scene,
  ShadowDepthWrapper,
  ShadowGenerator,
  StandardMaterial,
  UniversalCamera,
  TransformNode,
  Vector3,
  type Effect,
} from "@babylonjs/core";
import { sceneShadowController } from "./shadow-controller";
import { isForwardLightExcluded, syncForwardLightPolicy } from "./light-policy";
import { selectHapticLights } from "./haptic-lights";
import { awaitsFirstDraw } from "./shadow-first-draw";
import { NEUTRAL_DARKNESS } from "./shadow-map-factory";
import {
  sceneRenderingSettings,
  updateSceneRenderingSettings,
} from "./render-settings";
import { normalizeShadowSettings, normalizeWaterBody, qualityPresetPatch, SHADOW_CAPACITY_PROFILES } from "@haptic/core";
import { ENGINE_SHADOW_BUDGET } from "./shadow-admission";
import { managedRenderReservations } from "./managed-render-resources";
import { unsupportedManagedShadows } from "./framegraph-managed-shadows";
import { createColliderVisualMesh } from "./collider-visual";
import { createWaterMesh } from "./water-mesh";
import { ShadowAtlasAllocator } from "./shadow-atlas-allocator";
import { AtlasCascadedShadowGenerator, AtlasShadowGenerator, isAtlasShadow, shadowAtlasBytes, shadowAtlasTexture } from "./shadow-atlas";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});
/** `beforeController` runs on the bare Scene, before anything observes its meshes. */
function fixture(beforeController?: (scene: Scene) => void) {
  const engine = new NullEngine();
  engines.push(engine);
  Object.assign(engine.getCaps(), {
    maxTexturesImageUnits: 16,
    maxTextureSize: 4096,
    maxCubemapTextureSize: 4096,
    textureHalfFloatRender: true,
    textureHalfFloatLinearFiltering: true,
  });
  // Every shipped Engine (WebGL2, WebGPU) draws cascades with hardware depth comparison: the sun's atlas map is one.
  engine._features.supportCSM = true;
  engine._features.supportShadowSamplers = true;
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
  beforeController?.(scene);
  return { scene, controller: sceneShadowController(scene) };
}

/** Run real RTT preparation/clear callbacks; NullEngine still does not prove pixels. */
function prepareShadowLayers(generator: ShadowGenerator): void {
  const scene = generator.getLight().getScene();
  scene.incrementRenderId();
  // Scene._renderForCamera prepares the receiver's projection before RTTs.
  // Native CSM consumes that cached matrix during its before-bind callback.
  scene.updateTransformMatrix(true);
  const map = generator.getShadowMap()!;
  map.render();
}

/** An atlas map's tile sizes, one per cascade or face. */
const tileSizes = (generator: unknown) => (generator as AtlasCascadedShadowGenerator | AtlasShadowGenerator).tiles.map((tile) => tile.size);

/** A cascade's world texel in a `size`-texel tile: the larger side of its light-space box over the tile. */
function cascadeTexel(generator: CascadedShadowGenerator, layer: number, size: number): number {
  const min = generator.getCascadeMinExtents(layer)!;
  const max = generator.getCascadeMaxExtents(layer)!;
  return Math.max(max.x - min.x, max.y - min.y) / size;
}

/** The automatic depth bias of a cascade: a quarter texel over its depth range, for depth-clamped PCF. */
function cascadeDepthBias(generator: CascadedShadowGenerator, layer: number, size: number, authored: number): number {
  const depth = generator.getCascadeMaxExtents(layer)!.z - generator.getCascadeMinExtents(layer)!.z;
  return Math.max(authored, Math.min(0.05, cascadeTexel(generator, layer, size) / 4 / depth / 1.5));
}

describe("shared shadow lifecycle", () => {
  it("draws the sun's cascades as tiles of the light block's atlas, built with the level's cascade count", () => {
    const { scene, controller } = fixture();
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades: 3, maxLocalLights: 1 }) });
    const sun = new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    controller.register(sun, true);
    controller.sync();
    const generator = sun.getShadowGenerator() as AtlasCascadedShadowGenerator;
    expect(generator).toBeInstanceOf(AtlasCascadedShadowGenerator);
    expect(generator.numCascades).toBe(3);
    // Medium's three 2048 cascades in its 4096 atlas.
    expect(generator.tiles.map((tile) => tile.size)).toEqual([2048, 2048, 2048]);
    expect(controller.metrics().bytes).toBe(shadowAtlasBytes(scene));
    // One cascade, which Babylon's own count could not be.
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 1 }) });
    controller.sync();
    const single = sun.getShadowGenerator() as AtlasCascadedShadowGenerator;
    expect(single).not.toBe(generator);
    expect([single.numCascades, single.tiles.length]).toEqual([1, 1]);
  });

  it("draws a point light's shadow as six face tiles of the light block's atlas, filtered with PCF", () => {
    const { scene, controller } = fixture();
    const lamp = new PointLight("lamp", new Vector3(0, 2, 0), scene);
    controller.register(lamp, true);
    controller.sync();
    const generator = lamp.getShadowGenerator() as AtlasShadowGenerator;
    expect(generator).toBeInstanceOf(AtlasShadowGenerator);
    // Medium's 1024 local maps, one per face.
    expect(generator.tiles.map((tile) => tile.size)).toEqual([1024, 1024, 1024, 1024, 1024, 1024]);
    expect(generator.usePercentageCloserFiltering).toBe(true);
    expect(controller.diagnostics()[0]?.passes).toBe(6);
  });

    it("draws spot maps as tiles of the light block's atlas, rebuilt for another atlas edge and released with the last", () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    Object.assign(engine.getCaps(), { maxTextureSize: 8192 });
    const spot = new SpotLight("spot", new Vector3(0, 4, 0), Vector3.Down(), 1, 2, scene);
    controller.register(spot, true);
    controller.sync();
    const medium = spot.getShadowGenerator();
    expect(medium).toBeInstanceOf(AtlasShadowGenerator);
    expect(shadowAtlasTexture(scene).getRenderSize()).toBe(4096);
    expect(controller.metrics().bytes).toBe(shadowAtlasBytes(scene));
    // High's byte budget holds an atlas of 8192: the map is rebuilt in it.
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ profile: "high", cascades: 1, maxLocalLights: 1 }) });
    controller.sync();
    const high = spot.getShadowGenerator() as AtlasShadowGenerator;
    expect(high).toBeInstanceOf(AtlasShadowGenerator);
    expect(high).not.toBe(medium);
    expect(shadowAtlasTexture(scene).getRenderSize()).toBe(8192);
    expect(high.tile.size).toBe(2048);
    // With the last map the atlas goes.
    controller.register(spot, false);
    controller.sync();
    expect(shadowAtlasBytes(scene)).toBe(0);
    expect(shadowAtlasTexture(scene).getRenderSize()).toBe(1);
  });
  it("excludes collider display segments without excluding authored meshes below the collider", () => {
    const { scene, controller } = fixture();
    const sun = new DirectionalLight("sun", new Vector3(0.35, -1, 0.2), scene);
    const collider = createColliderVisualMesh(scene, "mannequin-collider", {
      kind: "capsule", radius: 0.5, halfHeight: 1,
    });
    const dashes = collider.getChildMeshes();
    const model = MeshBuilder.CreateBox("authored-child", {}, scene);
    model.parent = collider;
    controller.setParticipation(collider, { castShadows: true, receiveShadows: true });
    controller.register(sun, true);
    controller.sync();
    const generator = controller.generator(sun)!;
    expect(dashes.length).toBeGreaterThan(0);
    expect(generator.getShadowMap()!.renderList).toContain(model);
    expect(dashes.filter(dash => generator.getShadowMap()!.renderList!.includes(dash))).toEqual([]);
    // Showing/hiding selection helpers must not recreate a map or drop the model.
    for (const visible of [false, true]) {
      for (const dash of dashes) dash.setEnabled(visible);
      controller.sync();
      expect(controller.generator(sun)).toBe(generator);
      expect(generator.getShadowMap()!.renderList).toContain(model);
      expect(dashes.some(dash => generator.getShadowMap()!.renderList!.includes(dash))).toBe(false);
    }
  });
  it("admits the Ultra sun at its requested 4096 within the Ultra memory budget", () => {
    const { scene, controller } = fixture();
    // A desktop texture limit: Ultra's byte budget holds an 8192 atlas, which its four 4096 cascades fill.
    Object.assign(scene.getEngine().getCaps(), { maxTextureSize: 16384 });
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings(qualityPresetPatch("ultra").shadows) });
    const sun = new DirectionalLight("sun", Vector3.Down(), scene);
    controller.register(sun, true);
    controller.sync();
    expect(controller.generator(sun), JSON.stringify(controller.diagnostics())).not.toBeNull();
    expect(controller.diagnostics().find((entry) => entry.name === "sun")).toMatchObject({ status: "active", mapSize: 4096, reason: null });
    expect(tileSizes(controller.generator(sun))).toEqual([4096, 4096, 4096, 4096]);
    expect(controller.metrics().bytes).toBe(8192 ** 2 * 4);
    expect(controller.metrics().bytes).toBeLessThanOrEqual(SHADOW_CAPACITY_PROFILES.ultra.byteBudget);
    expect(sceneRenderingSettings(scene).shadows).toMatchObject({ profile: "ultra", preset: "ultra", mapSize: 4096, cascades: 4, maxLocalLights: 8 });
  });
  // The sun, admitted first, leaves the atlas room for the planned point light's six faces at the level's local size:
  // Medium's 4096 atlas keeps 10.5 M texels for its three cascades (1024), High's 8192 atlas 41.9 M for four 2048
  // cascades, and Ultra's 8192 atlas too little for four 4096 ones (2048).
  it.each([
    ["medium", 1024],
    ["high", 2048],
    ["ultra", 2048],
  ] as const)("admits the %s sun beside a local shadow light at the largest cascades the atlas holds after the light's faces (%i)", (level, mapSize) => {
    const { scene, controller } = fixture();
    Object.assign(scene.getEngine().getCaps(), { maxTextureSize: 16384 });
    const shadows = normalizeShadowSettings(qualityPresetPatch(level).shadows);
    updateSceneRenderingSettings(scene, { shadows });
    const sun = new DirectionalLight("sun", Vector3.Down(), scene);
    controller.register(sun, true);
    controller.register(new PointLight("point", Vector3.Zero(), scene), true);
    controller.sync();
    expect(controller.diagnostics().find((entry) => entry.name === "sun")).toMatchObject({
      status: "active",
      mapSize,
      reason: mapSize < shadows.mapSize ? "shadow map reduced by shadow atlas space" : null,
    });
    expect(tileSizes(controller.generator(sun))).toEqual(Array(shadows.cascades).fill(mapSize));
    expect(controller.diagnostics().find((entry) => entry.name === "point")).toMatchObject({
      status: "active", mapSize: shadows.localMapSize, reason: null,
    });
  });
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
  it("registers meshes created in the same task as the frame, before Babylon's deferred notification", async () => {
    const { scene, controller } = fixture();
    const light = new DirectionalLight("sun", new Vector3(0, -1, 1), scene);
    controller.register(light, true);
    const replaced = MeshBuilder.CreateBox("replaced", {}, scene);
    controller.sync();
    // A replacement keeps scene.meshes the same length; both frames run synchronously.
    replaced.dispose();
    const mesh = MeshBuilder.CreateBox("spawned", {}, scene);
    controller.sync();
    const casters = () =>
      (controller.generator(light)?.getShadowMap()?.renderList ?? []).map((caster) => caster.name);
    expect(casters()).toEqual(["spawned"]);
    expect(mesh.receiveShadows).toBe(true);
    const sibling = MeshBuilder.CreateBox("sibling", {}, scene);
    controller.sync();
    expect(casters()).toEqual(["spawned", "sibling"]);
    // The late notification must not duplicate or reorder an existing caster.
    await new Promise<void>((resolve) =>
      scene.onNewMeshAddedObservable.add((added) => {
        if (added === sibling) resolve();
      }),
    );
    controller.sync();
    expect(casters()).toEqual(["spawned", "sibling"]);
  });
  it("lets a removal win over Babylon's deferred add, and registers a mesh that returns to the Scene", async () => {
    const { scene, controller } = fixture();
    const light = new DirectionalLight("sun", new Vector3(0, -1, 1), scene);
    controller.register(light, true);
    controller.sync();
    const casters = () => controller.generator(light)?.getShadowMap()?.renderList ?? [];
    const added = (target: ReturnType<typeof MeshBuilder.CreateBox>) =>
      new Promise<void>((resolve) =>
        scene.onNewMeshAddedObservable.add((mesh) => {
          if (mesh === target) resolve();
        }),
      );
    // Leaves the Scene (still alive) before the add notification arrives.
    const proxy = MeshBuilder.CreateBox("proxy", {}, scene);
    const proxyAdded = added(proxy);
    scene.removeMesh(proxy);
    await proxyAdded;
    controller.sync();
    expect(casters()).not.toContain(proxy);
    // Returning to the Scene registers it again.
    const returned = added(proxy);
    scene.addMesh(proxy);
    await returned;
    controller.sync();
    expect(casters()).toContain(proxy);
    scene.removeMesh(proxy);
    expect(casters()).not.toContain(proxy);
    const again = added(proxy);
    scene.addMesh(proxy);
    await again;
    controller.sync();
    expect(casters()).toContain(proxy);
  });
  it("does not queue a mesh that left the Scene before the controller existed when Babylon's deferred add arrives", async () => {
    // A mesh a Babylon helper creates and removes at once, before the controller exists.
    let proxy!: ReturnType<typeof MeshBuilder.CreateBox>;
    const { scene, controller } = fixture((bare) => {
      proxy = MeshBuilder.CreateBox("proxy", {}, bare);
      bare.removeMesh(proxy);
    });
    const light = new DirectionalLight("sun", new Vector3(0, -1, 1), scene);
    controller.register(light, true);
    const added = (target: ReturnType<typeof MeshBuilder.CreateBox>) =>
      new Promise<void>((resolve) =>
        scene.onNewMeshAddedObservable.add((mesh) => {
          if (mesh === target) resolve();
        }),
      );
    // A mesh the controller does hear about while the older notice is still pending.
    const receiver = MeshBuilder.CreateBox("receiver", {}, scene);
    await Promise.all([added(proxy), added(receiver)]);
    controller.sync();
    const casters = (controller.generator(light)?.getShadowMap()?.renderList ?? []).map(
      (caster) => caster.name,
    );
    expect(casters).toEqual(["receiver"]);
  });
  it("adapts Low to admitted tile dimensions and updates projection and allocation in the current draw", () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    engine.getCaps().maxTextureSize = 256;
    // The Low tier with one 1024 cascade over 80 m.
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ ...qualityPresetPatch("low").shadows, preset: "custom", distance: 80, mapSize: 1024, cascades: 1 }),
    });
    const authored = structuredClone(sceneRenderingSettings(scene).shadows);
    const light = new DirectionalLight("sun", new Vector3(0, -1, 1), scene);
    controller.register(light, true);
    controller.sync();
    const generator = controller.generator(light) as CascadedShadowGenerator;
    // The texture limit bounds the atlas, and its one tile with it.
    expect(tileSizes(generator)).toEqual([256]);
    expect(controller.diagnostics([light])[0]).toMatchObject({ mapSize: 256, effectiveFilter: "pcf" });
    prepareShadowLayers(generator);
    const near = cascadeTexel(generator, 0, 256);
    expect(controller.effectiveBias(light)[0].worldTexelSize).toBeCloseTo(near, 7);
    expect(generator.bias).toBeGreaterThan(authored.depthBias);
    expect(generator.bias).toBeCloseTo(cascadeDepthBias(generator, 0, 256, authored.depthBias), 8);
    expect(generator.normalBias).toBe(0.005);
    expect(sceneRenderingSettings(scene).shadows.mapSize).toBe(1024);

    // A longer shadow distance refits the same tile over more of the world in the next draw.
    updateSceneRenderingSettings(scene, {
      shadows: { ...sceneRenderingSettings(scene).shadows, distance: 160 },
    });
    controller.sync();
    prepareShadowLayers(generator);
    expect(controller.generator(light)).toBe(generator);
    const far = cascadeTexel(generator, 0, 256);
    expect(far).toBeGreaterThan(near);
    expect(controller.effectiveBias(light)[0].worldTexelSize).toBeCloseTo(far, 7);
    expect(generator.bias).toBeCloseTo(cascadeDepthBias(generator, 0, 256, authored.depthBias), 8);

    // A restored context with a larger texture limit rebuilds the map at its requested size.
    engine.getCaps().maxTextureSize = 4096;
    engine.onContextRestoredObservable.notifyObservers(engine);
    controller.sync();
    const recovered = controller.generator(light) as CascadedShadowGenerator;
    expect(recovered).not.toBe(generator);
    expect(tileSizes(recovered)).toEqual([1024]);
    prepareShadowLayers(recovered);
    expect(controller.effectiveBias(light)[0].worldTexelSize).toBeCloseTo(cascadeTexel(recovered, 0, 1024), 7);
    expect(recovered.bias).toBeCloseTo(cascadeDepthBias(recovered, 0, 1024, authored.depthBias), 8);
  });

  it("reads the replacement camera projection before deriving directional bias", () => {
    const { scene, controller } = fixture();
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ cascades: 1, distance: 10, mapSize: 512 }),
    });
    const light = new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    controller.register(light, true);
    controller.sync();
    const generator = controller.generator(light) as CascadedShadowGenerator;
    prepareShadowLayers(generator);
    const perspective = cascadeTexel(generator, 0, 512);
    expect(controller.effectiveBias(light)[0].worldTexelSize).toBeCloseTo(perspective, 7);
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
    // The cascade fits the replacement's 80-unit-wide view, not the perspective camera's.
    const orthographic = cascadeTexel(generator, 0, 512);
    expect(orthographic).not.toBeCloseTo(perspective, 3);
    expect(controller.effectiveBias(light)[0].worldTexelSize).toBeCloseTo(orthographic, 7);
  });

  it("derives each cascade from its current extents and restores exact manual bias", () => {
    const { scene, controller } = fixture();
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
    expect(generator.getShadowMap()!.is2DArray).toBe(true);
    expect(generator.getShadowMap()!.getRenderLayers()).toBe(2);
    prepareShadowLayers(generator);
    const effective = controller.effectiveBias(light).map((value) => ({ ...value }));
    expect(effective).toHaveLength(2);
    expect(effective[1].worldTexelSize).toBeGreaterThan(effective[0].worldTexelSize);
    for (let layer = 0; layer < 2; layer++) {
      const min = generator.getCascadeMinExtents(layer)!;
      const max = generator.getCascadeMaxExtents(layer)!;
      const texel = Math.max(max.x - min.x, max.y - min.y) / 1024;
      expect(effective[layer].worldTexelSize).toBeCloseTo(texel, 7);
      expect(effective[layer].depthBias).toBeCloseTo(Math.min(0.05, (texel / 4) / (max.z - min.z) / 1.5), 8);
      expect(effective[layer].normalBias).toBe(0.001);
    }
    scene.activeCamera!.position.x += 6;
    scene.activeCamera!.getViewMatrix(true);
    prepareShadowLayers(generator);
    expect(controller.effectiveBias(light)[0].worldTexelSize).toBeCloseTo(effective[0].worldTexelSize, 7);

    updateSceneRenderingSettings(scene, {
      shadows: {
        ...sceneRenderingSettings(scene).shadows,
        autoBias: false,
        depthBias: 0.002,
        normalBias: 0.025,
      },
    });
    controller.sync();
    prepareShadowLayers(generator);
    expect(generator.bias).toBe(0.002);
    expect(generator.normalBias).toBe(0.025);
    expect(controller.effectiveBias(light).map(({ mode, depthBias, normalBias }) => ({ mode, depthBias, normalBias })))
      .toEqual([{ mode: "manual", depthBias: 0.002, normalBias: 0.025 }, { mode: "manual", depthBias: 0.002, normalBias: 0.025 }]);
    expect(sceneRenderingSettings(scene).shadows).toMatchObject({ autoBias: false, depthBias: 0.002, normalBias: 0.025 });
  });
  it("selects receiver correction only for automatic directional PCF and invalidates mode changes once", () => {
    const { scene, controller } = fixture();
    scene.getEngine()._features.supportShadowSamplers = true;
    const sun = new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    const spot = new SpotLight("spot", new Vector3(0, 4, 0), Vector3.Down(), 1, 1, scene);
    controller.register(sun, true);
    controller.register(spot, true);
    controller.sync();
    const directional = controller.generator(sun)!;
    const local = controller.generator(spot)!;
    const defines = () => {
      const result = new MaterialDefines() as MaterialDefines & Record<string, unknown>;
      directional.prepareDefines(result, 0);
      local.prepareDefines(result, 1);
      return result;
    };
    expect(defines()).toMatchObject({ SLATE_SHADOW_AUTO0: true, SLATE_SHADOW_AUTO1: false });
    const dirty = vi.spyOn(scene, "markAllMaterialsAsDirty");
    updateSceneRenderingSettings(scene, { shadows: { ...sceneRenderingSettings(scene).shadows, autoBias: false } });
    controller.sync();
    expect(defines()).toMatchObject({ SLATE_SHADOW_AUTO0: false, SLATE_SHADOW_AUTO1: false });
    expect(dirty).toHaveBeenCalled();
    const count = dirty.mock.calls.length;
    controller.sync();
    expect(dirty).toHaveBeenCalledTimes(count);
    expect(controller.generator(sun)).toBe(directional);
    expect(controller.generator(spot)).toBe(local);
  });
  // The define text is the Effect cache key: a leftover per-slot define with the
  // same shader source would link the same program again for a toggled light.
  it.each([
    {
      name: "a hemispheric fill takes the slot",
      slot: 0,
      lights: (scene: Scene) => ({
        sun: new DirectionalLight("sun", new Vector3(0.4, -1, 0.6), scene),
        other: new HemisphericLight("fill", Vector3.Up(), scene),
      }),
    },
    {
      name: "the slot falls beyond the light count",
      slot: 1,
      lights: (scene: Scene) => ({
        other: new HemisphericLight("fill", Vector3.Up(), scene),
        sun: new DirectionalLight("sun", new Vector3(0.4, -1, 0.6), scene),
      }),
    },
    {
      name: "a shadowed spot without cascades takes the slot",
      slot: 0,
      lights: (scene: Scene) => ({
        sun: new DirectionalLight("sun", new Vector3(0.4, -1, 0.6), scene),
        other: new SpotLight("spot", new Vector3(0, 4, 0), Vector3.Down(), 1, 1, scene),
      }),
    },
  ])("gives a receiver the defines of a fresh one after the cascaded sun leaves its slot: $name", ({ slot, lights }) => {
    const { scene, controller } = fixture();
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ cascades: 2, distance: 40, mapSize: 1024, filterQuality: "low" }),
    });
    const addReceiver = (name: string) => {
      const mesh = MeshBuilder.CreateBox(name, {}, scene);
      mesh.material = new StandardMaterial(name, scene);
      controller.setParticipation(mesh, { castShadows: true, receiveShadows: true });
      controller.sync();
      return {
        mesh,
        defines: () => {
          // A ready receiver answers from its cache within one render.
          scene.incrementRenderId();
          mesh.material!.isReadyForSubMesh(mesh, mesh.subMeshes[0]!);
          return mesh.subMeshes[0]!.materialDefines!.toString();
        },
      };
    };
    const { sun, other } = lights(scene);
    controller.register(sun, true);
    controller.register(other, true);
    controller.sync();
    const receiver = addReceiver("receiver");
    const cascaded = receiver.defines();
    expect(cascaded).toContain(`#define SLATE_SHADOW_AUTO${slot}\n`);
    expect(cascaded).toContain(`#define SLATE_SHADOW_FADE${slot} `);

    sun.setEnabled(false);
    controller.sync();
    receiver.mesh._markSubMeshesAsLightDirty();
    const toggled = receiver.defines();
    expect(toggled).not.toContain(`SLATE_SHADOW_AUTO${slot}`);
    expect(toggled).not.toContain(`SLATE_SHADOW_FADE${slot}`);
    expect(toggled).toBe(addReceiver("fresh").defines());
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
  it("keeps water out of shadow maps even when authored to cast, while it still receives shadows", () => {
    const { scene, controller } = fixture();
    const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.2), scene);
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 10, length: 10, resolution: 8 }));
    const rock = MeshBuilder.CreateBox("rock", {}, scene);
    for (const mesh of [lake, rock]) controller.setParticipation(mesh, { castShadows: true, receiveShadows: true });
    controller.register(sun, true);
    controller.sync();
    const casters = controller.generator(sun)!.getShadowMap()!.renderList!;
    expect(casters).toContain(rock);
    expect(casters).not.toContain(lake);
    expect(lake.receiveShadows).toBe(true);
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

  it(
    "keeps the retained sun's caster bounds and limits current across a local handoff",
    () => {
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      try {
        const { scene, controller } = fixture();
        // The sun's requested map exceeds the device size, so admission reduces it.
        scene.getEngine().getCaps().maxTextureSize = 1024;
        updateSceneRenderingSettings(scene, {
          shadows: normalizeShadowSettings({ cascades: 2, mapSize: 2048, localMapSize: 256, maxLocalLights: 1 }),
        });
        const caster = MeshBuilder.CreateBox("caster", {}, scene);
        caster.material = new StandardMaterial("receiver", scene);
        controller.setParticipation(caster, { castShadows: true, receiveShadows: true });
        const sun = new DirectionalLight("sun", new Vector3(0.4, -1, 0.6), scene);
        const near = new SpotLight("near", new Vector3(0, 3, -2), Vector3.Down(), Math.PI / 2, 1, scene);
        const far = new SpotLight("far", new Vector3(40, 3, -2), Vector3.Down(), Math.PI / 2, 1, scene);
        near.range = far.range = 100;
        for (const light of [sun, near, far]) controller.register(light, true);
        controller.sync();
        const generator = controller.generator(sun)!;
        const local = controller.generator(near)!;
        expect(generator).toBeInstanceOf(AtlasCascadedShadowGenerator);
        const sunReason = controller.diagnostics([sun])[0]!.reason;
        expect(sunReason).toContain("shadow map reduced");
        scene.activeCamera!.position.x = 40;
        caster.position.x = 60;
        caster.computeWorldMatrix(true);
        clock.mockReturnValue(500);
        controller.sync();
        // The local map moves in the same sync; the retained sun keeps its own limits.
        expect(controller.generator(far)).toBe(local);
        expect(controller.generator(near)).toBeNull();
        expect(controller.generator(sun)).toBe(generator);
        expect(controller.diagnostics([sun, far]).map(({ status, reason }) => ({ status, reason })))
          .toEqual([{ status: "active", reason: sunReason }, { status: "active", reason: null }]);
        expect((generator as CascadedShadowGenerator).shadowCastersBoundingInfo.maximum.x).toBeGreaterThan(60);
      } finally { clock.mockRestore(); }
    },
  );

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
  it("moves a local map to a nearer same-kind light without allocation or receiver changes", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const { scene, controller } = fixture();
      scene.activeCamera!.position.set(0, 0, 0);
      const receiver = MeshBuilder.CreateBox("receiver", {}, scene);
      receiver.material = new StandardMaterial("receiver", scene);
      controller.setParticipation(receiver, { castShadows: true, receiveShadows: true });
      const near = new PointLight("near", new Vector3(5, 0, 0), scene);
      const far = new PointLight("far", new Vector3(50, 0, 0), scene);
      controller.register(near, true);
      controller.register(far, true);
      controller.sync();
      const generator = controller.generator(near)!;
      const part = receiver.subMeshes[0]!;
      receiver.material.isReadyForSubMesh(receiver, part);
      const defines = part.materialDefines!.toString();
      expect(defines).toContain("SHADOW0");
      // A new map would place atlas tiles.
      const allocate = vi.spyOn(ShadowAtlasAllocator.prototype, "allocate");
      const dispose = vi.spyOn(generator, "dispose");
      const dirty = vi.spyOn(receiver, "_markSubMeshesAsLightDirty");
      scene.activeCamera!.position.x = 50;
      clock.mockReturnValue(300);
      controller.sync();
      expect(controller.generator(far)).toBe(generator);
      expect(controller.generator(near)).toBeNull();
      expect(near.getShadowGenerator()).toBeNull();
      expect(allocate).not.toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();
      expect(dirty).not.toHaveBeenCalled();
      // Re-preparing proves the exchanged shader light indices keep every define.
      receiver._markSubMeshesAsLightDirty();
      receiver.material.isReadyForSubMesh(receiver, part);
      expect(part.materialDefines!.toString()).toBe(defines);
      // The moved map samples neutrally until it has redrawn for its new light.
      expect(generator.getDarkness()).toBe(1);
      prepareShadowLayers(generator);
      expect(generator.getDarkness()).toBe(0);
    } finally { clock.mockRestore(); }
  });

  it("keeps a camera-rejected local map on standby, unrendered, for the next same-kind light", async () => {
    const { scene, controller } = fixture();
    scene.activeCamera!.position.set(0, 0, 0);
    const receiver = MeshBuilder.CreateBox("receiver", {}, scene);
    receiver.material = new StandardMaterial("receiver", scene);
    controller.setParticipation(receiver, { castShadows: true, receiveShadows: true });
    // An observed caster cannot be cached, so admitted local maps redraw every frame.
    receiver.onBeforeRenderObservable.add(() => {});
    const first = new PointLight("first", new Vector3(5, 0, 0), scene);
    first.range = 10;
    controller.register(first, true);
    controller.sync();
    const generator = controller.generator(first)!;
    // Babylon retries a map every frame until its caster shaders are ready.
    await generator.forceCompilationAsync();
    const map = generator.getShadowMap()!;
    const bytes = controller.metrics().bytes;
    const dispose = vi.spyOn(generator, "dispose");
    const dirty = vi.spyOn(receiver, "_markSubMeshesAsLightDirty");
    scene.activeCamera!.position.x = 1000;
    controller.sync();
    expect(controller.status(first)).toBe("outside-relevant-area");
    expect(controller.generator(first)).toBeNull();
    // Receivers keep the attached map, and so their defines, at neutral darkness.
    expect(first.getShadowGenerator()).toBe(generator);
    expect(generator.getDarkness()).toBe(1);
    expect(dirty).not.toHaveBeenCalled();
    expect(controller.metrics()).toEqual({ passes: 0, bytes });
    // Only actual passes clear; one final pass may follow the refresh-rate change.
    let clears = 0;
    map.onClearObservable.add(() => clears++);
    for (let frame = 0; frame < 3; frame++) scene.render();
    expect(clears).toBeLessThanOrEqual(6);
    // A new map would place atlas tiles.
    const allocate = vi.spyOn(ShadowAtlasAllocator.prototype, "allocate");
    const next = new PointLight("next", new Vector3(1005, 0, 0), scene);
    next.range = 10;
    controller.register(next, true);
    controller.sync();
    expect(controller.generator(next)).toBe(generator);
    expect(first.getShadowGenerator()).toBeNull();
    expect(allocate).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  /** A shadowed point light the one-slot Forward budget has dropped for a nearer unshadowed one. */
  function forwardDroppedStandby() {
    const { scene, controller } = fixture();
    scene.activeCamera!.position.set(0, 0, 0);
    const receiver = MeshBuilder.CreateBox("receiver", {}, scene);
    receiver.material = new StandardMaterial("receiver", scene);
    controller.setParticipation(receiver, { castShadows: true, receiveShadows: true });
    const shadowed = new PointLight("shadowed", new Vector3(5, 0, 0), scene);
    const nearer = new PointLight("nearer", new Vector3(1, 0, 0), scene);
    controller.register(shadowed, true);
    syncForwardLightPolicy(scene, 2, selectHapticLights);
    controller.sync();
    const generator = controller.generator(shadowed)!;
    const dispose = vi.spyOn(generator, "dispose");
    syncForwardLightPolicy(scene, 1, selectHapticLights);
    controller.sync();
    expect(shadowed.isEnabled()).toBe(false);
    expect(nearer.isEnabled()).toBe(true);
    return { scene, controller, shadowed, nearer, generator, dispose };
  }

  it("keeps the map of a light the Forward budget dropped on standby until the light returns", () => {
    const { scene, controller, shadowed, generator, dispose } = forwardDroppedStandby();
    // A new map would place atlas tiles.
    const allocate = vi.spyOn(ShadowAtlasAllocator.prototype, "allocate");
    expect(controller.generator(shadowed)).toBeNull();
    expect(shadowed.getShadowGenerator()).toBe(generator);
    expect(generator.getDarkness()).toBe(1);
    expect(controller.metrics().passes).toBe(0);
    expect(controller.metrics().bytes).toBeGreaterThan(0);
    expect(dispose).not.toHaveBeenCalled();
    // Capacity returns: the same map is admitted again, neutral until redrawn.
    syncForwardLightPolicy(scene, 2, selectHapticLights);
    controller.sync();
    expect(controller.generator(shadowed)).toBe(generator);
    expect(controller.status(shadowed)).toBe("active");
    expect(generator.getDarkness()).toBe(1);
    prepareShadowLayers(generator);
    expect(generator.getDarkness()).toBe(0);
    expect(allocate).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it.each([
    ["a withdrawn shadow request", ({ controller, shadowed }: ReturnType<typeof forwardDroppedStandby>) =>
      controller.register(shadowed, false)],
    ["shadows turned off", ({ scene }: ReturnType<typeof forwardDroppedStandby>) =>
      updateSceneRenderingSettings(scene, {
        shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 1, enabled: false }),
      })],
  ])("releases the standby map of a Forward-dropped light on %s", (_name, change) => {
    const context = forwardDroppedStandby();
    const { controller, shadowed, dispose } = context;
    // The light stays disabled, which hides the change from its status.
    expect(shadowed.getShadowGenerator()).not.toBeNull();
    change(context);
    controller.sync();
    expect(controller.generator(shadowed)).toBeNull();
    expect(shadowed.getShadowGenerator()).toBeNull();
    expect(dispose).toHaveBeenCalledOnce();
    expect(controller.metrics()).toEqual({ passes: 0, bytes: 0 });
  });

  it("ranks a standby map handed to a new winner by its light's current distance, not the distance it had when dropped", () => {
    const { scene, controller } = fixture();
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 2 }),
    });
    const camera = scene.activeCamera!;
    camera.position.set(0, 0, 0);
    const near = new PointLight("near", new Vector3(1, 0, 0), scene);
    const dropped = new PointLight("dropped", new Vector3(6, 0, 0), scene);
    const rejected = new PointLight("rejected", new Vector3(5, 0, 0), scene);
    for (const light of [dropped, rejected]) {
      light.range = 10;
      controller.register(light, true);
    }
    controller.sync();
    const droppedMap = controller.generator(dropped)!;
    const rejectedMap = controller.generator(rejected)!;
    // The camera leaves: only `dropped` loses its Forward slot, and `rejected`
    // leaves the relevant area. Both keep their maps, but `dropped` is now the
    // farther one, though it was the nearest light with a stale measurement.
    camera.position.set(-1000, 0, 0);
    const winner = new PointLight("winner", new Vector3(-1001, 0, 0), scene);
    winner.range = 10;
    controller.register(winner, true);
    syncForwardLightPolicy(scene, 3, selectHapticLights);
    controller.sync();
    expect(isForwardLightExcluded(dropped)).toBe(true);
    expect(controller.status(rejected)).toBe("outside-relevant-area");
    expect(near.isEnabled()).toBe(true);
    // The new winner takes the farthest retained map and the nearer one waits.
    expect(controller.generator(winner)).toBe(droppedMap);
    expect(rejected.getShadowGenerator()).toBe(rejectedMap);
  });

  it("frees standby maps before reducing an admitted map that finds no room in the atlas", () => {
    const { scene, controller } = fixture();
    // A 2048 atlas: a point light's six 512 tiles take two of its four 1024 quadrants.
    scene.getEngine().getCaps().maxTextureSize = 2048;
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ cascades: 3, mapSize: 1024, maxLocalLights: 1, localMapSize: 512 }),
    });
    scene.activeCamera!.position.set(0, 0, 0);
    const point = new PointLight("point", new Vector3(5, 0, 0), scene);
    point.range = 10;
    controller.register(point, true);
    controller.sync();
    const standby = controller.generator(point)!;
    expect(tileSizes(standby)).toEqual(Array(6).fill(512));
    scene.activeCamera!.position.x = 1000;
    controller.sync();
    expect(controller.generator(point)).toBeNull();
    expect(point.getShadowGenerator()).toBe(standby);
    // The sun's three 1024 cascades fit the atlas's area, but only two fit beside the standby tiles.
    const sun = new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    controller.register(sun, true);
    const placement = vi.spyOn(ShadowAtlasAllocator.prototype, "allocate");
    controller.sync();
    // The first placement found no third quadrant; the retry, with the standby tiles freed, did.
    expect(placement.mock.results.filter(({ value }) => value === null)).toHaveLength(1);
    placement.mockRestore();
    expect(controller.status(sun)).toBe("active");
    expect(tileSizes(controller.generator(sun))).toEqual([1024, 1024, 1024]);
    expect(controller.diagnostics([sun])[0]!.reason).toBeNull();
    expect(point.getShadowGenerator()).toBeNull();
    expect(standby.getShadowMap()).toBeNull();
  });

  it("releases a standby map when its light no longer requests shadows", () => {
    const { scene, controller } = fixture();
    scene.activeCamera!.position.set(0, 0, 0);
    const light = new PointLight("light", new Vector3(5, 0, 0), scene);
    light.range = 10;
    controller.register(light, true);
    controller.sync();
    const map = controller.generator(light)!.getShadowMap()!;
    scene.activeCamera!.position.x = 1000;
    controller.sync();
    expect(light.getShadowGenerator()).not.toBeNull();
    controller.register(light, false);
    controller.sync();
    expect(light.getShadowGenerator()).toBeNull();
    expect(scene.textures).not.toContain(map);
    expect(controller.metrics()).toEqual({ passes: 0, bytes: 0 });
  });
  it("admits point lights' six face tiles by atlas area before construction, then lowers cost after a Low preset", () => {
    const { scene, controller } = fixture();
    // A desktop texture limit: Ultra's 8192 atlas.
    Object.assign(scene.getEngine().getCaps(), { maxTextureSize: 16384 });
    const placement = vi.spyOn(ShadowAtlasAllocator.prototype, "allocate");
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
    // Ultra's 52 passes hold eight lights' six faces; each halves its tiles until they fit the area the earlier
    // lights leave in the atlas.
    const active = points.filter((light) => controller.generator(light));
    expect(active).toHaveLength(8);
    expect(active.map((light) => tileSizes(controller.generator(light))[0])).toEqual([2048, 2048, 1024, 1024, 512, 512, 256, 256]);
    // Every tile was placed at its first try: admission sized it before construction.
    expect(placement.mock.results.map(({ value }) => value !== null)).toEqual(Array(48).fill(true));
    expect(controller.metrics()).toEqual({ passes: 48, bytes: 8192 ** 2 * 4 });
    expect(controller.metrics().bytes).toBeLessThanOrEqual(SHADOW_CAPACITY_PROFILES.ultra.byteBudget);
    expect(controller.limits()).not.toContain("point shadows: Poisson filter fallback");
    controller.sync();
    expect(placement).toHaveBeenCalledTimes(48);
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ profile: "low", maxLocalLights: 16 }),
    });
    controller.sync();
    // Low's eight passes hold one light's six faces, in its 4096 atlas.
    expect(points.filter((light) => controller.generator(light))).toHaveLength(
      1,
    );
    expect(controller.metrics()).toEqual({ passes: 6, bytes: 4096 ** 2 * 4 });
  });
  it("charges spot shadows by one face each and no material sampler", () => {
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
    // The light block samples every tile through the atlas, always bound: fewer texture units admit as many.
    caps.maxTexturesImageUnits = 11;
    controller.sync();
    expect(controller.metrics().passes).toBe(16);
    expect(controller.diagnostics().filter((light) => light.reason !== null)).toEqual([]);
  });
  it("shares the Engine allowance with previews and releases reservations on scene disposal", () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    // A desktop texture limit: each Scene's Ultra atlas is 8192, whose area holds eight point lights' faces.
    Object.assign(engine.getCaps(), { maxTextureSize: 16384 });
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
    ).toBeLessThanOrEqual(ENGINE_SHADOW_BUDGET.bytes);
    // The Engine's 64 passes leave the preview two lights' faces beside the scene's 48.
    expect(controller.metrics().passes).toBe(48);
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
    // The first tile makes the atlas, so each attempt makes it again.
    const allocation = vi.spyOn(engine, "createRenderTargetTexture");
    for (let attempt = 0; attempt < 3; attempt++)
      allocation.mockImplementationOnce((...args) => {
        // A driver rejection after upload leaves the registered wrapper orphaned.
        NullEngine.prototype.createRenderTargetTexture.apply(engine, args);
        throw new Error("allocation failed");
      });
    controller.sync();
    expect(controller.metrics()).toEqual({ bytes: 0, passes: 0 });
    // One attempt at each size from 1024 to the 256 floor.
    expect(allocation).toHaveBeenCalledTimes(3);
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
    expect(tileSizes(controller.generator(light))[0]).toBe(1024);
    expect(controller.generator(fallback)).toBeNull();
  });
  it("releases a partially allocated atlas before retrying smaller without changing authored settings", async () => {
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
    // The first tile makes the atlas: the driver rejects it once it is complete.
    const allocate = engine.createRenderTargetTexture.bind(engine);
    let orphanDispose: ReturnType<typeof vi.spyOn> | undefined;
    const allocation = vi
      .spyOn(engine, "createRenderTargetTexture")
      .mockImplementationOnce((...args) => {
        const orphan = allocate(...args);
        orphanDispose = vi.spyOn(orphan, "dispose");
        throw new Error("driver rejected completed atlas");
      });
    controller.sync();
    const retained = controller.generator(light);
    expect(tileSizes(retained)).toEqual(Array(6).fill(512));
    expect(controller.metrics()).toEqual({ bytes: shadowAtlasBytes(scene), passes: 6 });
    expect(shadowAtlasBytes(scene)).toBe(4096 ** 2 * 4);
    expect(sceneRenderingSettings(scene).shadows).toEqual(authored);
    expect(
      controller.diagnostics().find((entry) => entry.name === "point"),
    ).toMatchObject({
      status: "active",
      reason: "shadow map reduced after allocation failure",
      allocationError: "driver rejected completed atlas",
    });
    // The atlas was made again for the 512 tiles.
    expect(allocation).toHaveBeenCalledTimes(2);
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
    expect(tileSizes(controller.generator(light))[0]).toBe(512);
    engine.onContextRestoredObservable.notifyObservers(engine);
    controller.sync();
    expect(tileSizes(controller.generator(light))[0]).toBe(1024);
    const restoreObservers =
      engine.onContextRestoredObservable.observers.length;
    scene.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.onContextRestoredObservable.observers).toHaveLength(
      restoreObservers - 1,
    );
  });
  it("lifts a failed allocation's reduced size when the map size setting changes", () => {
    const { scene, controller } = fixture();
    const light = new PointLight("point", Vector3.Zero(), scene);
    controller.register(light, true);
    // The first tile makes the atlas, which the driver rejects once.
    vi.spyOn(scene.getEngine(), "createRenderTargetTexture")
      .mockImplementationOnce(() => {
        throw new Error("driver allocation failed");
      });
    controller.sync();
    expect(controller.diagnostics([light])[0]).toMatchObject({
      status: "active",
      reason: "shadow map reduced after allocation failure",
      allocationError: "driver allocation failed",
      mapSize: 512,
    });
    // The failure was keyed to the 1024 request; a 2048 request is new and
    // no longer limited by it. The atlas's area alone halves its six faces.
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 1, localMapSize: 2048 }),
    });
    controller.sync();
    expect(controller.diagnostics([light])[0]).toMatchObject({
      status: "active",
      reason: "shadow map reduced by shadow atlas space",
      allocationError: null,
      mapSize: 1024,
    });
  });
  it("releases a non-throwing WebGL allocation failure and retains the validated smaller tiles", () => {
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
    // The first tile makes the atlas: a framebuffer whose only attachment is its depth texture.
    const allocate = engine.createRenderTargetTexture.bind(engine);
    let rejectedDispose: ReturnType<typeof vi.spyOn> | undefined;
    const allocation = vi
      .spyOn(engine, "createRenderTargetTexture")
      .mockImplementation((size, options) => {
        const target = allocate(size, options);
        // As WebGL makes it: NullEngine adds a colour texture even without a colour attachment.
        if (typeof options === "object" && options.noColorAttachment) target.releaseTextures();
        const targetFramebuffer = {};
        Object.assign(target, { _framebuffer: targetFramebuffer });
        framebuffers.add(targetFramebuffer);
        if (!rejectedDispose) {
          rejectedDispose = vi.spyOn(target, "dispose");
          // Babylon still returns a ready target when the driver reports OOM
          // through its error flag instead of throwing from texImage2D.
          errors.push(gl.OUT_OF_MEMORY);
        }
        return target;
      });
    const allocateDepth = engine.createDepthStencilTexture.bind(engine);
    vi.spyOn(engine, "createDepthStencilTexture").mockImplementation((...args) => {
      const texture = allocateDepth(...args);
      const resource = {};
      textures.add(resource);
      texture._hardwareTexture = { underlyingResource: resource } as InternalTexture["_hardwareTexture"];
      return texture;
    });
    try {
      controller.sync();
      const retained = controller.generator(light);
      expect(tileSizes(retained)).toEqual(Array(6).fill(512));
      // The atlas was made again for the 512 tiles.
      expect(allocation).toHaveBeenCalledTimes(2);
      expect(rejectedDispose).toHaveBeenCalledTimes(1);
      expect(controller.diagnostics()[0]).toMatchObject({
        status: "active",
        allocationError: "Shadow allocation WebGL errors: 0x505",
      });
      expect(controller.metrics()).toEqual({ bytes: shadowAtlasBytes(scene), passes: 6 });
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
    // The first tile makes the atlas.
    const allocate = engine.createRenderTargetTexture.bind(engine);
    let restoreFailedDispose: (() => void) | undefined;
    const allocation = vi
      .spyOn(engine, "createRenderTargetTexture")
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

/** Every cascade's light transform as plain numbers (the generator reuses its matrices). */
function cascadeFit(generator: CascadedShadowGenerator): number[][] {
  return Array.from({ length: generator.numCascades }, (_, layer) => [...generator.getCascadeTransformMatrix(layer)!.m]);
}

describe("atlas caster variants", () => {
  it.each([1, 2])("hold each atlas kind's caster depth variant that a first shadow start then draws with (%i cascades)", async (cascades) => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades, maxLocalLights: 2 }) });
    // Posed with a non-uniform scale, as a level's floor is: its variant reads its world matrix.
    const crate = MeshBuilder.CreateBox("crate", { size: 1 }, scene);
    crate.scaling.set(6, 0.2, 6);
    controller.sync();
    const compiled = () => new Set(Object.values((engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects));
    const before = compiled();
    // Babylon loads a new map's shaders first: a later sync asks again.
    controller.warmCasterVariants();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.sync();
    const held = [...compiled()].filter((effect) => !before.has(effect));
    expect(held.map((effect) => /SM_LIGHTTYPE_(\w+)/.exec(effect.defines)?.[1]).sort()).toEqual(["DIRECTIONALLIGHT", "POINTLIGHT", "SPOTLIGHT"]);
    expect(held.every((effect) => /NONUNIFORMSCALING/.test(effect.defines))).toBe(true);
    // The stand-ins hold nothing of the Scene's: no light, no atlas tile, no texture.
    expect([scene.lights.length, shadowAtlasBytes(scene), scene.textures.length]).toEqual([0, 0, 0]);
    // The first map of each kind draws its caster with the variant held for it.
    const sun = new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    const spot = new SpotLight("spot", new Vector3(0, 4, 0), Vector3.Down(), 1, 2, scene);
    const lamp = new PointLight("lamp", new Vector3(2, 2, 0), scene);
    for (const light of [sun, spot, lamp]) controller.register(light, true);
    controller.sync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const drawnWith = (light: DirectionalLight | SpotLight | PointLight) => {
      const map = light.getShadowGenerator()!.getShadowMap()!;
      const pass = engine.currentRenderPassId;
      engine.currentRenderPassId = map.renderPassId;
      try {
        map.customIsReadyFunction!(crate, 0, true);
      } finally {
        engine.currentRenderPassId = pass;
      }
      return crate.subMeshes[0]!._getDrawWrapper(map.renderPassId)!.effect!;
    };
    expect([sun, spot, lamp].map((light) => isAtlasShadow(light.getShadowGenerator()))).toEqual([true, true, true]);
    expect([sun, spot, lamp].map((light) => held.includes(drawnWith(light)))).toEqual([true, true, true]);
  });

  it("asks a caster whose Material draws its depth through a wrapper until it holds its variants, then no more", async () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    // Authored World Position Offset and lattice deformation draw a caster's depth through a standalone wrapper of a
    // variant Material that no other pass draws: its first ask compiles that Material, a later one the depth variant,
    // which the wrapper holds itself.
    const crate = MeshBuilder.CreateBox("crate", { size: 1 }, scene);
    const material = crate.material = new StandardMaterial("offset", scene);
    const wrapper = material.shadowDepthWrapper =
      new ShadowDepthWrapper(new StandardMaterial("offset depth", scene), scene, { standalone: true });
    const asked = vi.spyOn(wrapper, "isReadyForSubMesh");
    const kinds = () => Object.values((engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects)
      .map((effect) => /SM_LIGHTTYPE_(\w+)/.exec(effect.defines)?.[1]).filter(Boolean).sort();
    controller.sync();
    controller.warmCasterVariants();
    for (let frame = 0; frame < 4; frame++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.sync();
    }
    expect(kinds()).toEqual(["DIRECTIONALLIGHT", "POINTLIGHT", "SPOTLIGHT"]);
    asked.mockClear();
    for (let frame = 0; frame < 3; frame++) controller.sync();
    expect(asked).not.toHaveBeenCalled();
  });

  it("asks again for new shadow settings", async () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    MeshBuilder.CreateBox("crate", { size: 1 }, scene);
    const variants = () => Object.values((engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects)
      .filter((effect) => /SM_LIGHTTYPE/.test(effect.defines));
    controller.warmCasterVariants();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.sync();
    expect(variants().map((effect) => /SM_NORMALBIAS (\d)/.exec(effect.defines)?.[1])).toEqual(["1", "1", "1"]);
    // Without normal bias the casters draw other variants: the next syncs hold those too (Babylon releases the others
    // at a frame's end).
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 1, normalBias: 0 }) });
    controller.sync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.sync();
    expect(variants().filter((effect) => /SM_NORMALBIAS 0/.test(effect.defines))).toHaveLength(3);
  });
});

describe("view sun shadow maps", () => {
  /** The light block's path, Medium: the sun's `cascades` 2048 cascades in a 4096 atlas, and a capture's camera. */
  const atlasSun = (cascades: number) => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades, maxLocalLights: 1 }) });
    const sun = new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    controller.register(sun, true);
    controller.sync();
    return { scene, engine, controller, sun, capture: new UniversalCamera("capture", new Vector3(20, 6, 20), scene) };
  };

  it("gives a capture its own sun cascades as tiles of the light block's atlas, which charge nothing and go with the claim", async () => {
    const { scene, engine, controller, sun, capture } = atlasSun(2);
    const reserved = managedRenderReservations(engine).reservedBytes;
    const claim = controller.attachView(capture);
    const own = sun.getShadowGenerator(capture) as AtlasCascadedShadowGenerator;
    expect(own).toBeInstanceOf(AtlasCascadedShadowGenerator);
    expect(own).not.toBe(sun.getShadowGenerator());
    expect(controller.viewBoundGenerator(sun, capture)).toBe(own);
    expect(own.getShadowMap()!.renderTarget).toBe(shadowAtlasTexture(scene).renderTarget);
    expect(tileSizes(own)).toEqual([2048, 2048]);
    // Its tiles hold what their last map drew until it draws.
    expect([own.getDarkness(), awaitsFirstDraw(own)]).toEqual([NEUTRAL_DARKNESS, true]);
    expect(managedRenderReservations(engine).reservedBytes).toBe(reserved);
    expect(controller.metrics()).toEqual({ passes: 4, bytes: shadowAtlasBytes(scene) });
    expect(unsupportedManagedShadows(scene)).toBeUndefined();
    await claim.release();
    expect(sun.getShadowGenerator(capture)).toBeNull();
    expect(own.getShadowMap()).toBeNull();
  });

  it("samples the scene view's sun cascades for a capture whose own find no room in the atlas", () => {
    const { controller, sun, capture } = atlasSun(4);
    // Four 2048 cascades fill the 4096 atlas.
    expect(tileSizes(sun.getShadowGenerator())).toEqual([2048, 2048, 2048, 2048]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      controller.attachView(capture);
      expect(sun.getShadowGenerator(capture)).toBeNull();
      expect(controller.viewBoundGenerator(sun, capture)).toBe(sun.getShadowGenerator());
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("does not fit the shadow atlas"));
    } finally {
      warn.mockRestore();
    }
  });

  it("makes a capture's cascades give way before a scene view's map would shrink for atlas room, and take what it leaves", () => {
    const { scene, controller, sun, capture } = atlasSun(2);
    controller.attachView(capture);
    // The scene view's and the capture's cascades fill the atlas.
    expect(tileSizes(sun.getShadowGenerator(capture))).toEqual([2048, 2048]);
    const spot = new SpotLight("spot", new Vector3(0, 4, -4), new Vector3(0, -1, 0.5), 1, 1, scene);
    controller.register(spot, true);
    controller.sync();
    expect((spot.getShadowGenerator() as AtlasShadowGenerator).tile.size).toBe(1024);
    expect(tileSizes(sun.getShadowGenerator(capture))).toEqual([1024, 1024]);
  });

  it("follows the scene view's sun map into an atlas of another edge, and goes with it, the atlas with them", () => {
    const { scene, engine, controller, sun, capture } = atlasSun(2);
    Object.assign(engine.getCaps(), { maxTextureSize: 8192 });
    controller.attachView(capture);
    const medium = sun.getShadowGenerator(capture);
    // High's 8192 atlas: the scene view's map is rebuilt in it, and the capture's after it.
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ profile: "high", cascades: 2, maxLocalLights: 1 }) });
    controller.sync();
    const high = sun.getShadowGenerator(capture);
    expect(medium!.getShadowMap()).toBeNull();
    expect(high).toBeInstanceOf(AtlasCascadedShadowGenerator);
    expect(shadowAtlasTexture(scene).getRenderSize()).toBe(8192);
    expect(tileSizes(high)).toEqual(tileSizes(sun.getShadowGenerator()));
    // The sun's shadow off: both maps go in the same sync, and the atlas with its last tile.
    controller.register(sun, false);
    controller.sync();
    expect([high!.getShadowMap(), sun.getShadowGenerator(capture)]).toEqual([null, null]);
    expect(shadowAtlasBytes(scene)).toBe(0);
  });
  it("mirrors each admitted sun map for an attached view, fitted to that view's camera, and shares local maps", async () => {
    const { scene, controller } = fixture();
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ cascades: 2, distance: 40, mapSize: 512, localMapSize: 256, maxLocalLights: 1 }),
    });
    const caster = MeshBuilder.CreateBox("caster", { size: 2 }, scene);
    const sun = new DirectionalLight("sun", new Vector3(0.4, -1, 0.6), scene);
    const spot = new SpotLight("spot", new Vector3(0, 4, -4), new Vector3(0, -1, 0.5), 1, 1, scene);
    controller.register(sun, true);
    controller.register(spot, true);
    controller.sync();
    const main = controller.generator(sun) as CascadedShadowGenerator;
    const local = controller.generator(spot)!;
    const capture = new UniversalCamera("capture", new Vector3(120, 6, 90), scene);
    capture.setTarget(new Vector3(120, 0, 100));
    const metrics = controller.metrics();
    const view = controller.attachView(capture);
    const own = controller.viewBoundGenerator(sun, capture) as CascadedShadowGenerator;
    // Stats count the view's two cascades; their tiles' bytes are the atlas's.
    expect(controller.metrics()).toEqual({ passes: metrics.passes + 2, bytes: metrics.bytes });
    // A map of the scene map's kind, tile size and cascades, keyed to the capture camera.
    expect(own).toBeInstanceOf(AtlasCascadedShadowGenerator);
    expect(own).not.toBe(main);
    expect(own.camera).toBe(capture);
    expect(own.numCascades).toBe(2);
    expect(tileSizes(own)).toEqual(tileSizes(main));
    expect(own.getShadowMap()!.renderList).toContain(caster);
    expect(sun.getShadowGenerator(capture)).toBe(own);
    expect(sun.getShadowGenerator()).toBe(main);
    // Point and spot maps do not depend on the view: it shares the scene's.
    expect(controller.viewBoundGenerator(spot, capture)).toBe(local);
    expect(unsupportedManagedShadows(scene)).toBeUndefined();
    // Each map fits its own camera; drawing one leaves the other's fit alone.
    prepareShadowLayers(main);
    const mainFit = cascadeFit(main);
    prepareShadowLayers(own);
    expect(cascadeFit(own)).not.toEqual(mainFit);
    expect(cascadeFit(main)).toEqual(mainFit);
    const ownFit = cascadeFit(own);
    prepareShadowLayers(main);
    expect(cascadeFit(own)).toEqual(ownFit);
    await view.release();
    expect(sun.getShadowGenerator(capture)).toBeNull();
    expect(own.getShadowMap()).toBeNull();
    // A camera-keyed map the controller does not own is still rejected.
    new ShadowGenerator(256, sun, undefined, capture);
    expect(unsupportedManagedShadows(scene)).toBe("Unmanaged shadow allocations are not supported.");
  });

  it("replaces a view's map with the scene map's allocation and releases it with the view", async () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ cascades: 2, distance: 40, mapSize: 512 }),
    });
    const sun = new DirectionalLight("sun", new Vector3(0.4, -1, 0.6), scene);
    controller.register(sun, true);
    controller.sync();
    const capture = new UniversalCamera("capture", new Vector3(20, 6, 20), scene);
    const view = controller.attachView(capture);
    const first = controller.viewBoundGenerator(sun, capture)!;
    // A shadow settings change replaces the scene map, and the view's follows it.
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ cascades: 1, distance: 40, mapSize: 256 }),
    });
    controller.sync();
    const second = controller.viewBoundGenerator(sun, capture)!;
    expect(second).not.toBe(first);
    expect(first.getShadowMap()).toBeNull();
    expect((second as CascadedShadowGenerator).numCascades).toBe(1);
    expect(tileSizes(second)).toEqual(tileSizes(controller.generator(sun)));
    // Turning the sun's shadows off removes the view's map too.
    controller.register(sun, false);
    controller.sync();
    expect(controller.viewBoundGenerator(sun, capture)).toBeNull();
    expect(second.getShadowMap()).toBeNull();
    expect(sun.getShadowGenerator(capture)).toBeNull();
    controller.register(sun, true);
    controller.sync();
    const third = controller.viewBoundGenerator(sun, capture)!;
    expect(third.getShadowMap()).not.toBeNull();
    // A spot map admitted while the view is attached stays shared, never mirrored.
    const spot = new SpotLight("spot", new Vector3(0, 4, -4), new Vector3(0, -1, 0.5), 1, 1, scene);
    controller.register(spot, true);
    controller.sync();
    expect(controller.generator(spot)).not.toBeNull();
    expect(controller.viewBoundGenerator(spot, capture)).toBe(controller.generator(spot));
    expect(spot.getShadowGenerators()?.size).toBe(1);
    await view.release();
    expect(third.getShadowMap()).toBeNull();
    expect(sun.getShadowGenerator(capture)).toBeNull();
    // A view's maps never charge the shared ledger.
    expect(managedRenderReservations(engine)).toMatchObject({ resourceBytes: 0, pendingBytes: 0 });
    // A released view gets no new maps.
    controller.sync();
    expect(sun.getShadowGenerator(capture)).toBeNull();
  });
});
