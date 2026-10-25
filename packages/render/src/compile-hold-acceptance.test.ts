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
 *   exists.
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
  DirectionalLight,
  Mesh,
  MeshBuilder,
  NullEngine,
  NullEngineOptions,
  Light,
  Material,
  PBRMaterial,
  PointLight,
  Scene,
  ShadowGenerator,
  SpotLight,
  StandardMaterial,
  SubMesh,
  UniversalCamera,
  Vector3,
  type AbstractEngine,
  type Effect,
} from "@babylonjs/core";
import {
  SNAPSHOT_FLAG_VISIBLE,
  snapshotFloatCount,
  writeActorSlot,
  writeSnapshotHeader,
  type ScriptBundleEntry,
} from "@haptic/bridge";
import { areaRectLightBindings, createDefaultScene, normalizeRenderingQuality } from "@haptic/core";
import { AREA_EMISSION_EDGE, decodeAreaEmission, encodeAreaEmission } from "@haptic/assets";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "./create-engine";
import { effectLightSeats } from "./fixed-light-binding";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { setFixedShapeLightingEnabled, setFixedShapeLightingWorldScene } from "./fixed-light-admission";
import { isForwardLightExcluded, nearForwardAdmissions, setAuthoredLightEnabled } from "./light-policy";
import { compileMaterialPlan } from "./material-compiler";
import { sceneRenderingSettings, updateSceneRenderingSettings } from "./render-settings";
import { AUTHORED_LIGHT_PREFIX } from "./scene-illumination";
import { SceneRenderCoordinator } from "./scene-render-coordinator";
import { existingShadowSamplerPlaceholders } from "./shadow-sampler-placeholders";
import { findSceneShadowController, PREDICTION_MAP_SIZE } from "./shadow-controller";
import { awaitsFirstDraw } from "./shadow-first-draw";
import { isRevealPending, onMeshRevealed } from "./reveal-pending";
import { FIRST_DRAWS_PER_FRAME } from "./variant-pipeline-warmup";
import { PREDICTIONS_MAX } from "./variant-prediction";
import { managedRenderReservations } from "./managed-render-resources";
import { shadowBytesPerTexel } from "./shadow-admission";
import { isSceneGameTimePaused } from "./scene-game-time";
import { enableHeadlessCascades, enableHeadlessCubeTargets } from "./shadow-test-fixtures";
import { mockCubeTextureIO } from "./texture-test-fixtures";
import type { AssignMeshCommand, AssignMeshPart } from "./snapshot-apply";
import { spawnableLightsFromScripts } from "./spawnable-lights";
import { beginPipelineDeferral, effectDrawn, pipelinesDeferred } from "./webgpu-pipeline-deferral";

// NullEngine is not WebGPU, so the real deferral never engages; the `webgpu` model replaces it.
vi.mock("./webgpu-pipeline-deferral", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./webgpu-pipeline-deferral")>();
  return {
    ...actual,
    beginPipelineDeferral: vi.fn(actual.beginPipelineDeferral),
    pipelinesDeferred: vi.fn(actual.pipelinesDeferred),
    effectDrawn: vi.fn(actual.effectDrawn),
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
const { beginPipelineDeferral: actualBeginPipelineDeferral, pipelinesDeferred: actualPipelinesDeferred, effectDrawn: actualEffectDrawn } =
  await vi.importActual<typeof import("./webgpu-pipeline-deferral")>("./webgpu-pipeline-deferral");

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

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.restoreAllMocks();
  vi.mocked(beginPipelineDeferral).mockImplementation(actualBeginPipelineDeferral);
  vi.mocked(pipelinesDeferred).mockImplementation(actualPipelinesDeferred);
  vi.mocked(effectDrawn).mockImplementation(actualEffectDrawn);
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
    pending.add(effect);
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
  type Scope = { allows: (pass: number) => boolean; warm: boolean; skipped: number; lookups: number; hits: number; effects: Set<Effect> };
  const scopes: Scope[] = [];
  if (model === "webgpu") {
    vi.mocked(pipelinesDeferred).mockReturnValue(true);
    vi.mocked(effectDrawn).mockImplementation((_engine, effect) => drawnEffects.has(effect as Effect));
    vi.mocked(beginPipelineDeferral).mockImplementation((_engine, allows, options = {}) => {
      if (options.nested && !scopes.length) return undefined;
      const warm = options.warm === true;
      const scope: Scope = { allows, warm, skipped: 0, lookups: 0, hits: 0, effects: new Set() };
      scopes.push(scope);
      let closed = false;
      return {
        close: () => {
          if (!closed) {
            closed = true;
            const index = scopes.lastIndexOf(scope);
            if (index >= 0) scopes.splice(index, 1);
            const parent = scopes[index - 1];
            if (parent && !warm) {
              parent.skipped += scope.skipped;
              for (const effect of scope.effects) parent.effects.add(effect);
            }
          }
          return scope.skipped;
        },
        waiting: () => [...scope.effects].some((effect) => pending.has(effect)),
        warmed: () => scope.lookups > 0 && scope.hits === scope.lookups,
      };
    });
    const internals = engine as unknown as { _currentEffect: Effect | null; currentRenderPassId: number };
    for (const name of ["drawElementsType", "drawArraysType"] as const) {
      const draw = (engine[name] as (...args: unknown[]) => void).bind(engine);
      vi.spyOn(engine, name).mockImplementation(((...args: unknown[]) => {
        const effect = internals._currentEffect;
        let scope: Scope | undefined;
        for (let index = scopes.length - 1; index >= 0 && !scope; index--)
          if (scopes[index]!.allows(internals.currentRenderPassId)) scope = scopes[index];
        // An Effect's first draw needs its pipeline: at once before arming or after release, pending in between (an
        // Effect the load compiled without drawing it, such as a spawnable's, has none yet).
        if (effect && !pipelineReady.has(effect) && !pending.has(effect)) {
          if (armed && holding) pending.add(effect);
          else pipelineReady.add(effect);
        }
        const missing = !!effect && pending.has(effect);
        if (scope?.warm) {
          scope.lookups += 1;
          scope.skipped += 1;
          if (missing) {
            warmPipelines.add(effect);
            scope.effects.add(effect);
          } else scope.hits += 1;
          return;
        }
        if (scope && missing) {
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
        }
        if (effect) drawnEffects.add(effect);
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
      pending.clear();
      holding = false;
      lags = undefined;
    },
    /** From now on the driver finishes every link but those `lagging` picks, which stay pending until `release`. */
    lagOnly: (lagging: (effect: Effect) => boolean) => {
      lags = lagging;
      for (const effect of [...pending]) if (!lagging(effect)) pending.delete(effect);
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
    /** WebGPU model: Effects whose pipeline a shadow map's draw created synchronously (the shadow pass defers none). */
    synchronous,
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

/** A Class whose prefab template holds a Light component with `properties` (its Light Kind among them). */
const lightClass = (classId: string, properties: Record<string, unknown>): ScriptBundleEntry => ({
  assetGuid: classId, classId, source: "", anchors: [], entryPoints: [],
  components: [{ id: "light", classId: "LightComponent", properties }],
});

/**
 * A Play world: a crate on a floor, a sun, a camera, plus the scenario's own actors. Every actor is posed through
 * the snapshot, as the game worker poses them. `classes` are the session's compiled Classes, whose lights it may spawn.
 */
function playWorld(model: Model, actors: Actor[], materials: string[] = [], subject = "actor-2", classes: ScriptBundleEntry[] = []) {
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
    // As editor Play passes its session's Classes.
    spawnableLights: spawnableLightsFromScripts(classes),
  });
  cleanups.push(() => handle.dispose());
  handle.loadScene(createDefaultScene(), { sceneAssetGuid: "scene" });
  const world: Actor[] = [
    { slotId: 1, guid: "floor", position: [0, 0, 0], scale: [12, 0.2, 12], assign: { meshAssetGuid: null, meshKind: "box" } },
    { slotId: 2, guid: "crate", position: [0, 1, 0], assign: { meshAssetGuid: null, meshKind: "box" } },
    { slotId: 3, guid: "sun", position: [5, 8, -5], rotation: [0.3827, 0, 0, 0.9239], assign: light("directional", { intensity: 1.5 }) },
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
  vi.spyOn(SceneRenderCoordinator.prototype, "render").mockImplementation(function (this: SceneRenderCoordinator, ...args) {
    const result = render.apply(this, args);
    if ((this as unknown as { scene: unknown }).scene === handle.scene)
      views.push({ rendered: result.rendered, reason: result.reason, holding: this.holdingForPipelines, checks: this.strictReadinessChecks });
    return result;
  });
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
  return { engine, handle, driver, holds, world, place, remove, move, frame, views, subjectEffect };
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

  it.each((["sync", "webgpu"] as const).flatMap((model) =>
    (["a torch spawns near the camera", "a torch spawns near the camera into a full Forward budget", "the spot starts casting shadows"] as const)
      .map((cause) => [model, cause] as const)))(
    "a light a Class may spawn compiles nothing at its admission, nor does a rehearsed change: %s, %s", async (model, cause) => {
    // A Class's prefab holds a shadowed spot. The load rehearses one such light spawning, at the camera, so a torch
    // spawned near the camera mid-game finds its receivers' variants and its casters' depth variants compiled and drawn,
    // also where it takes the place of a point the Forward budget then leaves out. The scene holds four lights: the
    // spawned fifth would raise every lit Material's light capacity, so the load compiles for five from the start, and
    // the authored changes it rehearses compile nothing either.
    rehearseLoad = true;
    const torch = { castShadows: true, range: 12, outerAngle: 70, innerAngle: 40 };
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1]), point(11, [1.5, 2.5, -1]), spot(12, [0, 5, 0])], [], "actor-2",
      [lightClass("Torch", { lightKind: "spot", ...torch })]);
    const full = cause === "a torch spawns near the camera into a full Forward budget";
    // Two local lights: the points, nearer the camera than the spot.
    if (full) updateSceneRenderingSettings(world.handle.scene,
      { quality: normalizeRenderingQuality({ lighting: { localLightMode: "manual", maxLocalLights: 2 } }) });
    const lightOf = (slotId: number) => world.handle.scene.lights.find((entry) => entry.name === `${AUTHORED_LIGHT_PREFIX}${slotId}`);
    let before: Effect | null = null;
    let requesters = new Map<Effect, string>();
    const record = await measure(world, () => cause === "the spot starts casting shadows"
      ? world.place(spot(12, [0, 5, 0], { castShadows: true }))
      // Facing the way the camera does, as a torch the player carries.
      : world.place({ slotId: 40, guid: "torch", position: [0.5, 2.5, -9], assign: light("spot", torch) }), () => {
      before = world.subjectEffect();
      requesters = effectRequesters(world);
      if (full) expect([10, 11, 12].map((slotId) => isForwardLightExcluded(lightOf(slotId)!))).toEqual([false, false, true]);
    });
    const rehearsal = world.handle.loadRehearsalStats();
    const map = lightOf(40) ? findSceneShadowController(world.handle.scene)!.generator(lightOf(40)!) : null;
    // The torch actor's own meshes (its invisible origin and light helper, which the camera pass's scene probe prepares
    // with fresh defines) are a spawn of their own: what the load warmed did not have the torch's light.
    const own = (name: string | undefined) => name === "actor-40" || !!name?.startsWith("actor-40|");
    expect({
      rehearsed: rehearsal?.timedOut.length === 0 && rehearsal.omitted.length === 0 && rehearsal.unrestored.length === 0,
      // The change took effect: the subject draws another variant, and a spawned torch is lit (in place of a point when
      // the budget is full) and its map has drawn.
      changed: world.subjectEffect() !== before,
      torch: cause === "the spot starts casting shadows" || (!isForwardLightExcluded(lightOf(40)!) && !!map && !awaitsFirstDraw(map) &&
        (!full || [10, 11].some((slotId) => isForwardLightExcluded(lightOf(slotId)!)))),
      effects: world.driver.created.filter((effect) => !own(requesters.get(effect))).length,
      pipelines: record.pipelines + record.warmPipelines,
      synchronous: world.driver.synchronous.size,
      heldFrames: record.heldFrames, holdRaised: record.holdRaised, paused: record.pausedFrames > 0, recovered: record.recovered,
    }, JSON.stringify({ record, rehearsal })).toEqual({
      rehearsed: true, changed: true, torch: true, effects: 0, pipelines: 0, synchronous: 0, heldFrames: 0, holdRaised: false,
      paused: false, recovered: true,
    });
  });

  /**
   * Each authored light (lit, and whether its shadow map is admitted, with its darkness) and the subject's defines at
   * the first presented frame and 17 frames later, for a load with or without its rehearsal. The frames run on a 16 ms
   * clock once loading has drawn six frames, and in both runs afterwards: a residency the load's own admissions began
   * has not run out by the first presentation, and runs out (250 ms) within the later frames.
   */
  async function presentedAdmission(rehearse: boolean, actors: Actor[], configure?: (world: PlayWorld) => void, classes: ScriptBundleEntry[] = []) {
    // A fresh world per run: the previous one's Engine, clock and render spy go first.
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    if (vi.isMockFunction(SceneRenderCoordinator.prototype.render)) vi.mocked(SceneRenderCoordinator.prototype.render).mockRestore();
    rehearseLoad = rehearse;
    const world = playWorld("sync", actors, [], "actor-2", classes);
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
      [lightClass("Torch", { lightKind: "spot", castShadows: true, range: 12 })]);
    expect({
      steps: spawning.rehearsal!.steps - baseline.rehearsal!.steps, drawn: spawning.rehearsal!.drawn - baseline.rehearsal!.drawn,
      unrestored: spawning.rehearsal!.unrestored,
    }, JSON.stringify(spawning.rehearsal)).toEqual({ steps: 1, drawn: 1, unrestored: [] });
    expect({ first: admission(spawning.first), later: admission(spawning.later) })
      .toEqual({ first: admission(baseline.first), later: admission(baseline.later) });
    expect([capacity(baseline.first.defines), capacity(spawning.first.defines), capacity(spawning.later.defines)]).toEqual(["4", "5", "5"]);
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

  it.each(MODELS)("a spot light starts casting shadows: %s", async (model) => {
    // The floor receives the crate's shadow. The view keeps drawing while the receivers' shadowed variants and the
    // casters' depth variants for the new map compile: the map samples neutrally (lit) until it first draws, which it
    // does once every caster is ready.
    const world = playWorld(model, [spot(10, [0, 5, 0])], [], "actor-1");
    const spotLight = () => world.handle.scene.lights.find((entry) => entry.name === `${AUTHORED_LIGHT_PREFIX}10`)!;
    const map = () => spotLight().getShadowGenerator() as ShadowGenerator | null;
    let neutralWhilePending = true;
    const record = await measure(world, () => world.place(spot(10, [0, 5, 0], { castShadows: true })), undefined, () => {
      const generator = map();
      // Only a pending compile keeps the map from drawing; a synchronous link draws it in the change's frame.
      if (model === "parallel") neutralWhilePending &&= !!generator && awaitsFirstDraw(generator) && generator.getDarkness() === 1;
    });
    const generator = map();
    const shadow = {
      neutralWhilePending,
      drawn: !!generator && !awaitsFirstDraw(generator) && generator.getDarkness() === 0,
      received: /#define SHADOW\d/.test(world.subjectEffect()?.defines ?? ""),
    };
    expect(shadow, JSON.stringify(record)).toEqual({ neutralWhilePending: true, drawn: true, received: true });
    expectSwapped(record, model);
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

