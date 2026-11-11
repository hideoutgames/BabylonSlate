/** Euler degrees [x, y, z] and quaternion [x, y, z, w] using Babylon YXZ (yaw/pitch/roll). */

export type EulerDegrees = [number, number, number];
export type QuaternionTuple = [number, number, number, number];

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

// The scalar kernels below write their result into these slots instead of returning an array or
// an object: the rotation nodes run every tick, and a combined operation chains several kernels.
// A caller reads the slots before it runs another kernel.
let outX = 0;
let outY = 0;
let outZ = 0;
let outW = 1;
let outPitch = 0;
let outYaw = 0;
let outRoll = 0;

/** Pitch (X), yaw (Y), roll (Z) in degrees to a quaternion in `outX`..`outW` (YXZ / Babylon yaw-pitch-roll). */
function eulerToQuat(pitch: number, yaw: number, roll: number): void {
  const x = pitch * DEG;
  const y = yaw * DEG;
  const z = roll * DEG;
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);
  outX = s1 * c2 * c3 + c1 * s2 * s3;
  outY = c1 * s2 * c3 - s1 * c2 * s3;
  outZ = c1 * c2 * s3 - s1 * s2 * c3;
  outW = c1 * c2 * c3 + s1 * s2 * s3;
}

/** Inverse of `eulerToQuat`, into `outPitch`, `outYaw` and `outRoll`. */
function quatToEuler(qx: number, qy: number, qz: number, qw: number): void {
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
  outPitch = x * RAD;
  outYaw = y * RAD;
  outRoll = z * RAD;
}

/** Pitch (X), yaw (Y), roll (Z) in degrees → quaternion (YXZ / Babylon yaw-pitch-roll). */
export function eulerDegreesToQuaternion(
  euler: EulerDegrees,
): QuaternionTuple {
  eulerToQuat(euler[0], euler[1], euler[2]);
  return [outX, outY, outZ, outW];
}

/**
 * Quaternion that aims Babylon local +Z from `from` toward `target`
 * (YXZ yaw/pitch, no roll). Degenerate when the two points coincide.
 */
export function lookAtRotation(
  from: readonly [number, number, number],
  target: readonly [number, number, number] = [0, 0, 0],
): QuaternionTuple {
  lookAt(from[0], from[1], from[2], target[0], target[1], target[2]);
  return [outX, outY, outZ, outW];
}

/** `lookAtRotation` on scalars, into `outX`..`outW`. */
function lookAt(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): void {
  const dx = tx - fx;
  const dy = ty - fy;
  const dz = tz - fz;
  const horiz = Math.hypot(dx, dz);
  if (horiz < 1e-8 && Math.abs(dy) < 1e-8) {
    outX = 0;
    outY = 0;
    outZ = 0;
    outW = 1;
    return;
  }
  eulerToQuat(Math.atan2(-dy, horiz) * RAD, Math.atan2(dx, dz) * RAD, 0);
}

/** Inverse of {@link eulerDegreesToQuaternion}. */
export function quaternionToEulerDegrees(
  q: QuaternionTuple,
): EulerDegrees {
  quatToEuler(q[0], q[1], q[2], q[3]);
  return [outPitch, outYaw, outRoll];
}

export type RotatorObject = { pitch: number; yaw: number; roll: number };
export type QuatObject = { x: number; y: number; z: number; w: number };
export type Vec3Object = { x: number; y: number; z: number };

type RotatorInput = Partial<RotatorObject> | null | undefined;
type QuatInput = Partial<QuatObject> | null | undefined;
type Vec3Input = Partial<Vec3Object> | null | undefined;

/** A rotator pin value as a quaternion in `outX`..`outW`; a missing component is 0. */
function loadRotator(value: RotatorInput): void {
  eulerToQuat(Number(value?.pitch ?? 0), Number(value?.yaw ?? 0), Number(value?.roll ?? 0));
}

/** A quaternion pin value in `outX`..`outW`: a missing one, or all zeros, is the identity. */
function loadQuat(value: QuatInput): void {
  setQuat(Number(value?.x ?? 0), Number(value?.y ?? 0), Number(value?.z ?? 0), Number(value?.w ?? 1));
}

/** `(x, y, z, w)` in `outX`..`outW`, with all zeros read as the identity. */
function setQuat(x: number, y: number, z: number, w: number): void {
  const zero = x === 0 && y === 0 && z === 0 && w === 0;
  outX = x;
  outY = y;
  outZ = z;
  outW = zero ? 1 : w;
}

/**
 * Scales the quaternion in `outX`..`outW` to unit length. Make Quaternion and arithmetic on
 * quaternions can hand over any length, and the formulas below assume one: (0, 1, 0, 1) is a 90°
 * yaw, not 116°.
 */
function normalizeOut(): void {
  const length = Math.hypot(outX, outY, outZ, outW);
  if (!(length > 0) || !Number.isFinite(length)) {
    outX = 0;
    outY = 0;
    outZ = 0;
    outW = 1;
    return;
  }
  if (Math.abs(length - 1) < 1e-9) return;
  outX /= length;
  outY /= length;
  outZ /= length;
  outW /= length;
}

/** The Hamilton product `a * b`, into `outX`..`outW`. */
function multiply(ax: number, ay: number, az: number, aw: number, bx: number, by: number, bz: number, bw: number): void {
  outX = aw * bx + ax * bw + ay * bz - az * by;
  outY = aw * by - ax * bz + ay * bw + az * bx;
  outZ = aw * bz + ax * by - ay * bx + az * bw;
  outW = aw * bw - ax * bx - ay * by - az * bz;
}

/** The rotation in `outX`..`outW` as a rotator, into `outPitch`, `outYaw` and `outRoll`. */
function outToEuler(): void {
  setQuat(outX, outY, outZ, outW);
  normalizeOut();
  quatToEuler(outX, outY, outZ, outW);
}

function outQuat(): QuatObject {
  return { x: outX, y: outY, z: outZ, w: outW };
}

function outRotator(): RotatorObject {
  return { pitch: outPitch, yaw: outYaw, roll: outRoll };
}

export function rotatorToQuat(rotator: RotatorInput): QuatObject {
  loadRotator(rotator);
  return outQuat();
}

export function quatToRotator(quat: QuatInput): RotatorObject {
  loadQuat(quat);
  outToEuler();
  return outRotator();
}

export function multiplyQuats(a: QuatInput, b: QuatInput): QuatObject {
  loadQuat(a);
  const ax = outX, ay = outY, az = outZ, aw = outW;
  loadQuat(b);
  multiply(ax, ay, az, aw, outX, outY, outZ, outW);
  return outQuat();
}

export function inverseQuat(quat: QuatInput): QuatObject {
  loadQuat(quat);
  normalizeOut();
  return { x: -outX, y: -outY, z: -outZ, w: outW };
}

/** `a` then `b` as one rotator, into `outPitch`, `outYaw` and `outRoll`. */
function combine(aPitch: number, aYaw: number, aRoll: number, b: RotatorInput): void {
  eulerToQuat(aPitch, aYaw, aRoll);
  const ax = outX, ay = outY, az = outZ, aw = outW;
  loadRotator(b);
  multiply(ax, ay, az, aw, outX, outY, outZ, outW);
  outToEuler();
}

/** The inverse of `rotator`, into `outPitch`, `outYaw` and `outRoll`. */
function invert(rotator: RotatorInput): void {
  loadRotator(rotator);
  normalizeOut();
  outX = -outX;
  outY = -outY;
  outZ = -outZ;
  outToEuler();
}

export function combineRotators(a: RotatorInput, b: RotatorInput): RotatorObject {
  combine(Number(a?.pitch ?? 0), Number(a?.yaw ?? 0), Number(a?.roll ?? 0), b);
  return outRotator();
}

export function inverseRotator(rotator: RotatorInput): RotatorObject {
  invert(rotator);
  return outRotator();
}

export function deltaRotator(from: RotatorInput, to: RotatorInput): RotatorObject {
  invert(from);
  combine(outPitch, outYaw, outRoll, to);
  return outRotator();
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/** The shortest-arc interpolation from `a` to `b`, into `outX`..`outW`; `t` is clamped to 0..1. */
function slerp(ax: number, ay: number, az: number, aw: number, bx: number, by: number, bz: number, bw: number, alpha: number): void {
  const t = clamp01(Number(alpha));
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) {
    ax = -ax;
    ay = -ay;
    az = -az;
    aw = -aw;
    dot = -dot;
  }
  if (dot > 0.9995) {
    outX = ax + (bx - ax) * t;
    outY = ay + (by - ay) * t;
    outZ = az + (bz - az) * t;
    outW = aw + (bw - aw) * t;
    return;
  }
  const theta = Math.acos(Math.min(1, dot));
  const sinTheta = Math.sin(theta);
  const w0 = Math.sin((1 - t) * theta) / sinTheta;
  const w1 = Math.sin(t * theta) / sinTheta;
  outX = ax * w0 + bx * w1;
  outY = ay * w0 + by * w1;
  outZ = az * w0 + bz * w1;
  outW = aw * w0 + bw * w1;
}

export function slerpQuats(a: QuatInput, b: QuatInput, alpha: number): QuatObject {
  loadQuat(a);
  const ax = outX, ay = outY, az = outZ, aw = outW;
  loadQuat(b);
  slerp(ax, ay, az, aw, outX, outY, outZ, outW, alpha);
  return outQuat();
}

export function lerpRotator(a: RotatorInput, b: RotatorInput, alpha: number): RotatorObject {
  loadRotator(a);
  const ax = outX, ay = outY, az = outZ, aw = outW;
  loadRotator(b);
  slerp(ax, ay, az, aw, outX, outY, outZ, outW, alpha);
  outToEuler();
  return outRotator();
}

/** `(vx, vy, vz)` turned by the unit quaternion in `outX`..`outW`. */
function rotated(vx: number, vy: number, vz: number): Vec3Object {
  const qx = outX, qy = outY, qz = outZ, qw = outW;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return {
    x: vx + qw * tx + (qy * tz - qz * ty),
    y: vy + qw * ty + (qz * tx - qx * tz),
    z: vz + qw * tz + (qx * ty - qy * tx),
  };
}

export function quatRotateVector(quat: QuatInput, vector: Vec3Input): Vec3Object {
  loadQuat(quat);
  normalizeOut();
  return rotated(Number(vector?.x ?? 0), Number(vector?.y ?? 0), Number(vector?.z ?? 0));
}

/** The axis `(vx, vy, vz)` of an object turned by `rotator`. */
function rotatorAxis(rotator: RotatorInput, vx: number, vy: number, vz: number): Vec3Object {
  loadRotator(rotator);
  normalizeOut();
  return rotated(vx, vy, vz);
}

export function rotatorForward(rotator: RotatorInput): Vec3Object {
  return rotatorAxis(rotator, 0, 0, 1);
}

export function rotatorRight(rotator: RotatorInput): Vec3Object {
  return rotatorAxis(rotator, 1, 0, 0);
}

export function rotatorUp(rotator: RotatorInput): Vec3Object {
  return rotatorAxis(rotator, 0, 1, 0);
}

export function lookAtRotator(from: Vec3Input, target: Vec3Input): RotatorObject {
  lookAt(
    Number(from?.x ?? 0), Number(from?.y ?? 0), Number(from?.z ?? 0),
    Number(target?.x ?? 0), Number(target?.y ?? 0), Number(target?.z ?? 0),
  );
  outToEuler();
  return outRotator();
}

export function normalizeQuat(quat: QuatInput): QuatObject {
  loadQuat(quat);
  const length = Math.hypot(outX, outY, outZ, outW);
  if (length < 1e-8) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: outX / length, y: outY / length, z: outZ / length, w: outW / length };
}
