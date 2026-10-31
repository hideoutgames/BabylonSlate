import { Mesh, type InstancedMesh, type Material, type Scene } from "@babylonjs/core";
import { materialIneligibility, sceneInstancePool, sceneInstancing, type InstanceGeometry } from "./instance-pool";
import { RENDERING_GROUP } from "./sorting";
import { attachPooledLeaf } from "./pooled-visuals";
import { createPrimitiveMesh } from "./scene-component-mesh";
import { occluderShape, registerOccluderShape } from "./view-occlusion";

/** The primitive kinds a pool group can draw (`createPrimitiveMesh`'s 3D shapes). */
const POOLED_KINDS = new Set(["box", "sphere", "cylinder", "plane", "quad", "ground"]);

const templates = new WeakMap<Scene, Map<string, InstanceGeometry>>();

/** `scene`'s template geometry of primitive `kind`: one disabled mesh per kind, cloned per group, sharing its geometry. */
function primitiveGeometry(scene: Scene, kind: string): InstanceGeometry {
  let byKind = templates.get(scene);
  if (!byKind) templates.set(scene, (byKind = new Map()));
  let geometry = byKind.get(kind);
  if (!geometry) {
    const template = createPrimitiveMesh(scene, `instanceTemplate:${kind}`, kind);
    template.setEnabled(false);
    template.isPickable = false;
    template.doNotSerialize = true;
    geometry = {
      key: `primitive:${kind}`,
      build: (_scene, name) => {
        const source = template.clone(name, null, true, false);
        source.setEnabled(true);
        source.isPickable = true;
        // A member occludes as the primitive does (`occluderShape` reads an instance's source): the source itself, hidden,
        // is in no view's list, so it neither occludes nor is occluded.
        registerOccluderShape(source, occluderShape(template) ?? null);
        return source;
      },
    };
    byKind.set(kind, geometry);
  }
  return geometry;
}

/**
 * A primitive visual drawn through `scene`'s instance pool, when instancing is on (`setSceneInstancing`) and the kind
 * is one a group draws: a root `Mesh` without geometry named `name` (the slot root or named part, which keeps every
 * transform, flag and record keyed by it) and a pool member at identity under it, `name:drawn`. Null otherwise.
 */
export function createPooledPrimitiveVisual(scene: Scene, name: string, kind: string | null | undefined): Mesh | null {
  if (!kind || !POOLED_KINDS.has(kind) || !sceneInstancing(scene)) return null;
  const root = new Mesh(name, scene);
  const leaf = sceneInstancePool(scene).join(
    { geometry: primitiveGeometry(scene, kind), material: null, receiveShadows: true, renderingGroupId: root.renderingGroupId },
    `${name}:drawn`,
  );
  leaf.parent = root;
  attachPooledLeaf(root, leaf);
  return root;
}

/**
 * A member of the group a spawned primitive of `kind` drawn with `material` joins (receiving shadows, in the world
 * rendering group), for a warm-up that stages what Play may spawn: it compiles and draws the group's instanced
 * variants, which a pooled spawn draws with. Null when such a spawn would draw unpooled.
 */
export function joinPooledPrimitiveGroup(scene: Scene, kind: string, material: Material, name: string): InstancedMesh | null {
  if (!POOLED_KINDS.has(kind) || !sceneInstancing(scene)) return null;
  const member = sceneInstancePool(scene).join(
    { geometry: primitiveGeometry(scene, kind), material, receiveShadows: true, renderingGroupId: RENDERING_GROUP.world }, name);
  if (!materialIneligibility(member.sourceMesh, material)) return member;
  // A group that never drew goes with its last member.
  member.dispose();
  return null;
}
