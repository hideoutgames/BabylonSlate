import {
  DirectionalLight,
  FreeCamera,
  NullEngine,
  PointLight,
  Scene,
  SpotLight,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { DEFAULT_RENDER_EFFECTS, normalizeShadowSettings } from "@babylonslate/core";
import { expect, it } from "vitest";
import { registerClusteredLightPolicy } from "./clustered-light-policy";
import { updateSceneRenderingSettings } from "./render-settings";
import { sceneShadowController } from "./shadow-controller";
import {
  selectVolumetricLights,
  volumetricLayout,
  volumetricLayoutMatches,
  type VolumeShadow,
} from "./volumetric-lights";

const NONE: VolumeShadow = { kind: "none", cascades: 0, packed: false };
const COMPARE: VolumeShadow = { kind: "compare", cascades: 1, packed: false };

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

it("bounds contributors, includes borrowed cluster children and follows parent transforms", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const camera = new FreeCamera("camera", Vector3.Zero(), scene);
    camera.getViewMatrix();
    const sun = new DirectionalLight("sun", Vector3.Down(), scene);
    const near = new PointLight("near", new Vector3(1, 0, 0), scene);
    const child = new SpotLight(
      "borrowed",
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
    scene.removeLight(child);
    const unregister = registerClusteredLightPolicy(scene, {
      sync() {},
      limits: () => [],
      target: () => undefined,
      ownsContainer: () => false,
      allowsLocal: () => true,
      clusteredCount: () => 1,
      authoredLights: () => [child],
    });
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
    unregister();
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

it.each([true, false])("orders the slots by shadow shape whatever the lights' creation order (shadowed sun first: %s)", (sunFirst) => {
  const { engine, scene, camera, shadowed } = shadowedScene();
  try {
    const sun = () => shadowed(new DirectionalLight("sun", new Vector3(0, -1, 0.2), scene));
    if (sunFirst) sun();
    new PointLight("point", new Vector3(1, 0, 0), scene);
    if (!sunFirst) sun();
    const settings = { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true, maxLights: 2, maxDistance: 10 };
    expect(volumetricLayout(scene, camera, settings)).toEqual([NONE, COMPARE]);
    expect(selectVolumetricLights(scene, camera, settings).map((light) => light.name)).toEqual(["point", "sun"]);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

it("matches a built layout while lights of the same shadow shape trade places, and not once the shapes or their count change", () => {
  const { engine, scene, camera, shadowed } = shadowedScene();
  try {
    const sun = shadowed(new DirectionalLight("sun", new Vector3(0, -1, 0.2), scene));
    const spot = shadowed(new SpotLight("spot", new Vector3(100, 0, 0), Vector3.Down(), 1, 1, scene));
    const near = new PointLight("near", new Vector3(1, 0, 0), scene);
    const other = new PointLight("other", new Vector3(100, 0, 0), scene);
    spot.range = near.range = other.range = 1;
    const settings = { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true, maxLights: 2, maxDistance: 10 };
    // The shadowed sun and the nearest unshadowed point light; the other two lights are out of reach.
    const built = volumetricLayout(scene, camera, settings);
    expect(built).toEqual([NONE, COMPARE]);
    expect(volumetricLayoutMatches(scene, camera, settings, built)).toBe(true);
    // The other point light comes nearer: another light in the same slot, the same layout.
    other.position.x = 0.5;
    expect(selectVolumetricLights(scene, camera, settings)).toEqual([other, sun]);
    expect(volumetricLayoutMatches(scene, camera, settings, built)).toBe(true);
    // The shadowed spot light takes that place instead: the slot compiled for no shadow would sample its map.
    spot.position.x = 0.25;
    expect(selectVolumetricLights(scene, camera, settings)).toEqual([sun, spot]);
    expect(volumetricLayoutMatches(scene, camera, settings, built)).toBe(false);
    expect(volumetricLayoutMatches(scene, camera, settings, [COMPARE, COMPARE])).toBe(true);
    // The sun's map goes away: the layout follows the shadows the lights have now.
    spot.position.x = 100;
    sun.shadowEnabled = false;
    expect(volumetricLayoutMatches(scene, camera, settings, built)).toBe(false);
    expect(volumetricLayoutMatches(scene, camera, settings, [NONE, NONE])).toBe(true);
    // Another count of slots is another layout.
    other.setEnabled(false);
    near.setEnabled(false);
    expect(volumetricLayoutMatches(scene, camera, settings, [NONE, NONE])).toBe(false);
    expect(volumetricLayoutMatches(scene, camera, settings, [NONE])).toBe(true);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
