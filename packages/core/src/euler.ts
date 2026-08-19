/** Euler degrees [x, y, z] and quaternion [x, y, z, w] using Babylon YXZ (yaw/pitch/roll). */

export type EulerDegrees = [number, number, number];
export type QuaternionTuple = [number, number, number, number];

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Pitch (X), yaw (Y), roll (Z) in degrees → quaternion (YXZ / Babylon yaw-pitch-roll). */
export function eulerDegreesToQuaternion(
  euler: EulerDegrees,
): QuaternionTuple {
  const x = euler[0] * DEG;
  const y = euler[1] * DEG;
  const z = euler[2] * DEG;
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 - s1 * s2 * c3,
    c1 * c2 * c3 + s1 * s2 * s3,
  ];
}

/**
 * Quaternion that aims Babylon local +Z from `from` toward `target`
 * (YXZ yaw/pitch, no roll). Degenerate when the two points coincide.
 */
export function lookAtRotation(
  from: readonly [number, number, number],
  target: readonly [number, number, number] = [0, 0, 0],
): QuaternionTuple {
  const dx = target[0] - from[0];
  const dy = target[1] - from[1];
  const dz = target[2] - from[2];
  const horiz = Math.hypot(dx, dz);
  if (horiz < 1e-8 && Math.abs(dy) < 1e-8) {
    return [0, 0, 0, 1];
  }
  const yaw = Math.atan2(dx, dz) * RAD;
  const pitch = Math.atan2(-dy, horiz) * RAD;
  return eulerDegreesToQuaternion([pitch, yaw, 0]);
}

/** Inverse of {@link eulerDegreesToQuaternion}. */
export function quaternionToEulerDegrees(
  q: QuaternionTuple,
): EulerDegrees {
  const [qx, qy, qz, qw] = q;
  const sinp = 2 * (qw * qx - qy * qz);
  let x: number;
  let y: number;
  let z: number;
  if (Math.abs(sinp) < 0.9999999) {
    x = Math.asin(Math.min(1, Math.max(-1, sinp)));
    y = Math.atan2(2 * (qw * qy + qz * qx), 1 - 2 * (qx * qx + qy * qy));
    z = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qx * qx + qz * qz));
  } else {
    x = Math.asin(Math.min(1, Math.max(-1, sinp)));
    y = Math.atan2(2 * (qy * qw - qz * qx), 1 - 2 * (qy * qy + qz * qz));
    z = 0;
  }
  return [x * RAD, y * RAD, z * RAD];
}

export type RotatorObject = { pitch: number; yaw: number; roll: number };
export type QuatObject = { x: number; y: number; z: number; w: number };
export type Vec3Object = { x: number; y: number; z: number };

function readRotator(value: Partial<RotatorObject> | null | undefined): RotatorObject {
  return {
    pitch: Number(value?.pitch ?? 0),
    yaw: Number(value?.yaw ?? 0),
    roll: Number(value?.roll ?? 0),
  };
}

function readQuat(value: Partial<QuatObject> | null | undefined): QuatObject {
  const x = Number(value?.x ?? 0);
  const y = Number(value?.y ?? 0);
  const z = Number(value?.z ?? 0);
  const w = Number(value?.w ?? 1);
  if (x === 0 && y === 0 && z === 0 && w === 0) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  return { x, y, z, w };
}

function readVec3(value: Partial<Vec3Object> | null | undefined): Vec3Object {
  return {
    x: Number(value?.x ?? 0),
    y: Number(value?.y ?? 0),
    z: Number(value?.z ?? 0),
  };
}

export function rotatorToQuat(
  rotator: Partial<RotatorObject> | null | undefined,
): QuatObject {
  const r = readRotator(rotator);
  const [x, y, z, w] = eulerDegreesToQuaternion([r.pitch, r.yaw, r.roll]);
  return { x, y, z, w };
}

export function quatToRotator(
  quat: Partial<QuatObject> | null | undefined,
): RotatorObject {
  const q = readQuat(quat);
  const [pitch, yaw, roll] = quaternionToEulerDegrees([q.x, q.y, q.z, q.w]);
  return { pitch, yaw, roll };
}

export function multiplyQuats(
  a: Partial<QuatObject> | null | undefined,
  b: Partial<QuatObject> | null | undefined,
): QuatObject {
  const left = readQuat(a);
  const right = readQuat(b);
  return {
    x: left.w * right.x + left.x * right.w + left.y * right.z - left.z * right.y,
    y: left.w * right.y - left.x * right.z + left.y * right.w + left.z * right.x,
    z: left.w * right.z + left.x * right.y - left.y * right.x + left.z * right.w,
    w: left.w * right.w - left.x * right.x - left.y * right.y - left.z * right.z,
  };
}

export function inverseQuat(
  quat: Partial<QuatObject> | null | undefined,
): QuatObject {
  const q = readQuat(quat);
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

export function combineRotators(
  a: Partial<RotatorObject> | null | undefined,
  b: Partial<RotatorObject> | null | undefined,
): RotatorObject {
  return quatToRotator(multiplyQuats(rotatorToQuat(a), rotatorToQuat(b)));
}

export function inverseRotator(
  rotator: Partial<RotatorObject> | null | undefined,
): RotatorObject {
  return quatToRotator(inverseQuat(rotatorToQuat(rotator)));
}

export function deltaRotator(
  from: Partial<RotatorObject> | null | undefined,
  to: Partial<RotatorObject> | null | undefined,
): RotatorObject {
  return combineRotators(inverseRotator(from), to);
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export function slerpQuats(
  a: Partial<QuatObject> | null | undefined,
  b: Partial<QuatObject> | null | undefined,
  alpha: number,
): QuatObject {
  let left = readQuat(a);
  const right = readQuat(b);
  const t = clamp01(Number(alpha));
  let dot =
    left.x * right.x + left.y * right.y + left.z * right.z + left.w * right.w;
  if (dot < 0) {
    left = { x: -left.x, y: -left.y, z: -left.z, w: -left.w };
    dot = -dot;
  }
  if (dot > 0.9995) {
    return {
      x: left.x + (right.x - left.x) * t,
      y: left.y + (right.y - left.y) * t,
      z: left.z + (right.z - left.z) * t,
      w: left.w + (right.w - left.w) * t,
    };
  }
  const theta = Math.acos(Math.min(1, dot));
  const sinTheta = Math.sin(theta);
  const w0 = Math.sin((1 - t) * theta) / sinTheta;
  const w1 = Math.sin(t * theta) / sinTheta;
  return {
    x: left.x * w0 + right.x * w1,
    y: left.y * w0 + right.y * w1,
    z: left.z * w0 + right.z * w1,
    w: left.w * w0 + right.w * w1,
  };
}

export function lerpRotator(
  a: Partial<RotatorObject> | null | undefined,
  b: Partial<RotatorObject> | null | undefined,
  alpha: number,
): RotatorObject {
  return quatToRotator(slerpQuats(rotatorToQuat(a), rotatorToQuat(b), alpha));
}

export function quatRotateVector(
  quat: Partial<QuatObject> | null | undefined,
  vector: Partial<Vec3Object> | null | undefined,
): Vec3Object {
  const q = readQuat(quat);
  const v = readVec3(vector);
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

export function rotatorForward(
  rotator: Partial<RotatorObject> | null | undefined,
): Vec3Object {
  return quatRotateVector(rotatorToQuat(rotator), { x: 0, y: 0, z: 1 });
}

export function rotatorRight(
  rotator: Partial<RotatorObject> | null | undefined,
): Vec3Object {
  return quatRotateVector(rotatorToQuat(rotator), { x: 1, y: 0, z: 0 });
}

export function rotatorUp(
  rotator: Partial<RotatorObject> | null | undefined,
): Vec3Object {
  return quatRotateVector(rotatorToQuat(rotator), { x: 0, y: 1, z: 0 });
}

export function lookAtRotator(
  from: Partial<Vec3Object> | null | undefined,
  target: Partial<Vec3Object> | null | undefined,
): RotatorObject {
  const start = readVec3(from);
  const end = readVec3(target);
  return quatToRotator(
    tupleToQuat(
      lookAtRotation([start.x, start.y, start.z], [end.x, end.y, end.z]),
    ),
  );
}

function tupleToQuat(tuple: QuaternionTuple): QuatObject {
  return { x: tuple[0], y: tuple[1], z: tuple[2], w: tuple[3] };
}
