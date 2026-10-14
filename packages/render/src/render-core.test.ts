import { describe, expect, it, vi } from "vitest";
import { ResourceCache } from "./resource-cache";
import { RenderScheduler } from "./render-scheduler";
import { SnapshotSampler, writeSampledAudioPoses } from "./snapshot-sync";
import {
  snapshotFloatCount,
  writeActorSlot,
  writeSnapshotHeader,
} from "@babylonslate/bridge";

describe("resource cache", () => {
  it("reuses stable blob URLs per asset guid", () => {
    const cache = new ResourceCache({ byteCeiling: 1024 * 1024 });
    const bytes = new Uint8Array([1, 2, 3]);
    const aLease = cache.acquireBlobUrl("guid-1", bytes);
    const a = aLease.resource;
    const bLease = cache.acquireBlobUrl("guid-1", bytes);
    const b = bLease.resource;
    expect(a).toBe(b);
    cache.account("guid-1", Math.ceil(64 * 64 * 4 * (4 / 3)));
    aLease.release();
    bLease.release();
    cache.flushUnreferenced();
    expect(cache.accountedBytes()).toBe(0);
    cache.dispose();
  });

  it("replaces the blob URL when texture bytes change", () => {
    const cache = new ResourceCache({ byteCeiling: 1024 * 1024 });
    const aLease = cache.acquireBlobUrl("guid-1", new Uint8Array([1, 2, 3]));
    const a = aLease.resource;
    const bLease = cache.acquireBlobUrl("guid-1", new Uint8Array([9, 9, 9]));
    const b = bLease.resource;
    expect(a).not.toBe(b);
    cache.dispose();
  });

  it("evicts unreferenced entries over the ceiling", () => {
    const evictions: string[] = [];
    const cache = new ResourceCache({
      byteCeiling: 100,
      onEvict: (id) => evictions.push(id),
    });
    cache.account("a", 80);
    cache.account("b", 80);
    cache.releaseAccounting("a");
    cache.evictToCeiling();
    expect(evictions).toContain("a");
    expect(cache.accountedBytes()).toBe(80);
    cache.dispose();
  });

  it("trims unreferenced LRU toward 80% of the live ceiling", () => {
    const evictions: string[] = [];
    const cache = new ResourceCache({
      byteCeiling: 100,
      onEvict: (id) => evictions.push(id),
    });
    cache.account("a", 50);
    cache.account("b", 50);
    cache.account("c", 50);
    cache.releaseAccounting("a");
    cache.releaseAccounting("b");
    cache.evictToCeiling();
    expect(cache.accountedBytes()).toBeLessThanOrEqual(80);
    expect(evictions).toContain("a");
    cache.dispose();
  });

  it("skips eviction when the budget is disabled", () => {
    const evictions: string[] = [];
    const cache = new ResourceCache({
      byteCeiling: 10,
      onEvict: (id) => evictions.push(id),
    });
    cache.setBudgetEnabled(false);
    cache.account("a", 80);
    cache.releaseAccounting("a");
    cache.evictToCeiling();
    expect(evictions).toEqual([]);
    expect(cache.accountedBytes()).toBe(80);
    cache.dispose();
  });

  it("evicts released accounting entries while preserving their live siblings", () => {
    const evictions: string[] = [];
    const cache = new ResourceCache({
      byteCeiling: 100,
      onEvict: (id) => evictions.push(id),
    });
    cache.account("gone", 80);
    cache.account("kept", 80);
    cache.releaseAccounting("gone");
    cache.evictToCeiling();
    expect(evictions).toContain("gone");
    expect(cache.accountedBytes()).toBe(80);
    cache.dispose();
  });
});

describe("render scheduler", () => {
  it("presents one paused step while retaining document and viewport visibility gates", () => {
    const scheduler = new RenderScheduler();
    scheduler.setAlwaysRender(true);
    scheduler.setPaused(true);
    scheduler.invalidate("snapshot");
    expect(scheduler.shouldRender(0)).toBe(false);
    scheduler.requestPausedFrame();
    scheduler.setDocumentVisible(false);
    expect(scheduler.shouldRender(0)).toBe(false);
    scheduler.setDocumentVisible(true);
    scheduler.setObstructed(true);
    expect(scheduler.shouldRender(0)).toBe(false);
    scheduler.setObstructed(false);
    expect(scheduler.shouldRender(0)).toBe(true);
    scheduler.noteRendered(0);
    expect(scheduler.shouldRender(100)).toBe(false);
    scheduler.requestPausedFrame();
    expect(scheduler.shouldRender(100)).toBe(true);
  });
  it("keeps a sustained cap with fractional, jittered browser callbacks", () => {
    const scheduler = new RenderScheduler();
    scheduler.acquireContinuous("play");
    scheduler.setFrameCap(30);
    for (let frame = 0; frame < 600; frame += 1) {
      const now = frame * (1000 / 60) + (frame % 3) * 0.2;
      if (scheduler.shouldRender(now)) scheduler.noteRendered(now);
    }
    expect(scheduler.stats().renderedFrames).toBeGreaterThanOrEqual(299);
    expect(scheduler.stats().renderedFrames).toBeLessThanOrEqual(301);
  });

  it("rebases pacing after cap changes and suspension without catch-up bursts", () => {
    const scheduler = new RenderScheduler();
    scheduler.acquireContinuous("play");
    scheduler.setFrameCap(15);
    scheduler.noteRendered(0);
    scheduler.setFrameCap(60);
    expect(scheduler.shouldRender(17)).toBe(true);
    scheduler.noteRendered(17);
    scheduler.setFrameCap(30);
    scheduler.setPaused(true);
    expect(scheduler.shouldRender(10_000)).toBe(false);
    scheduler.setPaused(false);
    expect(scheduler.shouldRender(10_000)).toBe(true);
    scheduler.noteRendered(10_000);
    expect(scheduler.shouldRender(10_001)).toBe(false);
    expect(scheduler.shouldRender(10_017)).toBe(false);
    expect(scheduler.shouldRender(10_034)).toBe(true);
  });

  it("normalizes rendered FPS by elapsed time and reports zero when no frames render", () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const scheduler = new RenderScheduler();
      for (let frame = 0; frame < 30; frame += 1) {
        now = frame * 30;
        scheduler.noteRendered(now);
      }
      now = 1500;
      expect(scheduler.stats().renderedFps).toBe(20);
      now = 2500;
      expect(scheduler.stats().renderedFps).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not catch up when a cap change lands on a fractional deadline", () => {
    const scheduler = new RenderScheduler();
    scheduler.acquireContinuous("play");
    scheduler.setFrameCap(30);
    scheduler.noteRendered(58 * (1000 / 60));
    scheduler.setFrameCap(60);
    expect(scheduler.shouldRender(1000)).toBe(true);
    scheduler.noteRendered(1000);
    expect(scheduler.shouldRender(1001)).toBe(false);
    expect(scheduler.shouldRender(1017)).toBe(true);
  });

  it("skips renders when clean and renders when dirty", () => {
    const scheduler = new RenderScheduler();
    expect(scheduler.shouldRender()).toBe(false);
    expect(scheduler.stats().renderedFrames).toBe(0);
    scheduler.invalidate("snapshot");
    expect(scheduler.shouldRender()).toBe(true);
    scheduler.noteRendered();
    expect(scheduler.shouldRender()).toBe(false);
  });

  it("refcount continuous leases", () => {
    const scheduler = new RenderScheduler();
    const release = scheduler.acquireContinuous("camera");
    expect(scheduler.shouldRender(0)).toBe(true);
    scheduler.noteRendered(0);
    expect(scheduler.shouldRender(17)).toBe(true);
    release();
    expect(scheduler.shouldRender(34)).toBe(false);
  });

  it("always-render toggle forces frames", () => {
    const scheduler = new RenderScheduler();
    scheduler.setAlwaysRender(true);
    expect(scheduler.shouldRender(0)).toBe(true);
  });

  it("skips frames inside the frame-cap window", () => {
    const scheduler = new RenderScheduler();
    scheduler.setAlwaysRender(true);
    scheduler.setFrameCap(60);
    expect(scheduler.shouldRender(0)).toBe(true);
    scheduler.noteRendered(0);
    expect(scheduler.shouldRender(8)).toBe(false);
    expect(scheduler.shouldRender(17)).toBe(true);
  });

  it("honors a 30 fps frame cap interval", () => {
    const scheduler = new RenderScheduler();
    scheduler.setAlwaysRender(true);
    scheduler.setFrameCap(30);
    expect(scheduler.shouldRender(0)).toBe(true);
    scheduler.noteRendered(0);
    expect(scheduler.shouldRender(20)).toBe(false);
    expect(scheduler.shouldRender(34)).toBe(true);
  });

  it.each([
    ["the canvas is not visible", (scheduler: RenderScheduler, on: boolean) => scheduler.setVisible(!on)],
    ["obstructed by a modal", (scheduler: RenderScheduler, on: boolean) => scheduler.setObstructed(on)],
    ["the canvas is resizing", (scheduler: RenderScheduler, on: boolean) => scheduler.setResizing(on)],
  ] as const)("does not render while %s", (_gate, gate) => {
    const scheduler = new RenderScheduler();
    scheduler.setAlwaysRender(true);
    gate(scheduler, true);
    expect(scheduler.shouldRender(0)).toBe(false);
    gate(scheduler, false);
    expect(scheduler.shouldRender(0)).toBe(true);
  });

  it("does not cap frames until setFrameCap is called", () => {
    const scheduler = new RenderScheduler();
    scheduler.acquireContinuous("play");
    expect(scheduler.shouldRender(0)).toBe(true);
    scheduler.noteRendered(0);
    expect(scheduler.shouldRender(1)).toBe(true);
  });

  it("caps continuous-render leases", () => {
    const scheduler = new RenderScheduler();
    scheduler.setFrameCap(60);
    scheduler.acquireContinuous("camera");
    expect(scheduler.shouldRender(0)).toBe(true);
    scheduler.noteRendered(0);
    expect(scheduler.shouldRender(1)).toBe(false);
    expect(scheduler.shouldRender(17)).toBe(true);
  });
});

describe("snapshot sampler", () => {
  it("replaces capacity state and ignores stale layout generations", () => {
    const sampler = new SnapshotSampler(1);
    const stale = new Float32Array(snapshotFloatCount(1));
    writeSnapshotHeader(stale, {
      frameId: 1,
      tickIndex: 1,
      actorCount: 0,
      scriptMs: 0,
      physicsMs: 0,
      layoutGeneration: 0,
    });
    expect(sampler.installLayout(4, 1)).toBe(true);
    sampler.push(stale);
    expect(sampler.sample()).toBeNull();
    const current = new Float32Array(snapshotFloatCount(4));
    writeSnapshotHeader(current, {
      frameId: 2,
      tickIndex: 2,
      actorCount: 0,
      scriptMs: 0,
      physicsMs: 0,
      layoutGeneration: 1,
    });
    sampler.push(current);
    expect(sampler.sample()?.frameId).toBe(2);
  });

  it("ignores unpublished zeroed snapshot buffers", () => {
    const sampler = new SnapshotSampler(4);
    sampler.push(new Float32Array(snapshotFloatCount(4)));
    expect(sampler.sample()).toBeNull();
  });

  it("samples a published snapshot with no actors", () => {
    const buf = new Float32Array(snapshotFloatCount(4));
    writeSnapshotHeader(buf, {
      frameId: 2,
      tickIndex: 2,
      actorCount: 0,
      scriptMs: 0,
      physicsMs: 0,
    });
    const sampler = new SnapshotSampler(4);
    sampler.push(buf);
    const out = sampler.sample();
    expect(out).not.toBeNull();
    expect(out!.actorCount).toBe(0);
    expect(out!.frameId).toBe(2);
  });

  it("clear drops published snapshots so sample returns null", () => {
    const buf = new Float32Array(snapshotFloatCount(1));
    writeSnapshotHeader(buf, {
      frameId: 1,
      tickIndex: 1,
      actorCount: 1,
      scriptMs: 0,
      physicsMs: 0,
    });
    writeActorSlot(buf, 0, {
      slotId: 0,
      position: { x: 1, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: 1,
    });
    const sampler = new SnapshotSampler(1);
    sampler.push(buf);
    expect(sampler.sample()?.actorCount).toBe(1);
    sampler.clear();
    expect(sampler.sample()).toBeNull();
  });

  it("copies into an owned buffer instead of slicing each push", () => {
    const slice = vi.spyOn(Float32Array.prototype, "slice");
    const buf = new Float32Array(snapshotFloatCount(2));
    writeSnapshotHeader(buf, {
      frameId: 1,
      tickIndex: 1,
      actorCount: 1,
      scriptMs: 0,
      physicsMs: 0,
    });
    writeActorSlot(buf, 0, {
      slotId: 0,
      position: { x: 1, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: 1,
    });
    const sampler = new SnapshotSampler(2);
    try {
      for (let i = 0; i < 16; i++) sampler.push(buf);
      expect(slice).not.toHaveBeenCalled();
    } finally {
      slice.mockRestore();
    }
    buf[snapshotFloatCount(0) + 1] = 99;
    const sampled = sampler.sample();
    expect(sampled?.actors[0]?.position.x).toBe(1);
  });

  it("decodes a buffered snapshot once however often it is sampled, and again after a push or clear", () => {
    const frame = (frameId: number, x: number) => {
      const buf = new Float32Array(snapshotFloatCount(2));
      writeSnapshotHeader(buf, { frameId, tickIndex: frameId, actorCount: 1, scriptMs: 0, physicsMs: 0 });
      writeActorSlot(buf, 0, {
        slotId: 4, position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 }, flags: 1,
      });
      return buf;
    };
    const sampler = new SnapshotSampler(2);
    sampler.push(frame(1, 10));
    const sampled = sampler.sample()!;
    // Rows are decoded in place, so a re-decode shows up as a write to the row.
    let decodes = 0;
    let x = sampled.actors[0]!.position.x;
    Object.defineProperty(sampled.actors[0]!.position, "x", { get: () => x, set: (value: number) => { decodes++; x = value; } });
    const revision = sampler.revision;

    expect(sampler.sample()).toBe(sampled);
    expect(sampler.sample()).toBe(sampled);
    expect(decodes).toBe(0);
    expect(sampler.revision).toBe(revision);

    sampler.push(frame(2, 25));
    expect(sampler.revision).not.toBe(revision);
    expect(sampler.sample()?.frameId).toBe(2);
    expect(decodes).toBe(1);
    expect(sampled.actors[0]!.position.x).toBe(25);

    sampler.clear();
    expect(sampler.sample()).toBeNull();
    sampler.push(frame(3, 7));
    expect(sampler.sample()?.actors[0]?.position.x).toBe(7);
  });

  it("samples a smaller snapshot without reading an earlier larger frame's rows", () => {
    const sampler = new SnapshotSampler(32);
    const push = (frameId: number, rows: Array<[slotId: number, x: number]>) => {
      const buf = new Float32Array(snapshotFloatCount(32));
      rows.forEach(([slotId, x], index) => writeActorSlot(buf, index, {
        slotId,
        position: { x, y: 1, z: 2 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 2, z: 3 },
        flags: 1,
      }));
      writeSnapshotHeader(buf, { frameId, tickIndex: frameId, actorCount: rows.length, scriptMs: 0, physicsMs: 0 });
      sampler.push(buf);
    };
    push(1, [[0, 0], [1, 10], [2, 20], [3, 30]]);
    // Lands in the buffer that held frame 1; its rows past the second remain.
    push(2, [[5, 16], [4, 6]]);

    const out = sampler.sample()!;
    expect(out.frameId).toBe(2);
    expect(out.actorCount).toBe(2);
    expect(out.actors.slice(0, 2).map(({ slotId, position, scale }) => ({ slotId, x: position.x, y: position.y, scale })))
      .toEqual([
        { slotId: 5, x: 16, y: 1, scale: { x: 1, y: 2, z: 3 } },
        { slotId: 4, x: 6, y: 1, scale: { x: 1, y: 2, z: 3 } },
      ]);
  });
});

describe("writeSampledAudioPoses", () => {
  it("reuses scratch pose objects across samples", () => {
    const sampled = {
      actorCount: 1,
      actors: [
        {
          slotId: 3,
          position: { x: 1, y: 2, z: 3 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
      ],
    };
    const out: Parameters<typeof writeSampledAudioPoses>[1] = [];
    const slots = new Set([3]);
    writeSampledAudioPoses(sampled, out, slots);
    const first = out[0];
    expect(first).toMatchObject({
      slotId: 3,
      position: { x: 1, y: 2, z: 3, qx: 0, qy: 0, qz: 0, qw: 1 },
    });
    sampled.actors[0]!.position.x = 8;
    writeSampledAudioPoses(sampled, out, slots);
    expect(out[0]).toBe(first);
    expect(out[0]?.position.x).toBe(8);
  });

  describe("for the emitter slots only", () => {
    // Slot ids are not row indices: row i holds slot SLOTS[i].
    const SLOTS = [5, 7, 9, 11];
    const snapshot = (slotIds: number[]) => ({
      actorCount: slotIds.length,
      actors: slotIds.map((slotId) => ({
        slotId,
        position: { x: slotId * 10, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      })),
    });
    const written = (out: Parameters<typeof writeSampledAudioPoses>[1]) =>
      out.map((row) => [row.slotId, row.position.x]).sort((a, b) => a[0]! - b[0]!);

    it("poses just the requested actors and drops a slot that left the snapshot", () => {
      const out: Parameters<typeof writeSampledAudioPoses>[1] = [];
      const rows = new Map<number, number>();
      expect(writeSampledAudioPoses(snapshot(SLOTS), out, new Set([7, 11]), rows)).toBe(2);
      expect(written(out)).toEqual([[7, 70], [11, 110]]);

      // Slot 7 despawns: slot 11 moves up a row, the memo must not return a neighbour.
      expect(writeSampledAudioPoses(snapshot([5, 9, 11]), out, new Set([7, 11]), rows)).toBe(1);
      expect(written(out)).toEqual([[11, 110]]);

      // It spawns again later in the list and is found by the rescan.
      expect(writeSampledAudioPoses(snapshot([5, 9, 11, 7]), out, new Set([7, 11]), rows)).toBe(2);
      expect(written(out)).toEqual([[7, 70], [11, 110]]);
      expect(writeSampledAudioPoses(snapshot(SLOTS), out, new Set(), rows)).toBe(0);
      expect(out).toEqual([]);
    });

    it("does not read unrelated actors while the snapshot rows hold still", () => {
      let reads = 0;
      const actors = Array.from({ length: 200 }, (_, slotId) => ({
        get slotId() { reads++; return slotId; },
        position: { x: slotId * 10, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      }));
      const sampled = { actorCount: actors.length, actors };
      const out: Parameters<typeof writeSampledAudioPoses>[1] = [];
      const rows = new Map<number, number>();
      const slots = new Set([150, 3]);
      writeSampledAudioPoses(sampled, out, slots, rows);
      expect(reads).toBeGreaterThanOrEqual(actors.length);

      reads = 0;
      for (const actor of actors) actor.position.x += 1;
      expect(writeSampledAudioPoses(sampled, out, slots, rows)).toBe(2);
      expect(reads).toBeLessThanOrEqual(2 * slots.size);
      expect(written(out)).toEqual([[3, 31], [150, 1501]]);
    });
  });
});
