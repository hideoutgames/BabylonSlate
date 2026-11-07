import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { DeepImmutable } from "@babylonjs/core/types";

const scratchScale = new Vector3();
const scratchRotation = new Quaternion();
const scratchPosition = new Vector3();
const scratchLocal = Matrix.Identity();
const scratchParentInverse = Matrix.Identity();
const scratchInverseStart = Matrix.Identity();
const scratchNewWorld = Matrix.Identity();
const scratchDelta = Matrix.Identity();

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
  result = new Matrix(),
): Matrix {
  startWorld.invertToRef(scratchInverseStart);
  return scratchInverseStart.multiplyToRef(currentWorld, result);
}

/**
 * Writes `startWorld * delta` onto `mesh` as a parent-relative local TRS.
 */
export function applyWorldDeltaToMesh(
  mesh: AbstractMesh,
  startWorld: DeepImmutable<Matrix>,
  delta: DeepImmutable<Matrix>,
): void {
  if (mesh.isWorldMatrixFrozen) mesh.unfreezeWorldMatrix();
  const newWorld = startWorld.multiplyToRef(delta, scratchNewWorld);
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

interface GizmoMultiSelectFollower {
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
  applyGizmoMultiSelectDragTo(drag, attached.getWorldMatrix());
}

/** Followers take the delta that brings the pivot from its start to `pivotWorld`. */
export function applyGizmoMultiSelectDragTo(
  drag: GizmoMultiSelectDrag,
  pivotWorld: DeepImmutable<Matrix>,
): void {
  const delta = worldDelta(drag.pivotStartWorld, pivotWorld, scratchDelta);
  for (const follower of drag.followers) {
    applyWorldDeltaToMesh(follower.mesh, follower.startWorld, delta);
  }
}

const scratchComposed = Matrix.Identity();
const scratchPivotWorld = Matrix.Identity();
const scratchStartScale = new Vector3();
const scratchStartRotation = new Quaternion();
const scratchStartPosition = new Vector3();

/**
 * World pose `mesh` would have at its drag-start local TRS with only its
 * `axis` scale set to `value`: the pivot of an axis scale drag, before a
 * linked owner's other axes are rescaled.
 */
export function axisScaledPivotWorld(
  mesh: AbstractMesh,
  start: ReturnType<typeof readMeshLocalTransform>,
  axis: 0 | 1 | 2,
  value: number,
): Matrix {
  scratchStartScale.fromArray(start.scale);
  if (axis === 0) scratchStartScale.x = value;
  else if (axis === 1) scratchStartScale.y = value;
  else scratchStartScale.z = value;
  scratchStartRotation.set(...start.rotation);
  scratchStartPosition.fromArray(start.position);
  Matrix.ComposeToRef(scratchStartScale, scratchStartRotation, scratchStartPosition, scratchComposed);
  const parent = mesh.parent;
  if (!parent) return scratchPivotWorld.copyFrom(scratchComposed);
  parent.computeWorldMatrix(true);
  return scratchComposed.multiplyToRef(parent.getWorldMatrix(), scratchPivotWorld);
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
