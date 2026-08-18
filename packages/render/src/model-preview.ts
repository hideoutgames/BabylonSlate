import "@babylonjs/loaders/glTF/2.0/glTFLoader";
import type { AbstractMesh, AnimationGroup, Material } from "@babylonjs/core";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { ModelMaterialSlot } from "@babylonslate/assets";
import {
  aimPreviewCameraAtMesh,
  createMaterialPreviewScene,
  type MaterialPreviewScene,
} from "./material-preview";
import { gltfLoaderExtension, isGltfModelBytes } from "./model-mesh";

const CONSTRUCTION_KEY = "babylonslateModelConstructionMaterial";

type ConstructionMeta = {
  [CONSTRUCTION_KEY]?: Material | null;
};

function asMeta(mesh: AbstractMesh): ConstructionMeta {
  const current =
    mesh.metadata && typeof mesh.metadata === "object"
      ? (mesh.metadata as ConstructionMeta)
      : {};
  mesh.metadata = current;
  return current;
}

function visualMeshes(root: AbstractMesh): AbstractMesh[] {
  const children = root.getChildMeshes();
  // After LoadAssetContainerAsync adopt, the first-primitive stub is hidden.
  // Counting it as slot 0 would offset every glTF material by one.
  if (root.visibility === 0 && children.length > 0) {
    return children;
  }
  return [root, ...children];
}

/**
 * Map first-seen construction materials to Model `materialSlots` indices.
 * Empty guid restores the glTF construction material; a filled guid assigns
 * `resolveMaterial` when it returns a material.
 */
export function applyModelMaterialSlots(
  root: AbstractMesh,
  slots: readonly Pick<ModelMaterialSlot, "index" | "name" | "materialGuid">[],
  resolveMaterial: (guid: string) => Material | null,
): void {
  const meshes = visualMeshes(root);
  const constructionOrder: Array<Material | null> = [];
  const constructionToSlot = new Map<Material, number>();

  for (const mesh of meshes) {
    const meta = asMeta(mesh);
    if (!Object.prototype.hasOwnProperty.call(meta, CONSTRUCTION_KEY)) {
      meta[CONSTRUCTION_KEY] = mesh.material ?? null;
    }
    const construction = meta[CONSTRUCTION_KEY] ?? null;
    if (construction && !constructionToSlot.has(construction)) {
      constructionToSlot.set(construction, constructionOrder.length);
      constructionOrder.push(construction);
    }
  }

  const byIndex = new Map<number, string | null>();
  for (const slot of slots) {
    byIndex.set(slot.index, slot.materialGuid);
  }

  for (const mesh of meshes) {
    const construction = asMeta(mesh)[CONSTRUCTION_KEY] ?? null;
    if (!construction) continue;
    const slotIndex = constructionToSlot.get(construction);
    if (slotIndex === undefined) continue;
    const guid = byIndex.get(slotIndex) ?? null;
    if (!guid) {
      mesh.material = construction;
      continue;
    }
    const resolved = resolveMaterial(guid);
    if (resolved) mesh.material = resolved;
  }
}

export function createModelPreviewScene(
  engine: Parameters<typeof createMaterialPreviewScene>[0],
  options: { transparent?: boolean } = {},
): MaterialPreviewScene {
  const host = createMaterialPreviewScene(engine);
  host.mesh.isVisible = false;
  host.mesh.isPickable = false;
  host.camera.lowerRadiusLimit = 0.25;
  host.camera.upperRadiusLimit = 400;
  if (options.transparent) {
    host.scene.clearColor = new Color4(0, 0, 0, 0);
  }
  return host;
}

export async function loadModelPreviewSource(
  host: MaterialPreviewScene,
  bytes: Uint8Array,
): Promise<{ dispose: () => void; animationGroups: AnimationGroup[] } | null> {
  if (!isGltfModelBytes(bytes)) return null;
  const container = await LoadAssetContainerAsync(bytes, host.scene, {
    pluginExtension: gltfLoaderExtension(bytes),
    name: "model-preview.glb",
  });
  container.addAllToScene();
  const candidates = [
    ...(container.rootNodes ?? []),
    ...container.transformNodes,
    ...container.meshes,
  ];
  const seen = new Set<(typeof candidates)[number]>();
  for (const node of candidates) {
    if (seen.has(node) || node === host.mesh) continue;
    seen.add(node);
    if (!node.parent) node.parent = host.mesh;
  }
  host.mesh.visibility = 0;
  host.mesh.computeWorldMatrix(true);
  aimPreviewCameraAtMesh(host.camera, host.mesh);
  const extent = host.mesh.getHierarchyBoundingVectors(true);
  const size = extent.max.subtract(extent.min).length();
  if (Number.isFinite(size) && size > 0) {
    const lower = host.camera.lowerRadiusLimit ?? 0.5;
    const upper = host.camera.upperRadiusLimit ?? 400;
    host.camera.radius = Math.min(upper, Math.max(lower, size * 1.2));
  }
  return {
    dispose: () => {
      container.dispose();
    },
    animationGroups: container.animationGroups,
  };
}
