import {
  Matrix,
  Quaternion,
  Vector3,
  type AbstractMesh,
  type DeepImmutable,
} from "@babylonjs/core";

const scratchScale = new Vector3();
const scratchRotation = new Quaternion();
const scratchPosition = new Vector3();
const scratchLocal = Matrix.Identity();
const scratchParentInverse = Matrix.Identity();

/**
 * Selected actors whose parent is not also selected. Gizmo group transforms
 * apply to these roots only so a selected child is not double-moved.
 */
export function selectionGizmoRoots(
  selectedIds: readonly string[],
  parentIdOf: (id: string) => string | null,
): string[] {
  const selected = new Set(selectedIds);
  return selectedIds.filter((id) => {
    let parent = parentIdOf(id);
    while (parent) {
      if (selected.has(parent)) return false;
      parent = parentIdOf(parent);
    }
    return true;
  });
}

/** First pickable selection root — the mesh the viewport gizmo attaches to. */
export function pickGizmoAttachActorId(
  selectedIds: readonly string[],
  parentIdOf: (id: string) => string | null,
  isPickable: (id: string) => boolean,
): string | null {
  return (
    selectionGizmoRoots(selectedIds, parentIdOf).find((id) => isPickable(id)) ??
    null
  );
}

/**
 * World-space TRS delta that takes `startWorld` to `currentWorld`.
 * Babylon uses row vectors, so `newWorld = startWorld * delta`.
 */
export function worldDelta(
  startWorld: DeepImmutable<Matrix>,
  currentWorld: DeepImmutable<Matrix>,
): Matrix {
  const inverseStart = Matrix.Invert(startWorld);
  return inverseStart.multiply(currentWorld);
}

/**
 * Writes `startWorld * delta` onto `mesh` as a parent-relative local TRS.
 */
export function applyWorldDeltaToMesh(
  mesh: AbstractMesh,
  startWorld: DeepImmutable<Matrix>,
  delta: DeepImmutable<Matrix>,
): void {
  const newWorld = startWorld.multiply(delta);
  let local: DeepImmutable<Matrix> = newWorld;
  const parent = mesh.parent;
  if (parent) {
    parent.computeWorldMatrix(true);
    parent.getWorldMatrix().invertToRef(scratchParentInverse);
    newWorld.multiplyToRef(scratchParentInverse, scratchLocal);
    local = scratchLocal;
  }
  local.decompose(scratchScale, scratchRotation, scratchPosition);
  mesh.position.copyFrom(scratchPosition);
  mesh.rotationQuaternion ??= new Quaternion();
  mesh.rotationQuaternion.copyFrom(scratchRotation);
  mesh.scaling.copyFrom(scratchScale);
}

export interface GizmoMultiSelectFollower {
  mesh: AbstractMesh;
  startWorld: Matrix;
}

export interface GizmoMultiSelectDrag {
  pivotStartWorld: Matrix;
  followers: GizmoMultiSelectFollower[];
}

export function beginGizmoMultiSelectDrag(
  attached: AbstractMesh | null,
  followerMeshes: readonly AbstractMesh[],
): GizmoMultiSelectDrag | null {
  if (!attached) return null;
  attached.computeWorldMatrix(true);
  return {
    pivotStartWorld: attached.getWorldMatrix().clone(),
    followers: followerMeshes.map((mesh) => {
      mesh.computeWorldMatrix(true);
      return { mesh, startWorld: mesh.getWorldMatrix().clone() };
    }),
  };
}

export function applyGizmoMultiSelectDrag(
  drag: GizmoMultiSelectDrag,
  attached: AbstractMesh,
): void {
  attached.computeWorldMatrix(true);
  const delta = worldDelta(drag.pivotStartWorld, attached.getWorldMatrix());
  for (const follower of drag.followers) {
    applyWorldDeltaToMesh(follower.mesh, follower.startWorld, delta);
  }
}

export function readMeshLocalTransform(mesh: AbstractMesh): {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
} {
  const rotation = mesh.rotationQuaternion
    ? mesh.rotationQuaternion
    : Quaternion.FromEulerVector(mesh.rotation);
  return {
    position: [mesh.position.x, mesh.position.y, mesh.position.z],
    rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
    scale: [mesh.scaling.x, mesh.scaling.y, mesh.scaling.z],
  };
}
