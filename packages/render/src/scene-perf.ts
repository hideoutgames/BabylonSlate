import {
  Mesh,
  MultiMaterial,
  NodeMaterial,
  NodeMaterialModes,
  NullEngine,
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
      if (!scene.activeCamera || !scene.isReady()) return;
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

/** Readiness of the actual scene passes, including shadow render targets. */
export function isSceneFrameReady(scene: Scene, targets: readonly RenderTargetTexture[] = []): boolean {
  // Babylon 9.20 readiness probes write scene UBOs outside Scene.render(). A
  // newly constructed sibling can own the global origin without camera matrices.
  // Scope this synchronous probe exactly as Babylon scopes its render entry.
  const previousScene = FloatingOriginCurrentScene.getScene;
  const previousEyeAtCamera = FloatingOriginCurrentScene.eyeAtCamera;
  FloatingOriginCurrentScene.getScene = () => scene.floatingOriginMode ? scene : undefined;
  FloatingOriginCurrentScene.eyeAtCamera = true;
  try {
    if (!scene.isReady(true)) return false;
    for (const light of scene.lights) {
      for (const generator of light.getShadowGenerators()?.values() ?? []) {
        const map = generator.getShadowMap();
        if (map && !map.isReadyForRendering()) return false;
      }
    }
    return targets.every((target) => target.isReadyForRendering());
  } finally {
    FloatingOriginCurrentScene.getScene = previousScene;
    FloatingOriginCurrentScene.eyeAtCamera = previousEyeAtCamera;
  }
}
