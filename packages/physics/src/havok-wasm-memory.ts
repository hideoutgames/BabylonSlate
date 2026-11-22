import type {
  HavokPhysicsWithBindings,
  HP_BodyId,
  HP_ShapeId,
  Quaternion as HavokQuat,
  Result,
  Vector3 as HavokVec3,
} from "@babylonjs/havok";
import type { PhysicsTransform, Quat, Vec3 } from "./types";

/** Null native shape handle (detaches a body's shape in Havok 1.3.14). */
export const NULL_SHAPE_ID: HP_ShapeId = [0n];

/** Null native body handle (no ignored body in Havok queries). */
export const NULL_BODY_ID: HP_BodyId = [0n];

/** Identity quaternion tuple for Havok native calls. */
export const IDENTITY_HAVOK_QUAT: HavokQuat = [0, 0, 0, 1];

/** Zero vector tuple for Havok native calls. */
export const ZERO_HAVOK_VEC3: HavokVec3 = [0, 0, 0];

/** Assert that a Havok C-API result code is `RESULT_OK`. */
export function checked(
  havok: HavokPhysicsWithBindings,
  result: Result,
  operation: string,
): void {
  if (result !== havok.Result.RESULT_OK) {
    throw new Error(`Havok ${operation} failed`);
  }
}

/** Assert `RESULT_OK` on a tuple return `[Result, T]` and unwrap `T`. */
export function checkedValue<T>(
  havok: HavokPhysicsWithBindings,
  tuple: [Result, T],
  operation: string,
): T {
  if (tuple[0] !== havok.Result.RESULT_OK) {
    throw new Error(`Havok ${operation} failed`);
  }
  return tuple[1];
}

/** Allocate a temporary Float32 buffer on the Havok WASM heap, run `fn(ptr)`, and always free it. */
export function withFloat32Heap<T>(
  havok: HavokPhysicsWithBindings,
  values: ArrayLike<number>,
  fn: (ptr: number) => T,
): T {
  const count = values.length;
  const byteLength = Math.max(4, count * 4);
  const ptr = havok._malloc(byteLength);
  if (!ptr) throw new Error("Havok WASM float buffer allocation failed");
  try {
    const view = new Float32Array(havok.HEAPU8.buffer, ptr, count);
    view.set(values);
    return fn(ptr);
  } finally {
    havok._free(ptr);
  }
}

/** Allocate a temporary Int32 buffer on the Havok WASM heap, run `fn(ptr)`, and always free it. */
export function withInt32Heap<T>(
  havok: HavokPhysicsWithBindings,
  values: ArrayLike<number>,
  fn: (ptr: number) => T,
): T {
  const count = values.length;
  const byteLength = Math.max(4, count * 4);
  const ptr = havok._malloc(byteLength);
  if (!ptr) throw new Error("Havok WASM int buffer allocation failed");
  try {
    const view = new Int32Array(havok.HEAPU8.buffer, ptr, count);
    view.set(values);
    return fn(ptr);
  } finally {
    havok._free(ptr);
  }
}

/**
 * Read a stepped body's 4x4 column-major float transform matrix directly from Havok's world body buffer
 * (`HP_World_GetBodyBuffer` + `HP_Body_GetWorldTransformOffset`) into `out` with zero allocations.
 */
export function readBodyBufferTransform(
  heap: Float32Array,
  floatIndex: number,
  out: PhysicsTransform,
): void {
  out.position.x = heap[floatIndex + 12]!;
  out.position.y = heap[floatIndex + 13]!;
  out.position.z = heap[floatIndex + 14]!;
  setRotationFromMatrix(out.rotation, heap, floatIndex);
}

/**
 * Extract a unit quaternion from the upper-left 3x3 rotation block of a column-major 4x4 float matrix at `m`.
 * Matches `Quaternion.FromRotationMatrixToRef` followed by normalization.
 */
export function setRotationFromMatrix(
  out: Quat,
  data: Float32Array,
  m: number,
): void {
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
  out.x = x / length;
  out.y = y / length;
  out.z = z / length;
  out.w = w / length;
}

export function toHavokVec3(v: Vec3): HavokVec3 {
  return [v.x, v.y, v.z];
}

export function toHavokQuat(q: Quat): HavokQuat {
  return [q.x, q.y, q.z, q.w];
}

export function vec3Cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function vec3Dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function conjugateQuat(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** Return a unit vector perpendicular to `axis` (for constraint anchor basis frames). */
export function perpendicularAxis(axis: Vec3): Vec3 {
  const ref: Vec3 = Math.abs(axis.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const c = vec3Cross(axis, ref);
  const len = Math.hypot(c.x, c.y, c.z) || 1;
  return { x: c.x / len, y: c.y / len, z: c.z / len };
}

/** Read the integer `.value` of an Emscripten embind enum object (or bare number). */
export function embindEnumValue(entry: unknown): number {
  return typeof entry === "number" ? entry : (entry as { value: number }).value;
}
