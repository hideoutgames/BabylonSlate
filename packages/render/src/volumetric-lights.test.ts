import {
  type Camera,
  DirectionalLight,
  FreeCamera,
  NullEngine,
  PointLight,
  Scene,
  SpotLight,
  TransformNode,
  Vector3,
  type Effect,
} from "@babylonjs/core";
import { DEFAULT_RENDER_EFFECTS, type VolumetricLightingSettings } from "@haptic/core";
import { expect, it, vi } from "vitest";
import { hapticLightBuffer } from "./haptic-lights";
import { syncSceneLighting } from "./scene-lighting";
import { createAtlasCascadedShadowGenerator, createAtlasShadowGenerator, shadowAtlasTexture } from "./shadow-atlas";
import {
  bindVolumetricLights,
  createVolumetricSlots,
  fillVolumetricSlots,
  type VolumeLight,
  type VolumeShadow,
} from "./volumetric-lights";

const NONE: VolumeShadow = { kind: "none", cascades: 0, first: 0 };

/** The lights taking part, in slot order. */
function selectVolumetricLights(scene: Scene, camera: Camera, settings: VolumetricLightingSettings): VolumeLight[] {
  const slots = createVolumetricSlots();
  fillVolumetricSlots(slots, scene, camera, settings);
  return slots.lights.slice(0, slots.count) as VolumeLight[];
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

it.each([true, false])("gives the sun the first slot whatever the creation order (sun first: %s)", (sunFirst) => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", Vector3.Zero(), scene);
  camera.getViewMatrix();
  try {
    const sun = () => new DirectionalLight("sun", new Vector3(0, -1, 0.2), scene);
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

it("binds each slot's views of the light block's atlas, and no map of its own", () => {
  const engine = new NullEngine();
  engine._features.supportCSM = true;
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
    const slots = createVolumetricSlots();
    fillVolumetricSlots(slots, scene, camera, { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true, maxLights: 4, maxDistance: 10 });
    bindVolumetricLights(effect as unknown as Effect, scene, camera, slots, 4, { ...NONE });
    // [kind, views, first view]: the sun's two cascades from view 0, the spot light's view after them, the point
    // light's six faces after that; the unshadowed light none.
    expect(effect.setFloat4.mock.calls.filter(([name]) => String(name).startsWith("volumeShadow"))).toEqual([
      ["volumeShadow0", 3, 2, 0, 0], ["volumeShadow1", 1, 1, 4, 0], ["volumeShadow2", 2, 6, 5, 0], ["volumeShadow3", 0, 0, 0, 0],
    ]);
    expect(effect.bindUniformBuffer).toHaveBeenCalledExactlyOnceWith(hapticLightBuffer(scene).getBuffer(), "HapticLights");
    expect(effect.setDepthStencilTexture).toHaveBeenCalledExactlyOnceWith("hapticShadowAtlas", shadowAtlasTexture(scene));
    expect(effect.setTexture).not.toHaveBeenCalled();
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
