import { afterEach, expect, it } from "vitest";
import { Camera, FreeCamera, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { DEFAULT_RENDER_EFFECTS } from "@babylonslate/core";
import { EffectCompileFailure } from "./effect-compile-failure";
import { sceneRenderingSettings, updateSceneRenderingSettings } from "./render-settings";
import { createSpatialStages, type SpatialStage } from "./spatial-effects";

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });

function stagesFor(effects: Partial<typeof DEFAULT_RENDER_EFFECTS>, failure?: EffectCompileFailure, mode = Camera.PERSPECTIVE_CAMERA): SpatialStage[] {
  const engine = new NullEngine();
  // The spatial chain needs four float targets and depth sampling.
  Object.assign(engine.getCaps(), {
    maxDrawBuffers: 4, drawBuffersExtension: true, depthTextureExtension: true,
    textureHalfFloatRender: true, textureFloatRender: true, texelFetch: true,
  });
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 2, -6), scene);
  camera.mode = mode;
  updateSceneRenderingSettings(scene, { mode: "pbr", effects: { ...DEFAULT_RENDER_EFFECTS, ...effects } });
  const stages = createSpatialStages(scene, camera, sceneRenderingSettings(scene).effectsPlan!, 64, 64, failure);
  disposers.push(() => { for (const stage of stages) stage.wrapper.dispose(); scene.dispose(); engine.dispose(); });
  return stages;
}

const named = (stages: SpatialStage[], name: string) => stages.findIndex((stage) => stage.wrapper.name === name);

it("composes reflections onto the occlusion-composed color they traced, not the color before occlusion", () => {
  const stages = stagesFor({
    ambientOcclusion: { ...DEFAULT_RENDER_EFFECTS.ambientOcclusion, enabled: true },
    reflections: { ...DEFAULT_RENDER_EFFECTS.reflections, enabled: true },
  });
  // The graph binds the color entering stage `mainInput` as the compose's main sampler.
  const occlusion = named(stages, "Scene Ambient Occlusion Compose"), reflections = named(stages, "Scene Reflections");
  expect(occlusion).toBeGreaterThanOrEqual(0);
  expect(reflections).toBeGreaterThan(occlusion);
  expect(stages[named(stages, "Scene Reflections Compose")]!.mainInput).toBe(reflections);
});

it("reports a failed volumetric march as the chain's compile failure", () => {
  const failure = new EffectCompileFailure();
  const stages = stagesFor({ volumetricLighting: { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true } }, failure);
  const march = stages[named(stages, "Scene Volumetric Lighting")]!.wrapper.effect;
  // Babylon reports a shader error through the Effect's onError once its fallbacks are exhausted.
  march.onError?.(march, "march failed");
  expect(failure.message).toBe("Scene Volumetric Lighting failed to compile: march failed");
});

it("gives the orthographic reflection compose the parallel view direction its trace uses", async () => {
  const reflections = { reflections: { ...DEFAULT_RENDER_EFFECTS.reflections, enabled: true } };
  const compose = async (mode: number) => {
    const stages = stagesFor(reflections, undefined, mode);
    const effect = stages[named(stages, "Scene Reflections Compose")]!.wrapper.effect;
    await new Promise<void>((resolve) => effect.executeWhenCompiled(() => resolve()));
    return effect.fragmentSourceCode;
  };
  expect(await compose(Camera.ORTHOGRAPHIC_CAMERA)).toMatch(/csViewDirection\s*=\s*normalize\(vec3\(0\.0, 0\.0, csPosition\.z\)\)/);
  expect(await compose(Camera.PERSPECTIVE_CAMERA)).toMatch(/csViewDirection\s*=\s*normalize\(csPosition\)/);
});
