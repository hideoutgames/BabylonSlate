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
  PBRMaterial,
  PointLight,
  Scene,
  StandardMaterial,
  UniversalCamera,
  Vector3,
  type AbstractEngine,
  type Effect,
  type ShadowGenerator,
} from "@babylonjs/core";
import {
  SNAPSHOT_FLAG_VISIBLE,
  snapshotFloatCount,
  writeActorSlot,
  writeSnapshotHeader,
} from "@haptic/bridge";
import { areaRectLightBindings, createDefaultScene } from "@haptic/core";
import { AREA_EMISSION_EDGE, decodeAreaEmission, encodeAreaEmission } from "@haptic/assets";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "./create-engine";
import { effectLightSeats } from "./fixed-light-binding";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { setFixedShapeLightingEnabled, setFixedShapeLightingWorldScene } from "./fixed-light-admission";
import { isAuthoredLightEnabled, isForwardLightExcluded, setAuthoredLightEnabled } from "./light-policy";
import { compileMaterialPlan } from "./material-compiler";
import { AUTHORED_LIGHT_PREFIX } from "./scene-illumination";
import { SceneRenderCoordinator } from "./scene-render-coordinator";
import { existingShadowSamplerPlaceholders } from "./shadow-sampler-placeholders";
import { findSceneShadowController } from "./shadow-controller";
import { awaitsFirstDraw } from "./shadow-first-draw";
import { isRevealPending, onMeshRevealed } from "./reveal-pending";
import { FIRST_DRAWS_PER_FRAME } from "./variant-pipeline-warmup";
import { isSceneGameTimePaused } from "./scene-game-time";
import { enableHeadlessCascades, enableHeadlessCubeTargets } from "./shadow-test-fixtures";
import { mockCubeTextureIO } from "./texture-test-fixtures";
import type { AssignMeshCommand, AssignMeshPart } from "./snapshot-apply";
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
    createLoadRehearsal: vi.fn((scene: Scene) => rehearseLoad ? actual.createLoadRehearsal(scene) : {
      done: true, frame() {}, check() {}, cancel() {},
      report: () => ({ steps: 0, omitted: [], timedOut: [], variants: 0, pipelines: 0, ms: 0 }),
    }),
  };
});
let rehearseLoad = false;
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
});

/** Each Play frame advances the clock this much, so a run of held frames crosses the pause delay deterministically. */
const FRAME_MS = 100;
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

/**
 * A Play world: a crate on a floor, a sun, a camera, plus the scenario's own actors. Every actor is posed through
 * the snapshot, as the game worker poses them.
 */
function playWorld(model: Model, actors: Actor[], materials: string[] = [], subject = "actor-2") {
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
    engine.onEndFrameObservable.notifyObservers(engine);
    const view = views.at(-1);
    const state = { view, holding: view?.holding ?? false, paused: isSceneGameTimePaused(handle.scene), effect: subjectEffect() };
    await vi.advanceTimersByTimeAsync(FRAME_MS);
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

/** The view keeps drawing, raises no hold and pauses nothing; the subject drew its previous Effect while the new one compiled. */
function expectSwapped(record: CauseRecord, model: Model): void {
  const detail = JSON.stringify(record);
  // The cause really compiled a lit variant, so the states below mean something.
  expect(record.litEffects, detail).toBeGreaterThan(0);
  expect({
    heldFrames: record.heldFrames, holdReported: record.holdReported, holdRaised: record.holdRaised,
    paused: record.pausedFrames > 0, recovered: record.recovered,
    // Only a pending compile (or pipeline) leaves a previous Effect drawing; a synchronous link draws the new one at
    // once, unless more new variants arrive together than a frame admits (`FIRST_DRAWS_PER_FRAME`).
    previousEffectDrawn: model === "sync" && record.effects > FIRST_DRAWS_PER_FRAME ? true : record.previousEffectDrawn,
    adopted: record.adopted,
    // One probe per frame while a swap is pending, not one per readiness question.
    probesAtMostOnePerFrame: record.probesPerFrame <= 1,
  }, detail).toEqual({
    heldFrames: 0, holdReported: false, holdRaised: false, paused: false, recovered: true,
    previousEffectDrawn: model !== "sync" || record.effects > FIRST_DRAWS_PER_FRAME, adopted: true, probesAtMostOnePerFrame: true,
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
    const lights = () => world.handle.scene.lights.filter((light) => light.name.startsWith(AUTHORED_LIGHT_PREFIX));
    const shadows = () => findSceneShadowController(world.handle.scene)!;
    let restored: unknown;
    const record = await measure(world, () => cause === "a point switches off"
      ? world.place(point(11, [1.5, 2.5, -1], { enabled: false }))
      : world.place(spot(12, [0, 5, 0], { castShadows: true })), () => {
      // The rehearsal left every light as authored.
      restored = lights().map((light) => [light.name, isAuthoredLightEnabled(light), shadows().requestsShadow(light)]);
    });
    const rehearsal = world.handle.loadRehearsalStats();
    expect({
      rehearsed: (rehearsal?.steps ?? 0) > 0, compiled: (rehearsal?.variants ?? 0) > 0,
      restored: (restored as [string, boolean, boolean][]).every(([, enabled, shadowed]) => enabled && !shadowed),
      effects: record.effects, pipelines: record.pipelines + record.warmPipelines,
      heldFrames: record.heldFrames, holdRaised: record.holdRaised, paused: record.pausedFrames > 0, recovered: record.recovered,
    }, JSON.stringify({ record, rehearsal })).toEqual({
      rehearsed: true, compiled: true, restored: true, effects: 0, pipelines: 0, heldFrames: 0, holdRaised: false, paused: false,
      recovered: true,
    });
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

