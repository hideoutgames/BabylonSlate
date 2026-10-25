import {
  Matrix,
  Mesh,
  Quaternion,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import type { CommandMessage } from "@haptic/bridge";
import { parseOverlayVisualStyle, type Transform } from "@haptic/core";
import { shouldFreezeStaticWorldMatrix } from "./scene-loader";
import { updateText2DAppear } from "./text2d-mesh";
import { uiControl2DMesh } from "./ui-controls2d-mesh";
import { updatePainter2DMesh } from "./painter2d-mesh";
import { applyOverlayVisualStyle } from "./overlay-visual-style";
import {
  attachmentParentFor,
  setSpringArmAuthoredTransform,
  springArmRigsOf,
} from "./spring-arm";
import {
  partsNeedOrigin,
  playComponentMeshName,
  type AssignMeshCommand,
  type AssignMeshPart,
  type SnapshotSceneBinding,
} from "./snapshot-binding";
import { updateComponentIllumination } from "./snapshot-illumination";
import { forgetMaterialPreparation } from "./snapshot-materials";

/** Scratch math objects — never allocate per component pose. */
const scratchPos = new Vector3();
const scratchScale = new Vector3();
const scratchQuat = new Quaternion();
const scratchComponentMatrix = new Matrix();
const scratchParentMatrix = new Matrix();

const pendingVisualReplacements = new WeakMap<SnapshotSceneBinding, Map<number, Mesh>>();
const visualAssignments = new WeakMap<SnapshotSceneBinding, Map<number, AssignMeshCommand>>();
type ComponentTransformCommand = Extract<CommandMessage, { type: "setComponentTransforms" }>;
type ComponentPose = ComponentTransformCommand["parts"][number];
// Pose samples must not change the assignment's topology: an optimized singleton
// stays a singleton when its initially identity component starts moving.
const assignmentComponentPoses = new WeakMap<AssignMeshCommand, Map<string, ComponentPose>>();
const playVisualAncestors = new WeakMap<Mesh, Map<string, TransformNode[]>>();
/** Exact component roots belong to one visual generation, including prepared successors. */
const playVisualComponents = new WeakMap<Mesh, ReadonlyMap<string, Mesh>>();

/** The latest assignMesh per slot; a rebuilt visual restores its retained component poses. */
export function recordVisualAssignment(binding: SnapshotSceneBinding, command: AssignMeshCommand): void {
  const assignments = visualAssignments.get(binding) ?? new Map<number, AssignMeshCommand>();
  visualAssignments.set(binding, assignments);
  assignments.set(command.slotId, command);
}

/** The latest assignMesh recorded for the slot. */
export function visualAssignmentOf(binding: SnapshotSceneBinding, slotId: number): AssignMeshCommand | undefined {
  return visualAssignments.get(binding)?.get(slotId);
}

export function forgetVisualAssignment(binding: SnapshotSceneBinding, slotId: number): void {
  visualAssignments.get(binding)?.delete(slotId);
}

export function forgetVisualAssignments(binding: SnapshotSceneBinding): void {
  visualAssignments.delete(binding);
}

export function hasPendingVisualReplacement(binding: SnapshotSceneBinding, slotId: number): boolean {
  return pendingVisualReplacements.get(binding)?.has(slotId) === true;
}

/** The slot's prepared successor not yet adopted, if any. */
export function pendingVisualReplacement(binding: SnapshotSceneBinding, slotId: number): Mesh | undefined {
  return pendingVisualReplacements.get(binding)?.get(slotId);
}

/** The binding's stored map (created on first use) of prepared successors not yet adopted. */
export function pendingVisualReplacementsOf(binding: SnapshotSceneBinding): Map<number, Mesh> {
  const pending = pendingVisualReplacements.get(binding) ?? new Map<number, Mesh>();
  pendingVisualReplacements.set(binding, pending);
  return pending;
}

export function disposePendingVisualReplacements(binding: SnapshotSceneBinding): void {
  const pending = pendingVisualReplacements.get(binding);
  for (const candidate of pending?.values() ?? []) candidate.dispose();
  pending?.clear();
  pendingVisualReplacements.delete(binding);
}

export function rememberPlayVisualAncestors(root: Mesh, chains: Map<string, TransformNode[]>): void {
  playVisualAncestors.set(root, chains);
}

export function rememberPlayVisualComponents(root: Mesh, components: ReadonlyMap<string, Mesh>): void {
  playVisualComponents.set(root, components);
  root.onDisposeObservable.addOnce(() => {
    playVisualComponents.delete(root);
    playVisualAncestors.delete(root);
  });
}

/** Also used before a SceneLayer has a render scene or asynchronous assets finish. */
export function retainAssignMeshComponentTransforms(assignment: AssignMeshCommand, command: ComponentTransformCommand): void {
  const poses = assignmentComponentPoses.get(assignment) ?? new Map<string, ComponentPose>();
  assignmentComponentPoses.set(assignment, poses);
  for (const pose of command.parts) {
    if (assignment.primaryComponentId === pose.componentId || assignment.parts?.some(part => part.componentId === pose.componentId)) {
      poses.set(pose.componentId, pose);
    }
  }
}

function writeComponentPose(node: TransformNode, transform: Transform): void {
  node.unfreezeWorldMatrix();
  node.position.copyFromFloats(transform.position.x, transform.position.y, transform.position.z);
  node.rotationQuaternion ??= Quaternion.Identity();
  node.rotationQuaternion.copyFromFloats(transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w);
  node.scaling.copyFromFloats(transform.scale.x, transform.scale.y, transform.scale.z);
}

function updateVisualComponentPoses(root: Mesh, poses: Iterable<ComponentPose>): void {
  const components = playVisualComponents.get(root);
  if (!components || root.isDisposed()) return;
  const chains = playVisualAncestors.get(root) ?? new Map<string, TransformNode[]>();
  playVisualAncestors.set(root, chains);
  const armRigs = springArmRigsOf(root);
  for (const pose of poses) {
    const mesh = components.get(pose.componentId);
    if (!mesh || mesh.isDisposed()) continue;
    if (mesh === root) {
      composeTransformMatrix(pose.transform, scratchComponentMatrix);
      for (const parent of pose.parentTransforms ?? []) {
        composeTransformMatrix(parent, scratchParentMatrix);
        scratchComponentMatrix.multiplyToRef(scratchParentMatrix, scratchComponentMatrix);
      }
      // Native pretransforms preserve shear under nonuniform actor scaling,
      // and leave snapshot TRS intact for bone attachment and spatial audio.
      mesh.setPreTransformMatrix(scratchComponentMatrix);
      mesh.unfreezeWorldMatrix();
      if (shouldFreezeStaticWorldMatrix(mesh)) mesh.freezeWorldMatrix();
      continue;
    }
    const rig = armRigs.find(entry => entry.arm === mesh);
    if (rig) setSpringArmAuthoredTransform(rig, pose.transform);
    writeComponentPose(mesh, pose.transform);
    const ancestors = chains.get(pose.componentId) ?? [];
    chains.set(pose.componentId, ancestors);
    const parentMesh = pose.parentId ? components.get(pose.parentId) : undefined;
    const parent = parentMesh ? attachmentParentFor(parentMesh) : root;
    let attachment: TransformNode = mesh;
    const transforms = pose.parentTransforms ?? [];
    for (let index = 0; index < transforms.length; index++) {
      const ancestor = ancestors[index] ?? new TransformNode(`${mesh.name}-attachment`, mesh.getScene());
      ancestors[index] = ancestor;
      writeComponentPose(ancestor, transforms[index]!);
      attachment.parent = ancestor;
      attachment = ancestor;
    }
    attachment.parent = parent;
    // Detach the retained chain before retiring obsolete ancestors.
    for (const obsolete of ancestors.splice(transforms.length)) obsolete.dispose(true);
    mesh.computeWorldMatrix(true);
  }
  updateComponentIllumination(root);
}

export function restoreComponentPoses(binding: SnapshotSceneBinding, slotId: number, root: Mesh): void {
  const assignment = visualAssignments.get(binding)?.get(slotId);
  const poses = assignment && assignmentComponentPoses.get(assignment);
  if (poses) updateVisualComponentPoses(root, poses.values());
}

/** Keep exact live and prepared meshes, materials, atlases and geometry in place. */
export function applyComponentTransformsCommand(binding: SnapshotSceneBinding, command: ComponentTransformCommand): void {
  const assignment = visualAssignments.get(binding)?.get(command.slotId);
  if (!assignment) return;
  retainAssignMeshComponentTransforms(assignment, command);
  const live = binding.meshes.get(command.slotId);
  const prepared = pendingVisualReplacements.get(binding)?.get(command.slotId);
  if (live) updateVisualComponentPoses(live, command.parts);
  if (prepared && prepared !== live) updateVisualComponentPoses(prepared, command.parts);
}

function updateVisualTextAppear(root: Mesh | undefined, componentId: string, progress: number): void {
  if (!root || root.isDisposed()) return;
  const mesh = playVisualComponents.get(root)?.get(componentId);
  if (mesh && !mesh.isDisposed()) updateText2DAppear(mesh, progress);
}

/** Style changes retain both live and prepared component meshes and their texture resources. */
export function applyOverlayVisualStyleCommand(binding: SnapshotSceneBinding, command: Extract<CommandMessage, { type: "setOverlayVisualStyle" }>): void {
  const styles = binding.overlayStyles.get(command.slotId);
  if (!styles?.has(command.componentId)) return;
  const style = parseOverlayVisualStyle(command.style);
  styles.set(command.componentId, style);
  const assignment = visualAssignments.get(binding)?.get(command.slotId);
  if (assignment?.primaryComponentId === command.componentId) assignment.overlayStyle = style;
  const part = binding.meshParts.get(command.slotId)?.find((entry) => entry.componentId === command.componentId);
  if (part) part.overlayStyle = style;
  const live = binding.meshes.get(command.slotId);
  const prepared = pendingVisualReplacements.get(binding)?.get(command.slotId);
  for (const root of prepared && prepared !== live ? [live, prepared] : [live]) {
    const mesh = root && playVisualComponents.get(root)?.get(command.componentId);
    if (mesh && !mesh.isDisposed()) applyOverlayVisualStyle(mesh, style);
  }
}

/** Keep live and prepared text visuals on the same simulation-owned reveal sample. */
export function applyText2DAppearCommand(binding: SnapshotSceneBinding, command: Extract<CommandMessage, { type: "setText2DAppear" }>): void {
  if (!Number.isFinite(command.progress)) return;
  const parts = binding.meshParts.get(command.slotId);
  let part: AssignMeshPart | undefined;
  if (parts) {
    for (let index = 0; index < parts.length; index++) {
      const entry = parts[index]!;
      if (entry.componentId === command.componentId && entry.meshKind === "2drichtext") {
        part = entry;
        break;
      }
    }
  }
  const primary = binding.primaryComponentIds.get(command.slotId) === command.componentId && binding.meshKinds.get(command.slotId) === "2drichtext";
  if (!part && !primary) return;
  const progress = Math.min(1, Math.max(0, command.progress));
  if (part?.text2d) part.text2d.appearProgress = progress;
  if (primary) {
    const properties = binding.text2dProps.get(command.slotId);
    if (properties) properties.appearProgress = progress;
  }
  const live = binding.meshes.get(command.slotId);
  const prepared = pendingVisualReplacements.get(binding)?.get(command.slotId);
  updateVisualTextAppear(live, command.componentId, progress);
  if (prepared !== live) updateVisualTextAppear(prepared, command.componentId, progress);
}

/** State changes keep pointer capture, compiled materials and texture leases alive. */
export function applyUIControl2DCommand(binding: SnapshotSceneBinding, command: Extract<CommandMessage, { type: "setUIControl2D" }>): void {
  const part = binding.meshParts.get(command.slotId)?.find(entry => entry.componentId === command.componentId && entry.meshKind === "2dcontrol");
  if (part) part.uiControl = command.uiControl;
  const assignment = visualAssignments.get(binding)?.get(command.slotId);
  const assignedPart = assignment?.parts?.find(entry => entry.componentId === command.componentId);
  if (assignedPart) assignedPart.uiControl = command.uiControl;
  const live = binding.meshes.get(command.slotId);
  const prepared = pendingVisualReplacements.get(binding)?.get(command.slotId);
  for (const root of prepared && prepared !== live ? [live, prepared] : [live]) {
    if (!root || root.isDisposed()) continue;
    const target = uiControl2DMesh(root) ? root : root.getChildMeshes().find(mesh => mesh.metadata?.overlayControlComponentId === command.componentId && uiControl2DMesh(mesh));
    if (target) {
      const visual = uiControl2DMesh(target);
      visual?.update(command.uiControl);
      if (command.focused !== undefined) visual?.setFocused(command.focused);
    }
  }
  binding.onVisualChanged?.(command.slotId);
}

export function applyPainter2DCommand(binding: SnapshotSceneBinding, command: Extract<CommandMessage, { type: "setPainter2D" }>): void {
  const parts = binding.meshParts.get(command.slotId);
  const part = parts?.find((entry) => entry.componentId === command.componentId && entry.meshKind === "2dpainter");
  if (!part) return;
  part.painter = command.painter;
  for (const root of [binding.meshes.get(command.slotId), pendingVisualReplacements.get(binding)?.get(command.slotId)]) {
    if (!root || root.isDisposed()) continue;
    if (!partsNeedOrigin(parts)) updatePainter2DMesh(root, command.painter);
    else {
      const name = playComponentMeshName(command.slotId, command.componentId);
      const mesh = root.getChildMeshes().find((child) => child.name === name);
      if (mesh instanceof Mesh) updatePainter2DMesh(mesh, command.painter);
    }
  }
  binding.onVisualChanged?.(command.slotId);
}

export function cancelPendingVisualReplacement(binding: SnapshotSceneBinding, slotId: number): void {
  const pending = pendingVisualReplacements.get(binding);
  pending?.get(slotId)?.dispose();
  pending?.delete(slotId);
  forgetMaterialPreparation(binding, slotId);
}

function composeTransformMatrix(transform: Transform, target: Matrix): void {
  scratchPos.copyFromFloats(transform.position.x, transform.position.y, transform.position.z);
  scratchQuat.copyFromFloats(transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w);
  scratchScale.copyFromFloats(transform.scale.x, transform.scale.y, transform.scale.z);
  Matrix.ComposeToRef(scratchScale, scratchQuat, scratchPos, target);
}
