import { normalizeQuat, slerpQuats } from "./euler";
import type { SerializedComponent } from "./scene";

export const SPRING_ARM_COMPONENT_CLASS_ID = "SpringArmComponent";
export const SPRING_ARM_LENGTH_LIMITS = [0, 1000] as const;
export const SPRING_ARM_LAG_SPEED_LIMITS = [0.1, 100] as const;
/** Camera Probe sphere radius, in world units. */
export const SPRING_ARM_PROBE_SIZE_LIMITS = [0.01, 5] as const;
/** Camera Probe return speed; 0 returns at once. */
export const SPRING_ARM_PROBE_RETURN_SPEED_LIMITS = [0, 100] as const;
/**
 * Query channels the Camera Probe can use (the script trace channels without
 * All and Triggers: the probe never hits triggers, so All would equal Solid).
 */
export const SPRING_ARM_PROBE_CHANNELS = ["Static", "Dynamic", "Character", "Solid"] as const;
export type SpringArmProbeChannel = (typeof SPRING_ARM_PROBE_CHANNELS)[number];
/** Longest frame step the lag integrates; longer stalls resume without a jump. */
const SPRING_ARM_MAX_LAG_STEP_SECONDS = 0.1;

export interface SpringArmProperties {
  /** Distance from the arm pivot to the socket that children attach to. */
  armLength: number;
  enableLocationLag: boolean;
  /** Higher values catch up faster (1/s, frame-rate independent). */
  locationLagSpeed: number;
  /** Farthest the lagged pivot may trail its target; 0 disables the clamp. */
  maxLocationLagDistance: number;
  enableRotationLag: boolean;
  rotationLagSpeed: number;
  /** Play draws the target arm, the lagged arm, their offsets and a socket trail. */
  drawDebugLag: boolean;
  /** Play pulls the socket in front of whatever blocks the arm (a sphere sweep from the pivot). */
  cameraProbe: boolean;
  /** Radius of the probe sphere, in world units. */
  probeSize: number;
  /** What blocks the probe; it never hits triggers or the arm's own actor. */
  probeChannel: SpringArmProbeChannel;
  /** How fast the arm grows back once the way clears (1/s); 0 returns at once. Pulling in is always instant. */
  probeReturnSpeed: number;
}

export const DEFAULT_SPRING_ARM_PROPERTIES: Readonly<SpringArmProperties> = {
  armLength: 4,
  enableLocationLag: false,
  locationLagSpeed: 10,
  maxLocationLagDistance: 0,
  enableRotationLag: false,
  rotationLagSpeed: 10,
  drawDebugLag: false,
  cameraProbe: false,
  probeSize: 0.15,
  probeChannel: "Static",
  probeReturnSpeed: 10,
};

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function parseSpringArmProperties(value: unknown): SpringArmProperties {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const defaults = DEFAULT_SPRING_ARM_PROPERTIES;
  return {
    armLength: finiteNumber(source.armLength, defaults.armLength, ...SPRING_ARM_LENGTH_LIMITS),
    enableLocationLag: source.enableLocationLag === true,
    locationLagSpeed: finiteNumber(source.locationLagSpeed, defaults.locationLagSpeed, ...SPRING_ARM_LAG_SPEED_LIMITS),
    maxLocationLagDistance: finiteNumber(source.maxLocationLagDistance, defaults.maxLocationLagDistance, 0, Number.MAX_VALUE),
    enableRotationLag: source.enableRotationLag === true,
    rotationLagSpeed: finiteNumber(source.rotationLagSpeed, defaults.rotationLagSpeed, ...SPRING_ARM_LAG_SPEED_LIMITS),
    drawDebugLag: source.drawDebugLag === true,
    cameraProbe: source.cameraProbe === true,
    probeSize: finiteNumber(source.probeSize, defaults.probeSize, ...SPRING_ARM_PROBE_SIZE_LIMITS),
    probeChannel: SPRING_ARM_PROBE_CHANNELS.includes(source.probeChannel as SpringArmProbeChannel)
      ? source.probeChannel as SpringArmProbeChannel
      : defaults.probeChannel,
    probeReturnSpeed: finiteNumber(source.probeReturnSpeed, defaults.probeReturnSpeed, ...SPRING_ARM_PROBE_RETURN_SPEED_LIMITS),
  };
}

/**
 * Socket position in the arm's local space. The arm extends behind its pivot
 * (-Z), so an unrotated child camera looks forward (+Z) back at the pivot.
 */
export function springArmSocketPosition(armLength: number): [number, number, number] {
  return [0, 0, -armLength];
}

/** Socket offset contributed by a parent component, or null when it is not a spring arm. */
export function springArmChildOffset(
  parent: Pick<SerializedComponent, "classId" | "properties"> | null | undefined,
): [number, number, number] | null {
  if (parent?.classId !== SPRING_ARM_COMPONENT_CLASS_ID) return null;
  return springArmSocketPosition(parseSpringArmProperties(parent.properties).armLength);
}

export interface SpringArmPose {
  position: [number, number, number];
  /** Quaternion as [x, y, z, w]. */
  rotation: [number, number, number, number];
}

/** Fraction of the remaining gap closed in `dtSeconds` by an exponential approach at `speed`. */
function springArmLagAlpha(speed: number, dtSeconds: number): number {
  if (!(dtSeconds > 0) || !(speed > 0)) return 0;
  return 1 - Math.exp(-speed * Math.min(dtSeconds, SPRING_ARM_MAX_LAG_STEP_SECONDS));
}

/**
 * The Camera Probe's arm length after `dtSeconds`: a shorter `target` (the
 * way is blocked) applies at once, so the camera never passes through what
 * blocks it; a longer one is approached at `returnSpeed` (0 jumps). The first
 * step (no `current`) takes the target.
 */
export function stepSpringArmProbeLength(
  current: number | null,
  target: number,
  returnSpeed: number,
  dtSeconds: number,
): number {
  if (current === null || target <= current || returnSpeed <= 0) return target;
  const next = current + (target - current) * springArmLagAlpha(returnSpeed, dtSeconds);
  // Settle instead of creeping toward the full length forever.
  return target - next < 1e-4 ? target : next;
}

function clonePose(pose: SpringArmPose): SpringArmPose {
  return { position: [...pose.position], rotation: [...pose.rotation] };
}

/**
 * Advance the lagged arm pivot toward its target world pose. The first step
 * (no previous pose) snaps to the target; disabled channels follow exactly.
 */
export function stepSpringArmLag(
  previous: SpringArmPose | null,
  target: SpringArmPose,
  dtSeconds: number,
  properties: SpringArmProperties,
): SpringArmPose {
  if (!previous) return clonePose(target);
  const position: [number, number, number] = [...target.position];
  if (properties.enableLocationLag) {
    const alpha = springArmLagAlpha(properties.locationLagSpeed, dtSeconds);
    for (let axis = 0; axis < 3; axis++) {
      position[axis] = previous.position[axis]! + (target.position[axis]! - previous.position[axis]!) * alpha;
    }
    const max = properties.maxLocationLagDistance;
    if (max > 0) {
      const dx = position[0] - target.position[0];
      const dy = position[1] - target.position[1];
      const dz = position[2] - target.position[2];
      const distance = Math.hypot(dx, dy, dz);
      if (distance > max) {
        const scale = max / distance;
        position[0] = target.position[0] + dx * scale;
        position[1] = target.position[1] + dy * scale;
        position[2] = target.position[2] + dz * scale;
      }
    }
  }
  let rotation: [number, number, number, number] = [...target.rotation];
  if (properties.enableRotationLag) {
    const [px, py, pz, pw] = previous.rotation;
    const [tx, ty, tz, tw] = target.rotation;
    const q = normalizeQuat(slerpQuats(
      { x: px, y: py, z: pz, w: pw },
      { x: tx, y: ty, z: tz, w: tw },
      springArmLagAlpha(properties.rotationLagSpeed, dtSeconds),
    ));
    rotation = [q.x, q.y, q.z, q.w];
  }
  return { position, rotation };
}
