import { afterEach, expect, it, vi } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { backbufferColorTextureHandle, type FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { ThinImageProcessingPostProcess } from "@babylonjs/core/PostProcesses/thinImageProcessingPostProcess";
import { Scene } from "@babylonjs/core/scene";
import { DEFAULT_RENDER_EFFECTS, type RenderEffectsSettings } from "@haptic/core";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { planSceneEffects, sceneEffectsImageProcessingConfiguration } from "./scene-effects";
import { SceneEffectsGraph, type SceneEffectsGraphOptions } from "./scene-effects-graph";
import { FrameGraphBloomBlurTask } from "./bloom-blur-task";
import { DISPLAY_COLOR_SHADER, FrameGraphDisplayColorTask } from "./display-color-task";
import { SharedOutlineOwner } from "./shared-outline";
import { FrameGraphSharedOutlineTask } from "./shared-outline-task";
import { SHARED_OUTLINE_COMPOSE_SHADER } from "./shared-outline-shaders";
import { SHARED_OUTLINE_STROKE_INCLUDE } from "./shared-outline-stroke";
import { setOutlineContribution } from "./test-support/shared-outline-contributions";

const dispose: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (dispose.length) dispose.pop()!();
});

const BLOOM = { enabled: true, threshold: 0.8, weight: 0.3, kernel: 32, scale: 0.5 };
const LINEAR: Partial<RenderEffectsSettings> = { colorPipeline: { mode: "sceneLinear" }, toneMapping: "aces", exposure: 1.5, contrast: 1.2 };
const VIGNETTE: Partial<RenderEffectsSettings> = { vignette: { enabled: true, weight: 2, color: [0.1, 0, 0] } };

function host() {
  const engine = adaptNullEngineFrameGraph(new NullEngine({ renderWidth: 64, renderHeight: 32, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 1 }));
  const scene = new Scene(engine);
  scene.activeCamera = new FreeCamera("camera", new Vector3(0, 0, -4), scene);
  const graph = new FrameGraph(scene);
  /** Every Effect the Engine is asked for, by fragment shader, with the uniforms and samplers it was asked with. */
  const created: Array<{ fragment: string; effect: Effect; uniforms: string[]; samplers: string[] }> = [];
  const createEffect = engine.createEffect.bind(engine);
  vi.spyOn(engine, "createEffect").mockImplementation((...args: Parameters<typeof engine.createEffect>) => {
    const effect = createEffect(...args);
    const path = args[0] as { fragment?: string; fragmentElement?: string };
    const options = args[1] as { uniformsNames?: string[]; samplers?: string[] };
    created.push({ fragment: path.fragment ?? path.fragmentElement ?? "", effect,
      uniforms: [...options.uniformsNames ?? []], samplers: [...options.samplers ?? []] });
    return effect;
  });
  dispose.push(() => { graph.dispose(); scene.dispose(); engine.dispose(); });
  const build = (settings: Partial<RenderEffectsSettings>, options: Partial<SceneEffectsGraphOptions> & { fxaa?: boolean } = {}) => {
    const effects = { ...DEFAULT_RENDER_EFFECTS, ...settings };
    const plan = planSceneEffects(effects, "pbr", true, { fxaa: options.fxaa })!;
    const chain = new SceneEffectsGraph({
      frameGraph: graph, plan, effects, width: 64, height: 32, outputTarget: backbufferColorTextureHandle, ...options,
    });
    for (const task of chain.tasks) graph.addTask(task);
    return { plan, chain };
  };
  const requests = (name: string) => created.filter((entry) => entry.fragment === name);
  const fragments = (name: string) => requests(name).map((entry) => entry.effect);
  /** The names of the textures the graph created (not imported or aliased). */
  const textureNames = () => [...graph.textureManager._textures.values()]
    .filter((entry) => entry && !entry.refHandle).map((entry) => entry!.name);
  return { engine, scene, graph, build, fragments, requests, textureNames };
}

/**
 * A shared outline view outlining a box in each group (strict, through, selection), and the chain's `outlines` factory,
 * which creates the task in the mode the chain asks for, as the view's coordinator does.
 */
const outlined = (scene: Scene, graph: FrameGraph) => {
  Object.assign(scene.getEngine().getCaps(), { textureFloatRender: true, textureHalfFloatRender: true });
  const view = SharedOutlineOwner.forScene(scene).createView("test");
  const box = (name: string) => MeshBuilder.CreateBox(name, {}, scene);
  setOutlineContribution(view, "component", { kind: "component", color: [1, 0, 0], width: 2, targets: [{ key: "strict", meshes: [box("strict")] }] });
  setOutlineContribution(view, "through", { kind: "component", color: [0, 1, 0], width: 2, throughMeshes: true,
    targets: [{ key: "through", meshes: [box("through")] }] });
  setOutlineContribution(view, "selection", { kind: "selection", color: [1, 1, 0], width: 2,
    targets: [{ key: "selected", meshes: [box("selected")] }] });
  const tasks: FrameGraphSharedOutlineTask[] = [];
  const outlines = (externalCompose: boolean) => {
    const task = new FrameGraphSharedOutlineTask("Shared outlines", graph, view, { externalCompose });
    task.camera = scene.activeCamera!;
    tasks.push(task);
    return task;
  };
  dispose.push(() => { for (const task of tasks) task.dispose(); view.dispose(); });
  return { view, tasks, outlines };
};

it("merges bloom inside the Display Color pass: three blur passes, one full-size pass, no merge target", async () => {
  const { graph, build, fragments, textureNames } = host();
  const { chain } = build({ ...LINEAR, bloom: BLOOM });
  await graph.buildAsync();
  expect(chain.tasks.map((task) => task.name)).toEqual(["Scene Effects Bloom", "Scene Effects Display Color"]);
  const [bloom, display] = chain.tasks as [FrameGraphBloomBlurTask, FrameGraphDisplayColorTask];
  expect(bloom.passes.map((pass) => pass.name)).toEqual(
    ["Scene Effects Bloom Downscale", "Scene Effects Bloom Blur X", "Scene Effects Bloom Blur Y"]);
  expect(display.passes.map((pass) => pass.name)).toEqual(["Scene Effects Display Color"]);
  // The pass reads bloom's blurred highlights at bloom's size and draws straight into the output.
  expect(display.bloomTexture).toBe(bloom.outputTexture);
  expect(graph.textureManager.getTextureDescription(bloom.outputTexture).size).toEqual({ width: 32, height: 16 });
  expect(chain.rendersToOutput).toBe(true);
  expect(chain.outputWriter).toBe(display);
  expect(textureNames().filter((name) => name.includes("Merge"))).toEqual([]);
  // One effect for the whole stage, its merge included; no stock merge or image-processing effect, and each blur
  // compiled once, at its final kernel.
  expect(fragments(DISPLAY_COLOR_SHADER)).toHaveLength(1);
  expect(fragments(DISPLAY_COLOR_SHADER)[0]!.defines).toContain("#define BLOOM\n");
  expect(fragments("bloomMerge")).toEqual([]);
  expect(fragments("imageProcessing")).toEqual([]);
  expect(fragments("kernelBlur")).toHaveLength(2);
  expect(fragments("extractHighlights")).toHaveLength(1);
  chain.disposeTasks();
});

it.each([
  ["Scene Linear", LINEAR, true],
  ["Display Space with a vignette", VIGNETTE, false],
  ["Scene Linear with white balance and a vignette", {
    ...LINEAR, ...VIGNETTE, whiteBalance: { enabled: true, temperature: 4000, tint: 0.2 },
  }, true],
] as const)("compiles image processing alone (%s) once, with Babylon's image-processing defines, uniforms and samplers", async (_, settings, linear) => {
  const { engine, graph, build, fragments, requests } = host();
  const { plan, chain } = build(settings);
  expect(fragments(DISPLAY_COLOR_SHADER)).toEqual([]);
  await graph.buildAsync();
  // Built from the configuration and linear option the stock pass takes, compiled once for the source it reads.
  const effects = fragments(DISPLAY_COLOR_SHADER);
  expect(effects).toHaveLength(1);
  const [effect] = effects;
  expect((chain.tasks[0] as FrameGraphDisplayColorTask).drawWrapper.effect).toBe(effect);
  expect(effect!.defines.includes("#define FROMLINEARSPACE;")).toBe(linear);
  const stock = new ThinImageProcessingPostProcess("stock", engine, {
    imageProcessingConfiguration: sceneEffectsImageProcessingConfiguration({ ...DEFAULT_RENDER_EFFECTS, ...settings }, plan.imageProcessing!),
  });
  stock.fromLinearSpace = linear;
  expect(effect!.defines).toBe(`#define DISPLAY_COLOR\n${stock.effect.defines}`);
  const [own] = requests(DISPLAY_COLOR_SHADER);
  const reference = requests("imageProcessing").at(-1)!;
  expect(reference.effect).toBe(stock.effect);
  expect([own!.uniforms, own!.samplers]).toEqual([reference.uniforms, reference.samplers]);
  // A second build (a resize) records again without compiling again.
  await graph.buildAsync();
  expect(fragments(DISPLAY_COLOR_SHADER)).toHaveLength(1);
  stock.dispose();
  chain.disposeTasks();
});

it.each([
  ["Display Space bloom alone", { bloom: BLOOM }, "Scene Effects Bloom Merge", "BLOOM_UNORM8", false],
  ["Display Space bloom and vignette", { ...VIGNETTE, bloom: BLOOM }, "Scene Effects Display Color", "BLOOM_UNORM8", true],
  ["Scene Linear bloom", { ...LINEAR, bloom: BLOOM }, "Scene Effects Display Color", "BLOOM_HALF_FLOAT", true],
] as const)("keeps %s's merged colour as the merge's target of the source's type held it", async (_, settings, name, held, image) => {
  const { graph, build, fragments } = host();
  const { chain } = build(settings);
  await graph.buildAsync();
  expect(chain.tasks.map((task) => task.name)).toEqual(["Scene Effects Bloom", name]);
  const [effect] = fragments(DISPLAY_COLOR_SHADER);
  // An RGBA8 source's merge target clamped and rounded the merged colour; a half-float one rounded it to half floats.
  expect(effect!.defines.match(/BLOOM_(UNORM8|HALF_FLOAT)/g)).toEqual([held]);
  expect(effect!.defines.includes("#define DISPLAY_COLOR\n")).toBe(image);
  chain.disposeTasks();
});

const FSR = { upscaling: { enabled: true, renderScale: 0.5, sharpness: 0.2 } };

it.each([
  ["neither FXAA nor FSR", {}, ["Scene Effects Display Color"], "OUTLINE_UNORM8"],
  ["FXAA", { fxaa: true }, ["Scene Effects Display Color", "Scene Effects FXAA"], "OUTLINE_HALF_FLOAT"],
  ["FSR", FSR, ["Scene Effects Display Color", "Scene Effects FSR Upscale", "Scene Effects FSR Sharpen"], "OUTLINE_HALF_FLOAT"],
] as const)("composites the outline stroke inside the Display Color pass with %s after it: the masks, then one full-size pass", async (_, extra, after, stored) => {
  const { scene, graph, build, fragments, requests } = host();
  const { tasks, outlines } = outlined(scene, graph);
  const fsr = "upscaling" in extra;
  const { chain } = build({ ...LINEAR, bloom: BLOOM, ...fsr ? { upscaling: extra.upscaling } : {} }, {
    fxaa: "fxaa" in extra, outlines,
    // FSR restores the output size from half of it.
    ...fsr ? { width: 32, height: 16, outputWidth: 64, outputHeight: 32 } : {},
  });
  await graph.buildAsync();
  // Bloom's blurs, the outline masks (the task, created composed externally), then the Display Color pass.
  expect(chain.tasks.map((task) => task.name)).toEqual(["Scene Effects Bloom", "Shared outlines", ...after]);
  const [, task, display] = chain.tasks as [FrameGraphBloomBlurTask, FrameGraphSharedOutlineTask, FrameGraphDisplayColorTask];
  expect(tasks).toEqual([task]);
  expect(task!.externalCompose).toBe(true);
  expect(chain.outlines).toBe(task);
  // The outline task records its masks and their clears alone; no composition pass, program or output copy.
  expect(task!.passes.map((pass) => pass.name).filter((name) => !/ (Clear|Mask)$/.test(name))).toEqual([]);
  expect(fragments(SHARED_OUTLINE_COMPOSE_SHADER)).toEqual([]);
  expect(display.passes.map((pass) => pass.name)).toEqual([display.name]);
  // The pass declares every texture the stroke reads, so the masks are drawn before it and live until it has drawn.
  expect(task!.strokeTextures).toHaveLength(4);
  const pass = display.passes[0] as unknown as { _dependencies: Set<FrameGraphTextureHandle> };
  for (const handle of task!.strokeTextures) expect(pass._dependencies.has(handle)).toBe(true);
  // One program: bloom's merge, image processing and the stroke, rounding where a stroke lands as the target it writes
  // stores: the RGBA8 output, or its half-float intermediate (the Scene Linear source's type) before FXAA or FSR.
  const [effect] = fragments(DISPLAY_COLOR_SHADER);
  expect(fragments(DISPLAY_COLOR_SHADER)).toHaveLength(1);
  expect(effect!.defines).toContain("#define OUTLINE\n");
  expect(effect!.defines.match(/OUTLINE_(UNORM8|HALF_FLOAT)/g)).toEqual([stored]);
  const [request] = requests(DISPLAY_COLOR_SHADER);
  expect(request!.samplers).toEqual(expect.arrayContaining(["strictDepth", "strictMask", "throughMask", "selectionMask"]));
  // The pass draws at the masks' size and writes the output only when nothing follows it.
  const textures = graph.textureManager;
  expect(textures.getTextureDescription(display.outputTexture).size).toEqual(textures.getTextureDescription(task!.strokeTextures[0]!).size);
  expect(textures.isBackbufferColor(display.outputTexture)).toBe(after.length === 1);
  expect(chain.outputWriter).toBe(after.length === 1 ? display : chain.tasks.at(-1));
  expect(textures.isBackbufferColor(chain.outputTexture)).toBe(true);
  chain.disposeTasks();
});

it.each([
  ["the chain ends at the view's size, short of the output", { outputTarget: undefined }],
  ["the chain draws at a scale of the output without FSR", { outputWidth: 128, outputHeight: 64 }],
] as const)("composites the stroke on the Display Color pass's own target, at its size, when %s", async (_, options) => {
  const { scene, graph, build, fragments } = host();
  const { outlines } = outlined(scene, graph);
  const { chain } = build(LINEAR, { ...options, outlines });
  await graph.buildAsync();
  expect(chain.tasks.map((task) => task.name)).toEqual(["Shared outlines", "Scene Effects Display Color"]);
  const [task, display] = chain.tasks as [FrameGraphSharedOutlineTask, FrameGraphDisplayColorTask];
  expect(chain.rendersToOutput).toBe(false);
  expect(chain.outputWriter).toBeUndefined();
  const textures = graph.textureManager;
  expect(textures.isBackbufferColor(display.outputTexture)).toBe(false);
  // The caller's output copy reads the pass's own target, the stroke on it; the masks are that target's size.
  expect(chain.outputTexture).toBe(display.outputTexture);
  expect(textures.getTextureDescription(task.strokeTextures[0]!).size).toEqual({ width: 64, height: 32 });
  expect(fragments(DISPLAY_COLOR_SHADER)[0]!.defines).toContain("#define OUTLINE_HALF_FLOAT\n");
  chain.disposeTasks();
});

it.each([
  ["neither FXAA nor FSR", {}, ["Shared outlines"]],
  ["FXAA", { fxaa: true }, ["Shared outlines", "Scene Effects FXAA"]],
] as const)("keeps the outlines' own composition without a Display Color pass, with %s", async (_, options, order) => {
  const { scene, graph, build, fragments } = host();
  const { outlines } = outlined(scene, graph);
  // A Display Space chain of FXAA alone, or of the spatial effects alone (which this Engine cannot draw), has no Display
  // Color pass.
  const settings: Partial<RenderEffectsSettings> = "fxaa" in options ? {} : {
    ambientOcclusion: { ...DEFAULT_RENDER_EFFECTS.ambientOcclusion, enabled: true },
  };
  const { chain } = build(settings, { ...options, outlines });
  await graph.buildAsync();
  expect(chain.tasks.map((task) => task.name)).toEqual(order);
  const task = chain.tasks[0] as FrameGraphSharedOutlineTask;
  expect(task.externalCompose).toBe(false);
  expect(task.passes.map((pass) => pass.name)).toContain("Shared outlines Compose");
  expect(fragments(SHARED_OUTLINE_COMPOSE_SHADER)).toHaveLength(1);
  expect(fragments(DISPLAY_COLOR_SHADER)).toEqual([]);
  // It blends onto the image before it, here the scene colour, which FXAA or the caller's output copy reads after.
  expect(task.targetTexture).toBe(chain.sceneColorTexture);
  expect(chain.outputWriter).toBe("fxaa" in options ? chain.tasks[1] : undefined);
  chain.disposeTasks();
});

const halfFloatOutput = (graph: FrameGraph) => graph.textureManager.createRenderTargetTexture("Half-float output", {
  size: { width: 64, height: 32 }, sizeIsPercentage: false,
  options: { createMipMaps: false, types: [Constants.TEXTURETYPE_HALF_FLOAT], formats: [Constants.TEXTUREFORMAT_RGBA], samples: 1, useSRGBBuffers: [false] },
});

// Where a stroke lands, the pass rounds its result as the target it writes stored it before the blend read it: by the
// target's type, never the source's.
it.each([
  ["the RGBA8 output, over a half-float source", LINEAR, {}, "OUTLINE_UNORM8"],
  ["a half-float output, over an RGBA8 source", VIGNETTE, { output: "half" }, "OUTLINE_HALF_FLOAT"],
  ["its own RGBA8 intermediate before FXAA", VIGNETTE, { fxaa: true }, "OUTLINE_UNORM8"],
  ["its own half-float intermediate before FXAA", LINEAR, { fxaa: true }, "OUTLINE_HALF_FLOAT"],
] as const)("composites the stroke as written into %s", async (_, settings, extra, stored) => {
  const { scene, graph, build, fragments } = host();
  const { outlines } = outlined(scene, graph);
  const { chain } = build(settings, {
    outlines, fxaa: "fxaa" in extra,
    ...("output" in extra ? { outputTarget: halfFloatOutput(graph) } : {}),
  });
  await graph.buildAsync();
  const display = chain.tasks.find((task) => task instanceof FrameGraphDisplayColorTask) as FrameGraphDisplayColorTask;
  const textures = graph.textureManager;
  expect(textures.getTextureCreationOptions(display.outputTexture).options.types?.[0]).toBe(
    stored === "OUTLINE_UNORM8" ? Constants.TEXTURETYPE_UNSIGNED_BYTE : Constants.TEXTURETYPE_HALF_FLOAT);
  expect(fragments(DISPLAY_COLOR_SHADER)[0]!.defines.match(/OUTLINE_(UNORM8|HALF_FLOAT)/g)).toEqual([stored]);
  chain.disposeTasks();
});

it("binds at most ten samplers in the fused pass, none of them its own target", async () => {
  const { scene, graph, requests } = host();
  // The worst case: bloom, a LUT and every outline group, with the strict group's depth.
  const lut = RawTexture.CreateRGBATexture(new Uint8Array(4 * 4 * 4), 4, 4, scene);
  dispose.push(() => lut.dispose());
  const effects = { ...DEFAULT_RENDER_EFFECTS, ...VIGNETTE, bloom: BLOOM, colorGrading: { enabled: true, lutTextureGuid: "lut" } };
  const plan = planSceneEffects(effects, "pbr", true, { fxaa: true, colorGradingTexture: lut })!;
  expect(plan.imageProcessing?.colorGrading).toBe(lut);
  const { outlines } = outlined(scene, graph);
  const chain = new SceneEffectsGraph({ frameGraph: graph, plan, effects, width: 64, height: 32, outputTarget: backbufferColorTextureHandle, outlines });
  for (const task of chain.tasks) graph.addTask(task);
  await graph.buildAsync();
  const [request] = requests(DISPLAY_COLOR_SHADER);
  // Scene colour, the bloom blur, the LUT, three masks, three style tables and the strict depth: within WebGL2's 16.
  expect(request!.samplers).toHaveLength(10);
  expect(new Set(request!.samplers).size).toBe(10);
  // The pass draws into its own intermediate before FXAA; nothing it samples may be that texture.
  const display = chain.tasks.find((task) => task instanceof FrameGraphDisplayColorTask) as FrameGraphDisplayColorTask;
  const textures = graph.textureManager;
  const target = textures.getTextureFromHandle(display.outputTexture);
  expect(target).toBeTruthy();
  for (const handle of [display.sourceTexture!, display.bloomTexture!, ...chain.outlines!.strokeTextures])
    expect(textures.getTextureFromHandle(handle)).not.toBe(target);
  chain.disposeTasks();
});

it("builds the fused and the standalone composition from the one stroke include", async () => {
  const { scene, graph, build } = host();
  const { outlines } = outlined(scene, graph);
  const { chain } = build(LINEAR, { outlines, fxaa: true });
  await graph.buildAsync();
  // Neither shader holds stroke maths of its own: each includes the shared chunk, which defines the stroke.
  const include = `#include<${SHARED_OUTLINE_STROKE_INCLUDE}>`;
  for (const name of [DISPLAY_COLOR_SHADER, SHARED_OUTLINE_COMPOSE_SHADER]) {
    const source = ShaderStore.ShadersStore[`${name}PixelShader`]!;
    expect(source.split(include)).toHaveLength(2);
    expect(source).not.toContain("decodeId(");
  }
  expect(ShaderStore.IncludesShadersStore[SHARED_OUTLINE_STROKE_INCLUDE]).toContain(`vec4 ${SHARED_OUTLINE_STROKE_INCLUDE}(vec2 pixelUV)`);
  chain.disposeTasks();
});

it("compiles again only when a configuration change changes the defines, and releases every effect it compiled", async () => {
  const { graph, build, fragments } = host();
  const { chain } = build({ ...LINEAR, bloom: BLOOM });
  await graph.buildAsync();
  const [bloom, display] = chain.tasks as [FrameGraphBloomBlurTask, FrameGraphDisplayColorTask];
  const configuration = display.postProcess.imageProcessing!.configuration;
  const blurs = bloom.effects;
  // A uniform: bound each frame, no new program.
  configuration.exposure = 2;
  expect(fragments(DISPLAY_COLOR_SHADER)).toHaveLength(1);
  // A define: a new program, the replaced one retired.
  configuration.vignetteEnabled = true;
  const [first, second] = fragments(DISPLAY_COLOR_SHADER);
  expect(second).toBeDefined();
  expect(second!.defines).toContain("#define VIGNETTE;");
  expect(display.drawWrapper.effect).toBe(second);
  expect(configuration.applyByPostProcess).toBe(true);
  chain.disposeTasks();
  await chain.whenReleased();
  for (const effect of [first, second, ...blurs]) expect(effect!.isDisposed).toBe(true);
  // The configuration is the pass's own: it no longer reads as applied by a post process.
  expect(configuration.applyByPostProcess).toBe(false);
  configuration.vignetteEnabled = false;
  expect(fragments(DISPLAY_COLOR_SHADER)).toHaveLength(2);
});

it("rejects a Display Color pass with no stage and one whose bloom has no blurred highlights", async () => {
  const { graph } = host();
  expect(() => new FrameGraphDisplayColorTask("Empty", graph, { bloom: null, imageProcessing: null })).toThrow("bloom or image processing");
  const merge = new FrameGraphDisplayColorTask("Merge", graph, { bloom: { weight: 1 }, imageProcessing: null });
  merge.sourceTexture = graph.textureManager.createRenderTargetTexture("Source", {
    size: { width: 4, height: 4 }, sizeIsPercentage: false,
    options: { createMipMaps: false, types: [Constants.TEXTURETYPE_UNSIGNED_BYTE], formats: [Constants.TEXTUREFORMAT_RGBA], samples: 1, useSRGBBuffers: [false] },
  });
  graph.addTask(merge);
  await expect(graph.buildAsync()).rejects.toThrow("bloomTexture is required");
  merge.dispose();
});
