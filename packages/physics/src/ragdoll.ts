import { parseRagdollProperties, type RagdollBonePose, type RagdollProperties } from "@babylonslate/core";
import type { PhysicsBackend } from "./backend";
import { multiplyQuat, rotateQuatVec } from "./collider-bake";
import { normalizedPhysicsPose } from "./collider-validation";
import type { BodyVelocity, ColliderDesc, ConstraintDesc, PhysicsTransform, Quat, RigidBodyDesc, Vec3 } from "./types";

const zero = (): Vec3 => ({ x: 0, y: 0, z: 0 });
const identity = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });
const inverse = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
const subtract = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

function selectBones(input: readonly RagdollBonePose[], names: readonly string[]): RagdollBonePose[] {
  if (input.length < 1 || input.length > 128) throw new Error("Ragdolls require between 1 and 128 bones");
  const bones = input.map((bone) => {
    if (!bone.name?.trim()) throw new Error("Ragdoll bones need nonempty names");
    const pose = normalizedPhysicsPose(bone);
    return { name: bone.name, parentName: bone.parentName, ...pose };
  });
  const byName = new Map(bones.map((bone) => [bone.name, bone]));
  if (byName.size !== bones.length) throw new Error("Ragdoll bone names must be unique");
  if (bones.filter((bone) => bone.parentName === null).length !== 1)
    throw new Error("Ragdoll skeletons need one root");
  for (const bone of bones) {
    const visited = new Set<string>();
    let current: RagdollBonePose | undefined = bone;
    while (current) {
      if (visited.has(current.name)) throw new Error("Ragdoll skeletons cannot contain cycles");
      visited.add(current.name);
      if (current.parentName === null) break;
      const parent: RagdollBonePose | undefined = byName.get(current.parentName);
      if (!parent) throw new Error(`Missing ragdoll parent: ${current.parentName}`);
      current = parent;
    }
  }
  if (!names.length) return bones;
  const selected = new Set(names);
  if (names.some((name) => !byName.has(name))) throw new Error("A selected ragdoll bone is missing from the skeleton");
  const result = bones.filter((bone) => selected.has(bone.name));
  if (result.filter((bone) => bone.parentName === null || !selected.has(bone.parentName)).length !== 1)
    throw new Error("Selected ragdoll bones must form one connected subtree");
  return result;
}

/** Rotation from capsule-local Y to the chosen bone direction. */
function capsuleRotation(offset: Vec3, length: number): Quat {
  const x = offset.x / length;
  const y = offset.y / length;
  const z = offset.z / length;
  if (y < -0.999999) return { x: 1, y: 0, z: 0, w: 0 };
  return normalizedPhysicsPose({ position: zero(), rotation: { x: z, y: 0, z: -x, w: 1 + y } }).rotation;
}

/** Owns a connected articulated body assembly in an existing native 3D world. */
export class RagdollPhysics {
  readonly rootBoneName: string;
  private readonly backend: PhysicsBackend;
  private readonly records: Array<{ bone: RagdollBonePose; bodyId: string }> = [];
  private readonly jointIds: string[] = [];
  private disposed = false;

  constructor(
    backend: PhysicsBackend,
    actorId: string,
    id: string,
    input: readonly RagdollBonePose[],
    properties: RagdollProperties,
    initialVelocity?: BodyVelocity,
  ) {
    this.backend = backend;
    if (backend.kind !== "3d" || !backend.supportsConstraints)
      throw new Error("Ragdolls require native 3D physics");
    if (!id || !actorId) throw new Error("Ragdolls require nonempty identities");
    if (initialVelocity && [initialVelocity.linear, initialVelocity.angular, initialVelocity.centerOfMass]
      .some((value) => !value || ![value.x, value.y, value.z].every(Number.isFinite)))
      throw new Error("Initial ragdoll velocity and mass center must be finite");
    const tuning = parseRagdollProperties({ ...properties });
    const bones = selectBones(input, tuning.boneNames);
    const selected = new Map(bones.map((bone, index) => [bone.name, { bone, bodyId: `${id}:bone:${index}` }]));
    this.rootBoneName = bones.find((bone) => bone.parentName === null || !selected.has(bone.parentName))!.name;
    const angle = tuning.angularLimit * Math.PI / 180;
    const prepared = bones.map((bone) => {
      const bodyId = selected.get(bone.name)!.bodyId;
      if (backend.getBodyTransform(bodyId)) throw new Error(`Ragdoll body identity already exists: ${bodyId}`);
      const body: RigidBodyDesc = { id: bodyId, actorId, motionType: "dynamic", mass: tuning.totalMass / bones.length,
        linearDamping: tuning.linearDamping, angularDamping: tuning.angularDamping, gravityScale: 1,
        transform: { position: bone.position, rotation: bone.rotation } };
      const child = bones.find((candidate) => candidate.parentName === bone.name &&
        Math.hypot(...Object.values(subtract(candidate.position, bone.position))) > 1e-6);
      const offset = child ? rotateQuatVec(inverse(bone.rotation), subtract(child.position, bone.position)) : zero();
      const length = Math.hypot(offset.x, offset.y, offset.z);
      const radius = length > 1e-6 ? Math.min(tuning.radius, length * 0.25) : tuning.radius;
      const collider: ColliderDesc = { id: `${bodyId}:collider`, bodyId,
        shape: length > 1e-6 ? { kind: "capsule", radius, halfHeight: length / 2 - radius } : { kind: "sphere", radius },
        translation: { x: offset.x / 2, y: offset.y / 2, z: offset.z / 2 },
        rotation: length > 1e-6 ? capsuleRotation(offset, length) : identity(),
        friction: tuning.friction, restitution: tuning.restitution, layer: tuning.layer, mask: tuning.mask, isTrigger: false };
      const parent = bone.parentName === null ? undefined : selected.get(bone.parentName);
      const joint: ConstraintDesc | undefined = parent ? {
        id: `${bodyId}:joint`, kind: "ballSocket", bodyAId: parent.bodyId, bodyBId: bodyId,
        anchorA: rotateQuatVec(inverse(parent.bone.rotation), subtract(bone.position, parent.bone.position)), anchorB: zero(),
        frameA: multiplyQuat(inverse(parent.bone.rotation), bone.rotation), frameB: identity(),
        angularLimits: { min: { x: -angle, y: -angle, z: -angle }, max: { x: angle, y: angle, z: angle } },
        collideConnected: false,
      } : undefined;
      return { bone, body, collider, joint };
    });
    try {
      for (const item of prepared) {
        backend.createBody(item.body);
        this.records.push({ bone: item.bone, bodyId: item.body.id });
        backend.createCollider(item.collider);
        if (initialVelocity) {
          const massCenter = backend.getBodyVelocity(item.body.id)?.centerOfMass;
          if (!massCenter) throw new Error("Cannot resolve the ragdoll body's mass center");
          const offset = subtract(massCenter, initialVelocity.centerOfMass);
          const angular = initialVelocity.angular;
          backend.setBodyAngularVelocity(item.body.id, angular);
          backend.setBodyLinearVelocity(item.body.id, {
            x: initialVelocity.linear.x + angular.y * offset.z - angular.z * offset.y,
            y: initialVelocity.linear.y + angular.z * offset.x - angular.x * offset.z,
            z: initialVelocity.linear.z + angular.x * offset.y - angular.y * offset.x,
          });
        }
      }
      for (const item of prepared) if (item.joint) {
        backend.createConstraint(item.joint);
        this.jointIds.push(item.joint.id);
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  readPose(): RagdollBonePose[] {
    if (this.disposed) return [];
    return this.records.map(({ bone, bodyId }) => {
      const pose: PhysicsTransform | null = this.backend.getBodyTransform(bodyId);
      if (!pose) throw new Error(`Ragdoll body was removed: ${bodyId}`);
      return { name: bone.name, parentName: bone.parentName, ...pose };
    });
  }

  /** Distribute an impulse over the total assembly, independent of bone count. */
  addImpulse(impulse: Vec3, strength = 1): void {
    if (this.disposed) return;
    if (![impulse.x, impulse.y, impulse.z, strength].every(Number.isFinite))
      throw new Error("Ragdoll impulses must be finite");
    const share = strength / this.records.length;
    const distributed = { x: impulse.x * share, y: impulse.y * share, z: impulse.z * share };
    for (const record of this.records) {
      const velocity = this.backend.getBodyVelocity(record.bodyId);
      if (!velocity) throw new Error(`Ragdoll body was removed: ${record.bodyId}`);
      this.backend.addImpulseAtPoint(record.bodyId, distributed, velocity.centerOfMass);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.jointIds) this.backend.destroyConstraint(id);
    for (const record of this.records) this.backend.destroyBody(record.bodyId);
    this.jointIds.length = 0;
    this.records.length = 0;
  }
}
