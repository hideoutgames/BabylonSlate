import {
  isPublishedSnapshot,
  readActorSlotInto,
  readSnapshotHeader,
  snapshotActiveFloatCount,
  snapshotFloatCount,
  type ActorSlot,
} from "@haptic/bridge";
import type { AudioPose } from "./audio-playback-backend";

export interface SampledSnapshot {
  frameId: number;
  tickIndex: number;
  actors: ActorSlot[];
  actorCount: number;
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
  private readonly sampled: SampledSnapshot;
  private generation = 0;
  private buffered = 0;
  private sampledAt = -1;
  private sampledResult: SampledSnapshot | null = null;

  constructor(maxActors: number) {
    this.maxActors = maxActors;
    this.buffer = new Float32Array(snapshotFloatCount(maxActors));
    this.scratch = Array.from({ length: maxActors }, () => emptySlot());
    this.sampled = {
      frameId: 0,
      tickIndex: 0,
      actors: this.scratch,
      actorCount: 0,
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

  installLayout(capacity: number, generation: number): boolean {
    if (generation <= this.generation || capacity < 1) return false;
    this.maxActors = capacity;
    this.generation = generation;
    this.buffer = new Float32Array(snapshotFloatCount(capacity));
    this.scratch = Array.from({ length: capacity }, () => emptySlot());
    this.sampled.actors = this.scratch;
    this.sampled.actorCount = 0;
    this.clear();
    return true;
  }

  push(buffer: Float32Array): void {
    if (!isPublishedSnapshot(buffer)) return;
    const header = readSnapshotHeader(buffer);
    if (header.layoutGeneration !== this.generation) return;
    const dest = this.buffer;
    // Copy only the header and live rows; `sample` never reads past
    // `actorCount`, so a count the buffer cannot hold would expose stale rows.
    const span = snapshotActiveFloatCount(buffer);
    if (span > dest.length || snapshotFloatCount(header.actorCount) > buffer.length) return;
    dest.set(span === buffer.length ? buffer : buffer.subarray(0, span));
    this.latest = dest;
    this.buffered++;
  }

  /** Drop the buffered snapshot so the next sample is null until a fresh push. */
  clear(): void {
    this.latest = null;
    this.buffered++;
  }

  /**
   * Decode the buffered snapshot into the scratch rows. The buffer is private
   * (`push` copies, `clear` and `installLayout` replace it) and the rows are
   * read-only to callers, so sampling again under the same {@link revision}
   * returns the same decoded result without decoding again.
   */
  sample(): SampledSnapshot | null {
    if (this.sampledAt === this.buffered) return this.sampledResult;
    this.sampledAt = this.buffered;
    if (!this.latest || !isPublishedSnapshot(this.latest)) return (this.sampledResult = null);
    const header = readSnapshotHeader(this.latest);
    const count = Math.min(header.actorCount, this.maxActors);
    for (let i = 0; i < count; i++) {
      readActorSlotInto(this.latest, i, this.scratch[i]!);
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
