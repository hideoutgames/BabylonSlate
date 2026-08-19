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
import { constructionMaterialOf, visualHierarchyBoundingVectors, visualMeshes } from "./visual-meshes";

export { applyMaterialToVisualMeshes, visualMeshes } from "./visual-meshes";

const GLTF_MATERIAL_POINTER = /^\/materials\/(\d+)$/;

type GltfPointerHost = {
  _internalMetadata?: { gltf?: { pointers?: unknown } };
  metadata?: { gltf?: { pointers?: unknown } } | null;
};

function gltfPointers(material: Material): string[] {
  const host = material as Material & GltfPointerHost;
  const raw =
    host._internalMetadata?.gltf?.pointers ?? host.metadata?.gltf?.pointers;
  if (!Array.isArray(raw)) return [];
  return raw.filter((pointer): pointer is string => typeof pointer === "string");
}

/** glTF `materials` array index from the loader’s `/materials/N` pointer. */
function gltfMaterialIndex(material: Material): number | undefined {
  for (const pointer of gltfPointers(material)) {
    const match = GLTF_MATERIAL_POINTER.exec(pointer);
    if (match) return Number(match[1]);
  }
  return undefined;
}

export function applyModelMaterialSlots(
  root: AbstractMesh,
  slots: readonly Pick<ModelMaterialSlot, "index" | "name" | "materialGuid">[],
  resolveMaterial: (guid: string) => Material | null,
): void {
  const meshes = visualMeshes(root);
  const constructionToSlot = new Map<Material, number>();
  const usedIndices = new Set<number>();
  const slotIndices = new Set(slots.map((slot) => slot.index));
  const slotByName = new Map<string, number>();
  for (const slot of slots) {
    if (slot.name.length > 0 && !slotByName.has(slot.name)) {
      slotByName.set(slot.name, slot.index);
    }
  }

  const unusedIndex = (): number => {
    const unused = slots.find((slot) => !usedIndices.has(slot.index));
    return unused?.index ?? usedIndices.size;
  };

  for (const mesh of meshes) {
    const construction = constructionMaterialOf(mesh);
    if (!construction || constructionToSlot.has(construction)) continue;
    const fromGltf = gltfMaterialIndex(construction);
    const namedIndex = slotByName.get(construction.name);
    const index =
      fromGltf !== undefined && slotIndices.has(fromGltf)
        ? fromGltf
        : namedIndex !== undefined
          ? namedIndex
          : unusedIndex();
    constructionToSlot.set(construction, index);
    usedIndices.add(index);
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
  const extent = visualHierarchyBoundingVectors(host.mesh);
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
