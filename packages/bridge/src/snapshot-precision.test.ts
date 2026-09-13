import { describe, expect, it } from "vitest";
import { snapshotFloatCount } from "./layout";
import {
  readActorSlot,
  readSnapshotHeader,
  writeActorSlot,
  writeSnapshotHeader,
} from "./snapshot-buffer";

describe("large-coordinate snapshot transport", () => {
  it("preserves sub-unit positions with atomic origin metadata and unchanged buffer size", () => {
    const buffer = new Float32Array(snapshotFloatCount(1));
    const origin = { x: 1_000_000_000, y: 0, z: -1_000_000_000 };
    const actor = {
      slotId: 0,
      position: { x: origin.x + 0.125, y: 1.5, z: origin.z - 0.375 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: 1,
    };
    writeActorSlot(buffer, 0, actor, origin);
    writeSnapshotHeader(buffer, {
      frameId: 1,
      tickIndex: 1,
      actorCount: 1,
      scriptMs: 0,
      physicsMs: 0,
      origin,
      originGeneration: 3,
    });
    const copied = new Float32Array(buffer);
    expect(readActorSlot(copied, 0).position).toEqual(actor.position);
    expect(readSnapshotHeader(copied)).toMatchObject({
      origin,
      originGeneration: 3,
    });
    writeActorSlot(buffer, 0, actor);
    writeSnapshotHeader(buffer, {
      frameId: 2,
      tickIndex: 2,
      actorCount: 1,
      scriptMs: 0,
      physicsMs: 0,
    });
    expect(readActorSlot(buffer, 0).position).toEqual(actor.position);
  });
});
