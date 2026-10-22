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
 * pause were raised, and pipelines the WebGPU model waited for.
 *
 * Baseline: the expectations below describe today's behaviour. The later
 * compile-hold phases flip them (no held frame and no pause for an existing
 * material's variant change; spawned meshes hidden per mesh).
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
function playWorld(model: Model, actors: Actor[], materials: string[] = []) {
  let now = 1_000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
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
  const frame = () => {
    now += FRAME_MS;
    handle.scheduler.invalidate("manual");
    engine.onBeginFrameObservable.notifyObservers(engine);
    if (!engine.getRenderingCanvas())
      vi.spyOn(engine, "getRenderingCanvas").mockReturnValue(new FakeCanvas() as unknown as HTMLCanvasElement);
    engine._renderViews();
    engine.onEndFrameObservable.notifyObservers(engine);
    const view = views.at(-1);
    return { view, holding: view?.holding ?? false, paused: isSceneGameTimePaused(handle.scene) };
  };
  return { engine, handle, driver, holds, world, place, frame, views };
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
  /** After release the view drew within three frames and nothing stayed paused. */
  recovered: boolean;
  /** Frames after release until the view drew unpaused (recorded, not asserted: graph preparation polls on real 16 ms timers). */
  recoveryFrames: number;
  /** Why the view held, in the order first seen. */
  reasons: string[];
}

async function settle(world: PlayWorld): Promise<void> {
  await world.handle.prewarmSceneMaterials();
  const presented = world.handle.presentFirstFrame();
  for (let index = 0; index < 4; index++) world.frame();
  await presented;
  // A few steady frames: shadow maps render once, lighting settles.
  for (let index = 0; index < 4; index++) world.frame();
  expect(world.frame().view?.rendered, "the scene draws before the cause").toBe(true);
}

/**
 * Applies `cause` to a settled view, keeps the new compiles or pipelines pending for `PENDING_FRAMES` frames,
 * releases them and lets the view recover. `cause` may return a promise (a spawn's material preparation), which is
 * awaited after the pending window and before the recovery frames.
 */
/** Real time between frames, so graph preparation (it polls readiness every 16 ms) runs about once per frame. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

async function measure(world: PlayWorld, cause: () => unknown, settled?: () => void): Promise<CauseRecord> {
  await settle(world);
  settled?.();
  world.driver.arm();
  const holdsBefore = world.holds.length;
  const outcome = cause();
  let heldFrames = 0;
  let drawnFrames = 0;
  let pausedFrames = 0;
  let holdReported = false;
  const reasons = new Set<string>();
  for (let index = 0; index < PENDING_FRAMES; index++) {
    const { view, holding, paused } = world.frame();
    if (view?.rendered) drawnFrames++;
    else {
      heldFrames++;
      reasons.add(view?.reason ?? "no frame");
    }
    if (paused) pausedFrames++;
    holdReported ||= holding;
    // Let asynchronous work (graph preparation, a spawned material's compile poll) run between frames.
    await nextTask();
  }
  world.driver.release();
  await outcome;
  let recovered = false;
  let recoveryFrames = 0;
  for (let index = 0; index < 30 && !recovered; index++, recoveryFrames++) {
    const { view, paused } = world.frame();
    if (paused) pausedFrames++;
    recovered = !!view?.rendered && !paused;
    if (!view?.rendered) reasons.add(`after release: ${view?.reason ?? "no frame"}`);
    await nextTask();
  }
  const created = world.driver.created;
  return {
    effects: created.length,
    litEffects: created.filter((effect) => /#define LIGHT0\b/.test(effect.defines)).length,
    heldFrames,
    drawnFrames,
    holdReported,
    holdRaised: world.holds.slice(holdsBefore).includes(true),
    pausedFrames,
    pipelines: world.driver.pipelines.size,
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

/** Whether the world view held its image in none, some or all of the pending window's frames. */
type Held = "none" | "some" | "all";
type Expected = { held: Held; holdReported: boolean; holdRaised: boolean; paused: boolean };

/** The states a later phase flips; compile counts are recorded in the failure message, not asserted. */
function expectBaseline(record: CauseRecord, model: Model, expected: Expected): void {
  const held: Held = record.heldFrames === 0 ? "none" : record.heldFrames === PENDING_FRAMES ? "all" : "some";
  const detail = JSON.stringify(record);
  // The cause really compiled a lit variant (and, on WebGPU, waited for its pipeline), so the states below mean something.
  expect(record.litEffects, detail).toBeGreaterThan(0);
  expect(record.pipelines > 0, detail).toBe(model === "webgpu" && expected.held !== "none");
  expect({ held, holdReported: record.holdReported, holdRaised: record.holdRaised, paused: record.pausedFrames > 0, recovered: record.recovered }, detail)
    .toEqual({ ...expected, recovered: true });
}

/** Today's behaviour per driver model for a cause that changes an existing Material's variant. */
const HELD_AND_PAUSED: Record<Model, Expected> = {
  // A link that completes inside the call blocks the thread instead; nothing is left to hold for.
  sync: { held: "none", holdReported: false, holdRaised: false, paused: false },
  // Strict readiness holds the image until the pending variant links, and Play pauses its game time meanwhile.
  parallel: { held: "all", holdReported: true, holdRaised: true, paused: true },
  // The deferral skips the frame until the new pipeline exists, with the same pause.
  webgpu: { held: "all", holdReported: true, holdRaised: true, paused: true },
};

describe("compile-hold baseline", () => {
  it.each(MODELS)("a point light switches off: %s", async (model) => {
    const world = playWorld(model, [point(10, [-1.5, 2.5, -1]), point(11, [1.5, 2.5, -1])]);
    const record = await measure(world, () => world.place(point(11, [1.5, 2.5, -1], { enabled: false })));
    expectBaseline(record, model, HELD_AND_PAUSED[model]);
  });

  it.each(MODELS)("a spot light starts casting shadows: %s", async (model) => {
    const world = playWorld(model, [spot(10, [0, 5, 0])]);
    const record = await measure(world, () => world.place(spot(10, [0, 5, 0], { castShadows: true })));
    // A new shadow map also re-prepares the graph, which holds the image for a frame even where links are synchronous;
    // that wait compiles nothing pending, so it raises no hold signal and pauses nothing.
    expectBaseline(record, model, model === "sync" ? { held: "some", holdReported: false, holdRaised: false, paused: false } : HELD_AND_PAUSED[model]);
  });

  it.each(MODELS)("a spot light stops casting shadows: %s", async (model) => {
    const world = playWorld(model, [spot(10, [0, 5, 0], { castShadows: true })]);
    const record = await measure(world, () => world.place(spot(10, [0, 5, 0])));
    expectBaseline(record, model, HELD_AND_PAUSED[model]);
  });

  it.each(MODELS)("the light inventory grows past its high-water mark: %s", async (model) => {
    // The sun and three points: four lights. A fifth, switched off, still raises every lit Material's light capacity.
    const world = playWorld(model, [point(10, [-2, 2.5, -1]), point(11, [2, 2.5, -1]), point(12, [0, 2.5, 2])]);
    const record = await measure(world, () => world.place(point(13, [0, 2.5, -3], { enabled: false })));
    expectBaseline(record, model, HELD_AND_PAUSED[model]);
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
    expectBaseline(record, model, HELD_AND_PAUSED[model]);
  });

  it.each(MODELS)("an area light's emission texture arrives: %s", async (model) => {
    const world = playWorld(model, []);
    const pixels = await decodeAreaEmission(await encodeAreaEmission(new Uint8Array(AREA_EMISSION_EDGE ** 2 * 4).fill(170), "a".repeat(64)));
    world.handle.applyCommand({ type: "setAreaLights", slotId: 2, lights: areaRectLightBindings([{ id: "panel", classId: "AreaRectLightComponent", properties: { textureGuid: "panel-texture" } }]) });
    const record = await measure(world, () => world.handle.setMeshAssets({ areaEmissions: new Map([["panel-texture", pixels]]) }));
    expectBaseline(record, model, HELD_AND_PAUSED[model]);
  });

  it.each(MODELS)("a spawned actor uses a Material no mesh drew before: %s", async (model) => {
    const world = playWorld(model, [], ["surface-a"]);
    const record = await measure(world, () => {
      world.place({ slotId: 20, guid: "barrel", position: [2, 1, 1], assign: { meshAssetGuid: null, meshKind: "box" } });
      world.handle.applyCommand({ type: "assignMaterial", slotId: 20, materialAssetGuid: "surface-a" });
    });
    // The whole frame waits for the new mesh, also for one frame where links are synchronous.
    expectBaseline(record, model, model === "sync" ? { held: "some", holdReported: false, holdRaised: false, paused: false } : HELD_AND_PAUSED[model]);
  });
});
