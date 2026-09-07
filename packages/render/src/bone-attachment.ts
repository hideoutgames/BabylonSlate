import { Matrix, type Mesh } from "@babylonjs/core";
import type { CommandMessage } from "@babylonslate/bridge";

export type BoneAttachmentCommand = Extract<CommandMessage, { type: "attachToBone" }>;
export interface BoneAttachment {
  targetSlotId: number;
  boneName: string;
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
  binding.boneAttachments.set(command.slotId, { targetSlotId: command.targetSlotId, boneName: command.boneName });
}

export function retireBoneAttachments(binding: BoneAttachmentBinding, slotId: number): void {
  binding.boneAttachments.delete(slotId);
  for (const [childId, attachment] of binding.boneAttachments) {
    if (attachment.targetSlotId === slotId) binding.boneAttachments.delete(childId);
  }
}

function boneWorldMatrix(root: Mesh, name: string): Matrix | null {
  // Linked glTF nodes already include the model root transform.
  for (const mesh of [root, ...root.getChildMeshes(false)]) {
    const skeleton = mesh.skeleton;
    const bone = skeleton?.bones.find((entry) => entry.name === name);
    if (!bone || !skeleton) continue;
    const linked = bone.getTransformNode();
    if (linked && !linked.isDisposed()) return linked.computeWorldMatrix(true);
    skeleton.prepare(true);
    for (const top of skeleton.bones) {
      if (!top.getParent()) top.computeAbsoluteMatrices();
    }
    return bone.getAbsoluteMatrix().multiply(mesh.computeWorldMatrix(true));
  }
  // Rigid animated model parts form hierarchy rigs without a skin.
  const node = root.getChildTransformNodes(false).find((child) =>
    child.name === name && child.name !== "__root__" &&
    child.name !== "materialPreviewMesh" && !child.name.endsWith("_overlay") &&
    !child.getClassName().includes("Camera") && !child.getClassName().includes("Light"),
  );
  return node?.computeWorldMatrix(true) ?? null;
}

/** Run after all snapshot TRS writes, so slot ordering cannot lag moving parents. */
export function updateBoneAttachments(binding: BoneAttachmentBinding): void {
  if (binding.boneAttachments.size === 0) return;
  const updated = new Set<number>();
  const apply = (slotId: number): void => {
    if (updated.has(slotId)) return;
    updated.add(slotId);
    const attachment = binding.boneAttachments.get(slotId);
    if (!attachment) return;
    apply(attachment.targetSlotId);
    const child = binding.meshes.get(slotId);
    const target = binding.meshes.get(attachment.targetSlotId);
    if (!child || !target || child.isDisposed() || target.isDisposed()) return;
    const bone = boneWorldMatrix(target, attachment.boneName);
    if (!bone) return;
    // No Babylon parenting: destroying a character must not dispose another actor.
    // Keep local TRS for snapshot offsets; only the composed world matrix changes.
    const local = Matrix.Compose(child.scaling, child.rotationQuaternion!, child.position);
    child.freezeWorldMatrix(local.multiply(bone));
  };
  for (const slotId of binding.boneAttachments.keys()) apply(slotId);
}
