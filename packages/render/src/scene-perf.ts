import {
  Mesh,
  MultiMaterial,
  NodeMaterial,
  NodeMaterialModes,
  type AbstractMesh,
  type Material,
  type RenderTargetTexture,
  type Scene,
  type SceneOptions,
} from "@babylonjs/core";
import { prewarmMaterial } from "./material-compiler";
import { isEngineDefaultMaterial } from "./default-material";
import { syncSceneLighting } from "./scene-lighting";
import { isEnvironmentLightingReady } from "./environment-lighting";
import { withSceneReadinessState } from "./scene-readiness-signal";
import { createStallDeadline, SCENE_SHADER_WARM_TIMEOUT_MS } from "./stall-deadline";
import { admittedSceneMeshes, admittedSceneParticles, admittedSceneTextures } from "./scene-stream-admission";
// Kept on the ./scene-perf subpath. Modules in scene-perf's transitive import
// graph must import these from the leaves, or they close an import cycle back
// through this file.
export { markSceneReadinessDirty, onSceneReadinessDirty, withSceneReadinessState } from "./scene-readiness-signal";
export { createStallDeadline, SCENE_SHADER_WARM_TIMEOUT_MS, type StallDeadline } from "./stall-deadline";

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

export async function prewarmSceneMaterials(scene: Scene, assertCurrent?: () => void): Promise<void> {
  await prewarmMeshMaterials(scene, scene.meshes, assertCurrent);
}

/** Warm only an additive instance's consumers, without waiting on sibling loads. */
export async function prewarmMeshMaterials(
  scene: Scene,
  meshes: Iterable<AbstractMesh>,
  assertCurrent?: (mesh?: AbstractMesh) => void,
): Promise<void> {
  let finished = false;
  const check = (mesh?: AbstractMesh) => {
    if (finished || scene.isDisposed) throw new Error("Scene shader warming was cancelled.");
    assertCurrent?.(mesh);
  };
  check();
  syncSceneLighting(scene);
  const deadline = createStallDeadline(describeShaderStall, SCENE_SHADER_WARM_TIMEOUT_MS);
  try {
    await deadline.race((async () => {
      for (const mesh of meshes) {
        check(mesh);
        if (!(mesh instanceof Mesh)) continue;
        const material = mesh.material ?? scene.defaultMaterial;
        // The same material can have different effects for skinned, morphed,
        // instanced and static meshes. Warm each consumer, including submaterials.
        const materials = material instanceof MultiMaterial
          ? new Set(material.subMaterials.filter((entry): entry is Material => entry !== null))
          : new Set([material]);
        for (const entry of materials) {
          check(mesh);
          deadline.advance(`"${entry.name}" for "${mesh.name}"`);
          if (entry instanceof NodeMaterial) await prewarmMaterial(entry, mesh);
          else await entry.forceCompilationAsync(mesh);
          check(mesh);
          if (mesh.hasThinInstances || mesh.instances.length > 0) {
            deadline.advance(`"${entry.name}" for instances of "${mesh.name}"`);
            await entry.forceCompilationAsync(mesh, { useInstances: true });
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

/** Probe requested material variants instead of Babylon's older hot-swap effects. */
export function isMeshFrameReady(mesh: AbstractMesh): boolean {
  const scene = mesh.getScene();
  // Native influence edits become attribute-dirty only when the manager resolves
  // its active targets. Resolve before native readiness can accept old defines.
  void mesh.morphTargetManager?.numInfluencers;
  const states = new Map<Material, readonly [boolean, boolean, boolean]>();
  const capture = (material: Material | null | undefined): void => {
    if (!material || states.has(material)) return;
    states.set(material, [material.allowShaderHotSwapping, material.checkReadyOnEveryCall, material.checkReadyOnlyOnce]);
    // UV transform setters similarly defer texture-define invalidation until
    // getTextureMatrix detects an identity/nonidentity transition at bind time.
    for (const texture of material.getActiveTextures()) texture.getTextureMatrix();
    // Material.forceCompilation also disables hot swapping. Its temporary
    // submesh bypasses these caches; our live submeshes need public cache flags.
    material.allowShaderHotSwapping = false;
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
        // A strict probe can replace a ready effect with a compiling variant.
        // Babylon 9.29 otherwise retains the previous effect's frozen/same-frame
        // readiness and can bind the new effect before its pipeline exists.
        if (material?._storeEffectOnSubMeshes) {
          const wrapper = part._drawWrapperOverride ?? part._getDrawWrapper();
          if (wrapper) wrapper._wasPreviouslyReady = false;
          const defines = part.materialDefines;
          if (defines) defines._renderId = -1;
        }
      }
    }
    for (const material of states.keys()) {
      if (!material._storeEffectOnSubMeshes)
        material._getDrawWrapper()._wasPreviouslyReady = false;
    }
    return mesh.isReady(true);
  } finally {
    for (const [material, [hotSwap, everyCall, onlyOnce]] of states) {
      material.allowShaderHotSwapping = hotSwap;
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
 * Babylon 9.29 Scene.isReady also waits for every cached Engine effect. Mirror
 * its scene-owned checks so an unrelated preview cannot block this viewport.
 */
export function isSceneFrameReady(scene: Scene, targets: readonly RenderTargetTexture[] = []): boolean {
  if (scene.isDisposed) return false;
  return withSceneReadinessState(scene, () => {
    const engine = scene.getEngine();
    const admitted = admittedSceneMeshes(scene);
    const meshes = admitted ?? scene.meshes;
    let ready = (admitted !== undefined || scene.getWaitingItemsCount() === 0) && isEnvironmentLightingReady(scene);
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
      if (!isMeshFrameReady(mesh)) { ready = false; continue; }
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
    for (const light of scene.lights) {
      if (admitted && !light.isEnabled()) continue;
      for (const generator of light.getShadowGenerators()?.values() ?? []) {
        const map = generator.getShadowMap();
        if (map) renderTargets.add(map);
      }
    }
    for (const target of renderTargets) {
      const owner = target.getScene() ?? scene;
      if (!withSceneReadinessState(owner, () => target.isReadyForRendering())) ready = false;
    }
    return ready;
  });
}
