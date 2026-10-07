import { expect, it } from "vitest";
import {
  snapshotFloatCount,
  writeActorSlot,
  writeSnapshotHeader,
} from "@babylonslate/bridge";
import { SnapshotInterpolator } from "./snapshot-sync";

it("interpolates world positions continuously across a camera-origin change", () => {
  const interpolator = new SnapshotInterpolator(1);
  for (const [frame, x, origin] of [
    [1, 1_000_000_000.125, 999_999_488],
    [2, 1_000_000_000.375, 1_000_000_512],
  ]) {
    const buffer = new Float32Array(snapshotFloatCount(1));
    const anchor = { x: origin!, y: 0, z: 0 };
    writeActorSlot(
      buffer,
      0,
      {
        slotId: 0,
        position: { x: x!, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
        flags: 1,
      },
      anchor,
    );
    writeSnapshotHeader(buffer, {
      frameId: frame!,
      tickIndex: frame!,
      actorCount: 1,
      scriptMs: 0,
      physicsMs: 0,
      origin: anchor,
      originGeneration: frame,
    });
    interpolator.push(buffer);
  }
  expect(interpolator.sample(0.5)?.actors[0]?.position.x).toBe(
    1_000_000_000.25,
  );
});

it("waits for authoritative edit publications then resumes interpolation after teleports", () => {
  const interpolator = new SnapshotInterpolator(2);
  const push = (frameId: number, x: number) => {
    const buffer = new Float32Array(snapshotFloatCount(2));
    for (let slotId = 0; slotId < 2; slotId++) writeActorSlot(buffer, slotId, {
      slotId, position: { x: x + slotId * 2, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 }, flags: 1,
    });
    writeSnapshotHeader(buffer, { frameId, tickIndex: 10, actorCount: 2, scriptMs: 0, physicsMs: 0 });
    interpolator.push(buffer);
  };
  push(1, 0);
  push(2, 2);
  interpolator.resetInterpolationFrom(3);
  interpolator.resetInterpolationFrom(4);
  expect(interpolator.sample(0.5)?.actors[0]?.position.x).toBe(1);
  push(3, 100);
  expect(interpolator.sample(0.5)?.actors.map((actor) => actor.position.x)).toEqual([100, 102]);
  push(4, 200);
  expect(interpolator.sample(0.5)?.actors[0]?.position.x).toBe(200);
  push(5, 202);
  expect(interpolator.sample(0.5)?.actors[0]?.position.x).toBe(201);
  expect(interpolator.sample(0.5)?.tickIndex).toBe(10);
});
