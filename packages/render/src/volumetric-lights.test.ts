import {
  type Camera,
  DirectionalLight,
  FreeCamera,
  InternalTexture,
  InternalTextureSource,
  NullEngine,
  PointLight,
  Scene,
  SpotLight,
  TransformNode,
  Vector3,
  type Effect,
} from "@babylonjs/core";
import { DEFAULT_RENDER_EFFECTS, normalizeShadowSettings, type VolumetricLightingSettings } from "@haptic/core";
import { expect, it, vi } from "vitest";
import { hapticLightBuffer, setHapticLighting } from "./haptic-lights";
import { updateSceneRenderingSettings } from "./render-settings";
import { syncSceneLighting } from "./scene-lighting";
import { createAtlasCascadedShadowGenerator, createAtlasShadowGenerator, shadowAtlasTexture } from "./shadow-atlas";
import { sceneShadowController } from "./shadow-controller";
import {
  bindVolumetricLights,
  createVolumetricSlots,
  fillVolumetricSlots,
  volumeShadowPlaceholders,
  type VolumeLight,
  type VolumeShadow,
  type VolumeShadowPlaceholders,
} from "./volumetric-lights";

const NONE: VolumeShadow = { kind: "none", cascades: 0, packed: false, first: 0 };

/** The lights taking part, in slot order. */
function selectVolumetricLights(scene: Scene, camera: Camera, settings: VolumetricLightingSettings): VolumeLight[] {
  const slots = createVolumetricSlots();
  fillVolumetricSlots(slots, scene, camera, settings);
  return slots.lights.slice(0, slots.count) as VolumeLight[];
}

/** A scene with its own engine; the sun's map compares in the sampler, as WebGL2 and WebGPU do. */
function shadowedScene() {
  const engine = new NullEngine();
  Object.assign(engine.getCaps(), { maxTexturesImageUnits: 16, maxTextureSize: 4096, textureHalfFloatRender: true });
  Object.assign(engine._features, { supportShadowSamplers: true });
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", Vector3.Zero(), scene);
  camera.getViewMatrix();
  updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades: 1, mapSize: 256 }) });
  /** Gives the light a map; the sampler compares in hardware, so its slot is compiled for a depth comparison. */
  const shadowed = <T extends DirectionalLight | SpotLight>(light: T): T => {
    const controller = sceneShadowController(scene);
    controller.register(light, true);
    controller.sync();
    expect(controller.generator(light)?.usePercentageCloserFiltering).toBe(true);
    return light;
  };
  return { engine, scene, camera, shadowed };
}

it("bounds contributors and follows parent transforms", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const camera = new FreeCamera("camera", Vector3.Zero(), scene);
    camera.getViewMatrix();
    const sun = new DirectionalLight("sun", Vector3.Down(), scene);
    const near = new PointLight("near", new Vector3(1, 0, 0), scene);
    const child = new SpotLight(
      "parented",
      new Vector3(2, 0, 0),
      Vector3.Down(),
      1,
      1,
      scene,
    );
    const far = new PointLight("far", new Vector3(100, 0, 0), scene);
    far.range = 2;
    const parent = new TransformNode("moving parent", scene);
    child.parent = parent;
    const settings = {
      ...DEFAULT_RENDER_EFFECTS.volumetricLighting,
      enabled: true,
      maxLights: 3,
      maxDistance: 10,
    };
    expect(selectVolumetricLights(scene, camera, settings)).toEqual([
      sun,
      near,
      child,
    ]);
    expect(
      selectVolumetricLights(scene, camera, { ...settings, maxLights: 2 }),
    ).toEqual([sun, near]);
    parent.setEnabled(false);
    expect(selectVolumetricLights(scene, camera, settings)).toEqual([
      sun,
      near,
    ]);
    parent.setEnabled(true);
    parent.position.x = 100;
    child.range = 2;
    expect(selectVolumetricLights(scene, camera, settings)).toEqual([
      sun,
      near,
    ]);
    near.setEnabled(false);
    expect(selectVolumetricLights(scene, camera, settings)).toEqual([sun]);
    scene.lightsEnabled = false;
    expect(selectVolumetricLights(scene, camera, settings)).toEqual([]);
    child.dispose();
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

it("keeps the slot order while selected lights cross in distance", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const camera = new FreeCamera("camera", Vector3.Zero(), scene);
    camera.getViewMatrix();
    const a = new PointLight("a", new Vector3(1, 0, 0), scene);
    const b = new PointLight("b", new Vector3(2, 0, 0), scene);
    const settings = { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true, maxLights: 2, maxDistance: 10 };
    expect(selectVolumetricLights(scene, camera, settings)).toEqual([a, b]);
    a.position.x = 3;
    expect(selectVolumetricLights(scene, camera, settings)).toEqual([a, b]);
    // Distance still chooses which lights take part.
    expect(selectVolumetricLights(scene, camera, { ...settings, maxLights: 1 })).toEqual([b]);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

it.each([true, false])("gives the sun the first slot, the only one that reads cascades, whatever the creation order (sun first: %s)", (sunFirst) => {
  const { engine, scene, camera, shadowed } = shadowedScene();
  try {
    const sun = () => shadowed(new DirectionalLight("sun", new Vector3(0, -1, 0.2), scene));
    if (sunFirst) sun();
    new PointLight("point", new Vector3(1, 0, 0), scene);
    new PointLight("other", new Vector3(2, 0, 0), scene);
    if (!sunFirst) sun();
    const settings = { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true, maxLights: 3, maxDistance: 10 };
    expect(selectVolumetricLights(scene, camera, settings).map((light) => light.name)).toEqual(["sun", "point", "other"]);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

it("lets go of the lights a smaller fill leaves out", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const camera = new FreeCamera("camera", Vector3.Zero(), scene);
    camera.getViewMatrix();
    const a = new PointLight("a", new Vector3(1, 0, 0), scene);
    const b = new PointLight("b", new Vector3(2, 0, 0), scene);
    const settings = { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true, maxLights: 2, maxDistance: 10 };
    const slots = createVolumetricSlots();
    fillVolumetricSlots(slots, scene, camera, settings);
    expect([slots.count, slots.lights[0], slots.lights[1]]).toEqual([2, a, b]);
    a.setEnabled(false);
    fillVolumetricSlots(slots, scene, camera, settings);
    expect([slots.count, slots.lights[0], slots.lights[1]]).toEqual([1, b, undefined]);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

it("binds each slot's map for its light's shadow kind and a placeholder to every sampler that kind leaves unread", () => {
  const { engine, scene, camera, shadowed } = shadowedScene();
  try {
    const sun = shadowed(new DirectionalLight("sun", new Vector3(0, -1, 0.2), scene));
    const point = new PointLight("point", new Vector3(1, 0, 0), scene);
    const bindShadowLight = vi.spyOn(sceneShadowController(scene).generator(sun)!, "bindShadowLight").mockImplementation(() => {});
    const effect = { setFloat4: vi.fn(), setFloat2: vi.fn(), setFloat: vi.fn(), setTexture: vi.fn() };
    const textures = { compare: { name: "compare" }, cube: { name: "cube" }, cascades: { name: "cascades" } } as unknown as VolumeShadowPlaceholders;
    const slots = createVolumetricSlots();
    const settings = { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true, maxLights: 3, maxDistance: 10 };
    const bind = () => {
      for (const spy of Object.values(effect)) spy.mockClear();
      bindShadowLight.mockClear();
      fillVolumetricSlots(slots, scene, camera, settings);
      bindVolumetricLights(effect as unknown as Effect, scene, camera, slots, 3, textures, { ...NONE });
    };
    const shadows = () => effect.setFloat4.mock.calls.filter(([name]) => String(name).startsWith("volumeShadow"));
    const placeholders = () => effect.setTexture.mock.calls.map(([name, texture]) => [name, (texture as { name: string }).name]);
    bind();
    // Two lights in three slots: the sun compares its map in the first; the unshadowed point light and the empty slot
    // sample nothing, so every one of their samplers holds a placeholder.
    expect(effect.setFloat).toHaveBeenCalledExactlyOnceWith("volumeLightCount", 2);
    expect(shadows()).toEqual([["volumeShadow0", 1, 1, 0, 0], ["volumeShadow1", 0, 0, 0, 0], ["volumeShadow2", 0, 0, 0, 0]]);
    expect(bindShadowLight).toHaveBeenCalledExactlyOnceWith("0", effect);
    expect(placeholders()).toEqual([
      ["shadowTextureCube0", "cube"], ["shadowTextureCascades0", "cascades"],
      ["shadowTexture1", "compare"], ["shadowTextureCube1", "cube"],
      ["shadowTexture2", "compare"], ["shadowTextureCube2", "cube"],
    ]);
    expect(effect.setFloat4.mock.calls.some(([name]) => name === "volumePosition2")).toBe(false);
    // The sun's map stands by: the slot keeps the sun, unshadowed, and its comparison sampler takes the placeholder.
    sceneShadowController(scene).register(sun, false);
    sceneShadowController(scene).sync();
    bind();
    expect(slots.lights.slice(0, slots.count)).toEqual([sun, point]);
    expect(shadows()[0]).toEqual(["volumeShadow0", 0, 0, 0, 0]);
    expect(bindShadowLight).not.toHaveBeenCalled();
    expect(placeholders()[0]).toEqual(["shadowTexture0", "compare"]);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

it("binds each slot's views of the light block's atlas on its path, and no map or placeholder of its own", () => {
  const engine = new NullEngine();
  vi.spyOn(engine, "supportsUniformBuffers", "get").mockReturnValue(true);
  vi.spyOn(engine, "createDepthStencilTexture").mockImplementation(() => new InternalTexture(engine, InternalTextureSource.DepthStencil));
  vi.spyOn(engine, "createRawTexture2DArray").mockImplementation(() => new InternalTexture(engine, InternalTextureSource.Raw2DArray));
  engine._features.supportCSM = true;
  setHapticLighting(engine, true);
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", Vector3.Zero(), scene);
  try {
    const sun = new DirectionalLight("sun", new Vector3(0, -1, 0.2), scene);
    const spot = new SpotLight("spot", new Vector3(1, 3, 0), Vector3.Down(), Math.PI / 2, 2, scene);
    const point = new PointLight("point", new Vector3(-1, 2, 0), scene);
    new PointLight("unshadowed", new Vector3(0, 2, 1), scene);
    createAtlasCascadedShadowGenerator(sun, 512, 2, 2048);
    createAtlasShadowGenerator(spot, 512, 2048);
    createAtlasShadowGenerator(point, 256, 2048);
    syncSceneLighting(scene);
    const effect = {
      setFloat4: vi.fn(), setFloat2: vi.fn(), setFloat: vi.fn(), setTexture: vi.fn(), setDepthStencilTexture: vi.fn(),
      bindUniformBuffer: vi.fn(),
    };
    const textures = { compare: { name: "compare" }, cube: { name: "cube" }, cascades: { name: "cascades" } } as unknown as VolumeShadowPlaceholders;
    const slots = createVolumetricSlots();
    fillVolumetricSlots(slots, scene, camera, { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true, maxLights: 4, maxDistance: 10 });
    bindVolumetricLights(effect as unknown as Effect, scene, camera, slots, 4, textures, { ...NONE }, true);
    // [kind, views, first view]: the sun's two cascades from view 0, the spot light's view after them, the point
    // light's six faces after that; the unshadowed light none.
    expect(effect.setFloat4.mock.calls.filter(([name]) => String(name).startsWith("volumeShadow"))).toEqual([
      ["volumeShadow0", 4, 2, 0, 0], ["volumeShadow1", 1, 1, 4, 0], ["volumeShadow2", 2, 6, 5, 0], ["volumeShadow3", 0, 0, 0, 0],
    ]);
    expect(effect.bindUniformBuffer).toHaveBeenCalledExactlyOnceWith(hapticLightBuffer(scene).getBuffer(), "HapticLights");
    expect(effect.setDepthStencilTexture).toHaveBeenCalledExactlyOnceWith("hapticShadowAtlas", shadowAtlasTexture(scene));
    expect(effect.setTexture).not.toHaveBeenCalled();
  } finally {
    setHapticLighting(engine, false);
    scene.dispose();
    engine.dispose();
  }
});

it("keeps one set of shadow placeholders per live scene and releases it with that scene", () => {
  const engine = new NullEngine();
  const first = new Scene(engine);
  const second = new Scene(engine);
  try {
    const targets = engine._renderTargetWrapperCache.length;
    const placeholders = volumeShadowPlaceholders(first);
    expect(volumeShadowPlaceholders(first)).toBe(placeholders);
    const other = volumeShadowPlaceholders(second);
    expect(other).not.toBe(placeholders);
    // Comparison 2D, cube and cascades for shadow samplers; plain 2D and array for PCSS depth and light textures.
    expect(new Set([...Object.values(placeholders), ...Object.values(other)]).size).toBe(10);
    expect(engine._renderTargetWrapperCache.length).toBe(targets + 10);
    first.dispose();
    expect(Object.values(placeholders).map((texture) => texture.getInternalTexture())).toEqual([null, null, null, null, null]);
    expect(Object.values(other).every((texture) => texture.getInternalTexture() !== null)).toBe(true);
    expect(engine._renderTargetWrapperCache.length).toBe(targets + 5);
    // A disposed scene never notifies its disposal again: textures made for it now would never be released.
    expect(() => volumeShadowPlaceholders(first)).toThrow();
    second.dispose();
    expect(engine._renderTargetWrapperCache.length).toBe(targets);
  } finally {
    first.dispose();
    second.dispose();
    engine.dispose();
  }
});

it("binds a Full Quality capture's march to the sun map fitted to the capture's camera, and none once the scene map goes", async () => {
  const { engine, scene, camera, shadowed } = shadowedScene();
  try {
    const sun = shadowed(new DirectionalLight("sun", new Vector3(0, -1, 0.2), scene));
    const controller = sceneShadowController(scene);
    const capture = new FreeCamera("capture", new Vector3(300, 2, 300), scene);
    capture.getViewMatrix();
    const view = controller.attachView(capture);
    const main = controller.generator(sun)!;
    const own = controller.viewBoundGenerator(sun, capture)!;
    expect(own).not.toBe(main);
    const mainBind = vi.spyOn(main, "bindShadowLight").mockImplementation(() => {});
    const ownBind = vi.spyOn(own, "bindShadowLight").mockImplementation(() => {});
    const effect = { setFloat4: vi.fn(), setFloat2: vi.fn(), setFloat: vi.fn(), setTexture: vi.fn() };
    const textures = { compare: { name: "compare" }, cube: { name: "cube" }, cascades: { name: "cascades" } } as unknown as VolumeShadowPlaceholders;
    const slots = createVolumetricSlots();
    const settings = { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true, maxLights: 1, maxDistance: 10 };
    const bind = (drawn: FreeCamera) => {
      for (const spy of [...Object.values(effect), mainBind, ownBind]) spy.mockClear();
      fillVolumetricSlots(slots, scene, drawn, settings);
      bindVolumetricLights(effect as unknown as Effect, scene, drawn, slots, 1, textures, { ...NONE });
    };
    // The capture's march samples the map its own pass drew, with that map's matrices; the scene view's, the scene's.
    bind(capture);
    expect(ownBind).toHaveBeenCalledExactlyOnceWith("0", effect);
    expect(mainBind).not.toHaveBeenCalled();
    bind(camera);
    expect(mainBind).toHaveBeenCalledExactlyOnceWith("0", effect);
    expect(ownBind).not.toHaveBeenCalled();
    // Without an admitted scene map the capture binds no sun map, the scene's or its own.
    controller.register(sun, false);
    controller.sync();
    bind(capture);
    expect(mainBind).not.toHaveBeenCalled();
    expect(ownBind).not.toHaveBeenCalled();
    expect(effect.setFloat4).toHaveBeenCalledWith("volumeShadow0", 0, 0, 0, 0);
    await view.release();
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
