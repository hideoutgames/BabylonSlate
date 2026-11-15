import { extractAnimationRootMotion, type AnimationRootMotion } from "@haptic/assets";

/**
 * The root motion an Animation's clip makes on `bone`, or, without one, on the first of its Skeleton's bones that travels
 * across the ground (else turns). Null when the file has neither the clip nor any such bone.
 */
export function animationRootMotionFrom(
  bytes: Uint8Array,
  clipName: string,
  bones: readonly string[],
  bone?: string,
): AnimationRootMotion | null {
  if (bone) return extractAnimationRootMotion(bytes, clipName, bone);
  let first: AnimationRootMotion | null = null;
  for (const candidate of bones) {
    const motion = extractAnimationRootMotion(bytes, clipName, candidate);
    if (!motion) continue;
    first ??= motion;
    const { x, z, yaw } = motion.track;
    const last = x.length - 1;
    if (Math.hypot(x[last]!, z[last]!) > 1e-3 || Math.abs(yaw[last]!) > 0.5) return motion;
  }
  return first;
}
