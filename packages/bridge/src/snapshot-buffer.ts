import {
  SNAPSHOT_LAYOUT_VERSION,
  SNAPSHOT_MAGIC_F32,
  actorSlotOffset,
  u32ToFloatBits,
  floatBitsToU32,
} from "./layout";

export interface SnapshotHeader {
  magic: number;
  version: number;
  frameId: number;
  tickIndex: number;
  actorCount: number;
  scriptMs: number;
  physicsMs: number;
  seq: number;
  layoutGeneration: number;
  origin?: Vec3;
  originGeneration?: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Snapshot `flags` bit 0: actor is visible. */
export const SNAPSHOT_FLAG_VISIBLE = 1;
/** Snapshot `flags` bit 1: actor is a SceneLayer HUD overlay (not the world Scene). */
export const SNAPSHOT_FLAG_OVERLAY = 2;

export interface ActorSlot {
  slotId: number;
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
  flags: number;
}

export function writeSnapshotHeader(
  buf: Float32Array,
  header: Omit<SnapshotHeader, "magic" | "version" | "seq" | "layoutGeneration"> &
    Partial<Pick<SnapshotHeader, "magic" | "version" | "seq" | "layoutGeneration">>,
): void {
  buf[0] = header.magic ?? SNAPSHOT_MAGIC_F32;
  buf[1] = header.version ?? SNAPSHOT_LAYOUT_VERSION;
  buf[2] = header.frameId;
  buf[3] = header.tickIndex;
  buf[4] = header.actorCount;
  buf[5] = header.scriptMs;
  buf[6] = header.physicsMs;
  if (header.seq !== undefined) {
    // Seq is an integer stored as raw u32 bits in float slot 7 (seq-lock / Atomics).
    buf[7] = u32ToFloatBits(header.seq >>> 0);
  }
  buf[8] = header.layoutGeneration ?? 0;
  const origin = header.origin ?? { x: 0, y: 0, z: 0 };
  buf[9] = origin.x; buf[10] = origin.y; buf[11] = origin.z;
  buf[12] = origin.x - buf[9]!; buf[13] = origin.y - buf[10]!; buf[14] = origin.z - buf[11]!;
  buf[15] = header.originGeneration ?? 0;
}

export function readSnapshotHeader(buf: Float32Array): SnapshotHeader {
  return {
    magic: buf[0]!,
    version: buf[1]!,
    frameId: buf[2]!,
    tickIndex: buf[3]!,
    actorCount: buf[4]!,
    scriptMs: buf[5]!,
    physicsMs: buf[6]!,
    seq: floatBitsToU32(buf[7]!),
    layoutGeneration: buf[8]!,
    origin: { x: buf[9]! + buf[12]!, y: buf[10]! + buf[13]!, z: buf[11]! + buf[14]! },
    originGeneration: buf[15]!,
  };
}

/** True when the buffer was published (`magic` + layout version), not a zeroed spare. */
export function isPublishedSnapshot(buf: Float32Array): boolean {
  return (
    buf[0] === SNAPSHOT_MAGIC_F32 && buf[1] === SNAPSHOT_LAYOUT_VERSION
  );
}

/** Last completed simulation tick, or null when the buffer is unpublished. */
export function snapshotTickIndex(buf: Float32Array): number | null {
  if (!isPublishedSnapshot(buf)) return null;
  return readSnapshotHeader(buf).tickIndex;
}

export function writeActorSlot(
  buf: Float32Array,
  slotIndex: number,
  actor: ActorSlot,
  origin: Vec3 = { x: 0, y: 0, z: 0 },
): void {
  const o = actorSlotOffset(slotIndex);
  buf[o] = actor.slotId;
  const x = actor.position.x - origin.x;
  const y = actor.position.y - origin.y;
  const z = actor.position.z - origin.z;
  buf[o + 1] = x;
  buf[o + 2] = y;
  buf[o + 3] = z;
  buf[o + 4] = actor.rotation.x;
  buf[o + 5] = actor.rotation.y;
  buf[o + 6] = actor.rotation.z;
  buf[o + 7] = actor.rotation.w;
  buf[o + 8] = actor.scale.x;
  buf[o + 9] = actor.scale.y;
  buf[o + 10] = actor.scale.z;
  buf[o + 11] = actor.flags;
  buf[o + 12] = x - buf[o + 1]!;
  buf[o + 13] = y - buf[o + 2]!;
  buf[o + 14] = z - buf[o + 3]!;
  buf[o + 15] = 0;
}

export function readActorSlot(buf: Float32Array, slotIndex: number): ActorSlot {
  const o = actorSlotOffset(slotIndex);
  return {
    slotId: buf[o]!,
    position: {
      x: (buf[o + 1]! + buf[o + 12]!) + (buf[9]! + buf[12]!),
      y: (buf[o + 2]! + buf[o + 13]!) + (buf[10]! + buf[13]!),
      z: (buf[o + 3]! + buf[o + 14]!) + (buf[11]! + buf[14]!),
    },
    rotation: {
      x: buf[o + 4]!,
      y: buf[o + 5]!,
      z: buf[o + 6]!,
      w: buf[o + 7]!,
    },
    scale: { x: buf[o + 8]!, y: buf[o + 9]!, z: buf[o + 10]! },
    flags: buf[o + 11]!,
  };
}

export function clearSnapshot(buf: Float32Array): void {
  buf.fill(0);
}
