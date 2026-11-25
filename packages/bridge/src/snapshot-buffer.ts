import {
  SNAPSHOT_ACTOR_STRIDE,
  SNAPSHOT_DIRTY_META_WORDS,
  SNAPSHOT_HEADER_FLOATS,
  SNAPSHOT_LAYOUT_VERSION,
  SNAPSHOT_MAGIC_F32,
  actorSlotOffset,
  snapshotDirtyBitsetWords,
  snapshotDirtyMetaOffset,
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
  // Frame and tick identities are raw u32 bits (like `seq`): a float32 value
  // stops counting every integer past 2^24 (about 78 hours at 60 Hz).
  buf[2] = u32ToFloatBits(header.frameId);
  buf[3] = u32ToFloatBits(header.tickIndex);
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
    frameId: floatBitsToU32(buf[2]!),
    tickIndex: floatBitsToU32(buf[3]!),
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

/**
 * Floats a reader needs from `buf`: the header plus its `actorCount` rows,
 * clamped to the buffer. Rows past `actorCount` may hold an earlier frame's
 * data, so copies stop here and readers never look beyond it.
 */
export function snapshotActiveFloatCount(buf: Float32Array): number {
  const count = buf[4] ?? 0;
  const rows = count > 0 ? Math.floor(count) : 0;
  return Math.min(buf.length, SNAPSHOT_HEADER_FLOATS + rows * SNAPSHOT_ACTOR_STRIDE);
}

/** Last completed simulation tick, or null when the buffer is unpublished. */
export function snapshotTickIndex(buf: Float32Array): number | null {
  if (!isPublishedSnapshot(buf)) return null;
  return readSnapshotHeader(buf).tickIndex;
}

/** The snapshot's frame id, or null when the buffer is unpublished; reads the one header field, building no header. */
export function snapshotFrameId(buf: Float32Array): number | null {
  return isPublishedSnapshot(buf) ? floatBitsToU32(buf[2]!) : null;
}

/** A worker host's input tick after a snapshot: its tickIndex once published, so throttled stats cannot drop sticks. */
export function applySnapshotTick(previous: number, buf: Float32Array): number {
  return snapshotTickIndex(buf) ?? previous;
}

/**
 * Tick stamp for Play canvas events. In-process Play uses World.clock; a
 * worker host has no World on the main thread, so it uses the last snapshot
 * `tickIndex` rather than `performance.now() / (1000/60)`.
 */
export function playInputStampTick(inProcessTickIndex: number | undefined, lastWorkerTickIndex: number): number {
  return inProcessTickIndex ?? lastWorkerTickIndex;
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

/** Decode one actor slot into caller-owned scratch without allocating. */
export function readActorSlotInto(buf: Float32Array, slotIndex: number, out: ActorSlot): ActorSlot {
  const o = actorSlotOffset(slotIndex);
  out.slotId = buf[o]!;
  out.position.x = (buf[o + 1]! + buf[o + 12]!) + (buf[9]! + buf[12]!);
  out.position.y = (buf[o + 2]! + buf[o + 13]!) + (buf[10]! + buf[13]!);
  out.position.z = (buf[o + 3]! + buf[o + 14]!) + (buf[11]! + buf[14]!);
  out.rotation.x = buf[o + 4]!;
  out.rotation.y = buf[o + 5]!;
  out.rotation.z = buf[o + 6]!;
  out.rotation.w = buf[o + 7]!;
  out.scale.x = buf[o + 8]!;
  out.scale.y = buf[o + 9]!;
  out.scale.z = buf[o + 10]!;
  out.flags = buf[o + 11]!;
  return out;
}

/**
 * Uint32 view over a snapshot buffer's dirty metadata (`[serial, flags]`) and
 * per-row bitset (`ceil(maxActors / 32)` words). Returns null when `buf` has no
 * dirty tail (e.g. a zero-capacity or custom-sized view).
 */
export function snapshotDirtyView(buf: Float32Array, maxActors: number): Uint32Array | null {
  if (maxActors <= 0) return null;
  const offset = snapshotDirtyMetaOffset(maxActors);
  const words = SNAPSHOT_DIRTY_META_WORDS + snapshotDirtyBitsetWords(maxActors);
  if (buf.length < offset + words) return null;
  return new Uint32Array(buf.buffer, buf.byteOffset + offset * 4, words);
}

/** Clear the active dirty-row bitset words for `actorCount` rows and write `[serial, flags]`. */
export function writeSnapshotDirtyMeta(
  dirtyView: Uint32Array,
  serial: number,
  flags: number,
  actorCount: number,
  clearBitset: boolean,
): void {
  dirtyView[0] = serial >>> 0;
  dirtyView[1] = flags >>> 0;
  if (clearBitset) {
    const activeWords = snapshotDirtyBitsetWords(actorCount);
    dirtyView.fill(0, SNAPSHOT_DIRTY_META_WORDS, SNAPSHOT_DIRTY_META_WORDS + activeWords);
  }
}

/** Set row `row`'s bit in the snapshot dirty-row bitset. */
export function markSnapshotDirtyRow(dirtyView: Uint32Array, row: number): void {
  const word = SNAPSHOT_DIRTY_META_WORDS + (row >>> 5);
  if (word < dirtyView.length) dirtyView[word]! |= 1 << (row & 31);
}
