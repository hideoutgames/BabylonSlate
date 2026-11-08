import type { NavPoint } from "./types";

/** XZ speed below which the facing keeps its previous yaw, to avoid jitter. */
const MIN_FACING_SPEED = 0.01;

/**
 * Recast crowd has no orientation. Yaw around Recast Y from XZ velocity.
 * +Z is yaw 0; below `MIN_FACING_SPEED` keep `previousYaw` to avoid jitter.
 */
export function facingYawFromVelocity(velocity: NavPoint, previousYaw: number): number {
  const length = Math.hypot(velocity.x, velocity.z);
  if (length < MIN_FACING_SPEED) return previousYaw;
  return Math.atan2(velocity.x, velocity.z);
}
