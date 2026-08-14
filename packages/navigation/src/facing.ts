import type { NavPoint } from "./types";

/**
 * Recast crowd has no orientation. Yaw around Recast Y from XZ velocity.
 * +Z is yaw 0; below `minLength` keep `previousYaw` to avoid jitter.
 */
export function facingYawFromVelocity(
  velocity: NavPoint,
  previousYaw: number,
  minLength = 0.01,
): number {
  const length = Math.hypot(velocity.x, velocity.z);
  if (length < minLength) return previousYaw;
  return Math.atan2(velocity.x, velocity.z);
}
