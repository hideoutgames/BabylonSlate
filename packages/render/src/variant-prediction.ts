import {
  InstancedMesh, MaterialDefines, Mesh, type AbstractEngine, type AbstractMesh, type Effect, type Light, type Scene, type ShadowGenerator,
} from "@babylonjs/core";
import { drawnMaterialVariants } from "./drawn-variants";
import { hasClusteredLightPolicy } from "./clustered-light-policy";
import { fixedShapeLightingActive } from "./fixed-light-admission";
import { restoreSceneLightOrder } from "./forward-light-slots";
import {
  forwardLightSelection,
  isForwardLightExcluded,
  nearForwardAdmissions,
  restoreForwardLightSelection,
  withForwardAdmissionPromotion,
} from "./light-policy";
import { syncSceneLighting } from "./scene-lighting";
import { withSceneReadinessState, withSceneSignalsHeld } from "./scene-readiness-signal";
import { findSceneShadowController, type SceneShadowController, type ShadowStartPrediction } from "./shadow-controller";
import { awaitsFirstDraw } from "./shadow-first-draw";
import { copyDefines, withPredictedEffects } from "./variant-pipeline-warmup";
import { beginPipelineDeferral, pipelinesDeferred, releaseWarmPipelines } from "./webgpu-pipeline-deferral";

/**
 * Variant prediction (decision 6): a light within this distance ratio of an admission (the Forward budget's cut-off,
 * the farthest admitted local light with its incumbent bonus; or a shadow map's, the relevant area's edge or the
 * farthest map holder's ranking distance) gets the variants that admission would ask for compiled ahead.
 */
export const PREDICTION_MARGIN = 1.5;
/**
 * How much nearer the what-if admission ranks the predicted light: ahead of every light it could displace, past the
 * budget's kind-change margin (`FORWARD_KIND_CHANGE_DISTANCE_RATIO`), so it admits what an approach would.
 */
const PREDICTION_PROMOTION = 4;
/** New Effects predictions compile per Engine frame (`engine.frameId`), shared by every view on it. */
export const PREDICTED_COMPILES_PER_FRAME = 2;
/**
 * Prediction-map warm renders per Engine frame (WebGPU), shared by every view on it; each starts every caster
 * pipeline its map misses.
 */
export const PREDICTION_MAP_RENDERS_PER_FRAME = 1;
/** Predictions held at once; a new one drops the least recently near. */
export const PREDICTIONS_MAX = 4;
/** A prediction that came true is kept at most this long for the first draw of a map its admission started. */
const PREDICTION_HANDOVER_MS = 1_000;
/** A prediction whose light has stayed outside the margin this long is dropped, and its Effects released. */
export const PREDICTION_EXPIRY_MS = 5_000;

/** A pass a prediction prepares receivers in, and whether it binds admitted shadow maps only (an object pass). */
export type PredictionPass = { id: number; admittedMapsOnly: boolean };

type Prediction = {
  scene: Scene;
  light: Light;
  /** A Forward admission, or a shadow map's start for a light already lit. */
  admission: "forward" | "shadow";
  /** The admitted lights and maps the prediction was made against: another context predicts afresh. */
  context: string;
  /** One render pass id per real pass and instancing, whose draw wrappers hold the predicted Effects. */
  passes: Map<string, number>;
  /**
   * Draw wrappers already prepared, each once: preparing one again with the same defines takes another reference to
   * its cached Effect (Babylon's `createEffect` counts each request), which its one disposal would never give back.
   */
  prepared: WeakSet<object>;
  /** Pipeline-cache nodes its prediction map's warm render looked up, by Effect: released with an Effect nothing else holds. */
  pipelines: Map<Effect, Set<object>>;
  /**
   * The controller's prediction map a first shadow start of its kind borrows (its receivers' defines and casters' depth
   * variants), or, on WebGPU, one standing in for a standby map in the warm render of its casters' depth pipelines.
   */
  map?: ShadowGenerator;
  /** It prepared a map's casters' depth variants. */
  casters?: boolean;
  /** Its prediction map's render (WebGPU) found every caster's pipeline. */
  mapWarm?: boolean;
  /** When its admission happened. */
  fulfilled?: number;
  /** When it was made: one still incomplete `PREDICTION_EXPIRY_MS` later stops probing (`predictLightVariants`). */
  madeAt: number;
  complete: boolean;
  lastNear: number;
};

type PredictionState = {
  frame: number;
  budget: number;
  /** Prediction-map warm renders still allowed in this Engine frame. */
  mapRenders: number;
  predictions: Map<Light, Prediction>;
  /**
   * Render pass ids dropped predictions gave back, for the next to reuse: Babylon numbers pass ids from one counter it
   * never rewinds, and every submesh's draw wrapper list grows to the highest id it was prepared under.
   */
  free: number[];
  /** Scenes whose disposal drops their predictions. */
  watched: WeakSet<Scene>;
  /**
   * Prediction maps' warm pipelines of dropped predictions, by Effect, until the Effect is released (Babylon disposes a
   * draw wrapper's Effect at the end of a later frame) or, still held by a real draw after `PIPELINE_RELEASE_WAIT_MS`,
   * kept.
   */
  releasing: { effect: Effect; nodes: Set<object>; since: number }[];
};

/** How long a dropped prediction's warm pipelines wait for their Effect's release before they are left to it. */
const PIPELINE_RELEASE_WAIT_MS = 10_000;

/** Releases the warm pipelines of Effects that left the cache since their prediction was dropped. */
function releaseWarmPipelinesOfReleasedEffects(engine: AbstractEngine, state: PredictionState, now: number): void {
  if (!state.releasing.length) return;
  const cached = new Set(Object.values((engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects));
  state.releasing = state.releasing.filter((entry) => {
    const released = (entry.effect as unknown as { _isDisposed: boolean })._isDisposed || !cached.has(entry.effect);
    if (released) releaseWarmPipelines(engine, entry.nodes);
    return !released && now - entry.since < PIPELINE_RELEASE_WAIT_MS;
  });
}

/** What one prediction prepares: its receivers, the maps they bind meanwhile, and the casters of a map that returns. */
type Probe = {
  receivers: (mesh: AbstractMesh) => boolean;
  /** Generators the lights resolve to in every pass: a borrowed map for the predicted light, none for one displaced. */
  maps: ReadonlyMap<Light, ShadowGenerator | null>;
  /** The standby map that comes back with the admission, whose casters' depth variants are prepared too. */
  casters: ShadowGenerator | null;
};

const states = new WeakMap<AbstractEngine, PredictionState>();

function stateFor(engine: AbstractEngine): PredictionState {
  let state = states.get(engine);
  if (!state) {
    state = { frame: -1, budget: 0, mapRenders: 0, predictions: new Map(), free: [], watched: new WeakSet(), releasing: [] };
    states.set(engine, state);
    const created = state;
    engine.onDisposeObservable.addOnce(() => created.predictions.clear());
  }
  if (state.frame !== engine.frameId) {
    state.frame = engine.frameId;
    state.budget = PREDICTED_COMPILES_PER_FRAME;
    state.mapRenders = PREDICTION_MAP_RENDERS_PER_FRAME;
  }
  return state;
}

/**
 * Gives back a prediction's render passes: their draw wrappers go, and with them the references to its Effects, and
 * the ids return to the pool.
 */
function drop(state: PredictionState, prediction: Prediction): void {
  state.predictions.delete(prediction.light);
  const engine = prediction.scene.getEngine();
  if (engine.isDisposed) return;
  const passes = [...prediction.passes.values()];
  prediction.passes.clear();
  const pipelines = [...prediction.pipelines];
  prediction.pipelines.clear();
  // After the frame, when no pass draws: the wrappers and their Effect references go at once.
  engine.onEndFrameObservable.addOnce(() => {
    if (engine.isDisposed) return;
    for (const scene of engine.scenes)
      for (const mesh of scene.meshes)
        for (const subMesh of mesh.subMeshes ?? []) for (const pass of passes) subMesh._removeDrawWrapper(pass, true, true);
    state.free.push(...passes);
    // An Effect only the prediction (or its prediction map) held takes the pipelines its map's warm render created along.
    const now = performance.now();
    for (const [effect, nodes] of pipelines) state.releasing.push({ effect, nodes, since: now });
    releaseWarmPipelinesOfReleasedEffects(engine, state, now);
  });
}

function contextOf(scene: Scene, controller: SceneShadowController | null): string {
  const selection = forwardLightSelection(scene);
  const lights = selection ? [...selection].map((light) => light.uniqueId).sort((a, b) => a - b).join(",") : "";
  const maps = controller ? scene.lights.filter((light) => controller.generator(light)).map((light) => light.uniqueId)
    .sort((a, b) => a - b).join(",") : "";
  return `${lights}|${maps}`;
}

/** Whether the admission a prediction was made for happened: the real draw wrappers then took its Effects. */
function cameTrue(prediction: Prediction, controller: SceneShadowController | null): boolean {
  return prediction.admission === "forward"
    ? !isForwardLightExcluded(prediction.light)
    : controller?.generator(prediction.light) != null;
}

/**
 * Drops every prediction of `scene` and disposes its prediction maps: a new world load (Play keeps one Scene across
 * its loads) keeps nothing the previous level predicted.
 */
export function releaseLightPredictions(scene: Scene): void {
  const state = states.get(scene.getEngine());
  if (state) for (const prediction of [...state.predictions.values()]) if (prediction.scene === scene) drop(state, prediction);
  const controller = findSceneShadowController(scene);
  if (controller?.heldPredictionMaps.length)
    withSceneSignalsHeld(scene, () => keepingWrapperMarks(scene, () => controller.releasePredictionMaps()));
}

/**
 * After a world view's drawn steady frame, outside its graph render (`passes`: the passes it prepares receivers in).
 * Compiles ahead, within the Engine frame's budget, the variants the nearest light about to be admitted (by the
 * Forward budget, or to a shadow map) would ask for, and drops predictions that came true or went stale. It never
 * changes what is admitted or drawn: a what-if admission is given back before it returns, with the scene's readiness
 * and receiver signals held (no frame draws it), and the probes prepare separate draw wrappers (`copyDefines` from the
 * real pass, so the defines text, which keys the Effect cache, matches the admission's own).
 */
export function predictLightVariants(scene: Scene, passes: readonly PredictionPass[]): void {
  // Seated lighting binds lights by seat (no variant to predict).
  if (scene.isDisposed || !passes.length || fixedShapeLightingActive(scene)) return;
  const engine = scene.getEngine();
  const state = stateFor(engine);
  const controller = findSceneShadowController(scene) ?? null;
  const now = performance.now();
  // Clustered Forward keeps a selection history of its own, which a what-if admission would move and not give back;
  // its admissions mostly move lights into clusters, which compile nothing. Its shadow starts are still predicted.
  const forward = hasClusteredLightPolicy(scene) ? [] : nearForwardAdmissions(scene, PREDICTION_MARGIN);
  const shadows = controller?.nearShadowStarts(PREDICTION_MARGIN) ?? [];
  const near = new Set<Light>([...forward, ...shadows.map((start) => start.light)]);
  const context = contextOf(scene, controller);
  if (!state.watched.has(scene)) {
    state.watched.add(scene);
    scene.onDisposeObservable.addOnce(() => {
      for (const prediction of [...state.predictions.values()]) if (prediction.scene === scene) drop(state, prediction);
    });
  }
  for (const prediction of [...state.predictions.values()]) {
    if (prediction.scene !== scene) continue;
    if (prediction.light.isDisposed()) {
      drop(state, prediction);
      continue;
    }
    if (cameTrue(prediction, controller)) {
      // Its receivers took its Effects in the admission's frame; a map the admission starts asks for its casters'
      // depth variants only when it first draws, so a prediction that prepared them stays until then.
      prediction.fulfilled ??= now;
      const map = controller?.generator(prediction.light);
      if (!prediction.casters || (map && !awaitsFirstDraw(map)) || now - prediction.fulfilled >= PREDICTION_HANDOVER_MS)
        drop(state, prediction);
      continue;
    }
    if (prediction.context !== context) {
      drop(state, prediction);
      continue;
    }
    if (near.has(prediction.light)) prediction.lastNear = now;
    else if (now - prediction.lastNear >= PREDICTION_EXPIRY_MS) {
      drop(state, prediction);
      continue;
    }
    // One that never finishes (a prediction map whose depth shaders never load) stops probing, and holds back neither
    // the candidates after it nor a map render: what it left out compiles at its admission.
    if (!prediction.complete && now - prediction.madeAt >= PREDICTION_EXPIRY_MS) {
      prediction.complete = true;
      prediction.mapWarm = true;
    }
  }
  releaseUnusedPredictionMaps(scene, controller, state);
  releaseWarmPipelinesOfReleasedEffects(engine, state, now);
  // WebGPU: a first shadow start of a kind, or an admission bringing a standby map back, renders its prediction map
  // once its variants are compiled (every draw skipped), so its casters' depth pipelines exist before the real map's
  // first draw needs them.
  for (const prediction of state.predictions.values())
    if (prediction.scene === scene && prediction.complete && prediction.map && !prediction.mapWarm && prediction.fulfilled === undefined)
      warmPredictionMapSafely(scene, prediction, state);
  if (state.budget <= 0) return;
  // The nearest PREDICTIONS_MAX candidates only. A full set makes room only by dropping a prediction of this scene
  // whose light has left the margin, never one still near (two near lights trading ranks would otherwise drop and
  // rebuild each other's predictions every frame) nor another view's.
  const candidates = [...near].slice(0, PREDICTIONS_MAX);
  const light = candidates.find((candidate) => !state.predictions.get(candidate)?.complete);
  if (!light) return;
  let prediction = state.predictions.get(light);
  if (!prediction) {
    if (state.predictions.size >= PREDICTIONS_MAX) {
      let oldest: Prediction | undefined;
      for (const other of state.predictions.values())
        if (other.scene === scene && !near.has(other.light) && (!oldest || other.lastNear < oldest.lastNear)) oldest = other;
      if (!oldest) return;
      drop(state, oldest);
    }
    prediction = { scene, light, admission: forward.includes(light) ? "forward" : "shadow", context, passes: new Map(),
      prepared: new WeakSet(), pipelines: new Map(), madeAt: now, complete: false, lastNear: now };
    state.predictions.set(light, prediction);
  }
  const target = prediction;
  const start = shadows.find((candidate) => candidate.light === light);
  // Anything pending applies first, as it would at the next frame: the held what-if refreshes no Material.
  if (target.admission === "forward") syncSceneLighting(scene);
  const run = (plan: Probe) => {
    // WebGPU: a standby map's casters draw again with its admission, and only a draw creates their depth pipelines. The
    // controller's prediction map of the light's kind stands in for it in a warm render: it has the current settings,
    // as a standby map has, so its format and its casters' depth variants are the standby map's.
    if (plan.casters && !target.map && pipelinesDeferred(engine))
      target.map = keepingWrapperMarks(scene, () => controller?.predictionMap(light) ?? null) ?? undefined;
    return withPredictedEffects(engine, () => withSceneReadinessState(scene, () => probe(scene, target, passes, state, plan, controller)));
  };
  target.complete = withSceneSignalsHeld(scene, () => target.admission === "forward"
    ? whatIfAdmitted(scene, light, (before) => run({
      receivers: (mesh) => {
        const previous = before.get(mesh);
        const lights = mesh.lightSources;
        return !previous || previous.length !== lights.length || previous.some((source, index) => source !== lights[index]);
      },
      maps: new Map(),
      casters: standbyMap(controller, light),
    }))
    : start ? shadowProbe(controller, start, target, run) : true);
  releaseUnusedPredictionMaps(scene, controller, state);
}

/** A prediction map goes with the last prediction it served (an expired, dropped or evicted one). */
function releaseUnusedPredictionMaps(scene: Scene, controller: SceneShadowController | null, state: PredictionState): void {
  if (!controller?.heldPredictionMaps.length) return;
  const unused = (map: ShadowGenerator) => ![...state.predictions.values()].some((other) => other.map === map);
  if (!controller.heldPredictionMaps.some(unused)) return;
  // Disposing a map marks its light's receivers light-dirty and reports a removed texture, though no frame drew it.
  withSceneSignalsHeld(scene, () => keepingWrapperMarks(scene, () => controller.releasePredictionMaps(unused)));
}

/**
 * Probes a shadow start; a first start of its kind borrows the controller's prediction map of that kind, and is left
 * out (complete, with nothing to predict) when there is no room for one.
 */
function shadowProbe(controller: SceneShadowController | null, start: ShadowStartPrediction, prediction: Prediction,
  run: (plan: Probe) => boolean): boolean {
  if (!start.firstOfKind) return run(shadowStart(controller, start, null));
  // Building a map marks its light's receivers light-dirty; this one is taken off the light at once.
  const map = keepingWrapperMarks(prediction.scene, () => controller?.predictionMap(start.light) ?? null);
  if (!map) return true;
  prediction.map = map;
  return run(shadowStart(controller, start, map));
}

/** The standby map `light` holds, which comes back with its admission. */
function standbyMap(controller: SceneShadowController | null, light: Light): ShadowGenerator | null {
  return controller && !controller.generator(light) ? controller.boundGenerator(light) : null;
}

/**
 * A shadow start for a light already lit: its receivers bind a map of its kind (its own standby one, or a borrowed
 * admitted one with the same defines), and the holder it displaces binds none.
 */
function shadowStart(controller: SceneShadowController | null, start: ShadowStartPrediction, map: ShadowGenerator | null): Probe {
  const maps = new Map<Light, ShadowGenerator | null>();
  const borrowed = start.borrowed ?? map;
  if (borrowed) maps.set(start.light, borrowed);
  if (start.displaced) maps.set(start.displaced, null);
  const lit = [start.light, ...(start.displaced ? [start.displaced] : [])];
  return {
    receivers: (mesh) => mesh.receiveShadows && lit.some((light) => mesh.lightSources.includes(light)),
    maps,
    // The first map of a kind: its casters' depth variants come from the prediction map, as a new map's would.
    casters: map ?? standbyMap(controller, start.light),
  };
}

/**
 * Runs `probe` with `light` admitted as the Forward budget would admit it `PREDICTION_PROMOTION` times nearer (its slot
 * exchange or canonical arrangement included), then gives admission back: the selection it favours, the lights'
 * enabled state and their order (as a load rehearsal's revert does). Returns `probe`'s answer, or true when even the
 * promoted light is not admitted (nothing to predict in this context).
 */
function whatIfAdmitted(scene: Scene, light: Light, probe: (before: Map<object, readonly Light[]>) => boolean): boolean {
  const selection = forwardLightSelection(scene);
  const order = [...scene.lights];
  const before = new Map<object, readonly Light[]>();
  for (const mesh of scene.meshes) if (!(mesh instanceof InstancedMesh)) before.set(mesh, mesh.lightSources.slice());
  const marks = wrapperMarks(scene);
  try {
    withForwardAdmissionPromotion(light, PREDICTION_PROMOTION, () => syncSceneLighting(scene));
    return isForwardLightExcluded(light) ? true : probe(before);
  } finally {
    restoreForwardLightSelection(scene, selection);
    syncSceneLighting(scene);
    // The lighting sync then takes the restored order as its own, or the next frame's would refresh every receiver.
    if (restoreSceneLightOrder(scene, order)) syncSceneLighting(scene);
    restoreWrapperMarks(marks, before);
  }
}

/** Runs `change`, which leaves every receiver's lights as they were, and gives back the draw wrappers' marks. */
function keepingWrapperMarks<T>(scene: Scene, change: () => T): T {
  const before = new Map<object, readonly Light[]>();
  for (const mesh of scene.meshes) if (!(mesh instanceof InstancedMesh)) before.set(mesh, mesh.lightSources.slice());
  const marks = wrapperMarks(scene);
  try {
    return change();
  } finally {
    restoreWrapperMarks(marks, before);
  }
}

type WrapperMark = {
  mesh: AbstractMesh;
  wrapper: { _wasPreviouslyReady: boolean; _wasPreviouslyUsingInstances: boolean | null; defines: unknown };
  ready: boolean;
  instances: boolean | null;
  dirty: boolean;
  lightsDirty: boolean;
  lightsDisposed: boolean;
};

type DefinesMarks = { _isDirty: boolean; _areLightsDirty: boolean; _areLightsDisposed: boolean };

/**
 * Every draw wrapper's readiness memo and its defines' light marks, which Babylon's light toggles (each receiver's
 * light resync marks its defines light-dirty) would otherwise leave set on the real passes' wrappers.
 */
function wrapperMarks(scene: Scene): WrapperMark[] {
  const marks: WrapperMark[] = [];
  for (const mesh of scene.meshes)
    for (const subMesh of mesh.subMeshes ?? [])
      for (const wrapper of (subMesh as unknown as { _drawWrappers: (WrapperMark["wrapper"] | undefined)[] })._drawWrappers) {
        if (!wrapper) continue;
        const defines = wrapper.defines instanceof MaterialDefines ? wrapper.defines as unknown as DefinesMarks : undefined;
        marks.push({
          mesh, wrapper, ready: wrapper._wasPreviouslyReady, instances: wrapper._wasPreviouslyUsingInstances,
          dirty: defines?._isDirty ?? false, lightsDirty: defines?._areLightsDirty ?? false,
          lightsDisposed: defines?._areLightsDisposed ?? false,
        });
      }
  return marks;
}

/**
 * Gives back the marks a what-if found, on the receivers whose lights it gave back in the same order (the others keep
 * theirs, and prepare again).
 */
function restoreWrapperMarks(marks: readonly WrapperMark[], before: ReadonlyMap<object, readonly Light[]>): void {
  const restored = new Map<AbstractMesh, boolean>();
  for (const mark of marks) {
    let same = restored.get(mark.mesh);
    if (same === undefined) {
      const previous = before.get(mark.mesh);
      const lights = mark.mesh.lightSources;
      same = !!previous && previous.length === lights.length && previous.every((source, index) => source === lights[index]);
      restored.set(mark.mesh, same);
    }
    if (!same) continue;
    mark.wrapper._wasPreviouslyReady = mark.ready;
    mark.wrapper._wasPreviouslyUsingInstances = mark.instances;
    if (!(mark.wrapper.defines instanceof MaterialDefines)) continue;
    const defines = mark.wrapper.defines as unknown as DefinesMarks;
    defines._isDirty = mark.dirty;
    defines._areLightsDirty = mark.lightsDirty;
    defines._areLightsDisposed = mark.lightsDisposed;
  }
}

/** The prediction's render pass for `key`, taken on first use (from the pool, or a new id). */
function predictionPass(engine: AbstractEngine, state: PredictionState, prediction: Prediction, key: string, name: string): number {
  let pass = prediction.passes.get(key);
  if (pass === undefined) {
    pass = state.free.pop();
    if (pass === undefined) pass = engine.createRenderPassId(`prediction ${name}`);
    else engine.getRenderPassNames()[pass] = `prediction ${name}`;
    prediction.passes.set(key, pass);
  }
  return pass;
}

/** Runs `run` with each light resolving to the given shadow generator (as receivers' light defines read it). */
function withShadowGenerators<T>(maps: ReadonlyMap<Light, ShadowGenerator | null>, run: () => T): T {
  for (const [light, generator] of maps) light.getShadowGenerator = () => generator;
  try {
    return run();
  } finally {
    for (const light of maps.keys()) delete (light as Partial<Light>).getShadowGenerator;
  }
}

/**
 * Prepares, on the prediction's own draw wrappers, every receiver `plan` names, as each pass would (plain and
 * instanced, as Babylon draws the mesh), then the casters of a standby map the admission brings back; whether it
 * finished within the frame's budget.
 */
function probe(scene: Scene, prediction: Prediction, passes: readonly PredictionPass[], state: PredictionState,
  plan: Probe, controller: SceneShadowController | null): boolean {
  const engine = scene.getEngine();
  const effects = (engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects;
  const current = engine.currentRenderPassId;
  // An object pass leaves a light holding a standby map unshadowed (it binds admitted maps only): resolving no
  // generator for it gives the same defines without touching its shadow flag. The predicted light keeps its standby
  // map, which comes back with its admission.
  const objectMaps = new Map(plan.maps);
  if (controller) for (const light of scene.lights)
    if (light !== prediction.light && !objectMaps.has(light) && light.isEnabled() && controller.boundGenerator(light) &&
      !controller.generator(light)) objectMaps.set(light, null);
  const prepare = (pass: number, ready: () => void) => {
    const count = Object.keys(effects).length;
    engine.currentRenderPassId = pass;
    ready();
    state.budget -= Object.keys(effects).length - count;
    return state.budget > 0;
  };
  try {
    for (const mesh of scene.meshes) {
      if (mesh instanceof InstancedMesh || mesh.isDisposed() || !mesh.subMeshes?.length || !plan.receivers(mesh)) continue;
      const { plain, instanced } = mesh instanceof Mesh ? drawnMaterialVariants(mesh) : { plain: true, instanced: false };
      for (const subMesh of mesh.subMeshes) {
        const material = subMesh.getMaterial();
        if (!material) continue;
        for (const pass of passes) {
          const defines = subMesh._getDrawWrapper(pass.id)?.defines;
          // The view never prepared this mesh in that pass.
          if (!(defines instanceof MaterialDefines)) continue;
          for (const useInstances of [false, true]) {
            if (useInstances ? !instanced : !plain) continue;
            const id = predictionPass(engine, state, prediction, `${pass.id}:${useInstances ? 1 : 0}`, engine.getRenderPassNames()[pass.id] ?? `${pass.id}`);
            const wrapper = subMesh._getDrawWrapper(id, true)!;
            if (prediction.prepared.has(wrapper)) continue;
            prediction.prepared.add(wrapper);
            wrapper.defines = copyDefines(defines);
            // As the admission marks receivers: their light defines, and only those, prepare again.
            wrapper.defines.markAsLightDirty();
            const ready = withShadowGenerators(pass.admittedMapsOnly ? objectMaps : plan.maps,
              () => prepare(id, () => material.isReadyForSubMesh(mesh, subMesh, useInstances)));
            if (!ready) return false;
          }
        }
      }
    }
    // The casters' depth variants of a standby map, which renders again once its light is admitted (or of the
    // prediction map standing in for the first map of a kind).
    const generator = plan.casters;
    if (generator) prediction.casters = true;
    // A map just built (a prediction map) imports its depth shaders first, and until then prepares no caster: the
    // probe finishes in a later frame.
    if (generator && !(generator as unknown as { _shadersLoaded: boolean })._shadersLoaded) return false;
    for (const mesh of generator?.getShadowMap()?.renderList ?? []) {
      if (mesh instanceof InstancedMesh || mesh.isDisposed() || !mesh.subMeshes?.length) continue;
      const { plain, instanced } = mesh instanceof Mesh ? drawnMaterialVariants(mesh) : { plain: true, instanced: false };
      for (const subMesh of mesh.subMeshes) {
        const material = subMesh.getMaterial();
        if (!material || !subMesh.verticesCount || (generator!.customAllowRendering && !generator!.customAllowRendering(subMesh))) continue;
        const transparent = material.needAlphaBlendingForMesh(subMesh.getRenderingMesh());
        for (const useInstances of [false, true]) {
          if (useInstances ? !instanced : !plain) continue;
          const id = predictionPass(engine, state, prediction, `depth:${useInstances ? 1 : 0}`, "shadow depth");
          const wrapper = subMesh._getDrawWrapper(id, true)!;
          if (prediction.prepared.has(wrapper)) continue;
          prediction.prepared.add(wrapper);
          if (!prepare(id, () => generator!.isReady(subMesh, useInstances, transparent))) return false;
        }
      }
    }
    return true;
  } finally {
    engine.currentRenderPassId = current;
    scene.resetCachedMaterial();
  }
}

/** Failures of prediction-map renders already reported, by scene. */
const mapRenderFailures = new WeakMap<Scene, Set<string>>();

/**
 * Renders a prediction's map (`warmPredictionMap`), which never throws out of the frame: one that fails is not
 * rendered again (its casters' pipelines are created at the admission, as without prediction), and each distinct
 * failure is reported once per scene.
 */
function warmPredictionMapSafely(scene: Scene, prediction: Prediction, state: PredictionState): void {
  try {
    warmPredictionMap(scene, prediction, state);
  } catch (error) {
    prediction.mapWarm = true;
    const message = String(error);
    let reported = mapRenderFailures.get(scene);
    if (!reported) mapRenderFailures.set(scene, (reported = new Set()));
    if (reported.has(message)) return;
    reported.add(message);
    console.warn(`[render] Prediction map render failed: ${message}`);
  }
}

/**
 * WebGPU: renders a prediction's prediction map after the view's graph render, inside the Engine frame and a warm
 * deferral scope that admits only the map's own render passes: every listed caster's draw is skipped, and every
 * missing depth pipeline starts creating asynchronously, with the shadow pass's target state (a map's format, not its
 * size, keys the pipeline). At most `PREDICTION_MAP_RENDERS_PER_FRAME` run per Engine frame. The map is attached to no
 * light and its output is never sampled.
 */
function warmPredictionMap(scene: Scene, prediction: Prediction, state: PredictionState): void {
  const engine = scene.getEngine();
  const map = prediction.map?.getShadowMap();
  if (!pipelinesDeferred(engine) || !map || state.mapRenders <= 0) return;
  const passes = new Set(map.renderPassIds);
  const scope = beginPipelineDeferral(engine, (pass) => passes.has(pass), { warm: true });
  if (!scope) return;
  state.mapRenders--;
  // Every caster the probe prepared draws: the map's own culling follows its light where it is now, short of the
  // admission, and would leave out casters the real map draws once the light is admitted.
  const generator = prediction.map!;
  const list = map.getCustomRenderList;
  const allow = generator.customAllowRendering;
  map.getCustomRenderList = () => map.renderList;
  generator.customAllowRendering = () => true;
  try {
    // The view's camera, matrices, scene UBO, pass, viewport and colour write come back after the map's pass.
    withSceneReadinessState(scene, () => map.render());
  } finally {
    map.getCustomRenderList = list;
    generator.customAllowRendering = allow;
    scope.close();
    // The pipelines it started, a failed render's included, go with their Effects.
    for (const [effect, node] of scope.pipelineEffects?.() ?? []) {
      let nodes = prediction.pipelines.get(effect as Effect);
      if (!nodes) prediction.pipelines.set(effect as Effect, (nodes = new Set()));
      nodes.add(node);
    }
  }
  if (scope.warmed()) prediction.mapWarm = true;
}
