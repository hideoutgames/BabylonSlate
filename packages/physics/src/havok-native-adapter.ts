import type { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import type { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import type { PhysicsShape } from "@babylonjs/core/Physics/v2/physicsShape";
import { PhysicsPrestepType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";

/** Babylon 9.20.0's body setter skips native detachment for null. Keep JS/native state aligned. */
export function attachHavokShape(plugin: HavokPlugin, body: PhysicsBody, shape: PhysicsShape | null): void {
  if (shape) body.shape = shape;
  else { plugin.setShape(body, null); body.shape = null; }
}

/** Worker NullEngine teleports must not depend on a later render/prestep callback. */
export function teleportHavokBody(plugin: HavokPlugin, body: PhysicsBody): void {
  const previous = body.getPrestepType();
  body.transformNode.computeWorldMatrix(true);
  try {
    body.setPrestepType(PhysicsPrestepType.TELEPORT);
    plugin.setPhysicsBodyTransformation(body, body.transformNode);
  } finally { body.setPrestepType(previous); }
}
