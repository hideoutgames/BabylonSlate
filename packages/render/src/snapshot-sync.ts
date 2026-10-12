import {
  isPublishedSnapshot,
  readActorSlotInto,
  readSnapshotHeader,
  snapshotActiveFloatCount,
  snapshotFloatCount,
  type ActorSlot,
} from "@babylonslate/bridge";
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
  }

  /** Drop the buffered snapshot so the next sample is null until a fresh push. */
  clear(): void {
    this.latest = null;
  }

  sample(): SampledSnapshot | null {
    if (!this.latest || !isPublishedSnapshot(this.latest)) return null;
    const header = readSnapshotHeader(this.latest);
    const count = Math.min(header.actorCount, this.maxActors);
    for (let i = 0; i < count; i++) {
      readActorSlotInto(this.latest, i, this.scratch[i]!);
    }
    this.sampled.frameId = header.frameId;
    this.sampled.tickIndex = header.tickIndex;
    this.sampled.actorCount = count;
    return this.sampled;
  }
}

export type SampledAudioPose = {
  slotId: number;
  position: AudioPose;
};

/** Fill `out` with snapshot actor poses without allocating per actor. */
export function writeSampledAudioPoses(
  sampled: {
    actorCount: number;
    actors: ReadonlyArray<{
      slotId: number;
      position: { x: number; y: number; z: number };
      rotation: { x: number; y: number; z: number; w: number };
    }>;
  },
  out: SampledAudioPose[],
): number {
  const count = sampled.actorCount;
  for (let i = 0; i < count; i++) {
    const actor = sampled.actors[i]!;
    const row =
      out[i] ??
      (out[i] = {
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
  out.length = count;
  return count;
}
