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
