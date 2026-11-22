import type { Material } from "@babylonjs/core/Materials/material";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { isEditorHelperMesh } from "./helper-mesh";
import { isSkyboxMesh } from "./skybox";
import { hasBoundedLatticeDeformer, hasMeshLatticeDeformer } from "./lattice-deformer-binding";
import { isMirrorSurfaceMesh } from "./mirror-surface-state";
import { followsPose } from "./pose-bounds";
import { isWaterSurfaceMesh } from "./water-mesh-surface";
export type ShadowParticipation = {
  castShadows?: boolean;
  receiveShadows?: boolean;
  /**
   * A warm-up's stand-in for a spawn (`spawnable-warm.ts`): it casts into no shadow map, yet a pool member stays in the
   * group the spawn joins, which casts, so the group it warms is the spawn's.
   */
  spawnStandIn?: boolean;
};
export function authoredShadowParticipation(
  mesh: AbstractMesh,
): ShadowParticipation {
  for (
    let node = mesh as import("@babylonjs/core/node").Node | null;
    node;
    node = node.parent
  ) {
    if (node.metadata?.hapticShadowParticipation)
      return node.metadata.hapticShadowParticipation as ShadowParticipation;
  }
  return {};
}
/**
 * Visible geometry-less particle emitters would otherwise refresh shadow maps every frame: an actor's slot emitters
 * and the ones a Spawn Emitter makes (`particle-service.ts`).
 */
const PARTICLE_EMITTER_PREFIXES = ["particleEmitter:", "particleSpawn:"];

export function participatesInShadows(mesh: AbstractMesh): boolean {
  // A LOD level is drawn by its master's shadow-map entry.
  if (mesh.isBlocked) return false;
  if (mesh.name.startsWith("__")) return false;
  if (isSkyboxMesh(mesh)) return false;
  if (mesh instanceof LinesMesh) return false;
  if (PARTICLE_EMITTER_PREFIXES.some((prefix) => mesh.name.startsWith(prefix))) return false;
  return !isEditorHelperMesh(mesh);
}

/**
 * Water surfaces receive shadows but never cast them: they are alpha-blended and displaced in the vertex shader, so
 * they would draw nothing useful into a map, yet as casters their dynamic geometry would force every local shadow map
 * to refresh each frame and split large grids into extra draws. Mirror surfaces never cast either. This holds even
 * when authored participation casts.
 */
export function neverCastsShadows(mesh: AbstractMesh): boolean {
  // Mirror surfaces are flat reflections: as casters they would only add a depth variant to compile.
  return isWaterSurfaceMesh(mesh) || isMirrorSurfaceMesh(mesh);
}

/**
 * Whether a caster draws nothing into any shadow map now: a plain Babylon `Mesh` (no subclass, which could draw by
 * other means) with no geometry and no levels of detail, such as an actor's root. Its instances, thin instances,
 * sub-meshes and children draw nothing through it. Read again every frame: geometry applied or released, or a level of
 * detail added, changes the answer.
 */
export function drawsNoShadow(mesh: AbstractMesh): boolean {
  return Object.getPrototypeOf(mesh) === Mesh.prototype && !(mesh as Mesh).geometry && (mesh as Mesh).getLODLevels().length === 0;
}

/** Bind-pose bounds cannot certify where GPU-deformed vertices will be. */
export function hasDeformingShadowBounds(mesh: AbstractMesh): boolean {
  return (
    hasMeshLatticeDeformer(mesh) ||
    !!mesh.skeleton ||
    !!mesh.morphTargetManager ||
    (mesh instanceof Mesh && !!mesh.bakedVertexAnimationManager) ||
    Number(mesh.material?.metadata?.boundsPadding ?? 0) > 0
  );
}

/**
 * Whether every part of `mesh` needs alpha blending, so a shadow map draws nothing of it: Babylon's shadow generator
 * sorts a map's parts as `RenderingGroup.dispatch` does and draws the blended ones only under `transparencyShadow`,
 * which no Haptic map sets. Read as the map's dispatch reads it: each part's Material from the mesh that draws it (an
 * instance's source), asked for the caster and for that mesh; a mesh with levels of detail (which may draw another
 * mesh), a Material for a render pass, or a part without a Material says no. Cheap for a mesh that draws: its first
 * part ends the read. Read again every walk (alpha, transparency, visibility and vertex alpha have no write point here).
 */
export function drawsOnlyBlended(mesh: AbstractMesh): boolean {
  const parts = mesh.subMeshes;
  if (!parts?.length) return false;
  const drawn = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh;
  for (let index = 0; index < parts.length; index++) {
    const material = partMaterial(drawn, parts[index]!.materialIndex);
    if (!material || !material.needAlphaBlendingForMesh(mesh) || (drawn !== mesh && !material.needAlphaBlendingForMesh(drawn))) return false;
  }
  return !(drawn instanceof Mesh && drawn.getLODLevels().length) && !drawn._internalAbstractMeshDataInfo._materialForRenderPass;
}

/** The Material a part of `mesh` draws with outside a render pass's own (`SubMesh.getMaterial`), without its side effects. */
function partMaterial(mesh: AbstractMesh, materialIndex: number): Material | null {
  const material = mesh.material ?? (mesh.getScene()._hasDefaultMaterial ? mesh.getScene().defaultMaterial : null);
  if (material instanceof MultiMaterial) return material.getSubMaterial(materialIndex);
  return material;
}

/**
 * Whether a caster draws nothing into a map now: it draws nothing at all (`drawsNoShadow`), or only blended parts
 * (`drawsOnlyBlended`) while no map draws blended parts (`blendedDraws`, a map's `transparencyShadow`).
 */
export function castsNoShadowDepth(mesh: AbstractMesh, blendedDraws: boolean): boolean {
  return drawsNoShadow(mesh) || (!blendedDraws && drawsOnlyBlended(mesh));
}

/**
 * Whether `mesh`'s bounds hold what it draws although it deforms: a skinned mesh whose bounds follow its skeleton
 * (`pose-bounds.ts`), with any padding its Material asks for, or a mesh whose only deformation is a lattice cage that
 * widened its bounds to the cage's hull (`hasBoundedLatticeDeformer`). A shadow list may then cull it by them.
 */
export function deformsWithinBounds(mesh: AbstractMesh): boolean {
  if (!hasMeshLatticeDeformer(mesh)) return followsPose(mesh);
  // The cage's hull with the undeformed bounds holds the cage's deformation of the geometry, not another deformation.
  return (
    !mesh.skeleton &&
    !mesh.morphTargetManager &&
    !(mesh instanceof Mesh && mesh.bakedVertexAnimationManager) &&
    !(Number(mesh.material?.metadata?.boundsPadding ?? 0) > 0) &&
    hasBoundedLatticeDeformer(mesh)
  );
}

/**
 * Whether a caster can reach a local light's range. Skinned, morphed and
 * lattice-deformed geometry can leave its bind-pose bounds, so it gets twice
 * its bounding radius, unless its bounds follow it (`deformsWithinBounds`). The deforming test walks the parent chain
 * and a material, so it runs only for casters between the one-radius and two-radius reach: this
 * is called for every caster, light and frame.
 */
export function casterWithinShadowRange(mesh: AbstractMesh, position: Vector3, range: number, cone?: ShadowCone | null): boolean {
  const sphere = mesh.getBoundingInfo().boundingSphere;
  const radius = sphere.radiusWorld;
  const center = sphere.centerWorld;
  const distance = Vector3.Distance(center, position);
  let reach = radius;
  if (!(distance <= range + radius)) {
    // Negated so a NaN distance stays out of range, as with the single comparison.
    if (!(distance <= range + 2 * radius) || !hasDeformingShadowBounds(mesh) || deformsWithinBounds(mesh)) return false;
    reach = 2 * radius;
  }
  return !cone || sphereTouchesCone(center.x - position.x, center.y - position.y, center.z - position.z, reach, cone);
}

/**
 * The cone a spot light's shadow map can hold anything in, from the light's position: around its unit shadow direction
 * (`x`, `y`, `z`), the half-angle (as its cosine and sine) of the corners of the map's square frustum, whose full field of
 * view is `fov`. Null when that frustum is not narrower than a half-space: then every direction counts.
 */
export type ShadowCone = { x: number; y: number; z: number; cos: number; sin: number };

const sharedCone: ShadowCone = { x: 0, y: 0, z: 1, cos: 0, sin: 1 };

/**
 * Asked per spot light each frame, so every call answers with the same cone, which the next call rewrites: read it
 * before asking again.
 */
export function spotShadowCone(direction: Vector3, fov: number): ShadowCone | null {
  const cone = sharedCone;
  const length = direction.length();
  // The square frustum's corners lie atan(√2 tan(fov / 2)) off its axis.
  const half = Math.atan(Math.SQRT2 * Math.tan(fov / 2));
  if (!(length > 0) || !(fov > 0) || !(fov < Math.PI) || !(half < Math.PI / 2)) return null;
  cone.x = direction.x / length;
  cone.y = direction.y / length;
  cone.z = direction.z / length;
  cone.cos = Math.cos(half);
  cone.sin = Math.sin(half);
  return cone;
}

/**
 * Whether a sphere at `(x, y, z)` from a cone's apex, of radius `radius`, may touch the cone. Conservative: a sphere
 * within a hair of the cone's surface counts, and a non-finite position does too.
 */
export function sphereTouchesCone(x: number, y: number, z: number, radius: number, cone: ShadowCone): boolean {
  const along = x * cone.x + y * cone.y + z * cone.z;
  const squared = x * x + y * y + z * z;
  const across = Math.sqrt(Math.max(0, squared - along * along));
  const slack = radius + 1e-4 * (1 + Math.sqrt(squared));
  // Behind the apex's side of the cone's surface the nearest point of the cone is the apex itself.
  if (along * cone.cos + across * cone.sin < 0) return !(squared > slack * slack);
  // Else the distance to the surface, negative inside.
  return !(across * cone.cos - along * cone.sin > slack);
}
