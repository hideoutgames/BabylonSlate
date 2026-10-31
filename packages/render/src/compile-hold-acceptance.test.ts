/**
 * Compile-hold acceptance harness: one Play scenario per cause of a mid-game
 * shader compile, run against the real Play Engine (`createEngine` with
 * `playMode`), its world view coordinator, lighting, shadows and materials on a
 * headless NullEngine with uniform buffers, on the light block's path.
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
  InstancedMesh,
  MeshBuilder,
  NullEngine,
  NullEngineOptions,
  Material,
  Matrix,
  PBRMaterial,
  PointLight,
  RawTexture,
  RenderTargetTexture,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  SubMesh,
  Texture,
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
  areaRectLightBindings, createDefaultRenderTargetCaptureProperties, createDefaultScene, DEFAULT_RENDER_EFFECTS, fogVolumeBindings, normalizeRenderingQuality,
  normalizeRenderProjectSettings, parseText2DProperties, parseText3DProperties,
} from "@haptic/core";
import { AREA_EMISSION_EDGE, decodeAreaEmission, encodeAreaEmission } from "@haptic/assets";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rectLightEmission } from "./area-emission-array";
import { createEngine } from "./create-engine";
import { drawsInPass } from "./webgpu-pipeline-deferral";
import { upsertFogVolumes } from "./fog-volumes";
import { markSceneReadinessDirty } from "./scene-readiness-signal";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { isForwardLightExcluded, setAuthoredLightEnabled } from "./light-policy";
import { HAPTIC_LIGHT_MAXIMUM, hapticLightBuffer } from "./haptic-lights";
import { compileMaterialPlan } from "./material-compiler";
import { sceneRenderingSettings, updateSceneRenderingSettings } from "./render-settings";
import { AUTHORED_LIGHT_PREFIX } from "./scene-illumination";
import { SceneRenderCoordinator } from "./scene-render-coordinator";
import { isAtlasShadow } from "./shadow-atlas";
import { findSceneShadowController } from "./shadow-controller";
import { awaitsFirstDraw, setFirstDrawsUrgent } from "./shadow-first-draw";
import { sceneInstancePool } from "./instance-pool";
import { pooledLeafOf } from "./pooled-visuals";
import { isRevealPending, noteDrawn, onMeshRevealed } from "./reveal-pending";
import { FIRST_DRAWS_PER_FRAME, firstDrawsPerFrame } from "./variant-pipeline-warmup";
import { isSceneGameTimePaused } from "./scene-game-time";
import { enableHeadlessCascades, enableHeadlessCubeTargets } from "./shadow-test-fixtures";
import { encodeTriangleGlb } from "./glb-test-fixtures";
import { mockCubeTextureIO } from "./texture-test-fixtures";
import type { AssignMeshCommand, AssignMeshPart } from "./snapshot-apply";
import { spawnableLightsOfLoad, type SpawnableLightLoad } from "./spawnable-lights";
import { setSceneBindsPreviousEffects } from "./variant-swaps";
import { setUnlitMaterial, type UnlitBinding, type UnlitMaterialKey } from "./unlit-material";
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
// The load draws its starting state without view culling behind the loading screen; a case leaves it out unless it
// sets `drawStartingState`, so its cause meets the scene as a load without it would.
vi.mock("./starting-state-draw", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./starting-state-draw")>();
  return {
    ...actual,
    createStartingStateDraw: vi.fn((...args: Parameters<typeof actual.createStartingStateDraw>) => drawStartingState
      ? actual.createStartingStateDraw(...args)
      : { done: true, frame() {}, check() {}, cancel() {}, release() {} }),
  };
});
let drawStartingState = false;
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
  drawStartingState = false;
  frameMs = FRAME_MS;
});

/** Each Play frame advances the clock this much, so a run of held frames crosses the pause delay deterministically. */
const FRAME_MS = 100;
/** The clock step of the next Play frames (a case with a realistic frame clock sets 16 ms). */
let frameMs = FRAME_MS;
/** Frames a pending compile or pipeline stays pending before the driver releases it (600 ms). */
const PENDING_FRAMES = 6;

/** A headless WebGL2-shaped Engine (uniform buffers come from the test setup), shadow maps with cascades. */
function headlessEngine(): NullEngine {
  const engine = adaptNullEngineFrameGraph(new NullEngine(new NullEngineOptions()));
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
    /** WebGPU model: a lookup scope is open (`lookUpPipelines`), and how many scopes of any kind are. */
    lookingUp: () => scopes.some((scope) => scope.lookup),
    openScopes: () => scopes.length,
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
/**
 * Whether `playWorld` gives the Engine hardware instancing unless a case says otherwise, which turns Play's primitive
 * pooling on (`sceneInstancing`). Off while the pooled run of every case is brought up (`HAPTIC_GATE_INSTANCING=1`).
 */
const INSTANCING_BY_DEFAULT = process.env.HAPTIC_GATE_INSTANCING === "1";

function playWorld(
  model: Model, actors: Actor[], materials: string[] = [], subject = "actor-2", load = classesLoad([]),
  { instancing = INSTANCING_BY_DEFAULT }: { instancing?: boolean } = {},
) {
  // Preparation polls every 16 ms and the Play pause waits 250 ms: both run on this clock.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"], now: 1_000 });
  cleanups.push(() => vi.useRealTimers());
  const engine = headlessEngine();
  // Play pools primitives where the Engine instances in hardware (`sceneInstancing`).
  if (instancing) engine.getCaps().instancedArrays = true;
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
  /** The mesh whose submeshes draw the visual named `name`: a pooled visual's group source, or the mesh itself. */
  const drawn = (name: string) => {
    const root = handle.scene.getMeshByName(name);
    return (root && pooledLeafOf(root)?.sourceMesh) ?? root;
  };
  const subjectEffect = () => {
    const pass = engine.getRenderPassNames().lastIndexOf("Forward objects#0");
    return pass < 0 ? null : drawn(subject)?.subMeshes?.[0]?._getDrawWrapper(pass)?.effect ?? null;
  };
  return { engine, handle, driver, holds, world, place, remove, move, frame, views, subjectEffect, view, drawn };
}

type PlayWorld = ReturnType<typeof playWorld>;

/** What one cause did to a settled Play view under one driver model. */
interface CauseRecord {
  /** Effects compiled after the cause: each blocks the thread on a driver without parallel compile. */
  effects: number;
  /** Of those, lit surface variants (the light block's, which bind its `HapticLights` buffer). */
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
  // The load's starting-state draw runs in the presentation's loading frames.
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
    litEffects: created.filter((effect) => effect.getUniformBuffersNames().includes("HapticLights")).length,
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
  const previous = model === "sync" && record.effects > FIRST_DRAWS_PER_FRAME.webgl2
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
    if (!engine.getCurrentRenderPassName().startsWith("warm ")) {
      drawn.add(this.name);
      // A batch draws its visible instances: a pooled visual's leaf, named for its slot root, under that root.
      const subMesh = args[0];
      for (const instance of this._getInstancesRenderList(subMesh._id).visibleInstances[subMesh._id] ?? []) {
        drawn.add(instance.name);
        if (instance.parent) drawn.add(instance.parent.name);
      }
    }
    return render.apply(this, args);
  });
  return drawn;
}

/**
 * Flips each graph Material's two-sided define (`HAPTIC_TWO_SIDED`), as a change to the Material does, marking the
 * Scene's readiness: its meshes ask for a new variant, which no light change does on the block's path.
 */
function toggleTwoSided(scene: Scene, ...materials: Material[]): void {
  for (const material of materials) material.backFaceCulling = !material.backFaceCulling;
  markSceneReadinessDirty(scene);
}

describe("compile holds after the first frame", () => {
  it.each(MODELS)("an area light's emission texture arrives without compiling a shader: %s", async (model) => {
    // The block samples emissions from layers of one texture array (`area-emission-array.ts`): an arrival fills the
    // light's layer and asks no Material for a new variant.
    const pixels = await areaEmissionPixels();
    const world = playWorld(model, []);
    world.handle.applyCommand({ type: "setAreaLights", slotId: 2, lights: areaRectLightBindings([{ id: "panel", classId: "AreaRectLightComponent", properties: { textureGuid: "panel-texture" } }]) });
    const panel = () => world.handle.scene.lights.find((entry) => entry.getClassName() === "RectAreaLight")!;
    let before: boolean | undefined;
    const record = await measure(world, () => world.handle.setMeshAssets({ areaEmissions: new Map([["panel-texture", pixels]]) }),
      () => { before = rectLightEmission(panel()) !== undefined; });
    expect({
      before, after: rectLightEmission(panel()) !== undefined, effects: record.effects, pipelines: record.pipelines + record.warmPipelines,
      heldFrames: record.heldFrames, holdRaised: record.holdRaised, paused: record.pausedFrames > 0, recovered: record.recovered,
    }, JSON.stringify(record)).toEqual({
      before: false, after: true, effects: 0, pipelines: 0, heldFrames: 0, holdRaised: false, paused: false, recovered: true,
    });
  });

  it.each(MODELS)("a frozen graph Material adopts its new variant: %s", async (model) => {
    // The editor freezes library Materials; a frozen NodeMaterial adopts a ready variant only when probed. A light
    // change asks it for none, so its own two-sided define changes.
    const barrel: Actor = { slotId: 20, guid: "barrel", position: [2, 1, 1], assign: { meshAssetGuid: null, meshKind: "box" } };
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1]), point(11, [1.5, 2.5, -1]), barrel], ["surface-a"], "actor-20");
    world.handle.applyCommand({ type: "assignMaterial", slotId: 20, materialAssetGuid: "surface-a" });
    const record = await measure(world, () => toggleTwoSided(world.handle.scene, world.handle.scene.getMeshByName("actor-20")!.material!), () => {
      const material = world.handle.scene.getMeshByName("actor-20")!.material!;
      expect(material.getClassName()).toBe("NodeMaterial");
      material.freeze();
    });
    expectSwapped(record, model);
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
    "a light Play may spawn compiles nothing at its admission, nor does an authored shadow start: %s, %s", async (model, _, spec) => {
    // A Class's prefab holds a shadowed spot, or a Spawn Actor names a Class the load cannot see. A light spawned
    // mid-game near the camera or near the casters, also where it takes the place of a point the Local Light Budget then
    // leaves out, asks its receivers for no new variant (the block reads lights as data), and its map's casters find
    // their depth variants compiled at load (`warmCasterVariants`). On WebGPU their pipelines are created by the map's
    // warm render before it first draws, never by a view's draw or synchronously in the shadow pass.
    drawStartingState = true;
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
    const map = lightOf(40) ? findSceneShadowController(world.handle.scene)!.generator(lightOf(40)!) : null;
    // The spawned actor's own meshes (its invisible origin and light helper, which the camera pass's scene probe prepares
    // with fresh defines) are a spawn of their own: what the load warmed did not have its light.
    const own = (name: string | undefined) => name === "actor-40" || !!name?.startsWith("actor-40|");
    expect({
      // The change took effect while the subject kept its variant: a spawned light is lit (in place of a point when the
      // budget is full) and a shadowed one's map has drawn.
      kept: world.subjectEffect() === before,
      spawned: !spawn || (!isForwardLightExcluded(lightOf(40)!) && (!spawn.shadows || (!!map && !awaitsFirstDraw(map))) &&
        (!spec.full || [10, 11].some((slotId) => isForwardLightExcluded(lightOf(slotId)!)))),
      effects: world.driver.created.filter((effect) => !own(requesters.get(effect))).length,
      pipelines: record.pipelines,
      synchronous: world.driver.synchronous.size,
      heldFrames: record.heldFrames, holdRaised: record.holdRaised, paused: record.pausedFrames > 0, recovered: record.recovered,
    }, JSON.stringify({ record })).toEqual({
      kept: true, spawned: true, effects: 0, pipelines: 0, synchronous: 0, heldFrames: 0, holdRaised: false,
      paused: false, recovered: true,
    });
  });

  it("a Play load counts its shader warm-up units", async () => {
    const world = playWorld("sync", [point(10, [-1.5, 2.5, -1]), point(11, [1.5, 2.5, -1]), spot(12, [0, 5, 0])]);
    const shaders: string[] = [];
    await withClock(world.handle.prewarmSceneMaterials(undefined, ({ done, total }) => shaders.push(`${done}/${total}`)));
    const total = Number(shaders[0]!.split("/")[1]);
    expect({ shadersFrom: shaders[0], shadersTo: shaders.at(-1), shaderSteps: shaders.length }).toEqual({
      shadersFrom: `0/${total}`, shadersTo: `${total}/${total}`, shaderSteps: total + 1,
    });
    expect(total).toBeGreaterThan(0);
  });

  it.each(MODELS)("a burst of swaps adopts at most FIRST_DRAWS_PER_FRAME new variants per frame: %s", async (model) => {
    // Six barrels with Materials of their own, whose two-sided define changes at once: every Material asks for a new
    // variant. Their first draws spread over frames, previous Effects drawing meanwhile.
    const guids = ["surface-a", "surface-b", "surface-c", "surface-d", "surface-e", "surface-f"];
    const barrels: Actor[] = guids.map((_, index) =>
      ({ slotId: 20 + index, guid: `barrel-${index}`, position: [-5 + index * 2, 1, 1], assign: { meshAssetGuid: null, meshKind: "box" } }));
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1]), point(11, [1.5, 2.5, -1]), ...barrels], guids);
    guids.forEach((guid, index) => world.handle.applyCommand({ type: "assignMaterial", slotId: 20 + index, materialAssetGuid: guid }));
    await settle(world);
    const pass = () => world.engine.getRenderPassNames().lastIndexOf("Forward objects#0");
    const effects = () => barrels.map((actor) =>
      world.drawn(`actor-${actor.slotId}`)!.subMeshes[0]!._getDrawWrapper(pass())?.effect ?? null);
    const before = effects();
    world.driver.arm();
    toggleTwoSided(world.handle.scene, ...barrels.map((actor) => world.handle.scene.getMeshByName(`actor-${actor.slotId}`)!.material!));
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
      atMostPerFrame: Math.max(...adoptedPerFrame) <= firstDrawsPerFrame(world.engine),
      spread: adoptedPerFrame.filter((count) => count > 0).length >= Math.ceil(barrels.length / firstDrawsPerFrame(world.engine)),
    }, JSON.stringify(adoptedPerFrame)).toEqual({ allAdopted: true, atMostPerFrame: true, spread: true });
  });

  /**
   * Shadow starts: each light's actors before, the light casting, its slot, and whether its map
   * renders several passes (a point light's faces, a sun's cascades).
   */
  const shadowStarts = {
    "a spot light": { actors: [spot(10, [0, 5, 0])], cast: () => spot(10, [0, 5, 0], { castShadows: true }), slotId: 10, passes: false },
    "a point light": { actors: [point(10, [0, 4, 0])], cast: () => point(10, [0, 4, 0], { castShadows: true }), slotId: 10, passes: true },
    "the sun (its first, cascaded map)": { actors: [], cast: () => sun({ castShadows: true }), slotId: 3, passes: true },
  } as const;

  it.each((Object.keys(shadowStarts) as (keyof typeof shadowStarts)[]).flatMap((kind) => MODELS.map((model) => [kind, model] as const)))(
    "%s starts casting shadows: %s", async (kind, model) => {
    // The floor receives the crate's shadow. Its new map is a tile of the Scene's atlas, which the receivers read
    // through the block's buffer, so they keep their variants; the casters' depth variants were compiled at load
    // (`warmCasterVariants`). On WebGPU the map's warm render creates their pipelines asynchronously, which its draw
    // would otherwise create synchronously, and the map samples neutrally (lit) until it first draws, once they exist.
    const start = shadowStarts[kind];
    const world = playWorld(model, [...start.actors], [], "actor-1");
    const shadowLight = () => world.handle.scene.lights.find((entry) => entry.name === `${AUTHORED_LIGHT_PREFIX}${start.slotId}`)!;
    const map = () => shadowLight().getShadowGenerator() as ShadowGenerator | null;
    let before: Effect | null = null;
    let neutralWhilePending = true;
    const record = await measure(world, () => world.place(start.cast()), () => { before = world.subjectEffect(); }, () => {
      const generator = map();
      // Only a pending pipeline keeps the map from drawing; with its casters' depth variants compiled, a WebGL2 map draws
      // in the change's frame.
      if (model === "webgpu") neutralWhilePending &&= !!generator && awaitsFirstDraw(generator) && generator.getDarkness() === 1;
    });
    const generator = map();
    expect({
      atlas: isAtlasShadow(generator),
      passes: (generator?.getShadowMap()?.renderPassIds.length ?? 0) > 1,
      neutralWhilePending,
      drawn: !!generator && !awaitsFirstDraw(generator) && generator.getDarkness() === 0,
      kept: world.subjectEffect() === before,
      effects: record.effects, heldFrames: record.heldFrames, holdRaised: record.holdRaised, paused: record.pausedFrames > 0,
      recovered: record.recovered, viewPipelines: record.pipelines,
      // WebGPU: the casters' depth pipelines were warmed ahead, none created synchronously by the map's draw.
      warmed: record.warmPipelines > 0, synchronousPipelines: world.driver.synchronous.size,
    }, JSON.stringify(record)).toEqual({
      atlas: true, passes: start.passes, neutralWhilePending: true, drawn: true, kept: true,
      effects: 0, heldFrames: 0, holdRaised: false, paused: false, recovered: true, viewPipelines: 0,
      warmed: model === "webgpu", synchronousPipelines: 0,
    });
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

  // WebGL2: a program's first draw holds iPad WebKit, so the load draws what it compiled behind its loading screen.
  it.each(["sync", "parallel"] as const)("a spawned actor's Material the load warmed was drawn by the load, not by its spawn: %s", async (model) => {
    drawStartingState = true;
    // The spawn warm-up's staged box draws in the load's starting-state draw, so the spawn draws nothing new.
    const world = playWorld(model, [], ["surface-a"]);
    await settle(world);
    const before = world.handle.renderDiagnostics().firstDraws!;
    world.place({ slotId: 20, guid: "barrel", position: [2, 1, 1], assign: { meshAssetGuid: null, meshKind: "box" } });
    world.handle.applyCommand({ type: "assignMaterial", slotId: 20, materialAssetGuid: "surface-a" });
    for (let index = 0; index < 4; index++) await world.frame();
    expect(world.handle.renderDiagnostics().firstDraws!.draws - before.draws).toBe(0);
    expect(world.handle.scene.meshes.some((mesh) => mesh.name.startsWith("spawnable-warm:"))).toBe(false);
  });

  it.each(MODELS)("Play culls a mesh outside the camera's view, which the load drew so it needs no first draw in view: %s", async (model) => {
    // Intermediate priority would draw every mesh every frame; Play clears that for meshes whose bounds hold. The
    // load's starting-state draw draws without view culling, so the barrel behind the camera draws there first.
    drawStartingState = true;
    const world = playWorld(model, [{ slotId: 20, guid: "barrel", position: [0, 1, -40], assign: { meshAssetGuid: null, meshKind: "box" } }], ["surface-b"]);
    world.handle.applyCommand({ type: "assignMaterial", slotId: 20, materialAssetGuid: "surface-b" });
    const drawn = spawnDraws();
    await settle(world);
    const drawnAtLoad = drawn.has("actor-20");
    drawn.clear();
    for (let index = 0; index < 3; index++) await world.frame();
    const drawnOutside = drawn.has("actor-20");
    const before = world.handle.renderDiagnostics().firstDraws;
    world.move(20, [2, 1, 1]);
    for (let index = 0; index < 3; index++) await world.frame();
    expect({ drawnAtLoad, drawnOutside, drawnInView: drawn.has("actor-20"),
      firstDrawsInView: before ? world.handle.renderDiagnostics().firstDraws!.draws - before.draws : 0,
    }).toEqual({ drawnAtLoad: true, drawnOutside: false, drawnInView: true, firstDrawsInView: 0 });
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

  it.each(["sync", "parallel"] as const)("two actors a Spawn Actor preparation compiled, spawned in one frame, first draw in frames of their own: %s", async (model) => {
    // WebGL2: the preparation compiles their Materials without drawing them, so their programs' first uses (the iPad
    // WebKit stall) are still ahead; the first-draw budget gives each its own frame, and each actor appears whole.
    const world = playWorld(model, [], ["surface-a"]);
    await settle(world);
    const documents = new Map(["surface-c", "surface-d"].map((guid) => [guid, createDefaultMaterialDocument(guid)]));
    cleanups.push(await withClock(world.handle.acquireSceneSources({ materialDocuments: documents }, { prepare: true, warm: true })));
    for (let index = 0; index < 6; index++) await world.frame();
    const before = world.handle.renderDiagnostics().firstDraws!;
    const drawn = spawnDraws();
    world.place(
      { slotId: 20, guid: "barrel", position: [2, 1, 1], assign: { meshAssetGuid: null, meshKind: "box" } },
      { slotId: 21, guid: "crate-2", position: [-2, 1, 1], assign: { meshAssetGuid: null, meshKind: "box" } },
    );
    world.handle.applyCommand({ type: "assignMaterial", slotId: 20, materialAssetGuid: "surface-c" });
    world.handle.applyCommand({ type: "assignMaterial", slotId: 21, materialAssetGuid: "surface-d" });
    for (let index = 0; index < 6; index++) await world.frame();
    const after = world.handle.renderDiagnostics().firstDraws!;
    expect({ shown: drawn.has("actor-20") && drawn.has("actor-21"), draws: after.draws - before.draws, mostInFrame: after.mostInFrame })
      .toEqual({ shown: true, draws: 2, mostInFrame: 1 });
  });

  it.each(MODELS)("a spawned actor whose Material arrived after the load is hidden until its variant is ready: %s", async (model) => {
    // Nothing warmed this Material: only the new mesh is left out while its variant compiles, and the view keeps drawing.
    const world = playWorld(model, [], ["surface-a"]);
    const drawn = spawnDraws();
    /** The mesh that draws the barrel (a pooled visual's leaf), which is what is hidden. */
    const barrel = () => {
      const root = world.handle.scene.getMeshByName("actor-20");
      return (root && pooledLeafOf(root)) ?? root;
    };
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
    /** The mesh that draws the part (a pooled part's leaf), which is what is hidden and revealed. */
    const part20 = (name: string) => {
      const root = world.handle.scene.getMeshByName(name);
      return (root && pooledLeafOf(root)) ?? root;
    };
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
        const name = mesh.name.replace(/:drawn$/, "");
        if (names.includes(name)) revealed.push([name, world.views.length]);
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
   * Scene-wide volumetric lighting on (in any render mode), with `effects` on top: the world view's graph draws the
   * spatial geometry pass (view depth) every frame, and no warm draw creates its pipelines.
   */
  function withGeometryPass(world: PlayWorld, effects: Partial<ReturnType<typeof sceneRenderingSettings>["effects"]> = {}) {
    // The spatial chain also needs texel fetches.
    Object.assign(world.engine.getCaps(), { texelFetch: true });
    updateSceneRenderingSettings(world.handle.scene, { effects: { ...sceneRenderingSettings(world.handle.scene).effects,
      volumetricLighting: { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true }, ...effects } });
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
    // Fog Volumes alone: Screen-Space Shadows would keep the geometry pass drawing every frame.
    updateSceneRenderingSettings(world.handle.scene, undefined, undefined, { screenShadows: "off" });
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
  /** A native PBR Material of each mesh's own, as an imported model's preserved slot has. */
  const ownMaterials = (world: PlayWorld, ...names: string[]) => names.map((name) => {
    const material = new PBRMaterial(name, world.handle.scene);
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
    // Fog Volumes alone: Screen-Space Shadows would keep the geometry pass drawing every frame.
    updateSceneRenderingSettings(world.handle.scene, undefined, undefined, { screenShadows: "off" });
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

  it.each([
    ["right after the change, before a steady frame probes it", 0],
    ["while a steady frame draws the previous variant", 1],
  ] as const)("a frame report requested %s settles and the view draws again: webgpu", async (_when, steadyFrames) => {
    // A report's frames validate their presentation, so they refuse the swap; only a steady frame's probe completes
    // it, and none runs while the report is pending. The report's frames probe as a steady frame does first.
    const world = playWorld("webgpu", []);
    const [crate] = ownMaterials(world, "actor-2");
    await settle(world);
    const normalForward = () => /#define FORCENORMALFORWARD\b/.test(world.subjectEffect()?.defines ?? "");
    changeDefines(world, crate!);
    for (let index = 0; index < steadyFrames; index++) await world.frame();
    const swapping = !normalForward();
    let report = "pending";
    void world.handle.captureFrame().then(() => { report = "settled"; }, (error: unknown) => { report = String(error); });
    const frames: boolean[] = [];
    // A variant no warm draw used meanwhile is admitted once `UNUSED_WARM_MS` passed (five 100 ms frames).
    for (let index = 0; index < 10; index++) frames.push((await world.frame()).view?.rendered === true);
    expect({ swapping, report, drawsAgain: frames.slice(-3), newVariant: normalForward() }, JSON.stringify(frames))
      .toEqual({ swapping: true, report: "settled", drawsAgain: [true, true, true], newVariant: true });
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
async function editorView() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"], now: 1_000 });
  cleanups.push(() => vi.useRealTimers());
  const engine = headlessEngine();
  const driver = driverModel(engine, "parallel");
  const scene = new Scene(engine);
  const camera = new UniversalCamera("camera", new Vector3(0, 3, -10), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  setSceneBindsPreviousEffects(scene);
  new DirectionalLight("sun", new Vector3(0.3, -1, 0.4), scene);
  new PointLight("near", new Vector3(-1.5, 2.5, -1), scene);
  const far = new PointLight("far", new Vector3(1.5, 2.5, -1), scene);
  const lowered = lowerMaterialDocument(createDefaultMaterialDocument());
  if (!lowered.ok) throw new Error("The default Material did not lower.");
  const compiled = compileMaterialPlan(lowered.plan, { scene, name: "graph" });
  if (!compiled.ok) throw new Error("The default Material did not compile.");
  const box = MeshBuilder.CreateBox("box", {}, scene);
  box.material = compiled.material;
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

/**
 * The lighting CI gate: after the first presented frame, lights switched,
 * spawned, recoloured, moved, removed and pushed past the light block's maximum, shadows started for each kind of atlas
 * map (the sun's cascades, a spot light's tile, a point light's faces), moved, stopped and started again, and a spawn of
 * an actor the level holds, compile no shader, wait on no WebGPU pipeline and create none in a shadow pass. A merge gate:
 * CI's unit job runs it.
 */
/** Where Play pools primitives: pipelines that are not deferred (`sceneInstancing`). */
const POOLED_MODELS: readonly Model[] = ["sync", "parallel"];

describe("pooled primitives", () => {
  const box = (slotId: number, position: Vec3): Actor =>
    ({ slotId, guid: `box-${slotId}`, position, assign: { meshAssetGuid: null, meshKind: "box" } });
  /** What a cause compiled and held, with the pool's groups and members after it. */
  const expectNothingCompiled = (world: PlayWorld, record: CauseRecord) => expect({
    effects: record.effects, pipelines: record.pipelines + record.warmPipelines, synchronous: world.driver.synchronous.size,
    heldFrames: record.heldFrames, holdRaised: record.holdRaised, recovered: record.recovered,
  }, JSON.stringify(record)).toEqual({ effects: 0, pipelines: 0, synchronous: 0, heldFrames: 0, holdRaised: false, recovered: true });

  it.each(POOLED_MODELS)("twenty boxes spawned into the load's drawn group compile nothing: %s", async (model) => {
    // The floor and crate are boxes of the engine default Material: one group, its instanced variants drawn by the load.
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1])], [], "actor-2", classesLoad([]), { instancing: true });
    const pool = sceneInstancePool(world.handle.scene);
    const record = await measure(world, () => world.place(...Array.from({ length: 20 }, (_, index) =>
      box(30 + index, [-4 + (index % 5) * 2, 1, -2 + Math.floor(index / 5) * 1.5]))));
    expectNothingCompiled(world, record);
    expect(pool.diagnostics()).toMatchObject({ groups: 1, pooled: 22 });
  });

  it.each(POOLED_MODELS)("a box whose Material changes to one another group draws compiles nothing: %s", async (model) => {
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1]), box(20, [2, 1, 1])], ["surface-a"], "actor-2", classesLoad([]),
      { instancing: true });
    world.handle.applyCommand({ type: "assignMaterial", slotId: 20, materialAssetGuid: "surface-a" });
    const record = await measure(world, () => world.handle.applyCommand({ type: "assignMaterial", slotId: 2, materialAssetGuid: "surface-a" }));
    expectNothingCompiled(world, record);
    expect(pooledLeafOf(world.handle.scene.getMeshByName("actor-2")!)?.sourceMesh)
      .toBe(pooledLeafOf(world.handle.scene.getMeshByName("actor-20")!)?.sourceMesh);
  });

  it.each(POOLED_MODELS)("a plain user of a Material only pooled groups drew compiles its variant as a swap, holding nothing: %s", async (model) => {
    // A mesh of its own drawn with the pooled Material (a model's, a deformed primitive's): its plain variant is new
    // mid-game. It is hidden until it compiles, and the view never holds nor waits on it.
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1]), box(20, [2, 1, 1])], ["surface-a"], "actor-2", classesLoad([]),
      { instancing: true });
    world.handle.applyCommand({ type: "assignMaterial", slotId: 20, materialAssetGuid: "surface-a" });
    let plain!: Mesh;
    const record = await measure(world, () => {
      plain = MeshBuilder.CreateBox("actor-21", { size: 1 }, world.handle.scene);
      plain.position.set(-2, 1, 1);
      plain.material = world.drawn("actor-20")!.material;
    });
    expect({
      pooled: pooledLeafOf(plain) !== undefined, heldFrames: record.heldFrames, holdRaised: record.holdRaised,
      recovered: record.recovered, shown: !isRevealPending(plain),
    }, JSON.stringify(record)).toEqual({ pooled: false, heldFrames: 0, holdRaised: false, recovered: true, shown: true });
  });

  it.each(POOLED_MODELS)("a load with a plain and a pooled user of one Material presents, and a spawn of either compiles nothing: %s", async (model) => {
    // A mesh of its own drawn with the pooled Material at load: the load compiles and draws both variants.
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1]), box(20, [2, 1, 1])], ["surface-a"], "actor-2", classesLoad([]),
      { instancing: true });
    world.handle.applyCommand({ type: "assignMaterial", slotId: 20, materialAssetGuid: "surface-a" });
    const plain = (name: string, x: number) => {
      const mesh = MeshBuilder.CreateBox(name, { size: 1 }, world.handle.scene);
      mesh.position.set(x, 1, 1);
      mesh.material = world.drawn("actor-20")!.material;
      return mesh;
    };
    await settle(world);
    plain("actor-21", -2);
    await settle(world);
    const record = await measure(world, () => {
      world.place(box(22, [1, 1, -2]));
      world.handle.applyCommand({ type: "assignMaterial", slotId: 22, materialAssetGuid: "surface-a" });
      plain("actor-23", -1);
    });
    expectNothingCompiled(world, record);
  });

  it.each(POOLED_MODELS)("a mesh of its own drawn with a Material only pooled groups drew holds no preparation: %s", async (model) => {
    // Its plain variant was never drawn, so it is cold; the view's preparation, which draws no frame, admits it rather
    // than wait on it until its stall.
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1]), box(20, [2, 1, 1])], ["surface-a"], "actor-2", classesLoad([]),
      { instancing: true });
    world.handle.applyCommand({ type: "assignMaterial", slotId: 20, materialAssetGuid: "surface-a" });
    await settle(world);
    const plain = MeshBuilder.CreateBox("actor-21", { size: 1 }, world.handle.scene);
    plain.position.set(-2, 1, 1);
    plain.material = world.drawn("actor-20")!.material;
    await settle(world);
    const record = await measure(world, () => world.place(box(22, [1, 1, -2])));
    expect({ shown: !isRevealPending(plain), heldFrames: record.heldFrames, recovered: record.recovered })
      .toEqual({ shown: true, heldFrames: 0, recovered: true });
  });

  it.each(POOLED_MODELS)("the last member of a drawn group despawned and spawned again compiles nothing: %s", async (model) => {
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1]), box(20, [2, 1, 1])], ["surface-a"], "actor-2", classesLoad([]),
      { instancing: true });
    world.handle.applyCommand({ type: "assignMaterial", slotId: 20, materialAssetGuid: "surface-a" });
    await settle(world);
    const pool = sceneInstancePool(world.handle.scene);
    world.remove(20);
    await world.frame();
    expect(pool.diagnostics()).toMatchObject({ groups: 1, retained: 1 });
    const record = await measure(world, () => {
      world.place(box(20, [2, 1, 1]));
      world.handle.applyCommand({ type: "assignMaterial", slotId: 20, materialAssetGuid: "surface-a" });
    });
    expectNothingCompiled(world, record);
    expect(pool.diagnostics()).toMatchObject({ groups: 2, retained: 0 });
  });
  it.each(POOLED_MODELS)("a second instance of a static model spawned after the first drew compiles nothing: %s", async (model) => {
    // A rigid model's leaf draws as a member of a group of its container geometry (`poolModelLeaves`).
    const statue = (slotId: number, position: Vec3): Actor =>
      ({ slotId, guid: `statue-${slotId}`, position, assign: { meshAssetGuid: "statue", meshKind: null } });
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1])], [], "actor-2", classesLoad([]), { instancing: true });
    world.handle.setMeshAssets({ modelBytes: new Map([["statue", encodeTriangleGlb()]]) });
    world.place(statue(20, [2, 1, 1]));
    await settle(world);
    const pool = sceneInstancePool(world.handle.scene);
    const pooled = pool.diagnostics().pooled;
    const record = await measure(world, () => world.place(statue(21, [-2, 1, 1])));
    expectNothingCompiled(world, record);
    const leaves = ["actor-20", "actor-21"].map((name) => world.handle.scene.getMeshByName(name)!.getChildMeshes(false)
      .find((mesh): mesh is InstancedMesh => mesh instanceof InstancedMesh && mesh.isVisible));
    expect({ joined: pool.diagnostics().pooled - pooled, shared: !!leaves[0] && leaves[0].sourceMesh === leaves[1]?.sourceMesh })
      .toEqual({ joined: 1, shared: true });
  });
});

describe("the lighting CI gate", () => {
  const actors = () => [point(10, [-1.5, 2.5, -1]), point(11, [1.5, 2.5, -1])];
  /** A Painter 2D surface: the unlit Material, textured and blended (`painter2d-mesh.ts`). */
  const painterKey: UnlitMaterialKey = { textured: true, backFaceCulling: false, fog: true, role: "world" };
  const canvas = (scene: Scene, rgba: number[]) => {
    const texture = RawTexture.CreateRGBATexture(new Uint8Array(rgba), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    // NullEngine never uploads, so its textures never report ready.
    texture.isReady = () => true;
    return texture;
  };
  const painting = (texture: Texture, overrides: Partial<UnlitBinding> = {}): UnlitBinding =>
    ({ texture, color: [1, 1, 1], alpha: 1, cutoff: 0, blend: true, textureAlpha: true, twoSided: false, ...overrides });
  /** The gameplay script: Effects each step compiled. */
  /** A sprite: the unlit Material, cut out at 0.4, culled (`mesh-assets.ts`). */
  const spriteKey: UnlitMaterialKey = { textured: true, backFaceCulling: true, fog: true, role: "world" };
  /** The world's unlit surfaces, drawn from its first frame. */
  const unlitSurfaces = (world: PlayWorld) => {
    const painter = MeshBuilder.CreatePlane("gate-painter", { size: 2 }, world.handle.scene);
    painter.position.set(0, 1, 2);
    setUnlitMaterial(painter, painterKey, painting(canvas(world.handle.scene, [255, 0, 0, 255])));
    const sprite = MeshBuilder.CreatePlane("gate-sprite", { size: 1 }, world.handle.scene);
    sprite.position.set(2, 1, 2);
    setUnlitMaterial(sprite, spriteKey, painting(canvas(world.handle.scene, [0, 0, 255, 255]), { blend: false, cutoff: 0.4 }));
    return { painter, sprite };
  };
  const play = async (world: PlayWorld, { painter, sprite }: { painter: Mesh; sprite: Mesh }) => {
    const steps: Array<[string, () => void]> = [
      ["a point light switches off", () => world.place(point(11, [1.5, 2.5, -1], { enabled: false }))],
      ["it switches back on", () => world.place(point(11, [1.5, 2.5, -1]))],
      ["a point light spawns", () => world.place(point(12, [0, 2.5, 2]))],
      ["a spot light spawns", () => world.place(spot(13, [0, 5, 0]))],
      ["lights move", () => { world.move(10, [-3, 2, -2]); world.move(13, [1, 5, 1]); }],
      ["a light's colour and intensity change", () => world.place(point(12, [0, 2.5, 2], { color: [1, 0.4, 0.2], intensity: 3 }))],
      ["the sun starts casting shadows", () => world.place(sun({ castShadows: true }))],
      ["a spot light starts casting shadows", () => world.place(spot(13, [1, 5, 1], { castShadows: true }))],
      ["a point light starts casting shadows", () => world.place(point(10, [-3, 2, -2], { castShadows: true }))],
      ["a shadowed light moves", () => world.move(13, [-1, 5, 0])],
      ["a light stops casting shadows", () => world.place(point(10, [-3, 2, -2]))],
      ["it starts again", () => world.place(point(10, [-3, 2, -2], { castShadows: true }))],
      ["a light is removed", () => world.remove(12)],
      ["more point lights spawn than the block draws", () =>
        world.place(...Array.from({ length: 40 }, (_, index) => point(100 + index, [-10 + (index % 10) * 2, 2.5, Math.floor(index / 10) * 3])))],
      ["an actor the level holds spawns", () => world.place({ slotId: 200, guid: "crate-2", position: [2, 1, 0], assign: { meshAssetGuid: null, meshKind: "box" } })],
      ["a sprite crossfades and its texture switches from a PNG to a KTX2", () => {
        // A KTX2 is flipped on its wrapper: a texture matrix that is not the identity.
        const ktx2 = canvas(world.handle.scene, [0, 255, 0, 255]);
        ktx2.vScale = -1;
        setUnlitMaterial(sprite, spriteKey, painting(ktx2, { blend: false, cutoff: 0.4 }));
        sprite.visibility = 0.5;
      }],
      ["a painter repaints onto another canvas and fades", () => {
        setUnlitMaterial(painter, painterKey, painting(canvas(world.handle.scene, [0, 128, 255, 128]), { color: [0.5, 1, 1] }));
        painter.visibility = 0.5;
      }],
    ];
    const compiled: Record<string, number> = {};
    for (const [name, step] of steps) {
      const before = world.driver.created.length;
      step();
      for (let index = 0; index < 4; index++) await world.frame();
      compiled[name] = world.driver.created.length - before;
    }
    return compiled;
  };

  it.each(MODELS)("lights change mid-game without compiling a shader or waiting on a pipeline: %s", async (model) => {
    const world = playWorld(model, actors());
    const surfaces = unlitSurfaces(world);
    await settle(world);
    world.driver.arm();
    const compiled = await play(world, surfaces);
    const lightDefines = Object.values(compiledEffects(world.engine)).filter((effect) => /#define LIGHT0\b/.test(effect.defines));
    // The block drew the script's lights: the sun, the spot and as many of the 42 points left as the Local Light Budget
    // leaves beside the spot, up to the block's maximum.
    const points = Math.min(HAPTIC_LIGHT_MAXIMUM.point, sceneRenderingSettings(world.handle.scene).localLightBudget - 1);
    const buffer = hapticLightBuffer(world.handle.scene) as unknown as { _bufferData: Float32Array; _uniformLocations: Record<string, number> };
    const counts = [...buffer._bufferData.subarray(buffer._uniformLocations.hapticCounts!, buffer._uniformLocations.hapticCounts! + 4)];
    // The atlas holds the three kinds' maps.
    const atlas = [3, 13, 10].map((slot) =>
      isAtlasShadow(world.handle.scene.lights.find((entry) => entry.name === `${AUTHORED_LIGHT_PREFIX}${slot}`)?.getShadowGenerator()));
    expect({
      compiled, pipelines: world.driver.pipelines.size, synchronous: world.driver.synchronous.size, lightDefines: lightDefines.length,
      counts, atlas,
    }).toEqual({
      compiled: Object.fromEntries(Object.keys(compiled).map((name) => [name, 0])), pipelines: 0, synchronous: 0, lightDefines: 0,
      counts: [1, points, 1, 0], atlas: [true, true, true],
    });
  });

  it.each(MODELS)("with Screen-Space Shadows at High, lights change without compiling or rebuilding the view: %s", async (model) => {
    const world = playWorld(model, actors());
    // Spatial effects need texel fetches, which the headless Engine leaves off.
    Object.assign(world.engine.getCaps(), { texelFetch: true });
    world.handle.setRenderSettings(normalizeRenderProjectSettings({
      shadows: { screenShadows: "high" },
    }));
    const surfaces = unlitSurfaces(world);
    await settle(world);
    const tasks = world.handle.renderTaskNames();
    const screenEffects = () => Object.values(compiledEffects(world.engine)).filter((effect) => /^#define HAPTIC_SCREEN_SHADOWS$/m.test(effect.defines));
    const before = screenEffects();
    world.driver.arm();
    const builds = vi.spyOn(FrameGraph.prototype, "buildAsync");
    const compiled = await play(world, surfaces);
    expect({
      compiled, pipelines: world.driver.pipelines.size, synchronous: world.driver.synchronous.size, builds: builds.mock.calls.length,
      marched: tasks.slice(tasks.indexOf("Spatial Geometry"), tasks.indexOf("Forward objects") + 1), tasks: world.handle.renderTaskNames(),
      reading: before.length > 0, sameReaders: screenEffects(),
    }).toEqual({
      compiled: Object.fromEntries(Object.keys(compiled).map((name) => [name, 0])), pipelines: 0, synchronous: 0, builds: 0,
      marched: ["Spatial Geometry", "Screen shadows", "Forward objects"], tasks, reading: true, sameReaders: before,
    });
  });

  it.each(MODELS)("with occlusion culling forced on and the crate hidden behind a wall, lights change without compiling: %s", async (model) => {
    // A wall between the camera and the crate (the lights' receiver), standing in front of the camera's whole view of it.
    const wall: Actor = { slotId: 20, guid: "wall", position: [0, 2, -5], scale: [6, 4, 0.2], assign: { meshAssetGuid: null, meshKind: "box" } };
    const world = playWorld(model, [...actors(), wall]);
    // Play's world view follows the project's Occlusion Culling setting.
    world.handle.setRenderSettings(normalizeRenderProjectSettings({ quality: { geometry: { occlusionCulling: true } } }));
    const surfaces = unlitSurfaces(world);
    await settle(world);
    world.driver.arm();
    const compiled = await play(world, surfaces);
    const crate = world.handle.scene.getMeshByName("actor-2")!;
    const hidden = world.view().occlusionDiagnostics()!.culled;
    // The debug views switch on: a 2D overlay and a frozen buffer, which compile nothing.
    const beforeDebug = world.driver.created.length;
    world.handle.applyCommand({ type: "setOcclusionDebug", show: true, freeze: true });
    for (let index = 0; index < 4; index++) await world.frame();
    const debug = { compiled: world.driver.created.length - beforeDebug, buffer: world.handle.occlusionOverlay()?.buffer != null };
    world.handle.applyCommand({ type: "setOcclusionDebug", show: false, freeze: false });
    // The wall moves aside: the crate, lit by every light the script changed, draws again.
    const before = world.driver.created.length;
    world.move(20, [30, 2, -5]);
    for (let index = 0; index < 4; index++) await world.frame();
    expect({
      compiled, pipelines: world.driver.pipelines.size, synchronous: world.driver.synchronous.size,
      // Occlusion left Babylon's own state alone.
      crateShown: crate.isEnabled() && crate.isVisible, hidden: hidden > 0,
      reappeared: world.driver.created.length - before, culledAfter: world.view().occlusionDiagnostics()!.culled, debug,
    }).toEqual({
      compiled: Object.fromEntries(Object.keys(compiled).map((name) => [name, 0])), pipelines: 0, synchronous: 0,
      crateShown: true, hidden: true, reappeared: 0, culledAfter: 0, debug: { compiled: 0, buffer: true },
    });
  });
});

describe("the editor world view", () => {
  it("probes each steady frame while a frozen graph Material swaps, so it draws its new variant once that is ready", async () => {
    // The editor freezes library Materials: a frozen NodeMaterial adopts a ready variant only when a probe asks again.
    const { driver, scene, material, frame, effect } = await editorView();
    material.freeze();
    const before = effect();
    driver.arm();
    toggleTwoSided(scene, material);
    for (let index = 0; index < 3; index++) {
      expect(await frame()).toBe(true);
      expect(effect()).toBe(before);
    }
    expect(driver.created.length).toBeGreaterThan(0);
    driver.release();
    expect(await frame()).toBe(true);
    expect(driver.created).toContain(effect());
  });

  it("draws the previous Effect through a preparation a strict readiness question started", async () => {
    // Play asks its world view strictly at the end of each frame. When that question is the first to find the graph
    // needing a preparation (here for a new output size), the preparation it starts serves the steady frames, which
    // draw a swapping Material's previous Effect.
    const { driver, scene, material, view, frame, effect, resize } = await editorView();
    const before = effect();
    driver.arm();
    toggleTwoSided(scene, material);
    resize(320, 200);
    expect(view.isReady()).toBe(false);
    expect(view.settled).toBe(false);
    const frames: boolean[] = [];
    for (let index = 0; index < 4; index++) frames.push(await frame() && effect() === before);
    expect(driver.created.length).toBeGreaterThan(0);
    expect(frames.slice(1)).toEqual([true, true, true]);
  });

  it("answers a strict question after a tolerant preparation found a swap without probing the scene again", async () => {
    const { driver, scene, material, view, frame, resize } = await editorView();
    driver.arm();
    toggleTwoSided(scene, material);
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
    // Its two new variants (colour and depth pre-pass) take a frame each of the WebGL2 first-draw budget.
    for (let index = 0; index < 3; index++) {
      await frame();
      hidden.push(isRevealPending(pane));
    }
    expect({ hidden, reveals, drawn: drawn.has("pane") }).toEqual({ hidden: [false, false, false, false, false, false], reveals: [], drawn: true });
  });

  it("ends a swap whose new variant failed to link: the previous Effect stays, probing stops and strict readiness passes", async () => {
    const { driver, scene, material, view, frame, effect } = await editorView();
    const before = effect();
    driver.arm();
    toggleTwoSided(scene, material);
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

  /** A light over the re-sent visual whose shadows drew: a spot's map, or the sun's cascaded one. */
  const shadowing = (kind: "spot" | "sun", intensity: number) => kind === "spot"
    ? spot(10, [0, 6, -4], { castShadows: true, intensity }) : sun({ castShadows: true, intensity });
  const shadowMapOf = (world: PlayWorld, kind: "spot" | "sun") => world.handle.scene.lights
    .find((entry) => entry.name === `${AUTHORED_LIGHT_PREFIX}${kind === "spot" ? 10 : 3}`)!.getShadowGenerator() as ShadowGenerator;
  /** Records the meshes a real (not skipped) draw into `map` drew, until cleared. */
  const castsInto = (world: PlayWorld, map: ShadowGenerator) => {
    const cast = new Set<AbstractMesh>();
    let before = 0;
    map.onBeforeShadowMapRenderMeshObservable.add(() => { before = world.driver.draws(); });
    map.onAfterShadowMapRenderMeshObservable.add((mesh) => { if (world.driver.draws() > before) cast.add(mesh); });
    return cast;
  };
  /** Records the meshes the view drew (warm draws only create pipelines), until cleared. */
  const viewDraws = () => {
    const drawn = new Set<AbstractMesh>();
    const render = Mesh.prototype.render;
    vi.spyOn(Mesh.prototype, "render").mockImplementation(function (this: Mesh, ...args) {
      if (!this.getScene().getEngine().getCurrentRenderPassName().startsWith("warm ")) drawn.add(this);
      return render.apply(this, args);
    });
    return drawn;
  };

  const RATES = [["every tick", 1], ["twice a frame", 2]] as const;
  it.each(RATES.flatMap(([rate, ticksPerFrame]) => (["spot", "sun"] as const).map((kind) => [rate, kind, ticksPerFrame] as const)))(
    "a Text3D whose text changes %s under a drawn %s map draws every frame and casts into it: webgpu", async (_rate, kind, ticksPerFrame) => {
    // The script also writes the light every tick, so the shadow controller lists each rebuilt mesh as a caster before
    // its probe. The mesh takes the place of one that drew and cast (at two ticks a frame, of a rebuild of it that never
    // drew), so its reveal waits for no map to list it while hidden: the lookup finds its pipelines and it is revealed
    // in its first frame. Revealed, it is a caster new to the map whose depth pipeline (the previous mesh's) exists, so
    // that frame's map render draws it.
    const world = playWorld("webgpu", [shadowing(kind, 1), actor(text3d("Score 0"))]);
    await settle(world);
    const map = shadowMapOf(world, kind);
    const cast = castsInto(world, map);
    const drawn = viewDraws();
    world.driver.arm();
    const visuals = new Set<AbstractMesh>();
    const rows: { drawn: boolean; hidden: boolean; held: boolean; cast: boolean }[] = [];
    for (let index = 0; index < 6; index++) {
      for (let tick = index * ticksPerFrame; tick < (index + 1) * ticksPerFrame; tick++)
        world.place(actor(text3d(`Score ${tick + 1}`)), shadowing(kind, 1 + (tick + 1) / 10));
      const visual = world.handle.scene.getMeshByName(`actor-${SLOT}`)!;
      visuals.add(visual);
      drawn.clear();
      cast.clear();
      const { view } = await world.frame();
      rows.push({ drawn: drawn.has(visual), hidden: isRevealPending(visual), held: view?.rendered !== true, cast: cast.has(visual) });
    }
    const { pipelines, synchronous } = world.driver;
    expect({ mapDrawn: !awaitsFirstDraw(map), rebuilt: visuals.size, rows, pipelines: pipelines.size, synchronous: synchronous.size })
      .toEqual({
        mapDrawn: true, rebuilt: 6, rows: Array.from({ length: 6 }, () => ({ drawn: true, hidden: false, held: false, cast: true })),
        pipelines: 0, synchronous: 0,
      });
  });

  it.each(["spot", "sun"] as const)(
    "a model visual rebuilt under a drawn %s map draws whole every frame and casts from the frame it takes the slot: webgpu", async (kind) => {
    // A changed assignment of an actor with a model part stages its new visual until the model has loaded. The visual it
    // replaces goes only when it takes the slot, and the shadow controller lists it as a caster then. It takes the place
    // of a visual that drew, so its reveal waits for no map to list it: the lookup finds its pipelines (the same model's
    // and box's) and it draws, and casts, in the first frame it holds the slot.
    const model = (orderInLayer: number): Actor => ({
      slotId: SLOT, guid: "visual", position: [0, 1, -4], assign: { meshAssetGuid: null, meshKind: null, orderInLayer, parts: [
        part("body", "box", { meshAssetGuid: "model" }), part("base", "box", { position: [0, -0.5, 0], scale: [0.6, 0.1, 0.6] }),
      ] },
    });
    const world = playWorld("webgpu", [shadowing(kind, 1)]);
    world.handle.setMeshAssets({ modelBytes: new Map([["model", encodeTriangleGlb()]]) });
    world.place(model(0));
    await settle(world);
    const scene = world.handle.scene;
    /** The slot's visual a frame shows (a staged replacement stays disabled until it takes the slot), and its surfaces. */
    const shown = () => scene.meshes.find((mesh) => mesh.name === `actor-${SLOT}` && mesh.isEnabled());
    const surfaces = (root: AbstractMesh | undefined) => root?.getChildMeshes(false).filter((mesh) => mesh.getTotalVertices() > 0) ?? [];
    const cast = castsInto(world, shadowMapOf(world, kind));
    const drawn = viewDraws();
    const first = shown();
    drawn.clear();
    await world.frame();
    const drewBefore = surfaces(first).length > 0 && surfaces(first).every((mesh) => drawn.has(mesh));
    world.driver.arm();
    world.place(model(1), shadowing(kind, 1.1));
    /** Frames in which some surface of the slot's visual did not draw. */
    let incomplete = 0;
    let held = 0;
    let adoptedAt = -1;
    let castAt = -1;
    for (let index = 0; index < 12 && castAt < 0; index++) {
      const visual = shown();
      // Before the frame: a replacement taking the slot after it disposes this visual.
      const parts = surfaces(visual);
      drawn.clear();
      cast.clear();
      if ((await world.frame()).view?.rendered !== true) held++;
      if (!parts.length || !parts.every((mesh) => drawn.has(mesh))) incomplete++;
      if (visual === first) continue;
      if (adoptedAt < 0) adoptedAt = index;
      if (parts.every((mesh) => cast.has(mesh))) castAt = index;
    }
    expect({ drewBefore, adopted: adoptedAt >= 0, incomplete, held, castOnAdoption: castAt >= 0 && castAt === adoptedAt,
      synchronous: world.driver.synchronous.size }).toEqual({
      drewBefore: true, adopted: true, incomplete: 0, held: 0, castOnAdoption: true, synchronous: 0,
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

  it("a lookup whose preparation throws leaves no deferral scope open, and the mesh still appears: webgpu", async () => {
    // Preparing the lookup ahead of a hidden mesh's draws (its warm draw wrapper) throws once. The lookup scope, which
    // replays its pass's target and, while open, starts no GPU pass for any draw on the Engine, is closed all the same;
    // the failure is reported once, and the mesh's warm draws reveal it instead.
    const world = playWorld("webgpu", []);
    await settle(world);
    const scene = world.handle.scene;
    const crate = scene.getMeshByName("actor-2") as Mesh;
    const getDrawWrapper = SubMesh.prototype._getDrawWrapper;
    let thrown = 0;
    vi.spyOn(SubMesh.prototype, "_getDrawWrapper").mockImplementation(function (this: SubMesh, ...args) {
      if (args[1] === true && world.driver.lookingUp() && thrown++ === 0) throw new Error("injected lookup preparation failure");
      return getDrawWrapper.apply(this, args);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    world.driver.arm();
    // Beside the crate, with its Material: the same variant, whose pipelines exist, so its probe looks them up.
    const spawned = MeshBuilder.CreateBox("spawned", { size: 1 }, scene);
    spawned.material = crate.material;
    spawned.position.set(1.5, 1, 0);
    let held = 0;
    const open: number[] = [];
    let shownAfter = -1;
    for (let index = 0; index < 4 && shownAfter < 0; index++) {
      if (!(await world.frame()).view?.rendered) held++;
      open.push(world.driver.openScopes());
      if (!isRevealPending(spawned)) shownAfter = index;
    }
    const reports = warn.mock.calls.filter(([message]) => String(message).includes("warm draws failed")).length;
    expect({ thrown: thrown > 0, open, reports, held, shown: shownAfter >= 0 }, JSON.stringify({ shownAfter })).toEqual({
      thrown: true, open: open.map(() => 0), reports: 1, held: 0, shown: true,
    });
  });
});

