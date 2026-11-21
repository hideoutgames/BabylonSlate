import type {
  ConstraintAxis,
  HavokPhysicsWithBindings,
  HP_BodyId,
  HP_ConstraintId,
} from "@babylonjs/havok";
import { rotateQuatVec } from "./collider-bake";
import type { ConstraintDesc } from "./types";
import {
  checked,
  checkedValue,
  perpendicularAxis,
  toHavokVec3,
} from "./havok-wasm-memory";

type AxisLimit = {
  axis: ConstraintAxis;
  minLimit?: number;
  maxLimit?: number;
};

/** Create, configure, attach, and validate a native Havok 6DoF constraint directly via `HP_Constraint_*`. */
export function createHavokConstraint(
  havok: HavokPhysicsWithBindings,
  desc: ConstraintDesc,
  bodyA: HP_BodyId,
  bodyB: HP_BodyId,
): HP_ConstraintId {
  const Axis = havok.ConstraintAxis;
  const Mode = havok.ConstraintAxisLimitMode;
  const linear = [Axis.LINEAR_X, Axis.LINEAR_Y, Axis.LINEAR_Z];
  const angular = [Axis.ANGULAR_X, Axis.ANGULAR_Y, Axis.ANGULAR_Z];
  const locked = (axis: ConstraintAxis): AxisLimit => ({ axis, minLimit: 0, maxLimit: 0 });

  let axisA = { x: 1, y: 0, z: 0 };
  let axisB = { x: 1, y: 0, z: 0 };
  let perpendicularA = { x: 0, y: 1, z: 0 };
  let perpendicularB = { x: 0, y: 1, z: 0 };
  let limits: AxisLimit[];

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
        for (let i = 0; i < angular.length; i++) {
          limits.push({
            axis: angular[i]!,
            minLimit: desc.angularLimits.min[keys[i]!],
            maxLimit: desc.angularLimits.max[keys[i]!],
          });
        }
      }
      break;
    case "distance":
      perpendicularA = perpendicularAxis(axisA);
      perpendicularB = perpendicularAxis(axisB);
      limits = [{ axis: Axis.LINEAR_DISTANCE, minLimit: desc.distance, maxLimit: desc.distance }];
      break;
    case "hinge":
      axisA = desc.axisA;
      axisB = desc.axisB;
      perpendicularA = desc.referenceAxisA!;
      perpendicularB = desc.referenceAxisB!;
      limits = [...linear, Axis.ANGULAR_Y, Axis.ANGULAR_Z].map(locked);
      if (desc.limits) {
        limits.push({
          axis: Axis.ANGULAR_X,
          minLimit: desc.limits.min,
          maxLimit: desc.limits.max,
        });
      }
      break;
  }

  const jointId = checkedValue(havok, havok.HP_Constraint_Create(), "constraint creation");
  if (!jointId || jointId[0] === 0n) {
    throw new Error("Havok failed to create the constraint");
  }
  try {
    checked(havok, havok.HP_Constraint_SetParentBody(jointId, bodyA), "constraint parent body");
    checked(havok, havok.HP_Constraint_SetChildBody(jointId, bodyB), "constraint child body");
    checked(
      havok,
      havok.HP_Constraint_SetAnchorInParent(
        jointId,
        toHavokVec3(desc.anchorA),
        toHavokVec3(axisA),
        toHavokVec3(perpendicularA),
      ),
      "constraint parent anchor",
    );
    checked(
      havok,
      havok.HP_Constraint_SetAnchorInChild(
        jointId,
        toHavokVec3(desc.anchorB),
        toHavokVec3(axisB),
        toHavokVec3(perpendicularB),
      ),
      "constraint child anchor",
    );

    for (const limit of limits) {
      if ((limit.minLimit ?? -1) === 0 && (limit.maxLimit ?? -1) === 0) {
        checked(havok, havok.HP_Constraint_SetAxisMode(jointId, limit.axis, Mode.LOCKED), "constraint axis lock");
      } else {
        if (limit.axis === Axis.LINEAR_DISTANCE) {
          // Havok 1.3.14 applies `LIMITED` to `LINEAR_DISTANCE` but returns `RESULT_INVALIDARGS`; verify the applied mode.
          havok.HP_Constraint_SetAxisMode(jointId, limit.axis, Mode.LIMITED);
          if (havok.HP_Constraint_GetAxisMode(jointId, limit.axis)[1] !== Mode.LIMITED) {
            throw new Error("Havok constraint distance limit mode failed");
          }
        } else {
          checked(havok, havok.HP_Constraint_SetAxisMode(jointId, limit.axis, Mode.LIMITED), "constraint axis limit mode");
        }
        if (limit.minLimit !== undefined) {
          checked(havok, havok.HP_Constraint_SetAxisMinLimit(jointId, limit.axis, limit.minLimit), "constraint axis min limit");
        }
        if (limit.maxLimit !== undefined) {
          checked(havok, havok.HP_Constraint_SetAxisMaxLimit(jointId, limit.axis, limit.maxLimit), "constraint axis max limit");
        }
      }
    }

    checked(
      havok,
      havok.HP_Constraint_SetCollisionsEnabled(jointId, desc.collideConnected ? 1 : 0),
      "constraint collisions flag",
    );
    checked(havok, havok.HP_Constraint_SetEnabled(jointId, 1), "constraint enable");

    const parent = havok.HP_Constraint_GetParentBody(jointId);
    const child = havok.HP_Constraint_GetChildBody(jointId);
    const enabled = havok.HP_Constraint_GetEnabled(jointId);
    if (
      parent[0] !== havok.Result.RESULT_OK ||
      child[0] !== havok.Result.RESULT_OK ||
      enabled[0] !== havok.Result.RESULT_OK ||
      parent[1][0] !== bodyA[0] ||
      child[1][0] !== bodyB[0] ||
      !enabled[1]
    ) {
      throw new Error("Havok failed to attach the constraint");
    }
    return jointId;
  } catch (error) {
    disposeHavokConstraint(havok, jointId);
    throw error;
  }
}

/** Disable and release a native Havok constraint handle. */
export function disposeHavokConstraint(
  havok: HavokPhysicsWithBindings,
  jointId: HP_ConstraintId | null | undefined,
): void {
  if (!jointId || jointId[0] === 0n) return;
  havok.HP_Constraint_SetEnabled(jointId, 0);
  havok.HP_Constraint_Release(jointId);
}
