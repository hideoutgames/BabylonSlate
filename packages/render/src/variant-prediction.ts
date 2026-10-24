import {
  Constants, InstancedMesh, MaterialDefines, Mesh, type AbstractEngine, type AbstractMesh, type Effect, type Light, type Scene,
  type ShadowGenerator, type SubMesh,
} from "@babylonjs/core";
import { drawnMaterialVariants } from "./drawn-variants";
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
import { copyDefines, settleWarmedEffect, withPredictedEffects } from "./variant-pipeline-warmup";
import { beginPipelineDeferral, deferredPipelineCount, pipelinesDeferred, releaseWarmPipelines } from "./webgpu-pipeline-deferral";

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
/** Render pipelines prediction warm draws start creating per Engine frame (WebGPU), shared by every view on it. */
export const PREDICTED_PIPELINES_PER_FRAME = 2;
/** Predictions held at once; a new one drops the least recently near. */
export const PREDICTIONS_MAX = 4;
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
  /** Receivers its object passes would draw, for the warm draws that create their pipelines (WebGPU). */
  receivers: PredictedDraw[];
  /** Pipeline-cache nodes its warm draws looked up, by Effect: released with an Effect nothing else holds. */
  pipelines: Map<Effect, Set<object>>;
  /** Every receiver's warm draws found their pipelines, and its Effects are settled. */
  warm: boolean;
  complete: boolean;
  lastNear: number;
};

/**
 * One receiver draw an admission would make: the real pass, the prediction pass whose wrapper holds the variant, the
 * instancing it was prepared for, and the lights and maps it binds (what the probe saw, the what-if's included).
 */
type PredictedDraw = {
  mesh: Mesh;
  subMesh: SubMesh;
  real: number;
  pass: number;
  instanced: boolean;
  lights: Light[];
  maps: ReadonlyMap<Light, ShadowGenerator | null>;
};

type PredictionState = {
  frame: number;
  budget: number;
  /** Pipelines warm draws may still start in this Engine frame. */
  pipelineBudget: number;
  predictions: Map<Light, Prediction>;
  /**
   * Render pass ids dropped predictions gave back, for the next to reuse: Babylon numbers pass ids from one counter it
   * never rewinds, and every submesh's draw wrapper list grows to the highest id it was prepared under.
   */
  free: number[];
  /** Scenes whose disposal drops their predictions. */
  watched: WeakSet<Scene>;
};

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
    state = { frame: -1, budget: 0, pipelineBudget: 0, predictions: new Map(), free: [], watched: new WeakSet() };
    states.set(engine, state);
    const created = state;
    engine.onDisposeObservable.addOnce(() => created.predictions.clear());
  }
  if (state.frame !== engine.frameId) {
    state.frame = engine.frameId;
    state.budget = PREDICTED_COMPILES_PER_FRAME;
    state.pipelineBudget = PREDICTED_PIPELINES_PER_FRAME;
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
  prediction.receivers.length = 0;
  const pipelines = [...prediction.pipelines];
  prediction.pipelines.clear();
  // After the frame, when no pass draws: the wrappers and their Effect references go at once.
  engine.onEndFrameObservable.addOnce(() => {
    if (engine.isDisposed) return;
    for (const scene of engine.scenes)
      for (const mesh of scene.meshes)
        for (const subMesh of mesh.subMeshes ?? []) for (const pass of passes) subMesh._removeDrawWrapper(pass, true, true);
    state.free.push(...passes);
    // An Effect that left the cache (only the prediction held it) takes the pipelines its warm draws created along.
    const cached = new Set(Object.values((engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects));
    for (const [effect, nodes] of pipelines) if (!cached.has(effect)) releaseWarmPipelines(engine, nodes);
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
  const forward = nearForwardAdmissions(scene, PREDICTION_MARGIN);
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
    if (prediction.light.isDisposed() || cameTrue(prediction, controller) || prediction.context !== context) {
      drop(state, prediction);
      continue;
    }
    if (near.has(prediction.light)) prediction.lastNear = now;
    else if (now - prediction.lastNear >= PREDICTION_EXPIRY_MS) drop(state, prediction);
  }
  if (state.budget <= 0) return;
  const light = [...near].find((candidate) => !state.predictions.get(candidate)?.complete);
  if (!light) return;
  let prediction = state.predictions.get(light);
  if (!prediction) {
    if (state.predictions.size >= PREDICTIONS_MAX) {
      let oldest: Prediction | undefined;
      for (const other of state.predictions.values()) if (!oldest || other.lastNear < oldest.lastNear) oldest = other;
      if (oldest) drop(state, oldest);
    }
    prediction = { scene, light, admission: forward.includes(light) ? "forward" : "shadow", context, passes: new Map(),
      prepared: new WeakSet(), receivers: [], pipelines: new Map(), warm: false, complete: false, lastNear: now };
    state.predictions.set(light, prediction);
  }
  const target = prediction;
  const start = shadows.find((candidate) => candidate.light === light);
  const run = (plan: Probe) =>
    withPredictedEffects(engine, () => withSceneReadinessState(scene, () => probe(scene, target, passes, state, plan, controller)));
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
    : start ? run(shadowStart(controller, start)) : true);
}

/** The standby map `light` holds, which comes back with its admission. */
function standbyMap(controller: SceneShadowController | null, light: Light): ShadowGenerator | null {
  return controller && !controller.generator(light) ? controller.boundGenerator(light) : null;
}

/**
 * A shadow start for a light already lit: its receivers bind a map of its kind (its own standby one, or a borrowed
 * admitted one with the same defines), and the holder it displaces binds none.
 */
function shadowStart(controller: SceneShadowController | null, start: ShadowStartPrediction): Probe {
  const maps = new Map<Light, ShadowGenerator | null>();
  if (start.borrowed) maps.set(start.light, start.borrowed);
  if (start.displaced) maps.set(start.displaced, null);
  const lit = [start.light, ...(start.displaced ? [start.displaced] : [])];
  return {
    receivers: (mesh) => mesh.receiveShadows && lit.some((light) => mesh.lightSources.includes(light)),
    maps,
    casters: standbyMap(controller, start.light),
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
  try {
    withForwardAdmissionPromotion(light, PREDICTION_PROMOTION, () => syncSceneLighting(scene));
    return isForwardLightExcluded(light) ? true : probe(before);
  } finally {
    restoreForwardLightSelection(scene, selection);
    syncSceneLighting(scene);
    restoreSceneLightOrder(scene, order);
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
            if (pass.admittedMapsOnly && mesh instanceof Mesh)
              prediction.receivers.push({ mesh, subMesh, real: pass.id, pass: id, instanced: useInstances, lights: mesh.lightSources.slice(), maps: objectMaps });
            const ready = withShadowGenerators(pass.admittedMapsOnly ? objectMaps : plan.maps,
              () => prepare(id, () => material.isReadyForSubMesh(mesh, subMesh, useInstances)));
            if (!ready) return false;
          }
        }
      }
    }
    // The casters' depth variants of a standby map, which renders again once its light is admitted.
    const generator = plan.casters;
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

/**
 * Inside a world view's main object pass, after its real draws and before it restores its lights' shadow flags
 * (WebGPU): draws each receiver of the scene's complete predictions again under its prediction pass, with the lights
 * and maps the prediction saw substituted, inside a warm deferral scope, so the predicted variants' render pipelines
 * are created ahead with the real pass's target and state. Every warm draw is skipped before it creates a bind group
 * (the pipeline lookup comes first); its uniform writes go to buffers Babylon renews when updated again in a frame, and
 * to the predicted Effect's own draw wrappers, so no presented draw sees them. A prediction whose warm draws all found
 * their pipelines settles its Effects, so its admission draws them at once.
 */
export function warmPredictedPipelines(scene: Scene, objectPass: number, depthPrePass: number): void {
  const engine = scene.getEngine();
  if (!pipelinesDeferred(engine)) return;
  const state = states.get(engine);
  if (!state?.predictions.size) return;
  stateFor(engine);
  const current = engine.currentRenderPassId;
  const alpha = Math.max(0, engine.getAlphaMode());
  const colour = engine.getColorWrite();
  try {
    for (const prediction of [...state.predictions.values()]) {
      if (prediction.scene !== scene || !prediction.complete || prediction.warm) continue;
      let warm = true;
      for (const draw of prediction.receivers) {
        if (draw.real !== objectPass && draw.real !== depthPrePass) continue;
        if (state.pipelineBudget <= 0) return;
        const result = warmDraw(engine, prediction, draw, draw.real === depthPrePass);
        if (result === "stale") {
          drop(state, prediction);
          warm = false;
          break;
        }
        if (result !== "warm") warm = false;
      }
      if (!warm) continue;
      prediction.warm = true;
      for (const effect of prediction.pipelines.keys()) settleWarmedEffect(engine, effect);
    }
  } finally {
    engine.currentRenderPassId = current;
    engine.setAlphaMode(alpha);
    engine.setColorWrite(colour);
    scene.resetCachedMaterial();
  }
}

/**
 * One skipped draw of a predicted receiver: "warm" once it found its pipeline, "cold" while its pipeline is being
 * created (or the mesh draws with other instancing now), "stale" when its wrapper no longer holds the predicted variant.
 */
function warmDraw(engine: AbstractEngine, prediction: Prediction, draw: PredictedDraw, depthPrePass: boolean): "warm" | "cold" | "stale" {
  const state = states.get(engine)!;
  const { mesh, subMesh } = draw;
  if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible) return "cold";
  const wrapper = subMesh._getDrawWrapper(draw.pass);
  const effect = wrapper?.effect;
  if (!effect || !(wrapper.defines instanceof MaterialDefines)) return "stale";
  // The variant the mesh draws now: a pass prepared for the other instancing would ask for another Effect.
  const batch = (mesh as unknown as { _getInstancesRenderList(id: number): { hardwareInstancedRendering: boolean[] } })._getInstancesRenderList(subMesh._id);
  const instanced = !!batch.hardwareInstancedRendering[subMesh._id] || mesh.hasThinInstances;
  if (instanced !== draw.instanced) return "cold";
  const material = subMesh.getMaterial();
  if (!material) return "cold";
  const scope = beginPipelineDeferral(engine, (pass) => pass === draw.pass, { warm: true });
  if (!scope) return "warm";
  // Its defines hold the predicted variant: lighting syncs since (the what-if's own restore among them) marked every
  // wrapper of the Material light-dirty, which would prepare the current lights' variant instead.
  wrapper.defines.markAsProcessed();
  const started = deferredPipelineCount(engine);
  const lights = (mesh as unknown as { _lightSources: Light[] })._lightSources;
  (mesh as unknown as { _lightSources: Light[] })._lightSources = draw.lights;
  engine.currentRenderPassId = draw.pass;
  engine.setColorWrite(!depthPrePass);
  engine.setAlphaMode(Constants.ALPHA_DISABLE);
  try {
    withShadowGenerators(draw.maps, () => subMesh.render(!depthPrePass && material.needAlphaBlendingForMesh(mesh)));
  } finally {
    (mesh as unknown as { _lightSources: Light[] })._lightSources = lights;
    scope.close();
  }
  state.pipelineBudget -= Math.max(0, deferredPipelineCount(engine) - started);
  if (wrapper.effect !== effect) {
    // The draw prepared another variant: give back the reference it took, keep the predicted one, and start afresh.
    wrapper.effect?.dispose();
    wrapper.setEffect(effect, wrapper.defines);
    return "stale";
  }
  let nodes = prediction.pipelines.get(effect);
  if (!nodes) prediction.pipelines.set(effect, (nodes = new Set()));
  for (const node of scope.pipelineNodes?.() ?? []) nodes.add(node);
  return scope.warmed() ? "warm" : "cold";
}

