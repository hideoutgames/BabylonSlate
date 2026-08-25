import {
  Mesh,
  NodeMaterial,
  NodeMaterialModes,
  NullEngine,
  type Material,
  type Scene,
  type SceneOptions,
} from "@babylonjs/core";
import type { SerializedScene } from "@babylonslate/core";
import { prewarmMaterial } from "./material-compiler";
import { isEngineDefaultMaterial } from "./default-material";
import { actorVisualFingerprint } from "./scene-loader";

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
    if (actorVisualFingerprint(was) !== actorVisualFingerprint(actor)) {
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

export function freezeEditorActiveMeshes(scene: Scene): void {
  scene.unfreezeActiveMeshes();
  scene.freezeActiveMeshes(false, undefined, undefined, false, true);
  // freezeActiveMeshes waits on executeWhenReady. Real Engines must keep
  // that wait so unready PBR/GLB meshes are not frozen out of the list.
  // NullEngine PrePass never goes ready, so evaluate and stamp now.
  if (!(scene.getEngine() instanceof NullEngine)) return;
  evaluateEditorActiveMeshes(scene);
  scene._activeMeshesFrozen = true;
  scene._activeMeshesFrozenButKeepClipping = true;
}

export function unfreezeEditorActiveMeshes(scene: Scene): void {
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
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function prewarmSceneMaterials(scene: Scene): Promise<void> {
  await settleOrTimeout((async () => {
    const warmed = new Set<Material>();
    for (const mesh of scene.meshes) {
      if (!(mesh instanceof Mesh)) continue;
      const material = mesh.material;
      if (!material || warmed.has(material)) continue;
      if (material instanceof NodeMaterial) {
        warmed.add(material);
        await prewarmMaterial(material, mesh);
        continue;
      }
      if (isEngineDefaultMaterial(material) || material === scene.defaultMaterial) {
        warmed.add(material);
        await material.forceCompilationAsync(mesh);
      }
    }
    const fallback = scene.defaultMaterial;
    if (fallback && !warmed.has(fallback)) {
      const mesh = scene.meshes.find((entry): entry is Mesh => entry instanceof Mesh);
      if (mesh) await fallback.forceCompilationAsync(mesh);
    }
  })(), SCENE_SHADER_WARM_TIMEOUT_MS);
}
