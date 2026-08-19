import "./gltf-loader";
import type { AbstractMesh, AnimationGroup, Material, TransformNode } from "@babylonjs/core";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { ModelMaterialSlot } from "@babylonslate/assets";
import {
  aimPreviewCameraAtMesh,
  createMaterialPreviewScene,
  type MaterialPreviewScene,
} from "./material-preview";
import { gltfLoaderExtension, isGltfModelBytes } from "./model-mesh";
import { constructionMaterialOf, visualMeshes } from "./visual-meshes";

export { applyMaterialToVisualMeshes, visualMeshes } from "./visual-meshes";

export function applyModelMaterialSlots(
  root: AbstractMesh,
  slots: readonly Pick<ModelMaterialSlot, "index" | "name" | "materialGuid">[],
  resolveMaterial: (guid: string) => Material | null,
): void {
  const meshes = visualMeshes(root);
  const constructionToSlot = new Map<Material, number>();

  for (const mesh of meshes) {
    const construction = constructionMaterialOf(mesh);
    if (construction && !constructionToSlot.has(construction)) {
      constructionToSlot.set(construction, constructionToSlot.size);
    }
  }

  const byIndex = new Map<number, string | null>();
  for (const slot of slots) {
    byIndex.set(slot.index, slot.materialGuid);
  }

  for (const mesh of meshes) {
    const construction = constructionMaterialOf(mesh);
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

/** glTF container root under the hidden preview placeholder (not the placeholder mesh). */
export function previewRigRoot(host: MaterialPreviewScene): TransformNode {
  const child = host.mesh.getChildTransformNodes(true).find(
    (node) => !node.name.endsWith("_overlay"),
  );
  return child ?? host.mesh;
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
