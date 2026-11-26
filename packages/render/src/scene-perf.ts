import type { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { NodeMaterialModes } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialModes";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { InternalTexture } from "@babylonjs/core/Materials/Textures/internalTexture";
import type { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import type { Effect } from "@babylonjs/core/Materials/effect";
import type { Material } from "@babylonjs/core/Materials/material";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene, SceneOptions } from "@babylonjs/core/scene";
import { prewarmMaterial } from "./material-compiler";
import { isEngineDefaultMaterial } from "./default-material";
import { syncSceneLighting } from "./scene-lighting";
import { isEnvironmentLightingReady } from "./environment-lighting";
import { isRenderTargetProbeReady, outsideReadinessProbeScope } from "./readiness-scope";
import { noteReadinessBlocker } from "./readiness-blockers";
import { withSceneReadinessState } from "./scene-readiness-signal";
import { createHeldThreadBudget, createStallDeadline, SCENE_SHADER_WARM_TIMEOUT_MS } from "./stall-deadline";
import { DriverCompileWatch } from "./driver-compile";
import { drawnMaterialVariants } from "./drawn-variants";
import { drawingMesh, isInstanceSource } from "./instance-source";
import { admittedSceneMeshes, admittedSceneParticles, admittedSceneTextures } from "./scene-stream-admission";
import { noteVariantSwap, variantSwapsTolerated } from "./variant-swaps";
import { collectEffectRequests } from "./effect-requests";
import {
  hasDrawn, hasDrawnItself, hideUntilReady, isRevealPending, noteDrawn, noteRevealFailed, noteRevealProbe,
} from "./reveal-pending";
import { awaitsFirstDraw } from "./shadow-first-draw";
// Re-exported for in-package importers of this module. Modules in scene-perf's
// transitive import graph must import these from the leaves, or they close an
// import cycle back through this file.
export {
  markSceneReadinessDirty, onSceneReadinessDirty, type SceneReadinessDirtyReason, withSceneReadinessState,
} from "./scene-readiness-signal";
export {
  createStallDeadline,
  SCENE_DRIVER_COMPILE_TIMEOUT_MS,
  SCENE_FIRST_FRAME_TIMEOUT_MS,
  SCENE_SHADER_WARM_TIMEOUT_MS,
  type StallDeadline,
} from "./stall-deadline";

/** Fast large-scene lookups (§2.4). Babylon 9 defaults these on; pass them explicitly. */
export const SCENE_LOOKUP_MAPS: SceneOptions = {
  useGeometryUniqueIdsMap: true,
  useMaterialMeshMap: true,
  useClonedMeshMap: true,
};

const MATERIAL_LIBRARY_PREFIX = "material:";

export function materialLibraryAssetGuid(material: Material): string | null {
  if (!material.name.startsWith(MATERIAL_LIBRARY_PREFIX)) return null;
  return material.name.slice(MATERIAL_LIBRARY_PREFIX.length);
}

function shouldManageMaterialFreeze(material: Material): boolean {
  if (isEngineDefaultMaterial(material)) return true;
  if (!(material instanceof NodeMaterial)) return false;
  if (material.mode === NodeMaterialModes.Particle) return false;
  return material.name.startsWith(MATERIAL_LIBRARY_PREFIX);
}

export function applyEditorMaterialFreeze(
  scene: Scene,
  editingGuids: ReadonlySet<string>,
): void {
  for (const material of scene.materials) {
    if (!shouldManageMaterialFreeze(material)) continue;
    const guid = materialLibraryAssetGuid(material);
    const editing = guid !== null && editingGuids.has(guid);
    if (editing) {
      if (material.isFrozen) material.unfreeze();
    } else if (!material.isFrozen) {
      material.freeze();
    }
  }
}

function describeShaderStall(stalled: string | null, completed: number): string {
  const where = stalled ? ` Stalled compiling ${stalled}` : "";
  return `Scene shaders did not become ready before the loading deadline.${where} after ${completed} compiled variant${completed === 1 ? "" : "s"}.`;
}

/**
 * Babylon rejects a failed compile with the bare shader log, a string. The warm-up is where a first acquisition's
 * program first links, so the failure names the Material and mesh it was for.
 */
async function attributeCompileFailure(unit: string, compile: () => Promise<void>): Promise<void> {
  try {
    await compile();
  } catch (error) {
    throw new Error(`Shader compilation failed for ${unit}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Whether `mesh` still draws with `material` (directly, through its MultiMaterial, or as the scene default). */
function drawsWith(mesh: AbstractMesh, material: Material): boolean {
  const current = mesh.material ?? mesh.getScene().defaultMaterial;
  return current === material || (current instanceof MultiMaterial && current.subMaterials.includes(material));
}

/**
 * `compile`, or nothing once the mesh no longer draws `material` or either is disposed: Babylon's `forceCompilation`
 * never settles for a Material disposed while it polls (a Skybox whose cube failed drops and disposes its material),
 * and nothing would draw that variant. A unit waiting behind another can find its Material gone by its turn.
 */
function compileUnlessDisposed(material: Material, mesh: AbstractMesh, compile: () => Promise<void>): Promise<void> {
  if (mesh.isDisposed() || !drawsWith(mesh, material)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const materialGone = material.onDisposeObservable.addOnce(() => resolve());
    const meshGone = mesh.onDisposeObservable.addOnce(() => resolve());
    void compile().then(resolve, reject).finally(() => {
      material.onDisposeObservable.remove(materialGone);
      mesh.onDisposeObservable.remove(meshGone);
    });
  });
}

/** Shader warm-up units compiling at once, across Materials (one Material's units run in order). */
export const SCENE_SHADER_WARM_CONCURRENCY = 8;

/**
 * `skipMesh` names meshes whose drawn variant a later readiness probe compiles under the pass that draws them (built-in
 * water, whose variant depends on the pass), so warming the pass-less variant here could compile one nothing draws.
 */
export async function prewarmSceneMaterials(
  scene: Scene,
  assertCurrent?: () => void,
  skipMesh?: (mesh: AbstractMesh) => boolean,
  onProgress?: (count: { done: number; total: number }) => void,
): Promise<void> {
  await prewarmMeshMaterials(scene, scene.meshes, assertCurrent, skipMesh, onProgress);
}

/**
 * Captures every mesh property that can alter a Material's compiled shader defines so
 * `prewarmMeshMaterials` compiles each distinct `(Material, variant)` once per warm-up
 * instead of serially re-warming dozens of identical static meshes.
 */
function meshShaderVariantKey(mesh: Mesh, material: Material, useInstances: boolean): string {
  const scene = mesh.getScene();
  const kinds = mesh.getVerticesDataKinds();
  kinds.sort();
  const colorSize = mesh.getVertexBuffer("color")?.getSize() ?? 0;
  const skeleton = mesh.skeleton
    ? `${mesh.skeleton.bones.length}:${mesh.numBoneInfluencers}:${mesh.computeBonesUsingShaders ? 1 : 0}:${mesh.skeleton.isUsingTextureForMatrices ? 1 : 0}`
    : "0";
  const morphs = mesh.morphTargetManager
    ? `${mesh.morphTargetManager.numInfluencers}:${mesh.morphTargetManager.supportsNormals ? 1 : 0}:${mesh.morphTargetManager.supportsTangents ? 1 : 0}:${mesh.morphTargetManager.supportsUVs ? 1 : 0}:${mesh.morphTargetManager.isUsingTextureForTargets ? 1 : 0}`
    : "0";
  const meta = mesh.metadata as Record<string, unknown> | null | undefined;
  const clipPlanes =
    (scene.clipPlane ? 1 : 0) |
    (scene.clipPlane2 ? 2 : 0) |
    (scene.clipPlane3 ? 4 : 0) |
    (scene.clipPlane4 ? 8 : 0) |
    (scene.clipPlane5 ? 16 : 0) |
    (scene.clipPlane6 ? 32 : 0);
  const flags =
    (useInstances ? 1 : 0) |
    (mesh.hasThinInstances ? 2 : 0) |
    (mesh.instances.length > 0 ? 4 : 0) |
    (mesh.receiveShadows ? 8 : 0) |
    (mesh.hasVertexAlpha ? 16 : 0) |
    (mesh.useVertexColors ? 32 : 0) |
    (mesh.applyFog ? 64 : 0) |
    (meta?.text2dGlyph ? 128 : 0) |
    (meta?.latticeDeformer ? 256 : 0) |
    (meta?.drawBatch ? 512 : 0) |
    (meta?.overlayStyle ? 1024 : 0) |
    (mesh.visibility < 1 ? 2048 : 0);
  const lights = material instanceof NodeMaterial ? "" : mesh.lightSources.map((light) => light.uniqueId).join(",");
  // Text2D glyph atlases bind per-mesh in TextMaterialBlock.isReady; keep those meshes distinct.
  const perMeshId = meta?.text2d || meta?.text2dGlyph ? `:${mesh.uniqueId}` : "";
  return `${flags}|${clipPlanes}|${colorSize}|${mesh.overrideMaterialSideOrientation ?? -1}|${kinds.join(",")}|${skeleton}|${morphs}|${lights}${perMeshId}`;
}

/** True when every live submesh of `mesh` drawing `material` already holds a ready, clean Effect. */
function isMaterialVariantAlreadyReady(mesh: Mesh, material: Material, useInstances: boolean): boolean {
  if (useInstances || !mesh.subMeshes?.length) return false;
  let matched = false;
  for (const part of mesh.subMeshes) {
    const partMaterial = part.getMaterial();
    if (partMaterial !== material) continue;
    matched = true;
    const wrapper = material._storeEffectOnSubMeshes
      ? part._drawWrapperOverride ?? part._getDrawWrapper()
      : material._getDrawWrapper();
    if (!wrapper?.effect?.isReady()) return false;
    if (wrapper._wasPreviouslyUsingInstances !== useInstances) return false;
    if (material._storeEffectOnSubMeshes) {
      const defines = part.materialDefines;
      if (!defines || defines.isDirty || defines._renderId === -1) return false;
    } else if (part.materialDefines?.isDirty) {
      return false;
    }
  }
  return matched;
}

/**
 * Warm only an additive instance's consumers, without waiting on sibling loads. `onProgress` counts the units (one
 * unique Material variant; meshes sharing a Material and shader-define signature share one unit) before the first and
 * after each; a mesh added meanwhile raises the total. With `onProgress`, `meshes` must be iterable twice (an array, as
 * `scene.meshes`).
 */
export async function prewarmMeshMaterials(
  scene: Scene,
  given: Iterable<AbstractMesh>,
  assertCurrent?: (mesh?: AbstractMesh) => void,
  skipMesh?: (mesh: AbstractMesh) => boolean,
  onProgress?: (count: { done: number; total: number }) => void,
): Promise<void> {
  // An instance draws in its source's batch: the source compiles, once (a pool source, instanced only).
  const meshes = new Set([...given].map(drawingMesh));
  let finished = false;
  const check = (mesh?: AbstractMesh) => {
    // The owner's check first: it names why (a superseded load) before its deferred Scene disposal does.
    assertCurrent?.(mesh);
    if (finished || scene.isDisposed) throw new Error("Scene shader warming was cancelled.");
  };
  check();
  syncSceneLighting(scene);
  // A unit can outlast the budget while it compiles: variants that finished since the last renewal (each synchronous
  // link), or a parallel compile pending on the driver (which reports completion only), are not a stall. Like every
  // stall deadline, a timer that fires a held gap late (a hidden page, a call that held the thread and finished no
  // variant) also starts a fresh window, from the warm-up's own held-thread budget.
  const compiles = new DriverCompileWatch(scene.getEngine());
  const deadline = createStallDeadline(
    (stalled, completed) => `${describeShaderStall(stalled, completed)} ${compiles.describe()}`,
    SCENE_SHADER_WARM_TIMEOUT_MS,
    () => compiles.renew(),
    createHeldThreadBudget(),
  );
  // Counted up front for progress, deduplicated by (Material, meshShaderVariantKey) matching the loop below.
  let total = 0;
  if (onProgress) {
    const counted = new Map<Material, Set<string>>();
    for (const mesh of meshes) {
      if (!(mesh instanceof Mesh) || !mesh.getTotalVertices() || skipMesh?.(mesh)) continue;
      const material = mesh.material ?? scene.defaultMaterial;
      const materials = material instanceof MultiMaterial
        ? new Set(material.subMaterials.filter((entry): entry is Material => entry !== null))
        : new Set([material]);
      const drawn = drawnMaterialVariants(mesh);
      for (const entry of materials) {
        let keys = counted.get(entry);
        if (!keys) counted.set(entry, keys = new Set());
        if (drawn.plain && !isMaterialVariantAlreadyReady(mesh, entry, false)) {
          const key = meshShaderVariantKey(mesh, entry, false);
          if (!keys.has(key)) { keys.add(key); total += 1; }
        }
        if (drawn.instanced && !isMaterialVariantAlreadyReady(mesh, entry, true)) {
          const key = meshShaderVariantKey(mesh, entry, true);
          if (!keys.has(key)) { keys.add(key); total += 1; }
        }
      }
    }
  }
  let done = 0;
  const compiled = () => {
    done += 1;
    // Meshes the warm-up reaches that the count did not see (added meanwhile) raise the total, never past it.
    total = Math.max(total, done);
    onProgress?.({ done, total });
  };
  // Units across and within Materials compile concurrently so KHR_parallel_shader_compile links every variant
  // in parallel. Babylon's `forceCompilation` saves and restores `material.allowShaderHotSwapping` around each call;
  // holding it `false` in one ref-counted guard per Material prevents concurrent variants from racing on restore.
  const running = new Set<Promise<void>>();
  const hotSwapGuards = new Map<Material, { original: boolean; active: number }>();
  const seenVariants = new Map<Material, Set<string>>();
  /** Units started and not finished, oldest first: the oldest is the one a stall names. */
  const inFlight: string[] = [];
  let failure: { error: unknown } | null = null;
  let first = true;
  const acquireHotSwapGuard = (material: Material) => {
    const existing = hotSwapGuards.get(material);
    if (existing) {
      existing.active += 1;
      return;
    }
    hotSwapGuards.set(material, { original: material.allowShaderHotSwapping, active: 1 });
    material.allowShaderHotSwapping = false;
  };
  const releaseHotSwapGuard = (material: Material) => {
    const guard = hotSwapGuards.get(material);
    if (!guard) return;
    guard.active -= 1;
    if (guard.active <= 0) {
      hotSwapGuards.delete(material);
      material.allowShaderHotSwapping = guard.original;
    }
  };
  const start = (material: Material, mesh: AbstractMesh, unit: string, compile: () => Promise<void>) => {
    // The first unit names the stall window at once, as it opens; later ones as earlier units finish.
    if (first) {
      first = false;
      deadline.advance(unit);
    }
    const job = (async () => {
      check(mesh);
      inFlight.push(unit);
      acquireHotSwapGuard(material);
      try {
        await attributeCompileFailure(unit, () => compileUnlessDisposed(material, mesh, compile));
        check(mesh);
        compiled();
      } finally {
        releaseHotSwapGuard(material);
        const at = inFlight.indexOf(unit);
        if (at >= 0) inFlight.splice(at, 1);
      }
      // Progress renews the stall window; it names the oldest unit still compiling.
      deadline.advance(inFlight[0] ?? unit);
    })();
    const tracked: Promise<void> = job.then(() => {}, (error: unknown) => { failure ??= { error }; })
      .finally(() => { running.delete(tracked); });
    running.add(tracked);
  };
  const settle = async () => {
    while (running.size) await Promise.race(running);
  };
  try {
    await deadline.race((async () => {
      onProgress?.({ done, total });
      for (const mesh of meshes) {
        check(mesh);
        // A mesh without vertices draws nothing (empty roots, placeholders, geometry that arrives later).
        if (!(mesh instanceof Mesh) || !mesh.getTotalVertices() || skipMesh?.(mesh)) continue;
        const material = mesh.material ?? scene.defaultMaterial;
        // The same material can have different effects for skinned, morphed,
        // instanced and static meshes. Warm each unique (Material, variant) once.
        const materials = material instanceof MultiMaterial
          ? new Set(material.subMaterials.filter((entry): entry is Material => entry !== null))
          : new Set([material]);
        for (const entry of materials) {
          check(mesh);
          let seen = seenVariants.get(entry);
          if (!seen) seenVariants.set(entry, seen = new Set());
          const drawn = drawnMaterialVariants(mesh);
          const units: Array<[string, () => Promise<void>]> = [];
          if (drawn.plain && !isMaterialVariantAlreadyReady(mesh, entry, false)) {
            const key = meshShaderVariantKey(mesh, entry, false);
            if (!seen.has(key)) {
              seen.add(key);
              units.push([`"${entry.name}" for "${mesh.name}"`,
                () => entry instanceof NodeMaterial ? prewarmMaterial(entry, mesh) : entry.forceCompilationAsync(mesh)]);
            }
          }
          if (drawn.instanced && !isMaterialVariantAlreadyReady(mesh, entry, true)) {
            const key = meshShaderVariantKey(mesh, entry, true);
            if (!seen.has(key)) {
              seen.add(key);
              units.push([`"${entry.name}" for instances of "${mesh.name}"`,
                () => entry.forceCompilationAsync(mesh, { useInstances: true })]);
            }
          }
          for (const [unit, compile] of units) {
            while (running.size >= SCENE_SHADER_WARM_CONCURRENCY && !failure) await Promise.race(running);
            if (failure) throw (failure as { error: unknown }).error;
            start(entry, mesh, unit, compile);
          }
        }
      }
      await settle();
      if (failure) throw (failure as { error: unknown }).error;
      // Units the count saw that were gone by their turn (a mesh disposed, a material replaced) end it at what ran.
      if (done !== total) {
        total = done;
        onProgress?.({ done, total });
      }
    })());
    check();
  } finally {
    // A timeout cannot cancel Babylon's in-flight GPU compile. Its continuation
    // must stop before touching any more meshes, freezing, or reporting ready,
    // and any Material whose hot-swapping guard is still held must be restored.
    finished = true;
    for (const [material, guard] of hotSwapGuards) {
      material.allowShaderHotSwapping = guard.original;
    }
    hotSwapGuards.clear();
  }
}

/** Babylon exposes registration, but no enumeration, of custom readiness checks. */
type SceneReadinessInternals = { _isReadyChecks: readonly { isReady(): boolean }[] };

/** The Effects the mesh being probed requested, and that mesh (reused, so a probe allocates nothing per mesh). */
const meshRequests = new Set<Effect>();
let probedMesh: AbstractMesh | undefined;
// A pool's source draws only its instances (`markInstanceSource`), so it is probed for its instanced variants even
// while it has none: a member that moved to another group leaves its source empty for the rest of the frame.
const probeMesh = () => probedMesh instanceof Mesh && isInstanceSource(probedMesh) ? probedMesh.isReady(true, true) : probedMesh!.isReady(true);
const reportedFailures = new WeakSet<Effect>();
/** The scene probe's shadow maps (reused). */
const probedShadowMaps = new Set<RenderTargetTexture>();
/** Generators whose caster check a tolerant probe answers while it asks one mesh, with what to restore. */
const deferredCasters: { generator: ShadowGenerator; own: boolean; isReady: ShadowGenerator["isReady"] }[] = [];

/**
 * Babylon's `Mesh.isReady` asks every map of the mesh's lights for the mesh's caster depth variant. In a tolerant
 * probe a shadow map never holds the frame (`ManagedShadowsTask`): one that has not drawn yet samples neutrally and
 * draws once its casters are ready, and a drawn one keeps drawing without a caster still compiling (Babylon skips it
 * and redraws the map until it is ready). So such a probe still requests those variants but does not let them hold
 * the mesh: its colour variant decides.
 */
function deferCasterChecks(mesh: AbstractMesh, firstDrawsOnly: boolean): void {
  for (const light of mesh.lightSources) {
    const generators = light.getShadowGenerators();
    if (!generators) continue;
    for (const generator of generators.values()) {
      const shadows = generator as ShadowGenerator;
      if ((firstDrawsOnly && !awaitsFirstDraw(shadows)) || deferredCasters.some((entry) => entry.generator === shadows)) continue;
      const own = Object.prototype.hasOwnProperty.call(shadows, "isReady");
      const isReady = shadows.isReady;
      deferredCasters.push({ generator: shadows, own, isReady });
      shadows.isReady = function (this: ShadowGenerator, ...args: Parameters<ShadowGenerator["isReady"]>) {
        isReady.apply(this, args);
        return true;
      };
    }
  }
}

function restoreCasterChecks(): void {
  for (const { generator, own, isReady } of deferredCasters) {
    if (own) generator.isReady = isReady;
    else delete (generator as Partial<ShadowGenerator>).isReady;
  }
  deferredCasters.length = 0;
}

/** None of the Effects the probed mesh requested is still compiling and one failed with every fallback: that one. */
function failedRequest(): Effect | undefined {
  let failed: Effect | undefined;
  for (const effect of meshRequests) {
    if (effect.isReady()) continue;
    if (!effect.getCompilationError() || !effect.allFallbacksProcessed()) return undefined;
    failed = effect;
  }
  return failed;
}

/** The Effects the probed mesh requested and where each stands, for a reader of the probe's diagnostics. */
function describeRequests(): string {
  if (!meshRequests.size) return "it requested no Effect";
  const states: string[] = [];
  for (const effect of meshRequests) {
    const name = typeof effect.name === "string" ? effect.name : effect.name.fragmentElement ?? effect.name.fragment ?? effect.name.fragmentSource?.slice(0, 40) ?? "inline";
    const error = effect.getCompilationError();
    // Whether Babylon has the Effect's sources yet: its program exists only once they are processed.
    const linking = Boolean((effect.getPipelineContext() as { program?: unknown } | null)?.program);
    states.push(`${name} #${effectSerial(effect)} ${effect.isReady() ? "ready" : effect.isDisposed ? "disposed"
      : error ? `failed (${error.slice(0, 160)})` : linking ? "linking" : "processing its sources"}`);
  }
  return states.join(", ");
}

/** A number per Effect object, in the order a failed probe first described them: tells one Effect that stays unready from a new one each probe. */
const effectSerials = new WeakMap<Effect, number>();
let nextEffectSerial = 1;
function effectSerial(effect: Effect): number {
  let serial = effectSerials.get(effect);
  if (serial === undefined) effectSerials.set(effect, (serial = nextEffectSerial++));
  return serial;
}

function reportFailure(effect: Effect, message: string): void {
  if (reportedFailures.has(effect)) return;
  reportedFailures.add(effect);
  console.error(`[render] ${message} ${effect.getCompilationError()}`);
}

/**
 * A swapping mesh's new variant failed to compile, every fallback included. Babylon then draws the previous Effect
 * for good, so the swap is over; it is reported once.
 */
function swapFailed(material: Material): boolean {
  const failed = failedRequest();
  if (failed) reportFailure(failed, `Material "${material.name}" keeps drawing its previous shader variant: its new variant failed to compile.`);
  return failed !== undefined;
}

/**
 * Whether every submesh of `mesh` has a ready Effect in the current pass: something it can draw while it swaps. An
 * instance's submeshes hold none: its source's batch draws it with the source's.
 */
function drawsSomething(mesh: AbstractMesh): boolean {
  const source = drawingMesh(mesh);
  if (!source.subMeshes?.length) return true;
  for (const part of source.subMeshes) {
    const material = part.getMaterial();
    if (!material) continue;
    const wrapper = material._storeEffectOnSubMeshes ? part._drawWrapperOverride ?? part._getDrawWrapper() : material._getDrawWrapper();
    if (!wrapper?.effect?.isReady()) return false;
  }
  return true;
}

/**
 * Probe the variants `mesh` is drawn with now. The probe never replaces a ready Effect: Babylon's hot swap keeps
 * drawing a submesh's previous Effect while a newly requested variant compiles. Such a mesh is ready only inside
 * `probeVariantSwaps(true, …)` (a world view's steady frames); everywhere else it waits for its new variant. A swap
 * whose new variant failed to compile is over: the mesh is ready, drawing its previous Effect.
 *
 * A mesh that has never drawn with its Material (a spawn, a changed Material) and has nothing to draw meanwhile is
 * hidden instead inside such a probe (`hideUntilReady`), and every pass's probe of it passes, noting whether its own
 * variant is ready (`noteRevealProbe`; the colour probe also needs its caster depth variant for every shadow map that
 * has drawn). The world view's readiness round reveals it, with the rest of its actor, once no pass found one unready.
 * A mesh that has drawn is never hidden: one pass's new variant (a geometry pass added, a depth pre-pass newly
 * blended) waits as before. A hidden mesh whose variant failed to compile stays hidden, reported once. A strict probe
 * that finds a hidden mesh ready notes it for its round too, so a mesh hidden by the view's previous run is revealed.
 */
export function isMeshFrameReady(mesh: AbstractMesh): boolean {
  // A probe for changes that touched other meshes only: this one's variants are as the last probe found them.
  if (outsideReadinessProbeScope(mesh)) return true;
  const scene = mesh.getScene();
  // Native influence edits become attribute-dirty only when the manager resolves
  // its active targets. Resolve before native readiness can accept old defines.
  void mesh.morphTargetManager?.numInfluencers;
  const states = new Map<Material, readonly [boolean, boolean]>();
  const capture = (material: Material | null | undefined): void => {
    if (!material || states.has(material)) return;
    states.set(material, [material.checkReadyOnEveryCall, material.checkReadyOnlyOnce]);
    // UV transform setters similarly defer texture-define invalidation until
    // getTextureMatrix detects an identity/nonidentity transition at bind time.
    for (const texture of material.getActiveTextures()) texture.getTextureMatrix();
    // The probe evaluates the requested variant now; Material.forceCompilation's
    // temporary submesh bypasses these caches, our live submeshes need public cache flags.
    material.checkReadyOnEveryCall = true;
    material.checkReadyOnlyOnce = false;
    if (material instanceof MultiMaterial)
      for (const child of material.subMaterials) capture(child);
  };
  try {
    capture(mesh.material ?? scene.defaultMaterial);
    // An instance draws with its source's submeshes, whose draw wrappers hold the cached readiness to reset.
    const drawing = drawingMesh(mesh);
    if (drawing.subMeshes) {
      for (const part of drawing.subMeshes) {
        const material = part.getMaterial();
        capture(material);
        // Babylon 9.29 otherwise answers from the previous effect's frozen or
        // same-frame readiness and never requests the changed variant.
        if (material?._storeEffectOnSubMeshes) {
          const wrapper = part._drawWrapperOverride ?? part._getDrawWrapper();
          if (wrapper) wrapper._wasPreviouslyReady = false;
          const defines = part.materialDefines;
          if (defines) defines._renderId = -1;
          // Babylon will not draw a previous Effect after a light was disposed. The light block binds lights as data,
          // never a disposed light, so in a view that tolerates swaps the submesh keeps drawing it.
          if (defines?._areLightsDisposed && variantSwapsTolerated() && part.effect?.isReady())
            defines._areLightsDisposed = false;
        }
      }
    }
    for (const material of states.keys()) {
      if (!material._storeEffectOnSubMeshes)
        material._getDrawWrapper()._wasPreviouslyReady = false;
    }
    const tolerated = variantSwapsTolerated();
    // Before the probe: a spawn's first request sets its still-compiling Effect on the submesh.
    // A new instance waits for its actor's other meshes, as a new mesh does, though its batch draws (its group's
    // variants are ready, so it is revealed in the round that finds them all ready).
    const fresh = mesh.getClassName() === "InstancedMesh" ? !hasDrawnItself(mesh) : !hasDrawn(mesh) && !drawsSomething(mesh);
    const hideable = tolerated && (isRevealPending(mesh) || fresh);
    probedMesh = mesh;
    // A mesh to reveal also needs its caster depth variant for every map that has drawn (a map awaiting its first
    // draw waits for its casters itself); a drawn mesh lets the maps wait for theirs.
    if (tolerated) deferCasterChecks(mesh, hideable);
    const meshReady = collectEffectRequests(scene.getEngine(), meshRequests, probeMesh);
    if (hideable) {
      hideUntilReady(mesh);
      noteRevealProbe(mesh, meshReady);
      const failed = meshReady ? undefined : failedRequest();
      if (failed) {
        reportFailure(failed, `Mesh "${mesh.name}" stays hidden: its shader failed to compile.`);
        noteRevealFailed(mesh);
      } else if (isRevealPending(mesh)) noteVariantSwap();
      return true;
    }
    if (!meshReady) {
      noteReadinessBlocker(() => `mesh "${mesh.name}" (Material "${(mesh.material ?? scene.defaultMaterial).name}"): ${describeRequests()}`);
      return false;
    }
    // A strict probe (a new run, before its first steady frame) found a hidden mesh ready: it is revealed with the
    // round when every other pass agrees. Otherwise only a tolerant round could reveal it, and none follows.
    if (isRevealPending(mesh)) noteRevealProbe(mesh, true);
    noteDrawn(mesh);
    // A hot swap keeps the previous, ready effect and leaves the defines unprocessed until the new variant is ready (an
    // instance's in its source's submeshes).
    for (const part of drawing.subMeshes ?? []) {
      const material = part.getMaterial();
      if (!material?._storeEffectOnSubMeshes) continue;
      if (part.materialDefines?.isDirty && part.effect?.isReady()) {
        if (swapFailed(material)) continue;
        noteVariantSwap();
        if (!variantSwapsTolerated())
          noteReadinessBlocker(() => `mesh "${mesh.name}" (Material "${material.name}"): its new variant is compiling (${describeRequests()})`);
        return variantSwapsTolerated();
      }
    }
    return true;
  } finally {
    restoreCasterChecks();
    probedMesh = undefined;
    meshRequests.clear();
    for (const [material, [everyCall, onlyOnce]] of states) {
      material.checkReadyOnEveryCall = everyCall;
      material.checkReadyOnlyOnce = onlyOnce;
    }
  }
}

/** Native texture decoding may render asynchronously after its load observable. */
export function isSceneTextureWorkReady(scene: Scene): boolean {
  return pendingSceneTextures(scene).length === 0;
}

/** Names of scene textures still loading or decoding; throws on a failed load. */
export function pendingSceneTextures(scene: Scene): string[] {
  if (scene.isDisposed) return ["<disposed scene>"];
  const pending: string[] = [];
  for (const texture of scene.textures) {
    if (texture.loadingError) throw new Error(texture.errorObject?.message ?? `Texture ${texture.name} failed to load.`,
      { cause: texture.errorObject?.exception });
    if (!texture.isRenderTarget && !texture.isReady()) pending.push(`texture "${texture.name}"`);
  }
  return pending;
}

/**
 * Pinned Babylon 9.29 adapter for a staged scene stream. Anonymous pending
 * tokens (glTF imports, particle helpers and prefiltering use plain objects;
 * cube images use a GUID string) cannot be told apart from the stream's own,
 * and texture uploads are decided per admitted texture. Any other pending
 * owner, such as a water reflection's irradiance, is scene-level work the
 * parent still waits for.
 */
function hasParentPendingData(scene: Scene): boolean {
  for (const data of scene._pendingData as unknown[]) {
    if (data instanceof InternalTexture || data instanceof BaseTexture || typeof data === "string") continue;
    if (typeof data === "object" && data !== null && Object.getPrototypeOf(data) === Object.prototype) continue;
    return true;
  }
  return false;
}

/**
 * Babylon 9.29 Scene.isReady also waits for every cached Engine effect. Mirror
 * its scene-owned checks so an unrelated preview cannot block this viewport.
 * This probe compiles each mesh's variant under the camera's own pass; `skipVariant` names meshes the view
 * never draws in that pass (copy-sampling water draws only in the water split's pass), whose other
 * readiness checks still run. `probedElsewhere` names shadow maps another probe of the same round asks whole (the
 * view's shadow task, `ManagedShadowsTask.probesMap`): they are not asked twice.
 */
export function isSceneFrameReady(
  scene: Scene,
  targets: readonly RenderTargetTexture[] = [],
  skipVariant?: (mesh: AbstractMesh) => boolean,
  probedElsewhere?: (map: RenderTargetTexture) => boolean,
): boolean {
  if (scene.isDisposed) return false;
  return withSceneReadinessState(scene, () => {
    const engine = scene.getEngine();
    const admitted = admittedSceneMeshes(scene);
    const meshes = admitted ?? scene.meshes;
    const pendingData = admitted !== undefined ? hasParentPendingData(scene) : scene.getWaitingItemsCount() > 0;
    // Each `unready` names what holds the probe, for a reader of its diagnostics (`noteReadinessBlocker`).
    const unready = (describe: () => string): false => {
      noteReadinessBlocker(describe);
      return false;
    };
    let ready = true;
    if (pendingData) ready = unready(() => "scene data still loading");
    else if (!isEnvironmentLightingReady(scene)) ready = unready(() => "environment lighting");
    const textures = admittedSceneTextures(scene, meshes);
    if (textures) {
      for (const texture of textures) {
        if (texture.loadingError) throw new Error(texture.errorObject?.message ?? `Texture ${texture.name} failed to load.`);
        if (!texture.isRenderTarget && !texture.isReady()) ready = unready(() => `texture "${texture.name}"`);
      }
    } else if (!isSceneTextureWorkReady(scene)) ready = unready(() => pendingSceneTextures(scene)[0] ?? "scene textures");
    scene.prePassRenderer?.update();
    if (scene.useOrderIndependentTransparency && scene.depthPeelingRenderer && !scene.depthPeelingRenderer.isReady())
      ready = unready(() => "depth peeling renderer");
    const renderTargets = new Set([...scene.customRenderTargets, ...targets]);
    const materials = new Set<Material>();
    for (const mesh of meshes) {
      if (!mesh.subMeshes?.length) continue;
      // Start all consumers' compilation even when an earlier one is unready.
      if (!skipVariant?.(mesh) && !isMeshFrameReady(mesh)) { ready = false; continue; }
      const instanced = mesh.hasThinInstances || mesh.getClassName() === "InstancedMesh" ||
        mesh.getClassName() === "InstancedLinesMesh" || Boolean(engine.getCaps().instancedArrays && mesh instanceof Mesh && mesh.instances.length);
      for (const step of scene._isReadyForMeshStage) {
        if (!step.action(mesh, instanced)) ready = unready(() => `mesh "${mesh.name}" (a scene component's mesh stage)`);
      }
      const material = mesh.material ?? scene.defaultMaterial;
      if (material._storeEffectOnSubMeshes) {
        for (const subMesh of mesh.subMeshes) {
          const entry = subMesh.getMaterial();
          if (entry) materials.add(entry);
        }
      } else materials.add(material);
    }
    for (const material of materials) {
      if (material.hasRenderTargetTextures) {
        const textures = material.getRenderTargetTextures?.();
        if (textures) for (let index = 0; index < textures.length; index += 1) renderTargets.add(textures.data[index]!);
      }
    }
    if (admitted) {
      for (const mesh of meshes)
        if (mesh instanceof Mesh && mesh.geometry?.delayLoadState === 2) ready = unready(() => `geometry of mesh "${mesh.name}"`);
    } else {
      for (const geometry of scene.geometries) if (geometry.delayLoadState === 2) ready = unready(() => `geometry "${geometry.id}"`);
    }
    const cameras = scene.activeCameras?.length ? scene.activeCameras : scene.activeCamera ? [scene.activeCamera] : [];
    for (const camera of cameras) {
      if (!camera.isReady(true)) ready = unready(() => `camera "${camera.name}"`);
      if (camera.outputRenderTarget) renderTargets.add(camera.outputRenderTarget);
    }
    for (const particle of admittedSceneParticles(scene) ?? scene.particleSystems)
      if (!particle.isReady()) ready = unready(() => `particle system "${particle.name}"`);
    if (scene.proceduralTexturesEnabled) {
      for (const texture of scene.proceduralTextures ?? []) if (!texture.isReady()) ready = unready(() => `procedural texture "${texture.name}"`);
    }
    for (const layer of scene.layers ?? []) if (!layer.isReady()) ready = unready(() => `layer "${layer.name}"`);
    for (const layer of scene.effectLayers ?? []) if (!layer.isLayerReady()) ready = unready(() => `effect layer "${layer.name}"`);
    for (const check of (scene as unknown as SceneReadinessInternals)._isReadyChecks) {
      if (!check.isReady()) ready = unready(() => "a scene readiness check");
    }
    // A shadow map waits for its casters without holding a tolerant probe (`deferCasterChecks`).
    const shadowMaps = probedShadowMaps;
    shadowMaps.clear();
    for (const light of scene.lights) {
      if (admitted && !light.isEnabled()) continue;
      for (const generator of light.getShadowGenerators()?.values() ?? []) {
        const map = generator.getShadowMap();
        if (!map || probedElsewhere?.(map)) continue;
        renderTargets.add(map);
        shadowMaps.add(map);
      }
    }
    for (const target of renderTargets) {
      const owner = target.getScene() ?? scene;
      if (withSceneReadinessState(owner, () => isRenderTargetProbeReady(target))) continue;
      if (variantSwapsTolerated() && shadowMaps.has(target)) noteVariantSwap();
      else ready = unready(() => `render target "${target.name}"`);
    }
    shadowMaps.clear();
    return ready;
  });
}
