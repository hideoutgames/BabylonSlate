import {
  Constants,
  MaterialDefines,
  type AbstractEngine,
  type AbstractMesh,
  type Effect,
  type InstancedMesh,
  type Scene,
  type SubMesh,
} from "@babylonjs/core";
import { beginPipelineDeferral, effectDrawn, pipelinesDeferred } from "./webgpu-pipeline-deferral";
import { variantSwapsTolerated } from "./variant-swaps";

/**
 * First draws of new variants in a world view's steady frames, and on WebGPU their render pipelines.
 *
 * An Effect first requested by a world view that draws steady frames (inside a tolerant scope: its steady frames and
 * their preparations; or inside any readiness round once it has drawn one, such as Play's strict end-of-frame
 * question, which often asks for a new variant first) is cold: it reports not ready in the view's main object pass and
 * blended depth pre-pass, so a Material keeps drawing its previous Effect and a spawned mesh stays hidden
 * (`reveal-pending.ts`). A cold Effect turns ready only when it is admitted, and each steady frame admits at most
 * `FIRST_DRAWS_PER_FRAME` of them (oldest first; one that links inside the frame that requests it is admitted at once
 * while the frame has room), so a burst of swaps spreads its first draws over frames: a new program's first draw can
 * hold a thread (about 100 ms on iPad WebKit WebGL2), and a WebGPU pipeline is created there.
 *
 * WebGL2: a new Effect is cold, and admissible once linked. WebGPU: an Effect is ready as soon as it exists and its
 * render pipeline is created on its first draw, so Babylon's hot swap (which keeps a previous Effect only while the new
 * one is not ready) would never engage, and the first draw would miss its pipeline and hold the view
 * (`webgpu-pipeline-deferral.ts`). There an Effect no draw has drawn with is cold, and admissible once warm: the probes
 * ask for the meshes that swap or wait to be revealed (`requestPipelineWarm`); after its real draws, the view's main
 * object pass draws each again under a second render pass id (`warmPassId`: its own draw wrappers, so the real pass
 * keeps its previous Effect) inside a warm deferral scope, with the real pass's target and the group's render state.
 * Those draws are always skipped; a missing pipeline starts creating asynchronously. An Effect warms once every warm
 * draw that used it in a frame found its pipeline. A mesh's own warm draws all finding theirs (`pipelinesWarm`) is part
 * of its reveal.
 *
 * A cold Effect that no warm draw used for `UNUSED_WARM_MS` (one only the camera's probe pass compiles, a shadow
 * caster's depth variant, a geometry pass's variant, or one whose view stopped warming) becomes admissible as it is,
 * and waits as it did before.
 */
type ColdEntry = { usedAt: number; base: () => boolean; warmed: boolean };

/** A cold Effect no warm draw used for this long becomes admissible as it is (a view that warms one draws it every frame). */
export const UNUSED_WARM_MS = 500;

/**
 * New variants a world view's steady frame admits at most, so their first draws (a program's first use, a WebGPU
 * pipeline) spread over frames.
 */
export const FIRST_DRAWS_PER_FRAME = 2;

type WarmupState = {
  /** Cold Effects, oldest first. */
  cold: Map<Effect, ColdEntry>;
  /** WebGL2: every Effect the Engine held at installation or returned since (a new one is cold). */
  known: WeakSet<Effect>;
  /** Admissions left in the Engine frame `budgetFrame` (`engine.frameId`), shared by its rounds and views. */
  budget: number;
  budgetFrame: number;
  /** Effects that were cold and are not any more (warmed, or turned ready unused): never cold again. */
  settled: WeakSet<Effect>;
  /** Open readiness rounds of a view that has drawn steady frames: new Effects are cold there too. */
  marking: number;
  /** Inside a warm draw: cold Effects are ready. */
  warming: boolean;
  /** Inside a variant prediction (`withPredictedEffects`): the Effects it creates are known, never cold. */
  predicting: boolean;
  /** Meshes the current round's probes asked to warm. */
  requests: Set<AbstractMesh>;
  /** Whether a mesh's last warm draws all found their pipelines. */
  meshWarm: WeakMap<AbstractMesh, boolean>;
  /** Each real render pass id's warm pass id. */
  warmPasses: Map<number, number>;
};

type EffectEngine = { createEffect(...args: unknown[]): Effect };

const states = new WeakMap<AbstractEngine, WarmupState>();
/** Per Engine, the render passes of world views that warm their pipelines: a cold Effect is unready only there. */
const warmedPasses = new WeakMap<AbstractEngine, Map<number, number>>();

/**
 * A world view's main object pass and its blended depth pre-pass, whose pipelines its warm draws create: a cold Effect
 * waits there only (a probe pass nothing draws, such as the camera's, or a shadow map's takes it at once). Returns
 * the release.
 */
export function registerPipelineWarmPasses(engine: AbstractEngine, passIds: readonly number[]): () => void {
  let passes = warmedPasses.get(engine);
  if (!passes) warmedPasses.set(engine, (passes = new Map()));
  const owned = passes;
  for (const id of passIds) owned.set(id, (owned.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const id of passIds) {
      const count = (owned.get(id) ?? 1) - 1;
      if (count > 0) owned.set(id, count);
      else owned.delete(id);
    }
  };
}

function install(engine: AbstractEngine): WarmupState {
  const target = engine as unknown as EffectEngine;
  const create = target.createEffect;
  if (typeof create !== "function") throw new Error("Unsupported Babylon engine layout: createEffect is missing.");
  const compiled = (engine as unknown as { _compiledEffects?: Record<string, Effect> })._compiledEffects ?? {};
  const state: WarmupState = {
    cold: new Map(), known: new WeakSet(Object.values(compiled)), budget: 0, budgetFrame: -1, settled: new WeakSet(), marking: 0, warming: false,
    requests: new Set(), meshWarm: new WeakMap(), warmPasses: new Map(), predicting: false,
  };
  const own = Object.prototype.hasOwnProperty.call(engine, "createEffect");
  if (!warmedPasses.has(engine)) warmedPasses.set(engine, new Map());
  target.createEffect = function (this: EffectEngine, ...args: unknown[]) {
    const effect = create.apply(this, args);
    // A prediction compiles ahead what an admission will ask for, and leaves its first draw to the admission: that
    // finds it new, linked, and admits it within the frame's first-draw budget.
    if (state.predicting) return effect;
    const known = state.known.has(effect);
    state.known.add(effect);
    if ((state.marking === 0 && !variantSwapsTolerated()) || state.cold.has(effect) || state.settled.has(effect)) return effect;
    // WebGPU: a variant no draw has drawn with has no pipeline yet (a new one, or one only a probe pass compiled).
    // WebGL2: a new variant has not been drawn either.
    if (pipelinesDeferred(engine) ? effectDrawn(engine, effect) : known) return effect;
    // A variant linked as soon as it is requested (a synchronous driver) draws in this frame while it has room.
    if (!pipelinesDeferred(engine) && variantSwapsTolerated() && state.budget > 0 && effect.isReady()) {
      state.budget -= 1;
      state.settled.add(effect);
      return effect;
    }
    makeCold(state, effect);
    return effect;
  };
  const released = engine._onReleaseRenderPassObservable?.add((id) => {
    const warm = state.warmPasses.get(id);
    if (warm === undefined) return;
    state.warmPasses.delete(id);
    engine.releaseRenderPassId(warm);
  });
  engine.onDisposeObservable.addOnce(() => {
    if (own) target.createEffect = create;
    else delete (target as Partial<EffectEngine>).createEffect;
    if (released) engine._onReleaseRenderPassObservable?.remove(released);
    states.delete(engine);
  });
  return state;
}

function makeCold(state: WarmupState, effect: Effect): void {
  const base = effect.isReady.bind(effect);
  const engine = effect.getEngine();
  const passes = warmedPasses.get(engine)!;
  state.cold.set(effect, { usedAt: performance.now(), base, warmed: false });
  effect.isReady = () => base() && (state.warming || !state.cold.has(effect) || !passes.has(engine.currentRenderPassId));
}

/** An Effect that warms keeps its original readiness as its own `isReady` (a bound copy), deliberately: one closure. */
function warmUp(state: WarmupState, effect: Effect): void {
  const entry = state.cold.get(effect);
  if (!entry) return;
  state.cold.delete(effect);
  state.settled.add(effect);
  effect.isReady = entry.base;
}

/**
 * Runs a world view's readiness round: the Effects it requests first are cold when the round is tolerant, or when the
 * view has drawn steady frames (`steady`). A tolerant round (one per steady frame) first admits up to
 * `FIRST_DRAWS_PER_FRAME` admissible cold Effects, oldest first, and starts its warm requests afresh.
 */
export function withPipelineWarmupRound<T>(engine: AbstractEngine, steady: boolean, run: () => T): T {
  const tolerated = variantSwapsTolerated();
  if (!(tolerated || steady)) return run();
  let state = states.get(engine);
  if (!state) states.set(engine, (state = install(engine)));
  if (tolerated) {
    const deferred = pipelinesDeferred(engine);
    const now = performance.now();
    // Per Engine frame: a tolerant preparation and a second view's rounds in the same frame share its admissions.
    if (state.budgetFrame !== engine.frameId) {
      state.budgetFrame = engine.frameId;
      state.budget = FIRST_DRAWS_PER_FRAME;
    }
    let budget = state.budget;
    for (const [effect, entry] of state.cold) {
      // A variant that failed to link, every fallback included, never turns ready (the mesh keeps its previous Effect
      // for good): it leaves the queue without a first draw to spread.
      if (effect.getCompilationError() && effect.allFallbacksProcessed()) {
        warmUp(state, effect);
        continue;
      }
      if (budget === 0) break;
      const unused = now - entry.usedAt >= UNUSED_WARM_MS;
      if (!(deferred ? entry.warmed || unused : entry.base())) continue;
      warmUp(state, effect);
      budget -= 1;
    }
    state.budget = budget;
    state.requests.clear();
  }
  state.marking += 1;
  try {
    return run();
  } finally {
    state.marking -= 1;
  }
}

/** Whether probes on `engine` ask for warm draws: inside a tolerant round where pipelines are deferred. */
function warmupActive(engine: AbstractEngine): WarmupState | undefined {
  return variantSwapsTolerated() && pipelinesDeferred(engine) ? states.get(engine) : undefined;
}

/**
 * A tolerant probe found `mesh` swapping a variant, or waiting to be revealed: the view's next pass warms it. An
 * instance draws with its source's batch, so the source is warmed.
 */
export function requestPipelineWarm(mesh: AbstractMesh): void {
  const state = warmupActive(mesh.getScene().getEngine());
  // A mesh the view does not draw (a light's or camera's helper) needs no pipeline.
  if (!state || !mesh.isEnabled() || !mesh.isVisible) return;
  state.requests.add(mesh.getClassName() === "InstancedMesh" ? (mesh as InstancedMesh).sourceMesh : mesh);
}

/**
 * Whether `mesh` may draw without its first draws waiting for pipelines: always where pipelines are not deferred, and
 * otherwise once its last warm draws all found theirs.
 */
export function pipelinesWarm(mesh: AbstractMesh): boolean {
  const state = warmupActive(mesh.getScene().getEngine());
  return !state || state.meshWarm.get(mesh) === true;
}

/** Whether `mesh`'s last warm draws all found their pipelines, whatever the current round. */
export function pipelinesWarmed(mesh: AbstractMesh): boolean {
  return states.get(mesh.getScene().getEngine())?.meshWarm.get(mesh) === true;
}

/** The warm pass id standing in for `renderPassId`. */
function warmPassId(engine: AbstractEngine, state: WarmupState, renderPassId: number): number {
  let warm = state.warmPasses.get(renderPassId);
  if (warm === undefined) {
    warm = engine.createRenderPassId(`warm ${engine.getRenderPassNames()[renderPassId] ?? renderPassId}`);
    state.warmPasses.set(renderPassId, warm);
  }
  return warm;
}

/**
 * The main object pass of a world view, after its real draws and inside its target: draws every mesh of `scene` the
 * round asked for under the warm pass of `renderPassId` (blended ones' depth pre-passes under that of
 * `depthPrePassId`), so their pipelines exist before a real draw needs them.
 */
export function warmRequestedPipelines(scene: Scene, renderPassId: number, depthPrePassId?: number): void {
  const engine = scene.getEngine();
  const state = states.get(engine);
  if (!state?.requests.size) return;
  const effects = new Map<Effect, boolean>();
  const pass = engine.currentRenderPassId;
  const alpha = Math.max(0, engine.getAlphaMode());
  const colour = engine.getColorWrite();
  try {
    for (const mesh of state.requests) {
      if (mesh.getScene() !== scene || mesh.isDisposed() || !mesh.subMeshes) continue;
      let warm = true;
      for (const subMesh of mesh.subMeshes) {
        const material = subMesh.getMaterial();
        if (!material) continue;
        const blended = material.needAlphaBlendingForMesh(mesh);
        warm = warmDraw(engine, state, renderPassId, subMesh, true, blended, effects) && warm;
        if (blended && material.needDepthPrePass && depthPrePassId !== undefined)
          warm = warmDraw(engine, state, depthPrePassId, subMesh, false, false, effects) && warm;
      }
      state.meshWarm.set(mesh, warm);
    }
  } finally {
    engine.currentRenderPassId = pass;
    engine.setAlphaMode(alpha);
    engine.setColorWrite(colour);
    scene.resetCachedMaterial();
  }
  for (const [effect, warm] of effects) {
    const entry = state.cold.get(effect);
    if (!entry) continue;
    entry.usedAt = performance.now();
    if (warm) entry.warmed = true;
  }
}

/**
 * One skipped draw of `subMesh` under the warm pass of `realPass`; whether it found its pipeline. A draw that never
 * reached its pipeline (its Material not ready for another reason) warms nothing and leaves its Effect's warmth to
 * other draws.
 */
function warmDraw(
  engine: AbstractEngine, state: WarmupState, realPass: number, subMesh: SubMesh, colour: boolean, blended: boolean,
  effects: Map<Effect, boolean>,
): boolean {
  const warmPass = warmPassId(engine, state, realPass);
  const scope = beginPipelineDeferral(engine, (pass) => pass === warmPass, { warm: true });
  if (!scope) return true;
  // The defines text keys the Effect cache in the order the defines object gained its keys, so a fresh object can
  // name the same variant differently: the warm draw prepares a copy of the real pass's defines.
  const defines = subMesh._getDrawWrapper(realPass)?.defines;
  if (defines instanceof MaterialDefines) subMesh._getDrawWrapper(warmPass, true)!.defines = copyDefines(defines);
  engine.currentRenderPassId = warmPass;
  engine.setColorWrite(colour);
  engine.setAlphaMode(Constants.ALPHA_DISABLE);
  state.warming = true;
  let drawn: number;
  try {
    subMesh.render(blended);
  } finally {
    state.warming = false;
    drawn = scope.close();
  }
  const warmed = scope.warmed();
  const effect = subMesh._getDrawWrapper(warmPass)?.effect;
  if (effect && drawn > 0) effects.set(effect, (effects.get(effect) ?? true) && warmed);
  return warmed;
}

/**
 * Runs `predict` (a variant prediction's probes, `variant-prediction.ts`): the Effects it creates are neither cold nor
 * known, so the admission that later asks for one finds it new and, on WebGL2, linked: it draws within the frame's
 * first-draw budget (`FIRST_DRAWS_PER_FRAME`) with no compile to wait for; on WebGPU it still waits for its pipeline,
 * which only a draw creates.
 */
export function withPredictedEffects<T>(engine: AbstractEngine, predict: () => T): T {
  let state = states.get(engine);
  if (!state) states.set(engine, (state = install(engine)));
  const previous = state.predicting;
  state.predicting = true;
  try {
    return predict();
  } finally {
    state.predicting = previous;
  }
}

/**
 * `source` as a separate defines object: the same class, own properties in the same order, the same define list
 * (`_keys`, which only `rebuild` refreshes) and the same text, marked unprocessed so a preparation builds its Effect.
 */
export function copyDefines(source: MaterialDefines): MaterialDefines {
  const copy = Object.create(Object.getPrototypeOf(source)) as Record<string, unknown>;
  const values = source as unknown as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const value = values[key];
    copy[key] = Array.isArray(value) ? value.slice() : value;
  }
  // A defines text a hook gave its own builder (`trackShadowSlotDefines`) builds it the same way.
  const text = Object.getOwnPropertyDescriptor(source, "toString");
  if (text) Object.defineProperty(copy, "toString", text);
  const defines = copy as unknown as MaterialDefines & { _renderId: number };
  defines._renderId = -1;
  defines.markAsUnprocessed();
  return defines;
}
