import { Physics6DoFConstraint, type Physics6DoFLimit } from "@babylonjs/core/Physics/v2/physicsConstraint";
import { PhysicsConstraintAxis } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import type { Scene } from "@babylonjs/core/scene";
import type { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import type { HavokPhysicsWithBindings, HP_BodyId } from "@babylonjs/havok";
import { rotateQuatVec } from "./collider-bake";
import type { ConstraintDesc, Vec3 } from "./types";

const toVector = (v: Vec3) => new Vector3(v.x, v.y, v.z);
const locked = (axis: PhysicsConstraintAxis): Physics6DoFLimit => ({ axis, minLimit: 0, maxLimit: 0 });

export function makeHavokConstraint(desc: ConstraintDesc, scene: Scene): Physics6DoFConstraint {
  const linear = [PhysicsConstraintAxis.LINEAR_X, PhysicsConstraintAxis.LINEAR_Y, PhysicsConstraintAxis.LINEAR_Z];
  const angular = [PhysicsConstraintAxis.ANGULAR_X, PhysicsConstraintAxis.ANGULAR_Y, PhysicsConstraintAxis.ANGULAR_Z];
  let axisA = { x: 1, y: 0, z: 0 };
  let axisB = { ...axisA };
  let perpendicularA = { x: 0, y: 1, z: 0 };
  let perpendicularB = { ...perpendicularA };
  let limits: Physics6DoFLimit[];
  switch (desc.kind) {
    case "fixed":
      axisA = rotateQuatVec(desc.frameA!, axisA);
      axisB = rotateQuatVec(desc.frameB!, axisB);
      perpendicularA = rotateQuatVec(desc.frameA!, perpendicularA);
      perpendicularB = rotateQuatVec(desc.frameB!, perpendicularB);
      limits = [...linear, ...angular].map(locked);
      break;
    case "ballSocket":
      axisA = rotateQuatVec(desc.frameA!, axisA);
      axisB = rotateQuatVec(desc.frameB!, axisB);
      perpendicularA = rotateQuatVec(desc.frameA!, perpendicularA);
      perpendicularB = rotateQuatVec(desc.frameB!, perpendicularB);
      limits = linear.map(locked);
      if (desc.angularLimits) {
        const keys = ["x", "y", "z"] as const;
        for (let i = 0; i < angular.length; i++) limits.push({ axis: angular[i]!,
          minLimit: desc.angularLimits.min[keys[i]!], maxLimit: desc.angularLimits.max[keys[i]!] });
      }
      break;
    case "distance":
      limits = [{ axis: PhysicsConstraintAxis.LINEAR_DISTANCE, minLimit: desc.distance, maxLimit: desc.distance }];
      break;
    case "hinge":
      axisA = desc.axisA;
      axisB = desc.axisB;
      perpendicularA = desc.referenceAxisA!;
      perpendicularB = desc.referenceAxisB!;
      limits = [...linear, PhysicsConstraintAxis.ANGULAR_Y, PhysicsConstraintAxis.ANGULAR_Z].map(locked);
      if (desc.limits) limits.push({ axis: PhysicsConstraintAxis.ANGULAR_X, minLimit: desc.limits.min, maxLimit: desc.limits.max });
      break;
  }
  return new Physics6DoFConstraint({
    pivotA: toVector(desc.anchorA), pivotB: toVector(desc.anchorB),
    axisA: toVector(axisA), axisB: toVector(axisB),
    perpAxisA: toVector(perpendicularA), perpAxisB: toVector(perpendicularB),
    collision: desc.collideConnected,
  }, limits, scene);
}

/** Babylon 9.20 releases native joints but leaves its reverse pair index behind. */
export function disposeHavokConstraint(plugin: HavokPlugin, constraint: Physics6DoFConstraint): void {
  const handles = constraint._pluginData as Array<[bigint]> | undefined;
  if (!handles) return;
  const validHandles = handles.filter((handle) => Array.isArray(handle) && typeof handle[0] === "bigint" && handle[0] !== 0n);
  const ids = validHandles.map(([id]) => id);
  // A failed native allocation may publish a null handle; never release it.
  constraint._pluginData = validHandles;
  constraint.dispose();
  const pairs = (plugin as unknown as { _constraintToBodyIdPair: Map<bigint, unknown> })._constraintToBodyIdPair;
  for (const id of ids) pairs.delete(id);
}

/** Babylon ignores native setup result codes; validate the published joint before replacing an owner. */
export function assertHavokConstraintAttached(plugin: HavokPlugin, constraint: Physics6DoFConstraint, a: PhysicsBody, b: PhysicsBody): void {
  const handles = constraint._pluginData as Array<[bigint]> | undefined;
  if (handles?.length !== 1 || !handles[0]?.[0]) throw new Error("Havok failed to create the constraint");
  const havok = plugin._hknp as HavokPhysicsWithBindings;
  const parent = havok.HP_Constraint_GetParentBody(handles[0]);
  const child = havok.HP_Constraint_GetChildBody(handles[0]);
  const enabled = havok.HP_Constraint_GetEnabled(handles[0]);
  const bodyA = (a._pluginData as { hpBodyId: HP_BodyId }).hpBodyId;
  const bodyB = (b._pluginData as { hpBodyId: HP_BodyId }).hpBodyId;
  if (parent[0] !== havok.Result.RESULT_OK || child[0] !== havok.Result.RESULT_OK || enabled[0] !== havok.Result.RESULT_OK ||
    parent[1][0] !== bodyA[0] || child[1][0] !== bodyB[0] || !enabled[1])
    throw new Error("Havok failed to attach the constraint");
}
