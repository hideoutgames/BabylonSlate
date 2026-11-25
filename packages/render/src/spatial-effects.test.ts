import { afterEach, expect, it, vi } from "vitest";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { Matrix, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import type { WebGLPipelineContext } from "@babylonjs/core/Engines/WebGL/webGLPipelineContext";
import { DEFAULT_RENDER_EFFECTS, normalizeRenderingQuality, qualityPresetPatch } from "@haptic/core";
import { projectionUnprojectParams } from "./ambient-occlusion-shader";
import { EffectCompileFailure } from "./effect-compile-failure";
import { sceneRenderingSettings, updateSceneRenderingSettings } from "./render-settings";
import { createSpatialStages, type SpatialStage } from "./spatial-effects";

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });

function stagesFor(
  effects: Partial<typeof DEFAULT_RENDER_EFFECTS>, failure?: EffectCompileFailure, mode = Camera.PERSPECTIVE_CAMERA,
): SpatialStage[] {
  return spatialChain(effects, mode).build(failure);
}

/** A Scene planning `effects`, whose `build` creates the chain's stages as each graph build does. */
function spatialChain(effects: Partial<typeof DEFAULT_RENDER_EFFECTS>, mode = Camera.PERSPECTIVE_CAMERA) {
  const engine = new NullEngine();
  // The spatial chain needs four float targets and depth sampling.
  Object.assign(engine.getCaps(), {
    maxDrawBuffers: 4, drawBuffersExtension: true, depthTextureExtension: true,
    textureHalfFloatRender: true, textureFloatRender: true, texelFetch: true,
  });
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 2, -6), scene);
  camera.mode = mode;
  // High is the lowest Post Processing tier that allows every screen-space effect.
  updateSceneRenderingSettings(scene, {
    mode: "pbr", effects: { ...DEFAULT_RENDER_EFFECTS, ...effects }, quality: normalizeRenderingQuality(qualityPresetPatch("high")),
  });
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  return {
    engine,
    build: (failure?: EffectCompileFailure) => {
      const stages = createSpatialStages(scene, camera, sceneRenderingSettings(scene).effectsPlan!, 64, 64, failure);
      disposers.push(() => { for (const stage of stages) stage.wrapper.dispose(); });
      return stages;
    },
  };
}

const named = (stages: SpatialStage[], name: string) => stages.findIndex((stage) => stage.name === name);

const OCCLUSION = { ambientOcclusion: { ...DEFAULT_RENDER_EFFECTS.ambientOcclusion, enabled: true } };
const REFLECTIONS = { reflections: { ...DEFAULT_RENDER_EFFECTS.reflections, enabled: true } };
const FOG = { volumetricLighting: { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true } };

/** The chain's compose and what it samples, by the names of the stages that write them. */
function compose(stages: SpatialStage[]) {
  const composes = stages.filter((stage) => stage.scale === 1);
  const stage = composes[0]!;
  return {
    stage,
    full: composes.map((each) => each.name),
    reads: Object.fromEntries(Object.entries(stage.reads ?? {}).map(([sampler, index]) => [sampler, stages[index]!.name])),
  };
}

it("composes occlusion, reflections and fog onto the scene colour in one full-resolution stage, after every effect's own stages", () => {
  const stages = stagesFor({ ...OCCLUSION, ...REFLECTIONS, ...FOG });
  const { stage, full, reads } = compose(stages);
  expect(full).toEqual(["Scene Effects Compose"]);
  expect(stages[stages.length - 1]).toBe(stage);
  expect(stage).toMatchObject({ source: "scene", color: true, idle: undefined });
  expect(reads).toEqual({
    aoSampler: "Scene Ambient Occlusion Blur Y",
    reflectionSampler: "Scene Reflections Blur Y",
    fogSampler: "Scene Volumetric Lighting",
  });
  // Reflections trace the scene colour before occlusion: the compose applies both at once.
  expect(stages[named(stages, "Scene Reflections")]!.source).toBe("scene");
});

it.each([
  ["occlusion", OCCLUSION, { aoSampler: "Scene Ambient Occlusion Blur Y" }],
  ["reflections", REFLECTIONS, { reflectionSampler: "Scene Reflections Blur Y" }],
  ["fog", FOG, { fogSampler: "Scene Volumetric Lighting" }],
  ["occlusion and fog", { ...OCCLUSION, ...FOG }, { aoSampler: "Scene Ambient Occlusion Blur Y", fogSampler: "Scene Volumetric Lighting" }],
] as const)("composes %s alone in the same one stage, sampling only its own results", (_name, effects, expected) => {
  const stages = stagesFor(effects);
  const { stage, full, reads } = compose(stages);
  expect(full).toEqual(["Scene Effects Compose"]);
  expect(reads).toEqual(expected);
  // Fog alone composes nothing while its march idles, so the compose skips with it (one condition, evaluated once);
  // beside another effect it runs and leaves the fog out.
  const march = stages[named(stages, "Scene Volumetric Lighting")];
  expect(stage.idle).toBe("aoSampler" in expected || "reflectionSampler" in expected ? undefined : march?.idle);
});

it("reads each depth texel the occlusion and fog upsamples share once, and only where they are at one resolution", () => {
  const depthReads = (effects: Partial<typeof DEFAULT_RENDER_EFFECTS>) => {
    const wrapper = compose(stagesFor(effects)).stage.wrapper!;
    const fragment = ShaderStore.ShadersStore[`${wrapper.options.fragmentShader}FragmentShader`]!;
    return fragment.match(/texture2D\(depthSampler/g)?.length ?? 0;
  };
  // The centre and four taps, for both upsamples.
  expect(depthReads({ ...OCCLUSION, ...FOG })).toBe(5);
  // The fog at another resolution taps other texels: its own four reads and centre stay.
  const coarseFog = { volumetricLighting: { ...FOG.volumetricLighting, resolutionScale: FOG.volumetricLighting.resolutionScale / 2 } };
  expect(depthReads({ ...OCCLUSION, ...coarseFog })).toBe(10);
});

it("declares in the compose exactly the uniforms and samplers its Effect binds", () => {
  const stages = stagesFor({ ...OCCLUSION, ...REFLECTIONS, ...FOG });
  const wrapper = compose(stages).stage.wrapper!;
  const uniforms = wrapper.options.uniforms.filter((name) => name !== "scale").sort();
  const samplers = wrapper.options.samplers.sort();
  const fragment = ShaderStore.ShadersStore[`${wrapper.options.fragmentShader}FragmentShader`]!;
  const glsl = [...fragment.matchAll(/uniform\s+(?:highp\s+)?(\w+)\s+(\w+)/g)];
  expect(glsl.filter(([, type]) => !type!.startsWith("sampler")).map(([, , name]) => name).sort()).toEqual(uniforms);
  expect(glsl.filter(([, type]) => type!.startsWith("sampler")).map(([, , name]) => name).sort()).toEqual(samplers);
});

it("links each stage's program once: a chain built again draws the same Effects, and stages of one code share one", () => {
  const chain = spatialChain({
    ambientOcclusion: { ...DEFAULT_RENDER_EFFECTS.ambientOcclusion, enabled: true },
    volumetricLighting: { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true },
  });
  const first = chain.build();
  // A load builds its view's graph more than once; each build creates the chain's stages again.
  const again = chain.build();
  const effect = (stages: SpatialStage[], name: string) => stages[named(stages, name)]!.wrapper.effect;
  for (const name of ["Scene Ambient Occlusion", "Scene Ambient Occlusion Blur X", "Scene Volumetric Lighting",
    "Scene Effects Compose"]) {
    expect(effect(again, name)).toBe(effect(first, name));
  }
  // The two blur directions differ only in a uniform.
  expect(effect(first, "Scene Ambient Occlusion Blur Y")).toBe(effect(first, "Scene Ambient Occlusion Blur X"));
});

it("reports a shared stage's failure to every chain that draws it, not only to the first", async () => {
  vi.useFakeTimers();
  try {
    const chain = spatialChain({ volumetricLighting: { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true } });
    // NullEngine has no driver: only a parallel-compile driver's pending query is modelled, and the link then fails.
    let linkFails = false;
    const prepare = chain.engine._preparePipelineContextAsync.bind(chain.engine);
    vi.spyOn(chain.engine, "_preparePipelineContextAsync").mockImplementation((...args) => {
      (args[0] as WebGLPipelineContext).isParallelCompiled = true;
      return prepare(...args);
    });
    vi.spyOn(chain.engine, "_isRenderingStateCompiled").mockImplementation(() => {
      if (linkFails) throw new Error("link failed");
      return false;
    });
    const first = new EffectCompileFailure(), rebuilt = new EffectCompileFailure();
    chain.build(first);
    chain.build(rebuilt);
    linkFails = true;
    await vi.advanceTimersByTimeAsync(32);
    expect(first.message ?? "").toContain("Scene Volumetric Lighting failed to compile");
    expect(rebuilt.message ?? "").toContain("Scene Volumetric Lighting failed to compile");
  } finally {
    vi.useRealTimers();
  }
});

it("reports a failed volumetric march as the chain's compile failure", () => {
  const failure = new EffectCompileFailure();
  const stages = stagesFor({ volumetricLighting: { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true } }, failure);
  const march = stages[named(stages, "Scene Volumetric Lighting")]!.wrapper.effect;
  // Babylon reports a shader error through the Effect's onError once its fallbacks are exhausted.
  march.onError?.(march, "march failed");
  expect(failure.message).toBe("Scene Volumetric Lighting failed to compile: march failed");
});

it("declares in the volumetric march exactly the uniforms and samplers its Effect binds", () => {
  const stages = stagesFor({ volumetricLighting: { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true, maxLights: 4 } });
  const march = stages[named(stages, "Scene Volumetric Lighting")]!.wrapper!;
  // Babylon adds the post-process scale (read by its vertex shader) and the source texture (the march reads none).
  const uniforms = march.options.uniforms.filter((name) => name !== "scale").sort();
  const samplers = march.options.samplers.filter((name) => name !== "textureSampler").sort();
  // A march that reads the light block's buffer is drawn from the shader store, which passes Babylon its buffers.
  expect(march.options.useShaderStore).toBe(true);
  const fragment = ShaderStore.ShadersStore[`${march.options.fragmentShader}FragmentShader`]!;
  const glsl = [...fragment.matchAll(/uniform\s+(?:highp\s+)?(\w+)\s+(\w+)/g)];
  expect(glsl.filter(([, type]) => !type!.startsWith("sampler")).map(([, , name]) => name).sort()).toEqual(uniforms);
  expect(glsl.filter(([, type]) => type!.startsWith("sampler")).map(([, , name]) => name).sort()).toEqual(samplers);
  // The scene depth and the atlas; the block's views in its buffer.
  expect(samplers).toEqual(["depthSampler", "hapticShadowAtlas"]);
  expect(march.options.uniformBuffers).toEqual(["HapticLights"]);
  expect(fragment).toContain("uniform HapticLights {");
});

it("gives the orthographic reflection compose the parallel view direction and the orthographic view position its trace uses", async () => {
  const source = async (mode: number) => {
    const stages = stagesFor(REFLECTIONS, undefined, mode);
    const effect = stages[named(stages, "Scene Effects Compose")]!.wrapper.effect;
    await new Promise<void>((resolve) => effect.executeWhenCompiled(() => resolve()));
    return effect.fragmentSourceCode;
  };
  const orthographic = await source(Camera.ORTHOGRAPHIC_CAMERA), perspective = await source(Camera.PERSPECTIVE_CAMERA);
  expect(orthographic).toMatch(/csViewDirection\s*=\s*normalize\(vec3\(0\.0, 0\.0, csPosition\.z\)\)/);
  expect(perspective).toMatch(/csViewDirection\s*=\s*normalize\(csPosition\)/);
  // Babylon's view-position helper (`computeViewPosFromUVDepth`): depth is linear in an orthographic projection.
  expect(orthographic).toMatch(/ndc\.z\s*=\s*projection\[2\]\.z\s*\*\s*depth\s*\+\s*projection\[3\]\.z/);
  expect(perspective).toMatch(/ndc\.z\s*=\s*projection\[2\]\.z\s*\+\s*projection\[3\]\.z\s*\/\s*depth/);
});

it("matches full matrix inverse unprojection and projection for perspective and orthographic frustums", () => {
  const offCenterPersp = Matrix.PerspectiveFovLH(0.9, 16 / 9, 0.1, 200);
  offCenterPersp.setRowFromFloats(2, 0.25, -0.15, offCenterPersp.m[10]!, offCenterPersp.m[11]!);
  const cases: Array<{ name: string; matrix: Matrix; ortho: boolean; rh: boolean }> = [
    { name: "perspective LH", matrix: Matrix.PerspectiveFovLH(0.9, 16 / 9, 0.1, 200), ortho: false, rh: false },
    { name: "perspective RH", matrix: Matrix.PerspectiveFovRH(1.1, 4 / 3, 0.2, 500), ortho: false, rh: true },
    { name: "perspective off-center LH", matrix: offCenterPersp, ortho: false, rh: false },
    { name: "ortho LH", matrix: Matrix.OrthoLH(12, 8, 0.1, 100), ortho: true, rh: false },
    { name: "ortho RH", matrix: Matrix.OrthoOffCenterRH(-6, 6, -4, 4, 0.1, 100), ortho: true, rh: true },
    { name: "ortho off-center LH", matrix: Matrix.OrthoOffCenterLH(-3, 9, -2, 6, 0.1, 100), ortho: true, rh: false },
    { name: "ortho off-center RH", matrix: Matrix.OrthoOffCenterRH(-3, 9, -2, 6, 0.1, 100), ortho: true, rh: true },
  ];
  for (const { name, matrix, ortho, rh } of cases) {
    const inv = matrix.clone().invert();
    const { unproject, project, zSign } = projectionUnprojectParams(matrix, ortho, rh);
    for (const [u, v, depth] of [[0.15, 0.25, 1.5], [0.5, 0.5, 12], [0.87, 0.73, 42]] as const) {
      const ndc = new Vector3(u * 2 - 1, v * 2 - 1, 0.5);
      const ref4 = Vector4.TransformCoordinates(ndc, inv);
      const refRay = new Vector3(ref4.x / ref4.w, ref4.y / ref4.w, ref4.z / ref4.w);
      const expected = ortho
        ? new Vector3(refRay.x, refRay.y, depth * (rh ? -1 : 1))
        : refRay.scale(depth / Math.abs(refRay.z));
      const xyX = u * unproject[0] + unproject[2];
      const xyY = v * unproject[1] + unproject[3];
      const actual = new Vector3(ortho ? xyX : xyX * depth, ortho ? xyY : xyY * depth, depth * zSign);
      expect(actual.x, `${name} x`).toBeCloseTo(expected.x, 4);
      expect(actual.y, `${name} y`).toBeCloseTo(expected.y, 4);
      expect(actual.z, `${name} z`).toBeCloseTo(expected.z, 4);

      const clipW = ortho ? 1 : actual.z * zSign;
      const projU = (ortho ? actual.x : actual.x / clipW) * project[0] + project[2];
      const projV = (ortho ? actual.y : actual.y / clipW) * project[1] + project[3];
      expect(projU, `${name} roundtrip u`).toBeCloseTo(u, 4);
      expect(projV, `${name} roundtrip v`).toBeCloseTo(v, 4);
    }
  }
});
