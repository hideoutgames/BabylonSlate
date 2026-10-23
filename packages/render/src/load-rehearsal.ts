import { DirectionalLight, PointLight, SpotLight, type Effect, type Light, type Scene } from "@babylonjs/core";
import { WebGPUCacheRenderPipeline } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipeline";
import { isAuthoredLightEnabled, setAuthoredLightEnabled } from "./light-policy";
import { AUTHORED_LIGHT_PREFIX } from "./scene-illumination";
import { renewOnCompileProgress } from "./driver-compile";
import { markSceneReadinessDirty } from "./scene-readiness-signal";
import { findSceneShadowController } from "./shadow-controller";

/**
 * Light changes a load rehearses at most. A scene with more authored lights rehearses the first ones (scene order) and
 * reports the rest as left out.
 */
export const LOAD_REHEARSAL_STEP_BUDGET = 48;
/**
 * A rehearsal step whose variants are not ready to draw after this long is reverted, skipped and reported, unless a
 * shader finished meanwhile: compile progress grants another budget (as loading waits renew), up to the preparation
 * ceiling.
 */
export const LOAD_REHEARSAL_STEP_MS = 10_000;

type RehearsalStep = { label: string; apply(): void; revert(): void };

export interface LoadRehearsalReport {
  /** Light changes rehearsed. */
  steps: number;
  /** Rehearsed changes that drew: the others drew with Effects an earlier frame drew (or the first frame draws). */
  drawn: number;
  /** Changes the step budget left out. */
  omitted: string[];
  /** Changes whose variants were not ready to draw within `LOAD_REHEARSAL_STEP_MS`. */
  timedOut: string[];
  /** Effects the rehearsal compiled (new entries in the Engine's cache). */
  variants: number;
  /** WebGPU render pipelines it created (Babylon's pipeline-cache misses). */
  pipelines: number;
  /** Time from its first frame to its last. */
  ms: number;
}

export interface LoadRehearsal {
  /** Every step has been rehearsed (or skipped). */
  readonly done: boolean;
  /**
   * A loading frame in which the view is ready to draw: applies the next step, or draws the applied one with `draw`
   * (true once its strict frame drew) and reverts it.
   */
  frame(draw: () => boolean): void;
  /** Reverts and skips a step that has waited `LOAD_REHEARSAL_STEP_MS`; call while the view is not ready. */
  check(): void;
  /** Reverts an applied step and ends the rehearsal (a superseded load). */
  cancel(): void;
  report(): LoadRehearsalReport;
}

/**
 * The light changes gameplay can make, one at a time, for every authored light of `scene` in scene order: switching
 * it off (or on), and for a lit shadow-capable light, starting (or stopping) its shadows. Combinations are left out:
 * their count grows exponentially.
 */
function rehearsalSteps(scene: Scene): RehearsalStep[] {
  const shadows = findSceneShadowController(scene);
  const steps: RehearsalStep[] = [];
  for (const light of scene.lights) {
    if (!light.name.startsWith(AUTHORED_LIGHT_PREFIX)) continue;
    const enabled = isAuthoredLightEnabled(light);
    steps.push({
      label: `${light.name} ${enabled ? "off" : "on"}`,
      apply: () => setAuthoredLightEnabled(light, !enabled),
      revert: () => setAuthoredLightEnabled(light, enabled),
    });
    if (!shadows || !enabled || !castsShadows(light)) continue;
    const requested = shadows.requestsShadow(light);
    const priority = shadows.shadowPriority(light);
    steps.push({
      label: `${light.name} shadows ${requested ? "off" : "on"}`,
      apply: () => shadows.register(light, !requested, priority),
      revert: () => shadows.register(light, requested, priority),
    });
  }
  return steps;
}

function castsShadows(light: Light): boolean {
  return light instanceof DirectionalLight || light instanceof PointLight || light instanceof SpotLight;
}

/**
 * Keeps every Effect the meshes of `scene` draw with, in any pass, compiled for the scene's lifetime (one reference
 * each, released when it is disposed). Babylon releases an Effect, its program and its WebGPU pipelines, once the last
 * draw wrapper using it is disposed: a shadow map that stops disposes its casters' depth wrappers, so starting it again
 * would compile them anew mid-game. The returned call retains the Effects the meshes hold now, and says whether any
 * was new.
 */
function effectRetainer(scene: Scene): () => boolean {
  const retained = new Set<Effect>();
  scene.onDisposeObservable.addOnce(() => {
    for (const effect of retained) effect.dispose();
    retained.clear();
  });
  return () => {
    if (scene.isDisposed) return false;
    let added = false;
    for (const mesh of scene.meshes) {
      for (const subMesh of mesh.subMeshes ?? []) {
        for (const wrapper of subMesh._drawWrappers) {
          const effect = wrapper?.effect;
          if (!effect || effect.isDisposed || retained.has(effect)) continue;
          effect._refCount += 1;
          retained.add(effect);
          added = true;
        }
      }
    }
    return added;
  };
}

/**
 * Rehearses a loaded Play scene's enumerable light changes behind its loading screen, so their variants are compiled
 * and drawn once before the first presented frame: each change is applied, the view's strict readiness requests its
 * variants on the meshes' own draw wrappers (the variants a real change asks for, defines order included), one frame
 * draws them (a program's first use, a WebGPU pipeline), and the change is reverted. A change whose meshes then hold
 * only Effects an earlier rehearsal frame drew, or the starting state's (which the first presented frame draws), is
 * not drawn. The Effects of the starting state and of each step stay compiled while the scene lives. The caller draws
 * only on frames the view is ready for, and hides what they draw.
 */
export function createLoadRehearsal(scene: Scene): LoadRehearsal {
  const all = rehearsalSteps(scene);
  const steps = all.slice(0, LOAD_REHEARSAL_STEP_BUDGET);
  const omitted = all.slice(LOAD_REHEARSAL_STEP_BUDGET).map((step) => step.label);
  const timedOut: string[] = [];
  const engine = scene.getEngine();
  const compiled = () => Object.keys((engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects).length;
  const effectsBefore = compiled();
  const pipelinesBefore = WebGPUCacheRenderPipeline.NumCacheMiss;
  const retain = effectRetainer(scene);
  let index = 0;
  let applied = false;
  let appliedAt = 0;
  let renew: ((now: number) => boolean) | undefined;
  /** The applied step's meshes hold an Effect no rehearsal frame drew yet. */
  let undrawn = false;
  let drawn = 0;
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  let variants = 0;
  let pipelines = 0;
  const finish = () => {
    if (endedAt !== undefined) return;
    endedAt = performance.now();
    variants = compiled() - effectsBefore;
    pipelines = WebGPUCacheRenderPipeline.NumCacheMiss - pipelinesBefore;
  };
  const advance = (timed: boolean) => {
    const step = steps[index]!;
    step.revert();
    markSceneReadinessDirty(scene);
    if (timed) timedOut.push(step.label);
    applied = false;
    undrawn = false;
    renew = undefined;
    index += 1;
    if (index >= steps.length) finish();
  };
  if (!steps.length) {
    startedAt = endedAt = performance.now();
  }
  return {
    get done() {
      return index >= steps.length;
    },
    frame(draw) {
      if (index >= steps.length) return;
      if (startedAt === undefined) {
        startedAt = performance.now();
        // The starting state's Effects: a step that stops a map must not release its casters' depth Effects.
        retain();
      }
      if (!applied) {
        steps[index]!.apply();
        markSceneReadinessDirty(scene);
        applied = true;
        appliedAt = performance.now();
        renew = renewOnCompileProgress(engine);
        return;
      }
      undrawn = retain() || undrawn;
      if (undrawn) {
        if (!draw()) return;
        // The draw's own Effects (a shadow map's casters drawn for the first time).
        retain();
        drawn += 1;
      }
      advance(false);
    },
    check() {
      if (!applied) return;
      const now = performance.now();
      if (now - appliedAt < LOAD_REHEARSAL_STEP_MS) return;
      if (renew?.(now)) appliedAt = now;
      else advance(true);
    },
    cancel() {
      if (applied) {
        steps[index]!.revert();
        markSceneReadinessDirty(scene);
        applied = false;
      }
      index = steps.length;
      finish();
    },
    report: () => ({
      steps: Math.min(index, steps.length) - timedOut.length, drawn, omitted, timedOut, variants, pipelines,
      ms: (endedAt ?? performance.now()) - (startedAt ?? performance.now()),
    }),
  };
}
