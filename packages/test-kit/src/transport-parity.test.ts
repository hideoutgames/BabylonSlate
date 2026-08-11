import { describe, expect, it } from "vitest";
import {
  SeqLockSnapshotPair,
  TransferablePingPong,
  readActorSlot,
  readSnapshotHeader,
  snapshotFloatCount,
  writeActorSlot,
  writeSnapshotHeader,
} from "@babylonslate/bridge";
import { createInProcessRuntime } from "@babylonslate/runtime";

/**
 * P4 acceptance: same scenario identical in-process, over SAB seq-lock, and
 * over transferable ping-pong (actor transforms after N ticks).
 */
describe("multi-transport scenario parity", () => {
  it("matches SAB and transferable snapshot payloads to in-process", () => {
    const inProcess = runAndCapture();
    const viaSab = publishViaSab(inProcess.buffer);
    const viaTransfer = publishViaTransferable(inProcess.buffer);

    expect(readSnapshotHeader(viaSab).actorCount).toBe(
      readSnapshotHeader(inProcess.buffer).actorCount,
    );
    expect(readSnapshotHeader(viaTransfer).tickIndex).toBe(
      readSnapshotHeader(inProcess.buffer).tickIndex,
    );
    const count = readSnapshotHeader(inProcess.buffer).actorCount;
    for (let i = 0; i < count; i++) {
      expect(readActorSlot(viaSab, i).position).toEqual(
        readActorSlot(inProcess.buffer, i).position,
      );
      expect(readActorSlot(viaTransfer, i).position).toEqual(
        readActorSlot(inProcess.buffer, i).position,
      );
    }
  });

  it("two independent runs with the same seed match", () => {
    const a = runAndCapture().fingerprint;
    const b = runAndCapture().fingerprint;
    expect(a).toBe(b);
  });
});

function runAndCapture(): { buffer: Float32Array; fingerprint: string } {
  const runtime = createInProcessRuntime({ seed: 99, maxActors: 16, dt: 1 / 60 });
  runtime.start();
  for (let i = 0; i < 24; i++) {
    runtime.tick();
  }
  const buffer = new Float32Array(snapshotFloatCount(16));
  expect(runtime.copySnapshot(buffer)).toBe(true);
  runtime.stop();
  const header = readSnapshotHeader(buffer);
  const parts = [`t${header.tickIndex}`, `n${header.actorCount}`];
  for (let i = 0; i < header.actorCount; i++) {
    const a = readActorSlot(buffer, i);
    parts.push(
      `${a.slotId}:${a.position.x.toFixed(5)},${a.position.y.toFixed(5)},${a.position.z.toFixed(5)}`,
    );
  }
  return { buffer, fingerprint: parts.join("|") };
}

function publishViaSab(source: Float32Array): Float32Array {
  const pair = SeqLockSnapshotPair.create(16);
  const writer = pair.beginWrite();
  writer.set(source);
  writeSnapshotHeader(writer, {
    frameId: readSnapshotHeader(source).frameId,
    tickIndex: readSnapshotHeader(source).tickIndex,
    actorCount: readSnapshotHeader(source).actorCount,
    scriptMs: readSnapshotHeader(source).scriptMs,
    physicsMs: readSnapshotHeader(source).physicsMs,
  });
  for (let i = 0; i < readSnapshotHeader(source).actorCount; i++) {
    writeActorSlot(writer, i, readActorSlot(source, i));
  }
  pair.publish();
  const out = new Float32Array(source.length);
  expect(pair.tryRead(out)).toBe(true);
  return out;
}

function publishViaTransferable(source: Float32Array): Float32Array {
  const ping = new TransferablePingPong(16);
  const writer = ping.beginWrite();
  writeSnapshotHeader(writer, {
    frameId: readSnapshotHeader(source).frameId,
    tickIndex: readSnapshotHeader(source).tickIndex,
    actorCount: readSnapshotHeader(source).actorCount,
    scriptMs: readSnapshotHeader(source).scriptMs,
    physicsMs: readSnapshotHeader(source).physicsMs,
  });
  for (let i = 0; i < readSnapshotHeader(source).actorCount; i++) {
    writeActorSlot(writer, i, readActorSlot(source, i));
  }
  const ab = ping.commitWrite();
  return new Float32Array(ab);
}
