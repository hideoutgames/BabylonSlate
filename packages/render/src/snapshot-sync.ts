import {
  readActorSlot,
  readSnapshotHeader,
  type ActorSlot,
} from "@babylonslate/bridge";

export interface SampledSnapshot {
  frameId: number;
  tickIndex: number;
  actors: ActorSlot[];
  alpha: number;
}

/**
 * Holds the two most recent snapshots and samples an interpolated view.
 * Pure Float32Array math — mesh writes happen in applySnapshotToScene.
 */
export class SnapshotInterpolator {
  private prev: Float32Array | null = null;
  private next: Float32Array | null = null;
  private readonly maxActors: number;

  constructor(maxActors: number) {
    this.maxActors = maxActors;
  }

  push(buffer: Float32Array): void {
    if (!this.next) {
      this.next = buffer.slice();
      return;
    }
    this.prev = this.next;
    this.next = buffer.slice();
  }

  sample(alpha: number): SampledSnapshot | null {
    if (!this.next) return null;
    const t = Math.min(1, Math.max(0, alpha));
    const nextHeader = readSnapshotHeader(this.next);
    if (!this.prev || t >= 1) {
      return {
        frameId: nextHeader.frameId,
        tickIndex: nextHeader.tickIndex,
        actors: readActors(this.next, nextHeader.actorCount),
        alpha: 1,
      };
    }
    const prevHeader = readSnapshotHeader(this.prev);
    const count = Math.min(
      prevHeader.actorCount,
      nextHeader.actorCount,
      this.maxActors,
    );
    const actors: ActorSlot[] = [];
    for (let i = 0; i < count; i++) {
      const a = readActorSlot(this.prev, i);
      const b = readActorSlot(this.next, i);
      actors.push({
        slotId: b.slotId,
        position: {
          x: a.position.x + (b.position.x - a.position.x) * t,
          y: a.position.y + (b.position.y - a.position.y) * t,
          z: a.position.z + (b.position.z - a.position.z) * t,
        },
        rotation: {
          x: a.rotation.x + (b.rotation.x - a.rotation.x) * t,
          y: a.rotation.y + (b.rotation.y - a.rotation.y) * t,
          z: a.rotation.z + (b.rotation.z - a.rotation.z) * t,
          w: a.rotation.w + (b.rotation.w - a.rotation.w) * t,
        },
        scale: {
          x: a.scale.x + (b.scale.x - a.scale.x) * t,
          y: a.scale.y + (b.scale.y - a.scale.y) * t,
          z: a.scale.z + (b.scale.z - a.scale.z) * t,
        },
        flags: b.flags,
      });
    }
    return {
      frameId: nextHeader.frameId,
      tickIndex: nextHeader.tickIndex,
      actors,
      alpha: t,
    };
  }
}

function readActors(buf: Float32Array, count: number): ActorSlot[] {
  const actors: ActorSlot[] = [];
  for (let i = 0; i < count; i++) {
    actors.push(readActorSlot(buf, i));
  }
  return actors;
}
