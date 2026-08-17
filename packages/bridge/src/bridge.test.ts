import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_ACTOR_STRIDE,
  SNAPSHOT_HEADER_FLOATS,
  SNAPSHOT_LAYOUT_VERSION,
  SNAPSHOT_MAGIC_F32,
  SNAPSHOT_MAGIC_U32,
  actorSlotOffset,
  floatBitsToU32,
  snapshotFloatCount,
  u32ToFloatBits,
} from "./layout";
import {
  isPublishedSnapshot,
  readActorSlot,
  readSnapshotHeader,
  writeActorSlot,
  writeSnapshotHeader,
  type ActorSlot,
} from "./snapshot-buffer";
import { SeqLockSnapshotPair } from "./seq-lock";
import { TransferablePingPong } from "./transferable";
import { createRpcHost, type RpcResponse, type RpcTransport } from "./rpc";

describe("snapshot layout", () => {
  it("uses the locked header and stride sizes from bridge.md", () => {
    expect(SNAPSHOT_HEADER_FLOATS).toBe(16);
    expect(SNAPSHOT_ACTOR_STRIDE).toBe(16);
    expect(SNAPSHOT_LAYOUT_VERSION).toBe(1);
    expect(actorSlotOffset(0)).toBe(16);
    expect(actorSlotOffset(2)).toBe(48);
    expect(snapshotFloatCount(8)).toBe(16 + 8 * 16);
  });

  it("round-trips u32 identity through float bit packing", () => {
    expect(floatBitsToU32(u32ToFloatBits(SNAPSHOT_MAGIC_U32))).toBe(
      SNAPSHOT_MAGIC_U32,
    );
    expect(floatBitsToU32(u32ToFloatBits(0))).toBe(0);
    expect(floatBitsToU32(u32ToFloatBits(0xffffffff))).toBe(0xffffffff);
    expect(floatBitsToU32(SNAPSHOT_MAGIC_F32)).toBe(SNAPSHOT_MAGIC_U32);
  });

  it("round-trips header and actor slots in a Float32Array", () => {
    const buf = new Float32Array(snapshotFloatCount(2));
    writeSnapshotHeader(buf, {
      frameId: 10,
      tickIndex: 9,
      actorCount: 2,
      scriptMs: 1.5,
      physicsMs: 0.25,
      seq: 4,
    });
    const actor: ActorSlot = {
      slotId: 1,
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: 1,
    };
    writeActorSlot(buf, 0, actor);
    writeActorSlot(buf, 1, {
      ...actor,
      slotId: 2,
      position: { x: 4, y: 5, z: 6 },
    });

    const header = readSnapshotHeader(buf);
    expect(header.magic).toBe(SNAPSHOT_MAGIC_F32);
    expect(header.version).toBe(SNAPSHOT_LAYOUT_VERSION);
    expect(header.frameId).toBe(10);
    expect(header.tickIndex).toBe(9);
    expect(header.actorCount).toBe(2);
    expect(header.scriptMs).toBeCloseTo(1.5);
    expect(header.physicsMs).toBeCloseTo(0.25);
    expect(readActorSlot(buf, 1).position).toEqual({ x: 4, y: 5, z: 6 });
  });

  it("treats only magic+version headers as published snapshots", () => {
    const empty = new Float32Array(snapshotFloatCount(1));
    expect(isPublishedSnapshot(empty)).toBe(false);
    writeSnapshotHeader(empty, {
      frameId: 1,
      tickIndex: 1,
      actorCount: 0,
      scriptMs: 0,
      physicsMs: 0,
    });
    expect(isPublishedSnapshot(empty)).toBe(true);
  });
});

describe("SAB seq-lock transport", () => {
  it("does not treat an unpublished zeroed buffer as a snapshot", () => {
    const pair = SeqLockSnapshotPair.create(4);
    const copy = new Float32Array(pair.floatCount);
    expect(pair.tryRead(copy)).toBe(false);
  });

  it("publishes a stable snapshot the reader can copy", () => {
    const pair = SeqLockSnapshotPair.create(4);
    const writer = pair.writerBuffer();
    pair.beginWrite();
    writeSnapshotHeader(writer, {
      frameId: 1,
      tickIndex: 1,
      actorCount: 1,
      scriptMs: 0.1,
      physicsMs: 0,
    });
    writeActorSlot(writer, 0, {
      slotId: 0,
      position: { x: 9, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: 1,
    });
    pair.publish();

    const copy = new Float32Array(writer.length);
    const ok = pair.tryRead(copy);
    expect(ok).toBe(true);
    expect(readSnapshotHeader(copy).frameId).toBe(1);
    expect(readActorSlot(copy, 0).position.x).toBe(9);
  });
});

describe("transferable ping-pong", () => {
  it("hands ownership of the written buffer to the reader", () => {
    const ping = new TransferablePingPong(2);
    const writeBuf = ping.beginWrite();
    writeSnapshotHeader(writeBuf, {
      frameId: 3,
      tickIndex: 2,
      actorCount: 0,
      scriptMs: 0,
      physicsMs: 0,
      seq: 0,
    });
    const transferred = ping.commitWrite();
    expect(transferred.byteLength).toBe(writeBuf.byteLength);
    const view = new Float32Array(transferred);
    expect(readSnapshotHeader(view).frameId).toBe(3);
    ping.recycle(transferred);
    const next = ping.beginWrite();
    expect(next.length).toBe(writeBuf.length);
  });

  it("recycles a cancelled write instead of leaking the buffer", () => {
    const ping = new TransferablePingPong(2);
    // Drain and return the initial free pool (2 buffers).
    const bufA = ping.beginWrite();
    const abA = ping.commitWrite();
    const bufB = ping.beginWrite();
    const abB = ping.commitWrite();
    expect(bufA.length).toBe(bufB.length);
    ping.recycle(abA);
    ping.recycle(abB);

    // A write that discovers there is nothing to send this frame must give
    // its buffer back rather than leaking it — otherwise the free pool
    // drains to zero and every later frame pays a fresh allocation.
    const scratchBuffer = ping.beginWrite().buffer;
    ping.cancelWrite();
    const reused = ping.beginWrite();
    expect(reused.buffer).toBe(scratchBuffer);
  });
});

describe("typed RPC", () => {
  it("round-trips a request and response over a fake transport", async () => {
    const pending: Array<{
      data: unknown;
      reply: (v: RpcResponse) => void;
    }> = [];
    const transport: RpcTransport = {
      post(message) {
        return new Promise((resolve) => {
          pending.push({ data: message, reply: resolve });
        });
      },
    };
    const host = createRpcHost(transport);
    const callPromise = host.call<{ n: number }, { doubled: number }>("double", {
      n: 21,
    });
    expect(pending).toHaveLength(1);
    const req = pending[0]!.data as {
      id: number;
      method: string;
      params: { n: number };
    };
    expect(req.method).toBe("double");
    pending[0]!.reply({ id: req.id, result: { doubled: req.params.n * 2 } });
    await expect(callPromise).resolves.toEqual({ doubled: 42 });
  });
});
