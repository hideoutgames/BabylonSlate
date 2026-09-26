import { Matrix, Quaternion, Vector3, type AbstractMesh, type Bone, type Mesh, type TransformNode } from "@babylonjs/core";
import type { CommandMessage, ControlMessage } from "@babylonslate/bridge";
import type { RagdollBonePose } from "@babylonslate/core";
import type { SnapshotSceneBinding } from "./snapshot-apply";
import { MODEL_IMPORT_SCALE_NODE_NAME } from "./glb-anim";

type Capture = Extract<CommandMessage, { type: "captureRagdollPose" }>;
export type RagdollCaptureResult = Extract<ControlMessage, { type: "ragdollPoseCaptured" }>;
type Target = { name: string; parentName: string | null; node?: TransformNode; bone?: Bone; mesh?: AbstractMesh };
type CapturedTarget = Target & { scale: Vector3; original: Matrix };
type Session = {
  request: Capture;
  root?: Mesh;
  targets?: CapturedTarget[];
  pose?: readonly RagdollBonePose[];
  failed?: boolean;
  observedLoad?: Promise<void>;
  loadReady?: boolean;
};

function targetsFor(root: Mesh, names: readonly string[]): Target[] {
  const skins = new Map<NonNullable<AbstractMesh["skeleton"]>, AbstractMesh>();
  for (const mesh of [root, ...root.getChildMeshes(false)]) {
    if (mesh.skeleton && !skins.has(mesh.skeleton)) skins.set(mesh.skeleton, mesh);
  }
  if (skins.size > 1) throw new Error("Ragdoll requires a model with one skeleton.");
  let targets: Target[];
  const skin = [...skins][0];
  if (skin) {
    const [skeleton, mesh] = skin;
    skeleton.prepare(true);
    for (const bone of skeleton.bones) if (!bone.getParent()) bone.computeAbsoluteMatrices();
    targets = skeleton.bones.map((bone) => ({
      name: bone.name, parentName: bone.getParent()?.name ?? null,
      node: bone.getTransformNode() ?? undefined, bone, mesh,
    }));
  } else {
    const nodes = root.getChildTransformNodes(false).filter((node) =>
      node.name !== "__root__" && node.name !== MODEL_IMPORT_SCALE_NODE_NAME && !node.name.endsWith("_overlay") &&
      !node.getClassName().includes("Camera") && !node.getClassName().includes("Light"));
    const members = new Set(nodes);
    targets = nodes.map((node) => ({ name: node.name, parentName: members.has(node.parent as TransformNode) ? node.parent!.name : null, node }));
  }
  if (!targets.length) throw new Error("Ragdoll requires a skinned or hierarchy Model with bones.");
  if (new Set(targets.map((target) => target.name)).size !== targets.length) throw new Error("Ragdoll bone names must be unique.");
  const all = new Map(targets.map((target) => [target.name, target]));
  if (names.length) {
    for (const name of names) if (!all.has(name)) throw new Error(`Ragdoll bone '${name}' was not found.`);
    const chosen = new Set(names);
    targets = targets.filter((target) => chosen.has(target.name));
    for (const target of targets) {
      let parent = target.parentName;
      let skippedParent = false;
      while (parent && !chosen.has(parent)) {
        skippedParent = true;
        parent = all.get(parent)?.parentName ?? null;
      }
      if (parent && skippedParent) throw new Error("Selected ragdoll bones must form one connected subtree without skipped parents.");
      target.parentName = parent;
    }
  }
  if (targets.filter((target) => target.parentName === null).length !== 1)
    throw new Error("Ragdoll bones must form one connected hierarchy with a single root.");
  if (targets.length > 128) throw new Error("Select at most 128 Ragdoll Bone Names.");
  // Imported bone arrays need not be ordered parent-first.
  const selected = new Map(targets.map((target) => [target.name, target]));
  const ordered: Target[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (target: Target) => {
    if (visited.has(target.name)) return;
    if (visiting.has(target.name)) throw new Error("Ragdoll bone hierarchy contains a cycle.");
    visiting.add(target.name);
    const parent = target.parentName ? selected.get(target.parentName) : undefined;
    if (parent) visit(parent);
    visiting.delete(target.name);
    visited.add(target.name);
    ordered.push(target);
  };
  for (const target of targets) visit(target);
  return ordered;
}

function worldMatrix(target: Target): Matrix {
  if (target.node) return target.node.computeWorldMatrix(true);
  target.bone!.computeAbsoluteMatrices();
  return target.bone!.getAbsoluteMatrix().multiply(target.mesh!.computeWorldMatrix(true));
}

function localMatrix(target: Target): Matrix {
  if (!target.node) return target.bone!.getLocalMatrix().clone();
  const node = target.node;
  return Matrix.Compose(node.scaling, node.rotationQuaternion ?? Quaternion.FromEulerVector(node.rotation), node.position);
}

function writeLocal(target: Target, local: Matrix): void {
  const scale = new Vector3();
  const rotation = new Quaternion();
  const position = new Vector3();
  if (!local.decompose(scale, rotation, position)) throw new Error(`Cannot apply ragdoll bone '${target.name}'.`);
  if (target.node) {
    target.node.unfreezeWorldMatrix();
    target.node.position.copyFrom(position);
    target.node.scaling.copyFrom(scale);
    target.node.rotationQuaternion = rotation;
    target.node.computeWorldMatrix(true);
  } else {
    target.bone!.setPosition(position);
    target.bone!.setRotationQuaternion(rotation);
    target.bone!.setScale(scale);
    target.bone!.computeAbsoluteMatrices();
  }
}

/** Pose capture and presentation only. All bodies and simulation remain in the worker. */
export class RagdollPoseController {
  private readonly sessions = new Map<number, Session>();

  constructor(
    private readonly binding: SnapshotSceneBinding,
    private readonly reply: (result: RagdollCaptureResult) => void,
    private readonly invalidate: () => void = () => {},
  ) {}

  isDriven(slotId: number): boolean { return !!this.sessions.get(slotId)?.targets; }

  capture(request: Capture): void {
    this.retire(request.slotId);
    this.sessions.set(request.slotId, { request });
  }

  setPose(command: Extract<CommandMessage, { type: "setRagdollPose" }>): void {
    const session = this.sessions.get(command.slotId);
    if (session?.request.requestId !== command.requestId || !session.targets || session.failed) return;
    const names = new Set(session.targets.map((target) => target.name));
    if (command.bones.length !== names.size || new Set(command.bones.map((bone) => bone.name)).size !== names.size ||
      command.bones.some((bone) => !names.has(bone.name) ||
        ![bone.position.x, bone.position.y, bone.position.z, bone.rotation.x, bone.rotation.y, bone.rotation.z, bone.rotation.w].every(Number.isFinite) ||
        Math.hypot(bone.rotation.x, bone.rotation.y, bone.rotation.z, bone.rotation.w) < 1e-6)) {
      this.fail(session, "Received an invalid ragdoll bone pose.");
      return;
    }
    session.pose = command.bones;
  }

  clear(command: Extract<CommandMessage, { type: "clearRagdollPose" }>): void {
    if (this.sessions.get(command.slotId)?.request.requestId === command.requestId) this.retire(command.slotId);
  }

  retire(slotId: number): void {
    const session = this.sessions.get(slotId);
    if (!session) return;
    this.sessions.delete(slotId);
    if (session.root && !session.root.isDisposed() && this.binding.meshes.get(slotId) === session.root) {
      for (const target of session.targets ?? []) {
        if (!target.node?.isDisposed() && !target.mesh?.isDisposed()) writeLocal(target, target.original);
      }
    }
  }

  dispose(): void { for (const slotId of this.sessions.keys()) this.retire(slotId); }

  private fail(session: Session, error: string): void {
    if (session.failed) return;
    session.failed = true;
    this.reply({ type: "ragdollPoseCaptured", slotId: session.request.slotId, requestId: session.request.requestId, error });
  }

  /** Called after Babylon's animation pass, before attachments and skeleton preparation. */
  update(): void {
    for (const session of this.sessions.values()) {
      if (session.failed) continue;
      const { slotId } = session.request;
      const root = this.binding.meshes.get(slotId);
      const load = this.binding.slotAnimLoads?.get(slotId);
      if (session.targets && load && load !== session.observedLoad) {
        this.fail(session, "Ragdoll model changed during simulation. Enable the ragdoll again after the new model loads.");
        continue;
      }
      if (load && load !== session.observedLoad) {
        session.observedLoad = load;
        session.loadReady = false;
        // This map retains settled promises for scene readiness/error reporting.
        // Observe each generation once rather than mistaking membership for work.
        void load.then(() => {
          if (this.sessions.get(slotId) === session && session.observedLoad === load) {
            session.loadReady = true;
            this.invalidate();
          }
        }, (error: unknown) => {
          if (this.sessions.get(slotId) !== session || session.observedLoad !== load || this.binding.slotAnimLoads?.get(slotId) !== load) return;
          this.fail(session, `Ragdoll model failed to load: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      if (load && !session.loadReady) continue;
      if (!root || root.isDisposed()) {
        this.fail(session, "Ragdoll requires a loaded Model with bones.");
        continue;
      }
      if (session.root && session.root !== root) {
        this.fail(session, "Ragdoll model changed during simulation. Enable the ragdoll again after the new model loads.");
        continue;
      }
      if (session.targets?.some((target) => target.node?.isDisposed() || target.mesh?.isDisposed() ||
        (target.bone && target.mesh?.skeleton !== target.bone.getSkeleton()))) {
        this.fail(session, "Ragdoll model bones were replaced during simulation. Enable the ragdoll again after the new model loads.");
        continue;
      }
      try {
        if (!session.targets) {
          const bones: RagdollBonePose[] = [];
          const targets = targetsFor(root, session.request.boneNames).map((target): CapturedTarget => {
            const scale = new Vector3();
            const rotation = new Quaternion();
            const position = new Vector3();
            const matrix = worldMatrix(target);
            if (!Array.from(matrix.m).every(Number.isFinite) || !matrix.decompose(scale, rotation, position) || Math.abs(scale.x) < 1e-8 ||
              Math.abs(Math.abs(scale.x) - Math.abs(scale.y)) > 1e-4 * Math.abs(scale.x) ||
              Math.abs(Math.abs(scale.x) - Math.abs(scale.z)) > 1e-4 * Math.abs(scale.x)) {
              throw new Error(`Ragdoll bone '${target.name}' requires nonzero uniform world scale.`);
            }
            const reconstructed = Matrix.Compose(scale, rotation, position);
            if (Array.from(matrix.m).some((value, index) => Math.abs(value - reconstructed.m[index]!) > 1e-4 * Math.max(1, Math.abs(value)))) {
              throw new Error(`Ragdoll bone '${target.name}' has unsupported world shear.`);
            }
            bones.push({ name: target.name, parentName: target.parentName,
              position: { x: position.x, y: position.y, z: position.z },
              rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w } });
            return { ...target, scale, original: localMatrix(target) };
          });
          session.root = root;
          session.targets = targets;
          session.pose = bones;
          // The preceding animation pass consumed queued weighted seeks. Preserve
          // the evaluated pose of unselected bones instead of resetting to rest.
          for (const group of this.binding.slotAnimationGroups?.get(slotId) ?? []) {
            group.pause();
          }
          this.reply({ type: "ragdollPoseCaptured", slotId, requestId: session.request.requestId, bones });
        }
        // An in-process reply may synchronously disable or destroy this actor.
        if (this.sessions.get(slotId) !== session) continue;
        if (!session.pose || !session.targets) continue;
        const poses = new Map(session.pose.map((bone) => [bone.name, bone]));
        for (const target of session.targets) {
          const pose = poses.get(target.name)!;
          const rotation = new Quaternion(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w).normalize();
          const world = Matrix.Compose(target.scale, rotation, new Vector3(pose.position.x, pose.position.y, pose.position.z));
          let parent: Matrix;
          if (target.node) parent = target.node.parent?.computeWorldMatrix(true) ?? Matrix.Identity();
          else {
            const parentBone = target.bone!.getParent();
            parent = parentBone ? parentBone.getAbsoluteMatrix().multiply(target.mesh!.computeWorldMatrix(true)) : target.mesh!.computeWorldMatrix(true);
          }
          writeLocal(target, world.multiply(Matrix.Invert(parent)));
        }
      } catch (error) { this.fail(session, error instanceof Error ? error.message : String(error)); }
    }
  }
}
