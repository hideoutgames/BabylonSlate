import "./gltf-loader";
import { applyMaterialBounds } from "./material-bounds";
import { setDrawnMaterial } from "./pooled-visuals";
import type {
  AnimationGroup,
  Material,
} from "@babylonjs/core";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { loadModelContainer, modelMaterialIndexOf, parentContainerRoots } from "./model-container";
import { normalizeModelImportScale, type ModelMaterialSlot } from "@haptic/assets";
import {
  createMaterialPreviewScene,
  type MaterialPreviewScene,
} from "./material-preview";
import { MODEL_IMPORT_SCALE_NODE_NAME } from "./glb-anim";
import { VisualBundle } from "./visual-bundle";
import {
  isGltfModelBytes,
} from "./model-mesh";
import { visualMeshes } from "./visual-meshes";
import { isTilemapChunkMesh } from "./tilemap-mesh";

export { applyMaterialToVisualMeshes, visualMeshes } from "./visual-meshes";

/**
 * Draw each of a Model's meshes with its slot's Material: the slot whose index is the glTF material its primitive
 * draws with in the file. A slot without a Material, or whose Material does not resolve, draws the engine default.
 */
export function applyModelMaterialSlots(
  root: AbstractMesh,
  slots: readonly Pick<ModelMaterialSlot, "index" | "name" | "materialGuid">[],
  resolveMaterial: (guid: string) => Material | null,
): void {
  const guids = new Map(slots.map((slot) => [slot.index, slot.materialGuid]));
  for (const mesh of visualMeshes(root)) {
    if (isTilemapChunkMesh(mesh)) continue;
    const index = modelMaterialIndexOf(mesh);
    if (index === undefined) continue;
    const guid = index === null ? null : guids.get(index) ?? null;
    // A pooled leaf moves to the group of its Material (`setDrawnMaterial`).
    applyMaterialBounds(setDrawnMaterial(mesh, guid ? resolveMaterial(guid) : null));
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
  // Imported models can be much smaller than the material preview primitive.
  // Keep the near plane inside the closest allowed orbit distance.
  host.camera.minZ = 0.01;
  if (options.transparent) {
    host.scene.clearColor = new Color4(0, 0, 0, 0);
  }
  return host;
}

/** glTF container root under the hidden preview placeholder (not the placeholder mesh). */
export function previewRigRoot(host: MaterialPreviewScene): TransformNode {
  const child = host.mesh
    .getChildTransformNodes(true)
    .find((node) => !node.name.endsWith("_overlay"));
  return child ?? host.mesh;
}

const previewRequests = new WeakMap<MaterialPreviewScene, object>();
const previewBundles = new WeakMap<MaterialPreviewScene, VisualBundle>();

export async function loadModelPreviewSource(
  host: MaterialPreviewScene,
  bytes: Uint8Array,
  importScale = 1,
): Promise<{ dispose: () => void; animationGroups: AnimationGroup[] } | null> {
  if (!isGltfModelBytes(bytes)) return null;
  const request = {};
  previewRequests.set(host, request);
  const container = await loadModelContainer(host.scene, bytes, "model-preview.glb");
  const bundle = new VisualBundle();
  bundle.ownRenderUser(container);
  if (host.scene.isDisposed || host.mesh.isDisposed() || previewRequests.get(host) !== request) {
    bundle.dispose();
    return null;
  }
  const priorTarget = host.camera.target.clone();
  const priorRadius = host.camera.radius;
  try {
    const wrapper = new TransformNode(MODEL_IMPORT_SCALE_NODE_NAME, host.scene);
    bundle.ownRenderUser({ dispose: () => { if (!wrapper.isDisposed()) wrapper.dispose(true); } });
    const scale = normalizeModelImportScale(importScale);
    wrapper.scaling.set(scale, scale, scale);
    wrapper.setEnabled(false);
    parentContainerRoots(wrapper, container);
    host.mesh.visibility = 0;
    host.mesh.computeWorldMatrix(true);
    // Imported joint transforms can put the visible rest pose far from raw vertices.
    // Refresh once for framing; avoid CPU skinning on every preview frame.
    for (const skeleton of container.skeletons) skeleton.prepare(true);
    for (const mesh of container.meshes) {
      if (mesh.skeleton) mesh.refreshBoundingInfo({ applySkeleton: true });
    }
    const previous = previewBundles.get(host);
    // Frame the candidate alone; the prior generation can still be visible.
    wrapper.computeWorldMatrix(true);
    const extent = wrapper.getHierarchyBoundingVectors(true, (mesh) => mesh instanceof AbstractMesh && mesh.getTotalVertices() > 0);
    const center = extent.min.add(extent.max).scale(0.5);
    if ([center.x, center.y, center.z].every(Number.isFinite)) host.camera.setTarget(center);
    const size = extent.max.subtract(extent.min).length();
    if (Number.isFinite(size) && size > 0) {
      const lower = host.camera.lowerRadiusLimit ?? 0.5;
      const upper = host.camera.upperRadiusLimit ?? 400;
      host.camera.radius = Math.min(upper, Math.max(lower, size * 1.2));
    }
    container.addAllToScene();
    wrapper.parent = host.mesh;
    wrapper.setEnabled(true);
    previewBundles.set(host, bundle);
    const observer = host.mesh.onDisposeObservable.addOnce(() => bundle.dispose());
    bundle.cancelWith(() => host.mesh.onDisposeObservable.remove(observer));
    previous?.dispose();
    return {
      dispose: () => bundle.dispose(),
      animationGroups: container.animationGroups,
    };
  } catch (error) {
    host.camera.setTarget(priorTarget);
    host.camera.radius = priorRadius;
    bundle.dispose();
    throw error;
  }
}
