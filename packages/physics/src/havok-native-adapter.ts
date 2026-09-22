import type { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import type { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import type { PhysicsShape } from "@babylonjs/core/Physics/v2/physicsShape";
import { PhysicsPrestepType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import type {
  HavokPhysicsWithBindings,
  HP_BodyId,
  HP_WorldId,
  Result,
} from "@babylonjs/havok";

// Pinned Babylon 9.20.0/Havok 1.3.14 worker adapter. The binding has no query
// broadphase refresh operation. SetQTransform changes pose but leaves an existing
// world's query index stale until a step. Reinsert the same native body, as the
// plugin's own region migration does; never remove its Babylon lookup/callbacks.
// A failed add stays recorded so the caller's pose rollback can restore membership.
const detachedBodies = new WeakSet<PhysicsBody>();
type NativeBodyData = {
  hpBodyId: HP_BodyId;
  worldRegion: { world: HP_WorldId };
  worldTransformOffset?: number;
};

function checked(
  havok: HavokPhysicsWithBindings,
  result: Result,
  operation: string,
): void {
  if (result !== havok.Result.RESULT_OK)
    throw new Error(`Havok ${operation} failed`);
}

function removeWorldMembership(plugin: HavokPlugin, body: PhysicsBody): void {
  const havok = plugin._hknp as HavokPhysicsWithBindings;
  const data = body._pluginData as NativeBodyData;
  if (!detachedBodies.has(body)) {
    checked(
      havok,
      havok.HP_World_RemoveBody(data.worldRegion.world, data.hpBodyId),
      "query membership removal",
    );
    detachedBodies.add(body);
  }
}

function restoreWorldMembership(plugin: HavokPlugin, body: PhysicsBody): void {
  const havok = plugin._hknp as HavokPhysicsWithBindings;
  const data = body._pluginData as NativeBodyData;
  checked(
    havok,
    havok.HP_World_AddBody(data.worldRegion.world, data.hpBodyId, false),
    "query membership insertion",
  );
  detachedBodies.delete(body);
  const [result, offset] = havok.HP_Body_GetWorldTransformOffset(data.hpBodyId);
  checked(havok, result, "body transform offset");
  data.worldTransformOffset = offset;
}

/** Babylon 9.20.0's body setter skips native detachment for null. Keep JS/native state aligned. */
export function attachHavokShape(
  plugin: HavokPlugin,
  body: PhysicsBody,
  shape: PhysicsShape | null,
): void {
  // Retire native contact pairs while their original shape is still attached.
  // Havok 1.3.14 can hang on the next native step when an overlapping compound
  // is replaced in-world and its old container is released. The body handle,
  // Babylon lookup and callbacks remain owned throughout this topology change.
  removeWorldMembership(plugin, body);
  if (shape) body.shape = shape;
  else {
    plugin.setShape(body, null);
    body.shape = null;
  }
  restoreWorldMembership(plugin, body);
}

/** Worker NullEngine teleports must not depend on a later render/prestep callback. */
export function teleportHavokBody(
  plugin: HavokPlugin,
  body: PhysicsBody,
): void {
  const previous = body.getPrestepType();
  body.transformNode.computeWorldMatrix(true);
  try {
    body.setPrestepType(PhysicsPrestepType.TELEPORT);
    plugin.setPhysicsBodyTransformation(body, body.transformNode);
    removeWorldMembership(plugin, body);
    restoreWorldMembership(plugin, body);
  } finally {
    body.setPrestepType(previous);
  }
}
