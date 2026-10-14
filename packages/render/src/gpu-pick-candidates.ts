import { InstancedMesh, Material, Mesh, MultiMaterial, TransformNode, type AbstractMesh, type Node, type Plane, type Scene } from "@babylonjs/core";
import { hasStockVertexStage } from "./shadow-material-policy";
import { hasDeformingShadowBounds } from "./shadow-mesh-policy";

function isWater(mesh: AbstractMesh): boolean {
  return (mesh.metadata as { slateWater?: unknown } | null)?.slateWater === true;
}

/** Points rasterise wider than the pixel their vertex lands in, so their bounds say nothing about coverage. */
function keepsVertices(material: Material): boolean {
  if (material instanceof MultiMaterial) return material.subMaterials.every((part) => !part || keepsVertices(part));
  if (material.pointsCloud || material.fillMode === Material.PointFillMode || material.fillMode === Material.PointListDrawMode) return false;
  return hasStockVertexStage(material);
}

/**
 * Whether `mesh` can only draw inside its bounding box, so a pick pixel its bounds miss is a pixel
 * it cannot cover. Anything the GPU may place elsewhere answers false and is always drawn:
 * skinned, morphed, baked-animation, lattice-deformed and padded-bounds meshes (the shadow
 * policy's deforming set), water, thin instances, regular-instance batches, LOD chains, meshes
 * whose world matrix follows the camera or whose bounds are not kept in sync, point clouds, and
 * any material that is not Babylon's stock vertex stage or a compiled static surface.
 */
export function boundsCertifyDrawnGeometry(mesh: AbstractMesh): boolean {
  if (mesh.doNotSyncBoundingInfo || mesh._masterMesh || mesh instanceof InstancedMesh) return false;
  if (mesh instanceof Mesh && (mesh.instances.length > 0 || mesh.hasThinInstances || mesh.getLODLevels().length > 0)) return false;
  if (hasDeformingShadowBounds(mesh) || isWater(mesh)) return false;
  for (let node: Node | null = mesh; node; node = node.parent)
    if (node instanceof TransformNode && node.isWorldMatrixCameraDependent()) return false;
  return keepsVertices(mesh.material ?? mesh.getScene().defaultMaterial);
}

/** The mesh's world box, brought up to date the way drawing would, meets the frustum; corrupt bounds rule nothing out. */
function boundsMeetFrustum(mesh: AbstractMesh, planes: readonly Plane[]): boolean {
  mesh.computeWorldMatrix();
  // The box alone: Babylon's sphere scales by the longest axis, which a shear outgrows.
  const box = mesh.getBoundingInfo().boundingBox;
  const { minimumWorld: min, maximumWorld: max } = box;
  if (!Number.isFinite(min.x + min.y + min.z + max.x + max.y + max.z)) return true;
  return box.isInFrustum(planes);
}

/**
 * The meshes a GPU pick must draw for the pixel whose clip volume is `planes`: every mesh whose
 * bounds meet it, plus every mesh whose bounds cannot be trusted. A mesh left out cannot cover the
 * pixel, so the nearest drawn fragment is the same as with every pickable mesh submitted.
 */
export function pickCandidates(scene: Scene, meshes: readonly AbstractMesh[], planes: readonly Plane[]): AbstractMesh[] {
  const degenerate = planes.some((plane) => !Number.isFinite(plane.normal.x + plane.normal.y + plane.normal.z + plane.d));
  if (degenerate || scene.forcePointsCloud) return [...meshes];
  return meshes.filter((mesh) => !boundsCertifyDrawnGeometry(mesh) || boundsMeetFrustum(mesh, planes));
}
