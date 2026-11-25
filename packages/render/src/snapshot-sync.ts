import {
  SNAPSHOT_ACTOR_STRIDE,
  SNAPSHOT_DIRTY_FLAG_FULL,
  SNAPSHOT_DIRTY_FLAG_TRACKED,
  SNAPSHOT_DIRTY_META_WORDS,
  SNAPSHOT_HEADER_FLOATS,
  SeqLockSnapshotPair,
  actorSlotOffset,
  isPublishedSnapshot,
  readActorSlotInto,
  readSnapshotHeader,
  snapshotActiveFloatCount,
  snapshotDirtyBitsetWords,
  snapshotDirtyView,
  snapshotFloatCount,
  snapshotFrameId,
  snapshotTickIndex,
  type ActorSlot,
  type SharedSnapshotBuffers,
} from "@haptic/bridge";
import type { AudioPose } from "./audio-playback-backend";

export interface SampledSnapshot {
  frameId: number;
  tickIndex: number;
  actors: ActorSlot[];
  actorCount: number;
  /** True when the caller must run full visual reconciliation and visit all `actorCount` rows. */
  full?: boolean;
  /** Row indices `[0..dirtyCount)` that changed since the last sample when `full === false`. */
  dirtyRows?: Uint32Array;
  /** Number of valid dirty row indices in `dirtyRows` when `full === false`. */
  dirtyCount?: number;
}

function emptySlot(): ActorSlot {
  return {
    slotId: 0,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
    flags: 0,
  };
}

/**
 * Holds the latest published snapshot and samples it into reused scratch
 * ActorSlot objects — no per-actor allocation in sample().
 */
export class SnapshotSampler {
  private latest: Float32Array | null = null;
  private buffer: Float32Array;
  private maxActors: number;
  private scratch: ActorSlot[];
  private dirtyRows: Uint32Array;
  private dirtyCount = 0;
  private pendingFull = true;
  private lastSerial = 0;
  private lastActorCount = -1;
  private sharedPair: SeqLockSnapshotPair | null = null;
  private readonly sampled: SampledSnapshot;
  private generation = 0;
  private buffered = 0;
  private sampledAt = -1;
  private sampledResult: SampledSnapshot | null = null;

  constructor(maxActors: number) {
    this.maxActors = maxActors;
    this.buffer = new Float32Array(snapshotFloatCount(maxActors));
    this.scratch = Array.from({ length: maxActors }, () => emptySlot());
    this.dirtyRows = new Uint32Array(Math.max(1, maxActors));
    this.sampled = {
      frameId: 0,
      tickIndex: 0,
      actors: this.scratch,
      actorCount: 0,
      full: true,
      dirtyRows: this.dirtyRows,
      dirtyCount: 0,
    };
  }

  get layoutGeneration(): number {
    return this.generation;
  }

  /**
   * Changes whenever the buffered snapshot or layout does, and only then: two
   * reads under one revision see the same sample.
   */
  get revision(): number {
    return this.buffered;
  }

  /** True when a cross-thread SharedArrayBuffer snapshot pair is attached. */
  get isShared(): boolean {
    return this.sharedPair !== null;
  }

  installLayout(
    capacity: number,
    generation: number,
    shared?: SharedSnapshotBuffers,
  ): boolean {
    const initialSharedAttach =
      Boolean(shared) && !this.sharedPair && generation === this.generation;
    if ((!initialSharedAttach && generation <= this.generation) || capacity < 1) {
      return false;
    }
    this.maxActors = capacity;
    this.generation = generation;
    this.buffer = new Float32Array(snapshotFloatCount(capacity));
    this.scratch = Array.from({ length: capacity }, () => emptySlot());
    this.dirtyRows = new Uint32Array(capacity);
    this.sharedPair = shared
      ? SeqLockSnapshotPair.fromSharedBuffers(capacity, shared)
      : null;
    this.sampled.actors = this.scratch;
    this.sampled.actorCount = 0;
    this.sampled.dirtyRows = this.dirtyRows;
    this.sampled.dirtyCount = 0;
    this.sampled.full = true;
    this.clear();
    return true;
  }

  /** True when the attached SAB has a newer published snapshot than the last polled one. */
  hasNewShared(): boolean {
    if (!this.sharedPair) return false;
    const serial = this.sharedPair.publishedSerial();
    return serial !== 0 && serial !== this.lastSerial;
  }

  /**
   * Poll the attached SAB snapshot pair directly into the local buffer (copying only
   * dirty rows on steady-state frames). Returns true when a newer snapshot was read.
   */
  pollShared(): boolean {
    if (!this.sharedPair) return false;
    const result = this.sharedPair.tryReadDirty(
      this.buffer,
      this.lastSerial,
      this.lastActorCount,
      this.dirtyRows,
    );
    if (!result || !result.changed) return false;
    const hadUnsampled = this.latest !== null && this.sampledAt !== this.buffered;
    this.latest = this.buffer;
    this.lastSerial = result.serial;
    this.lastActorCount = result.actorCount;
    if (result.full || hadUnsampled) {
      this.pendingFull = true;
      this.dirtyCount = 0;
    } else {
      this.pendingFull = false;
      this.dirtyCount = result.dirtyCount;
    }
    this.buffered++;
    return true;
  }

  /** Buffers `buffer` as the latest snapshot; false when it is ignored (unpublished, another layout, too large). */
  push(buffer: Float32Array): boolean {
    if (!isPublishedSnapshot(buffer)) return false;
    const header = readSnapshotHeader(buffer);
    if (header.layoutGeneration !== this.generation) return false;
    const dest = this.buffer;
    // Copy only the header and live rows; `sample` never reads past
    // `actorCount`, so a count the buffer cannot hold would expose stale rows.
    const span = snapshotActiveFloatCount(buffer);
    const minRowLength = SNAPSHOT_HEADER_FLOATS + header.actorCount * SNAPSHOT_ACTOR_STRIDE;
    if (span > dest.length || minRowLength > buffer.length) return false;

    const dirtyView = snapshotDirtyView(buffer, this.maxActors);
    const dirtyFlags = dirtyView ? dirtyView[1]! : 0;
    const serial = dirtyView ? dirtyView[0]! : 0;
    const serialDelta = (serial - this.lastSerial) >>> 0;
    const canIncremental =
      dirtyView !== null &&
      this.latest === dest &&
      this.sampledAt === this.buffered &&
      (dirtyFlags & SNAPSHOT_DIRTY_FLAG_TRACKED) !== 0 &&
      (dirtyFlags & SNAPSHOT_DIRTY_FLAG_FULL) === 0 &&
      this.lastSerial > 0 &&
      serialDelta >= 1 &&
      serialDelta <= 2 &&
      header.actorCount === this.lastActorCount;

    if (canIncremental) {
      dest.set(buffer.subarray(0, SNAPSHOT_HEADER_FLOATS));
      const words = snapshotDirtyBitsetWords(header.actorCount);
      let dirtyCount = 0;
      for (let w = 0; w < words; w++) {
        let bits = dirtyView[SNAPSHOT_DIRTY_META_WORDS + w]!;
        while (bits !== 0) {
          const lsb = bits & -bits;
          const bit = 31 - Math.clz32(lsb);
          const row = (w << 5) + bit;
          if (row < header.actorCount) {
            const offset = actorSlotOffset(row);
            dest.set(buffer.subarray(offset, offset + SNAPSHOT_ACTOR_STRIDE), offset);
            this.dirtyRows[dirtyCount++] = row;
          }
          bits ^= lsb;
        }
      }
      this.dirtyCount = dirtyCount;
      this.pendingFull = false;
    } else {
      dest.set(span === buffer.length ? buffer : buffer.subarray(0, span));
      this.dirtyCount = 0;
      this.pendingFull = true;
    }
    this.lastSerial = (dirtyFlags & SNAPSHOT_DIRTY_FLAG_TRACKED) !== 0 ? serial : 0;
    this.lastActorCount = header.actorCount;
    this.latest = dest;
    this.buffered++;
    return true;
  }

  /** Drop the buffered snapshot so the next sample is null until a fresh push. */
  clear(): void {
    this.latest = null;
    this.lastSerial = 0;
    this.lastActorCount = -1;
    this.pendingFull = true;
    this.dirtyCount = 0;
    this.buffered++;
  }

  /**
   * The buffered snapshot's frame id, or null when {@link sample} would return
   * null; reads the header field without decoding any row.
   */
  latestFrameId(): number | null {
    return this.latest ? snapshotFrameId(this.latest) : null;
  }

  /** The buffered snapshot's tick index, or null when unpublished. */
  latestTickIndex(): number | null {
    return this.latest ? snapshotTickIndex(this.latest) : null;
  }

  /**
   * Decode the buffered snapshot into the scratch rows. The buffer is private
   * (`push`/`pollShared` copy, `clear` and `installLayout` replace it) and the rows
   * are read-only to callers, so sampling again under the same {@link revision}
   * returns the same decoded result without decoding again.
   */
  sample(): SampledSnapshot | null {
    if (this.sampledAt === this.buffered) return this.sampledResult;
    this.sampledAt = this.buffered;
    if (!this.latest || !isPublishedSnapshot(this.latest)) return (this.sampledResult = null);
    const header = readSnapshotHeader(this.latest);
    const count = Math.min(header.actorCount, this.maxActors);
    if (!this.pendingFull) {
      const dirtyRows = this.dirtyRows;
      const dirtyCount = this.dirtyCount;
      for (let d = 0; d < dirtyCount; d++) {
        const row = dirtyRows[d]!;
        if (row < count) readActorSlotInto(this.latest, row, this.scratch[row]!);
      }
      this.sampled.full = false;
      this.sampled.dirtyRows = dirtyRows;
      this.sampled.dirtyCount = dirtyCount;
    } else {
      for (let i = 0; i < count; i++) {
        readActorSlotInto(this.latest, i, this.scratch[i]!);
      }
      this.sampled.full = true;
      this.sampled.dirtyRows = this.dirtyRows;
      this.sampled.dirtyCount = count;
    }
    this.sampled.frameId = header.frameId;
    this.sampled.tickIndex = header.tickIndex;
    this.sampled.actorCount = count;
    return (this.sampledResult = this.sampled);
  }
}

export type SampledAudioPose = {
  slotId: number;
  position: AudioPose;
};

type PoseSource = {
  slotId: number;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
};

function writePoseRow(out: SampledAudioPose[], index: number, actor: PoseSource): void {
  const row =
    out[index] ??
    (out[index] = {
      slotId: 0,
      position: { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
    });
  row.slotId = actor.slotId;
  const pose = row.position;
  pose.x = actor.position.x;
  pose.y = actor.position.y;
  pose.z = actor.position.z;
  pose.qx = actor.rotation.x;
  pose.qy = actor.rotation.y;
  pose.qz = actor.rotation.z;
  pose.qw = actor.rotation.w;
}

/**
 * Fill `out` with the poses of the `slots` that appear in the snapshot,
 * without allocating per actor. Audio reads only the actors that spatial
 * voices emit from, so the rest of the snapshot is left alone.
 *
 * `rows` is the caller's slot-to-row memo. A remembered row is trusted only
 * after its slot id is re-read, so a steady snapshot costs one lookup per slot;
 * when rows move (an earlier actor despawned) or a slot is missing, one scan of
 * the snapshot's slot ids resolves every slot and refreshes the memo. Slot ids
 * are unique within a snapshot.
 */
export function writeSampledAudioPoses(
  sampled: { actorCount: number; actors: ReadonlyArray<PoseSource> },
  out: SampledAudioPose[],
  slots: ReadonlySet<number>,
  rows: Map<number, number> = new Map(),
): number {
  const count = sampled.actorCount;
  const actors = sampled.actors;
  let written = 0;
  for (const slotId of slots) {
    const row = rows.get(slotId);
    const actor = row !== undefined && row < count ? actors[row] : undefined;
    if (!actor || actor.slotId !== slotId) {
      written = -1;
      break;
    }
    writePoseRow(out, written++, actor);
  }
  if (written < 0) {
    rows.clear();
    written = 0;
    for (let i = 0; i < count; i++) {
      const actor = actors[i]!;
      if (!slots.has(actor.slotId)) continue;
      rows.set(actor.slotId, i);
      writePoseRow(out, written++, actor);
    }
  }
  out.length = written;
  return written;
}
