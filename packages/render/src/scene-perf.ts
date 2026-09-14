import {
  Mesh,
  MultiMaterial,
  NodeMaterial,
  NodeMaterialModes,
  NullEngine,
  type AbstractMesh,
  type Material,
  type RenderTargetTexture,
  type Scene,
  type SceneOptions,
} from "@babylonjs/core";
import { FloatingOriginCurrentScene } from "@babylonjs/core/Materials/floatingOriginMatrixOverrides";
import type { SerializedScene } from "@babylonslate/core";
import { prewarmMaterial } from "./material-compiler";
import { isEngineDefaultMaterial } from "./default-material";
import { actorVisualFingerprint } from "./scene-loader";
import { syncSceneLighting } from "./scene-lighting";

/** Fast large-scene lookups (§2.4). Babylon 9 defaults these on; pass them explicitly. */
export const SCENE_LOOKUP_MAPS: SceneOptions = {
  useGeometryUniqueIdsMap: true,
  useMaterialMeshMap: true,
  useClonedMeshMap: true,
};

const MATERIAL_LIBRARY_PREFIX = "material:";

export function isStructuralEditorChange(
  previous: SerializedScene | null,
  next: SerializedScene,
): boolean {
  if (!previous) return true;
  if (previous.actors.length !== next.actors.length) return true;
  const previousById = new Map(
    previous.actors.map((actor) => [actor.id, actor] as const),
  );
  for (const actor of next.actors) {
    const was = previousById.get(actor.id);
    if (!was) return true;
    if (was.parentId !== actor.parentId) return true;
    if (was.visible !== actor.visible) return true;
    if (actorVisualFingerprint(was, undefined, previous.actors) !== actorVisualFingerprint(actor, undefined, next.actors)) {
      return true;
    }
  }
  return false;
}

type SceneActiveMeshInternals = {
  _frustumPlanes?: unknown;
  _evaluateActiveMeshes: () => void;
};

function evaluateEditorActiveMeshes(scene: Scene): void {
  if (!scene.activeCamera) return;
  const internals = scene as unknown as SceneActiveMeshInternals;
  if (!internals._frustumPlanes) {
    scene.updateTransformMatrix();
  }
  internals._evaluateActiveMeshes();
}

const freezeSkipGenerations = new WeakMap<Scene, number>();
const pendingFrameFreezes = new WeakMap<Scene, () => void>();

function beginSkipFrustumForFreeze(scene: Scene): () => void {
  const generation = (freezeSkipGenerations.get(scene) ?? 0) + 1;
  freezeSkipGenerations.set(scene, generation);
  scene.skipFrustumClipping = true;
  return () => {
    if (freezeSkipGenerations.get(scene) !== generation) return;
    scene.skipFrustumClipping = false;
  };
}

export function freezeEditorActiveMeshes(scene: Scene): void {
  unfreezeEditorActiveMeshes(scene);
  const engine = scene.getEngine();
  if (!(engine instanceof NullEngine) || engine.supportsUniformBuffers) {
    // Babylon's executeWhenReady callback can run between scenes, including
    // after the last floating-origin scene has been disposed. Evaluate only
    // inside this scene's render context, once its drawable materials are ready.
    const observer = scene.onBeforeRenderObservable.add(() => {
      if (!scene.activeCamera || !isSceneFrameReady(scene)) return;
      cancel();
      const restoreSkip = beginSkipFrustumForFreeze(scene);
      try {
        evaluateEditorActiveMeshes(scene);
        scene._activeMeshesFrozen = true;
        scene._activeMeshesFrozenButKeepClipping = true;
      } finally {
        restoreSkip();
      }
    });
    const cancel = () => {
      scene.onBeforeRenderObservable.remove(observer);
      pendingFrameFreezes.delete(scene);
    };
    pendingFrameFreezes.set(scene, cancel);
    return;
  }
  // Membership must include off-frustum drawable meshes. keepFrustumCulling
  // still skips their draw; camera motion then reveals them without an apply.
  const restoreSkip = beginSkipFrustumForFreeze(scene);
  scene.freezeActiveMeshes(false, restoreSkip, restoreSkip, false, true);
  // NullEngine PrePass never goes ready, so evaluate and stamp now.
  evaluateEditorActiveMeshes(scene);
  scene._activeMeshesFrozen = true;
  scene._activeMeshesFrozenButKeepClipping = true;
  restoreSkip();
}

export function unfreezeEditorActiveMeshes(scene: Scene): void {
  pendingFrameFreezes.get(scene)?.();
  scene.unfreezeActiveMeshes();
}

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

export const SCENE_SHADER_WARM_TIMEOUT_MS = 4_000;

export async function settleOrTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Scene shaders did not become ready before the loading deadline.")), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function prewarmSceneMaterials(scene: Scene, assertCurrent?: () => void): Promise<void> {
  let finished = false;
  const check = () => {
    if (finished || scene.isDisposed) throw new Error("Scene shader warming was cancelled.");
    assertCurrent?.();
  };
  check();
  syncSceneLighting(scene);
  try {
    await settleOrTimeout((async () => {
      for (const mesh of scene.meshes) {
        check();
        if (!(mesh instanceof Mesh)) continue;
        const material = mesh.material ?? scene.defaultMaterial;
        // The same material can have different effects for skinned, morphed,
        // instanced and static meshes. Warm each consumer, including submaterials.
        const materials = material instanceof MultiMaterial
          ? new Set(material.subMaterials.filter((entry): entry is Material => entry !== null))
          : new Set([material]);
        for (const entry of materials) {
          check();
          if (entry instanceof NodeMaterial) await prewarmMaterial(entry, mesh);
          else await entry.forceCompilationAsync(mesh);
          check();
          if (mesh.hasThinInstances || mesh.instances.length > 0) {
            await entry.forceCompilationAsync(mesh, { useInstances: true });
          }
        }
      }
    })(), SCENE_SHADER_WARM_TIMEOUT_MS);
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
  const states = new Map<Material, readonly [boolean, boolean, boolean]>();
  const capture = (material: Material | null | undefined): void => {
    if (!material || states.has(material)) return;
    states.set(material, [material.allowShaderHotSwapping, material.checkReadyOnEveryCall, material.checkReadyOnlyOnce]);
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
    if (mesh.subMeshes)
      for (const part of mesh.subMeshes) capture(part.getMaterial());
    return mesh.isReady(true);
  } finally {
    for (const [material, [hotSwap, everyCall, onlyOnce]] of states) {
      material.allowShaderHotSwapping = hotSwap;
      material.checkReadyOnEveryCall = everyCall;
      material.checkReadyOnlyOnce = onlyOnce;
    }
  }
}

/** Preserve shared render state even when Babylon's RTT probe throws mid-pass. */
export function withSceneReadinessState<T>(scene: Scene, probe: () => T): T {
  const engine = scene.getEngine();
  const camera = scene.activeCamera;
  const sceneUbo = scene.getSceneUniformBuffer();
  const view = scene.getViewMatrix()?.clone();
  const projection = scene.getProjectionMatrix()?.clone();
  const viewport = engine.currentViewport;
  const width = engine.getRenderWidth();
  const height = engine.getRenderHeight();
  const renderPassId = engine.currentRenderPassId;
  const colorWrite = engine.getColorWrite();
  const imageProcessing = scene.imageProcessingConfiguration.applyByPostProcess;
  const previousScene = FloatingOriginCurrentScene.getScene;
  const previousEyeAtCamera = FloatingOriginCurrentScene.eyeAtCamera;
  FloatingOriginCurrentScene.getScene = () => scene.floatingOriginMode ? scene : undefined;
  FloatingOriginCurrentScene.eyeAtCamera = true;
  let failed = false;
  let failure: unknown;
  let result!: T;
  const errors: unknown[] = [];
  try {
    // Ready checks can upload scene UBOs before the first Scene.render().
    if (camera && (!view || !projection)) scene.updateTransformMatrix();
    engine.currentRenderPassId = camera?.renderPassId ?? renderPassId;
    result = probe();
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    const restore = (action: () => void) => {
      try { action(); } catch (error) { errors.push(error); }
    };
    // Do not invoke RTT after-render observers: some perform blur passes.
    scene._activeCamera = camera;
    FloatingOriginCurrentScene.eyeAtCamera = true;
    restore(() => scene.setSceneUniformBuffer(sceneUbo));
    if (view && projection) restore(() => scene.setTransformMatrix(view, projection));
    restore(() => { scene.imageProcessingConfiguration.applyByPostProcess = imageProcessing; });
    restore(() => engine.setViewport(viewport ?? { x: 0, y: 0, width: 1, height: 1 }, width, height));
    restore(() => engine.setColorWrite(colorWrite));
    engine.currentRenderPassId = renderPassId;
    restore(() => scene.resetCachedMaterial());
    FloatingOriginCurrentScene.getScene = previousScene;
    FloatingOriginCurrentScene.eyeAtCamera = previousEyeAtCamera;
  }
  if (errors.length) throw new AggregateError(failed ? [failure, ...errors] : errors,
    "Scene readiness state restoration failed.", failed ? { cause: failure } : undefined);
  if (failed) throw failure;
  return result;
}

/**
 * Babylon 9.20 Scene.isReady also waits for every cached Engine effect. Mirror
 * its scene-owned checks so an unrelated preview cannot block this viewport.
 */
export function isSceneFrameReady(scene: Scene, targets: readonly RenderTargetTexture[] = []): boolean {
  if (scene.isDisposed) return false;
  return withSceneReadinessState(scene, () => {
    const engine = scene.getEngine();
    let ready = scene.getWaitingItemsCount() === 0;
    scene.prePassRenderer?.update();
    if (scene.useOrderIndependentTransparency && scene.depthPeelingRenderer && !scene.depthPeelingRenderer.isReady()) ready = false;
    const renderTargets = new Set([...scene.customRenderTargets, ...targets]);
    const materials = new Set<Material>();
    for (const mesh of scene.meshes) {
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
    for (const geometry of scene.geometries) if (geometry.delayLoadState === 2) ready = false;
    const cameras = scene.activeCameras?.length ? scene.activeCameras : scene.activeCamera ? [scene.activeCamera] : [];
    for (const camera of cameras) {
      if (!camera.isReady(true)) ready = false;
      if (camera.outputRenderTarget) renderTargets.add(camera.outputRenderTarget);
    }
    for (const particle of scene.particleSystems) if (!particle.isReady()) ready = false;
    if (scene.proceduralTexturesEnabled) {
      for (const texture of scene.proceduralTextures ?? []) if (!texture.isReady()) ready = false;
    }
    for (const layer of scene.layers ?? []) if (!layer.isReady()) ready = false;
    for (const layer of scene.effectLayers ?? []) if (!layer.isLayerReady()) ready = false;
    for (const check of (scene as unknown as SceneReadinessInternals)._isReadyChecks) {
      if (!check.isReady()) ready = false;
    }
    for (const light of scene.lights) {
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
