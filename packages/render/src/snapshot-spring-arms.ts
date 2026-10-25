import { Quaternion, TransformNode, Vector3, type Mesh } from "@babylonjs/core";
import { parseSpringArmProperties } from "@haptic/core";
import { updateAuthoredCameraTransform } from "./scene-illumination";
import {
  attachmentParentFor,
  createPlaySpringArmRig,
  setSpringArmCameraAnchor,
  springArmCameraAnchorOf,
  springArmRigsOf,
  SPRING_ARM_MESH_KIND,
  updateSpringArmRig,
  type SpringArmLagStore,
} from "./spring-arm";
import {
  SlotKeyedMap,
  slotKeysOf,
  type AssignMeshPart,
  type SnapshotSceneBinding,
} from "./snapshot-binding";
import { hasActorIllumination } from "./snapshot-illumination";

type SpringArmPlayState = { store: SpringArmLagStore; slots: Set<number>; lastMs: number | null };

const springArmStates = new WeakMap<SnapshotSceneBinding, SpringArmPlayState>();

function springArmStateOf(binding: SnapshotSceneBinding): SpringArmPlayState {
  let state = springArmStates.get(binding);
  if (!state) {
    state = { store: new SlotKeyedMap(), slots: new Set(), lastMs: null };
    springArmStates.set(binding, state);
  }
  return state;
}

/** Rig spring arm parts, attach their children at the socket, and anchor the slot camera. */
export function attachPlaySpringArms(
  binding: SnapshotSceneBinding,
  root: Mesh,
  slotId: number,
  parts: readonly AssignMeshPart[],
  meshes: ReadonlyMap<string, Mesh>,
): void {
  const partsById = new Map(parts.map((part) => [part.componentId, part]));
  const depthOf = (part: AssignMeshPart) => {
    const seen = new Set<string>();
    let depth = 0;
    for (let id: string | null | undefined = part.parentId; id && !seen.has(id); id = partsById.get(id)?.parentId) {
      seen.add(id);
      depth++;
    }
    return depth;
  };
  // Parent arms update first so nested arms lag toward an already lagged socket.
  const arms = parts
    .filter((part) => part.meshKind === SPRING_ARM_MESH_KIND)
    .sort((a, b) => depthOf(a) - depthOf(b));
  if (arms.length === 0) return;
  for (const part of arms) {
    const arm = meshes.get(part.componentId);
    if (!arm) continue;
    createPlaySpringArmRig(root, arm, `${slotId}|${part.componentId}`, parseSpringArmProperties(part.springArm));
  }
  for (const part of parts) {
    const child = meshes.get(part.componentId);
    const parent = part.parentId ? meshes.get(part.parentId) : undefined;
    if (child && parent) {
      let attachment: TransformNode = child;
      // Preserve nonvisual component ancestors when redirecting to an arm socket.
      for (let i = 0; i < (part.parentTransforms?.length ?? 0); i++) {
        if (attachment.parent instanceof TransformNode) attachment = attachment.parent;
      }
      const socket = attachmentParentFor(parent);
      if (socket !== attachment && !socket.isDescendantOf(attachment)) attachment.parent = socket;
    }
  }
  const cameraPart = parts.find((part) => part.meshKind === "camera");
  const anchor = cameraPart ? meshes.get(cameraPart.componentId) : undefined;
  if (anchor) setSpringArmCameraAnchor(root, anchor);
  springArmStateOf(binding).slots.add(slotId);
}

const scratchAnchorScale = new Vector3();
const scratchAnchorRotation = new Quaternion();
const scratchAnchorPosition = new Vector3();

/** Step every spring arm lag once per applied snapshot and pose cameras at their sockets. */
export function updatePlaySpringArms(binding: SnapshotSceneBinding, nowMs: number): void {
  const state = springArmStates.get(binding);
  if (!state || state.slots.size === 0) return;
  const dtSeconds = state.lastMs === null ? 0 : Math.max(0, nowMs - state.lastMs) / 1000;
  state.lastMs = nowMs;
  for (const slotId of state.slots) {
    // Staged replacements register their rigs before the slot adopts them.
    const root = binding.meshes.get(slotId);
    if (!root) continue;
    const rigs = springArmRigsOf(root);
    for (const rig of rigs) updateSpringArmRig(rig, state.store, dtSeconds);
    const camera = binding.cameras.get(slotId);
    const anchor = springArmCameraAnchorOf(root);
    if (!camera || !anchor || hasActorIllumination(root)) continue;
    anchor.computeWorldMatrix(true).decompose(scratchAnchorScale, scratchAnchorRotation, scratchAnchorPosition);
    updateAuthoredCameraTransform(camera, scratchAnchorPosition, scratchAnchorRotation);
  }
}

export function retireSpringArmLag(binding: SnapshotSceneBinding, slotId: number): void {
  const state = springArmStates.get(binding);
  if (!state) return;
  state.slots.delete(slotId);
  for (const key of slotKeysOf(state.store, slotId)) state.store.delete(key);
}

export function disposeSpringArmState(binding: SnapshotSceneBinding): void {
  springArmStates.delete(binding);
}
