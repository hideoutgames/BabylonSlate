import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreatePolyhedron } from "@babylonjs/core/Meshes/Builders/polyhedronBuilder";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { SkeletonSocket } from "@haptic/assets";
import { isRigJointNode } from "./skeleton-preview";
import { setUnlitMaterial, type UnlitMaterialKey } from "./unlit-material";

const SOCKET_MATERIAL: UnlitMaterialKey = { textured: false, backFaceCulling: false, fog: true, role: "preview" };
const SOCKET_COLOR: [number, number, number] = [0.25, 0.8, 1];
const SELECTED_COLOR: [number, number, number] = [1, 0.75, 0.2];
/** A marker spans this share of the rig's rest extent. */
const MARKER_SHARE = 0.035;

/** The Skeleton's sockets drawn on a previewed rig: a marker on each socket's bone, at its offset. */
export interface SkeletonSocketPreviewHandle {
  /** Rebuilds the markers for these sockets; a socket whose bone the rig lacks draws none. */
  setSockets(sockets: readonly SkeletonSocket[]): void;
  /** Draws the named socket's marker in the selection colour. */
  setSelected(name: string | null): void;
  /** The socket's marker (a gizmo moves it), or null. */
  marker(name: string): Mesh | null;
  /** The socket a marker belongs to, for picking. */
  socketOf(mesh: unknown): string | null;
  /** Where the marker sits in its bone's space: the socket's offset after a gizmo moved it. */
  offsetOf(name: string): { position: [number, number, number]; rotation: [number, number, number, number] } | null;
  dispose(): void;
}

/** The node a bone's socket hangs from: a skinned bone's linked node, or a hierarchy rig's joint of that name. */
function boneNode(root: TransformNode, name: string): TransformNode | null {
  for (const mesh of root.getChildMeshes(false)) {
    const linked = mesh.skeleton?.bones.find((bone) => bone.name === name)?.getTransformNode();
    if (linked) return linked;
  }
  return root.getChildTransformNodes(false).find((node) => node.name === name && isRigJointNode(node)) ?? null;
}

function rigExtent(root: TransformNode): number {
  const { min, max } = root.getHierarchyBoundingVectors(true);
  const extent = Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
  return Number.isFinite(extent) && extent > 0 ? extent : 1;
}

export function attachSkeletonSocketPreview(
  root: TransformNode,
  scene: Scene,
  sockets: readonly SkeletonSocket[],
): SkeletonSocketPreviewHandle {
  const markers = new Map<string, Mesh>();
  const owners = new WeakMap<object, string>();
  const size = rigExtent(root) * MARKER_SHARE;
  let selected: string | null = null;
  const scratch = new Vector3();

  const colour = (name: string) => {
    const mesh = markers.get(name);
    if (!mesh) return;
    setUnlitMaterial(mesh, SOCKET_MATERIAL, {
      texture: null, color: name === selected ? SELECTED_COLOR : SOCKET_COLOR, alpha: 1, cutoff: 0, blend: false, textureAlpha: false, twoSided: true,
    });
  };

  const clear = () => {
    for (const mesh of markers.values()) mesh.dispose(false, true);
    markers.clear();
  };

  const build = (list: readonly SkeletonSocket[]) => {
    clear();
    for (const socket of list) {
      const parent = boneNode(root, socket.bone);
      if (!parent) continue;
      const mesh = CreatePolyhedron(`socket_${socket.name}`, { type: 1, size: 1 }, scene);
      mesh.parent = parent;
      mesh.position.set(...socket.position);
      mesh.rotationQuaternion = new Quaternion(...socket.rotation);
      // The same size on screen whatever the bone's scale.
      parent.computeWorldMatrix(true).decompose(scratch);
      const unit = Math.max(Math.abs(scratch.x), Math.abs(scratch.y), Math.abs(scratch.z)) || 1;
      mesh.scaling.setAll(size / unit);
      mesh.isPickable = true;
      mesh.alwaysSelectAsActiveMesh = true;
      owners.set(mesh, socket.name);
      markers.set(socket.name, mesh);
      colour(socket.name);
    }
  };

  build(sockets);
  return {
    setSockets: build,
    setSelected(name) {
      const previous = selected;
      selected = name;
      if (previous) colour(previous);
      if (name) colour(name);
    },
    marker: (name) => markers.get(name) ?? null,
    socketOf: (mesh) => (mesh && typeof mesh === "object" ? owners.get(mesh) ?? null : null),
    offsetOf(name) {
      const mesh = markers.get(name);
      if (!mesh) return null;
      const q = mesh.rotationQuaternion ?? Quaternion.Identity();
      return { position: [mesh.position.x, mesh.position.y, mesh.position.z], rotation: [q.x, q.y, q.z, q.w] };
    },
    dispose: clear,
  };
}
