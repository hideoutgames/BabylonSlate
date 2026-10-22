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
 *   pipeline, which stays pending until `release` (`beginPipelineDeferral` is
 *   replaced by a model: NullEngine is not WebGPU).
 *
 * It records counts and states only, never timings: Effects compiled, frames
 * the world view held its image, whether the hold signal and the game-time
 * pause were raised, which Effect the changed mesh drew, and pipelines the
 * WebGPU model waited for. Time is Vitest's fake clock, advanced a fixed step
 * per frame, so graph preparation's polls run deterministically.
 *
 * A change to an existing Material's variant keeps drawing its previous Effect
 * while the new one compiles: no held frame, no hold signal, no pause. Causes
 * that still hold (a new shadow map's casters and graph preparation, a spawned
 * Material, any WebGPU pipeline) assert only that the view recovers; their holds
 * are in the failure message.
 */
import { NullEngine, NullEngineOptions, type AbstractEngine, type Effect } from "@babylonjs/core";
import {
  SNAPSHOT_FLAG_VISIBLE,
  snapshotFloatCount,
  writeActorSlot,
  writeSnapshotHeader,
} from "@babylonslate/bridge";
import { areaRectLightBindings, createDefaultScene } from "@babylonslate/core";
import { AREA_EMISSION_EDGE, decodeAreaEmission, encodeAreaEmission } from "@babylonslate/assets";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "./create-engine";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { isForwardLightExcluded } from "./light-policy";
import { AUTHORED_LIGHT_PREFIX } from "./scene-illumination";
import { SceneRenderCoordinator } from "./scene-render-coordinator";
import { isSceneGameTimePaused } from "./scene-game-time";
import { enableHeadlessCascades } from "./shadow-test-fixtures";
import { mockCubeTextureIO } from "./texture-test-fixtures";
import type { AssignMeshCommand, AssignMeshPart } from "./snapshot-apply";
import { beginPipelineDeferral } from "./webgpu-pipeline-deferral";

// NullEngine is not WebGPU, so the real deferral never engages; the `webgpu` model replaces it.
vi.mock("./webgpu-pipeline-deferral", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./webgpu-pipeline-deferral")>();
  return { ...actual, beginPipelineDeferral: vi.fn(actual.beginPipelineDeferral) };
});
const { beginPipelineDeferral: actualBeginPipelineDeferral } =
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
  if (model === "parallel") engine.getCaps().parallelShaderCompile = { COMPLETION_STATUS_KHR: 0x91b1 };
  const create = engine.createEffect.bind(engine) as (...args: unknown[]) => Effect;
  vi.spyOn(engine, "createEffect").mockImplementation(((...args: unknown[]) => {
    const effect = create(...args);
    if (!armed || known.has(effect)) return effect;
    known.add(effect);
    created.push(effect);
    if (model === "sync" || !holding) return effect;
    pending.add(effect);
    if (model === "parallel") {
      // A link the driver has not finished: Babylon and the app's waits read it through isReady().
      const isReady = effect.isReady.bind(effect);
      effect.isReady = () => !pending.has(effect) && isReady();
    }
    return effect;
  }) as unknown as typeof engine.createEffect);

  // The WebGPU model: a view's scope skips each draw whose Effect's pipeline is still pending, as the real deferral does.
  const pipelines = new Set<Effect>();
  type Scope = { allows: (pass: number) => boolean; skipped: number; effects: Set<Effect> };
  const scopes: Scope[] = [];
  if (model === "webgpu") {
    vi.mocked(beginPipelineDeferral).mockImplementation((_engine, allows, options = {}) => {
      if (options.nested && !scopes.length) return undefined;
      const scope: Scope = { allows, skipped: 0, effects: new Set() };
      scopes.push(scope);
      let closed = false;
      return {
        close: () => {
          if (!closed) {
            closed = true;
            const index = scopes.lastIndexOf(scope);
            if (index >= 0) scopes.splice(index, 1);
            const parent = scopes[index - 1];
            if (parent) {
              parent.skipped += scope.skipped;
              for (const effect of scope.effects) parent.effects.add(effect);
            }
          }
          return scope.skipped;
        },
        waiting: () => [...scope.effects].some((effect) => pending.has(effect)),
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
        if (scope && effect && pending.has(effect)) {
          pipelines.add(effect);
          scope.skipped += 1;
          scope.effects.add(effect);
          return;
        }
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
    },
    created,
    pipelines,
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
  for (const actor of world) handle.applyCommand({ type: "spawn", slotId: actor.slotId, actorGuid: actor.guid, classId: "Actor" });
  for (const actor of world) assign(actor);
  place(...actors);

  // The world view's frames, as the render loop drives them.
  const views: Array<{ rendered: boolean; reason?: string; holding: boolean }> = [];
  const render = SceneRenderCoordinator.prototype.render;
  vi.spyOn(SceneRenderCoordinator.prototype, "render").mockImplementation(function (this: SceneRenderCoordinator, ...args) {
    const result = render.apply(this, args);
    if ((this as unknown as { scene: unknown }).scene === handle.scene)
      views.push({ rendered: result.rendered, reason: result.reason, holding: this.holdingForPipelines });
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
  /** The Effect the subject's submesh draws with in the camera's pass: the crate by default (it receives every light). */
  const subjectEffect = () => {
    const pass = handle.scene.activeCamera?.renderPassId;
    return pass === undefined ? null : handle.scene.getMeshByName(subject)?.subMeshes?.[0]?._getDrawWrapper(pass)?.effect ?? null;
  };
  return { engine, handle, driver, holds, world, place, remove, frame, views, subjectEffect };
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
  /** WebGPU model: Effects whose pipeline a skipped draw waited for. */
  pipelines: number;
  /** In a frame the view drew while the cause's compiles were pending, the subject drew the Effect it had before the cause. */
  previousEffectDrawn: boolean;
  /** After release the subject draws an Effect the cause compiled. */
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
  for (let index = 0; index < 4; index++) await world.frame();
  await presented;
  // A few steady frames: shadow maps render once, lighting settles.
  for (let index = 0; index < 4; index++) await world.frame();
  expect((await world.frame()).view?.rendered, "the scene draws before the cause").toBe(true);
}

/**
 * Applies `cause` to a settled view, keeps the new compiles or pipelines pending for `PENDING_FRAMES` frames,
 * releases them and lets the view recover (up to 30 frames). `settled` runs once the view has settled.
 */
async function measure(world: PlayWorld, cause: () => unknown, settled?: () => void): Promise<CauseRecord> {
  await settle(world);
  settled?.();
  const before = world.subjectEffect();
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
  }
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
  const after = world.subjectEffect();
  return {
    effects: created.length,
    litEffects: created.filter((effect) => /#define LIGHT0\b/.test(effect.defines)).length,
    heldFrames,
    drawnFrames,
    holdReported,
    holdRaised: world.holds.slice(holdsBefore).includes(true),
    pausedFrames,
    pipelines: world.driver.pipelines.size,
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
    // Only a pending compile leaves a previous Effect drawing; a synchronous link draws the new one at once.
    previousEffectDrawn: record.previousEffectDrawn, adopted: record.adopted,
  }, detail).toEqual({
    heldFrames: 0, holdReported: false, holdRaised: false, paused: false, recovered: true,
    previousEffectDrawn: model === "parallel", adopted: true,
  });
}

/** A cause this harness does not yet require to swap: it compiled, and the view recovers once its work is done. */
function expectRecovers(record: CauseRecord): void {
  const detail = JSON.stringify(record);
  expect(record.litEffects, detail).toBeGreaterThan(0);
  expect(record.recovered, detail).toBe(true);
}

/** WebGPU's Effects are ready once created, so a new pipeline still holds the view (pipeline swaps are separate work). */
const SWAP_MODELS: readonly Model[] = ["sync", "parallel"];

describe("compile holds after the first frame", () => {
  it.each(SWAP_MODELS)("a point light switches off: %s", async (model) => {
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1]), point(11, [1.5, 2.5, -1])]);
    expectSwapped(await measure(world, () => world.place(point(11, [1.5, 2.5, -1], { enabled: false }))), model);
  });

  it.each(SWAP_MODELS)("a point light is removed: %s", async (model) => {
    // Babylon will not draw a previous Effect after one of its lights was disposed; the view binds it without that light.
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1]), point(11, [1.5, 2.5, -1])]);
    expectSwapped(await measure(world, () => world.remove(11)), model);
  });

  it.each(SWAP_MODELS)("a spot light stops casting shadows: %s", async (model) => {
    // The floor receives the crate's shadow; its unshadowed variant is new.
    const world = playWorld(model, [spot(10, [0, 5, 0], { castShadows: true })], [], "actor-1");
    expectSwapped(await measure(world, () => world.place(spot(10, [0, 5, 0]))), model);
  });

  it.each(SWAP_MODELS)("the light inventory grows past its high-water mark: %s", async (model) => {
    // The sun and three points: four lights. A fifth, switched off, still raises every lit Material's light capacity.
    const world = playWorld(model, [point(10, [-2, 2.5, -1]), point(11, [2, 2.5, -1]), point(12, [0, 2.5, 2])]);
    expectSwapped(await measure(world, () => world.place(point(13, [0, 2.5, -3], { enabled: false }))), model);
  });

  it.each(SWAP_MODELS)("the Forward budget swaps a point light for a spot light: %s", async (model) => {
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

  it.each(SWAP_MODELS)("an area light's emission texture arrives: %s", async (model) => {
    const pixels = await areaEmissionPixels();
    const world = playWorld(model, []);
    world.handle.applyCommand({ type: "setAreaLights", slotId: 2, lights: areaRectLightBindings([{ id: "panel", classId: "AreaRectLightComponent", properties: { textureGuid: "panel-texture" } }]) });
    expectSwapped(await measure(world, () => world.handle.setMeshAssets({ areaEmissions: new Map([["panel-texture", pixels]]) })), model);
  });

  it.each(SWAP_MODELS)("a frozen graph Material adopts its new variant: %s", async (model) => {
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

  it.each(MODELS)("a spot light starts casting shadows: %s", async (model) => {
    // Receivers swap, but the new map's casters compile their depth variants first and the graph prepares the map.
    const world = playWorld(model, [spot(10, [0, 5, 0])]);
    expectRecovers(await measure(world, () => world.place(spot(10, [0, 5, 0], { castShadows: true }))));
  });

  it.each(MODELS)("a spawned actor uses a Material no mesh drew before: %s", async (model) => {
    // A mesh with no previous Effect has nothing to draw meanwhile.
    const world = playWorld(model, [], ["surface-a"]);
    expectRecovers(await measure(world, () => {
      world.place({ slotId: 20, guid: "barrel", position: [2, 1, 1], assign: { meshAssetGuid: null, meshKind: "box" } });
      world.handle.applyCommand({ type: "assignMaterial", slotId: 20, materialAssetGuid: "surface-a" });
    }));
  });

  it("a variant change on WebGPU recovers once its pipeline exists", async () => {
    const world = playWorld("webgpu", [point(10, [-1.5, 2.5, -1]), point(11, [1.5, 2.5, -1])]);
    expectRecovers(await measure(world, () => world.place(point(11, [1.5, 2.5, -1], { enabled: false }))));
  });
});

/** Prepared area emission pixels, as the derived chunk holds them. */
async function areaEmissionPixels() {
  return decodeAreaEmission(await encodeAreaEmission(new Uint8Array(AREA_EMISSION_EDGE ** 2 * 4).fill(170), "a".repeat(64)));
}
