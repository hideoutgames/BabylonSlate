import type { Material } from "@babylonjs/core/Materials/material";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";

/**
 * Babylon's node blocks that read lights: they prepare light and shadow defines from a mesh's `lightSources` or bind a
 * light. Re-derive on a pin move (`Materials/Node`, `PrepareDefinesForLight`, `lightSources`).
 */
const LIGHT_READING_BLOCKS = new Set(["LightBlock", "PBRMetallicRoughnessBlock", "LightInformationBlock"]);

const nodeMaterialReads = new WeakMap<NodeMaterial, { buildId: number; blocks: number; reads: boolean }>();

function nodeMaterialReadsLights(material: NodeMaterial): boolean {
  const blocks = material.attachedBlocks;
  const known = nodeMaterialReads.get(material);
  if (known && known.buildId === material.buildId && known.blocks === blocks.length) return known.reads;
  const reads = blocks.some((block) => LIGHT_READING_BLOCKS.has(block.getClassName()));
  nodeMaterialReads.set(material, { buildId: material.buildId, blocks: blocks.length, reads });
  return reads;
}

/** Whether `material` may read lights: any material but a NodeMaterial without a light-reading block, or a multi-material of them. */
function readsLights(material: Material): boolean {
  if (material instanceof NodeMaterial) return nodeMaterialReadsLights(material);
  if (material.getClassName() === "MultiMaterial") {
    return (material as Material & { subMaterials: (Material | null)[] }).subMaterials.some((sub) => !!sub && readsLights(sub));
  }
  return true;
}

type MeshInternals = { _internalAbstractMeshDataInfo: { _materialForRenderPass?: (Material | undefined)[] } };

/**
 * Whether no material that draws `mesh` reads lights: its own, or the Scene's default without one, and each pass's
 * (`setMaterialForRenderPass`). A mesh without a material in a Scene that has no default yet is not: Babylon makes a
 * Standard one when it first draws it.
 */
export function isLightFreeMesh(mesh: AbstractMesh): boolean {
  const material = mesh.material ?? (mesh.getScene() as unknown as { _defaultMaterial?: Material })._defaultMaterial;
  if (!material || readsLights(material)) return false;
  const passes = (mesh as unknown as MeshInternals)._internalAbstractMeshDataInfo._materialForRenderPass;
  if (passes) for (const pass of passes) if (pass && readsLights(pass)) return false;
  return true;
}

/**
 * Babylon marks every define set of a mesh light-dirty when a light joins or leaves its `lightSources` (a light enabled,
 * disabled or limited by the light budget), and each marked set then prepares its defines and asks for its Effect again.
 * A Material that reads no Babylon light (every lit graph Material reads the `HapticLights` block) has no define those
 * change, so a Scene with this installed leaves its light-free meshes unmarked (a patch hook, `Scene._lightFreeMesh`).
 * `lightSources` itself is still kept, for what reads it (shadow caster readiness).
 */
export function installLightFreeMeshes(scene: Scene): void {
  scene._lightFreeMesh = isLightFreeMesh;
}
