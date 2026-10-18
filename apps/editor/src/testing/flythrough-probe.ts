/**
 * Test-build-only fly-through probe for camera-motion stutter. It flies the
 * editor camera along a scripted path at a fixed speed, the way the viewport
 * joystick and WASD keys move it (a pose change plus a camera invalidation per
 * animation frame while a continuous render lease is held), and records, per
 * rendered frame, the discrete events camera motion can trigger: new Effects
 * and shader programs or WebGPU pipelines, bind groups, buffers, texture
 * uploads, material and define invalidations, readiness probes, held frames,
 * shadow generator churn, enabled-light changes and visible-set churn.
 *
 * Counts are hardware-independent; timings on software adapters are not
 * device performance. The e2e route (`e2e/feature-test-flythrough-route.spec.ts`)
 * analyses the frames; this module only records them.
 */
import {
  Material,
  MaterialDefines,
  NodeMaterial,
  PBRBaseMaterial,
  ShaderMaterial,
  ShadowGenerator,
  StandardMaterial,
  Vector3,
  type AbstractEngine,
  type AbstractMesh,
  type Light,
  type Scene,
} from "@babylonjs/core";
import type { EngineHandle } from "@babylonslate/render";

export type FlyVec3 = [number, number, number];

export interface FlyThroughOptions {
  /** Polyline the camera eye follows, in scene coordinates. At least two points. */
  waypoints: FlyVec3[];
  /** Metres per second along the path. Default 8 (the editor's default fly speed). */
  speed?: number;
  /** Times the path is flown. Default 2: the first flight, then the same path again. */
  passes?: number;
  /** Hold at the start pose before the first pass. Default 5000 ms. */
  warmupMs?: number;
  /** Hold at the start pose between passes. Default 1500 ms. */
  resetMs?: number;
  /** Metres ahead on the path the camera looks at. Default max(4, speed * 0.75). */
  lookAhead?: number;
  /** Metres the look target sits below the path, for a slight downward view. Default 1. */
  lookDrop?: number;
  /** Detail log entries kept per kind. Default 300. */
  logLimit?: number;
  /** Stacks captured per log kind. Default 40. */
  stackLimit?: number;
}

export type FlyPhase = "warmup" | "reset" | `pass${number}`;

export interface FlyFrame {
  /** Rendered-frame index within the run. */
  i: number;
  phase: FlyPhase;
  /** Engine frame begin and end, page `performance.now()` ms. */
  begin: number;
  end: number;
  /** Main-thread time of the Engine frame that drew the view (begin → end). */
  cpuMs: number;
  /** Time since the previous recorded frame ended. */
  intervalMs: number | null;
  /** Engine frames that did not draw this view since the previous record. */
  skipped: number;
  /** Camera eye, rounded to centimetres. */
  pos: FlyVec3;
  /** Non-zero event counters since the previous recorded frame (see the counter keys in the report). */
  c: Record<string, number>;
  activeMeshes: number;
  activeAdded: number;
  activeRemoved: number;
  drawCalls: number;
  shadowDrawCalls: number;
  enabledLights: number;
  lodReduced: number;
  compiledEffects: number;
  engineTextures: number;
  /** `performance.memory.usedJSHeapSize` in MiB, when the browser exposes it. */
  heapMb: number | null;
}

export interface FlyLogEntry {
  frame: number;
  kind: string;
  detail: string;
  stack?: string;
}

export interface FlyThroughResult {
  backend: "webgpu" | "webgl2";
  adapter: unknown;
  caps: Record<string, unknown>;
  pathLength: number;
  speed: number;
  phases: Array<{ phase: FlyPhase; startMs: number; endMs: number; firstFrame: number; lastFrame: number }>;
  frames: FlyFrame[];
  log: FlyLogEntry[];
  longTasks: Array<[number, number]>;
  lights: Array<Record<string, unknown>>;
  qualityLimitsBefore: string[];
  qualityLimitsAfter: string[];
  pipeline: unknown;
  /** Counter totals over the whole run, including frames outside passes. */
  totals: Record<string, number>;
  instrumented: string[];
}

type AnyFunction = (...args: unknown[]) => unknown;
type Restore = () => void;

const MATERIAL_FLAGS: Array<[number, string]> = [
  [Material.TextureDirtyFlag, "texture"],
  [Material.LightDirtyFlag, "light"],
  [Material.FresnelDirtyFlag, "fresnel"],
  [Material.AttributesDirtyFlag, "attributes"],
  [Material.MiscDirtyFlag, "misc"],
  [Material.PrePassDirtyFlag, "prepass"],
  [Material.ImageProcessingDirtyFlag, "imageProcessing"],
];

const DEFINE_MARKS: Array<[string, string]> = [
  ["markAsLightDirty", "defines.light"],
  ["markAsTexturesDirty", "defines.texture"],
  ["markAsAttributesDirty", "defines.attributes"],
  ["markAsMiscDirty", "defines.misc"],
  ["markAsFresnelDirty", "defines.fresnel"],
  ["markAsImageProcessingDirty", "defines.imageProcessing"],
  ["markAsPrePassDirty", "defines.prepass"],
  ["markAllAsDirty", "defines.all"],
  ["markAsUnprocessed", "defines.unprocessed"],
  ["markAsProcessed", "defines.processed"],
];

const GL_METHODS: Array<[string, string]> = [
  ["linkProgram", "gl.link"],
  ["compileShader", "gl.compile"],
  ["getProgramParameter", "gl.programParameter"],
  ["getShaderParameter", "gl.shaderParameter"],
  ["texImage2D", "gl.texUpload"],
  ["texSubImage2D", "gl.texUpload"],
  ["texImage3D", "gl.texUpload"],
  ["texSubImage3D", "gl.texUpload"],
  ["compressedTexImage2D", "gl.texUpload"],
  ["compressedTexSubImage2D", "gl.texUpload"],
  ["texStorage2D", "gl.texStorage"],
  ["generateMipmap", "gl.mipmap"],
  ["createTexture", "gl.createTexture"],
  ["createBuffer", "gl.createBuffer"],
  ["bufferData", "gl.bufferData"],
  ["createFramebuffer", "gl.createFramebuffer"],
  ["readPixels", "gl.readPixels"],
  ["getBufferSubData", "gl.getBufferSubData"],
  ["getError", "gl.getError"],
  ["clientWaitSync", "gl.clientWaitSync"],
  ["finish", "gl.finish"],
];

const GPU_DEVICE_METHODS: Array<[string, string]> = [
  ["createRenderPipeline", "gpu.pipeline"],
  ["createRenderPipelineAsync", "gpu.pipelineAsync"],
  ["createComputePipeline", "gpu.computePipeline"],
  ["createShaderModule", "gpu.shaderModule"],
  ["createBindGroup", "gpu.bindGroup"],
  ["createBindGroupLayout", "gpu.bindGroupLayout"],
  ["createPipelineLayout", "gpu.pipelineLayout"],
  ["createBuffer", "gpu.buffer"],
  ["createTexture", "gpu.texture"],
  ["createSampler", "gpu.sampler"],
];

const GPU_QUEUE_METHODS: Array<[string, string]> = [
  ["writeTexture", "gpu.writeTexture"],
  ["copyExternalImageToTexture", "gpu.copyExternalImage"],
  ["writeBuffer", "gpu.writeBuffer"],
];

function wrapMethod(
  target: object,
  key: string,
  restores: Restore[],
  make: (original: AnyFunction) => AnyFunction,
): boolean {
  const owner = target as Record<string, unknown>;
  const original = owner[key];
  if (typeof original !== "function") return false;
  const hadOwn = Object.prototype.hasOwnProperty.call(owner, key);
  owner[key] = make(original as AnyFunction);
  restores.push(() => {
    if (hadOwn) owner[key] = original;
    else delete owner[key];
  });
  return true;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function captureStack(): string {
  const errorType = Error as unknown as { stackTraceLimit?: number };
  const limit = errorType.stackTraceLimit;
  errorType.stackTraceLimit = 24;
  const text = new Error().stack ?? "";
  errorType.stackTraceLimit = limit;
  return text
    .split("\n")
    .slice(3)
    .map((line) => line.trim().replace(/^at /, "").replace(/https?:\/\/[^/]+\//g, ""))
    .join(" | ");
}

function effectBaseName(baseName: unknown): string {
  if (typeof baseName === "string") return baseName;
  if (!baseName || typeof baseName !== "object") return String(baseName);
  const value = baseName as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) if (typeof value[key] === "string") return (value[key] as string).slice(0, 80);
    return "?";
  };
  return `${pick("vertexToken", "vertex", "vertexElement")}+${pick("fragmentToken", "fragment", "fragmentElement")}`;
}

/** Polyline arc-length sampling. */
function createPath(points: FlyVec3[]) {
  const vectors = points.map((point) => Vector3.FromArray(point));
  const cumulative = [0];
  for (let index = 1; index < vectors.length; index += 1)
    cumulative.push(cumulative[index - 1]! + Vector3.Distance(vectors[index - 1]!, vectors[index]!));
  const length = cumulative[cumulative.length - 1]!;
  const at = (distance: number, out: Vector3): Vector3 => {
    const clamped = Math.min(length, Math.max(0, distance));
    let segment = 1;
    while (segment < cumulative.length - 1 && cumulative[segment]! < clamped) segment += 1;
    const start = cumulative[segment - 1]!;
    const span = cumulative[segment]! - start;
    const t = span > 0 ? (clamped - start) / span : 0;
    Vector3.LerpToRef(vectors[segment - 1]!, vectors[segment]!, t, out);
    return out;
  };
  return { length, at, end: vectors[vectors.length - 1]!, beforeEnd: vectors[vectors.length - 2]! };
}

function activeMeshIds(scene: Scene, into: Set<number>): number {
  into.clear();
  const active = scene.getActiveMeshes();
  for (let index = 0; index < active.length; index += 1) {
    const mesh = active.data[index] as AbstractMesh | undefined;
    if (mesh) into.add(mesh.uniqueId);
  }
  return active.length;
}

function enabledLightNames(scene: Scene): string[] {
  const names: string[] = [];
  for (const light of scene.lights) if (light.isEnabled()) names.push(light.name);
  return names;
}

function lightGenerators(light: Light): ShadowGenerator[] {
  const generators = light.getShadowGenerators?.();
  if (!generators) return [];
  const list: ShadowGenerator[] = [];
  for (const generator of generators.values())
    if (generator instanceof ShadowGenerator) list.push(generator);
  return list;
}

/**
 * Fly the editor camera along `options.waypoints` and record every rendered
 * frame of the view. Instrumentation is installed for the run only and removed
 * before the promise settles.
 */
export async function runFlyThrough(handle: EngineHandle, options: FlyThroughOptions): Promise<FlyThroughResult> {
  const controller = handle.editor?.camera;
  if (!controller || controller.mode !== "3d") throw new Error("Fly-through needs the 3D editor camera.");
  if (options.waypoints.length < 2) throw new Error("Fly-through needs at least two waypoints.");
  const camera = controller.camera;
  const scene = handle.scene;
  const engine: AbstractEngine = handle.engine;
  const internals = engine as unknown as Record<string, unknown>;
  const speed = options.speed && options.speed > 0 ? options.speed : 8;
  const passes = Math.max(1, Math.floor(options.passes ?? 2));
  const warmupMs = Math.max(0, options.warmupMs ?? 5000);
  const resetMs = Math.max(0, options.resetMs ?? 1500);
  const lookAhead = options.lookAhead ?? Math.max(4, speed * 0.75);
  const lookDrop = options.lookDrop ?? 1;
  const logLimit = options.logLimit ?? 300;
  const stackLimit = options.stackLimit ?? 40;
  const path = createPath(options.waypoints);
  const passMs = (path.length / speed) * 1000;

  const restores: Restore[] = [];
  const instrumented: string[] = [];
  const pending: Record<string, number> = {};
  const totals: Record<string, number> = {};
  const bump = (key: string, amount = 1) => {
    pending[key] = (pending[key] ?? 0) + amount;
    totals[key] = (totals[key] ?? 0) + amount;
  };
  const log: FlyLogEntry[] = [];
  const logCounts = new Map<string, number>();
  const stackCounts = new Map<string, number>();
  let frameIndex = 0;
  const record = (kind: string, detail: string, withStack = false) => {
    const count = logCounts.get(kind) ?? 0;
    if (count >= logLimit) return;
    logCounts.set(kind, count + 1);
    const entry: FlyLogEntry = { frame: frameIndex, kind, detail };
    if (withStack) {
      const stacks = stackCounts.get(kind) ?? 0;
      if (stacks < stackLimit) {
        stackCounts.set(kind, stacks + 1);
        entry.stack = captureStack();
      }
    }
    log.push(entry);
  };
  const inScene = (material: Material) => {
    try {
      return material.getScene() === scene;
    } catch {
      return false;
    }
  };

  // Effects: requests, and new Effects (an engine cache miss starts a compile).
  const seenEffects = new WeakSet<object>();
  for (const effect of Object.values((internals._compiledEffects ?? {}) as Record<string, object>)) seenEffects.add(effect);
  if (wrapMethod(engine, "createEffect", restores, (original) => function (this: unknown, ...args: unknown[]) {
    const effect = original.apply(this, args);
    bump("effect.request");
    if (effect && typeof effect === "object" && !seenEffects.has(effect)) {
      seenEffects.add(effect);
      bump("effect.new");
      const effectOptions = args[1] as Record<string, unknown> | undefined;
      const defines = (typeof args[4] === "string" ? args[4] : effectOptions?.defines) as string | undefined;
      record("effect", `${effectBaseName(args[0])} @ ${(defines ?? "").replace(/\n/g, " ").replace(/#define /g, "").trim()}`, true);
    }
    return effect;
  })) instrumented.push("engine.createEffect");

  // Backend object creation and uploads.
  const gl = internals._gl as Record<string, unknown> | undefined;
  if (gl && !engine.isWebGPU) {
    for (const [method, key] of GL_METHODS)
      if (wrapMethod(gl, method, restores, (original) => function (this: unknown, ...args: unknown[]) {
        bump(key);
        return original.apply(this, args);
      })) instrumented.push(`gl.${method}`);
  }
  const device = internals._device as Record<string, unknown> | undefined;
  if (device && engine.isWebGPU) {
    for (const [method, key] of GPU_DEVICE_METHODS)
      if (wrapMethod(device, method, restores, (original) => function (this: unknown, ...args: unknown[]) {
        bump(key);
        return original.apply(this, args);
      })) instrumented.push(`device.${method}`);
    const queue = device.queue as Record<string, unknown> | undefined;
    if (queue)
      for (const [method, key] of GPU_QUEUE_METHODS)
        if (wrapMethod(queue, method, restores, (original) => function (this: unknown, ...args: unknown[]) {
          bump(key);
          return original.apply(this, args);
        })) instrumented.push(`queue.${method}`);
  }
  const pipelineCache = internals._cacheRenderPipeline as Record<string, unknown> | undefined;
  const pipelineStats = pipelineCache?.constructor as { NumCacheMiss?: number } | undefined;
  const bindGroupStats = (internals._cacheBindGroups as Record<string, unknown> | undefined)?.constructor as
    | { NumBindGroupsCreatedTotal?: number }
    | undefined;
  if (pipelineCache && wrapMethod(pipelineCache, "_createRenderPipeline", restores, (original) => function (this: unknown, ...args: unknown[]) {
    const effect = args[0] as { name?: unknown; uniqueId?: number } | undefined;
    record("pipeline", `${effectBaseName(effect?.name)} #${effect?.uniqueId ?? "?"} topology ${String(args[1])} samples ${String(args[2])}`, true);
    return original.apply(this, args);
  })) instrumented.push("cacheRenderPipeline._createRenderPipeline");
  let lastPipelineMiss = pipelineStats?.NumCacheMiss ?? 0;
  let lastBindGroups = bindGroupStats?.NumBindGroupsCreatedTotal ?? 0;

  // Materials: material-level invalidations by flag, submesh define marks, readiness.
  if (wrapMethod(Material.prototype, "markAsDirty", restores, (original) => function (this: Material, ...args: unknown[]) {
    if (inScene(this)) {
      const flag = Number(args[0]) || 0;
      for (const [bit, name] of MATERIAL_FLAGS)
        if (flag & bit) {
          bump(`mat.dirty.${name}`);
          record(`dirty.${name}`, this.name, true);
        }
    }
    return original.apply(this, args);
  })) instrumented.push("Material.markAsDirty");
  if (wrapMethod(Material.prototype, "markDirty", restores, (original) => function (this: Material, ...args: unknown[]) {
    if (inScene(this)) bump("mat.markDirty");
    return original.apply(this, args);
  })) instrumented.push("Material.markDirty");
  for (const [method, key] of DEFINE_MARKS)
    if (wrapMethod(MaterialDefines.prototype, method, restores, (original) => function (this: MaterialDefines, ...args: unknown[]) {
      // Processing a clean define set is a no-op; count only real transitions.
      if (method !== "markAsProcessed" || this.isDirty) bump(key);
      return original.apply(this, args);
    })) instrumented.push(`MaterialDefines.${method}`);
  let readyDepth = 0;
  for (const [name, prototype] of [
    ["PBRBaseMaterial", PBRBaseMaterial.prototype],
    ["StandardMaterial", StandardMaterial.prototype],
    ["NodeMaterial", NodeMaterial.prototype],
    ["ShaderMaterial", ShaderMaterial.prototype],
  ] as const)
    if (wrapMethod(prototype, "isReadyForSubMesh", restores, (original) => function (this: Material, ...args: unknown[]) {
      readyDepth += 1;
      try {
        const ready = original.apply(this, args);
        if (readyDepth === 1 && inScene(this)) {
          bump("ready.calls");
          if (!ready) {
            bump("ready.false");
            record("notReady", `${this.getClassName()} ${this.name} on ${(args[0] as AbstractMesh | undefined)?.name ?? "?"}`);
          }
        }
        return ready;
      } finally {
        readyDepth -= 1;
      }
    })) instrumented.push(`${name}.isReadyForSubMesh`);

  // Shadows: construction/recreation and disposal of maps.
  let shadowDepth = 0;
  if (wrapMethod(ShadowGenerator.prototype, "_initializeGenerator", restores, (original) => function (this: ShadowGenerator, ...args: unknown[]) {
    shadowDepth += 1;
    try {
      if (shadowDepth === 1 && this.getLight()?.getScene() === scene) {
        bump("shadow.init");
        record("shadow.init", `${this.getClassName()} for ${this.getLight()?.name ?? "?"} size ${this.mapSize}`, true);
      }
      return original.apply(this, args);
    } finally {
      shadowDepth -= 1;
    }
  })) instrumented.push("ShadowGenerator._initializeGenerator");
  if (wrapMethod(ShadowGenerator.prototype, "dispose", restores, (original) => function (this: ShadowGenerator, ...args: unknown[]) {
    if (shadowDepth === 0 && this.getLight()?.getScene() === scene) {
      bump("shadow.dispose");
      record("shadow.dispose", `${this.getClassName()} for ${this.getLight()?.name ?? "?"}`, true);
    }
    shadowDepth += 1;
    try {
      return original.apply(this, args);
    } finally {
      shadowDepth -= 1;
    }
  })) instrumented.push("ShadowGenerator.dispose");

  // Long tasks overlapping the run.
  const longTasks: Array<[number, number]> = [];
  const longTaskObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push([round2(entry.startTime), round2(entry.duration)]);
  });
  try {
    longTaskObserver.observe({ type: "longtask" });
  } catch {
    // Not supported: long-task attribution stays empty.
  }

  const diagnostics = () => handle.renderDiagnostics();
  const initial = diagnostics();
  const lights = scene.lights.map((light) => ({
    name: light.name,
    type: light.getClassName(),
    enabled: light.isEnabled(),
    intensity: light.intensity,
    position: "position" in light ? (light as Light & { position: Vector3 }).position.asArray().map(round2) : null,
    range: light.range,
    shadowGenerators: lightGenerators(light).length,
  }));
  const caps = handle.engine.getCaps();
  const capsSummary = {
    maxUniformBuffersPerShaderStage: caps.maxUniformBuffersPerShaderStage ?? null,
    maxTexturesImageUnits: caps.maxTexturesImageUnits,
    maxVertexUniformVectors: caps.maxVertexUniformVectors,
    parallelShaderCompile: !!caps.parallelShaderCompile,
  };

  // Per-frame bookkeeping.
  const frames: FlyFrame[] = [];
  const phases: FlyThroughResult["phases"] = [];
  let phase: FlyPhase = "warmup";
  let phaseStart = performance.now();
  let phaseFirstFrame = 0;
  const startPhase = (next: FlyPhase, now: number) => {
    phases.push({ phase, startMs: round2(phaseStart), endMs: round2(now), firstFrame: phaseFirstFrame, lastFrame: frames.length - 1 });
    phase = next;
    phaseStart = now;
    phaseFirstFrame = frames.length;
  };
  let lastWork = initial.rendererWork;
  let lastPresentation = initial.presentation;
  let lastRendered = handle.scheduler.stats().renderedFrames;
  let lastEnd: number | null = null;
  let skipped = 0;
  let frameBegin = 0;
  let previousLights = enabledLightNames(scene).join("|");
  const generatorLights = new Map<ShadowGenerator, string>();
  for (const light of scene.lights) for (const generator of lightGenerators(light)) generatorLights.set(generator, light.name);
  let previousActive = new Set<number>();
  let currentActive = new Set<number>();
  activeMeshIds(scene, previousActive);
  const heap = () => {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
    return typeof memory?.usedJSHeapSize === "number" ? round2(memory.usedJSHeapSize / 1048576) : null;
  };
  const delta = (key: string, next: number | undefined, previous: number | undefined) => {
    const value = (next ?? 0) - (previous ?? 0);
    if (value !== 0) bump(key, round2(value));
  };

  const beginObserver = engine.onBeginFrameObservable.add(() => {
    frameBegin = performance.now();
  });
  const endObserver = engine.onEndFrameObservable.add(() => {
    const end = performance.now();
    const rendered = handle.scheduler.stats().renderedFrames;
    if (rendered === lastRendered) {
      skipped += 1;
      return;
    }
    lastRendered = rendered;
    const cpuMs = end - frameBegin;
    const missNow = pipelineStats?.NumCacheMiss ?? 0;
    delta("babylon.pipelineMiss", missNow, lastPipelineMiss);
    lastPipelineMiss = missNow;
    const groupsNow = bindGroupStats?.NumBindGroupsCreatedTotal ?? 0;
    delta("babylon.bindGroupsCreated", groupsNow, lastBindGroups);
    lastBindGroups = groupsNow;
    const state = diagnostics();
    const work = state.rendererWork;
    const presentation = state.presentation;
    delta("graph.strictChecks", work?.strictReadinessChecks, lastWork?.strictReadinessChecks);
    delta("graph.outlineChecks", work?.outlineReadinessChecks, lastWork?.outlineReadinessChecks);
    delta("graph.builds", work?.graphBuilds, lastWork?.graphBuilds);
    delta("graph.shadowAdmissions", work?.shadowAdmissions, lastWork?.shadowAdmissions);
    delta("view.held", presentation?.held, lastPresentation?.held);
    delta("view.drawn", presentation?.drawn, lastPresentation?.drawn);
    delta("view.copied", presentation?.copied, lastPresentation?.copied);
    delta("view.copyMs", presentation?.copyMs, lastPresentation?.copyMs);
    delta("view.preparationMs", presentation?.preparationMs, lastPresentation?.preparationMs);
    lastWork = work;
    lastPresentation = presentation;
    const enabled = enabledLightNames(scene);
    const signature = enabled.join("|");
    if (signature !== previousLights) {
      bump("lights.changed");
      const before = new Set(previousLights ? previousLights.split("|") : []);
      const after = new Set(enabled);
      const added = enabled.filter((name) => !before.has(name));
      const removed = [...before].filter((name) => !after.has(name));
      record("lights", `+[${added.join(", ")}] -[${removed.join(", ")}] now ${enabled.length}`);
      previousLights = signature;
    }
    const seenGenerators = new Set<ShadowGenerator>();
    for (const light of scene.lights)
      for (const generator of lightGenerators(light)) {
        seenGenerators.add(generator);
        const owner = generatorLights.get(generator);
        if (owner === undefined) {
          bump("shadow.attached");
          record("shadow.attached", `${generator.getClassName()} to ${light.name}`);
        } else if (owner !== light.name) {
          bump("shadow.moved");
          record("shadow.moved", `${owner} -> ${light.name}`);
        }
        generatorLights.set(generator, light.name);
      }
    for (const [generator, owner] of generatorLights)
      if (!seenGenerators.has(generator)) {
        bump("shadow.detached");
        record("shadow.detached", owner);
        generatorLights.delete(generator);
      }
    const activeCount = activeMeshIds(scene, currentActive);
    let added = 0;
    let removed = 0;
    for (const id of currentActive) if (!previousActive.has(id)) added += 1;
    for (const id of previousActive) if (!currentActive.has(id)) removed += 1;
    [previousActive, currentActive] = [currentActive, previousActive];
    if (state.shadowDrawCalls > 0) bump("shadow.mapFrames");
    const cameraEye = camera.globalPosition;
    const counters: Record<string, number> = {};
    for (const key of Object.keys(pending)) {
      if (pending[key]) counters[key] = pending[key]!;
      delete pending[key];
    }
    frames.push({
      i: frameIndex,
      phase,
      begin: round2(frameBegin),
      end: round2(end),
      cpuMs: round2(cpuMs),
      intervalMs: lastEnd === null ? null : round2(end - lastEnd),
      skipped,
      pos: [round2(cameraEye.x), round2(cameraEye.y), round2(cameraEye.z)],
      c: counters,
      activeMeshes: activeCount,
      activeAdded: added,
      activeRemoved: removed,
      drawCalls: state.drawCalls,
      shadowDrawCalls: state.shadowDrawCalls,
      enabledLights: enabled.length,
      lodReduced: state.autoLod.reduced,
      compiledEffects: Object.keys((internals._compiledEffects ?? {}) as object).length,
      engineTextures: state.resources.cachedTextures,
      heapMb: heap(),
    });
    frameIndex += 1;
    lastEnd = end;
    skipped = 0;
  }, undefined, true);

  // Camera driver: one pose per animation frame, as the joystick and WASD do.
  const releaseLease = handle.scheduler.acquireContinuous("flythrough");
  const eye = new Vector3();
  const ahead = new Vector3();
  const direction = new Vector3();
  const setPose = (distance: number) => {
    path.at(distance, eye);
    if (distance + lookAhead <= path.length) path.at(distance + lookAhead, ahead);
    else ahead.copyFrom(path.end).addInPlace(path.end.subtract(path.beforeEnd).normalize().scale(distance + lookAhead - path.length));
    ahead.y -= lookDrop;
    ahead.subtractToRef(eye, direction);
    if (direction.lengthSquared() < 1e-6) direction.set(0, 0, 1);
    direction.normalize();
    const radius = camera.radius;
    camera.target.set(eye.x + direction.x * radius, eye.y + direction.y * radius, eye.z + direction.z * radius);
    camera.alpha = Math.atan2(-direction.z, -direction.x);
    camera.beta = Math.min(Math.PI - 0.01, Math.max(0.01, Math.acos(Math.min(1, Math.max(-1, -direction.y)))));
    handle.scheduler.invalidate("camera");
  };

  try {
    setPose(0);
    await new Promise<void>((resolve, reject) => {
      let pass = 0;
      let passStarted = 0;
      let holdUntil = performance.now() + warmupMs;
      const step = () => {
        if (scene.isDisposed) {
          reject(new Error("The viewport Scene was disposed during the fly-through."));
          return;
        }
        const now = performance.now();
        if (pass === 0 || phase === "reset") {
          setPose(0);
          if (now >= holdUntil) {
            pass += 1;
            startPhase(`pass${pass}`, now);
            passStarted = now;
          }
        } else {
          const distance = ((now - passStarted) / 1000) * speed;
          setPose(distance);
          if (now - passStarted >= passMs) {
            if (pass >= passes) {
              startPhase("reset", now);
              resolve();
              return;
            }
            startPhase("reset", now);
            holdUntil = now + resetMs;
            setPose(0);
          }
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    // One more presented frame closes the last pass.
    await new Promise<void>((resolve) => {
      const target = handle.scheduler.stats().renderedFrames + 1;
      const wait = () => (handle.scheduler.stats().renderedFrames >= target || scene.isDisposed ? resolve() : requestAnimationFrame(wait));
      requestAnimationFrame(wait);
    });
  } finally {
    releaseLease();
    engine.onBeginFrameObservable.remove(beginObserver);
    engine.onEndFrameObservable.remove(endObserver);
    for (const restore of restores.reverse()) restore();
    for (const entry of longTaskObserver.takeRecords()) longTasks.push([round2(entry.startTime), round2(entry.duration)]);
    longTaskObserver.disconnect();
  }
  const final = diagnostics();
  return {
    backend: handle.engine.isWebGPU ? "webgpu" : "webgl2",
    adapter: final.adapter,
    caps: capsSummary,
    pathLength: round2(path.length),
    speed,
    phases,
    frames,
    log,
    longTasks,
    lights,
    qualityLimitsBefore: initial.qualityLimits,
    qualityLimitsAfter: final.qualityLimits,
    pipeline: final.pipeline,
    totals,
    instrumented,
  };
}
