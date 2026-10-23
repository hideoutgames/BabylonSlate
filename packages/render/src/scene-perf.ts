import {
  BaseTexture,
  InternalTexture,
  Mesh,
  MultiMaterial,
  NodeMaterial,
  NodeMaterialModes,
  type AbstractMesh,
  type Effect,
  type Material,
  type RenderTargetTexture,
  type Scene,
  type ShadowGenerator,
  type SceneOptions,
} from "@babylonjs/core";
import { prewarmMaterial } from "./material-compiler";
import { isEngineDefaultMaterial } from "./default-material";
import { syncSceneLighting } from "./scene-lighting";
import { isEnvironmentLightingReady } from "./environment-lighting";
import { withSceneReadinessState } from "./scene-readiness-signal";
import { createHeldThreadBudget, createStallDeadline, SCENE_SHADER_WARM_TIMEOUT_MS } from "./stall-deadline";
import { DriverCompileWatch } from "./driver-compile";
import { drawnMaterialVariants } from "./drawn-variants";
import { admittedSceneMeshes, admittedSceneParticles, admittedSceneTextures } from "./scene-stream-admission";
import { noteVariantSwap, variantSwapsTolerated } from "./variant-swaps";
import { collectEffectRequests } from "./effect-requests";
import { bindsAsPreviousEffect } from "./fixed-light-binding";
import { awaitsFirstDraw } from "./shadow-first-draw";
// Kept on the ./scene-perf subpath. Modules in scene-perf's transitive import
// graph must import these from the leaves, or they close an import cycle back
// through this file.
export { markSceneReadinessDirty, onSceneReadinessDirty, withSceneReadinessState } from "./scene-readiness-signal";
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

/**
 * `skipMesh` names meshes whose drawn variant a later readiness probe compiles under the pass that draws them (built-in
 * water, whose variant depends on the pass), so warming the pass-less variant here could compile one nothing draws.
 */
export async function prewarmSceneMaterials(
  scene: Scene,
  assertCurrent?: () => void,
  skipMesh?: (mesh: AbstractMesh) => boolean,
): Promise<void> {
  await prewarmMeshMaterials(scene, scene.meshes, assertCurrent, skipMesh);
}

/** Warm only an additive instance's consumers, without waiting on sibling loads. */
export async function prewarmMeshMaterials(
  scene: Scene,
  meshes: Iterable<AbstractMesh>,
  assertCurrent?: (mesh?: AbstractMesh) => void,
  skipMesh?: (mesh: AbstractMesh) => boolean,
): Promise<void> {
  let finished = false;
  const check = (mesh?: AbstractMesh) => {
    if (finished || scene.isDisposed) throw new Error("Scene shader warming was cancelled.");
    assertCurrent?.(mesh);
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
  try {
    await deadline.race((async () => {
      for (const mesh of meshes) {
        check(mesh);
        // A mesh without vertices draws nothing (empty roots, placeholders, geometry that arrives later).
        if (!(mesh instanceof Mesh) || !mesh.getTotalVertices() || skipMesh?.(mesh)) continue;
        const material = mesh.material ?? scene.defaultMaterial;
        // The same material can have different effects for skinned, morphed,
        // instanced and static meshes. Warm each consumer, including submaterials.
        const materials = material instanceof MultiMaterial
          ? new Set(material.subMaterials.filter((entry): entry is Material => entry !== null))
          : new Set([material]);
        for (const entry of materials) {
          check(mesh);
          const drawn = drawnMaterialVariants(mesh);
          if (drawn.plain) {
            const unit = `"${entry.name}" for "${mesh.name}"`;
            deadline.advance(unit);
            await attributeCompileFailure(unit, () => entry instanceof NodeMaterial ? prewarmMaterial(entry, mesh) : entry.forceCompilationAsync(mesh));
            check(mesh);
          }
          if (drawn.instanced) {
            const instanced =`"${entry.name}" for instances of "${mesh.name}"`;
            deadline.advance(instanced);
            await attributeCompileFailure(instanced, () => entry.forceCompilationAsync(mesh, { useInstances: true }));
            check(mesh);
          }
        }
      }
    })());
    check();
  } finally {
    // A timeout cannot cancel Babylon's in-flight GPU compile. Its continuation
    // must stop before touching any more meshes, freezing, or reporting ready.
    finished = true;
  }
}

/** Babylon exposes registration, but no enumeration, of custom readiness checks. */
type SceneReadinessInternals = { _isReadyChecks: readonly { isReady(): boolean }[] };

/** The Effects the mesh being probed requested, and that mesh (reused, so a probe allocates nothing per mesh). */
const meshRequests = new Set<Effect>();
let probedMesh: AbstractMesh | undefined;
const probeMesh = () => probedMesh!.isReady(true);
const reportedFailures = new WeakSet<Effect>();
/** The scene probe's maps awaiting their first draw (reused). */
const firstDrawMaps = new Set<RenderTargetTexture>();
/** Generators whose caster check a tolerant probe answers while it asks one mesh, with what to restore. */
const deferredCasters: { generator: ShadowGenerator; own: boolean; isReady: ShadowGenerator["isReady"] }[] = [];

/**
 * Babylon's `Mesh.isReady` asks every map of the mesh's lights for the mesh's caster depth variant. A map that has
 * not drawn yet samples neutrally and draws once its casters are ready (`ManagedShadowsTask`), so a tolerant probe
 * still requests those variants but does not let them hold the mesh: its colour variant and every drawn map's
 * casters decide.
 */
function deferFirstDrawCasters(mesh: AbstractMesh): void {
  for (const light of mesh.lightSources) {
    const generators = light.getShadowGenerators();
    if (!generators) continue;
    for (const generator of generators.values()) {
      const shadows = generator as ShadowGenerator;
      if (!awaitsFirstDraw(shadows) || deferredCasters.some((entry) => entry.generator === shadows)) continue;
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

function restoreFirstDrawCasters(): void {
  for (const { generator, own, isReady } of deferredCasters) {
    if (own) generator.isReady = isReady;
    else delete (generator as Partial<ShadowGenerator>).isReady;
  }
  deferredCasters.length = 0;
}

/**
 * A swapping mesh's new variant failed to compile, every fallback included: none of the Effects it requested is still
 * compiling and one failed. Babylon then draws the previous Effect for good, so the swap is over; it is reported once.
 */
function swapFailed(material: Material): boolean {
  let failed: Effect | undefined;
  for (const effect of meshRequests) {
    if (effect.isReady()) continue;
    if (!effect.getCompilationError() || !effect.allFallbacksProcessed()) return false;
    failed = effect;
  }
  if (!failed) return false;
  if (!reportedFailures.has(failed)) {
    reportedFailures.add(failed);
    console.error(`[render] Material "${material.name}" keeps drawing its previous shader variant: its new variant failed to compile. ${failed.getCompilationError()}`);
  }
  return true;
}

/**
 * Probe the variants `mesh` is drawn with now. The probe never replaces a ready Effect: Babylon's hot swap keeps
 * drawing a submesh's previous Effect while a newly requested variant compiles. Such a mesh is ready only inside
 * `probeVariantSwaps(true, …)` (a world view's steady frames), and only where its previous Effect binds by its own
 * light layout (`bindsAsPreviousEffect`); everywhere else it waits for its new variant. A swap whose new variant
 * failed to compile is over: the mesh is ready, drawing its previous Effect.
 */
export function isMeshFrameReady(mesh: AbstractMesh): boolean {
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
    if (mesh.subMeshes) {
      for (const part of mesh.subMeshes) {
        const material = part.getMaterial();
        capture(material);
        // Babylon 9.29 otherwise answers from the previous effect's frozen or
        // same-frame readiness and never requests the changed variant.
        if (material?._storeEffectOnSubMeshes) {
          const wrapper = part._drawWrapperOverride ?? part._getDrawWrapper();
          if (wrapper) wrapper._wasPreviouslyReady = false;
          const defines = part.materialDefines;
          if (defines) defines._renderId = -1;
          // Babylon will not draw a previous Effect after one of its lights was disposed. A view that tolerates
          // swaps binds such an Effect by its own light layout (`bindLights` in fixed-light-binding.ts), which never
          // binds a disposed light, so the submesh keeps drawing it.
          if (defines?._areLightsDisposed && variantSwapsTolerated() && part.effect?.isReady() && bindsAsPreviousEffect(part.effect))
            defines._areLightsDisposed = false;
        }
      }
    }
    for (const material of states.keys()) {
      if (!material._storeEffectOnSubMeshes)
        material._getDrawWrapper()._wasPreviouslyReady = false;
    }
    probedMesh = mesh;
    if (variantSwapsTolerated()) deferFirstDrawCasters(mesh);
    if (!collectEffectRequests(scene.getEngine(), meshRequests, probeMesh)) return false;
    // A hot swap keeps the previous, ready effect and leaves the defines unprocessed until the new variant is ready.
    for (const part of mesh.subMeshes ?? []) {
      const material = part.getMaterial();
      if (!material?._storeEffectOnSubMeshes) continue;
      if (part.materialDefines?.isDirty && part.effect?.isReady()) {
        if (swapFailed(material)) continue;
        noteVariantSwap();
        return variantSwapsTolerated() && bindsAsPreviousEffect(part.effect);
      }
    }
    return true;
  } finally {
    restoreFirstDrawCasters();
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
 * readiness checks still run.
 */
export function isSceneFrameReady(
  scene: Scene,
  targets: readonly RenderTargetTexture[] = [],
  skipVariant?: (mesh: AbstractMesh) => boolean,
): boolean {
  if (scene.isDisposed) return false;
  return withSceneReadinessState(scene, () => {
    const engine = scene.getEngine();
    const admitted = admittedSceneMeshes(scene);
    const meshes = admitted ?? scene.meshes;
    const pendingData = admitted !== undefined ? hasParentPendingData(scene) : scene.getWaitingItemsCount() > 0;
    let ready = !pendingData && isEnvironmentLightingReady(scene);
    const textures = admittedSceneTextures(scene, meshes);
    if (textures) {
      for (const texture of textures) {
        if (texture.loadingError) throw new Error(texture.errorObject?.message ?? `Texture ${texture.name} failed to load.`);
        if (!texture.isRenderTarget && !texture.isReady()) ready = false;
      }
    } else if (!isSceneTextureWorkReady(scene)) ready = false;
    scene.prePassRenderer?.update();
    if (scene.useOrderIndependentTransparency && scene.depthPeelingRenderer && !scene.depthPeelingRenderer.isReady()) ready = false;
    const renderTargets = new Set([...scene.customRenderTargets, ...targets]);
    const materials = new Set<Material>();
    for (const mesh of meshes) {
      if (!mesh.subMeshes?.length) continue;
      // Start all consumers' compilation even when an earlier one is unready.
      if (!skipVariant?.(mesh) && !isMeshFrameReady(mesh)) { ready = false; continue; }
      const instanced = mesh.hasThinInstances || mesh.getClassName() === "InstancedMesh" ||
        mesh.getClassName() === "InstancedLinesMesh" || Boolean(engine.getCaps().instancedArrays && mesh instanceof Mesh && mesh.instances.length);
      for (const step of scene._isReadyForMeshStage) {
        if (!step.action(mesh, instanced)) ready = false;
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
      for (const mesh of meshes) if (mesh instanceof Mesh && mesh.geometry?.delayLoadState === 2) ready = false;
    } else {
      for (const geometry of scene.geometries) if (geometry.delayLoadState === 2) ready = false;
    }
    const cameras = scene.activeCameras?.length ? scene.activeCameras : scene.activeCamera ? [scene.activeCamera] : [];
    for (const camera of cameras) {
      if (!camera.isReady(true)) ready = false;
      if (camera.outputRenderTarget) renderTargets.add(camera.outputRenderTarget);
    }
    for (const particle of admittedSceneParticles(scene) ?? scene.particleSystems) if (!particle.isReady()) ready = false;
    if (scene.proceduralTexturesEnabled) {
      for (const texture of scene.proceduralTextures ?? []) if (!texture.isReady()) ready = false;
    }
    for (const layer of scene.layers ?? []) if (!layer.isReady()) ready = false;
    for (const layer of scene.effectLayers ?? []) if (!layer.isLayerReady()) ready = false;
    for (const check of (scene as unknown as SceneReadinessInternals)._isReadyChecks) {
      if (!check.isReady()) ready = false;
    }
    // A map that has not drawn yet waits for its casters without holding a tolerant probe (`deferFirstDrawCasters`).
    const firstDraws = firstDrawMaps;
    firstDraws.clear();
    for (const light of scene.lights) {
      if (admitted && !light.isEnabled()) continue;
      for (const generator of light.getShadowGenerators()?.values() ?? []) {
        const map = generator.getShadowMap();
        if (!map) continue;
        renderTargets.add(map);
        if (awaitsFirstDraw(generator as ShadowGenerator)) firstDraws.add(map);
      }
    }
    for (const target of renderTargets) {
      const owner = target.getScene() ?? scene;
      if (withSceneReadinessState(owner, () => target.isReadyForRendering())) continue;
      if (variantSwapsTolerated() && firstDraws.has(target)) noteVariantSwap();
      else ready = false;
    }
    firstDraws.clear();
    return ready;
  });
}
