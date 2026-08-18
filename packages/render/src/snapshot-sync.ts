import {
  isPublishedSnapshot,
  readActorSlot,
  readSnapshotHeader,
  snapshotFloatCount,
  type ActorSlot,
} from "@babylonslate/bridge";
import type { AudioPose } from "./audio-playback-backend";

export interface SampledSnapshot {
  frameId: number;
  tickIndex: number;
  actors: ActorSlot[];
  alpha: number;
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
 * Holds the two most recent snapshots and samples an interpolated view.
 * Reuses scratch ActorSlot objects — no per-actor allocation in sample().
 */
export class SnapshotInterpolator {
  private prev: Float32Array | null = null;
  private next: Float32Array | null = null;
  private write = 0;
  private readonly pair: [Float32Array, Float32Array];
  private readonly maxActors: number;
  private readonly scratch: ActorSlot[];
  private readonly prevIndexBySlot: Int32Array;
  private readonly sampled: SampledSnapshot;

  constructor(maxActors: number) {
    this.maxActors = maxActors;
    const floats = snapshotFloatCount(maxActors);
    this.pair = [new Float32Array(floats), new Float32Array(floats)];
    this.scratch = Array.from({ length: maxActors }, () => emptySlot());
    this.prevIndexBySlot = new Int32Array(maxActors);
    this.sampled = {
      frameId: 0,
      tickIndex: 0,
      actors: this.scratch,
      alpha: 1,
      actorCount: 0,
    };
  }

  push(buffer: Float32Array): void {
    if (!isPublishedSnapshot(buffer)) return;
    const dest = this.pair[this.write]!;
    if (buffer.length <= dest.length) {
      dest.set(buffer);
    } else {
      for (let i = 0; i < dest.length; i++) dest[i] = buffer[i]!;
    }
    this.prev = this.next;
    this.next = dest;
    this.write = 1 - this.write;
  }

  sample(alpha: number): SampledSnapshot | null {
    if (!this.next || !isPublishedSnapshot(this.next)) return null;
    const t = Math.min(1, Math.max(0, alpha));
    const nextHeader = readSnapshotHeader(this.next);
    if (!this.prev || t >= 1 || !isPublishedSnapshot(this.prev)) {
      const count = Math.min(nextHeader.actorCount, this.maxActors);
      for (let i = 0; i < count; i++) {
        copySlot(readActorSlot(this.next, i), this.scratch[i]!);
      }
      this.sampled.frameId = nextHeader.frameId;
      this.sampled.tickIndex = nextHeader.tickIndex;
      this.sampled.alpha = 1;
      this.sampled.actorCount = count;
      return this.sampled;
    }
    const prevHeader = readSnapshotHeader(this.prev);
    const prevCount = Math.min(prevHeader.actorCount, this.maxActors);
    const count = Math.min(nextHeader.actorCount, this.maxActors);
    this.prevIndexBySlot.fill(-1);
    for (let i = 0; i < prevCount; i++) {
      const slotId = readActorSlot(this.prev, i).slotId;
      if (slotId >= 0 && slotId < this.maxActors) {
        this.prevIndexBySlot[slotId] = i;
      }
    }
    for (let i = 0; i < count; i++) {
      const b = readActorSlot(this.next, i);
      const out = this.scratch[i]!;
      const prevIndex =
        b.slotId >= 0 && b.slotId < this.maxActors
          ? this.prevIndexBySlot[b.slotId]
          : -1;
      if (prevIndex === undefined || prevIndex < 0) {
        copySlot(b, out);
        continue;
      }
      const a = readActorSlot(this.prev, prevIndex);
      out.slotId = b.slotId;
      out.position.x = a.position.x + (b.position.x - a.position.x) * t;
      out.position.y = a.position.y + (b.position.y - a.position.y) * t;
      out.position.z = a.position.z + (b.position.z - a.position.z) * t;
      interpolateQuaternion(a, b, t, out);
      out.scale.x = a.scale.x + (b.scale.x - a.scale.x) * t;
      out.scale.y = a.scale.y + (b.scale.y - a.scale.y) * t;
      out.scale.z = a.scale.z + (b.scale.z - a.scale.z) * t;
      out.flags = b.flags;
    }
    this.sampled.frameId = nextHeader.frameId;
    this.sampled.tickIndex = nextHeader.tickIndex;
    this.sampled.alpha = t;
    this.sampled.actorCount = count;
    return this.sampled;
  }
}

function interpolateQuaternion(
  a: ActorSlot,
  b: ActorSlot,
  t: number,
  out: ActorSlot,
): void {
  const dot =
    a.rotation.x * b.rotation.x +
    a.rotation.y * b.rotation.y +
    a.rotation.z * b.rotation.z +
    a.rotation.w * b.rotation.w;
  const sign = dot < 0 ? -1 : 1;
  const x = a.rotation.x + (b.rotation.x * sign - a.rotation.x) * t;
  const y = a.rotation.y + (b.rotation.y * sign - a.rotation.y) * t;
  const z = a.rotation.z + (b.rotation.z * sign - a.rotation.z) * t;
  const w = a.rotation.w + (b.rotation.w * sign - a.rotation.w) * t;
  const length = Math.hypot(x, y, z, w);
  if (length <= Number.EPSILON) {
    out.rotation.x = 0;
    out.rotation.y = 0;
    out.rotation.z = 0;
    out.rotation.w = 1;
    return;
  }
  out.rotation.x = x / length;
  out.rotation.y = y / length;
  out.rotation.z = z / length;
  out.rotation.w = w / length;
}

function copySlot(src: ActorSlot, dst: ActorSlot): void {
  dst.slotId = src.slotId;
  dst.position.x = src.position.x;
  dst.position.y = src.position.y;
  dst.position.z = src.position.z;
  dst.rotation.x = src.rotation.x;
  dst.rotation.y = src.rotation.y;
  dst.rotation.z = src.rotation.z;
  dst.rotation.w = src.rotation.w;
  dst.scale.x = src.scale.x;
  dst.scale.y = src.scale.y;
  dst.scale.z = src.scale.z;
  dst.flags = src.flags;
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
