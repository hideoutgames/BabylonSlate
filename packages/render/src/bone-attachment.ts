import { Matrix, Quaternion, Vector3, type AbstractMesh, type Bone, type Mesh, type TransformNode } from "@babylonjs/core";
import type { CommandMessage } from "@babylonslate/bridge";

export type BoneAttachmentCommand = Extract<CommandMessage, { type: "attachToBone" }>;
export interface BoneAttachment {
  targetSlotId: number;
  boneName: string;
  world: Matrix;
  local: Matrix;
  boneWorld: Matrix;
  position: Vector3;
  scale: Vector3;
  rotation: Quaternion;
  inverseRotation: Quaternion;
  frame: number;
  applied: boolean;
  root?: Mesh;
  resolved?: { node: TransformNode } | { bone: Bone; mesh: AbstractMesh };
}

export interface BoneAttachmentBinding {
  meshes: Map<number, Mesh>;
  boneAttachments: Map<number, BoneAttachment>;
}

/** Store intent before the model exists; resolving each frame also handles replacements. */
export function applyAttachToBone(binding: BoneAttachmentBinding, command: BoneAttachmentCommand): void {
  if (command.targetSlotId === null) {
    binding.boneAttachments.delete(command.slotId);
    return;
  }
  if (!command.boneName.trim()) return;
  const visited = new Set<number>([command.slotId]);
  let target: number | undefined = command.targetSlotId;
  while (target !== undefined) {
    if (visited.has(target)) return;
    visited.add(target);
    target = binding.boneAttachments.get(target)?.targetSlotId;
  }
  binding.boneAttachments.set(command.slotId, {
    targetSlotId: command.targetSlotId, boneName: command.boneName,
    world: Matrix.Identity(), local: Matrix.Identity(), boneWorld: Matrix.Identity(),
    position: Vector3.Zero(), scale: Vector3.One(), rotation: Quaternion.Identity(), inverseRotation: Quaternion.Identity(), frame: -1, applied: false,
  });
}

export function retireBoneAttachments(binding: BoneAttachmentBinding, slotId: number): void {
  binding.boneAttachments.delete(slotId);
  for (const [childId, attachment] of binding.boneAttachments) {
    if (attachment.targetSlotId === slotId) binding.boneAttachments.delete(childId);
  }
}

function resolveBone(root: Mesh, name: string): BoneAttachment["resolved"] {
  // Linked glTF nodes already include the model root transform.
  for (const mesh of [root, ...root.getChildMeshes(false)]) {
    const skeleton = mesh.skeleton;
    const bone = skeleton?.bones.find((entry) => entry.name === name);
    if (!bone || !skeleton) continue;
    return { bone, mesh };
  }
  // Rigid animated model parts form hierarchy rigs without a skin.
  const node = root.getChildTransformNodes(false).find((child) =>
    child.name === name && child.name !== "__root__" &&
    child.name !== "materialPreviewMesh" && !child.name.endsWith("_overlay") &&
    !child.getClassName().includes("Camera") && !child.getClassName().includes("Light"),
  );
  return node ? { node } : undefined;
}

function updateAttachedSlot(binding: BoneAttachmentBinding, slotId: number, frame: number): void {
  const attachment = binding.boneAttachments.get(slotId);
  if (!attachment || attachment.frame === frame) return;
  attachment.frame = frame;
  attachment.applied = false;
  updateAttachedSlot(binding, attachment.targetSlotId, frame);
  const child = binding.meshes.get(slotId);
  const target = binding.meshes.get(attachment.targetSlotId);
  if (!child || !target || child.isDisposed() || target.isDisposed()) return;
  let source = attachment.resolved;
  if (attachment.root !== target || !source ||
    ("node" in source ? source.node.isDisposed() : source.mesh.isDisposed() || source.mesh.skeleton !== source.bone.getSkeleton())) {
    attachment.root = target;
    source = attachment.resolved = resolveBone(target, attachment.boneName);
  }
  if (!source) return;
  if ("node" in source) {
    attachment.boneWorld.copyFrom(source.node.computeWorldMatrix(true));
  } else {
    const linked = source.bone.getTransformNode();
    if (linked && !linked.isDisposed()) {
      attachment.boneWorld.copyFrom(linked.computeWorldMatrix(true));
    } else {
      const skeleton = source.bone.getSkeleton();
      skeleton.prepare(true);
      for (const top of skeleton.bones) if (!top.getParent()) top.computeAbsoluteMatrices();
      source.bone.getAbsoluteMatrix().multiplyToRef(source.mesh.computeWorldMatrix(true), attachment.boneWorld);
    }
  }
  // Snapshot TRS is already parent-composed. Undo the runtime's TRS composition
  // before applying the bone, including nonuniform scale without introducing shear.
  if (!target.scaling.x || !target.scaling.y || !target.scaling.z) return;
  target.rotationQuaternion!.conjugateToRef(attachment.inverseRotation);
  child.position.subtractToRef(target.position, attachment.position);
  attachment.position.applyRotationQuaternionInPlace(attachment.inverseRotation);
  attachment.position.divideInPlace(target.scaling);
  child.scaling.divideToRef(target.scaling, attachment.scale);
  attachment.inverseRotation.multiplyToRef(child.rotationQuaternion!, attachment.rotation);
  Matrix.ComposeToRef(attachment.scale, attachment.rotation, attachment.position, attachment.local);
  attachment.local.multiplyToRef(attachment.boneWorld, attachment.world);
  // Avoid Babylon parenting: disposing a character must not dispose another actor.
  // Each attachment owns its frozen matrix; snapshot TRS stays unchanged.
  child.freezeWorldMatrix(attachment.world);
  attachment.applied = true;
}

let attachmentFrame = 0;
/** Run after all snapshot TRS writes, so slot ordering cannot lag moving parents. */
export function updateBoneAttachments(binding: BoneAttachmentBinding): void {
  const frame = ++attachmentFrame;
  for (const slotId of binding.boneAttachments.keys()) updateAttachedSlot(binding, slotId, frame);
}
