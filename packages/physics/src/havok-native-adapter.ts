import type { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import type { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import type { PhysicsShape } from "@babylonjs/core/Physics/v2/physicsShape";
import type { PhysicsCharacterController } from "@babylonjs/core/Physics/v2/characterController";
import { PhysicsPrestepType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import type {
  HavokPhysicsWithBindings,
  HP_BodyId,
  HP_WorldId,
  Result,
} from "@babylonjs/havok";

// Pinned Babylon 9.29.0/Havok 1.3.14 worker adapter. The binding has no query
// broadphase refresh operation. SetQTransform changes pose but leaves an existing
// world's query index stale until a step. Reinsert the same native body, as the
// plugin's own region migration does; never remove its Babylon lookup/callbacks.
// A failed add stays recorded so the caller's pose rollback can restore membership.
const detachedBodies = new WeakSet<PhysicsBody>();
type NativeBodyData = {
  hpBodyId: HP_BodyId;
  worldRegion: { world: HP_WorldId; floatingOrigin: { _x: number; _y: number; _z: number } };
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

/** Babylon 9.29.0's body setter skips native detachment for null. Keep JS/native state aligned. */
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

/**
 * Babylon 9.29's controller creates a second body, although its solver uses
 * independent shape queries. Keep that body's lifetime native, but leave its
 * shape detached: the actor body owns physical contacts and query identity.
 */
export function detachHavokCharacterBodyShape(
  plugin: HavokPlugin,
  controller: PhysicsCharacterController,
): void {
  const body = (controller as unknown as { _body: PhysicsBody })._body;
  attachHavokShape(plugin, body, null);
}

/** Preserve native contacts; the imminent physics step refreshes query broadphase. */
export function setHavokBodyPoseBeforeStep(
  plugin: HavokPlugin,
  body: PhysicsBody,
): void {
  const previous = body.getPrestepType();
  body.transformNode.computeWorldMatrix(true);
  try {
    body.setPrestepType(PhysicsPrestepType.TELEPORT);
    plugin.setPhysicsBodyTransformation(body, body.transformNode);
  } finally {
    body.setPrestepType(previous);
  }
}

/** Worker NullEngine teleports also refresh queries before the next physics step. */
export function teleportHavokBody(
  plugin: HavokPlugin,
  body: PhysicsBody,
): void {
  setHavokBodyPoseBeforeStep(plugin, body);
  removeWorldMembership(plugin, body);
  restoreWorldMembership(plugin, body);
}

/**
 * Read each stepped body's pose from its world's body buffer.
 *
 * After a step, Babylon 9.29.0 copies every body's pose to its node through `HP_Body_GetQTransform`: one binding call
 * and three arrays per body. Havok 1.3.14 also keeps each body's world transform, as a 4 × 4 float matrix laid out
 * like a Babylon one, in one buffer per world (`HP_World_GetBodyBuffer`, `HP_Body_GetWorldTransformOffset`), which
 * the plugin already reads for thin instances. This replaces the plugin's `sync` during `executeStep` with a read of
 * that buffer: no call per body and nothing allocated. The position is the one `HP_Body_GetQTransform` returns, bit
 * for bit. The rotation is rebuilt from the matrix, so it can differ from Havok's stored quaternion in its last float
 * bits and comes out with a positive `w`: the same orientation, possibly the opposite sign.
 *
 * A body's offset holds while the body stays in its world (the plugin's own assumption for instances), and is read
 * again wherever this module, or the plugin, puts the body back. The buffer's address is read once per step, after
 * the worlds have stepped: nothing joins a world between then and the last copy. Babylon's own copy still serves an
 * instanced body, a node with a parent or without a quaternion, a body this module has taken out of its world, and
 * any call outside a step.
 */
export function installHavokBodyBufferSync(plugin: HavokPlugin): void {
  const havok = plugin._hknp as HavokPhysicsWithBindings & { HEAPU8: Uint8Array };
  const copyThroughBinding = plugin.sync.bind(plugin);
  const executeStep = plugin.executeStep.bind(plugin);
  let stepping = false;
  let region: NativeBodyData["worldRegion"] | null = null;
  let address = 0;
  let heap: Float32Array | null = null;
  plugin.executeStep = (delta, bodies) => {
    stepping = true;
    region = null;
    try {
      executeStep(delta, bodies);
    } finally {
      stepping = false;
      region = null;
    }
  };
  plugin.sync = (body) => {
    const data = body._pluginData as NativeBodyData | undefined;
    const node = body.transformNode;
    const rotation = node.rotationQuaternion;
    if (!stepping || !data || body._pluginDataInstances.length > 0 || node.parent || !rotation || detachedBodies.has(body)) {
      copyThroughBinding(body);
      return;
    }
    if (data.worldRegion !== region) {
      const [result, buffer] = havok.HP_World_GetBodyBuffer(data.worldRegion.world);
      if (result !== havok.Result.RESULT_OK) {
        copyThroughBinding(body);
        return;
      }
      region = data.worldRegion;
      address = buffer;
    }
    let offset = data.worldTransformOffset;
    if (offset === undefined) {
      const [result, value] = havok.HP_Body_GetWorldTransformOffset(data.hpBodyId);
      if (result !== havok.Result.RESULT_OK) {
        copyThroughBinding(body);
        return;
      }
      offset = data.worldTransformOffset = value;
    }
    const start = address + offset;
    // A float view needs a multiple of four; Havok aligns its transforms far beyond that.
    if (start % 4 !== 0) {
      copyThroughBinding(body);
      return;
    }
    // The module's memory is replaced when it grows.
    if (heap?.buffer !== havok.HEAPU8.buffer) heap = new Float32Array(havok.HEAPU8.buffer);
    const m = start >> 2;
    const origin = data.worldRegion.floatingOrigin;
    node.position.set(heap[m + 12]! + origin._x, heap[m + 13]! + origin._y, heap[m + 14]! + origin._z);
    setRotationFromMatrix(rotation, heap, m);
  };
}

/**
 * `Quaternion.FromRotationMatrixToRef` over the rotation rows of a Babylon-layout matrix at `m`, then normalized: the
 * matrix is in floats, so the quaternion read from it is a unit one only to float precision.
 */
function setRotationFromMatrix(out: { set(x: number, y: number, z: number, w: number): unknown }, data: Float32Array, m: number): void {
  const m11 = data[m]!, m12 = data[m + 4]!, m13 = data[m + 8]!;
  const m21 = data[m + 1]!, m22 = data[m + 5]!, m23 = data[m + 9]!;
  const m31 = data[m + 2]!, m32 = data[m + 6]!, m33 = data[m + 10]!;
  const trace = m11 + m22 + m33;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m32 - m23) * s;
    y = (m13 - m31) * s;
    z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / s;
    x = 0.25 * s;
    y = (m12 + m21) / s;
    z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / s;
    x = (m12 + m21) / s;
    y = 0.25 * s;
    z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / s;
    x = (m13 + m31) / s;
    y = (m23 + m32) / s;
    z = 0.25 * s;
  }
  const length = Math.hypot(x, y, z, w) || 1;
  out.set(x / length, y / length, z / length, w / length);
}
