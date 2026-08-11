import {
  SNAPSHOT_ACTOR_STRIDE,
  SNAPSHOT_HEADER_FLOATS,
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

export interface ActorSlot {
  slotId: number;
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
  flags: number;
}

export function writeSnapshotHeader(
  buf: Float32Array,
  header: Omit<SnapshotHeader, "magic" | "version"> &
    Partial<Pick<SnapshotHeader, "magic" | "version">>,
): void {
  buf[0] = header.magic ?? SNAPSHOT_MAGIC_F32;
  buf[1] = header.version ?? SNAPSHOT_LAYOUT_VERSION;
  buf[2] = header.frameId;
  buf[3] = header.tickIndex;
  buf[4] = header.actorCount;
  buf[5] = header.scriptMs;
  buf[6] = header.physicsMs;
  // Seq is an integer stored as raw u32 bits in float slot 7 (seq-lock / Atomics).
  buf[7] = u32ToFloatBits(header.seq >>> 0);
  for (let i = 8; i < SNAPSHOT_HEADER_FLOATS; i++) {
    buf[i] = 0;
  }
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
  };
}

export function writeActorSlot(
  buf: Float32Array,
  slotIndex: number,
  actor: ActorSlot,
): void {
  const o = actorSlotOffset(slotIndex);
  buf[o] = actor.slotId;
  buf[o + 1] = actor.position.x;
  buf[o + 2] = actor.position.y;
  buf[o + 3] = actor.position.z;
  buf[o + 4] = actor.rotation.x;
  buf[o + 5] = actor.rotation.y;
  buf[o + 6] = actor.rotation.z;
  buf[o + 7] = actor.rotation.w;
  buf[o + 8] = actor.scale.x;
  buf[o + 9] = actor.scale.y;
  buf[o + 10] = actor.scale.z;
  buf[o + 11] = actor.flags;
  for (let i = 12; i < SNAPSHOT_ACTOR_STRIDE; i++) {
    buf[o + i] = 0;
  }
}

export function readActorSlot(buf: Float32Array, slotIndex: number): ActorSlot {
  const o = actorSlotOffset(slotIndex);
  return {
    slotId: buf[o]!,
    position: { x: buf[o + 1]!, y: buf[o + 2]!, z: buf[o + 3]! },
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
