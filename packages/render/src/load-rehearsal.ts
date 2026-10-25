import { DirectionalLight, PointLight, SpotLight, Vector3, type Effect, type Light, type Scene } from "@babylonjs/core";
import { WebGPUCacheRenderPipeline } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipeline";
import { DriverCompileWatch } from "./driver-compile";
import { restoreSceneLightOrder } from "./forward-light-slots";
import {
  forwardLightSelection,
  isAuthoredLightEnabled,
  restoreForwardLightSelection,
  setAuthoredLightEnabled,
} from "./light-policy";
import { sceneRenderingSettings } from "./render-settings";
import { AUTHORED_LIGHT_PREFIX, createPlayLight } from "./scene-illumination";
import { syncSceneLighting } from "./scene-lighting";
import { markSceneReadinessDirty } from "./scene-readiness-signal";
import { findSceneShadowController, sceneShadowController, type ShadowAdmissionSnapshot } from "./shadow-controller";
import type { SpawnableLight } from "./spawnable-lights";

/**
 * Light changes a load rehearses at most. The first change of each authored kind (light class and change) comes first,
 * then one spawned light of each kind Play may spawn, then the other authored changes in scene order; a scene with
 * more changes reports the rest, repeats of kinds already rehearsed, as left out. There are at most fourteen authored
 * kinds and seven spawned ones, so the budget always keeps every kind.
 */
export const LOAD_REHEARSAL_STEP_BUDGET = 48;
/**
 * A rehearsal step whose variants are not ready to draw after this long is reverted, skipped and reported, unless a
 * shader finished meanwhile: compile progress grants another budget (as loading waits renew), within the rehearsal's
 * ceiling.
 */
export const LOAD_REHEARSAL_STEP_MS = 10_000;
/**
 * The rehearsal ends this long after its first frame, whatever remains (an applied step is reverted and reported as
 * timed out, the others as left out). The first presentation's own compile watch renews its budget for
 * `SCENE_PREPARATION_CEILING_MS` (300 s) from its start, and the frame it then presents needs that room.
 */
export const LOAD_REHEARSAL_CEILING_MS = 120_000;

type RehearsalStep = { label: string; kind: string; apply(): void; revert(): void };

export interface LoadRehearsalReport {
  /** Light changes rehearsed. */
  steps: number;
  /** Rehearsed changes that drew: the others drew with Effects an earlier rehearsal frame drew. */
  drawn: number;
  /** Changes the step budget or the rehearsal's ceiling left out. */
  omitted: string[];
  /** Changes whose variants were not ready to draw within `LOAD_REHEARSAL_STEP_MS` (or when the ceiling came), and
   * "starting state" when the starting state never settled. */
  timedOut: string[];
  /**
   * Changes after whose revert a light that held a shadow map (admitted or standby) holds none: most often a standby map
   * the change released (a standby map comes only from a map that lost its admission, so nothing rebuilds it), or a map
   * the restore could not allocate again. The scene then presents without it, until that light is admitted again.
   */
  unrestored: string[];
  /** Effects the rehearsal compiled (new entries in the Engine's cache). */
  variants: number;
  /** WebGPU render pipelines it created (Babylon's pipeline-cache misses). */
  pipelines: number;
  /** Time from its first frame to the loading frame after its last step. */
  ms: number;
}

export interface LoadRehearsal {
  /** Every step has been rehearsed (or skipped), and a loading frame has followed the last one. */
  readonly done: boolean;
  /**
   * A loading frame in which the view is ready to draw: applies the next step, draws the applied one with `draw` (true
   * once it drew) while its meshes hold an Effect no rehearsal frame drew, or reverts it.
   */
  frame(draw: () => boolean): void;
  /** Ends a step (or the starting state) that has waited `LOAD_REHEARSAL_STEP_MS`, and the whole rehearsal at
   * `LOAD_REHEARSAL_CEILING_MS`; call each loading frame. */
  check(): void;
  /** Reverts an applied step and ends the rehearsal (a superseded load). */
  cancel(): void;
  /** Releases the Effects it keeps compiled (a new world load: Play keeps one Scene across its loads). */
  release(): void;
  report(): LoadRehearsalReport;
}

/**
 * The light changes gameplay can make, one at a time: for every authored light of `scene`, switching it off (or on),
 * and for a lit shadow-capable light, starting (or stopping) its shadows; and one light of each kind in `spawnable`
 * spawning (`spawnedLightSteps`). Combinations are left out: their count grows exponentially. The first change of each
 * authored kind leads, then the spawned lights (each a kind of its own), so the step budget leaves out repeats (many
 * identical lights, whose changes usually ask for variants an earlier one compiled) rather than a later light of
 * another class.
 */
function rehearsalSteps(scene: Scene, spawnable: readonly SpawnableLight[]): RehearsalStep[] {
  const shadows = findSceneShadowController(scene);
  const steps: RehearsalStep[] = [];
  for (const light of scene.lights) {
    if (!light.name.startsWith(AUTHORED_LIGHT_PREFIX)) continue;
    const enabled = isAuthoredLightEnabled(light);
    const kind = light.getClassName();
    steps.push({
      label: `${light.name} ${enabled ? "off" : "on"}`,
      kind: `${kind} ${enabled ? "off" : "on"}`,
      apply: () => setAuthoredLightEnabled(light, !enabled),
      revert: () => setAuthoredLightEnabled(light, enabled),
    });
    if (!shadows || !enabled || !castsShadows(light)) continue;
    const requested = shadows.requestsShadow(light);
    const priority = shadows.shadowPriority(light);
    steps.push({
      label: `${light.name} shadows ${requested ? "off" : "on"}`,
      kind: `${kind} shadows ${requested ? "off" : "on"}`,
      apply: () => shadows.register(light, !requested, priority),
      revert: () => shadows.register(light, requested, priority),
    });
  }
  const kinds = new Set<string>();
  const leading: RehearsalStep[] = [];
  const repeats: RehearsalStep[] = [];
  for (const step of steps) {
    (kinds.has(step.kind) ? repeats : leading).push(step);
    kinds.add(step.kind);
  }
  return [...leading, ...spawnedLightSteps(scene, spawnable), ...repeats];
}

function castsShadows(light: Light): boolean {
  return light instanceof DirectionalLight || light instanceof PointLight || light instanceof SpotLight;
}

/**
 * One step per kind of light in `spawnable` (its light type, and for a shadow-capable one whether it casts shadows:
 * nothing else Play sets on a light changes a receiver's defines, and every map of a type takes the scene's shadow
 * settings), of the template with the highest shadow priority. Each adds that light as Play builds a spawned light part
 * (`createPlayLight`), lit, at the active camera and facing its way, where the Forward budget ranks it nearest and a
 * shadow map ranks it at its own priority, as for a spawn at the player; reverting it disposes the light.
 *
 * The stand-in reaches as far as the shadow distance, however short its template's range: a local map draws only the
 * casters within its light's range, and the camera can be far from them (high above, or behind a third-person pawn),
 * while a real spawn near the player draws the casters around it. A caster the stand-in's map never draws would have
 * its depth variant compiled (every caster's, by the readiness probe) but never drawn, so a real spawn's map would
 * create its WebGPU pipeline synchronously in the shadow pass, and iPad WebKit would pay its first draw then. Range
 * changes no define, and at the camera the stand-in is inside the shadows' relevant area whatever its range. Posing it
 * at the player's pawn instead would need the game's possession, which the render side does not know.
 */
function spawnedLightSteps(scene: Scene, spawnable: readonly SpawnableLight[]): RehearsalStep[] {
  const kinds = new Map<string, SpawnableLight>();
  for (const template of spawnable) {
    const kind = template.kind === "hemispheric" || template.kind === "directional" || template.kind === "spot" ? template.kind : "point";
    const key = `${kind}${kind !== "hemispheric" && template.properties.castShadows === true ? " with shadows" : ""}`;
    const kept = kinds.get(key);
    if (!kept || priority(template) > priority(kept)) kinds.set(key, { kind, properties: template.properties });
  }
  return [...kinds].map(([key, template]) => {
    let staged: Light | undefined;
    return {
      label: `spawned ${key} light`,
      kind: `spawned ${key} light`,
      apply: () => {
        const { intensity, range } = template.properties;
        const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
        // Lit, also when the light starts switched off or dark: it compiles what switching it on asks for.
        staged = createPlayLight(scene, `${AUTHORED_LIGHT_PREFIX}spawned ${key}`, template.kind, {
          ...template.properties, enabled: true, intensity: (finite(intensity) ?? 0) > 0 ? intensity : undefined,
          range: Math.max(finite(range) ?? 0, sceneRenderingSettings(scene).shadows.distance),
        });
        const camera = scene.activeCamera;
        if (camera && (staged instanceof PointLight || staged instanceof SpotLight)) staged.position.copyFrom(camera.globalPosition);
        if (camera && staged instanceof SpotLight) staged.direction.copyFrom(camera.getDirection(Vector3.Forward()));
        sceneShadowController(scene).sync();
      },
      revert: () => {
        staged?.dispose();
        staged = undefined;
      },
    };
  });
}

function priority(template: SpawnableLight): number {
  const value = template.properties.shadowPriority;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The admission history a step's change can move: the Forward light selection, the shadow maps' holders, and the
 * light order (`scene.lights`, which receivers' light slots follow and admission exchanges permute).
 */
type AdmissionSnapshot = {
  forward: ReadonlySet<Light> | undefined;
  shadows: ShadowAdmissionSnapshot | undefined;
  lights: readonly Light[];
};

function snapshotAdmission(scene: Scene): AdmissionSnapshot {
  return {
    forward: forwardLightSelection(scene),
    shadows: findSceneShadowController(scene)?.snapshotAdmission(),
    lights: [...scene.lights],
  };
}

/**
 * Puts `snapshot` back once a step is reverted, as the view's own admission runs it (lighting, shadow maps, lighting):
 * both admissions rank by history (an admitted light keeps its place against a slightly nearer one, a shadow map stays
 * where it was admitted), and the step created its own (a waiting light took the switched-off light's slot or map),
 * so its revert alone would leave that light admitted. Each admits again by the snapshot's history (the shadow maps as
 * of the snapshot's time), which moves the slots and maps back, and the light order its exchanges did not restore
 * goes back too. Later admissions carry on from there as a load that never tried the change would.
 */
function restoreAdmission(scene: Scene, snapshot: AdmissionSnapshot): boolean {
  if (scene.isDisposed) return true;
  restoreForwardLightSelection(scene, snapshot.forward);
  syncSceneLighting(scene);
  const shadows = findSceneShadowController(scene);
  if (snapshot.shadows) shadows?.restoreAdmission(snapshot.shadows);
  syncSceneLighting(scene);
  restoreSceneLightOrder(scene, snapshot.lights);
  // Every light that held a map holds one again, unless the step released a standby map or a reallocation failed.
  for (const light of snapshot.shadows?.maps.keys() ?? []) if (!shadows?.boundGenerator(light)) return false;
  return true;
}

/**
 * Keeps every Effect the meshes of `scene` draw with, in any pass, compiled until it is released (one reference each;
 * also released when the scene is disposed). Babylon releases an Effect, its program and its WebGPU pipelines, once the
 * last draw wrapper using it is disposed: a shadow map that stops disposes its casters' depth wrappers, so starting it
 * again would compile them anew mid-game. `hold` retains the Effects the meshes hold now and returns them.
 */
function effectRetainer(scene: Scene): { hold(): Set<Effect>; release(): void } {
  const retained = new Set<Effect>();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    scene.onDisposeObservable.remove(disposed);
    for (const effect of retained) effect.dispose();
    retained.clear();
  };
  const disposed = scene.onDisposeObservable.addOnce(release);
  return {
    hold() {
      const held = new Set<Effect>();
      if (scene.isDisposed) return held;
      // Instances share their source's submeshes.
      const seen = new Set<object>();
      for (const mesh of scene.meshes) {
        for (const subMesh of mesh.subMeshes ?? []) {
          if (seen.has(subMesh)) continue;
          seen.add(subMesh);
          for (const wrapper of subMesh._drawWrappers) {
            const effect = wrapper?.effect;
            if (!effect || effect.isDisposed) continue;
            held.add(effect);
            if (released || retained.has(effect)) continue;
            effect._refCount += 1;
            retained.add(effect);
          }
        }
      }
      return held;
    },
    release,
  };
}

/**
 * Rehearses a loaded Play scene's enumerable light changes behind its loading screen, so their variants are compiled
 * and drawn once before the first presented frame: each change is applied, the view's strict readiness requests its
 * variants on the meshes' own draw wrappers (the variants a real change asks for, defines order included), frames
 * draw them (a program's first use, a WebGPU pipeline) while the meshes hold an Effect no rehearsal frame drew (a
 * draw's post-draw probe can ask for more, which the next ready frame draws), and the change is reverted with the
 * admission history it found (`restoreAdmission`). A change whose meshes hold only Effects an earlier rehearsal frame
 * drew is not drawn. The Effects of the starting state and of each step stay compiled until `release`. The caller draws
 * only on frames the view is ready for, and hides what they draw.
 *
 * The starting state draws first, then waits for `settled` (the views its first draw created, such as a Full Quality
 * capture's, have prepared) and draws again while it holds anything undrawn: a view first prepared during a step
 * would build its draw wrappers' defines in that step's order, and Babylon keys Effects by the defines text, so the
 * starting state would compile again for it once the step is reverted.
 *
 * `spawnable` lists the light parts Play may spawn: one of each kind is added and removed as a step. Each adds a
 * light to the Scene, so the caller reserves room for one more in the light inventory before the load compiles
 * anything (`reserveSceneLightInventory`), or the step would raise every lit Material's light capacity.
 */
export function createLoadRehearsal(
  scene: Scene, settled: () => boolean = () => true, spawnable: readonly SpawnableLight[] = [],
): LoadRehearsal {
  const all = rehearsalSteps(scene, spawnable);
  const steps = all.slice(0, LOAD_REHEARSAL_STEP_BUDGET);
  const omitted = all.slice(LOAD_REHEARSAL_STEP_BUDGET).map((step) => step.label);
  const timedOut: string[] = [];
  const unrestored: string[] = [];
  const engine = scene.getEngine();
  const compiled = () => Object.keys((engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects).length;
  const effectsBefore = compiled();
  const pipelinesBefore = WebGPUCacheRenderPipeline.NumCacheMiss;
  const effects = effectRetainer(scene);
  /** Effects the meshes held when a rehearsal frame drew. */
  const drawnEffects = new WeakSet<Effect>();
  let index = 0;
  let rehearsed = 0;
  let drawn = 0;
  /** The starting state is still drawing (before the first step). */
  let starting = steps.length > 0;
  let startDrew = false;
  let applied = false;
  let stepDrew = false;
  /** The admission history before the applied step. */
  let admission: AdmissionSnapshot | undefined;
  /** When the applied step (or the starting state) began, for its budget. */
  let phaseSince = 0;
  /** Compile progress over the whole rehearsal: its ceiling is the rehearsal's. */
  let watch: DriverCompileWatch | undefined;
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
  const revert = () => {
    const step = steps[index]!;
    step.revert();
    if (admission && !restoreAdmission(scene, admission)) unrestored.push(step.label);
    admission = undefined;
    markSceneReadinessDirty(scene);
    applied = false;
    stepDrew = false;
  };
  const advance = (timed: boolean) => {
    const step = steps[index]!;
    revert();
    if (timed) timedOut.push(step.label);
    else rehearsed += 1;
    index += 1;
  };
  /**
   * Draws when the meshes hold an Effect no rehearsal frame drew (or `force`): "none" when there is nothing to draw,
   * "drew", or "waiting" when `draw` could not draw yet (WebGPU pipelines still compiling).
   */
  const drawUndrawn = (draw: () => boolean, force = false): "none" | "drew" | "waiting" => {
    const held = effects.hold();
    let undrawn = force;
    for (const effect of held) if (!drawnEffects.has(effect)) undrawn = true;
    if (!undrawn) return "none";
    if (!draw()) return "waiting";
    // Only what the meshes held as it drew: Effects its post-draw probe requested draw in the next ready frame.
    for (const effect of held) drawnEffects.add(effect);
    return "drew";
  };
  /** Ends the rehearsal at its ceiling: an applied step reverted, as timed out, and the rest left out. */
  const end = () => {
    if (applied) {
      timedOut.push(steps[index]!.label);
      revert();
      index += 1;
    } else if (starting) timedOut.push("starting state");
    starting = false;
    omitted.push(...steps.slice(index).map((step) => step.label));
    index = steps.length;
    finish();
  };
  if (!steps.length) {
    startedAt = endedAt = performance.now();
  }
  return {
    get done() {
      return endedAt !== undefined;
    },
    frame(draw) {
      if (endedAt !== undefined) return;
      // One more loading frame after the last step: it starts once the last draw's GPU work let it, so the duration
      // includes that work.
      if (index >= steps.length) {
        finish();
        return;
      }
      if (startedAt === undefined) {
        startedAt = phaseSince = performance.now();
        watch = new DriverCompileWatch(engine, startedAt, LOAD_REHEARSAL_CEILING_MS);
      }
      if (starting) {
        // Views the first draw created prepare on their own; wait for them without drawing.
        if (startDrew && !settled()) return;
        const result = drawUndrawn(draw, !startDrew);
        if (result === "drew") startDrew = true;
        if (result !== "none") return;
        starting = false;
      }
      if (!applied) {
        admission = snapshotAdmission(scene);
        // Before `apply`, so a step that throws midway (its stand-in added, a shadow sync failing) is still reverted.
        applied = true;
        steps[index]!.apply();
        markSceneReadinessDirty(scene);
        phaseSince = performance.now();
        watch!.restart();
        return;
      }
      const result = drawUndrawn(draw);
      if (result === "drew" && !stepDrew) {
        drawn += 1;
        stepDrew = true;
      }
      if (result !== "none") return;
      advance(false);
    },
    check() {
      if (endedAt !== undefined || startedAt === undefined) return;
      const now = performance.now();
      if (now - startedAt >= LOAD_REHEARSAL_CEILING_MS) {
        end();
        return;
      }
      if (!applied && !starting) return;
      if (now - phaseSince < LOAD_REHEARSAL_STEP_MS) return;
      if (watch!.renew(now)) phaseSince = now;
      else if (applied) advance(true);
      else {
        // The starting state never settled: rehearse from it as it is.
        starting = false;
        timedOut.push("starting state");
      }
    },
    cancel() {
      if (endedAt !== undefined) return;
      if (applied) revert();
      starting = false;
      index = steps.length;
      finish();
    },
    release: effects.release,
    report: () => ({
      steps: rehearsed, drawn, omitted, timedOut, unrestored, variants, pipelines,
      ms: (endedAt ?? performance.now()) - (startedAt ?? performance.now()),
    }),
  };
}
