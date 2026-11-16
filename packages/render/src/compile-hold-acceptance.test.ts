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
 *
 * It records counts and states only, never timings: Effects compiled, frames
 * the world view held its image, whether the hold signal and the game-time
 * pause were raised, and which Effect the changed mesh drew.
 * Time is Vitest's fake clock, advanced a fixed step
 * per frame, so graph preparation's polls run deterministically.
 *
 * A change to an existing Material's variant keeps drawing its previous Effect
 * while the new one compiles: no held frame, no hold signal, no pause. A new
 * shadow map draws once its casters are ready, and a spawned mesh with nothing
 * to draw is hidden until every variant it draws with is ready.
 */
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { NullEngine, NullEngineOptions } from "@babylonjs/core/Engines/nullEngine";
import { Material } from "@babylonjs/core/Materials/material";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Scene } from "@babylonjs/core/scene";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Effect } from "@babylonjs/core/Materials/effect";
import {
  SNAPSHOT_FLAG_VISIBLE,
  snapshotFloatCount,
  writeActorSlot,
  writeSnapshotHeader,
  type ScriptBundleEntry,
} from "@haptic/bridge";
import {
  areaRectLightBindings, createDefaultScene, type AntiAliasingMode, normalizeRenderingQuality,
  normalizeRenderProjectSettings, parseText2DProperties, parseText3DProperties,
} from "@haptic/core";
import { AREA_EMISSION_EDGE, decodeAreaEmission, encodeAreaEmission } from "@haptic/assets";
import { createDefaultMaterialDocument, lowerMaterialDocument, type MaterialDocument } from "@haptic/shader-graph";
import { instanceParameterOf } from "./instance-parameters";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rectLightEmission } from "./area-emission-array";
import { createEngine } from "./create-engine";
import { markSceneReadinessDirty } from "./scene-readiness-signal";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { isForwardLightExcluded, setAuthoredLightEnabled } from "./light-policy";
import { HAPTIC_LIGHT_MAXIMUM, hapticLightBuffer } from "./haptic-lights";
import { compileMaterialPlan } from "./material-compiler";
import { sceneMultisampleCount, sceneRenderingSettings, updateSceneRenderingSettings } from "./render-settings";
import { AUTHORED_LIGHT_PREFIX } from "./scene-illumination";
import { SceneRenderCoordinator } from "./scene-render-coordinator";
import { isAtlasShadow } from "./shadow-atlas";
import { findSceneShadowController } from "./shadow-controller";
import { awaitsFirstDraw } from "./shadow-first-draw";
import { sceneInstancePool } from "./instance-pool";
import { drawingMesh } from "./instance-source";
import { POOLED_LEAF_SUFFIX } from "./pooled-primitive-visual";
import { pooledLeafOf } from "./pooled-visuals";
import { isRevealPending, onMeshRevealed } from "./reveal-pending";
import { FIRST_DRAWS_PER_FRAME } from "./variant-first-draws";
import { isSceneGameTimePaused } from "./scene-game-time";
import { enableHeadlessCascades, enableHeadlessCubeTargets } from "./shadow-test-fixtures";
import { encodeAnimatedLimbGlb, encodeTriangleGlb, encodeUvSphereGlb } from "./glb-test-fixtures";
import { mockCubeTextureIO } from "./texture-test-fixtures";
import type { AssignMeshCommand, AssignMeshPart } from "./snapshot-apply";
import { spawnableLightsOfLoad, type SpawnableLightLoad } from "./spawnable-lights";
import { setSceneBindsPreviousEffects } from "./variant-swaps";
import { setUnlitMaterial, type UnlitBinding, type UnlitMaterialKey } from "./unlit-material";

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

type Model = "sync" | "parallel";
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
  drawStartingState = false;
  frameMs = FRAME_MS;
});

/** Each Play frame advances the clock this much, so a run of held frames crosses the pause delay deterministically. */
const FRAME_MS = 100;
/** The clock step of the next Play frames (a case with a realistic frame clock sets 16 ms). */
let frameMs = FRAME_MS;
/** Frames a pending compile stays pending before the driver releases it (600 ms). */
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
 * every new Effect, and until `release` `parallel` keeps each new Effect pending; after `release` new ones complete at
 * once again.
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
    // A link the driver has not finished: Babylon and the app's waits read it through isReady().
    const isReady = effect.isReady.bind(effect);
    effect.isReady = () => !pending.has(effect) && isReady();
    return effect;
  }) as unknown as typeof engine.createEffect);
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
 * pooling on (`sceneInstancing`). Off by default; CI runs the file again with it on (`HAPTIC_GATE_INSTANCING=1`).
 */
const INSTANCING_BY_DEFAULT = process.env.HAPTIC_GATE_INSTANCING === "1";

/** The mesh whose render observables fire for actor `name`'s drawn surface: its own, or a pooled leaf's source's batch. */
function surfaceDraws(scene: Scene, name: string): Mesh {
  const leaf = scene.getMeshByName(`${name}${POOLED_LEAF_SUFFIX}`);
  return (leaf ? drawingMesh(leaf) : scene.getMeshByName(name)) as Mesh;
}

function playWorld(
  model: Model, actors: Actor[], materials: string[] = [], subject = "actor-2", load = classesLoad([]),
  { instancing = INSTANCING_BY_DEFAULT, documents }: { instancing?: boolean; documents?: ReadonlyMap<string, MaterialDocument> } = {},
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
    onCompileHold: (held) => holds.push(held),
    materialDocuments: new Map(materials.map((guid) => [guid, documents?.get(guid) ?? createDefaultMaterialDocument(guid)])),
    // As editor Play passes its startup sources'.
    spawnableLights: spawnableLightsOfLoad(load),
  });
  cleanups.push(() => handle.dispose());
  handle.loadScene(createDefaultScene(), { sceneAssetGuid: "scene" });
  const world: Actor[] = [
    { slotId: 1, guid: "floor", position: [0, 0, 0], scale: [12, 0.2, 12], assign: { meshAssetGuid: null, meshKind: "box" } },
    { slotId: 2, guid: "crate", position: [0, 1, 0], assign: { meshAssetGuid: null, meshKind: "box" } },
    sun(),
    { slotId: 4, guid: "camera", position: [0, 3, -10], assign: { meshAssetGuid: null, meshKind: null, parts: [part("lens", "camera", { camera: { fieldOfView: 60 } })] } },
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
  // The runtime possesses the Scene's Default Camera when it starts.
  handle.applyCommand({ type: "possessCamera", slotId: 4 });
  place(...actors);

  // The world view's frames, as the render loop drives them.
  const views: Array<{ rendered: boolean; reason?: string; holding: boolean; checks: number }> = [];
  const render = SceneRenderCoordinator.prototype.render;
  const renders = vi.spyOn(SceneRenderCoordinator.prototype, "render").mockImplementation(function (this: SceneRenderCoordinator, ...args) {
    const result = render.apply(this, args);
    if ((this as unknown as { scene: unknown }).scene === handle.scene)
      views.push({ rendered: result.rendered, reason: result.reason, holding: this.holdingForCompiles, checks: this.strictReadinessChecks });
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
  /** Frames, while the compile was pending, in which the world view held its last image. */
  heldFrames: number;
  /** Frames in that window in which the world view drew. */
  drawnFrames: number;
  /** The view reported holding for compiles (`holdingForCompiles`). */
  holdReported: boolean;
  /** Play raised its rendering hold (`onCompileHold(true)`). */
  holdRaised: boolean;
  /** Frames in which Play's game time was paused. */
  pausedFrames: number;
  /** Full readiness probes per frame while the cause's compiles were pending, after the cause's own frame (each walks every mesh). */
  probesPerFrame: number;
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
 * Applies `cause` to a settled view, keeps the new compiles pending for `PENDING_FRAMES` frames,
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

const MODELS: readonly Model[] = ["sync", "parallel"];

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
  // Only a pending compile leaves a previous Effect drawing; a synchronous link draws the new one at once.
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

/** The names of the meshes drawn (`Mesh.render`) since the set was last cleared. */
function spawnDraws(): Set<string> {
  const drawn = new Set<string>();
  const render = Mesh.prototype.render;
  vi.spyOn(Mesh.prototype, "render").mockImplementation(function (this: Mesh, ...args) {
    drawn.add(this.name);
    // A batch draws its visible instances: a pooled visual's leaf, named for its slot root, under that root.
    const subMesh = args[0];
    for (const instance of this._getInstancesRenderList(subMesh._id).visibleInstances[subMesh._id] ?? []) {
      drawn.add(instance.name);
      if (instance.parent) drawn.add(instance.parent.name);
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
      before, after: rectLightEmission(panel()) !== undefined, effects: record.effects,
      heldFrames: record.heldFrames, holdRaised: record.holdRaised, paused: record.pausedFrames > 0, recovered: record.recovered,
    }, JSON.stringify(record)).toEqual({
      before: false, after: true, effects: 0, heldFrames: 0, holdRaised: false, paused: false, recovered: true,
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

  it.each((["sync"] as const).flatMap((model) => SPAWN_CASES.map(([cause, spec]) => [model, cause, spec] as const)))(
    "a light Play may spawn compiles nothing at its admission, nor does an authored shadow start: %s, %s", async (model, _, spec) => {
    // A Class's prefab holds a shadowed spot, or a Spawn Actor names a Class the load cannot see. A light spawned
    // mid-game near the camera or near the casters, also where it takes the place of a point the Local Light Budget then
    // leaves out, asks its receivers for no new variant (the block reads lights as data), and its map's casters find
    // their depth variants compiled at load (`warmCasterVariants`).
    drawStartingState = true;
    const lights = spec.lights?.() ?? [point(10, [-1.5, 2.5, -1]), point(11, [1.5, 2.5, -1]), spot(12, [0, 5, 0])];
    const world = playWorld(model, lights, [], "actor-2", spec.load());
    if (spec.full) updateSceneRenderingSettings(world.handle.scene,
      { quality: normalizeRenderingQuality({ lighting: { localLightMode: "manual", maxLocalLights: 2 } }) });
    if (spec.camera) {
      // The possessed camera, looking at the origin from the case's viewpoint; unchanged actor poses leave it there.
      const camera = world.handle.scene.activeCamera as UniversalCamera;
      camera.position.copyFrom(spec.camera);
      camera.setTarget(Vector3.Zero());
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
      heldFrames: record.heldFrames, holdRaised: record.holdRaised, paused: record.pausedFrames > 0, recovered: record.recovered,
    }, JSON.stringify({ record })).toEqual({
      kept: true, spawned: true, effects: 0, heldFrames: 0, holdRaised: false,
      paused: false, recovered: true,
    });
  });

  it("a Play load counts its shader warm-up units, then the programs its graph's passes compile", async () => {
    const world = playWorld("sync", [point(10, [-1.5, 2.5, -1]), point(11, [1.5, 2.5, -1]), spot(12, [0, 5, 0])]);
    const shaders: string[] = [];
    await withClock(world.handle.prewarmSceneMaterials(undefined, ({ done, total }) => shaders.push(`${done}/${total}`)));
    const counts = shaders.map((entry) => entry.split("/").map(Number) as [number, number]);
    const warmed = counts[0]![1];
    const [, total] = counts.at(-1)!;
    expect({
      from: shaders[0], to: shaders.at(-1),
      neverBack: counts.every(([done, of], index) => index === 0 || (done >= counts[index - 1]![0] && of >= counts[index - 1]![1])),
    }).toEqual({ from: `0/${warmed}`, to: `${total}/${total}`, neverBack: true });
    expect(warmed).toBeGreaterThan(0);
    // Shadow depth and the other passes' programs, which no warm-up unit counts, compile after the warm-up: the count
    // goes on through them instead of showing a finished warm-up meanwhile.
    expect(total).toBeGreaterThan(warmed);
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
    // Two frames with the links pending (a parallel driver), then they all finish at once.
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
    // (`warmCasterVariants`), so the map draws in the change's frame.
    const start = shadowStarts[kind];
    const world = playWorld(model, [...start.actors], [], "actor-1");
    const shadowLight = () => world.handle.scene.lights.find((entry) => entry.name === `${AUTHORED_LIGHT_PREFIX}${start.slotId}`)!;
    const map = () => shadowLight().getShadowGenerator() as ShadowGenerator | null;
    let before: Effect | null = null;
    const record = await measure(world, () => world.place(start.cast()), () => { before = world.subjectEffect(); });
    const generator = map();
    expect({
      atlas: isAtlasShadow(generator),
      passes: (generator?.getShadowMap()?.renderPassIds.length ?? 0) > 1,
      drawn: !!generator && !awaitsFirstDraw(generator) && generator.getDarkness() === 0,
      kept: world.subjectEffect() === before,
      effects: record.effects, heldFrames: record.heldFrames, holdRaised: record.holdRaised, paused: record.pausedFrames > 0,
      recovered: record.recovered,
    }, JSON.stringify(record)).toEqual({
      atlas: true, passes: start.passes, drawn: true, kept: true,
      effects: 0, heldFrames: 0, holdRaised: false, paused: false, recovered: true,
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
    }, JSON.stringify(record)).toEqual({ effects: 0, heldFrames: 0, paused: false, shown: true, warmed: 1 });
  });

  // A program's first draw holds iPad WebKit, so the load draws what it compiled behind its loading screen.
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
    }, JSON.stringify(record)).toEqual({ effects: 0, heldFrames: 0, paused: false, shown: true });
  });

  it.each(["sync", "parallel"] as const)("two actors a Spawn Actor preparation compiled, spawned in one frame, first draw in frames of their own: %s", async (model) => {
    // The preparation compiles their Materials without drawing them, so their programs' first uses (the iPad
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
      // Only a pending compile leaves the mesh without a variant; a synchronous link draws it in its first frame.
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
    }, JSON.stringify(record)).toEqual({
      compiled: true, heldFrames: 0, holdReported: false, holdRaised: false, paused: false, recovered: true,
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
      // Only a pending compile keeps the lid from its first frame; a synchronous link reveals both at once.
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
      holdRaised: record.holdRaised,
    }, JSON.stringify({ record, revealed })).toEqual({
      hiddenWhilePending: true, revealed: names, together: true, shown: [true, true], holdRaised: false,
      materials: [expect.stringContaining("surface-a"), expect.stringContaining("surface-b")],
    });
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
  const view = new SceneRenderCoordinator(scene, { compileHolds: true });
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
 * an actor the level holds, compile no shader. A merge gate: CI's unit job runs it.
 */
/** Where Play pools primitives: every driver model, given hardware instancing (`sceneInstancing`). */
const POOLED_MODELS: readonly Model[] = MODELS;

describe("pooled primitives", () => {
  const box = (slotId: number, position: Vec3): Actor =>
    ({ slotId, guid: `box-${slotId}`, position, assign: { meshAssetGuid: null, meshKind: "box" } });
  /** What a cause compiled and held, with the pool's groups and members after it. */
  const expectNothingCompiled = (record: CauseRecord) => expect({
    effects: record.effects,
    heldFrames: record.heldFrames, holdRaised: record.holdRaised, recovered: record.recovered,
  }, JSON.stringify(record)).toEqual({ effects: 0, heldFrames: 0, holdRaised: false, recovered: true });

  it.each(POOLED_MODELS)("twenty boxes spawned into the load's drawn group compile nothing: %s", async (model) => {
    // The floor and crate are boxes of the engine default Material: one group, its instanced variants drawn by the load.
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1])], [], "actor-2", classesLoad([]), { instancing: true });
    const pool = sceneInstancePool(world.handle.scene);
    const record = await measure(world, () => world.place(...Array.from({ length: 20 }, (_, index) =>
      box(30 + index, [-4 + (index % 5) * 2, 1, -2 + Math.floor(index / 5) * 1.5]))));
    expectNothingCompiled(record);
    expect(pool.diagnostics()).toMatchObject({ groups: 1, pooled: 22 });
  });

  it.each(POOLED_MODELS)("a box whose Material changes to one another group draws compiles nothing: %s", async (model) => {
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1]), box(20, [2, 1, 1])], ["surface-a"], "actor-2", classesLoad([]),
      { instancing: true });
    world.handle.applyCommand({ type: "assignMaterial", slotId: 20, materialAssetGuid: "surface-a" });
    const record = await measure(world, () => world.handle.applyCommand({ type: "assignMaterial", slotId: 2, materialAssetGuid: "surface-a" }));
    expectNothingCompiled(record);
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
    expectNothingCompiled(record);
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

  it.each(POOLED_MODELS)("a script's write of a per-instance Tint keeps the actor in its group and compiles nothing: %s", async (model) => {
    // A Material whose base colour is the Color parameter Tint, marked Per Instance.
    const tinted = createDefaultMaterialDocument("tinted");
    const tint = tinted.nodes.find((node) => node.id === "baseColor")!;
    tint.type = "param.color";
    tint.properties = { name: "Tint", value: [0.8, 0.8, 0.8, 1], perInstance: true };
    tinted.edges.find((edge) => edge.sourceNodeId === "baseColor")!.sourcePinId = "rgb";
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1]), box(20, [2, 1, 1])], ["tinted"], "actor-2", classesLoad([]),
      { instancing: true, documents: new Map([["tinted", tinted]]) });
    for (const slotId of [2, 20]) world.handle.applyCommand({ type: "assignMaterial", slotId, materialAssetGuid: "tinted" });
    const leaf = (name: string) => pooledLeafOf(world.handle.scene.getMeshByName(name)!)!;
    const record = await measure(world, () => world.handle.applyCommand({
      type: "setMaterialParameter", slotId: 20, componentId: null, materialAssetGuid: "tinted", parameterName: "Tint",
      parameter: { kind: "color", value: [1, 0, 0, 1] },
    }));
    expectNothingCompiled(record);
    const attribute = instanceParameterOf(leaf("actor-20").material!, "Tint")!.attribute;
    expect({
      shared: leaf("actor-20").sourceMesh === leaf("actor-2").sourceMesh,
      own: (leaf("actor-20").instancedBuffers[attribute] as Color4).equalsWithEpsilon(new Color4(1, 0, 0, 1).toLinearSpace()),
      theirs: (leaf("actor-2").instancedBuffers[attribute] as Color4).equalsWithEpsilon(new Color4(0.8, 0.8, 0.8, 1).toLinearSpace()),
    }).toEqual({ shared: true, own: true, theirs: true });
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
    expectNothingCompiled(record);
    expect(pool.diagnostics()).toMatchObject({ groups: 2, retained: 0 });
  });
  it.each(POOLED_MODELS)("a pooled dense model moving away draws its source's coarser level and compiles nothing: %s", async (model) => {
    // A sphere dense enough for Auto LOD: its group's source carries the levels (`attachModelLods`).
    const statue = (slotId: number, position: Vec3): Actor =>
      ({ slotId, guid: `statue-${slotId}`, position, assign: { meshAssetGuid: "sphere", meshKind: null } });
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1])], [], "actor-2", classesLoad([]), { instancing: true });
    world.handle.setMeshAssets({ modelBytes: new Map([["sphere", encodeUvSphereGlb()]]) });
    // One near and one far, so the source's levels have drawn before the near one moves away.
    world.place(statue(20, [2, 1, 1]), statue(21, [0, 1, 160]));
    await settle(world);
    const member = () => world.handle.scene.getMeshByName("actor-20")!.getChildMeshes(false)
      .find((mesh): mesh is InstancedMesh => mesh instanceof InstancedMesh && mesh.isVisible)!;
    // Levels arrive after the instance publishes (simplified off the frame), then draw for the far one.
    for (let frame = 0; frame < 120 && !member().sourceMesh.hasLODLevels; frame++) await world.frame();
    for (let frame = 0; frame < 4; frame++) await world.frame();
    const levels = member().sourceMesh.getLODLevels().map((level) => level.mesh);
    const record = await measure(world, () => world.move(20, [0, 1, 160]));
    expectNothingCompiled(record);
    expect({ levels: levels.length > 0, coarser: levels.includes((member() as unknown as { _currentLOD: Mesh })._currentLOD) })
      .toEqual({ levels: true, coarser: true });
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
    expectNothingCompiled(record);
    const leaves = ["actor-20", "actor-21"].map((name) => world.handle.scene.getMeshByName(name)!.getChildMeshes(false)
      .find((mesh): mesh is InstancedMesh => mesh instanceof InstancedMesh && mesh.isVisible));
    expect({ joined: pool.diagnostics().pooled - pooled, shared: !!leaves[0] && leaves[0].sourceMesh === leaves[1]?.sourceMesh })
      .toEqual({ joined: 1, shared: true });
  });

  it.each(POOLED_MODELS)("a second instance of a node-animated model spawned after the first drew compiles nothing, its clip moving its members: %s", async (model) => {
    // A rig of rigid meshes (a mannequin's): each mesh draws as a member, the instance's own clip channels moving it.
    const rig = (slotId: number, position: Vec3): Actor =>
      ({ slotId, guid: `rig-${slotId}`, position, assign: { meshAssetGuid: "rig", meshKind: null } });
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1])], [], "actor-2", classesLoad([]), { instancing: true });
    world.handle.setMeshAssets({ modelBytes: new Map([["rig", encodeAnimatedLimbGlb()]]) });
    world.place(rig(20, [2, 1, 1]));
    await settle(world);
    const pool = sceneInstancePool(world.handle.scene);
    const pooled = pool.diagnostics().pooled;
    const record = await measure(world, () => world.place(rig(21, [-2, 1, 1])));
    expectNothingCompiled(record);
    const members = (name: string) => world.handle.scene.getMeshByName(name)!.getChildMeshes(false)
      .filter((mesh): mesh is InstancedMesh => mesh instanceof InstancedMesh);
    const [first, second] = [members("actor-20"), members("actor-21")];
    const targets = world.handle.scene.animationGroups.flatMap((group) => group.targetedAnimations.map((channel) => channel.target));
    expect({
      joined: pool.diagnostics().pooled - pooled,
      names: second.map((member) => member.name),
      shared: second.map((member, index) => member.sourceMesh === first[index]?.sourceMesh),
      carried: second[1]?.parent === second[0],
      animated: targets.includes(second[0]),
    }).toEqual({ joined: 2, names: ["body", "arm"], shared: [true, true], carried: true, animated: true });
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
  /** The script's steps that change what lights a receiver and what shadows it: an occluded crate's variants. */
  const RECEIVER_STEPS: ReadonlySet<string> = new Set([
    "a point light switches off", "it switches back on", "a point light spawns", "a spot light spawns",
    "the sun starts casting shadows", "a spot light starts casting shadows", "a point light starts casting shadows",
    "a light stops casting shadows", "it starts again", "a light is removed", "more point lights spawn than the block draws",
  ]);
  /** Plays the light script (only the steps `only` names, when given), four frames per step. */
  const play = async (world: PlayWorld, { painter, sprite }: { painter: Mesh; sprite: Mesh }, only?: ReadonlySet<string>) => {
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
      if (only && !only.has(name)) continue;
      const before = world.driver.created.length;
      step();
      for (let index = 0; index < 4; index++) await world.frame();
      compiled[name] = world.driver.created.length - before;
    }
    return compiled;
  };

  it.each(MODELS)("lights change mid-game without compiling a shader: %s", async (model) => {
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
      compiled, lightDefines: lightDefines.length,
      counts, atlas,
    }).toEqual({
      compiled: Object.fromEntries(Object.keys(compiled).map((name) => [name, 0])), lightDefines: 0,
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
    // The march runs under a shadowed sun only.
    world.place(sun({ castShadows: true }));
    const surfaces = unlitSurfaces(world);
    await settle(world);
    const tasks = world.handle.renderTaskNames();
    const screenEffects = () => Object.values(compiledEffects(world.engine)).filter((effect) => /^#define HAPTIC_SCREEN_SHADOWS$/m.test(effect.defines));
    const before = screenEffects();
    world.driver.arm();
    const builds = vi.spyOn(FrameGraph.prototype, "buildAsync");
    const compiled = await play(world, surfaces);
    expect({
      compiled, builds: builds.mock.calls.length,
      marched: tasks.slice(tasks.indexOf("Spatial Geometry"), tasks.indexOf("Forward objects") + 1), tasks: world.handle.renderTaskNames(),
      reading: before.length > 0, sameReaders: screenEffects(),
    }).toEqual({
      compiled: Object.fromEntries(Object.keys(compiled).map((name) => [name, 0])), builds: 0,
      marched: ["Spatial Geometry", "Screen shadows", "Forward objects"], tasks, reading: true, sameReaders: before,
    });
  });

  it.each(MODELS)("a Screen-Space Shadows level change rebuilds nothing and the march reads the new level: %s", async (model) => {
    const world = playWorld(model, actors());
    Object.assign(world.engine.getCaps(), { texelFetch: true });
    const screenShadows = (level: "low" | "high") =>
      world.handle.setRenderSettings(normalizeRenderProjectSettings({ shadows: { screenShadows: level } }));
    screenShadows("high");
    // The march runs under a shadowed sun only.
    world.place(sun({ castShadows: true }));
    await settle(world);
    const tasks = world.handle.renderTaskNames();
    const builds = vi.spyOn(FrameGraph.prototype, "buildAsync");
    const uniforms = vi.spyOn(Effect.prototype, "setFloat4");
    // Steps, pixel cap and world cap of the frame's last march.
    const march = () => uniforms.mock.calls.filter(([name]) => name === "ssMarch").at(-1)?.slice(1, 4);
    await world.frame();
    expect(march()).toEqual([16, 64, 0.8]);
    screenShadows("low");
    const frames: boolean[] = [];
    for (let index = 0; index < 3; index++) frames.push((await world.frame()).view?.rendered === true);
    expect({ march: march(), frames, builds: builds.mock.calls.length, tasks: world.handle.renderTaskNames() })
      .toEqual({ march: [6, 30, 0.35], frames: [true, true, true], builds: 0, tasks });
  });

  it.each(MODELS)("turning Screen-Space Shadows off links no lit program again, and its draws stop reading them: %s", async (model) => {
    const world = playWorld(model, actors());
    Object.assign(world.engine.getCaps(), { texelFetch: true });
    const screenShadows = (level: "off" | "high") =>
      world.handle.setRenderSettings(normalizeRenderProjectSettings({ shadows: { screenShadows: level } }));
    screenShadows("high");
    // The march runs under a shadowed sun only.
    world.place(sun({ castShadows: true }));
    await settle(world);
    const readers = () => Object.values(compiledEffects(world.engine)).filter((effect) => /^#define HAPTIC_SCREEN_SHADOWS$/m.test(effect.defines));
    // A program's shaders, without its defines: another variant of a reader's shaders is a lit program linked again.
    const shaders = (effect: Effect) => effect._key.slice(0, effect._key.indexOf("@"));
    const variants = (of: readonly Effect[]) => {
      const names = new Set(of.map(shaders));
      return Object.values(compiledEffects(world.engine)).filter((effect) => names.has(shaders(effect))).length;
    };
    const before = readers();
    const variantsBefore = variants(before);
    const uniforms = vi.spyOn(Effect.prototype, "setFloat4");
    const reads = () => uniforms.mock.calls.filter(([name]) => name === "hapticScreenShadowTerms").map(([, on]) => on);
    await world.frame();
    expect(reads()).toContain(1);
    screenShadows("off");
    // The graph is built again without the march; the view draws again within a few frames.
    let rendered = false;
    for (let index = 0; index < 40 && !rendered; index++) rendered = (await world.frame()).view?.rendered === true;
    uniforms.mockClear();
    rendered = (await world.frame()).view?.rendered === true;
    expect({ rendered, readers: readers(), variants: variants(before), reading: before.length > 0, marching: world.handle.renderTaskNames().includes("Screen shadows"), reads: [...new Set(reads())] })
      .toEqual({ rendered: true, readers: before, variants: variantsBefore, reading: true, marching: false, reads: [0] });
  });

  // The geometry pass idles with the march: meshes it has not drawn may compile their geometry variant when it resumes,
  // which the view's readiness holds as for a graph change (the driver finishes it here).
  it.each(MODELS)("Screen-Space Shadows idle while the sun casts none, its draws reading none, and march once it casts, without a build: %s", async (model) => {
    const world = playWorld(model, actors());
    Object.assign(world.engine.getCaps(), { texelFetch: true });
    world.handle.setRenderSettings(normalizeRenderProjectSettings({ shadows: { screenShadows: "high" } }));
    world.place(sun({ castShadows: false }));
    await settle(world);
    const tasks = world.handle.renderTaskNames();
    world.driver.arm();
    const builds = vi.spyOn(FrameGraph.prototype, "buildAsync");
    const uniforms = vi.spyOn(Effect.prototype, "setFloat4");
    /** The frame's lit draws' screen-shadow reads, and how many marches it bound. */
    const frame = async () => {
      uniforms.mockClear();
      await world.frame();
      const calls = uniforms.mock.calls;
      return { reads: [...new Set(calls.filter(([name]) => name === "hapticScreenShadowTerms").map(([, on]) => on))],
        marches: calls.filter(([name]) => name === "ssMarch").length };
    };
    expect(await frame()).toEqual({ reads: [0], marches: 0 });
    world.place(sun({ castShadows: true }));
    world.driver.release();
    let marching = { reads: [0], marches: 0 };
    for (let index = 0; index < 8 && marching.marches === 0; index++) marching = await frame();
    // Other passes (shadow maps, probes) bind the placeholder with the read off; the objects read the march.
    expect({ marches: marching.marches, reads: marching.reads.includes(1), builds: builds.mock.calls.length, tasks: world.handle.renderTaskNames() })
      .toEqual({ marches: 1, reads: true, builds: 0, tasks });
  });

  /** The world view's Anti-Aliasing, on a device that multisamples at up to 4. */
  function withAntiAliasing(world: PlayWorld, antiAliasing: AntiAliasingMode) {
    Object.assign(world.engine.getCaps(), { maxMSAASamples: 4 });
    world.handle.setRenderSettings(normalizeRenderProjectSettings({ quality: { postprocessing: { antiAliasing } } }));
  }

  it.each(MODELS)("with MSAA 4x, lights change without compiling or rebuilding the view: %s", async (model) => {
    const world = playWorld(model, actors());
    withAntiAliasing(world, "msaa4");
    const surfaces = unlitSurfaces(world);
    await settle(world);
    const multisampled = sceneMultisampleCount(world.handle.scene);
    world.driver.arm();
    const builds = vi.spyOn(FrameGraph.prototype, "buildAsync");
    const compiled = await play(world, surfaces);
    expect({
      multisampled, compiled, builds: builds.mock.calls.length,
    }).toEqual({
      multisampled: 4, compiled: Object.fromEntries(Object.keys(compiled).map((name) => [name, 0])), builds: 0,
    });
  });

  it.each(MODELS)("an Anti-Aliasing change mid-game compiles no Material and holds as a quality change does: %s", async (model) => {
    // The sample count changes no Material's Effect: the rebuilt graph draws with the same programs, compiling only the
    // graph's own full-screen passes (its output copy). As for any quality change, the view keeps its last image until
    // the rebuilt graph has drawn a complete frame.
    const world = playWorld(model, []);
    withAntiAliasing(world, "off");
    const record = await measure(world, () => withAntiAliasing(world, "msaa4"));
    const materials = (effects: Iterable<Effect>) => [...effects].filter((effect) => (effect.name as { vertex?: string }).vertex !== "postprocess").length;
    // The Effects the floor and the crate draw with (one when pooled into groups of one Effect).
    const pass = world.engine.getRenderPassNames().lastIndexOf("Forward objects#0");
    const surfaceEffects = new Set(["actor-1", "actor-2"].map((name) => surfaceDraws(world.handle.scene, name).subMeshes[0]?._getDrawWrapper(pass)?.effect));
    expect({
      multisampled: sceneMultisampleCount(world.handle.scene), surfacesDrawn: [...surfaceEffects].every(Boolean), materialCompiles: materials(world.driver.created),
      held: record.heldFrames > 0,
      holdReported: record.holdReported, recovered: record.recovered, paused: record.pausedFrames,
    }, JSON.stringify(record)).toEqual({
      multisampled: 4, surfacesDrawn: true, materialCompiles: 0,
      held: true,
      holdReported: false, recovered: true, paused: 0,
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
    // The receiver's steps alone: what the hidden crate's variants depend on (the full script is the case above).
    const compiled = await play(world, surfaces, RECEIVER_STEPS);
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
      compiled,
      // Occlusion left Babylon's own state alone.
      crateShown: crate.isEnabled() && crate.isVisible, hidden: hidden > 0,
      reappeared: world.driver.created.length - before, culledAfter: world.view().occlusionDiagnostics()!.culled, debug,
    }).toEqual({
      compiled: Object.fromEntries(Object.keys(compiled).map((name) => [name, 0])),
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
    // Its two new variants (colour and depth pre-pass) take a frame each of the first-draw budget.
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
   * With the view settled and the driver armed (a new compile stays pending), each of six frames first
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
    // hides until they are known ready.
    const { world, rows } = await resend(model, () => VISUALS[name]!);
    expect({ rows, holdRaised: world.holds.includes(true) }).toEqual({
      rows: rowsOf({ kept: true, drawn: true, hidden: false, held: false }), holdRaised: false,
    });
  });

  it.each(MODELS)("a Text3D whose text changes every tick draws each new mesh in the frame it arrives: %s", async (model) => {
    // A real change rebuilds the mesh. Its variant is the previous mesh's, so it is revealed in its first frame: nothing
    // compiles or waits.
    const { world, rows } = await resend(model, (frame) => text3d(`Score ${frame + 1}`));
    const { created } = world.driver;
    expect({ rows, compiled: created.length }).toEqual({
      rows: rowsOf({ kept: false, drawn: true, hidden: false, held: false }), compiled: 0,
    });
  });
});

