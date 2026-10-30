import {
  AbstractEngine,
  Camera,
  CascadedShadowGenerator,
  DirectionalLight,
  NullEngine,
  Scene,
  UniversalCamera,
  Vector3,
} from "@babylonjs/core";
import { normalizeShadowSettings, type ShadowProfile } from "@haptic/core";
import { afterEach, describe, expect, it } from "vitest";
import { cascadeSplit, type CascadeSplitInput } from "./cascade-split";
import { lightsDebugText, type RenderDiagnostics } from "./render-diagnostics";
import { updateSceneRenderingSettings } from "./render-settings";
import type { AtlasCascadedShadowGenerator } from "./shadow-atlas";
import { sceneShadowController, shadowLightDiagnostics } from "./shadow-controller";
import { captureShadowDiagnostics } from "./shadow-diagnostics";

// A 0.8 rad, 16:9 view with Haptic's 0.1 m near plane.
const VIEW = { fov: 0.8, aspect: 16 / 9, near: 0.1, far: 1000 } as const;

describe("cascadeSplit", () => {
  // Hand-derived: end i = 4 · (D / 4)^((i + 1) / N); texels / (2 · stabilized radius) of each slice.
  it.each([
    ["Medium", { distance: 250, cascades: 3, tile: 2048 }, [15.874, 62.996, 250], [68.55, 17.28, 4.36]],
    ["High", { distance: 350, cascades: 4, tile: 2048 }, [12.234, 37.417, 114.437, 350], [90.02, 29.52, 9.67, 3.16]],
    ["Ultra", { distance: 600, cascades: 4, tile: 4096 }, [13.999, 48.99, 171.446, 600], [156.04, 44.77, 12.8, 3.66]],
  ])("anchors a log split at 4 m at %s", (_, level, ends, density) => {
    const split = cascadeSplit({ ...VIEW, ...level, anchor: 4 });
    expect(split.lambda).toBe(1);
    expect(split.minDistance).toBeCloseTo((4 - 0.1) / (1000 - 0.1), 12);
    split.ends.forEach((end, index) => expect(end).toBeCloseTo(ends[index]!, 2));
    split.texelsPerMetre.forEach((texels, index) => expect(texels).toBeCloseTo(density[index]!, 1));
  });

  it("concentrates the near cascade's texels and keeps the far end and the far cascade's density", () => {
    const level = { ...VIEW, distance: 250, cascades: 3, tile: 2048 };
    const uniform = cascadeSplit({ ...level, anchor: null });
    const log = cascadeSplit({ ...level, anchor: 4 });
    // Babylon's mix from the near plane at λ 0.7: the first cascade reaches 26 m.
    expect(uniform.ends[0]).toBeCloseTo(25.97, 2);
    expect(uniform.texelsPerMetre[0]).toBeCloseTo(39.57, 1);
    expect(log.texelsPerMetre[0]! / uniform.texelsPerMetre[0]!).toBeGreaterThan(1.7);
    expect(log.ends.at(-1)).toBe(250);
    expect(log.texelsPerMetre.at(-1)).toBeCloseTo(uniform.texelsPerMetre.at(-1)!, 2);
  });

  it.each<[string, Partial<CascadeSplitInput>]>([
    ["an orthographic camera", { fov: null }],
    // k² · q = 0.093 · 3.97 < 1.2: cascade 0's sphere would not reach back to the eye.
    ["a narrow view", { fov: 0.3, aspect: 1 }],
    ["an anchor at or before the near plane", { near: 4 }],
    ["an anchor beyond the shadow distance", { distance: 3 }],
    // Over 40 m the anchored first cascade would end at 12.6 m, the mix's at 7.4 m.
    ["a short range, where the log split's first cascade ends later", { far: 40, cascades: 2 }],
  ])("keeps Babylon's mix from the near plane for %s", (_, change) => {
    const split = cascadeSplit({ ...VIEW, distance: 250, cascades: 3, tile: 2048, anchor: 4, ...change });
    expect(split).toMatchObject({ minDistance: 0, lambda: 0.7 });
  });

  it("splits up to the camera's far plane when the shadow distance lies beyond it, and up to the distance when the far plane is infinite", () => {
    const base = { ...VIEW, cascades: 2, tile: 1024, anchor: 4 };
    expect(cascadeSplit({ ...base, far: 100, distance: 250 }).ends.at(-1)).toBeCloseTo(100, 9);
    const infinite = cascadeSplit({ ...base, cascades: 3, far: 0, distance: 250 });
    infinite.ends.forEach((end, index) => expect(end).toBeCloseTo([15.874, 62.996, 250][index]!, 2));
    expect(infinite.minDistance).toBeCloseTo((4 - 0.1) / (250 - 0.1), 12);
  });
});

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

/** A scene whose sun the controller draws as a three-cascade atlas map over 250 m at `profile`. */
function sunScene(profile: ShadowProfile, mode = Camera.PERSPECTIVE_CAMERA) {
  const engine = new NullEngine({ renderWidth: 512, renderHeight: 256, textureSize: 256, deterministicLockstep: false, lockstepMaxSteps: 1 });
  engines.push(engine);
  Object.assign(engine.getCaps(), { maxTexturesImageUnits: 16, maxTextureSize: 4096, textureHalfFloatRender: true });
  engine._features.supportCSM = true;
  const scene = new Scene(engine);
  const camera = new UniversalCamera("camera", new Vector3(0, 2, -10), scene);
  camera.fov = 0.8;
  camera.minZ = 0.1;
  camera.maxZ = 1000;
  camera.mode = mode;
  scene.activeCamera = camera;
  updateSceneRenderingSettings(scene, {
    shadows: normalizeShadowSettings({ profile, mapSize: 1024, cascades: 3, distance: 250, autoBias: false }),
  });
  const light = new DirectionalLight("sun", new Vector3(0.3, -1, 0.4), scene);
  const controller = sceneShadowController(scene);
  controller.register(light, true);
  controller.sync();
  scene.render();
  const generator = controller.generator(light) as AtlasCascadedShadowGenerator;
  return { scene, camera, generator, engine: engine as AbstractEngine };
}

describe("the sun's drawn cascades", () => {
  it("are Babylon's split with the log anchor at Medium and above, ending where cascadeSplit says", () => {
    const { generator } = sunScene("medium");
    expect(generator).toBeInstanceOf(CascadedShadowGenerator);
    expect(generator.lambda).toBe(1);
    // Babylon's own `_viewSpaceFrustumsZ`, as the map last bound.
    generator.cascadeEnds.forEach((end, index) => expect(end).toBeCloseTo([15.874, 62.996, 250][index]!, 2));
    // Its stabilized cascade boxes give the texel densities the helper predicts for this 2:1 view.
    const predicted = cascadeSplit({ fov: 0.8, aspect: 2, near: 0.1, far: 1000, distance: 250, cascades: 3, tile: 1024, anchor: 4 });
    generator.cascadeDensity.forEach((cascade, index) =>
      expect(cascade.texelsPerMetre).toBeCloseTo(predicted.texelsPerMetre[index]!, 3));
  });

  it("keep Babylon's near-uniform mix at Low and for an orthographic camera", () => {
    for (const { generator } of [sunScene("low"), sunScene("medium", Camera.ORTHOGRAPHIC_CAMERA)]) {
      expect(generator.lambda).toBe(0.7);
      expect(generator.minDistance).toBe(0);
    }
    sunScene("low").generator.cascadeEnds.forEach((end, index) => expect(end).toBeCloseTo([25.97, 62.904, 250][index]!, 2));
  });

  it("keep their splits and cascade sizes while the camera moves, so stabilized cascades do not shimmer", () => {
    const { scene, camera, generator } = sunScene("high");
    const ends = [...generator.cascadeEnds];
    const widths = generator.cascadeDensity.map((cascade) => cascade.texelsPerMetre);
    for (let frame = 0; frame < 30; frame++) {
      camera.position.x += 0.01;
      camera.rotation.y += 0.002;
      scene.render();
      expect(generator.cascadeEnds).toEqual(ends);
      // Babylon rounds a stabilized radius up to 1/16 m, which float noise in the far corners can flip by one step.
      generator.cascadeDensity.forEach((cascade, index) =>
        expect(Math.abs(cascade.texelsPerMetre / widths[index]! - 1)).toBeLessThan(1e-3));
    }
  });

  it("are reported per cascade in the Lights debug text and the shadow capture", () => {
    const { scene, generator } = sunScene("medium");
    const [first] = generator.cascadeDensity;
    const capture = captureShadowDiagnostics(scene).lights[0]!.generator!.projections;
    expect(capture.map((projection) => projection.cascadeEnd)).toEqual([...generator.cascadeEnds]);
    expect(capture[0]!.texelsPerMetre).toBeCloseTo(first!.texelsPerMetre, 4);
    const shadowLights = shadowLightDiagnostics(scene, sceneShadowController(scene));
    const text = lightsDebugText({ shadowLights } as RenderDiagnostics);
    expect(text).toContain(`cascades 15.9 m @ ${Math.round(first!.texelsPerMetre)}/m, 63.0 m @ `);
  });
});
