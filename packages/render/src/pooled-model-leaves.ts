import { Mesh, type AbstractMesh, type AnimationGroup, type AssetContainer, type Geometry, type InstancedMesh, type Scene } from "@babylonjs/core";
import { instancingIneligibility, sceneInstancePool, sceneInstancing, type InstanceGeometry } from "./instance-pool";
import { attachTemplateLods } from "./model-lod";
import { animatesOnlyTransform, handOverNode } from "./node-handover";

/** Each Scene's model leaf geometries, by the container geometry their clones share. */
const geometries = new WeakMap<Scene, WeakMap<Geometry, InstanceGeometry>>();

/**
 * The pool geometry of a container mesh: its group sources clone it, sharing its geometry, and each group holds the
 * container (`retain`) so that geometry outlives the instance that first joined it.
 */
function leafGeometry(scene: Scene, template: Mesh, retain: () => () => void): InstanceGeometry {
  let byGeometry = geometries.get(scene);
  if (!byGeometry) geometries.set(scene, (byGeometry = new WeakMap()));
  const shared = template.geometry!;
  let geometry = byGeometry.get(shared);
  if (!geometry) {
    geometry = {
      key: `model:${shared.uniqueId}`,
      build: (_scene, name) => {
        const source = template.clone(name, null, true, false);
        source.setEnabled(true);
        source.isVisible = true;
        attachTemplateLods(source, template);
        return source;
      },
      retain,
    };
    byGeometry.set(shared, geometry);
  }
  return geometry;
}

/**
 * Whether the model mesh `mesh` may draw as a pool member: a visible, rigid mesh whose geometry a container mesh holds,
 * with no skeleton or morphs, and whose animations in `groups` move only its transform (a member's own). Its children
 * move to the member. The rest is `instancingIneligibility`. Auto LOD gives its group's source the levels
 * (`attachModelLods`).
 */
function poolsLeaf(mesh: AbstractMesh, groups: readonly AnimationGroup[]): mesh is Mesh {
  if (!(mesh instanceof Mesh) || !mesh.geometry || !mesh.isVisible) return false;
  if (mesh.skeleton || mesh.morphTargetManager) return false;
  if (!animatesOnlyTransform(mesh, groups)) return false;
  return instancingIneligibility(mesh, mesh.material) === null;
}

/**
 * Replaces the eligible meshes of a model instance under `root` with members of `root`'s Scene's instance pool, in
 * place: same parent, children, name, transform, flags, metadata and glTF primitive (its Material slot), and the
 * channels of the instance's `animationGroups` that moved the mesh move the member. Returns the members. Only where
 * the Scene pools (`sceneInstancing`).
 */
export function poolModelLeaves(root: AbstractMesh, container: AssetContainer, options: {
  /** Takes a hold on the container for a group (a lease of the cached GLB); returns its release. */
  retain: () => () => void;
  /** The instance's animation groups, whose channels target its own nodes. */
  animationGroups?: readonly AnimationGroup[];
}): InstancedMesh[] {
  const scene = root.getScene();
  if (!sceneInstancing(scene)) return [];
  const templates = new Map<Geometry, Mesh>();
  for (const mesh of container.meshes) if (mesh instanceof Mesh && mesh.geometry && !templates.has(mesh.geometry)) templates.set(mesh.geometry, mesh);
  const pool = sceneInstancePool(scene);
  const members: InstancedMesh[] = [];
  const groups = options.animationGroups ?? [];
  for (const leaf of root.getChildMeshes(false)) {
    if (!poolsLeaf(leaf, groups)) continue;
    const template = templates.get(leaf.geometry!);
    if (!template) continue;
    const member = pool.join({
      geometry: leafGeometry(scene, template, options.retain),
      material: leaf.material,
      receiveShadows: leaf.receiveShadows,
      renderingGroupId: leaf.renderingGroupId,
    }, leaf.name);
    member.parent = leaf.parent;
    member.position.copyFrom(leaf.position);
    if (leaf.rotationQuaternion) member.rotationQuaternion = leaf.rotationQuaternion.clone();
    else member.rotation.copyFrom(leaf.rotation);
    member.scaling.copyFrom(leaf.scaling);
    member.isPickable = leaf.isPickable;
    member.layerMask = leaf.layerMask;
    member.metadata = leaf.metadata;
    // The glTF primitive record names the leaf's Material slot (`modelMaterialIndexOf`).
    (member as unknown as { _internalMetadata: unknown })._internalMetadata = (leaf as unknown as { _internalMetadata: unknown })._internalMetadata;
    handOverNode(scene, leaf, member, groups);
    leaf.dispose(false, false);
    members.push(member);
  }
  return members;
}
