import {
  isPublishedSnapshot,
  readActorSlot,
  readSnapshotHeader,
  type ActorSlot,
} from "@babylonslate/bridge";

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
  private readonly maxActors: number;
  private readonly scratch: ActorSlot[];
  private readonly sampled: SampledSnapshot;

  constructor(maxActors: number) {
    this.maxActors = maxActors;
    this.scratch = Array.from({ length: maxActors }, () => emptySlot());
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
    if (!this.next) {
      this.next = buffer.slice();
      return;
    }
    this.prev = this.next;
    this.next = buffer.slice();
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
    const count = Math.min(
      prevHeader.actorCount,
      nextHeader.actorCount,
      this.maxActors,
    );
    for (let i = 0; i < count; i++) {
      const a = readActorSlot(this.prev, i);
      const b = readActorSlot(this.next, i);
      const out = this.scratch[i]!;
      out.slotId = b.slotId;
      out.position.x = a.position.x + (b.position.x - a.position.x) * t;
      out.position.y = a.position.y + (b.position.y - a.position.y) * t;
      out.position.z = a.position.z + (b.position.z - a.position.z) * t;
      out.rotation.x = a.rotation.x + (b.rotation.x - a.rotation.x) * t;
      out.rotation.y = a.rotation.y + (b.rotation.y - a.rotation.y) * t;
      out.rotation.z = a.rotation.z + (b.rotation.z - a.rotation.z) * t;
      out.rotation.w = a.rotation.w + (b.rotation.w - a.rotation.w) * t;
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
