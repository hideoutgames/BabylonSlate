import { afterEach, expect, it, vi } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import { backbufferColorTextureHandle, type FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ThinImageProcessingPostProcess } from "@babylonjs/core/PostProcesses/thinImageProcessingPostProcess";
import { Scene } from "@babylonjs/core/scene";
import { DEFAULT_RENDER_EFFECTS, type RenderEffectsSettings } from "@haptic/core";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { planSceneEffects, sceneEffectsImageProcessingConfiguration } from "./scene-effects";
import { SceneEffectsGraph, type SceneEffectsGraphOptions } from "./scene-effects-graph";
import { FrameGraphBloomBlurTask } from "./bloom-blur-task";
import { DISPLAY_COLOR_SHADER, FrameGraphDisplayColorTask } from "./display-color-task";

const dispose: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (dispose.length) dispose.pop()!();
});

const BLOOM = { enabled: true, threshold: 0.8, weight: 0.3, kernel: 32, scale: 0.5 };
const LINEAR: Partial<RenderEffectsSettings> = { colorPipeline: { mode: "sceneLinear" }, toneMapping: "aces", exposure: 1.5, contrast: 1.2 };
const VIGNETTE: Partial<RenderEffectsSettings> = { vignette: { enabled: true, weight: 2, color: [0.1, 0, 0] } };

/** An in-place blend onto the image before it, as the shared outline composition is: it writes its target and reads none of it. */
class BlendTask extends FrameGraphTask {
  targetTexture!: FrameGraphTextureHandle;
  readonly outputTexture: FrameGraphTextureHandle;
  constructor(graph: FrameGraph) {
    super("Blend", graph);
    this.outputTexture = graph.textureManager.createDanglingHandle();
  }
  override record(): void {
    this._frameGraph.textureManager.resolveDanglingHandle(this.outputTexture, this.targetTexture);
    const pass = this._frameGraph.addRenderPass(this.name);
    pass.setRenderTarget(this.outputTexture);
    pass.setExecuteFunc(() => {});
  }
}

function host() {
  const engine = adaptNullEngineFrameGraph(new NullEngine({ renderWidth: 64, renderHeight: 32, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 1 }));
  const scene = new Scene(engine);
  scene.activeCamera = new FreeCamera("camera", new Vector3(0, 0, -4), scene);
  const graph = new FrameGraph(scene);
  /** Every Effect the Engine is asked for, by fragment shader. */
  const created: Array<{ fragment: string; effect: Effect }> = [];
  const createEffect = engine.createEffect.bind(engine);
  vi.spyOn(engine, "createEffect").mockImplementation((...args: Parameters<typeof engine.createEffect>) => {
    const effect = createEffect(...args);
    const path = args[0] as { fragment?: string; fragmentElement?: string };
    created.push({ fragment: path.fragment ?? path.fragmentElement ?? "", effect });
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
  const fragments = (name: string) => created.filter((entry) => entry.fragment === name).map((entry) => entry.effect);
  /** The names of the textures the graph created (not imported or aliased). */
  const textureNames = () => [...graph.textureManager._textures.values()]
    .filter((entry) => entry && !entry.refHandle).map((entry) => entry!.name);
  return { engine, scene, graph, build, fragments, textureNames };
}

const blend = (graph: FrameGraph) => {
  const tasks: BlendTask[] = [];
  const compose = (source: FrameGraphTextureHandle) => {
    const task = new BlendTask(graph);
    task.targetTexture = source;
    tasks.push(task);
    return { task, outputTexture: task.outputTexture };
  };
  return { tasks, compose };
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
  const { engine, graph, build, fragments } = host();
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
  expect(effect!.getUniformNames()).toEqual(stock.effect.getUniformNames());
  expect(effect!.getSamplers()).toEqual(stock.effect.getSamplers());
  // A second build (a resize) records again without compiling again.
  await graph.buildAsync();
  expect(fragments(DISPLAY_COLOR_SHADER)).toHaveLength(1);
  stock.dispose();
  chain.disposeTasks();
});

it.each([
  ["Display Space bloom alone", { bloom: BLOOM }, "Scene Effects Bloom Merge", true, false],
  ["Display Space bloom and vignette", { ...VIGNETTE, bloom: BLOOM }, "Scene Effects Display Color", true, true],
  ["Scene Linear bloom", { ...LINEAR, bloom: BLOOM }, "Scene Effects Display Color", false, true],
] as const)("keeps %s's merged colour as the merge's target of the source's type held it", async (_, settings, name, unorm8, image) => {
  const { graph, build, fragments } = host();
  const { chain } = build(settings);
  await graph.buildAsync();
  expect(chain.tasks.map((task) => task.name)).toEqual(["Scene Effects Bloom", name]);
  const [effect] = fragments(DISPLAY_COLOR_SHADER);
  // An RGBA8 source's merge target clamped and rounded the merged colour; a half-float one kept it.
  expect(effect!.defines.includes("#define BLOOM_UNORM8\n")).toBe(unorm8);
  expect(effect!.defines.includes("#define DISPLAY_COLOR\n")).toBe(image);
  chain.disposeTasks();
});

it.each([
  ["neither FXAA nor FSR", {}, ["Scene Effects Display Color", "Blend"]],
  ["FXAA", { fxaa: true }, ["Scene Effects Display Color", "Blend", "Scene Effects FXAA"]],
  ["FSR", { upscaling: { enabled: true, renderScale: 0.5, sharpness: 0.2 } },
    ["Scene Effects Display Color", "Blend", "Scene Effects FSR Upscale", "Scene Effects FSR Sharpen"]],
] as const)("blends the caller's composition onto the display image, which is the output with %s after it", async (_, extra, order) => {
  const { graph, build } = host();
  const composition = blend(graph);
  const fsr = "upscaling" in extra;
  const { chain } = build({ ...LINEAR, ...fsr ? { upscaling: extra.upscaling } : {} }, {
    fxaa: "fxaa" in extra, beforeAntialiasing: composition.compose,
    // FSR restores the output size from half of it.
    ...fsr ? { width: 32, height: 16, outputWidth: 64, outputHeight: 32 } : {},
  });
  await graph.buildAsync();
  expect(chain.tasks.map((task) => task.name)).toEqual(order);
  const display = chain.tasks[0] as FrameGraphDisplayColorTask;
  const [task] = composition.tasks;
  // The composition blends onto what the Display Color stage wrote.
  expect(task!.targetTexture).toBe(display.outputTexture);
  const textures = graph.textureManager;
  const last = chain.tasks.at(-1) as FrameGraphDisplayColorTask;
  // Some stage always writes the output; the Display Color stage does only when nothing follows the composition.
  expect(chain.rendersToOutput).toBe(true);
  expect(textures.isBackbufferColor(display.outputTexture)).toBe(order.length === 2);
  expect(chain.outputWriter).toBe(order.length === 2 ? display : last);
  expect(textures.isBackbufferColor(chain.outputTexture)).toBe(true);
  // The stage drawing into the backbuffer covers it whatever depth another pass left there.
  expect((chain.outputWriter as FrameGraphDisplayColorTask).depthTest).toBe(false);
  chain.disposeTasks();
  for (const entry of composition.tasks) entry.dispose();
});

it.each([
  ["the chain ends at the view's size, short of the output", { outputTarget: undefined }],
  ["the chain draws at a scale of the output without FSR", { outputWidth: 128, outputHeight: 64 }],
] as const)("keeps the composition on the display stage's own target when %s", async (_, options) => {
  const { graph, build } = host();
  const composition = blend(graph);
  const { chain } = build(LINEAR, { ...options, beforeAntialiasing: composition.compose });
  await graph.buildAsync();
  const display = chain.tasks[0] as FrameGraphDisplayColorTask;
  expect(chain.rendersToOutput).toBe(false);
  expect(chain.outputWriter).toBeUndefined();
  expect(graph.textureManager.isBackbufferColor(display.outputTexture)).toBe(false);
  // The caller's output copy reads the composed image.
  expect(chain.outputTexture).toBe(composition.tasks[0]!.outputTexture);
  chain.disposeTasks();
  composition.tasks[0]!.dispose();
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
