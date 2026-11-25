import { describe, expect, it, vi } from "vitest";
import {
  SNAPSHOT_ACTOR_STRIDE,
  SNAPSHOT_DIRTY_FLAG_FULL,
  SNAPSHOT_DIRTY_FLAG_TRACKED,
  SNAPSHOT_LAYOUT_VERSION,
  SNAPSHOT_MAGIC_F32,
  SNAPSHOT_MAGIC_U32,
  floatBitsToU32,
  snapshotFloatCount,
  u32ToFloatBits,
} from "./layout";
import {
  applySnapshotTick,
  isPublishedSnapshot,
  markSnapshotDirtyRow,
  playInputStampTick,
  readSnapshotHeader,
  snapshotTickIndex,
  writeActorSlot,
  writeSnapshotDirtyMeta,
  writeSnapshotHeader,
  SNAPSHOT_FLAG_OVERLAY,
  SNAPSHOT_FLAG_VISIBLE,
  type ActorSlot,
} from "./snapshot-buffer";
import { readActorSlot } from "./test-support/read-actor-slot";
import type { CommandMessage } from "./channels";
import { dispatchCommandBatch } from "./command-batch";
import { SeqLockSnapshotPair } from "./seq-lock";
import { TransferablePingPong } from "./transferable";

describe("snapshot layout", () => {
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
    expect(snapshotTickIndex(buf)).toBe(9);
  });

  it("stores SceneLayer overlay identity on flags bit 1 without changing stride", () => {
    const buf = new Float32Array(snapshotFloatCount(1));
    writeSnapshotHeader(buf, {
      frameId: 1,
      tickIndex: 1,
      actorCount: 1,
      scriptMs: 0,
      physicsMs: 0,
    });
    writeActorSlot(buf, 0, {
      slotId: 4,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: SNAPSHOT_FLAG_VISIBLE | SNAPSHOT_FLAG_OVERLAY,
    });
    const slot = readActorSlot(buf, 0);
    expect(SNAPSHOT_ACTOR_STRIDE).toBe(16);
    expect(slot.flags & SNAPSHOT_FLAG_VISIBLE).toBe(SNAPSHOT_FLAG_VISIBLE);
    expect(slot.flags & SNAPSHOT_FLAG_OVERLAY).toBe(SNAPSHOT_FLAG_OVERLAY);
  });

  it("returns null snapshotTickIndex for unpublished buffers", () => {
    expect(snapshotTickIndex(new Float32Array(snapshotFloatCount(1)))).toBeNull();
  });

  it("stamps worker input from snapshot tickIndex when stats are sparse", () => {
    const unpublished = new Float32Array(snapshotFloatCount(1));
    expect(applySnapshotTick(4, unpublished)).toBe(4);
    const published = new Float32Array(snapshotFloatCount(1));
    writeSnapshotHeader(published, {
      frameId: 9,
      tickIndex: 12,
      actorCount: 0,
      scriptMs: 1,
      physicsMs: 2,
    });
    expect(applySnapshotTick(4, published)).toBe(12);
  });

  it("stamps Play input from the in-process World tick when present", () => {
    expect(playInputStampTick(3, 99)).toBe(3);
  });

  it("stamps worker Play input from the last snapshot tick instead of a wall-clock index", () => {
    expect(playInputStampTick(undefined, 0)).toBe(0);
    expect(playInputStampTick(undefined, 12)).toBe(12);
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

  it("delivers every live row of a sparse large-capacity snapshot after a larger frame", () => {
    const pair = SeqLockSnapshotPair.create(64);
    const row = (slotId: number, x: number): ActorSlot => ({
      slotId,
      position: { x, y: x + 0.5, z: -x },
      rotation: { x: 0.5, y: -0.5, z: 0.5, w: 0.5 },
      scale: { x: 2, y: 3, z: 4 },
      flags: SNAPSHOT_FLAG_VISIBLE,
    });
    const publish = (frameId: number, rows: ActorSlot[]) => {
      const writer = pair.beginWrite();
      rows.forEach((slot, index) => writeActorSlot(writer, index, slot));
      writeSnapshotHeader(writer, { frameId, tickIndex: frameId, actorCount: rows.length, scriptMs: 0, physicsMs: 0 });
      pair.publish();
    };
    const copy = new Float32Array(pair.floatCount);
    publish(1, [row(7, 1), row(8, 2), row(9, 3), row(10, 4)]);
    expect(pair.tryRead(copy)).toBe(true);
    publish(2, [row(40, 5)]);
    publish(3, [row(41, 6), row(63, 7)]);

    expect(pair.tryRead(copy)).toBe(true);
    expect(readSnapshotHeader(copy)).toMatchObject({ frameId: 3, actorCount: 2 });
    expect(readActorSlot(copy, 0)).toEqual(row(41, 6));
    expect(readActorSlot(copy, 1)).toEqual(row(63, 7));
  });

  it("reads only dirty rows via tryReadDirty across shared buffers and falls back to full when flagged or skipped", () => {
    const capacity = 128;
    const writer = SeqLockSnapshotPair.create(capacity);
    const shared = writer.sharedBuffers();
    expect(shared).not.toBeNull();
    const reader = SeqLockSnapshotPair.fromSharedBuffers(capacity, shared!);
    const row = (slotId: number, x: number): ActorSlot => ({
      slotId,
      position: { x, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: SNAPSHOT_FLAG_VISIBLE,
    });
    // Publish frame 1 (full initial population of 100 actors into both buffers).
    for (let pass = 1; pass <= 2; pass++) {
      const buf = writer.beginWrite();
      for (let i = 0; i < 100; i++) writeActorSlot(buf, i, row(i, i));
      writeSnapshotHeader(buf, { frameId: pass, tickIndex: pass, actorCount: 100, scriptMs: 0, physicsMs: 0 });
      writeSnapshotDirtyMeta(writer.writerDirtyView()!, pass, SNAPSHOT_DIRTY_FLAG_TRACKED | SNAPSHOT_DIRTY_FLAG_FULL, 100, false);
      writer.publish();
    }
    const out = new Float32Array(writer.floatCount);
    const dirtyRows = new Uint32Array(capacity);
    const first = reader.tryReadDirty(out, 0, -1, dirtyRows)!;
    expect(first).toMatchObject({ changed: true, full: true, serial: 2, actorCount: 100 });
    expect(readActorSlot(out, 42).position.x).toBe(42);

    // Unchanged serial returns changed: false with zero work.
    const unchanged = reader.tryReadDirty(out, first.serial, first.actorCount, dirtyRows)!;
    expect(unchanged.changed).toBe(false);

    // Publish frame 3 moving only rows 3, 42, and 99.
    const buf3 = writer.beginWrite();
    const dirtyView3 = writer.writerDirtyView()!;
    writeSnapshotDirtyMeta(dirtyView3, 3, SNAPSHOT_DIRTY_FLAG_TRACKED, 100, true);
    for (const r of [3, 42, 99]) {
      writeActorSlot(buf3, r, row(r, r + 500));
      markSnapshotDirtyRow(dirtyView3, r);
    }
    writeSnapshotHeader(buf3, { frameId: 3, tickIndex: 3, actorCount: 100, scriptMs: 0, physicsMs: 0 });
    writer.publish();

    const inc = reader.tryReadDirty(out, first.serial, first.actorCount, dirtyRows)!;
    expect(inc).toMatchObject({ changed: true, full: false, dirtyCount: 3, serial: 3, actorCount: 100 });
    expect(Array.from(dirtyRows.subarray(0, inc.dirtyCount))).toEqual([3, 42, 99]);
    expect(readActorSlot(out, 3).position.x).toBe(503);
    expect(readActorSlot(out, 42).position.x).toBe(542);
    expect(readActorSlot(out, 99).position.x).toBe(599);
    // Untouched rows remain intact in `out`.
    expect(readActorSlot(out, 50).position.x).toBe(50);

    // Skipping >2 publishes forces full fallback automatically.
    for (let pass = 4; pass <= 6; pass++) {
      const buf = writer.beginWrite();
      writeSnapshotDirtyMeta(writer.writerDirtyView()!, pass, SNAPSHOT_DIRTY_FLAG_TRACKED, 100, true);
      writeSnapshotHeader(buf, { frameId: pass, tickIndex: pass, actorCount: 100, scriptMs: 0, physicsMs: 0 });
      writer.publish();
    }
    const skipped = reader.tryReadDirty(out, inc.serial, inc.actorCount, dirtyRows)!;
    expect(skipped).toMatchObject({ changed: true, full: true, serial: 6, actorCount: 100 });
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

  it("keeps only a small spare pool after a burst of returned buffers", () => {
    const ping = new TransferablePingPong(2);
    const burst = Array.from({ length: 8 }, () => {
      ping.beginWrite();
      return ping.commitWrite();
    });
    for (const buffer of burst) ping.recycle(buffer);
    const next = Array.from({ length: 8 }, () => {
      ping.beginWrite();
      return ping.commitWrite();
    });
    const reused = next.filter((buffer) => burst.includes(buffer)).length;
    expect(reused).toBeGreaterThan(0);
    expect(reused).toBeLessThanOrEqual(3);
  });
});

describe("dispatchCommandBatch", () => {
  const command = (message: string): CommandMessage => ({ type: "log", message, severity: "log", category: "console", frameId: 0 });
  const names = (commands: CommandMessage[]) => commands.map((entry) => entry.type === "log" ? entry.message : entry.type);

  it("dispatches every command in order and keeps going past a throwing one, rethrowing the first failure", () => {
    const later = vi.fn();
    vi.stubGlobal("queueMicrotask", later);
    try {
      const seen: CommandMessage[] = [];
      const dispatch = (entry: CommandMessage) => {
        seen.push(entry);
        if (entry.type === "log" && entry.message.startsWith("bad")) throw new Error(entry.message);
      };
      expect(() => dispatchCommandBatch([command("a"), command("bad 1"), command("b"), command("bad 2"), command("c")], dispatch))
        .toThrow("bad 1");
      expect(names(seen)).toEqual(["a", "bad 1", "b", "bad 2", "c"]);
      // The second failure is not swallowed: it surfaces as its own uncaught error.
      expect(later).toHaveBeenCalledTimes(1);
      expect(() => (later.mock.calls[0]![0] as () => void)()).toThrow("bad 2");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops handing out commands once the host reports it stopped", () => {
    const seen: CommandMessage[] = [];
    let stopped = false;
    dispatchCommandBatch([command("a"), command("stop"), command("b")], (entry) => {
      seen.push(entry);
      if (entry.type === "log" && entry.message === "stop") stopped = true;
    }, () => stopped);
    expect(names(seen)).toEqual(["a", "stop"]);
  });
});
