/**
 * Compile-hold acceptance harness: one Play scenario per cause of a mid-game
 * shader compile, run against the real Play Engine (`createEngine` with
 * `playMode`), its world view coordinator, lighting, shadows and materials on a
 * headless NullEngine with uniform buffers (the WebGL2 light path).
 *
 * Each scenario presents its first frame, then arms a driver model and applies
 * one cause through Play's own commands:
 * - `sync`: links complete inside the call, as on SwiftShader (no
 *   KHR_parallel_shader_compile). Nothing is ever pending, so only the compiles
 *   (each one blocks the thread on such a driver) are recorded.
 * - `parallel`: a parallel-compile driver (D3D11 through ANGLE, iPad WebKit
 *   WebGL2). Every Effect created after arming stays pending until `release`.
 * - `webgpu`: Effects are ready once created and each new one needs a render
 *   pipeline, which stays pending until `release` (`beginPipelineDeferral` and
 *   `pipelinesDeferred` are replaced by a model: NullEngine is not WebGPU). A
 *   warm scope's draws are always skipped and report whether their pipeline
 *   exists (a lookup scope's start none); a pass the view's scope omits (its
 *   geometry passes in steady frames) leaves a draw whose pipeline is pending
 *   out and holds nothing.
 *
 * It records counts and states only, never timings: Effects compiled, frames
 * the world view held its image, whether the hold signal and the game-time
 * pause were raised, which Effect the changed mesh drew, and in the WebGPU model
 * the pipelines the view's draws waited for and those warm draws started first.
 * Time is Vitest's fake clock, advanced a fixed step
 * per frame, so graph preparation's polls run deterministically.
 *
 * A change to an existing Material's variant keeps drawing its previous Effect
 * while the new one compiles (on WebGPU, until its pipeline exists): no held
 * frame, no hold signal, no pause. A new shadow map draws once its casters are
 * ready, and a spawned mesh with nothing to draw is hidden until every variant
 * it draws with is ready, its pipelines included.
 */
import {
  ArcRotateCamera,
  Constants,
  DirectionalLight,
  Mesh,
  MeshBuilder,
  NullEngine,
  NullEngineOptions,
  Light,
  Material,
  Matrix,
  PBRMaterial,
  PointLight,
  RenderTargetTexture,
  Scene,
  ShadowGenerator,
  SpotLight,
  StandardMaterial,
  SubMesh,
  TransformNode,
  UniversalCamera,
  Vector3,
  VertexBuffer,
  type AbstractEngine,
  type AbstractMesh,
  type Effect,
} from "@babylonjs/core";
import {
  SNAPSHOT_FLAG_VISIBLE,
  snapshotFloatCount,
  writeActorSlot,
  writeSnapshotHeader,
  type ScriptBundleEntry,
} from "@haptic/bridge";
import {
  areaRectLightBindings, createDefaultRenderTargetCaptureProperties, createDefaultScene, fogVolumeBindings, normalizeRenderingQuality,
  parseText2DProperties, parseText3DProperties,
} from "@haptic/core";
import { AREA_EMISSION_EDGE, decodeAreaEmission, encodeAreaEmission } from "@haptic/assets";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "./create-engine";
import { drawsInPass } from "./webgpu-pipeline-deferral";
import { effectLightSeats } from "./fixed-light-binding";
import { upsertFogVolumes } from "./fog-volumes";
import { markSceneReadinessDirty } from "./scene-readiness-signal";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { setFixedShapeLightingEnabled, setFixedShapeLightingWorldScene } from "./fixed-light-admission";
import { isForwardLightExcluded, nearForwardAdmissions, setAuthoredLightEnabled } from "./light-policy";
import { compileMaterialPlan } from "./material-compiler";
import { sceneRenderingSettings, updateSceneRenderingSettings } from "./render-settings";
import { AUTHORED_LIGHT_PREFIX } from "./scene-illumination";
import { SceneRenderCoordinator } from "./scene-render-coordinator";
import { existingShadowSamplerPlaceholders } from "./shadow-sampler-placeholders";
import { findSceneShadowController, PREDICTION_MAP_SIZE } from "./shadow-controller";
import { awaitsFirstDraw, setFirstDrawsUrgent } from "./shadow-first-draw";
import { isRevealPending, noteDrawn, onMeshRevealed } from "./reveal-pending";
import { FIRST_DRAWS_PER_FRAME } from "./variant-pipeline-warmup";
import { PREDICTIONS_MAX } from "./variant-prediction";
import { managedRenderReservations } from "./managed-render-resources";
import { shadowBytesPerTexel } from "./shadow-admission";
import { isSceneGameTimePaused } from "./scene-game-time";
import { enableHeadlessCascades, enableHeadlessCubeTargets } from "./shadow-test-fixtures";
import { mockCubeTextureIO } from "./texture-test-fixtures";
import type { AssignMeshCommand, AssignMeshPart } from "./snapshot-apply";
import { spawnableLightsOfLoad, type SpawnableLightLoad } from "./spawnable-lights";
import {
  beginPipelineDeferral, capturePipelineTarget, deferredPipelinesStalled, effectDrawn, PIPELINE_DEFERRAL_STALL_MS, pipelinesDeferred,
  type PipelineTarget,
} from "./webgpu-pipeline-deferral";

// NullEngine is not WebGPU, so the real deferral never engages; the `webgpu` model replaces it.
vi.mock("./webgpu-pipeline-deferral", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./webgpu-pipeline-deferral")>();
  return {
    ...actual,
    drawsInPass: vi.fn(actual.drawsInPass),
    beginPipelineDeferral: vi.fn(actual.beginPipelineDeferral),
    pipelinesDeferred: vi.fn(actual.pipelinesDeferred),
    effectDrawn: vi.fn(actual.effectDrawn),
    deferredPipelinesStalled: vi.fn(actual.deferredPipelinesStalled),
    capturePipelineTarget: vi.fn(actual.capturePipelineTarget),
  };
});
// The load's light rehearsal pre-compiles the variants these causes ask for; a case that measures a swap leaves it out
// (`rehearseLoad`), so its cause compiles mid-game as one the rehearsal does not enumerate would.
vi.mock("./load-rehearsal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./load-rehearsal")>();
  return {
    ...actual,
    createLoadRehearsal: vi.fn((...args: Parameters<typeof actual.createLoadRehearsal>) => rehearseLoad
      ? actual.createLoadRehearsal(...args)
      : {
        done: true, frame() {}, check() {}, cancel() {}, release() {},
        report: () => ({ steps: 0, drawn: 0, omitted: [], timedOut: [], unrestored: [], variants: 0, pipelines: 0, ms: 0 }),
      }),
  };
});
let rehearseLoad = false;
// Variant prediction compiles ahead what a light near the Forward budget's cut-off would ask for; a case that measures a
// swap leaves it out (`predictAhead`), so its cause compiles at admission as one nothing predicted would.
vi.mock("./variant-prediction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./variant-prediction")>();
  return {
    ...actual,
    predictLightVariants: vi.fn((...args: Parameters<typeof actual.predictLightVariants>) => {
      if (predictAhead) actual.predictLightVariants(...args);
    }),
  };
});
let predictAhead = false;
const {
  beginPipelineDeferral: actualBeginPipelineDeferral, pipelinesDeferred: actualPipelinesDeferred, effectDrawn: actualEffectDrawn,
  deferredPipelinesStalled: actualDeferredPipelinesStalled, capturePipelineTarget: actualCapturePipelineTarget,
} = await vi.importActual<typeof import("./webgpu-pipeline-deferral")>("./webgpu-pipeline-deferral");

type Model = "sync" | "parallel" | "webgpu";
type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
type PlayLightProperties = NonNullable<AssignMeshPart["light"]>;

class FakeCanvas {
  width = 256;
  height = 256;
  clientWidth = 256;
  clientHeight = 256;
  readonly style = { cursor: "", touchAction: "" };
  focus(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  setPointerCapture(): void {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
  getContext(kind: string): unknown {
    return kind === "2d" ? { clearRect() {}, drawImage() {} } : null;
  }
}

const { drawsInPass: actualDrawsInPass } = await vi.importActual<typeof import("./webgpu-pipeline-deferral")>("./webgpu-pipeline-deferral");
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.restoreAllMocks();
  vi.mocked(drawsInPass).mockImplementation(actualDrawsInPass);
  vi.mocked(beginPipelineDeferral).mockImplementation(actualBeginPipelineDeferral);
  vi.mocked(pipelinesDeferred).mockImplementation(actualPipelinesDeferred);
  vi.mocked(effectDrawn).mockImplementation(actualEffectDrawn);
  vi.mocked(deferredPipelinesStalled).mockImplementation(actualDeferredPipelinesStalled);
  vi.mocked(capturePipelineTarget).mockImplementation(actualCapturePipelineTarget);
  rehearseLoad = false;
  predictAhead = false;
  frameMs = FRAME_MS;
});

/** Each Play frame advances the clock this much, so a run of held frames crosses the pause delay deterministically. */
const FRAME_MS = 100;
/** The clock step of the next Play frames (a case with a realistic frame clock sets 16 ms). */
let frameMs = FRAME_MS;
/** Frames a pending compile or pipeline stays pending before the driver releases it (600 ms). */
const PENDING_FRAMES = 6;

/** A headless WebGL2-shaped Engine: uniform buffers (nine light slots), shadow maps with cascades. */
function headlessEngine(): NullEngine {
  const options = new NullEngineOptions();
  // Babylon's headless multiview option supplies the CPU-side UBO path; the default models a non-UBO fallback.
  options.enableMultiview = true;
  const engine = adaptNullEngineFrameGraph(new NullEngine(options));
  engine.customAnimationFrameRequester = { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} };
  mockCubeTextureIO(engine);
  Object.assign(engine.getCaps(), {
    maxTextureSize: 4096, maxDrawBuffers: 4, drawBuffersExtension: true,
    depthTextureExtension: true, textureFloatRender: true, textureHalfFloatRender: true,
    textureFloatLinearFiltering: true, textureHalfFloatLinearFiltering: true,
  });
  enableHeadlessCascades(engine);
  enableHeadlessCubeTargets(engine);
  cleanups.push(() => engine.dispose());
  return engine;
}

type EffectMap = Record<string, Effect>;
const compiledEffects = (engine: AbstractEngine) => (engine as unknown as { _compiledEffects: EffectMap })._compiledEffects;

/**
 * The driver model. Before `arm` every compile completes at once (the load compiles freely). From `arm` it counts
 * every new Effect, and until `release` `parallel` keeps each new Effect pending and `webgpu` each new Effect's
 * pipeline; after `release` new ones complete at once again.
 */
function driverModel(engine: NullEngine, model: Model) {
  const known = new Set<Effect>();
  const created: Effect[] = [];
  const pending = new Set<Effect>();
  /** WebGPU model: when a pipeline last started or finished (the deferral's stall measures from it). */
  let progressAt = performance.now();
  const start = (effect: Effect) => {
    pending.add(effect);
    progressAt = performance.now();
  };
  let armed = false;
  let holding = false;
  /** Set by `lagOnly`: the only new Effects the driver still keeps pending. */
  let lags: ((effect: Effect) => boolean) | undefined;
  if (model === "parallel") engine.getCaps().parallelShaderCompile = { COMPLETION_STATUS_KHR: 0x91b1 };
  const create = engine.createEffect.bind(engine) as (...args: unknown[]) => Effect;
  vi.spyOn(engine, "createEffect").mockImplementation(((...args: unknown[]) => {
    const effect = create(...args);
    if (!armed || known.has(effect)) return effect;
    known.add(effect);
    created.push(effect);
    if (model === "sync" || !holding || (lags && !lags(effect))) return effect;
    start(effect);
    if (model === "parallel") {
      // A link the driver has not finished: Babylon and the app's waits read it through isReady().
      const isReady = effect.isReady.bind(effect);
      effect.isReady = () => !pending.has(effect) && isReady();
    }
    return effect;
  }) as unknown as typeof engine.createEffect);

  // The WebGPU model: a view's scope skips each draw whose Effect's pipeline is still pending, as the real deferral does;
  // a warm scope skips every draw and reports whether each found its pipeline.
  const pipelines = new Set<Effect>();
  const warmPipelines = new Set<Effect>();
  /** WebGPU model: Effects whose render pipeline exists, and those a draw has drawn with. */
  const pipelineReady = new WeakSet<Effect>();
  const drawnEffects = new WeakSet<Effect>();
  /** WebGPU model: Effects whose pipeline a draw outside any deferring scope (a shadow map's) created synchronously. */
  const synchronous = new Set<Effect>();
  /** WebGPU model: Effects whose draw a pass the view's scope omits left out while their pipeline was pending. */
  const omitted = new Set<Effect>();
  /** WebGPU model: draws that reached the GPU (not skipped, left out or made only to warm), in all and by render pass. */
  let draws = 0;
  /** WebGPU model: draws made only to look a pipeline up ahead of a reveal. */
  let lookups = 0;
  /**
   * WebGPU model, from `keyLayouts`: pipelines are per Effect and vertex layout, as Babylon's cache keys them (the
   * attributes' formats, strides and offsets the draw bound), not per Effect alone.
   */
  let byLayout = false;
  let boundLayout = "";
  const layoutReady = new Set<string>();
  const layoutPending = new Set<string>();
  const passDraws = new Map<number, number>();
  type Scope = {
    allows: (pass: number) => boolean; omits?: (pass: number) => boolean; warm: boolean; lookup: boolean; isolated: boolean;
    skipped: number; lookups: number; hits: number; effects: Set<Effect>;
    /** Per omitting pass, the Effects whose draws it left out, and the omitting passes in which some draw drew. */
    omittedIn: Map<number, Set<Effect>>; drew: Set<number>;
  };
  const scopes: Scope[] = [];
  if (model === "webgpu") {
    vi.mocked(pipelinesDeferred).mockReturnValue(true);
    vi.mocked(effectDrawn).mockImplementation((_engine, effect) => drawnEffects.has(effect as Effect));
    vi.mocked(drawsInPass).mockImplementation((_engine, pass) => passDraws.get(pass) ?? 0);
    vi.mocked(deferredPipelinesStalled).mockImplementation(() => performance.now() - progressAt >= PIPELINE_DEFERRAL_STALL_MS);
    // Any pass's target replays: the model keys pipelines by Effect alone.
    vi.mocked(capturePipelineTarget).mockReturnValue({} as PipelineTarget);
    vi.mocked(beginPipelineDeferral).mockImplementation((_engine, allows, options = {}) => {
      if (options.nested && !scopes.length) return undefined;
      const lookup = options.lookup !== undefined;
      const warm = options.warm === true || lookup;
      const isolated = !warm && options.isolated === true;
      const scope: Scope = {
        allows, omits: warm || isolated ? undefined : options.omits, warm, lookup, isolated, skipped: 0, lookups: 0, hits: 0,
        effects: new Set(),
        omittedIn: new Map(), drew: new Set(),
      };
      scopes.push(scope);
      let closed = false;
      return {
        close: () => {
          if (!closed) {
            closed = true;
            const index = scopes.lastIndexOf(scope);
            if (index >= 0) scopes.splice(index, 1);
            // A pass whose every draw was left out holds for them, as the real deferral does.
            for (const [pass, effects] of scope.omittedIn) {
              if (scope.drew.has(pass)) continue;
              scope.skipped += effects.size;
              for (const effect of effects) {
                omitted.delete(effect);
                pipelines.add(effect);
                scope.effects.add(effect);
              }
            }
            const parent = scopes[index - 1];
            if (parent && !warm && !isolated) {
              parent.skipped += scope.skipped;
              for (const effect of scope.effects) parent.effects.add(effect);
            }
          }
          return scope.skipped;
        },
        // An isolated scope's draws compile at the stall, as the real deferral's do.
        waiting: () => !(isolated && performance.now() - progressAt >= PIPELINE_DEFERRAL_STALL_MS) &&
          [...scope.effects].some((effect) => pending.has(effect)),
        warmed: () => scope.lookups > 0 && scope.hits === scope.lookups,
      };
    });
    const internals = engine as unknown as { _currentEffect: Effect | null; currentRenderPassId: number };
    const bindBuffers = engine.bindBuffers.bind(engine);
    vi.spyOn(engine, "bindBuffers").mockImplementation((buffers, indexBuffer, effect) => {
      boundLayout = effect.getAttributesNames().map((name) => {
        const buffer = buffers[name];
        return buffer ? `${name}:${buffer.hashCode}:${buffer.byteOffset}` : `${name}:-`;
      }).join(",");
      bindBuffers(buffers, indexBuffer, effect);
    });
    for (const name of ["drawElementsType", "drawArraysType"] as const) {
      const draw = (engine[name] as (...args: unknown[]) => void).bind(engine);
      vi.spyOn(engine, name).mockImplementation(((...args: unknown[]) => {
        const effect = internals._currentEffect;
        const key = byLayout && effect ? `${effect.uniqueId}|${boundLayout}` : undefined;
        let scope: Scope | undefined;
        for (let index = scopes.length - 1; index >= 0 && !scope; index--)
          if (scopes[index]!.allows(internals.currentRenderPassId)) scope = scopes[index];
        // A lookup only asks whether the pipeline exists: it starts none.
        if (scope?.lookup) {
          scope.lookups += 1;
          scope.skipped += 1;
          if (key ? layoutReady.has(key) : effect && pipelineReady.has(effect) && !pending.has(effect)) scope.hits += 1;
          lookups += 1;
          return;
        }
        // An Effect's first draw needs its pipeline: at once before arming or after release, pending in between (an
        // Effect the load compiled without drawing it, such as a spawnable's, has none yet).
        if (key) {
          if (!layoutReady.has(key) && !layoutPending.has(key)) {
            if (armed && holding && (!lags || lags(effect!))) {
              layoutPending.add(key);
              start(effect!);
            } else layoutReady.add(key);
          }
        } else if (effect && !pipelineReady.has(effect) && !pending.has(effect)) {
          if (armed && holding && (!lags || lags(effect))) start(effect);
          else pipelineReady.add(effect);
        }
        const missing = !!effect && (key ? layoutPending.has(key) : pending.has(effect));
        if (scope?.warm) {
          scope.lookups += 1;
          scope.skipped += 1;
          if (missing) {
            warmPipelines.add(effect);
            scope.effects.add(effect);
          } else scope.hits += 1;
          return;
        }
        // A pass the scope omits leaves the draw out and holds nothing: neither skipped nor waited for.
        const pass = internals.currentRenderPassId;
        if (scope?.omits?.(pass) && missing) {
          omitted.add(effect);
          let effects = scope.omittedIn.get(pass);
          if (!effects) scope.omittedIn.set(pass, (effects = new Set()));
          effects.add(effect);
          return;
        }
        // An isolated scope (a drawn shadow map's new casters) skips a miss, holding nothing, until the stall.
        if (scope?.isolated && missing) {
          if (performance.now() - progressAt < PIPELINE_DEFERRAL_STALL_MS) {
            scope.skipped += 1;
            scope.effects.add(effect);
            return;
          }
        } else if (scope && missing) {
          pipelines.add(effect);
          scope.skipped += 1;
          scope.effects.add(effect);
          return;
        }
        // Outside a deferring scope (a shadow map) a missing pipeline is created synchronously.
        if (missing) {
          synchronous.add(effect);
          pending.delete(effect);
          pipelineReady.add(effect);
          if (key) {
            layoutPending.delete(key);
            layoutReady.add(key);
          }
        }
        if (effect) drawnEffects.add(effect);
        draws += 1;
        if (scopes.length) passDraws.set(pass, (passDraws.get(pass) ?? 0) + 1);
        if (scope?.omits?.(pass)) scope.drew.add(pass);
        draw(...args);
      }) as never);
    }
  }
  return {
    arm: () => {
      for (const effect of Object.values(compiledEffects(engine))) known.add(effect);
      armed = holding = true;
    },
    /** The driver finishes everything pending; later requests compile at once again. */
    release: () => {
      for (const effect of pending) pipelineReady.add(effect);
      pending.clear();
      for (const key of layoutPending) layoutReady.add(key);
      layoutPending.clear();
      progressAt = performance.now();
      holding = false;
      lags = undefined;
    },
    /**
     * From now on the driver finishes every link (WebGPU model: every pipeline) but those `lagging` picks, which stay
     * pending until `release`.
     */
    lagOnly: (lagging: (effect: Effect) => boolean) => {
      lags = lagging;
      for (const effect of [...pending]) if (!lagging(effect)) pending.delete(effect);
      progressAt = performance.now();
    },
    isPending: (effect: Effect) => pending.has(effect),
    /** Every pending link fails, with no fallback left: those Effects never become ready. */
    fail: () => {
      for (const effect of pending) Object.assign(effect, { _compilationError: "ERROR: 0:1: injected link failure", _allFallbacksProcessed: true });
    },
    created,
    /** WebGPU model: Effects whose pipeline a view's skipped draw waited for. */
    pipelines,
    /** WebGPU model: Effects whose pipeline a warm draw started before any real draw needed it. */
    warmPipelines,
    /** WebGPU model: Effects a geometry pass left out while their pipeline was pending, holding nothing. */
    omitted,
    /** WebGPU model: draws so far that reached the GPU. */
    draws: () => draws,
    /** WebGPU model: lookup draws so far (`lookUpPipelines`). */
    lookups: () => lookups,
    /** WebGPU model: from now on (before the load draws) each Effect needs a pipeline per vertex layout it draws with. */
    keyLayouts: () => { byLayout = true; },
    /** WebGPU model: Effects whose pipeline a shadow map's draw created synchronously (the shadow pass defers none). */
    synchronous,
    /** WebGPU model: a warm scope is open (draws in its passes only create pipelines). */
    warming: () => scopes.some((scope) => scope.warm),
    /** WebGPU model: a draw that was not skipped has drawn with `effect`. */
    drewWith: (effect: Effect) => drawnEffects.has(effect),
  };
}

type Actor = { slotId: number; guid: string; position: Vec3; rotation?: Quat; scale?: Vec3; assign: Omit<AssignMeshCommand, "type" | "slotId" | "actorGuid"> };

const part = (componentId: string, meshKind: string, extra: Partial<AssignMeshPart> = {}): AssignMeshPart => ({
  componentId, meshKind, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], ...extra,
});
const light = (kind: "point" | "spot" | "directional" | "hemispheric", properties: Partial<PlayLightProperties> = {}) =>
  ({ meshAssetGuid: null, meshKind: null, parts: [part("light", `light:${kind}`, {
    light: { color: [1, 1, 1], intensity: 1, enabled: true, range: 12, outerAngle: 70, innerAngle: 40, ...properties },
  })] });
/** Rotates +Z (a light's forward) to straight down. */
const DOWN: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
/** The world's sun (slot 3), whose shadow map, when it casts, is cascaded. */
const sun = (properties: Partial<PlayLightProperties> = {}): Actor => ({
  slotId: 3, guid: "sun", position: [5, 8, -5], rotation: [0.3827, 0, 0, 0.9239], assign: light("directional", { intensity: 1.5, ...properties }),
});

/** A Class whose prefab template holds a Light component with `properties` (its Light Kind among them). */
const lightClass = (classId: string, properties: Record<string, unknown>): ScriptBundleEntry => ({
  assetGuid: classId, classId, source: "", anchors: [], entryPoints: [],
  components: [{ id: "light", classId: "LightComponent", properties }],
});

/** A load's compiled Classes, each a Class asset of its own, and its assets' dependencies (every one a Class asset). */
const classesLoad = (scripts: ScriptBundleEntry[], assets: SpawnableLightLoad["assets"] = []): SpawnableLightLoad =>
  ({ scripts, assets, isClass: () => true });

/**
 * A Play world: a crate on a floor, a sun, a camera, plus the scenario's own actors. Every actor is posed through
 * the snapshot, as the game worker poses them. `load` is the startup sources' compiled Classes and dependencies, whose
 * lights it may spawn.
 */
function playWorld(model: Model, actors: Actor[], materials: string[] = [], subject = "actor-2", load = classesLoad([])) {
  // Preparation polls every 16 ms and the Play pause waits 250 ms: both run on this clock.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"], now: 1_000 });
  cleanups.push(() => vi.useRealTimers());
  const engine = headlessEngine();
  const driver = driverModel(engine, model);
  const holds: boolean[] = [];
  const handle = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, {
    sharedEngine: engine,
    playMode: true,
    onPipelineHold: (held) => holds.push(held),
    materialDocuments: new Map(materials.map((guid) => [guid, createDefaultMaterialDocument(guid)])),
    // As editor Play passes its startup sources'.
    spawnableLights: spawnableLightsOfLoad(load),
  });
  cleanups.push(() => handle.dispose());
  handle.loadScene(createDefaultScene(), { sceneAssetGuid: "scene" });
  const world: Actor[] = [
    { slotId: 1, guid: "floor", position: [0, 0, 0], scale: [12, 0.2, 12], assign: { meshAssetGuid: null, meshKind: "box" } },
    { slotId: 2, guid: "crate", position: [0, 1, 0], assign: { meshAssetGuid: null, meshKind: "box" } },
    sun(),
    { slotId: 4, guid: "camera", position: [0, 3, -10], assign: { meshAssetGuid: null, meshKind: null, parts: [part("lens", "camera", { camera: { fieldOfView: 60, isDefault: true } })] } },
  ];
  let frameId = 0;
  const pose = () => {
    const snapshot = new Float32Array(snapshotFloatCount(world.length + 4));
    writeSnapshotHeader(snapshot, { frameId: ++frameId, tickIndex: frameId, actorCount: world.length, scriptMs: 0, physicsMs: 0 });
    world.forEach((actor, index) => writeActorSlot(snapshot, index, {
      slotId: actor.slotId,
      position: { x: actor.position[0], y: actor.position[1], z: actor.position[2] },
      rotation: { x: actor.rotation?.[0] ?? 0, y: actor.rotation?.[1] ?? 0, z: actor.rotation?.[2] ?? 0, w: actor.rotation?.[3] ?? 1 },
      scale: { x: actor.scale?.[0] ?? 1, y: actor.scale?.[1] ?? 1, z: actor.scale?.[2] ?? 1 },
      flags: SNAPSHOT_FLAG_VISIBLE,
    }));
    handle.pushSnapshot(snapshot);
  };
  const assign = (actor: Actor) =>
    handle.applyCommand({ type: "assignMesh", slotId: actor.slotId, actorGuid: actor.guid, ...actor.assign } as AssignMeshCommand);
  /** Spawns actors (or re-sends an actor's visual, as a changed component does) and poses the world. */
  const place = (...added: Actor[]) => {
    for (const actor of added) {
      const index = world.findIndex((entry) => entry.slotId === actor.slotId);
      if (index >= 0) world[index] = actor;
      else {
        world.push(actor);
        handle.applyCommand({ type: "spawn", slotId: actor.slotId, actorGuid: actor.guid, classId: "Actor" });
      }
      assign(actor);
    }
    pose();
  };
  /** Despawns an actor; the worker's later snapshots leave its slot out. */
  const remove = (slotId: number) => {
    const index = world.findIndex((entry) => entry.slotId === slotId);
    const [actor] = world.splice(index, 1);
    handle.applyCommand({ type: "despawn", slotId, actorGuid: actor!.guid });
    pose();
  };
  /** Moves an actor through the snapshot alone, as the worker poses it: its visual is not sent again. */
  const move = (slotId: number, position: Vec3, rotation?: Quat) => {
    const actor = world.find((entry) => entry.slotId === slotId)!;
    actor.position = position;
    if (rotation) actor.rotation = rotation;
    pose();
  };
  for (const actor of world) handle.applyCommand({ type: "spawn", slotId: actor.slotId, actorGuid: actor.guid, classId: "Actor" });
  for (const actor of world) assign(actor);
  place(...actors);

  // The world view's frames, as the render loop drives them.
  const views: Array<{ rendered: boolean; reason?: string; holding: boolean; checks: number }> = [];
  const render = SceneRenderCoordinator.prototype.render;
  const renders = vi.spyOn(SceneRenderCoordinator.prototype, "render").mockImplementation(function (this: SceneRenderCoordinator, ...args) {
    const result = render.apply(this, args);
    if ((this as unknown as { scene: unknown }).scene === handle.scene)
      views.push({ rendered: result.rendered, reason: result.reason, holding: this.holdingForPipelines, checks: this.strictReadinessChecks });
    return result;
  });
  /** The world view's coordinator, once it has drawn. */
  const view = () => (renders.mock.contexts as SceneRenderCoordinator[])
    .filter((context) => (context as unknown as { scene: unknown }).scene === handle.scene).at(-1)!;
  /** One Play frame, then `FRAME_MS` of timers and microtasks (preparation, presentation, material preparation). */
  const frame = async () => {
    handle.scheduler.invalidate("manual");
    engine.onBeginFrameObservable.notifyObservers(engine);
    if (!engine.getRenderingCanvas())
      vi.spyOn(engine, "getRenderingCanvas").mockReturnValue(new FakeCanvas() as unknown as HTMLCanvasElement);
    engine._renderViews();
    // Engine.endFrame's count: per-frame budgets key to it.
    (engine as unknown as { _frameId: number })._frameId += 1;
    engine.onEndFrameObservable.notifyObservers(engine);
    const view = views.at(-1);
    const state = { view, holding: view?.holding ?? false, paused: isSceneGameTimePaused(handle.scene), effect: subjectEffect() };
    await vi.advanceTimersByTimeAsync(frameMs);
    return state;
  };
  /**
   * The Effect the subject's submesh draws with in the view's object pass (the camera's own pass is only probed): the
   * crate by default (it receives every light).
   */
  const subjectEffect = () => {
    const pass = engine.getRenderPassNames().lastIndexOf("Forward objects#0");
    return pass < 0 ? null : handle.scene.getMeshByName(subject)?.subMeshes?.[0]?._getDrawWrapper(pass)?.effect ?? null;
  };
  return { engine, handle, driver, holds, world, place, remove, move, frame, views, subjectEffect, view };
}

type PlayWorld = ReturnType<typeof playWorld>;

/** What one cause did to a settled Play view under one driver model. */
interface CauseRecord {
  /** Effects compiled after the cause: each blocks the thread on a driver without parallel compile. */
  effects: number;
  /** Of those, lit surface variants (any light define). */
  litEffects: number;
  /** Frames, while the compile or pipeline was pending, in which the world view held its last image. */
  heldFrames: number;
  /** Frames in that window in which the world view drew. */
  drawnFrames: number;
  /** The view reported holding for GPU work (`holdingForPipelines`). */
  holdReported: boolean;
  /** Play raised its rendering hold (`onPipelineHold(true)`). */
  holdRaised: boolean;
  /** Frames in which Play's game time was paused. */
  pausedFrames: number;
  /** Full readiness probes per frame while the cause's compiles were pending, after the cause's own frame (each walks every mesh). */
  probesPerFrame: number;
  /** WebGPU model: Effects whose pipeline a view's skipped draw waited for. */
  pipelines: number;
  /** WebGPU model: Effects whose pipeline a warm draw started before a real draw needed it. */
  warmPipelines: number;
  /** In a frame the view drew while the cause's compiles were pending, the subject drew the Effect it had before the cause. */
  previousEffectDrawn: boolean;
  /** After release the subject draws an Effect the cause compiled (within three frames of recovering). */
  adopted: boolean;
  /** After release the view drew within three frames and nothing stayed paused. */
  recovered: boolean;
  /** Frames after release until the view drew unpaused (recorded, not asserted: graph preparation polls on real 16 ms timers). */
  recoveryFrames: number;
  /** Why the view held, in the order first seen. */
  reasons: string[];
}

/** Awaits `work` while the fake clock runs, in 16 ms steps (its waits poll on timers). */
async function withClock<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  const done = work.finally(() => { settled = true; });
  for (let step = 0; step < 4_000 && !settled; step++) await vi.advanceTimersByTimeAsync(16);
  return done;
}

async function settle(world: PlayWorld): Promise<void> {
  await withClock(world.handle.prewarmSceneMaterials());
  const presented = world.handle.presentFirstFrame();
  let done = false;
  void presented.finally(() => { done = true; });
  // The load rehearses its light changes in the presentation's loading frames (two or more each).
  for (let index = 0; index < 400 && (index < 4 || !done); index++) await world.frame();
  await presented;
  // A few steady frames: shadow maps render once, lighting settles.
  for (let index = 0; index < 4; index++) await world.frame();
  expect((await world.frame()).view?.rendered, "the scene draws before the cause").toBe(true);
}

/**
 * Applies `cause` to a settled view, keeps the new compiles or pipelines pending for `PENDING_FRAMES` frames,
 * releases them and lets the view recover (up to 30 frames). `settled` runs once the view has settled.
 */
async function measure(
  world: PlayWorld, cause: () => unknown, settled?: () => void | Promise<void>, pending?: () => void,
): Promise<CauseRecord> {
  await settle(world);
  await settled?.();
  const before = world.subjectEffect();
  let checksBefore = 0;
  world.driver.arm();
  const holdsBefore = world.holds.length;
  cause();
  let heldFrames = 0;
  let drawnFrames = 0;
  let pausedFrames = 0;
  let holdReported = false;
  let previousEffectDrawn = false;
  const reasons = new Set<string>();
  for (let index = 0; index < PENDING_FRAMES; index++) {
    const { view, holding, paused, effect } = await world.frame();
    if (view?.rendered) {
      drawnFrames++;
      previousEffectDrawn ||= effect === before && world.driver.created.length > 0;
    } else {
      heldFrames++;
      reasons.add(view?.reason ?? "no frame");
    }
    if (paused) pausedFrames++;
    holdReported ||= holding;
    // The cause's own invalidation is probed in its first frame; count what the pending swap costs after it.
    if (index === 0) checksBefore = world.views.at(-1)?.checks ?? 0;
    pending?.();
  }
  const probesPerFrame = ((world.views.at(-1)?.checks ?? 0) - checksBefore) / (PENDING_FRAMES - 1);
  world.driver.release();
  let recovered = false;
  let recoveryFrames = 0;
  for (let index = 0; index < 30 && !recovered; index++, recoveryFrames++) {
    const { view, paused } = await world.frame();
    if (paused) pausedFrames++;
    recovered = !!view?.rendered && !paused;
    if (!view?.rendered) reasons.add(`after release: ${view?.reason ?? "no frame"}`);
  }
  const created = world.driver.created;
  // WebGPU adopts a variant on the frame after its warm draw found the pipeline.
  for (let index = 0; index < 3 && recovered && !created.includes(world.subjectEffect()!); index++) await world.frame();
  const after = world.subjectEffect();
  return {
    effects: created.length,
    litEffects: created.filter((effect) => /#define LIGHT0\b/.test(effect.defines)).length,
    heldFrames,
    drawnFrames,
    holdReported,
    holdRaised: world.holds.slice(holdsBefore).includes(true),
    pausedFrames,
    probesPerFrame,
    pipelines: world.driver.pipelines.size,
    warmPipelines: world.driver.warmPipelines.size,
    previousEffectDrawn,
    adopted: !!after && created.includes(after),
    recovered,
    recoveryFrames,
    reasons: [...reasons],
  };
}

const point = (slotId: number, position: Vec3, properties: Partial<PlayLightProperties> = {}): Actor =>
  ({ slotId, guid: `point-${slotId}`, position, assign: light("point", properties) });
const spot = (slotId: number, position: Vec3, properties: Partial<PlayLightProperties> = {}): Actor =>
  ({ slotId, guid: `spot-${slotId}`, position, rotation: DOWN, assign: light("spot", properties) });

const MODELS: readonly Model[] = ["sync", "parallel", "webgpu"];

/**
 * Effects the driver compiled since it was armed that a real pass draws or probes with (not only a prediction's own
 * passes: a later prediction for another light compiles ahead too).
 */
function realCompiles(world: PlayWorld): Effect[] {
  const names = world.engine.getRenderPassNames();
  const held = new Set<Effect>();
  for (const mesh of world.handle.scene.meshes)
    for (const subMesh of mesh.subMeshes ?? [])
      (subMesh as unknown as { _drawWrappers: ({ effect?: Effect | null } | undefined)[] })._drawWrappers.forEach((wrapper, pass) => {
        if (wrapper?.effect && !names[pass]?.startsWith("prediction")) held.add(wrapper.effect);
      });
  return world.driver.created.filter((effect) => held.has(effect));
}

/**
 * From now on, which mesh's readiness (`Mesh.isReady`, its caster checks included) requested each Effect the driver
 * creates. An Effect no mesh's readiness requested (a draw's, a shadow map's) has none.
 */
function effectRequesters(world: PlayWorld): Map<Effect, string> {
  const requesters = new Map<Effect, string>();
  const isReady = Mesh.prototype.isReady;
  vi.spyOn(Mesh.prototype, "isReady").mockImplementation(function (this: Mesh, ...args) {
    const before = world.driver.created.length;
    try {
      return isReady.apply(this, args);
    } finally {
      for (const effect of world.driver.created.slice(before)) if (!requesters.has(effect)) requesters.set(effect, this.name);
    }
  });
  return requesters;
}

/** The view keeps drawing, raises no hold and pauses nothing; the subject drew its previous Effect while the new one compiled. */
function expectSwapped(record: CauseRecord, model: Model): void {
  const detail = JSON.stringify(record);
  // The cause really compiled a lit variant, so the states below mean something.
  expect(record.litEffects, detail).toBeGreaterThan(0);
  // Only a pending compile (or pipeline) leaves a previous Effect drawing; a synchronous link draws the new one at once.
  // With more new variants than a frame admits (`FIRST_DRAWS_PER_FRAME`), whether the subject's waits depends on its
  // place in the queue, so that case does not say.
  const previous = model === "sync" && record.effects > FIRST_DRAWS_PER_FRAME
    ? {} : { previousEffectDrawn: record.previousEffectDrawn };
  expect({
    heldFrames: record.heldFrames, holdReported: record.holdReported, holdRaised: record.holdRaised,
    paused: record.pausedFrames > 0, recovered: record.recovered, ...previous,
    adopted: record.adopted,
    // One probe per frame while a swap is pending, not one per readiness question.
    probesAtMostOnePerFrame: record.probesPerFrame <= 1,
  }, detail).toEqual({
    heldFrames: 0, holdReported: false, holdRaised: false, paused: false, recovered: true,
    ...("previousEffectDrawn" in previous ? { previousEffectDrawn: model !== "sync" } : {}), adopted: true,
    probesAtMostOnePerFrame: true,
  });
}

/**
 * The names of the meshes drawn (`Mesh.render`) since the set was last cleared, leaving out warm draws (WebGPU: draws
 * under a warm pass only create pipelines and are always skipped).
 */
function spawnDraws(): Set<string> {
  const drawn = new Set<string>();
  const render = Mesh.prototype.render;
  vi.spyOn(Mesh.prototype, "render").mockImplementation(function (this: Mesh, ...args) {
    const engine = this.getScene().getEngine();
    if (!engine.getCurrentRenderPassName().startsWith("warm ")) drawn.add(this.name);
    return render.apply(this, args);
  });
  return drawn;
}

describe("compile holds after the first frame", () => {
  it.each(MODELS)("a point light switches off: %s", async (model) => {
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1]), point(11, [1.5, 2.5, -1])]);
    expectSwapped(await measure(world, () => world.place(point(11, [1.5, 2.5, -1], { enabled: false }))), model);
  });

  it.each(MODELS)("a point light is removed: %s", async (model) => {
    // Babylon will not draw a previous Effect after one of its lights was disposed; the view binds it without that light.
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1]), point(11, [1.5, 2.5, -1])]);
    expectSwapped(await measure(world, () => world.remove(11)), model);
  });

  it.each(MODELS)("a spot light stops casting shadows: %s", async (model) => {
    // The floor receives the crate's shadow; its unshadowed variant is new.
    const world = playWorld(model, [spot(10, [0, 5, 0], { castShadows: true })], [], "actor-1");
    expectSwapped(await measure(world, () => world.place(spot(10, [0, 5, 0]))), model);
  });

  it.each(MODELS)("the light inventory grows past its high-water mark: %s", async (model) => {
    // The sun and three points: four lights. A fifth, switched off, still raises every lit Material's light capacity.
    const world = playWorld(model, [point(10, [-2, 2.5, -1]), point(11, [2, 2.5, -1]), point(12, [0, 2.5, 2])]);
    expectSwapped(await measure(world, () => world.place(point(13, [0, 2.5, -3], { enabled: false }))), model);
  });

  it.each(MODELS)("the Forward budget swaps a point light for a spot light: %s", async (model) => {
    // The sun and eight points fill the nine shader slots; the spot, far away, is limited until it moves near the camera.
    const points = Array.from({ length: 8 }, (_, index) => point(10 + index, [-7 + index * 2, 2.5, -2]));
    const world = playWorld(model, [...points, spot(30, [0, 5, 40])]);
    const lightOf = (slotId: number) => world.handle.scene.lights.find((entry) => entry.name === `${AUTHORED_LIGHT_PREFIX}${slotId}`)!;
    let limitedBefore = false;
    const record = await measure(world, () => world.place(spot(30, [0, 5, -8])), () => {
      limitedBefore = isForwardLightExcluded(lightOf(30));
    });
    // The swap happened: the spot took a point's place.
    expect([limitedBefore, isForwardLightExcluded(lightOf(30))]).toEqual([true, false]);
    expect(points.filter((actor) => isForwardLightExcluded(lightOf(actor.slotId)))).toHaveLength(1);
    expectSwapped(record, model);
  });

  it.each((["unshadowed", "with a standby shadow map"] as const).flatMap((kind) => MODELS.map((model) => [kind, model] as const)))(
    "a spot nearing the Forward budget's cut-off has its variant compiled before the budget admits it, %s: %s", async (kind, model) => {
    // The sun and eight points fill the nine shader slots. The spot first comes within the prediction margin, where the
    // budget still leaves it out, then near enough that it takes a point's place. A shadowed spot's map waits on
    // standby meanwhile and comes back with its admission.
    predictAhead = true;
    const shadowed = kind !== "unshadowed";
    const at = (position: Vec3) => spot(30, position, shadowed ? { castShadows: true } : {});
    const points = Array.from({ length: 8 }, (_, index) => point(10 + index, [-7 + index * 2, 2.5, -2]));
    const world = playWorld(model, [...points, at([0, 5, 40])]);
    const controller = () => findSceneShadowController(world.handle.scene)!;
    const spotLight = () => world.handle.scene.lights.find((entry) => entry.name === `${AUTHORED_LIGHT_PREFIX}30`)!;
    await settle(world);
    world.place(at([0, 5, 3]));
    for (let index = 0; index < 12; index++) await world.frame();
    const limited = isForwardLightExcluded(spotLight());
    const standby = controller().boundGenerator(spotLight()) !== null && controller().generator(spotLight()) === null;
    const before = world.subjectEffect();
    world.driver.arm();
    world.place(at([0, 5, -8]));
    const frames: boolean[] = [];
    let adoptedAfter = -1;
    for (let index = 0; index < 8 && adoptedAfter < 0; index++) {
      const { view, effect } = await world.frame();
      frames.push(view?.rendered === true);
      if (effect && effect !== before) adoptedAfter = index;
    }
    // Admitted in the change's own frame, with an Effect compiled ahead. On WebGL2 the returning map's casters' depth
    // variants are first draws too, which the frame's first-draw budget spreads with the receivers': the subject's
    // comes in the next frame. On WebGPU its pipeline, which only a draw creates, still comes after (the previous
    // Effect draws meanwhile), while the returning map's casters find theirs: the controller's prediction map, standing
    // in for it, drew them ahead.
    expect({ limited, standby, admitted: !isForwardLightExcluded(spotLight()), compiled: realCompiles(world).length,
      drawn: frames.every(Boolean), adoptedAfter, warmedPipelines: world.driver.warmPipelines.size > 0,
      synchronousPipelines: world.driver.synchronous.size }).toEqual({
      limited: true, standby: shadowed, admitted: true, compiled: 0, drawn: true,
      adoptedAfter: model === "webgpu" ? -1 : shadowed ? 1 : 0, warmedPipelines: model === "webgpu", synchronousPipelines: 0,
    });
  });

  it("a warm draw that throws leaves every light's shadows as they were, and is reported once", async () => {
    // WebGPU: the object pass leaves a light holding a standby map unshadowed until it ends. One shadowed spot waits on
    // standby while another enters the Forward budget, whose receivers' new variants are warm-drawn in every frame
    // their pipelines are pending. Warm draws that throw must not end the pass early: the waiting spot's shadow flag
    // comes back after every frame, and the failure is reported once.
    const points = Array.from({ length: 8 }, (_, index) => point(10 + index, [-7 + index * 2, 2.5, -2]));
    const world = playWorld("webgpu", [...points, spot(30, [0, 5, 40], { castShadows: true }), spot(31, [0, 5, 40], { castShadows: true })]);
    const controller = () => findSceneShadowController(world.handle.scene)!;
    const spotLight = (slotId: number) => world.handle.scene.lights.find((entry) => entry.name === `${AUTHORED_LIGHT_PREFIX}${slotId}`)!;
    const onStandby = () => controller().boundGenerator(spotLight(31)) !== null && controller().generator(spotLight(31)) === null;
    await settle(world);
    world.place(spot(31, [0, 5, 3], { castShadows: true }));
    for (let index = 0; index < 12; index++) await world.frame();
    const render = Mesh.prototype.render;
    let thrown = 0;
    Mesh.prototype.render = function (this: Mesh, ...args: Parameters<typeof render>) {
      if (world.engine.getRenderPassNames()[world.engine.currentRenderPassId]?.startsWith("warm ")) {
        thrown++;
        throw new Error("injected warm draw failure");
      }
      return render.apply(this, args);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanups.push(() => { Mesh.prototype.render = render; warn.mockRestore(); });
    const standby = onStandby();
    world.driver.arm();
    world.place(spot(30, [0, 5, -8], { castShadows: true }));
    let escaped = false;
    const shadowed: boolean[] = [];
    const waiting: boolean[] = [];
    let throwingFrames = 0;
    for (let index = 0; index < 8; index++) {
      const before = thrown;
      try {
        await world.frame();
      } catch {
        escaped = true;
      }
      if (thrown > before) throwingFrames++;
      waiting.push(onStandby());
      shadowed.push(spotLight(31).shadowEnabled);
    }
    const reports = warn.mock.calls.filter(([message]) => String(message).includes("warm draws failed")).length;
    expect({ standby, admitted: !isForwardLightExcluded(spotLight(30)), waiting: waiting.every(Boolean), repeated: throwingFrames > 1,
      escaped, shadowed: shadowed.every(Boolean), reports }).toEqual({
      standby: true, admitted: true, waiting: true, repeated: true, escaped: false, shadowed: true, reports: 1 });
  });

  it("a prediction that never comes true expires and gives back its passes and Effects", async () => {
    // The spot waits within the margin, then leaves it for longer than the expiry: its prediction's draw wrappers and
    // the Effects only they held go, and the next prediction reuses its render pass ids.
    predictAhead = true;
    const points = Array.from({ length: 8 }, (_, index) => point(10 + index, [-7 + index * 2, 2.5, -2]));
    const world = playWorld("sync", [...points, spot(30, [0, 5, 40])]);
    await settle(world);
    const cached = (world.engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects;
    /** The Effects draw wrappers under a prediction's render passes hold. */
    const predicted = () => new Set(world.handle.scene.meshes.flatMap((mesh) => (mesh.subMeshes ?? []).flatMap((subMesh) =>
      (subMesh as unknown as { _drawWrappers: ({ effect?: Effect | null } | undefined)[] })._drawWrappers.flatMap((wrapper, pass) =>
        wrapper?.effect && world.engine.getRenderPassNames()[pass]?.startsWith("prediction") ? [wrapper.effect] : []))));
    const approach = async () => {
      world.place(spot(30, [0, 5, 3]));
      for (let index = 0; index < 12; index++) await world.frame();
    };
    await approach();
    const held = predicted();
    const passes = world.engine.getRenderPassNames().length;
    world.place(spot(30, [0, 5, 40]));
    frameMs = 1_000;
    for (let index = 0; index < 7; index++) await world.frame();
    frameMs = FRAME_MS;
    const expired = { held: predicted().size, cached: Object.values(cached).filter((effect) => held.has(effect)).length };
    await approach();
    expect({ held: held.size, expired, again: predicted().size > 0, reused: world.engine.getRenderPassNames().length === passes })
      .toEqual({ held: 2, expired: { held: 0, cached: 0 }, again: true, reused: true });
  });

  it.each((["borrowed", "first of its kind"] as const).flatMap((start) => MODELS.map((model) => [start, model] as const)))(
    "a spot nearing the shadow budget's cut-off has its variants compiled before it takes a point's map, %s: %s", async (start, model) => {
    // Two local shadow maps, a farther point's and either a spot's or another point's. A third shadowed light, a spot,
    // first comes within the prediction margin of the farther holder's ranking distance, then near enough to take its
    // map: a new spot map, while the point's receivers lose its shadow. Its receivers' defines come from the admitted
    // spot map, or, with no spot map admitted, from the controller's prediction map, which also gives its casters'
    // depth variants and never attaches to a light.
    predictAhead = true;
    const world = playWorld(model, [
      start === "borrowed" ? spot(10, [0, 5, 0], { castShadows: true }) : point(10, [0, 4, 0], { castShadows: true }),
      point(11, [3, 4, 4], { castShadows: true }), spot(30, [0, 5, 40], { castShadows: true })]);
    updateSceneRenderingSettings(world.handle.scene,
      { shadows: { ...sceneRenderingSettings(world.handle.scene).shadows, localLightMode: "manual", maxLocalLights: 2 } });
    const controller = () => findSceneShadowController(world.handle.scene)!;
    const lightOf = (slotId: number) => world.handle.scene.lights.find((entry) => entry.name === `${AUTHORED_LIGHT_PREFIX}${slotId}`)!;
    await settle(world);
    world.place(spot(30, [0, 5, 8], { castShadows: true }));
    for (let index = 0; index < 12; index++) await world.frame();
    const waiting = { lit: lightOf(30).isEnabled(), map: controller().generator(lightOf(30)) !== null, point: controller().generator(lightOf(11)) !== null };
    const predictionMaps = controller().heldPredictionMaps.length;
    const attached = world.handle.scene.lights.some((light) => [...(light.getShadowGenerators()?.values() ?? [])]
      .some((generator) => controller().heldPredictionMaps.includes(generator as ShadowGenerator)));
    const before = world.subjectEffect();
    world.driver.arm();
    world.place(spot(30, [0, 5, 2], { castShadows: true }));
    const frames: boolean[] = [];
    let adoptedAfter = -1;
    for (let index = 0; index < 8 && adoptedAfter < 0; index++) {
      const { view, effect } = await world.frame();
      frames.push(view?.rendered === true);
      if (effect && effect !== before) adoptedAfter = index;
    }
    // The spot's prediction is kept until its new map first draws, then goes with its prediction map. That first draw
    // asks for its casters' depth variants, so it is part of the admission.
    for (let index = 0; index < 6; index++) await world.frame();
    const compiled = realCompiles(world).length;
    // On WebGPU the receivers' pipelines, which only a draw creates, still come after the admission (their previous
    // Effects draw meanwhile), while the new map's casters find theirs: the admitted spot map's, or those the
    // prediction map's warm render created ahead.
    expect({ waiting, predictionMaps, attached, map: controller().generator(lightOf(30)) !== null,
      point: controller().generator(lightOf(11)) !== null,
      // The spot's prediction map goes with its admission (the point that lost its map may now be predicted with one).
      released: controller().heldPredictionMaps.filter((map) => map.getLight() instanceof SpotLight).length,
      compiled, drawn: frames.every(Boolean), adoptedAtOnce: adoptedAfter === 0, synchronousPipelines: world.driver.synchronous.size }).toEqual({
      waiting: { lit: true, map: false, point: true }, predictionMaps: start === "borrowed" ? 0 : 1, attached: false,
      map: true, point: false, released: 0, compiled: 0, drawn: true, adoptedAtOnce: model !== "webgpu", synchronousPipelines: 0,
    });
  });

  it("a prediction map serves its kind's first starts, reserves its bytes, attaches to no light and goes with a load", async () => {
    // Two point maps; two shadowed spots wait within the margin of the farther point's ranking distance. No spot map
    // is admitted, so both are first starts of their kind, and one prediction map of that kind serves both.
    predictAhead = true;
    const world = playWorld("sync", [point(10, [0, 4, 0], { castShadows: true }), point(11, [3, 4, 4], { castShadows: true }),
      spot(30, [0, 5, 40], { castShadows: true }), spot(31, [2, 5, 40], { castShadows: true })]);
    updateSceneRenderingSettings(world.handle.scene,
      { shadows: { ...sceneRenderingSettings(world.handle.scene).shadows, localLightMode: "manual", maxLocalLights: 2 } });
    const controller = () => findSceneShadowController(world.handle.scene)!;
    await settle(world);
    const reserved = () => managedRenderReservations(world.engine).shadowBytes;
    const before = reserved();
    world.place(spot(30, [0, 5, 8], { castShadows: true }));
    world.place(spot(31, [1, 5, 8.5], { castShadows: true }));
    for (let index = 0; index < 16; index++) await world.frame();
    const maps = controller().heldPredictionMaps;
    const held = {
      maps: maps.length,
      bytes: reserved() - before,
      attached: world.handle.scene.lights.some((light) => [...(light.getShadowGenerators()?.values() ?? [])]
        .some((generator) => maps.includes(generator as ShadowGenerator))),
      listed: maps.some((map) => world.handle.scene.textures.includes(map.getShadowMap()!)),
      realMaps: world.handle.scene.lights.filter((light) => controller().generator(light)).length,
    };
    world.handle.applyCommand({ type: "sceneLoading", sceneAssetGuid: "next", sceneLoadId: 1_000 });
    expect({ held, afterLoad: { maps: controller().heldPredictionMaps.length, bytes: reserved() - before } }).toEqual({
      held: { maps: 1, bytes: PREDICTION_MAP_SIZE ** 2 * shadowBytesPerTexel(world.engine), attached: false, listed: false, realMaps: 2 },
      afterLoad: { maps: 0, bytes: 0 },
    });
  });

  /** The first spot map's setup: two point maps, and a shadowed spot that waits within the margin of the farther one. */
  async function firstSpotMapWorld(model: Model) {
    predictAhead = true;
    const world = playWorld(model, [point(10, [0, 4, 0], { castShadows: true }), point(11, [3, 4, 4], { castShadows: true }),
      spot(30, [0, 5, 40], { castShadows: true })]);
    updateSceneRenderingSettings(world.handle.scene,
      { shadows: { ...sceneRenderingSettings(world.handle.scene).shadows, localLightMode: "manual", maxLocalLights: 2 } });
    await settle(world);
    return {
      world,
      controller: () => findSceneShadowController(world.handle.scene)!,
      spotLight: () => world.handle.scene.lights.find((entry) => entry.name === `${AUTHORED_LIGHT_PREFIX}30`)!,
    };
  }

  it("a prediction map whose render throws mid-draw throws nothing out of a frame, is reported once and is not rendered again", async () => {
    // WebGPU: the prediction map's warm render runs after the view's graph render, inside the frame. Each prediction
    // map throws inside its pass, with its target bound; the view keeps drawing. The spot then leaves for longer than
    // the expiry and comes back: the next prediction's map throws as well, and is not reported again.
    const { world, controller } = await firstSpotMapWorld("webgpu");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanups.push(() => warn.mockRestore());
    const throwing = new WeakSet<object>();
    let thrown = 0;
    let escaped = 0;
    const drawn: boolean[] = [];
    const frames = async (count: number) => {
      for (let index = 0; index < count; index++) {
        const map = controller().heldPredictionMaps[0]?.getShadowMap();
        if (map && !throwing.has(map)) {
          throwing.add(map);
          map.onBeforeRenderObservable.add(() => { thrown++; throw new Error("injected prediction map draw failure"); });
        }
        try {
          const { view } = await world.frame();
          drawn.push(view?.rendered === true);
        } catch {
          escaped++;
        }
      }
    };
    world.place(spot(30, [0, 5, 8], { castShadows: true }));
    await frames(16);
    world.place(spot(30, [0, 5, 40], { castShadows: true }));
    frameMs = 1_000;
    await frames(7);
    frameMs = FRAME_MS;
    world.place(spot(30, [0, 5, 8], { castShadows: true }));
    await frames(16);
    const reports = warn.mock.calls.filter(([message]) => String(message).includes("Prediction map render failed")).length;
    expect({ thrown, escaped, drawn: drawn.every(Boolean), reports }).toEqual({ thrown: 2, escaped: 0, drawn: true, reports: 1 });
  });

  it("a prediction map whose depth shaders load late still gives its casters' depth variants", async () => {
    // A map just built imports its depth shaders first, and until then prepares no caster: the probe waits for them
    // (here held back for a few frames), so the first spot map's admission compiles nothing.
    const { world, controller, spotLight } = await firstSpotMapWorld("sync");
    const prototype = ShadowGenerator.prototype as unknown as { _initShaderSourceAsync(...args: unknown[]): Promise<void> };
    const initShaders = prototype._initShaderSourceAsync;
    let load!: () => void;
    const loaded = new Promise<void>((resolve) => { load = resolve; });
    prototype._initShaderSourceAsync = async function (this: ShadowGenerator, ...args: unknown[]) {
      await loaded;
      return initShaders.apply(this, args);
    };
    cleanups.push(() => { prototype._initShaderSourceAsync = initShaders; });
    world.place(spot(30, [0, 5, 8], { castShadows: true }));
    for (let index = 0; index < 6; index++) await world.frame();
    const map = controller().heldPredictionMaps[0];
    const waited = !!map && !(map as unknown as { _shadersLoaded: boolean })._shadersLoaded;
    load();
    for (let index = 0; index < 12; index++) await world.frame();
    world.driver.arm();
    world.place(spot(30, [0, 5, 2], { castShadows: true }));
    for (let index = 0; index < 14; index++) await world.frame();
    expect({ waited, map: controller().generator(spotLight()) !== null, compiled: realCompiles(world).length })
      .toEqual({ waited: true, map: true, compiled: 0 });
  });

  it("a prediction that never completes stops at its expiry and holds back no later start", async () => {
    // Two spot maps, room for a third local map, and the relevant area ends 20 units from the camera (the shadow
    // distance and a light's range). A point and, farther, a spot wait just outside it, asking for shadows only there
    // (so neither holds a standby map); the point's start would build the first point map, whose prediction map never
    // loads its depth shaders, so its prediction never completes. Once it stops, the spot's start (borrowing a spot
    // map) is predicted, and its admission compiles nothing.
    predictAhead = true;
    const world = playWorld("sync", [spot(10, [0, 5, 0], { castShadows: true }), spot(11, [3, 5, 4], { castShadows: true }),
      point(30, [0, 4, 2_000]), spot(12, [0, 5, 2_000])]);
    updateSceneRenderingSettings(world.handle.scene, { shadows: { ...sceneRenderingSettings(world.handle.scene).shadows,
      localLightMode: "manual", maxLocalLights: 3, distance: 8 } });
    await settle(world);
    const prototype = ShadowGenerator.prototype as unknown as { _initShaderSourceAsync(...args: unknown[]): Promise<void> };
    const initShaders = prototype._initShaderSourceAsync;
    prototype._initShaderSourceAsync = function (this: ShadowGenerator & { _mapSize: number }, ...args: unknown[]) {
      return this._mapSize === PREDICTION_MAP_SIZE ? new Promise<void>(() => {}) : initShaders.apply(this, args);
    };
    cleanups.push(() => { prototype._initShaderSourceAsync = initShaders; });
    world.place(point(30, [0, 4, 12], { castShadows: true }));
    world.place(spot(12, [0, 5, 16], { castShadows: true }));
    frameMs = 1_000;
    for (let index = 0; index < 7; index++) await world.frame();
    frameMs = FRAME_MS;
    for (let index = 0; index < 12; index++) await world.frame();
    world.driver.arm();
    world.place(spot(12, [0, 5, 6], { castShadows: true }));
    for (let index = 0; index < 14; index++) await world.frame();
    const spotLight = world.handle.scene.lights.find((entry) => entry.name === `${AUTHORED_LIGHT_PREFIX}12`)!;
    expect({ map: findSceneShadowController(world.handle.scene)!.generator(spotLight) !== null, compiled: realCompiles(world).length })
      .toEqual({ map: true, compiled: 0 });
  });

  const approaches = {
    // The spot's map waits on standby while the Forward budget leaves it out, and comes back with its admission.
    "a shadowed spot enters the Forward budget": {
      actors: () => [...Array.from({ length: 8 }, (_, index) => point(10 + index, [-7 + index * 2, 2.5, -2])),
        spot(30, [0, 5, 40], { castShadows: true })],
      step: 1.7,
      frames: 30,
      configure: undefined,
      prepare: undefined,
    },
    // Two local maps: the spot takes the farther point's, a new spot map whose defines the other spot's give.
    "a spot takes a point's shadow map": {
      actors: () => [spot(10, [0, 5, 0], { castShadows: true }), point(11, [3, 4, 4], { castShadows: true }),
        spot(30, [0, 5, 40], { castShadows: true })],
      step: 1.7,
      frames: 24,
      configure: (world: PlayWorld) => updateSceneRenderingSettings(world.handle.scene,
        { shadows: { ...sceneRenderingSettings(world.handle.scene).shadows, localLightMode: "manual", maxLocalLights: 2 } }),
      prepare: undefined,
    },
    // Two point maps: the spot takes the farther one's, the first spot map, whose variants a prediction map gives.
    // Its frames run on past the prediction map's release, so the frames compared include it.
    "a spot takes a point's shadow map, the first of its kind": {
      actors: () => [point(10, [0, 4, 0], { castShadows: true }), point(11, [3, 4, 4], { castShadows: true }),
        spot(30, [0, 5, 40], { castShadows: true })],
      step: 1.7,
      frames: 30,
      configure: (world: PlayWorld) => updateSceneRenderingSettings(world.handle.scene,
        { shadows: { ...sceneRenderingSettings(world.handle.scene).shadows, localLightMode: "manual", maxLocalLights: 2 } }),
      prepare: undefined,
    },
    // A same-kind exchange first leaves the points out of creation order; the spot's what-if admission changes the
    // kind mix, which puts the lights in canonical order, and its give-back must put the exchanged order back.
    "a spot nears the Forward budget after a point exchange": {
      actors: () => [...Array.from({ length: 8 }, (_, index) => point(10 + index, [-7 + index * 2, 2.5, -2])),
        point(18, [0, 2.5, 60]), spot(30, [0, 5, 40], { castShadows: true })],
      step: 1.7,
      frames: 30,
      configure: undefined,
      prepare: async (world: PlayWorld) => {
        world.place(point(10, [-7, 2.5, 60]));
        world.place(point(18, [-7, 2.5, -2]));
        for (let index = 0; index < 4; index++) await world.frame();
      },
    },
  } as const;

  it.each((Object.keys(approaches) as (keyof typeof approaches)[]).flatMap((name) => (["sync", "webgpu"] as const).map((model) => [name, model] as const)))(
    "a prediction never changes what a frame admits, draws or probes while %s: %s", async (name, model) => {
    // Frame by frame, with and without prediction, while a spot approaches the camera: the lights in scene order, which
    // are lit and which hold shadow maps (and each light's generators, with their casters), the variant the subject's
    // draw wrapper asks for and the one it draws, whether the frame drew, the real draw wrappers' readiness memos and
    // light marks going into it, the variants adopted in it and the strict readiness probes so far.
    const scenario = approaches[name];
    const approach = async (predict: boolean) => {
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
      if (vi.isMockFunction(SceneRenderCoordinator.prototype.render)) vi.mocked(SceneRenderCoordinator.prototype.render).mockRestore();
      predictAhead = predict;
      const world = playWorld(model, [...scenario.actors()]);
      scenario.configure?.(world);
      const controller = () => findSceneShadowController(world.handle.scene)!;
      await settle(world);
      await scenario.prepare?.(world);
      const pass = () => world.engine.getRenderPassNames().lastIndexOf("Forward objects#0");
      /** The real main-pass draw wrappers, with the Effect each holds. */
      const real = () => world.handle.scene.meshes.flatMap((mesh) => (mesh.subMeshes ?? []).flatMap((subMesh) => {
        const wrapper = subMesh._getDrawWrapper(pass()) as unknown as
          { effect?: Effect | null; _wasPreviouslyReady?: boolean; defines?: { _areLightsDirty?: boolean; _isDirty?: boolean } } | undefined;
        return wrapper?.effect ? [{ name: mesh.name, wrapper }] : [];
      }));
      const states: unknown[] = [];
      const drawn: (string | null)[] = [];
      const predictionMaps: number[] = [];
      const wrapperMarks: string[][] = [];
      const adopted: number[] = [];
      const compiled: number[] = [];
      const checks: number[] = [];
      const effects = (world.engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects;
      let previous = new Map(real().map(({ name, wrapper }) => [name, wrapper.effect]));
      // Materials refreshed per frame: a what-if refreshes none.
      let refreshed = 0;
      const markDirty = Material.prototype.markDirty;
      Material.prototype.markDirty = function (this: Material, ...args: Parameters<typeof markDirty>) {
        refreshed++;
        return markDirty.apply(this, args);
      };
      cleanups.push(() => { Material.prototype.markDirty = markDirty; });
      for (let index = 0; index < scenario.frames; index++) {
        const refreshedBefore = refreshed;
        world.place(spot(30, [0, 5, 40 - index * scenario.step], { castShadows: true }));
        const marks = real().filter(({ wrapper }) => !wrapper._wasPreviouslyReady || wrapper.defines?._areLightsDirty || wrapper.defines?._isDirty)
          .map(({ name }) => name).sort();
        const { view, effect } = await world.frame();
        const subject = world.handle.scene.getMeshByName("actor-2")!.subMeshes[0]!;
        states.push({
          lights: world.handle.scene.lights.filter((light) => light.name.startsWith(AUTHORED_LIGHT_PREFIX))
            .map((light) => `${light.name.slice(AUTHORED_LIGHT_PREFIX.length)}:${light.isEnabled() ? "lit" : "off"}${controller().generator(light) ? "+map" : ""}`),
          generators: world.handle.scene.lights.map((light) => [...(light.getShadowGenerators()?.values() ?? [])]
            .map((generator) => generator.getShadowMap()?.renderList?.map((mesh) => mesh.name).sort().join("+") ?? null)),
          requested: subject._getDrawWrapper(pass())?.defines?.toString() ?? null,
          rendered: view?.rendered === true,
          refreshed: refreshed - refreshedBefore,
        });
        wrapperMarks.push(marks);
        drawn.push(effect?.defines ?? null);
        predictionMaps.push(controller().heldPredictionMaps.length);
        const current = new Map(real().map(({ name, wrapper }) => [name, wrapper.effect]));
        adopted.push([...current].filter(([key, held]) => previous.has(key) && previous.get(key) !== held).length);
        previous = current;
        compiled.push(Object.keys(effects).length);
        checks.push(view?.checks ?? -1);
      }
      return { states, drawn, wrapperMarks, adopted, compiled, checks, predictionMaps };
    };
    const baseline = await approach(false);
    const predicted = await approach(true);
    expect(predicted.states).toEqual(baseline.states);
    // What a frame draws differs only where the run without prediction still drew the previous variant, never later
    // than without it, and its first draws keep to the per-frame budget.
    const requested = (state: unknown) => (state as { requested: string | null }).requested;
    const lagged = (run: typeof baseline) => run.drawn.filter((defines, index) => defines !== requested(run.states[index])).length;
    const counts = JSON.stringify({ baseline: baseline.compiled, predicted: predicted.compiled, baselineChecks: baseline.checks,
      predictedChecks: predicted.checks, baselineAdopted: baseline.adopted, predictedAdopted: predicted.adopted });
    expect({
      sameOrAdopted: predicted.drawn.every((defines, index) => defines === baseline.drawn[index] || defines === requested(predicted.states[index])),
      notLater: lagged(predicted) <= lagged(baseline),
      firstDraws: Math.max(...predicted.adopted) <= FIRST_DRAWS_PER_FRAME,
      adoptedAlike: predicted.adopted.reduce((sum, count) => sum + count, 0) === baseline.adopted.reduce((sum, count) => sum + count, 0),
    }, counts).toEqual({ sameOrAdopted: true, notLater: true, firstDraws: true, adoptedAlike: true });
    // The admission frame compiles nothing with prediction: what it asks for was compiled on earlier frames.
    const admitted = baseline.compiled.findIndex((count, index) => index > 0 && count > baseline.compiled[index - 1]!);
    expect(admitted, counts).toBeGreaterThan(0);
    // Until then the real draw wrappers go into each frame with the readiness memos and light marks they would have
    // without prediction (an earlier adoption leaves them ready sooner afterwards), and again once both runs draw
    // their new variants: through the frame that releases a prediction map, too.
    expect(predicted.wrapperMarks.slice(0, admitted + 1)).toEqual(baseline.wrapperMarks.slice(0, admitted + 1));
    const settled = (run: typeof baseline) => run.drawn.findIndex((defines, index) => index >= admitted &&
      run.drawn.slice(index).every((later, at) => later === requested(run.states[index + at])));
    const both = Math.max(settled(baseline), settled(predicted));
    expect(both, counts).toBeGreaterThanOrEqual(admitted);
    expect(predicted.wrapperMarks.slice(both + 1)).toEqual(baseline.wrapperMarks.slice(both + 1));
    if (name === "a spot takes a point's shadow map, the first of its kind") {
      // Its prediction map goes after the admission, before a frame compared.
      const released = predicted.predictionMaps.findIndex((count, index) => index > admitted && count < predicted.predictionMaps[index - 1]!);
      expect({ released: released > admitted, compared: released >= both && released < scenario.frames - 1 }, JSON.stringify(predicted.predictionMaps))
        .toEqual({ released: true, compared: true });
    }
    expect({
      atAdmission: predicted.compiled[admitted]! - predicted.compiled[admitted - 1]!,
      ahead: predicted.compiled[admitted - 1]! > baseline.compiled[admitted - 1]!,
      // Its what-if admission, given back before any frame draws it, never asks a frame for a strict readiness probe.
      addedProbes: predicted.checks.some((count, index) => count > baseline.checks[index]!),
    }, counts).toEqual({ atAdmission: 0, ahead: true, addedProbes: false });
  });

  it("predictions settle with more lights near the Forward budget's cut-off than they hold", async () => {
    // Thirteen points at nearly one distance from the camera: those past the budget all sit within the margin, more
    // than PREDICTIONS_MAX of them. With the camera still, prediction work ends after its first frames: no what-if
    // admission toggles a light and no prediction's draw wrappers are dropped.
    predictAhead = true;
    const lights = Array.from({ length: 13 }, (_, index) => point(100 + index, [Math.cos(index) * 6, 2.5 + (index % 3) * 0.1, Math.sin(index) * 6]));
    const world = playWorld("sync", [...lights]);
    await settle(world);
    const near = nearForwardAdmissions(world.handle.scene, 1.5).length;
    for (let index = 0; index < 20; index++) await world.frame();
    let toggles = 0;
    let removals = 0;
    const setEnabled = Light.prototype.setEnabled;
    Light.prototype.setEnabled = function (this: Light, ...args: Parameters<typeof setEnabled>) {
      toggles++;
      return setEnabled.apply(this, args);
    };
    const remove = SubMesh.prototype._removeDrawWrapper;
    SubMesh.prototype._removeDrawWrapper = function (this: SubMesh, ...args: Parameters<typeof remove>) {
      removals++;
      return remove.apply(this, args);
    };
    cleanups.push(() => { SubMesh.prototype._removeDrawWrapper = remove; Light.prototype.setEnabled = setEnabled; });
    for (let index = 0; index < 20; index++) await world.frame();
    expect({ moreThanHeld: near > PREDICTIONS_MAX, toggles, removals }).toEqual({ moreThanHeld: true, toggles: 0, removals: 0 });
  });

  it("predictions settle while the fourth and fifth lights near the cut-off trade places every frame", async () => {
    // The thirteen-point ring: the fifth candidate moves 1% either side of the fourth's distance each frame, so the two
    // trade ranks. Neither prediction is dropped for the other while both stay near.
    predictAhead = true;
    const ring = (index: number): Vec3 => [Math.cos(index) * 6, 2.5 + (index % 3) * 0.1, Math.sin(index) * 6];
    const world = playWorld("sync", Array.from({ length: 13 }, (_, index) => point(100 + index, ring(index))));
    await settle(world);
    for (let index = 0; index < 20; index++) await world.frame();
    const near = nearForwardAdmissions(world.handle.scene, 1.5);
    const camera = world.handle.scene.activeCamera!.globalPosition.clone();
    const fourth = Vector3.Distance(near[3]!.getAbsolutePosition(), camera);
    const fifth = near[4]!;
    const slot = Number(fifth.name.slice(AUTHORED_LIGHT_PREFIX.length));
    const direction = fifth.getAbsolutePosition().subtract(camera).normalize();
    let removals = 0;
    const remove = SubMesh.prototype._removeDrawWrapper;
    SubMesh.prototype._removeDrawWrapper = function (this: SubMesh, ...args: Parameters<typeof remove>) {
      removals++;
      return remove.apply(this, args);
    };
    cleanups.push(() => { SubMesh.prototype._removeDrawWrapper = remove; });
    const ranks: string[] = [];
    for (let index = 0; index < 20; index++) {
      const target = camera.add(direction.scale(fourth * (index % 2 ? 1.01 : 0.99)));
      world.place(point(slot, [target.x, target.y, target.z]));
      await world.frame();
      ranks.push(nearForwardAdmissions(world.handle.scene, 1.5).slice(0, PREDICTIONS_MAX).includes(fifth) ? "in" : "out");
    }
    expect({ traded: ranks.includes("in") && ranks.includes("out"), removals }).toEqual({ traded: true, removals: 0 });
  });

  it("a light switched off during a frame a prediction runs in still refreshes a frozen Material", async () => {
    // Switched off inside the frame's render, after its lighting sync, while a spot waits within the margin: a frozen
    // Material keeps its cached readiness until the lighting refreshes it. The prediction's held what-if refreshes no
    // Material, so the plain sync before it must, or the subject would keep its stale variant.
    const run = async (predict: boolean) => {
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
      if (vi.isMockFunction(SceneRenderCoordinator.prototype.render)) vi.mocked(SceneRenderCoordinator.prototype.render).mockRestore();
      predictAhead = predict;
      const points = Array.from({ length: 8 }, (_, index) => point(10 + index, [-7 + index * 2, 2.5, -2]));
      const world = playWorld("sync", [...points, spot(30, [0, 5, 40])]);
      await settle(world);
      world.handle.scene.getMeshByName("actor-2")!.subMeshes[0]!.getMaterial()!.freeze();
      const switched = world.handle.scene.lights.find((light) => light.name === `${AUTHORED_LIGHT_PREFIX}11`)!;
      world.handle.scene.onAfterRenderObservable.addOnce(() => setAuthoredLightEnabled(switched, false));
      world.place(spot(30, [0, 5, 3]));
      for (let index = 0; index < 4; index++) await world.frame();
      // The freed slot then admits the spot the prediction was made for.
      const admitted = !isForwardLightExcluded(world.handle.scene.lights.find((light) => light.name === `${AUTHORED_LIGHT_PREFIX}30`)!);
      return { admitted, drawn: world.subjectEffect()?.defines ?? null };
    };
    const baseline = await run(false);
    const predicted = await run(true);
    expect({ admitted: predicted.admitted, same: predicted.drawn === baseline.drawn }).toEqual({ admitted: true, same: true });
  });

  it("predicted variants still adopt at most FIRST_DRAWS_PER_FRAME new variants per frame", async () => {
    // Six barrels with Materials of their own: a spot the prediction compiled ahead for comes into the Forward budget,
    // and each Material asks for its variant at once. The first draws still spread over frames (on iPad WebKit WebGL2
    // a program's first draw is the stall), with nothing left to compile.
    const guids = ["surface-a", "surface-b", "surface-c", "surface-d", "surface-e", "surface-f"];
    const barrels: Actor[] = guids.map((_, index) =>
      ({ slotId: 50 + index, guid: `barrel-${index}`, position: [-5 + index * 2, 1, 1], assign: { meshAssetGuid: null, meshKind: "box" } }));
    const points = Array.from({ length: 8 }, (_, index) => point(10 + index, [-7 + index * 2, 2.5, -2]));
    predictAhead = true;
    const world = playWorld("sync", [...points, spot(30, [0, 5, 40]), ...barrels], guids);
    guids.forEach((guid, index) => world.handle.applyCommand({ type: "assignMaterial", slotId: 50 + index, materialAssetGuid: guid }));
    await settle(world);
    world.place(spot(30, [0, 5, 3]));
    for (let index = 0; index < 40; index++) await world.frame();
    const pass = () => world.engine.getRenderPassNames().lastIndexOf("Forward objects#0");
    const effects = () => barrels.map((actor) => world.handle.scene.getMeshByName(`actor-${actor.slotId}`)!.subMeshes[0]!._getDrawWrapper(pass())?.effect ?? null);
    let current = effects();
    const start = current;
    world.driver.arm();
    world.place(spot(30, [0, 5, -8]));
    const perFrame: number[] = [];
    for (let index = 0; index < 10; index++) {
      await world.frame();
      const next = effects();
      perFrame.push(next.filter((effect, at) => effect !== current[at]).length);
      current = next;
    }
    expect({ compiled: world.driver.created.length, most: Math.max(...perFrame), all: current.every((effect, at) => effect !== start[at]) },
      JSON.stringify(perFrame)).toEqual({ compiled: 0, most: FIRST_DRAWS_PER_FRAME, all: true });
  });

  it.each(MODELS)("an area light's emission texture arrives: %s", async (model) => {
    const pixels = await areaEmissionPixels();
    const world = playWorld(model, []);
    world.handle.applyCommand({ type: "setAreaLights", slotId: 2, lights: areaRectLightBindings([{ id: "panel", classId: "AreaRectLightComponent", properties: { textureGuid: "panel-texture" } }]) });
    expectSwapped(await measure(world, () => world.handle.setMeshAssets({ areaEmissions: new Map([["panel-texture", pixels]]) })), model);
  });

  it.each(MODELS)("a frozen graph Material adopts its new variant: %s", async (model) => {
    // The editor freezes library Materials; a frozen NodeMaterial adopts a ready variant only when probed.
    const barrel: Actor = { slotId: 20, guid: "barrel", position: [2, 1, 1], assign: { meshAssetGuid: null, meshKind: "box" } };
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1]), point(11, [1.5, 2.5, -1]), barrel], ["surface-a"], "actor-20");
    world.handle.applyCommand({ type: "assignMaterial", slotId: 20, materialAssetGuid: "surface-a" });
    const record = await measure(world, () => world.place(point(11, [1.5, 2.5, -1], { enabled: false })), () => {
      const material = world.handle.scene.getMeshByName("actor-20")!.material!;
      expect(material.getClassName()).toBe("NodeMaterial");
      material.freeze();
    });
    expectSwapped(record, model);
  });

  it.each(MODELS.flatMap((model) => (["a point switches off", "a spot starts casting shadows"] as const).map((cause) => [model, cause] as const)))(
    "a light change the load rehearsed compiles nothing: %s, %s", async (model, cause) => {
    // The load rehearses each authored light's changes (on or off, shadows on or off) behind its loading screen, so
    // the variants they ask for are compiled, and drawn once, before the first presented frame.
    rehearseLoad = true;
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1]), point(11, [1.5, 2.5, -1]), spot(12, [0, 5, 0])], [],
      cause === "a point switches off" ? "actor-2" : "actor-1");
    const record = await measure(world, () => cause === "a point switches off"
      ? world.place(point(11, [1.5, 2.5, -1], { enabled: false }))
      : world.place(spot(12, [0, 5, 0], { castShadows: true })));
    const rehearsal = world.handle.loadRehearsalStats();
    expect({
      rehearsed: (rehearsal?.steps ?? 0) > 0, compiled: (rehearsal?.variants ?? 0) > 0,
      effects: record.effects, pipelines: record.pipelines + record.warmPipelines,
      heldFrames: record.heldFrames, holdRaised: record.holdRaised, paused: record.pausedFrames > 0, recovered: record.recovered,
    }, JSON.stringify({ record, rehearsal })).toEqual({
      rehearsed: true, compiled: true, effects: 0, pipelines: 0, heldFrames: 0, holdRaised: false, paused: false,
      recovered: true,
    });
  });

  /** A torch: a shadowed spot. */
  const TORCH = { castShadows: true, range: 12, outerAngle: 70, innerAngle: 40 };
  /** A Class whose prefab holds the torch. */
  const TORCH_CLASS = () => classesLoad([lightClass("Torch", { lightKind: "spot", ...TORCH })]);
  /** A Spawn Actor names Pickup, a Class the load does not hold: Load On Demand, it arrives with its spawn. */
  const ON_DEMAND = () => classesLoad([{ assetGuid: "spawner", classId: "Spawner", source: "", anchors: [], entryPoints: [] }],
    [{ guid: "spawner", dependencies: ["pickup"] }]);
  /** Play's camera high above the floor, looking down at the crate. */
  const HIGH_CAMERA = new Vector3(0, 25, -10);
  const SPAWN_CASES: ReadonlyArray<readonly [string, {
    /** The startup sources' Classes and dependencies. */
    load: () => SpawnableLightLoad;
    /** The light spawned in slot 40 (facing the way a torch the player carries does, or down), or an authored change. */
    spawn?: { position: Vec3; rotation?: Quat; assign: Actor["assign"]; shadows: boolean };
    /** Two local lights in the Forward budget: the points, nearer the camera than the spot. */
    full?: boolean;
    camera?: Vector3;
    /** The authored lights, when not two points and a spot. */
    lights?: () => Actor[];
  }]> = [
    ["a torch spawns near the camera", { load: TORCH_CLASS, spawn: { position: [0.5, 2.5, -9], assign: light("spot", TORCH), shadows: true } }],
    ["a torch spawns near the camera into a full Forward budget",
      { load: TORCH_CLASS, full: true, spawn: { position: [0.5, 2.5, -9], assign: light("spot", TORCH), shadows: true } }],
    // The stand-in at the camera reaches the casters only by reaching as far as the shadow distance; no authored point
    // starting to cast draws a point map's caster depth variants (a cube of distances) instead.
    ["a lantern spawns near the casters below a high camera", {
      load: () => classesLoad([lightClass("Lantern", { lightKind: "point", castShadows: true, range: 12 })]),
      camera: HIGH_CAMERA, lights: () => [spot(12, [0, 5, 0])],
      spawn: { position: [0, 3, -2], assign: light("point", { castShadows: true }), shadows: true },
    }],
    ["an on-demand Class's point spawns near the camera",
      { load: ON_DEMAND, spawn: { position: [0.5, 2.5, -9], assign: light("point"), shadows: false } }],
    ["an on-demand Class's shadowed spot spawns near the camera",
      { load: ON_DEMAND, spawn: { position: [0.5, 2.5, -9], assign: light("spot", { castShadows: true }), shadows: true } }],
    ["the spot starts casting shadows", { load: TORCH_CLASS }],
  ];

  it.each((["sync", "webgpu"] as const).flatMap((model) => SPAWN_CASES.map(([cause, spec]) => [model, cause, spec] as const)))(
    "a light Play may spawn compiles nothing at its admission, nor does a rehearsed change: %s, %s", async (model, _, spec) => {
    // A Class's prefab holds a shadowed spot, or a Spawn Actor names a Class the load cannot see, in whose place it
    // rehearses a point and a spot, each with and without shadows. The load rehearses one such light spawning, at the
    // camera and reaching as far as the shadow distance, so a light spawned mid-game near the camera or near the casters
    // finds its receivers' variants and its casters' depth variants compiled and drawn (their WebGPU pipelines created),
    // also where it takes the place of a point the Forward budget then leaves out. The scene holds four lights: the
    // spawned fifth would raise every lit Material's light capacity, so the load compiles for five from the start, and
    // the authored changes it rehearses compile nothing either.
    rehearseLoad = true;
    const lights = spec.lights?.() ?? [point(10, [-1.5, 2.5, -1]), point(11, [1.5, 2.5, -1]), spot(12, [0, 5, 0])];
    const world = playWorld(model, lights, [], "actor-2", spec.load());
    if (spec.full) updateSceneRenderingSettings(world.handle.scene,
      { quality: normalizeRenderingQuality({ lighting: { localLightMode: "manual", maxLocalLights: 2 } }) });
    if (spec.camera) {
      const camera = world.handle.scene.activeCamera as ArcRotateCamera;
      camera.setTarget(Vector3.Zero());
      camera.setPosition(spec.camera);
    }
    const lightOf = (slotId: number) => world.handle.scene.lights.find((entry) => entry.name === `${AUTHORED_LIGHT_PREFIX}${slotId}`);
    let before: Effect | null = null;
    let requesters = new Map<Effect, string>();
    const spawn = spec.spawn;
    const record = await measure(world, () => spawn
      ? world.place({ slotId: 40, guid: "spawned", position: spawn.position, rotation: spawn.rotation, assign: spawn.assign })
      : world.place(spot(12, [0, 5, 0], { castShadows: true })), () => {
      before = world.subjectEffect();
      requesters = effectRequesters(world);
      if (spec.full) expect([10, 11, 12].map((slotId) => isForwardLightExcluded(lightOf(slotId)!))).toEqual([false, false, true]);
    });
    const rehearsal = world.handle.loadRehearsalStats();
    const map = lightOf(40) ? findSceneShadowController(world.handle.scene)!.generator(lightOf(40)!) : null;
    // The spawned actor's own meshes (its invisible origin and light helper, which the camera pass's scene probe prepares
    // with fresh defines) are a spawn of their own: what the load warmed did not have its light.
    const own = (name: string | undefined) => name === "actor-40" || !!name?.startsWith("actor-40|");
    expect({
      rehearsed: rehearsal?.timedOut.length === 0 && rehearsal.omitted.length === 0 && rehearsal.unrestored.length === 0,
      // The change took effect: the subject draws another variant, and a spawned light is lit (in place of a point when
      // the budget is full) and a shadowed one's map has drawn.
      changed: world.subjectEffect() !== before,
      spawned: !spawn || (!isForwardLightExcluded(lightOf(40)!) && (!spawn.shadows || (!!map && !awaitsFirstDraw(map))) &&
        (!spec.full || [10, 11].some((slotId) => isForwardLightExcluded(lightOf(slotId)!)))),
      effects: world.driver.created.filter((effect) => !own(requesters.get(effect))).length,
      pipelines: record.pipelines + record.warmPipelines,
      synchronous: world.driver.synchronous.size,
      heldFrames: record.heldFrames, holdRaised: record.holdRaised, paused: record.pausedFrames > 0, recovered: record.recovered,
    }, JSON.stringify({ record, rehearsal })).toEqual({
      rehearsed: true, changed: true, spawned: true, effects: 0, pipelines: 0, synchronous: 0, heldFrames: 0, holdRaised: false,
      paused: false, recovered: true,
    });
  });

  /**
   * Each authored light (lit, and whether its shadow map is admitted, with its darkness) and the subject's defines at
   * the first presented frame and 17 frames later, for a load with or without its rehearsal. The frames run on a 16 ms
   * clock once loading has drawn six frames, and in both runs afterwards: a residency the load's own admissions began
   * has not run out by the first presentation, and runs out (250 ms) within the later frames.
   */
  async function presentedAdmission(rehearse: boolean, actors: Actor[], configure?: (world: PlayWorld) => void, load = classesLoad([])) {
    // A fresh world per run: the previous one's Engine, clock and render spy go first.
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    if (vi.isMockFunction(SceneRenderCoordinator.prototype.render)) vi.mocked(SceneRenderCoordinator.prototype.render).mockRestore();
    rehearseLoad = rehearse;
    const world = playWorld("sync", actors, [], "actor-2", load);
    configure?.(world);
    const controller = () => findSceneShadowController(world.handle.scene)!;
    const state = () => ({
      lights: world.handle.scene.lights.filter((light) => light.name.startsWith(AUTHORED_LIGHT_PREFIX))
        .map((light) => {
          const map = controller().generator(light);
          return `${light.name.slice(AUTHORED_LIGHT_PREFIX.length)}:${light.isEnabled() ? "lit" : "off"}${map ? `+map@${map.getDarkness()}` : ""}`;
        }).sort(),
      defines: world.subjectEffect()?.defines ?? null,
    });
    await withClock(world.handle.prewarmSceneMaterials());
    const presentation = world.handle.presentFirstFrame();
    let presented = false;
    void presentation.finally(() => { presented = true; });
    for (let index = 0; index < 400 && (index < 4 || !presented); index++) {
      frameMs = index < 6 ? FRAME_MS : 16;
      await world.frame();
    }
    await presentation;
    const first = state();
    frameMs = 16;
    for (let index = 0; index < 17; index++) await world.frame();
    return { first, later: state(), rehearsal: world.handle.loadRehearsalStats() };
  }

  const ADMISSION_SCENARIOS = [
    ["shadow maps", [
      spot(12, [-1, 4, 3], { castShadows: true }), spot(10, [0, 4, 0], { castShadows: true }), spot(11, [1, 4, 0.2], { castShadows: true }),
    ], undefined],
    ["the Forward light budget", [point(10, [0, 4, 0]), point(11, [1, 4, 0.2]), spot(12, [-1, 4, 0.6])], (world: PlayWorld) =>
      updateSceneRenderingSettings(world.handle.scene,
        { quality: normalizeRenderingQuality({ lighting: { localLightMode: "manual", maxLocalLights: 2 } }) })],
  ] as const;

  it.each(ADMISSION_SCENARIOS)("a load rehearsal leaves %s as a load without it does", async (_, actors, configure) => {
    // Admission ranks by history: an admitted light keeps its place against a slightly nearer one. Switching a light
    // off lets a waiting one take its map or slot; reverting that change must not leave the waiting light admitted.
    const baseline = await presentedAdmission(false, [...actors], configure);
    const rehearsed = await presentedAdmission(true, [...actors], configure);
    expect((rehearsed.rehearsal?.steps ?? 0) > 0, JSON.stringify(rehearsed.rehearsal)).toBe(true);
    expect({ first: rehearsed.first, later: rehearsed.later }).toEqual({ first: baseline.first, later: baseline.later });
  });

  it.each(ADMISSION_SCENARIOS)("a load rehearsal's spawned light leaves %s as a load that may spawn none does", async (_, actors, configure) => {
    // The spawned spot takes the nearest place in the Forward budget and a shadow map, and goes again: removing it must
    // give back every light's slot and map as it found them. Only the light capacity differs, by the one light the
    // load reserves for a spawn (four lights here, so five).
    const capacity = (defines: string | null) => /#define MAXLIGHTCOUNT (\d+)/.exec(defines ?? "")?.[1];
    const admission = (state: { lights: string[]; defines: string | null }) =>
      ({ ...state, defines: state.defines?.replace(/#define MAXLIGHTCOUNT \d+/, "") ?? null });
    const baseline = await presentedAdmission(true, [...actors], configure);
    const spawning = await presentedAdmission(true, [...actors], configure,
      classesLoad([lightClass("Torch", { lightKind: "spot", castShadows: true, range: 12 })]));
    expect({
      steps: spawning.rehearsal!.steps - baseline.rehearsal!.steps, drawn: spawning.rehearsal!.drawn - baseline.rehearsal!.drawn,
      unrestored: spawning.rehearsal!.unrestored,
    }, JSON.stringify(spawning.rehearsal)).toEqual({ steps: 1, drawn: 1, unrestored: [] });
    expect({ first: admission(spawning.first), later: admission(spawning.later) })
      .toEqual({ first: admission(baseline.first), later: admission(baseline.later) });
    expect([capacity(baseline.first.defines), capacity(spawning.first.defines), capacity(spawning.later.defines)]).toEqual(["4", "5", "5"]);
  });

  it("a load rehearses generic spawned lights only when its scripts may spawn a Class it does not hold", async () => {
    // Spawner's Spawn Actor names Pickup. Held, Pickup's own lights are known (it has none); not held, Pickup loads on
    // demand with its spawn, and the load rehearses a point and a spot, each with and without shadows, in its place.
    const spawner: ScriptBundleEntry = {
      assetGuid: "spawner", classId: "Spawner", source: 'out = await ctx.spawnActorAsync("Pickup", transform);', anchors: [], entryPoints: [],
    };
    const pickup: ScriptBundleEntry = { assetGuid: "pickup", classId: "Pickup", source: "", anchors: [], entryPoints: [] };
    const steps = async (load: SpawnableLightLoad) =>
      (await presentedAdmission(true, [point(10, [-1.5, 2.5, -1])], undefined, load)).rehearsal!.steps;
    const none = await steps(classesLoad([]));
    const held = await steps(classesLoad([spawner, pickup], [{ guid: "spawner", dependencies: ["pickup"] }]));
    const unheld = await steps(classesLoad([spawner], [{ guid: "spawner", dependencies: ["pickup"] }]));
    expect([held - none, unheld - none]).toEqual([0, 4]);
  });

  it("a load rehearsal reports a change whose revert could not give back a standby shadow map", async () => {
    // One Forward local slot: the nearer spot takes it from the spot realized first, whose map stays on standby from the
    // first presentation frame. Its own switch-off releases that map, and nothing rebuilds a standby map, so the
    // rehearsal says so.
    rehearseLoad = true;
    const world = playWorld("sync", [spot(12, [-1, 4, 6], { castShadows: true }), spot(10, [0, 4, 0], { castShadows: true })]);
    updateSceneRenderingSettings(world.handle.scene,
      { quality: normalizeRenderingQuality({ lighting: { localLightMode: "manual", maxLocalLights: 1 } }) });
    const controller = findSceneShadowController(world.handle.scene)!;
    const far = world.handle.scene.lights.find((light) => light.name === `${AUTHORED_LIGHT_PREFIX}12`)!;
    await withClock(world.handle.prewarmSceneMaterials());
    const presentation = world.handle.presentFirstFrame();
    let presented = false;
    void presentation.finally(() => { presented = true; });
    for (let index = 0; index < 400 && (index < 4 || !presented); index++) await world.frame();
    await presentation;
    expect({ map: controller.boundGenerator(far) !== null, unrestored: world.handle.loadRehearsalStats()?.unrestored })
      .toEqual({ map: false, unrestored: [`${AUTHORED_LIGHT_PREFIX}12 off`] });
  });

  it.each(MODELS)("a burst of swaps adopts at most FIRST_DRAWS_PER_FRAME new variants per frame: %s", async (model) => {
    // Six barrels with Materials of their own under two points: one point switching off asks every Material for a new
    // variant at once. Their first draws spread over frames, previous Effects drawing meanwhile.
    const guids = ["surface-a", "surface-b", "surface-c", "surface-d", "surface-e", "surface-f"];
    const barrels: Actor[] = guids.map((_, index) =>
      ({ slotId: 20 + index, guid: `barrel-${index}`, position: [-5 + index * 2, 1, 1], assign: { meshAssetGuid: null, meshKind: "box" } }));
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1]), point(11, [1.5, 2.5, -1]), ...barrels], guids);
    guids.forEach((guid, index) => world.handle.applyCommand({ type: "assignMaterial", slotId: 20 + index, materialAssetGuid: guid }));
    await settle(world);
    const pass = () => world.engine.getRenderPassNames().lastIndexOf("Forward objects#0");
    const effects = () => barrels.map((actor) =>
      world.handle.scene.getMeshByName(`actor-${actor.slotId}`)!.subMeshes[0]!._getDrawWrapper(pass())?.effect ?? null);
    const before = effects();
    world.driver.arm();
    world.place(point(11, [1.5, 2.5, -1], { enabled: false }));
    let current = before;
    const adoptedPerFrame: number[] = [];
    // Two frames with the links pending (a parallel driver, WebGPU pipelines), then they all finish at once.
    for (let index = 0; index < 14 && current.some((effect, at) => effect === before[at]); index++) {
      if (index === 2) world.driver.release();
      const { view } = await world.frame();
      expect(view?.rendered).toBe(true);
      const next = effects();
      adoptedPerFrame.push(next.filter((effect, at) => effect !== current[at]).length);
      current = next;
    }
    expect({
      allAdopted: current.every((effect, at) => effect !== before[at] && world.driver.created.includes(effect!)),
      atMostPerFrame: Math.max(...adoptedPerFrame) <= FIRST_DRAWS_PER_FRAME,
      spread: adoptedPerFrame.filter((count) => count > 0).length >= Math.ceil(barrels.length / FIRST_DRAWS_PER_FRAME),
    }, JSON.stringify(adoptedPerFrame)).toEqual({ allAdopted: true, atMostPerFrame: true, spread: true });
  });

  /**
   * Shadow starts nothing rehearsed or predicted: each light's actors before, the light casting, its slot, and whether
   * its map renders several passes (a cube's faces, a sun's cascades).
   */
  const shadowStarts = {
    "a spot light": { actors: [spot(10, [0, 5, 0])], cast: () => spot(10, [0, 5, 0], { castShadows: true }), slotId: 10, passes: false },
    "a point light": { actors: [point(10, [0, 4, 0])], cast: () => point(10, [0, 4, 0], { castShadows: true }), slotId: 10, passes: true },
    "the sun (its first, cascaded map)": { actors: [], cast: () => sun({ castShadows: true }), slotId: 3, passes: true },
  } as const;

  it.each((Object.keys(shadowStarts) as (keyof typeof shadowStarts)[]).flatMap((kind) => MODELS.map((model) => [kind, model] as const)))(
    "%s starts casting shadows: %s", async (kind, model) => {
    // The floor receives the crate's shadow. The view keeps drawing while the receivers' shadowed variants and the
    // casters' depth variants for the new map compile (on WebGPU, while the casters' depth pipelines are created
    // asynchronously, which the map's draw would otherwise create synchronously): the map samples neutrally (lit) until
    // it first draws, which it does once every caster is ready.
    const start = shadowStarts[kind];
    const world = playWorld(model, [...start.actors], [], "actor-1");
    const shadowLight = () => world.handle.scene.lights.find((entry) => entry.name === `${AUTHORED_LIGHT_PREFIX}${start.slotId}`)!;
    const map = () => shadowLight().getShadowGenerator() as ShadowGenerator | null;
    let neutralWhilePending = true;
    const record = await measure(world, () => world.place(start.cast()), undefined, () => {
      const generator = map();
      // Only a pending compile or pipeline keeps the map from drawing; a synchronous link draws it in the change's frame.
      if (model !== "sync") neutralWhilePending &&= !!generator && awaitsFirstDraw(generator) && generator.getDarkness() === 1;
    });
    const generator = map();
    const shadow = {
      passes: (generator?.getShadowMap()?.renderPassIds.length ?? 0) > 1,
      neutralWhilePending,
      drawn: !!generator && !awaitsFirstDraw(generator) && generator.getDarkness() === 0,
      received: /#define SHADOW\d/.test(world.subjectEffect()?.defines ?? ""),
      // WebGPU: the map's draw created none of its casters' depth pipelines synchronously.
      synchronousPipelines: world.driver.synchronous.size,
    };
    expect(shadow, JSON.stringify(record)).toEqual({
      passes: start.passes, neutralWhilePending: true, drawn: true, received: true, synchronousPipelines: 0,
    });
    expectSwapped(record, model);
  });

  it("a first shadow map whose casters' pipelines never arrive draws at the deferral's stall, and the view never holds", async () => {
    // WebGPU: the new spot map waits, neutral, for the pipelines its warm render started, which never arrive. Once no
    // pipeline has started or finished for the stall time, it draws anyway, creating them synchronously.
    const world = playWorld("webgpu", [spot(10, [0, 5, 0])], [], "actor-1");
    const map = () => world.handle.scene.lights.find((entry) => entry.name === `${AUTHORED_LIGHT_PREFIX}10`)!.getShadowGenerator() as ShadowGenerator | null;
    await settle(world);
    world.driver.arm();
    world.place(spot(10, [0, 5, 0], { castShadows: true }));
    // Frames on the usual clock, so the receivers' warm draws keep their cold variants waiting meanwhile.
    let held = 0;
    let waitedFrames = 0;
    for (let index = 0; index < 1.5 * PIPELINE_DEFERRAL_STALL_MS / FRAME_MS; index++) {
      const { view } = await world.frame();
      if (view?.rendered !== true) held++;
      const generator = map();
      if (!generator || !awaitsFirstDraw(generator)) break;
      waitedFrames++;
    }
    const generator = map();
    expect({ held, waitedPastStall: waitedFrames >= PIPELINE_DEFERRAL_STALL_MS / FRAME_MS, drawn: !!generator && !awaitsFirstDraw(generator),
      synchronous: world.driver.synchronous.size > 0 }, JSON.stringify({ waitedFrames })).toEqual({
      held: 0, waitedPastStall: true, drawn: true, synchronous: true,
    });
  });

  /**
   * A spot map over the crate (drawn unless `castShadows` is false), and thin-instanced boxes: casters whose depth
   * variant (an instanced one) no caster of the map drew. `lagCasters` lags only the casters' depth pipelines; every
   * other pipeline is created at once.
   */
  async function newCasterWorld(options: { castShadows?: boolean } = {}) {
    const world = playWorld("webgpu", [spot(10, [0, 5, 0], { castShadows: options.castShadows ?? true })], [], "actor-1");
    await settle(world);
    const scene = world.handle.scene;
    const map = () => scene.lights.find((entry) => entry.name === `${AUTHORED_LIGHT_PREFIX}10`)!.getShadowGenerator() as ShadowGenerator | null;
    // Instanced drawing, which the headless engine does not report: the boxes' variants are then instanced ones.
    world.engine.getCaps().instancedArrays = true;
    const instancedBox = (position: Vec3) => {
      const box = MeshBuilder.CreateBox("instanced caster", { size: 0.5 }, scene);
      box.position.set(...position);
      box.thinInstanceAdd(Matrix.Identity());
      return box;
    };
    // Thin instances keep a map drawing every frame; an unlit box without normals is another depth variant (no
    // normal bias attribute) that leaves it drawing once per change.
    const unlit = new StandardMaterial("unlit caster", scene);
    unlit.disableLighting = true;
    const unlitBox = (position: Vec3) => {
      const box = MeshBuilder.CreateBox("unlit caster", { size: 0.5 }, scene);
      box.removeVerticesData(VertexBuffer.NormalKind);
      box.material = unlit;
      box.position.set(...position);
      return box;
    };
    /** The spot map draws once per change. */
    const drawsOnce = () => map()?.getShadowMap()?.refreshRate === RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    /** Meshes a real (not skipped) draw into the spot map drew: each level of detail drawn, and its master. */
    const drew = new WeakSet<AbstractMesh>();
    const watched = new WeakSet<ShadowGenerator>();
    let renders = 0;
    const watch = () => {
      const generator = map();
      if (!generator || watched.has(generator)) return;
      watched.add(generator);
      let before = 0;
      generator.onBeforeShadowMapRenderMeshObservable.add(() => { before = world.driver.draws(); });
      generator.onAfterShadowMapRenderMeshObservable.add((mesh) => {
        if (world.driver.draws() === before) return;
        drew.add(mesh);
        if (mesh._masterMesh) drew.add(mesh._masterMesh);
      });
      // A spot map clears once per render.
      generator.getShadowMap()?.onClearObservable.add(() => { renders++; });
    };
    watch();
    const frame = async () => {
      watch();
      return world.frame();
    };
    /** One frame; how many times the spot map rendered in it. */
    const rendersIn = async () => {
      watch();
      renders = 0;
      await world.frame();
      return renders;
    };
    const castInto = (mesh: AbstractMesh) => drew.has(mesh);
    const lagCasters = () => {
      world.driver.arm();
      world.driver.lagOnly((effect) => /#define SM_FLOAT\b/.test(effect.defines));
    };
    return { world, map, frame, rendersIn, instancedBox, unlitBox, drawsOnce, castInto, lagCasters };
  }

  it("a hidden spawn whose caster depth variant no caster drew is revealed once that pipeline exists, creating none synchronously", async () => {
    // WebGPU: the spawn is hidden until its variants are ready. Its caster depth pipeline for the spot map, which the map
    // would create synchronously when it redraws with the revealed mesh, is created ahead while it stays hidden: the
    // map's own render lists it in a warm scope, every other caster drawing as before.
    const { world, map, frame, instancedBox, castInto, lagCasters } = await newCasterWorld();
    lagCasters();
    const box = instancedBox([1, 0.25, 1]);
    const hidden: boolean[] = [];
    let held = 0;
    for (let index = 0; index < 6; index++) {
      if ((await frame()).view?.rendered !== true) held++;
      hidden.push(isRevealPending(box));
    }
    world.driver.release();
    let castAtReveal: boolean | null = null;
    for (let index = 0; index < 8 && castAtReveal === null; index++) {
      if ((await frame()).view?.rendered !== true) held++;
      if (!isRevealPending(box)) castAtReveal = castInto(box);
    }
    expect({ hidden, castAtReveal, mapDrawn: !awaitsFirstDraw(map()!), synchronous: world.driver.synchronous.size, held })
      .toEqual({ hidden: [true, true, true, true, true, true], castAtReveal: true, mapDrawn: true, synchronous: 0, held: 0 });
  });

  it("a hidden spawn a drawn map does not redraw for meanwhile is revealed with its shadow, creating no pipeline synchronously", async () => {
    // WebGPU: the spawn (an unlit box: the map draws once per change) is hidden while its colour pipelines lag;
    // meanwhile the spot starts casting, and its new map draws without it (a first draw lists no hidden mesh) and
    // would not draw again while it stays hidden. Its reveal asks the map to list it, so its depth pipeline is created
    // ahead, and it appears on the frame its shadow does.
    const { world, map, frame, unlitBox, drawsOnce, castInto } = await newCasterWorld({ castShadows: false });
    world.driver.arm();
    /** The box's caster depth variant: the only one without the normal bias attribute. */
    const boxDepth = (effect: Effect) => /#define SM_FLOAT\b/.test(effect.defines) && !/#define NORMAL\b/.test(effect.defines);
    // Every new pipeline lags but the other casters' depth pipelines, so the new map draws at once.
    world.driver.lagOnly((effect) => !/#define SM_FLOAT\b/.test(effect.defines) || boxDepth(effect));
    const box = unlitBox([1, 0.25, 1]);
    let held = 0;
    for (let index = 0; index < 3; index++) if ((await frame()).view?.rendered !== true) held++;
    world.place(spot(10, [0, 5, 0], { castShadows: true }));
    for (let index = 0; index < 10 && !(map() && !awaitsFirstDraw(map()!)); index++)
      if ((await frame()).view?.rendered !== true) held++;
    const drawnWhileHidden = !!map() && !awaitsFirstDraw(map()!) && drawsOnce() && isRevealPending(box);
    // Its colour pipelines arrive; its depth pipeline for the spot map still lags.
    world.driver.lagOnly(boxDepth);
    const hidden: boolean[] = [];
    for (let index = 0; index < 6; index++) {
      if ((await frame()).view?.rendered !== true) held++;
      hidden.push(isRevealPending(box));
    }
    world.driver.release();
    let castAtReveal: boolean | null = null;
    for (let index = 0; index < 8 && castAtReveal === null; index++) {
      if ((await frame()).view?.rendered !== true) held++;
      if (!isRevealPending(box)) castAtReveal = castInto(box);
    }
    expect({ drawnWhileHidden, hidden, castAtReveal, synchronous: world.driver.synchronous.size, held }).toEqual({
      drawnWhileHidden: true, hidden: [true, true, true, true, true, true], castAtReveal: true, synchronous: 0, held: 0,
    });
  });

  it.each(["colour", "depth"] as const)(
    "a hidden spawn drawn as a level of detail casts nothing into a drawn map until it is revealed with its shadow (%s pipelines lag)", async (lagging) => {
    // WebGPU: Babylon's shadow pass names the level it draws for a mesh, which counts as the mesh: while the mesh is
    // hidden (its colour pipelines lagging) the level's draws are skipped, even once its depth pipeline exists, and the
    // reveal waits for that pipeline (its depth pipeline lagging).
    const { world, frame, instancedBox, castInto } = await newCasterWorld();
    world.driver.arm();
    const depth = (effect: Effect) => /#define SM_FLOAT\b/.test(effect.defines);
    world.driver.lagOnly(lagging === "depth" ? depth : (effect) => /#define INSTANCES\b/.test(effect.defines) && !depth(effect));
    const box = instancedBox([1, 0.25, 1]);
    // The camera, ten units away, draws the level.
    const level = instancedBox([1, 0.25, 1]);
    box.addLODLevel(5, level);
    const hidden: boolean[] = [];
    const levelCast: boolean[] = [];
    let held = 0;
    for (let index = 0; index < 6; index++) {
      if ((await frame()).view?.rendered !== true) held++;
      hidden.push(isRevealPending(box));
      levelCast.push(castInto(level));
    }
    world.driver.release();
    let castAtReveal: boolean | null = null;
    for (let index = 0; index < 8 && castAtReveal === null; index++) {
      if ((await frame()).view?.rendered !== true) held++;
      if (!isRevealPending(box)) castAtReveal = castInto(level);
    }
    expect({ hidden, levelCastWhileHidden: levelCast.some(Boolean), castAtReveal, synchronous: world.driver.synchronous.size, held })
      .toEqual({ hidden: [true, true, true, true, true, true], levelCastWhileHidden: false, castAtReveal: true, synchronous: 0, held: 0 });
  });

  it("a drawn mesh that becomes a caster of a drawn map with a depth variant no caster drew creates no pipeline synchronously", async () => {
    // WebGPU: the box draws far from the spot's range, then moves under it. The map draws on with its other casters
    // while the box's depth pipeline is created, and draws the box once it exists.
    const { world, frame, instancedBox, castInto, lagCasters } = await newCasterWorld();
    const box = instancedBox([40, 0.25, 40]);
    for (let index = 0; index < 6; index++) await frame();
    const drawnBefore = !isRevealPending(box);
    lagCasters();
    box.position.set(1, 0.25, 1);
    const cast: boolean[] = [];
    let held = 0;
    for (let index = 0; index < 6; index++) {
      if ((await frame()).view?.rendered !== true) held++;
      cast.push(castInto(box));
    }
    world.driver.release();
    for (let index = 0; index < 4 && !castInto(box); index++) if ((await frame()).view?.rendered !== true) held++;
    expect({ drawnBefore, castWhilePending: cast.some(Boolean), cast: castInto(box), synchronous: world.driver.synchronous.size, held })
      .toEqual({ drawnBefore: true, castWhilePending: false, cast: true, synchronous: 0, held: 0 });
  });

  it("a caster new to a drawn map whose depth pipeline exists casts in the frame it arrives, the map rendering once", async () => {
    // WebGPU: a plain spawn (the crate's depth variant), a mesh moved under the spot and one replaced by a new mesh
    // every frame (as a script's text is), whose depth pipelines exist: each draws in the map's one render of that frame.
    const { world, frame, rendersIn, instancedBox, castInto } = await newCasterWorld();
    for (let index = 0; index < 4; index++) await frame();
    const plain = MeshBuilder.CreateBox("plain caster", { size: 0.5 }, world.handle.scene);
    plain.position.set(1, 0.25, -1);
    // Never hidden, as a mesh whose Material keeps the Effect it draws with on itself (a script's text) is not.
    noteDrawn(plain);
    const plainRenders: number[] = [];
    for (let index = 0; index < 3 && !castInto(plain); index++) plainRenders.push(await rendersIn());
    const moved = instancedBox([40, 0.25, 40]);
    for (let index = 0; index < 6; index++) await frame();
    moved.position.set(-1, 0.25, 1);
    const movedRenders = await rendersIn();
    const movedCast = castInto(moved);
    let rebuilt = instancedBox([1, 0.25, 1]);
    for (let index = 0; index < 4; index++) await frame();
    const rebuiltCast: boolean[] = [];
    const rebuiltRenders: number[] = [];
    for (let index = 0; index < 4; index++) {
      rebuilt.dispose();
      rebuilt = instancedBox([1, 0.25, 1]);
      noteDrawn(rebuilt);
      rebuiltRenders.push(await rendersIn());
      rebuiltCast.push(castInto(rebuilt) && !isRevealPending(rebuilt));
    }
    expect({ plainCast: castInto(plain), plainRenders: Math.max(...plainRenders), movedCast, movedRenders, rebuiltCast, rebuiltRenders,
      synchronous: world.driver.synchronous.size }).toEqual({
      plainCast: true, plainRenders: 1, movedCast: true, movedRenders: 1, rebuiltCast: [true, true, true, true],
      rebuiltRenders: [1, 1, 1, 1], synchronous: 0,
    });
  });

  it("a caster a drawn map left out that moves out of its reach leaves the map drawing once per change", async () => {
    // WebGPU: the box (unlit: the map draws once per change) is left out while its depth pipeline is created, then
    // leaves the spot's range before it exists. The map forgets it, so the pipeline's arrival renders nothing.
    const { world, frame, rendersIn, unlitBox, drawsOnce, castInto, lagCasters } = await newCasterWorld();
    const box = unlitBox([40, 0.25, 40]);
    for (let index = 0; index < 6; index++) await frame();
    lagCasters();
    box.position.set(1, 0.25, 1);
    for (let index = 0; index < 3; index++) await frame();
    const leftOut = !castInto(box);
    box.position.set(40, 0.25, 40);
    for (let index = 0; index < 2; index++) await frame();
    world.driver.release();
    for (let index = 0; index < 3; index++) await frame();
    const renders: number[] = [];
    for (let index = 0; index < 6; index++) renders.push(await rendersIn());
    expect({ leftOut, drawsOnce: drawsOnce(), renders }).toEqual({ leftOut: true, drawsOnce: true, renders: [0, 0, 0, 0, 0, 0] });
  });

  it.each(["outside the spot's cone", "while every frame publishes a manual capture"] as const)(
    "a hidden spawn %s is revealed once its colour pipelines exist", async (arrival) => {
    // WebGPU: only the box's colour pipelines lag. Its reveal asks the drawn spot map to list it: a render that leaves
    // it out (it is beyond the cone) answers that it has nothing to warm there, and a frame that may not wait (a manual
    // Full Quality capture that cannot publish yet marks every frame so) still lists it, so neither waits for long.
    const { world, frame, unlitBox, castInto } = await newCasterWorld();
    const scene = world.handle.scene;
    if (arrival !== "outside the spot's cone") scene.onBeforeRenderObservable.add(() => setFirstDrawsUrgent(scene, true));
    for (let index = 0; index < 4; index++) await frame();
    world.driver.arm();
    world.driver.lagOnly((effect) => !/#define SM_FLOAT\b/.test(effect.defines));
    const box = unlitBox(arrival === "outside the spot's cone" ? [9, 0.25, 0] : [1, 0.25, 1]);
    let held = 0;
    for (let index = 0; index < 3; index++) if ((await frame()).view?.rendered !== true) held++;
    const hiddenBefore = isRevealPending(box);
    world.driver.release();
    let revealedAfter = -1;
    for (let index = 0; index < 1.3 * PIPELINE_DEFERRAL_STALL_MS / FRAME_MS && revealedAfter < 0; index++) {
      if ((await frame()).view?.rendered !== true) held++;
      if (!isRevealPending(box)) revealedAfter = index;
    }
    expect({ hiddenBefore, revealedPromptly: revealedAfter >= 0 && revealedAfter <= 2, cast: arrival === "outside the spot's cone" || castInto(box),
      synchronous: world.driver.synchronous.size, held }, JSON.stringify({ revealedAfter })).toEqual({
      hiddenBefore: true, revealedPromptly: true, cast: true, synchronous: 0, held: 0,
    });
  });

  it.each(["spawned", "moved"] as const)(
    "a %s caster of a drawn map whose depth pipeline never arrives casts at the deferral's stall, and the view never holds", async (arrival) => {
    // WebGPU: the caster waits (a spawn hidden, a drawn mesh left out of the map) for the pipeline the map's redraw
    // started, which never arrives. Once no pipeline has started or finished for the stall time, the map draws it,
    // creating it synchronously.
    const { world, frame, instancedBox, castInto, lagCasters } = await newCasterWorld();
    const box = instancedBox(arrival === "spawned" ? [1, 0.25, 1] : [40, 0.25, 40]);
    if (arrival === "moved") for (let index = 0; index < 6; index++) await frame();
    lagCasters();
    if (arrival === "moved") box.position.set(1, 0.25, 1);
    let held = 0;
    let waitedFrames = 0;
    for (let index = 0; index < 1.5 * PIPELINE_DEFERRAL_STALL_MS / FRAME_MS && !castInto(box); index++) {
      if ((await frame()).view?.rendered !== true) held++;
      waitedFrames++;
    }
    expect({ held, waitedPastStall: waitedFrames >= PIPELINE_DEFERRAL_STALL_MS / FRAME_MS, revealed: !isRevealPending(box),
      cast: castInto(box), synchronous: world.driver.synchronous.size > 0 }, JSON.stringify({ waitedFrames })).toEqual({
      held: 0, waitedPastStall: true, revealed: true, cast: true, synchronous: true,
    });
  });

  it.each(["fast", "fullQuality"] as const)(
    "a manual %s capture requested while a drawn map leaves out a new caster publishes the map with it", async (quality) => {
    // WebGPU: the box (unlit: the map draws once per change) moves under the spot, whose map leaves it out while its
    // depth pipeline is created. A manual capture keeps the image it publishes, so the map draws with it for the
    // capture, creating that pipeline then: a Full Quality capture draws after the frame's maps, a Fast one before
    // them, so it waits one frame for them.
    const { world, frame, unlitBox, drawsOnce, castInto, lagCasters } = await newCasterWorld();
    const allocate = world.engine.createRenderTargetTexture.bind(world.engine);
    vi.spyOn(world.engine, "createRenderTargetTexture").mockImplementation((size, creation) => {
      const target = allocate(size, creation);
      target.texture!.format = typeof creation === "object" && creation.format !== undefined ? creation.format : Constants.TEXTUREFORMAT_RGBA;
      return target;
    });
    world.handle.setMeshAssets({
      renderTargets: new Map([["target", { mode: "SceneColor", width: 32, height: 16 }]]),
      renderTargetTextures: new Map([["texture", { renderTargetGuid: "target" }]]),
    });
    world.handle.applyCommand({ type: "configureRenderTargetCapture", actorGuid: "camera", slotId: 4, settings: {
      ...createDefaultRenderTargetCaptureProperties(), renderTargetGuid: "target", captureEveryFrame: false, quality } });
    const scene = world.handle.scene;
    const box = unlitBox([40, 0.25, 40]);
    /** Per capture draw of the floor: whether the spot's map held the box (after it: a render hook would redraw it). */
    const captured: boolean[] = [];
    (scene.getMeshByName("actor-1") as Mesh).onAfterRenderObservable.add(() => {
      if (scene.activeCamera?.name === "renderTargetCapture:camera") captured.push(castInto(box));
    });
    for (let index = 0; index < 6; index++) await frame();
    let held = 0;
    const capture = async () => {
      captured.length = 0;
      world.handle.applyCommand({ type: "captureRenderTarget", actorGuid: "camera" });
      for (let index = 0; index < 8; index++) if ((await frame()).view?.rendered !== true) held++;
      const drawn = captured.length;
      for (let index = 0; index < 2; index++) if ((await frame()).view?.rendered !== true) held++;
      return { drew: drawn > 0, published: captured.length === drawn, last: captured.at(-1) ?? null };
    };
    // A first capture prepares the capture's view.
    await capture();
    held = 0;
    lagCasters();
    box.position.set(1, 0.25, 1);
    for (let index = 0; index < 3; index++) if ((await frame()).view?.rendered !== true) held++;
    const leftOut = drawsOnce() && !castInto(box);
    const during = await capture();
    expect({ leftOut, during, held }).toEqual({ leftOut: true, during: { drew: true, published: true, last: true }, held: 0 });
  });

  it.each(["fast", "fullQuality"] as const)(
    "a manual %s capture requested while a new map waits for its casters' pipelines publishes the map drawn", async (quality) => {
    // WebGPU: the spot's new map samples neutrally while its casters' depth pipelines are created (the receivers' come at
    // once here). A manual capture keeps the image it publishes, so one requested meanwhile publishes the map drawn: a
    // Full Quality capture draws after the frame's maps, which then draw for it at once; a Fast one draws before them,
    // so it waits one frame for them. The capture looks from the camera actor's root at the floor under the crate.
    const world = playWorld("webgpu", [spot(10, [0, 5, 0])], [], "actor-1");
    // NullEngine does not record the requested format, which a capture's target is charged by.
    const allocate = world.engine.createRenderTargetTexture.bind(world.engine);
    vi.spyOn(world.engine, "createRenderTargetTexture").mockImplementation((size, creation) => {
      const target = allocate(size, creation);
      target.texture!.format = typeof creation === "object" && creation.format !== undefined ? creation.format : Constants.TEXTUREFORMAT_RGBA;
      return target;
    });
    world.handle.setMeshAssets({
      renderTargets: new Map([["target", { mode: "SceneColor", width: 32, height: 16 }]]),
      renderTargetTextures: new Map([["texture", { renderTargetGuid: "target" }]]),
    });
    world.handle.applyCommand({ type: "configureRenderTargetCapture", actorGuid: "camera", slotId: 4, settings: {
      ...createDefaultRenderTargetCaptureProperties(), renderTargetGuid: "target", captureEveryFrame: false, quality } });
    const scene = world.handle.scene;
    const map = () => scene.lights.find((entry) => entry.name === `${AUTHORED_LIGHT_PREFIX}10`)!.getShadowGenerator() as ShadowGenerator | null;
    /** Per capture draw of the floor: whether the spot's map had drawn (none while it casts no shadows). */
    const captured: boolean[] = [];
    (scene.getMeshByName("actor-1") as Mesh).onBeforeRenderObservable.add(() => {
      if (scene.activeCamera?.name !== "renderTargetCapture:camera") return;
      const generator = map();
      captured.push(!!generator && !awaitsFirstDraw(generator) && generator.getDarkness() === 0);
    });
    await settle(world);
    let held = 0;
    const frame = async () => {
      if ((await world.frame()).view?.rendered !== true) held++;
    };
    // A first capture prepares the capture's view; a manual capture stops drawing once it has published.
    const capture = async () => {
      captured.length = 0;
      world.handle.applyCommand({ type: "captureRenderTarget", actorGuid: "camera" });
      for (let index = 0; index < 8; index++) await frame();
      const drawn = captured.length;
      for (let index = 0; index < 2; index++) await frame();
      return { drew: drawn > 0, published: captured.length === drawn, last: captured.at(-1) ?? null };
    };
    const before = await capture();
    world.driver.arm();
    world.driver.lagOnly((effect) => /#define SM_FLOAT\b/.test(effect.defines));
    world.place(spot(10, [0, 5, 0], { castShadows: true }));
    held = 0;
    for (let index = 0; index < 3; index++) await frame();
    const waiting = !!map() && awaitsFirstDraw(map()!);
    const during = await capture();
    expect({ before, waiting, during, held }).toEqual({
      before: { drew: true, published: true, last: false }, waiting: true,
      during: { drew: true, published: true, last: true }, held: 0,
    });
  });

  it("a first shadow map whose warm render throws mid-draw throws nothing out of a frame, is reported once and then draws", async () => {
    // WebGPU: the new spot map's warm render throws with the map's target bound. The frame goes on, the target is
    // unbound (the graph would refuse the next frame otherwise), the failure is reported, and the map is not
    // warm-rendered again: it draws as it would without one, creating its casters' pipelines then.
    const world = playWorld("webgpu", [spot(10, [0, 5, 0])], [], "actor-1");
    const map = () => world.handle.scene.lights.find((entry) => entry.name === `${AUTHORED_LIGHT_PREFIX}10`)!.getShadowGenerator() as ShadowGenerator | null;
    await settle(world);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const prototype = RenderTargetTexture.prototype as unknown as { _prepareFrame(...args: unknown[]): void };
    const prepareFrame = prototype._prepareFrame;
    let thrown = 0;
    prototype._prepareFrame = function (this: RenderTargetTexture, ...args: unknown[]) {
      // Once the map's target is bound.
      prepareFrame.apply(this, args);
      if (!world.driver.warming()) return;
      thrown++;
      throw new Error("injected warm shadow render failure");
    };
    cleanups.push(() => { prototype._prepareFrame = prepareFrame; warn.mockRestore(); });
    world.driver.arm();
    world.place(spot(10, [0, 5, 0], { castShadows: true }));
    let escaped = 0;
    const drawn: boolean[] = [];
    for (let index = 0; index < 6; index++) {
      try {
        const { view } = await world.frame();
        drawn.push(view?.rendered === true);
      } catch {
        escaped++;
      }
    }
    const generator = map();
    const reports = warn.mock.calls.filter(([message]) => String(message).includes("Shadow map warm render failed")).length;
    expect({ thrown, escaped, drawn: drawn.every(Boolean), reports, mapDrawn: !!generator && !awaitsFirstDraw(generator),
      synchronous: world.driver.synchronous.size > 0 }).toEqual({
      thrown: 1, escaped: 0, drawn: true, reports: 1, mapDrawn: true, synchronous: true,
    });
  });

  it.each(MODELS)("a spawned actor's Material the load warmed compiles nothing when it spawns: %s", async (model) => {
    // Play's load compiles what it may spawn (`warmSpawnables`): a box with this Material is drawn in its first frame.
    const world = playWorld(model, [], ["surface-a"]);
    const drawn = spawnDraws();
    const record = await measure(world, () => {
      world.place({ slotId: 20, guid: "barrel", position: [2, 1, 1], assign: { meshAssetGuid: null, meshKind: "box" } });
      world.handle.applyCommand({ type: "assignMaterial", slotId: 20, materialAssetGuid: "surface-a" });
      drawn.clear();
    });
    expect({
      effects: record.effects, heldFrames: record.heldFrames, paused: record.pausedFrames > 0, shown: drawn.has("actor-20"),
      warmed: world.handle.spawnableWarmStats()?.materials ?? 0,
      // WebGPU: the load's warm-up also created its pipeline (its staged box was warm-drawn), so nothing waits for one.
      pipelines: record.pipelines + record.warmPipelines,
    }, JSON.stringify(record)).toEqual({ effects: 0, heldFrames: 0, paused: false, shown: true, warmed: 1, pipelines: 0 });
  });

  it.each(MODELS)("a Spawn Actor preparation compiles the actor's Material before it spawns: %s", async (model) => {
    // Spawn Actor (and a Class load) prepares the actor's sources first: that preparation also compiles them against
    // the current lighting, so the actor draws in its first frame.
    const world = playWorld(model, [], ["surface-a"]);
    const drawn = spawnDraws();
    const record = await measure(world, () => {
      world.place({ slotId: 20, guid: "barrel", position: [2, 1, 1], assign: { meshAssetGuid: null, meshKind: "box" } });
      world.handle.applyCommand({ type: "assignMaterial", slotId: 20, materialAssetGuid: "surface-c" });
      drawn.clear();
    }, async () => {
      const documents = new Map([["surface-c", createDefaultMaterialDocument("surface-c")]]);
      cleanups.push(await withClock(world.handle.acquireSceneSources({ materialDocuments: documents }, { prepare: true, warm: true })));
      for (let index = 0; index < 6; index++) await world.frame();
    });
    expect({
      effects: record.effects, heldFrames: record.heldFrames, paused: record.pausedFrames > 0, shown: drawn.has("actor-20"),
      pipelines: record.pipelines + record.warmPipelines,
    }, JSON.stringify(record)).toEqual({ effects: 0, heldFrames: 0, paused: false, shown: true, pipelines: 0 });
  });

  it.each(MODELS)("a spawned actor whose Material arrived after the load is hidden until its variant is ready: %s", async (model) => {
    // Nothing warmed this Material: only the new mesh is left out while its variant compiles, and the view keeps drawing.
    const world = playWorld(model, [], ["surface-a"]);
    const drawn = spawnDraws();
    const barrel = () => world.handle.scene.getMeshByName("actor-20");
    let hiddenWhilePending = true;
    let pendingFrames = 0;
    const record = await measure(world, () => {
      world.place({ slotId: 20, guid: "barrel", position: [2, 1, 1], assign: { meshAssetGuid: null, meshKind: "box" } });
      world.handle.applyCommand({ type: "assignMaterial", slotId: 20, materialAssetGuid: "surface-b" });
      drawn.clear();
    }, async () => {
      // A changed Material library prepares the view again; let it settle before the spawn.
      world.handle.setMaterialDocuments(new Map(["surface-a", "surface-b"].map((guid) => [guid, createDefaultMaterialDocument(guid)])));
      for (let index = 0; index < 6; index++) await world.frame();
    }, () => {
      // Only a pending compile or pipeline leaves the mesh without a variant; a synchronous link draws it in its first
      // frame.
      const mesh = barrel();
      if (model !== "sync") {
        pendingFrames++;
        hiddenWhilePending &&= !!mesh && isRevealPending(mesh) && !drawn.has(mesh.name);
      }
      drawn.clear();
    });
    for (let index = 0; index < 2; index++) await world.frame();
    const mesh = barrel();
    const spawned = {
      hiddenWhilePending: hiddenWhilePending && (model === "sync" || pendingFrames > 0),
      shown: !!mesh && !isRevealPending(mesh) && drawn.has(mesh.name),
      material: mesh?.material?.getClassName(),
    };
    expect(spawned, JSON.stringify(record)).toEqual({ hiddenWhilePending: true, shown: true, material: "NodeMaterial" });
    expect({
      compiled: record.litEffects > 0, heldFrames: record.heldFrames, holdReported: record.holdReported,
      holdRaised: record.holdRaised, paused: record.pausedFrames > 0, recovered: record.recovered,
      // WebGPU: its pipelines were warmed by draws nothing showed, never by the view's.
      viewPipelines: record.pipelines, warmed: model !== "webgpu" || record.warmPipelines > 0,
    }, JSON.stringify(record)).toEqual({
      compiled: true, heldFrames: 0, holdReported: false, holdRaised: false, paused: false, recovered: true,
      viewPipelines: 0, warmed: true,
    });
  });

  it.each(MODELS)("a mesh hidden for a new Material when the view's graph is invalidated is still shown: %s", async (model) => {
    // A changed Material library invalidates the view right after the spawn: its new run probes strictly and must
    // neither wait for an admission only steady frames make nor leave the hidden mesh for a reveal they would make.
    const world = playWorld(model, [], ["surface-a"]);
    const drawn = spawnDraws();
    const barrel = () => world.handle.scene.getMeshByName("actor-20");
    let invalidated = false;
    const record = await measure(world, () => {
      world.place({ slotId: 20, guid: "barrel", position: [2, 1, 1], assign: { meshAssetGuid: null, meshKind: "box" } });
      world.handle.applyCommand({ type: "assignMaterial", slotId: 20, materialAssetGuid: "surface-b" });
    }, async () => {
      world.handle.setMaterialDocuments(new Map(["surface-a", "surface-b"].map((guid) => [guid, createDefaultMaterialDocument(guid)])));
      for (let index = 0; index < 6; index++) await world.frame();
    }, () => {
      // After the frame that hid it, as a scene naming a new Material changes the library.
      if (!invalidated) world.handle.setMaterialDocuments(new Map(["surface-a", "surface-b", "surface-c"].map((guid) => [guid, createDefaultMaterialDocument(guid)])));
      invalidated = true;
      drawn.clear();
    });
    for (let index = 0; index < 4; index++) await world.frame();
    const mesh = barrel();
    expect({
      recovered: record.recovered, shown: !!mesh && !isRevealPending(mesh) && drawn.has(mesh.name), material: mesh?.material?.getClassName(),
    }, JSON.stringify(record)).toEqual({ recovered: true, shown: true, material: "NodeMaterial" });
  });

  it.each(MODELS)("a spawned actor's meshes appear together, on the frame the last of them is ready: %s", async (model) => {
    // The body's Material was warmed at load, the lid's arrived after it: the body waits, hidden, for the lid.
    const world = playWorld(model, [], ["surface-a"]);
    const drawn = spawnDraws();
    const names = ["actor-20|body", "actor-20|lid"];
    const part20 = (name: string) => world.handle.scene.getMeshByName(name);
    /** Each reveal: the part, and the world view frame it happened in. */
    const revealed: Array<[string, number]> = [];
    let hiddenWhilePending = true;
    let pendingFrames = 0;
    const record = await measure(world, () => {
      world.place({ slotId: 20, guid: "chest", position: [2, 1, 1], assign: { meshAssetGuid: null, meshKind: null, parts: [
        part("body", "box"), part("lid", "box", { position: [0, 1, 0] }),
      ] } });
      world.handle.applyCommand({ type: "assignMaterial", slotId: 20, componentId: "body", materialAssetGuid: "surface-a" });
      world.handle.applyCommand({ type: "assignMaterial", slotId: 20, componentId: "lid", materialAssetGuid: "surface-b" });
      drawn.clear();
    }, async () => {
      world.handle.setMaterialDocuments(new Map(["surface-a", "surface-b"].map((guid) => [guid, createDefaultMaterialDocument(guid)])));
      for (let index = 0; index < 6; index++) await world.frame();
      cleanups.push(onMeshRevealed(world.handle.scene, (mesh) => {
        if (names.includes(mesh.name)) revealed.push([mesh.name, world.views.length]);
      }));
    }, () => {
      // Only a pending compile or pipeline keeps the lid from its first frame; a synchronous link reveals both at once.
      if (model !== "sync") {
        pendingFrames++;
        hiddenWhilePending &&= names.every((name) => {
          const mesh = part20(name);
          return !!mesh && isRevealPending(mesh) && !drawn.has(name);
        });
      }
      drawn.clear();
    });
    for (let index = 0; index < 2; index++) await world.frame();
    expect({
      hiddenWhilePending: hiddenWhilePending && (model === "sync" || pendingFrames > 0),
      // Each part is revealed once, both in one frame.
      revealed: revealed.map(([name]) => name).sort(),
      together: new Set(revealed.map(([, frame]) => frame)).size === 1,
      shown: names.map((name) => !!part20(name) && !isRevealPending(part20(name)!) && drawn.has(name)),
      materials: names.map((name) => part20(name)?.material?.name),
      viewPipelines: record.pipelines, holdRaised: record.holdRaised,
    }, JSON.stringify({ record, revealed })).toEqual({
      hiddenWhilePending: true, revealed: names, together: true, shown: [true, true], viewPipelines: 0, holdRaised: false,
      materials: [expect.stringContaining("surface-a"), expect.stringContaining("surface-b")],
    });
  });

  /**
   * Temporal anti-aliasing on (in any render mode), with `effects` on top: the world view's graph draws the spatial
   * geometry pass (view depth and velocity) every frame, and no warm draw creates its pipelines.
   */
  function withGeometryPass(world: PlayWorld, effects: Partial<ReturnType<typeof sceneRenderingSettings>["effects"]> = {}) {
    // The spatial chain also needs texel fetches.
    Object.assign(world.engine.getCaps(), { texelFetch: true });
    updateSceneRenderingSettings(world.handle.scene, { effects: { ...sceneRenderingSettings(world.handle.scene).effects,
      temporalAntiAliasing: { enabled: true, samples: 8, blend: 0.1 }, ...effects } });
  }
  /** A geometry pass's variant: Babylon's geometry rendering defines `PREPASS`. */
  const geometryVariant = (effect: Effect) => /#define PREPASS\b/.test(effect.defines);

  it.each(["a spawned actor is revealed", "an actor's Material changes"] as const)(
    "with a geometry pass, %s with no frame held and fills the geometry buffers once its pipeline exists: webgpu", async (cause) => {
    // The new Material's colour pipelines are warmed while the barrel is hidden; its geometry variant's pipeline is
    // started only by its first geometry draw, after the reveal, and arrives later (`lagOnly`). Meanwhile that pass
    // alone leaves the barrel out, and the view keeps drawing.
    const barrel: Actor = { slotId: 20, guid: "barrel", position: [2, 1, 1], assign: { meshAssetGuid: null, meshKind: "box" } };
    const changes = cause === "an actor's Material changes";
    const world = playWorld("webgpu", changes ? [barrel] : [], ["surface-a"]);
    if (changes) world.handle.applyCommand({ type: "assignMaterial", slotId: 20, materialAssetGuid: "surface-a" });
    withGeometryPass(world);
    /** The passes the barrel really drew in (`pass:mesh`), since last cleared; a draw left out or skipped is not one. */
    const drawn = new Set<string>();
    const render = Mesh.prototype.render;
    vi.spyOn(Mesh.prototype, "render").mockImplementation(function (this: Mesh, ...args) {
      const before = world.driver.draws();
      const result = render.apply(this, args);
      if (world.driver.draws() > before) drawn.add(`${world.engine.getCurrentRenderPassName()}:${this.name}`);
      return result;
    });
    await settle(world);
    // A Material library that gains the new Material prepares the view again; let it settle first.
    world.handle.setMaterialDocuments(new Map(["surface-a", "surface-b"].map((guid) => [guid, createDefaultMaterialDocument(guid)])));
    for (let index = 0; index < 6; index++) await world.frame();
    const geometry = world.engine.getRenderPassNames().filter((name) => name?.startsWith("Spatial Geometry"));
    const holdsBefore = world.holds.length;
    world.driver.arm();
    if (!changes) world.place(barrel);
    world.handle.applyCommand({ type: "assignMaterial", slotId: 20, materialAssetGuid: "surface-b" });
    /** Each frame: whether the view drew and reported holding, and where the barrel drew. */
    const frames: Array<{ rendered: boolean; holding: boolean; colour: boolean; geometry: boolean }> = [];
    const step = async () => {
      drawn.clear();
      const { view, holding } = await world.frame();
      frames.push({ rendered: view?.rendered === true, holding, colour: drawn.has("Forward objects#0:actor-20"),
        geometry: [...drawn].some((entry) => entry.startsWith("Spatial Geometry") && entry.endsWith(":actor-20")) });
    };
    // Every new pipeline pending: the barrel is hidden while its colour pipelines are warmed.
    for (let index = 0; index < 2; index++) await step();
    // The colour pipelines arrive; the geometry variant's still lags.
    world.driver.lagOnly(geometryVariant);
    for (let index = 0; index < 6; index++) await step();
    const lagging = frames.length;
    world.driver.release();
    for (let index = 0; index < 2; index++) await step();
    const revealed = frames.findIndex((frame) => frame.colour);
    expect({
      geometryPass: geometry.length > 0, revealedWhileLagging: revealed >= 2 && revealed < lagging - 1,
      held: frames.filter((frame) => !frame.rendered || frame.holding).length, holdRaised: world.holds.slice(holdsBefore).includes(true),
      paused: isSceneGameTimePaused(world.handle.scene), synchronousPipelines: world.driver.synchronous.size,
      // From its reveal the barrel draws in the colour pass every frame, and into the geometry buffers from the first
      // frame its geometry pipeline exists.
      colourFromReveal: frames.slice(revealed).every((frame) => frame.colour),
      geometryWhileLagging: frames.slice(0, lagging).some((frame) => frame.geometry),
      geometryOnceReady: frames.slice(lagging).every((frame) => frame.geometry),
      leftOut: world.driver.omitted.size > 0 && [...world.driver.omitted].every(geometryVariant),
    }, JSON.stringify(frames)).toEqual({
      geometryPass: true, revealedWhileLagging: true, held: 0, holdRaised: false, paused: false, synchronousPipelines: 0,
      colourFromReveal: true, geometryWhileLagging: false, geometryOnceReady: true, leftOut: true,
    });
  });

  it.each(["a point light switches off", "a spot light starts casting shadows"] as const)(
    "with a geometry pass, %s with no new geometry variant: webgpu", async (cause) => {
    // Geometry variants carry the Material's light defines, but no geometry attachment reads the lights: the geometry
    // pass keeps the defines it prepared, so the receivers keep drawing their geometry Effects there (no pipeline to
    // create, nothing left out), while the object pass swaps to their new variants as without the pass.
    const world = playWorld("webgpu", [point(10, [-1.5, 2.5, -1]), point(11, [1.5, 2.5, -1]), spot(12, [0, 5, 0])], [], "actor-1");
    withGeometryPass(world);
    const geometryEffects = () => {
      const pass = world.engine.getRenderPassNames().lastIndexOf("Spatial Geometry#0");
      return ["actor-1", "actor-2"].map((name) => world.handle.scene.getMeshByName(name)?.subMeshes?.[0]?._getDrawWrapper(pass)?.effect ?? null);
    };
    let before: (Effect | null)[] = [];
    const record = await measure(world, () => cause === "a point light switches off"
      ? world.place(point(11, [1.5, 2.5, -1], { enabled: false }))
      : world.place(spot(12, [0, 5, 0], { castShadows: true })), () => { before = geometryEffects(); });
    expectSwapped(record, "webgpu");
    expect({ drawnBefore: before.every(Boolean), geometryVariants: world.driver.created.filter(geometryVariant).length,
      leftOut: world.driver.omitted.size, kept: geometryEffects().every((effect, index) => effect === before[index]) })
      .toEqual({ drawnBefore: true, geometryVariants: 0, leftOut: 0, kept: true });
  });

  it("a geometry effect switched on mid-game holds the view for its new graph's geometry pipelines: webgpu", async () => {
    // Ambient occlusion adds world normals to the geometry pass, so the rebuilt graph's geometry variants are new for
    // every mesh at once. Until a build has drawn a complete frame it keeps the hold (bounded by the hold cap and the
    // stall) rather than present every mesh missing from the geometry buffers.
    const world = playWorld("webgpu", []);
    withGeometryPass(world);
    const record = await measure(world, () => withGeometryPass(world, {
      ambientOcclusion: { ...sceneRenderingSettings(world.handle.scene).effects.ambientOcclusion, enabled: true } }));
    expect({ geometryVariants: world.driver.created.some(geometryVariant), held: record.heldFrames > 0, holdReported: record.holdReported,
      leftOut: world.driver.omitted.size, recovered: record.recovered }, JSON.stringify(record)).toEqual({
      geometryVariants: true, held: true, holdReported: true, leftOut: 0, recovered: true,
    });
  });

  it("a geometry pass that first draws when a Fog Volume comes within reach holds the view for its pipelines: webgpu", async () => {
    // Fog Volumes alone run the geometry pass only while one is within reach of the camera, so the view's complete
    // frames leave it undrawn. Its first draws miss every mesh's pipeline at once, so they hold as a new graph's do.
    const world = playWorld("webgpu", []);
    Object.assign(world.engine.getCaps(), { texelFetch: true });
    const fog = new TransformNode("fog", world.handle.scene);
    fog.position.z = 5_000;
    upsertFogVolumes(world.handle.scene, "fog", fog, fogVolumeBindings([{ id: "fog", classId: "FogVolumeComponent", properties: {} }]));
    const record = await measure(world, () => { fog.position.z = 0; });
    // Its geometry variants are compiled only once it runs: the pass had not drawn before.
    expect({ geometryVariants: world.driver.created.some(geometryVariant), held: record.heldFrames > 0, holdReported: record.holdReported,
      leftOut: world.driver.omitted.size, recovered: record.recovered }, JSON.stringify(record)).toEqual({
      geometryVariants: true, held: true, holdReported: true, leftOut: 0, recovered: true,
    });
  });

  /** Gives the world's meshes (by name) PBR Materials of their own before the load: one can then change alone. */
  const ownMaterials = (world: PlayWorld, ...names: string[]) => names.map((name) => {
    const material = (world.handle.scene.defaultMaterial as PBRMaterial).clone(name);
    world.handle.scene.getMeshByName(name)!.material = material;
    return material;
  });
  /**
   * Changes a define of each Material (it normalizes in the forward shader) as a runtime change does, marking the Scene's
   * readiness: every pass, the geometry pass included, asks its meshes for a new variant.
   */
  const changeDefines = (world: PlayWorld, ...materials: PBRMaterial[]) => {
    for (const material of materials) material.forceNormalForward = !material.forceNormalForward;
    markSceneReadinessDirty(world.handle.scene);
  };
  /**
   * From now on new geometry variants' pipelines (those `lags` picks) lag while every other pipeline exists at once;
   * `change` then gives some mesh a new geometry variant. Records `frames` frames, releases the lag and lets the view
   * recover.
   */
  async function geometryLag(world: PlayWorld, change: () => void | Promise<void>, frames = 4, lags = geometryVariant) {
    world.driver.arm();
    world.driver.lagOnly(lags);
    const holdsBefore = world.holds.length;
    await change();
    const lagging: { rendered: boolean; holding: boolean }[] = [];
    for (let index = 0; index < frames; index++) {
      const { view, holding } = await world.frame();
      lagging.push({ rendered: view?.rendered === true, holding });
    }
    world.driver.release();
    let recovered = false;
    for (let index = 0; index < 6 && !recovered; index++) recovered = (await world.frame()).view?.rendered === true;
    return {
      geometryVariants: world.driver.created.some(geometryVariant),
      held: lagging.some((frame) => !frame.rendered), holdRaised: world.holds.slice(holdsBefore).includes(true),
      leftOut: world.driver.omitted.size, waitedFor: [...world.driver.pipelines].some(geometryVariant), recovered,
    };
  }
  /** A pass's first draws of a variant hold, as a new graph's do: nothing left out, the view waits and then draws. */
  const HELD = { geometryVariants: true, held: true, holdRaised: true, leftOut: 0, waitedFor: true, recovered: true };

  it("a Fog Volume pass that went idle holds again for its next draws: webgpu", async () => {
    // The pass drew while a volume was within reach, then idled while the crate's geometry variant changed. A volume
    // coming within reach again draws that new variant first; an idle pass is forgotten, so it holds as a first draw.
    const world = playWorld("webgpu", []);
    Object.assign(world.engine.getCaps(), { texelFetch: true });
    const fog = new TransformNode("fog", world.handle.scene);
    upsertFogVolumes(world.handle.scene, "fog", fog, fogVolumeBindings([{ id: "fog", classId: "FogVolumeComponent", properties: {} }]));
    const [crate] = ownMaterials(world, "actor-2");
    await settle(world);
    fog.position.z = 5_000;
    for (let index = 0; index < 3; index++) await world.frame();
    expect(await geometryLag(world, async () => {
      changeDefines(world, crate!);
      for (let index = 0; index < 4; index++) await world.frame();
      fog.position.z = 0;
    })).toEqual(HELD);
  });

  it("a geometry pass whose complete frames drew nothing holds for its first draws: webgpu", async () => {
    // A new graph (Bloom switched on) with nothing in view (both meshes disabled, as facing the sky): its geometry pass
    // runs and draws nothing. Back in view, the floor finds its pipeline and the crate's new geometry variant misses:
    // the pass has drawn nothing yet, so it holds as a first draw.
    const world = playWorld("webgpu", []);
    withGeometryPass(world);
    const [crate] = ownMaterials(world, "actor-2");
    await settle(world);
    const meshes = ["actor-1", "actor-2"].map((name) => world.handle.scene.getMeshByName(name)!);
    for (const mesh of meshes) mesh.setEnabled(false);
    withGeometryPass(world, { bloom: { ...sceneRenderingSettings(world.handle.scene).effects.bloom, enabled: true } });
    const pass = () => world.engine.getRenderPassNames().lastIndexOf("Spatial Geometry#0");
    const drew: number[] = [];
    let drawn = 0;
    for (let index = 0; index < 8; index++) {
      if ((await world.frame()).view?.rendered) drawn++;
      drew.push(drawsInPass(world.engine, pass()));
    }
    // Enabled again, the meshes rejoin the view's lists first (a few frames not drawn), then draw. Only the crate's new
    // geometry variant lags: the floor's, new in this graph too, has its pipeline at once.
    const record = await geometryLag(world, () => {
      changeDefines(world, crate!);
      for (const mesh of meshes) mesh.setEnabled(true);
    }, 12, (effect) => geometryVariant(effect) && /#define FORCENORMALFORWARD\b/.test(effect.defines));
    expect({ ...record, drewNothingBefore: drawn > 0 && drew.every((count) => count === 0) }).toEqual({ ...HELD, drewNothingBefore: true });
  });

  it("a steady frame whose deferral counts a geometry pass's left-out draws holds and reports the hold: webgpu", async () => {
    // The floor and the crate get new geometry variants at once, so every draw of the pass is left out. Whether those
    // count is the deferral's rule (`close()`, modelled here and tested in `webgpu-pipeline-deferral.test.ts`); this
    // covers the view's response to a steady frame that counts them: it holds, reports the hold, waits and recovers.
    const world = playWorld("webgpu", []);
    withGeometryPass(world);
    const materials = ownMaterials(world, "actor-1", "actor-2");
    await settle(world);
    expect(await geometryLag(world, () => changeDefines(world, ...materials))).toEqual(HELD);
  });

  it("an invalidated view holds for its geometry pass's next draws: webgpu", async () => {
    // An invalidation starts a new run, which can give every mesh new geometry variants: its geometry pass holds for
    // a miss until it has drawn a complete frame again.
    const world = playWorld("webgpu", []);
    withGeometryPass(world);
    const [crate] = ownMaterials(world, "actor-2");
    await settle(world);
    expect(await geometryLag(world, () => {
      changeDefines(world, crate!);
      world.view().invalidate();
    }, 6)).toEqual(HELD);
  });

  it("a frame report's frame never leaves a geometry draw out: webgpu", async () => {
    // Steady frames leave the crate's new geometry variant out and draw; the frame a report captures validates its
    // presentation, so it holds for that pipeline instead of reporting a frame without the crate's geometry.
    const world = playWorld("webgpu", []);
    withGeometryPass(world);
    const [crate] = ownMaterials(world, "actor-2");
    await settle(world);
    world.driver.arm();
    world.driver.lagOnly(geometryVariant);
    changeDefines(world, crate!);
    const steady: boolean[] = [];
    for (let index = 0; index < 3; index++) steady.push((await world.frame()).view?.rendered === true);
    const leftOut = world.driver.omitted.size;
    void world.handle.captureFrame().catch(() => {});
    const captured = (await world.frame()).view;
    world.driver.release();
    for (let index = 0; index < 4; index++) await world.frame();
    expect({ steady, leftOut, captured: captured?.rendered, reason: captured?.reason })
      .toEqual({ steady: [true, true, true], leftOut: 1, captured: false, reason: "Render pipelines are compiling." });
  });

  it("a camera move that makes the Forward budget drop a shadowed spot binds a placeholder for its map from the first frame", async () => {
    // Ten local lights for nine shader slots. Near the spot the floor receives its shadow; seen from the far side it
    // is the farthest light, and its place goes to a point. Only the camera moved, so the frame's own readiness probe
    // is the first to see the swap, and the floor's previous Effect still samples the map the spot no longer binds.
    const points = Array.from({ length: 8 }, (_, index) => point(10 + index, [-7 + index * 2, 2.5, -5]));
    const world = playWorld("parallel", [...points, spot(30, [4, 5, 4], { castShadows: true })], [], "actor-1");
    const scene = world.handle.scene;
    const camera = scene.activeCamera as ArcRotateCamera;
    camera.setTarget(Vector3.Zero());
    camera.setPosition(new Vector3(4, 3, 12));
    await settle(world);
    const spotLight = scene.lights.find((entry) => entry.name === `${AUTHORED_LIGHT_PREFIX}30`)!;
    const before = world.subjectEffect()!;
    expect([isForwardLightExcluded(spotLight), /#define SHADOW\d/.test(before.defines)]).toEqual([false, true]);
    // No swap has needed them yet.
    expect(existingShadowSamplerPlaceholders(scene)).toBeUndefined();
    // Whether the placeholders existed each time the previous Effect bound its lights.
    const bound: boolean[] = [];
    const hooks = (scene as unknown as { _materialLightHooks: { bindLights: (...args: unknown[]) => boolean } })._materialLightHooks;
    const bindLights = hooks.bindLights;
    hooks.bindLights = function (...args: unknown[]) {
      if (args[2] === before) bound.push(existingShadowSamplerPlaceholders(scene) !== undefined);
      return bindLights.apply(this, args);
    };
    world.driver.arm();
    camera.setPosition(new Vector3(-4, 3, -14));
    const { view, effect } = await world.frame();
    expect(isForwardLightExcluded(spotLight)).toBe(true);
    expect(world.driver.created.length).toBeGreaterThan(0);
    expect({ drawn: view?.rendered, previous: effect === before, bound }).toEqual({ drawn: true, previous: true, bound: [true] });
  });
});

/** Prepared area emission pixels, as the derived chunk holds them. */
async function areaEmissionPixels() {
  return decodeAreaEmission(await encodeAreaEmission(new Uint8Array(AREA_EMISSION_EDGE ** 2 * 4).fill(170), "a".repeat(64)));
}

/**
 * The editor's world view: the same coordinator as Play's, drawing steady frames (`render(false)`) on a world Scene
 * without Play's end-of-frame readiness check, under the parallel driver. A box with the default graph Material
 * receives a sun and two points.
 */
async function editorView(options: { fixedShape?: boolean; native?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"], now: 1_000 });
  cleanups.push(() => vi.useRealTimers());
  const engine = headlessEngine();
  const driver = driverModel(engine, "parallel");
  if (options.fixedShape) setFixedShapeLightingEnabled(engine, true);
  const scene = new Scene(engine);
  const camera = new UniversalCamera("camera", new Vector3(0, 3, -10), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  setFixedShapeLightingWorldScene(scene);
  new DirectionalLight("sun", new Vector3(0.3, -1, 0.4), scene);
  new PointLight("near", new Vector3(-1.5, 2.5, -1), scene);
  const far = new PointLight("far", new Vector3(1.5, 2.5, -1), scene);
  const lowered = lowerMaterialDocument(createDefaultMaterialDocument());
  if (!lowered.ok) throw new Error("The default Material did not lower.");
  const compiled = compileMaterialPlan(lowered.plan, { scene, name: "graph" });
  if (!compiled.ok) throw new Error("The default Material did not compile.");
  const box = MeshBuilder.CreateBox("box", {}, scene);
  box.material = options.native ? new PBRMaterial("native", scene) : compiled.material;
  const view = new SceneRenderCoordinator(scene, { deferPipelines: true });
  cleanups.push(() => view.dispose());
  await withClock(view.prepare());
  /** One steady frame; whether it drew. */
  const frame = async () => {
    engine.beginFrame();
    const drawn = view.render(false).rendered;
    engine.endFrame();
    await vi.advanceTimersByTimeAsync(FRAME_MS);
    return drawn;
  };
  const effect = () => box.subMeshes[0]!._getDrawWrapper(camera.renderPassId)?.effect;
  /** The output resizes, as the canvas does: the graph needs a preparation for the new size. */
  const resize = (width: number, height: number) =>
    Object.assign((engine as unknown as { _options: NullEngineOptions })._options, { renderWidth: width, renderHeight: height });
  for (let index = 0; index < 3; index++) expect(await frame()).toBe(true);
  return { engine, driver, scene, far, material: compiled.material, view, frame, effect, resize };
}

describe("the editor world view", () => {
  it("probes each steady frame while a frozen graph Material swaps, so it draws its new variant once that is ready", async () => {
    // The editor freezes library Materials: a frozen NodeMaterial adopts a ready variant only when a probe asks again.
    const { driver, far, material, frame, effect } = await editorView();
    material.freeze();
    const before = effect();
    driver.arm();
    setAuthoredLightEnabled(far, false);
    for (let index = 0; index < 3; index++) {
      expect(await frame()).toBe(true);
      expect(effect()).toBe(before);
    }
    expect(driver.created.length).toBeGreaterThan(0);
    driver.release();
    expect(await frame()).toBe(true);
    expect(driver.created).toContain(effect());
  });

  it("holds a seated Material for its new variant under fixed-shape lighting instead of drawing its previous Effect", async () => {
    // A seat-bound Effect binds its seats from the current slot table, with no placeholder for a map a seat lost.
    const { driver, scene, frame, effect } = await editorView({ fixedShape: true, native: true });
    const before = effect()!;
    expect(effectLightSeats(before)).not.toBeNull();
    driver.arm();
    new PointLight("extra", new Vector3(0, 2.5, 1), scene);
    for (let index = 0; index < 3; index++) expect(await frame()).toBe(false);
    expect(driver.created.length).toBeGreaterThan(0);
    driver.release();
    let drawn = false;
    for (let index = 0; index < 3 && !drawn; index++) drawn = await frame();
    expect(drawn).toBe(true);
    expect(driver.created).toContain(effect());
  });

  it("draws the previous Effect through a preparation a strict readiness question started", async () => {
    // Play asks its world view strictly at the end of each frame. When that question is the first to find the graph
    // needing a preparation (here for a new output size), the preparation it starts serves the steady frames, which
    // draw a swapping Material's previous Effect.
    const { driver, far, view, frame, effect, resize } = await editorView();
    const before = effect();
    driver.arm();
    setAuthoredLightEnabled(far, false);
    resize(320, 200);
    expect(view.isReady()).toBe(false);
    expect(view.settled).toBe(false);
    const frames: boolean[] = [];
    for (let index = 0; index < 4; index++) frames.push(await frame() && effect() === before);
    expect(driver.created.length).toBeGreaterThan(0);
    expect(frames.slice(1)).toEqual([true, true, true]);
  });

  it("answers a strict question after a tolerant preparation found a swap without probing the scene again", async () => {
    const { driver, far, view, frame, resize } = await editorView();
    driver.arm();
    setAuthoredLightEnabled(far, false);
    resize(320, 200);
    // The steady frame cannot draw before the graph is prepared for the new size; that preparation tolerates the swap.
    expect(await frame()).toBe(false);
    for (let step = 0; step < 50 && !view.settled; step++) await vi.advanceTimersByTimeAsync(16);
    expect(view.settled).toBe(true);
    const checks = view.strictReadinessChecks;
    expect(view.isReady()).toBe(false);
    expect(view.strictReadinessChecks).toBe(checks);
  });

  it("reveals a transparent mesh whose depth pre-pass links after its colour variant once, with both, then hot-swaps it", async () => {
    // A blended StandardMaterial with a depth pre-pass draws two variants (DEPTHPREPASS is a define of its own). The new
    // mesh stays hidden while either links, appears once, and a later light change keeps it drawn.
    const { driver, scene, far, frame } = await editorView();
    const drawn = spawnDraws();
    const depthPrePass = (effect: Effect) => /#define DEPTHPREPASS\b/.test(effect.defines);
    const reveals: number[] = [];
    let frames = 0;
    cleanups.push(onMeshRevealed(scene, (mesh) => { if (mesh.name === "glass") reveals.push(frames); }));
    driver.arm();
    const glass = MeshBuilder.CreateBox("glass", {}, scene);
    glass.position.set(1.5, 0.5, 0);
    const material = new StandardMaterial("glass", scene);
    material.alpha = 0.5;
    material.needDepthPrePass = true;
    glass.material = material;
    /** Each frame: drew, `glass` hidden, `glass` drawn, only its depth pre-pass still linking. */
    const states: Array<[boolean, boolean, boolean, boolean]> = [];
    const step = async () => {
      frames++;
      drawn.clear();
      const viewDrew = await frame();
      const linking = driver.created.filter((effect) => driver.isPending(effect));
      states.push([viewDrew, isRevealPending(glass), drawn.has("glass"), linking.length > 0 && linking.every(depthPrePass)]);
    };
    for (let index = 0; index < 2; index++) await step();
    // Every link but the depth pre-pass's finishes.
    driver.lagOnly(depthPrePass);
    for (let index = 0; index < 4; index++) await step();
    driver.release();
    for (let index = 0; index < 2; index++) await step();
    expect(states).toEqual([
      [true, true, false, false], [true, true, false, false],
      [true, true, false, true], [true, true, false, true], [true, true, false, true], [true, true, false, true],
      [true, false, true, false], [true, false, true, false],
    ]);
    expect(reveals).toEqual([7]);
    // A light switching off: both variants swap, and the mesh keeps drawing its previous ones meanwhile.
    driver.arm();
    setAuthoredLightEnabled(far, false);
    states.length = 0;
    for (let index = 0; index < 3; index++) await step();
    expect(driver.created.filter((effect) => driver.isPending(effect)).some(depthPrePass)).toBe(true);
    expect(states.map(([viewDrew, hidden, shown]) => [viewDrew, hidden, shown])).toEqual([[true, false, true], [true, false, true], [true, false, true]]);
    expect(reveals).toEqual([7]);
  });

  it("never hides a drawn mesh whose new blend needs a depth pre-pass it has not drawn yet", async () => {
    // Only a mesh that has never drawn with its Material is hidden; one that has keeps its place in every pass while a
    // pass's new variant links (here its first depth pre-pass, once it blends).
    const { driver, scene, far, frame } = await editorView();
    const drawn = spawnDraws();
    const pane = MeshBuilder.CreateBox("pane", {}, scene);
    pane.position.set(1.5, 0.5, 0);
    const material = new StandardMaterial("pane", scene);
    pane.material = material;
    for (let index = 0; index < 3; index++) await frame();
    expect(drawn.has("pane")).toBe(true);
    const reveals: string[] = [];
    cleanups.push(onMeshRevealed(scene, (mesh) => reveals.push(mesh.name)));
    driver.arm();
    material.alpha = 0.5;
    material.needDepthPrePass = true;
    // A light switching off too: the view probes again, and the pane's colour variant swaps.
    setAuthoredLightEnabled(far, false);
    const hidden: boolean[] = [];
    for (let index = 0; index < 3; index++) {
      await frame();
      hidden.push(isRevealPending(pane));
    }
    // Its depth pre-pass variant really was linking.
    expect(driver.created.filter((effect) => driver.isPending(effect)).some((effect) => /#define DEPTHPREPASS\b/.test(effect.defines))).toBe(true);
    driver.release();
    drawn.clear();
    for (let index = 0; index < 2; index++) {
      await frame();
      hidden.push(isRevealPending(pane));
    }
    expect({ hidden, reveals, drawn: drawn.has("pane") }).toEqual({ hidden: [false, false, false, false, false], reveals: [], drawn: true });
  });

  it("ends a swap whose new variant failed to link: the previous Effect stays, probing stops and strict readiness passes", async () => {
    const { driver, far, view, frame, effect } = await editorView();
    const before = effect();
    driver.arm();
    setAuthoredLightEnabled(far, false);
    expect(await frame()).toBe(true);
    expect(view.isReady()).toBe(false);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    driver.fail();
    // This frame's probe finds the failure.
    expect(await frame()).toBe(true);
    const checks = view.strictReadinessChecks;
    for (let index = 0; index < 3; index++) {
      expect(await frame()).toBe(true);
      expect(effect()).toBe(before);
    }
    expect(view.strictReadinessChecks).toBe(checks);
    expect(view.isReady()).toBe(true);
    const reports = error.mock.calls.map(([message]) => String(message)).filter((message) => message.includes("previous shader variant"));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("injected link failure");
  });
});

describe("a visual re-sent every tick", () => {
  const SLOT = 50;
  const text3d = (text: string): Actor["assign"] => ({ meshAssetGuid: null, meshKind: "text3d", text3d: parseText3DProperties({ text }) });
  /** World visuals a script can re-send every tick by writing one of their component properties. */
  const VISUALS: Record<string, Actor["assign"]> = {
    "a Text3D": text3d("Score 0"),
    "a box": { meshAssetGuid: null, meshKind: "box" },
    "a box with a 2D Text part": { meshAssetGuid: null, meshKind: "box", parts: [
      part("body", "box"), part("label", "2dtext", { text2d: parseText2DProperties({ text: "Hi" }) }),
    ] },
    "a sprite": { meshAssetGuid: null, meshKind: "sprite" },
  };
  const actor = (assign: Actor["assign"]): Actor => ({ slotId: SLOT, guid: "visual", position: [0, 2, -4], assign });
  type Row = { kept: boolean; drawn: boolean; hidden: boolean; held: boolean };
  const rowsOf = (row: Row) => Array.from({ length: 6 }, () => row);

  /**
   * With the view settled and the driver armed (a new compile or pipeline stays pending), each of six frames first
   * re-sends the actor's visual (`assign(frame)`), as a script writing one of its component properties every tick does,
   * then records whether the slot kept the meshes it had, whether a real pass drew them, whether one is hidden for its
   * reveal and whether the view held its image.
   */
  async function resend(model: Model, assign: (frame: number) => Actor["assign"]) {
    const world = playWorld(model, [actor(assign(-1))]);
    await settle(world);
    const drawn = spawnDraws();
    const meshes = () => {
      const root = world.handle.scene.getMeshByName(`actor-${SLOT}`);
      return root ? [root, ...root.getChildMeshes()] : [];
    };
    world.driver.arm();
    const rows: Row[] = [];
    for (let index = 0; index < 6; index++) {
      const before = meshes();
      world.place(actor(assign(index)));
      drawn.clear();
      const { view } = await world.frame();
      const after = meshes();
      rows.push({
        kept: after.length === before.length && after.every((mesh, at) => mesh === before[at]),
        drawn: after.some((mesh) => drawn.has(mesh.name)),
        hidden: after.some(isRevealPending),
        held: view?.rendered !== true,
      });
    }
    return { world, rows };
  }

  it.each(MODELS.flatMap((model) => Object.keys(VISUALS).map((name) => [name, model] as const)))(
    "%s re-sent unchanged every tick keeps its meshes and draws every frame: %s", async (name, model) => {
    // The script wrote the value the property had. A rebuild would replace drawn meshes with new ones, which the view
    // hides until they are known ready: on WebGPU a frame later, so never at one write per frame.
    const { world, rows } = await resend(model, () => VISUALS[name]!);
    expect({ rows, holdRaised: world.holds.includes(true) }).toEqual({
      rows: rowsOf({ kept: true, drawn: true, hidden: false, held: false }), holdRaised: false,
    });
  });

  it.each(MODELS)("a Text3D whose text changes every tick draws each new mesh in the frame it arrives: %s", async (model) => {
    // A real change rebuilds the mesh. Its variant and, on WebGPU, its pipelines (same Effect, same vertex layout) are
    // the previous mesh's, so it is revealed in its first frame, as on WebGL2: nothing compiles, waits or is created.
    const { world, rows } = await resend(model, (frame) => text3d(`Score ${frame + 1}`));
    const { created, pipelines, warmPipelines, synchronous } = world.driver;
    expect({ rows, compiled: created.length, pipelines: [pipelines.size, warmPipelines.size, synchronous.size] }).toEqual({
      rows: rowsOf({ kept: false, drawn: true, hidden: false, held: false }), compiled: 0, pipelines: [0, 0, 0],
    });
  });

  it("a mesh whose Effect drew only with another vertex layout waits hidden for its own pipeline, holding nothing: webgpu", async () => {
    // Pipelines are per vertex layout: the crate's Effect has one for the crate's buffers, not for padded positions. The
    // lookup ahead of the mesh's draws misses, so it waits hidden while its warm draws create that pipeline, and no
    // frame holds for it nor creates it synchronously.
    const world = playWorld("webgpu", []);
    world.driver.keyLayouts();
    await settle(world);
    const scene = world.handle.scene;
    const crate = scene.getMeshByName("actor-2") as Mesh;
    const drawn = spawnDraws();
    world.driver.arm();
    const padded = MeshBuilder.CreateBox("padded", { size: 1 }, scene);
    const positions = padded.getVerticesData(VertexBuffer.PositionKind)!;
    const data = new Float32Array((positions.length / 3) * 4);
    for (let index = 0; index < positions.length / 3; index++) data.set(positions.slice(index * 3, index * 3 + 3), index * 4);
    padded.setVerticesBuffer(new VertexBuffer(world.engine, data, VertexBuffer.PositionKind, false, false, 4, false, 0, 3));
    padded.material = crate.material;
    // Beside the crate: the same lights, so the same variant.
    padded.position.set(1.5, 1, 0);
    let held = 0;
    let hiddenWhilePending = true;
    for (let index = 0; index < PENDING_FRAMES; index++) {
      drawn.clear();
      if (!(await world.frame()).view?.rendered) held++;
      hiddenWhilePending &&= isRevealPending(padded) && !drawn.has("padded");
    }
    world.driver.release();
    let shownAfter = -1;
    for (let index = 0; index < 3 && shownAfter < 0; index++) {
      drawn.clear();
      if (!(await world.frame()).view?.rendered) held++;
      if (!isRevealPending(padded) && drawn.has("padded")) shownAfter = index;
    }
    const pass = world.engine.getRenderPassNames().lastIndexOf("Forward objects#0");
    const effect = (mesh: Mesh) => mesh.subMeshes[0]?._getDrawWrapper(pass)?.effect;
    const { pipelines, warmPipelines, synchronous } = world.driver;
    expect({
      sameEffect: !!effect(padded) && effect(padded) === effect(crate), lookedUp: world.driver.lookups() > 0, hiddenWhilePending,
      shownAfter, held, viewPipelines: pipelines.size, synchronous: synchronous.size, warmed: warmPipelines.size > 0,
    }).toEqual({
      sameEffect: true, lookedUp: true, hiddenWhilePending: true, shownAfter: 0, held: 0, viewPipelines: 0, synchronous: 0, warmed: true,
    });
  });
});

