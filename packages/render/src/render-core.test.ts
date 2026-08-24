import { describe, expect, it, vi } from "vitest";
import {
  accountedTextureBytes,
  BYTES_PER_TEXEL,
} from "./texture-bytes";
import { ResourceCache } from "./resource-cache";
import { RenderScheduler } from "./render-scheduler";
import { SnapshotInterpolator, writeSampledAudioPoses } from "./snapshot-sync";
import {
  snapshotFloatCount,
  writeActorSlot,
  writeSnapshotHeader,
} from "@babylonslate/bridge";

describe("texture byte accounting", () => {
  it("computes RGBA8 and ASTC with mipmap overhead", () => {
    expect(BYTES_PER_TEXEL.rgba8).toBe(4);
    expect(BYTES_PER_TEXEL.astc4x4).toBe(1);
    // 64x64 RGBA8 base = 16384; +1/3 mips ≈ 21845
    expect(accountedTextureBytes(64, 64, "rgba8", true)).toBe(
      Math.ceil(64 * 64 * 4 * (4 / 3)),
    );
    expect(accountedTextureBytes(64, 64, "astc4x4", false)).toBe(64 * 64 * 1);
  });
});

describe("resource cache", () => {
  it("reuses stable blob URLs per asset guid", () => {
    const cache = new ResourceCache({ byteCeiling: 1024 * 1024 });
    const bytes = new Uint8Array([1, 2, 3]);
    const a = cache.blobUrlFor("guid-1", bytes);
    const b = cache.blobUrlFor("guid-1", bytes);
    expect(a).toBe(b);
    cache.release("guid-1");
    cache.dispose();
  });

  it("replaces the blob URL when texture bytes change", () => {
    const cache = new ResourceCache({ byteCeiling: 1024 * 1024 });
    const a = cache.blobUrlFor("guid-1", new Uint8Array([1, 2, 3]));
    const b = cache.blobUrlFor("guid-1", new Uint8Array([9, 9, 9]));
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
    cache.release("a");
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
    cache.release("a");
    cache.release("b");
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
    cache.release("a");
    cache.evictToCeiling();
    expect(evictions).toEqual([]);
    expect(cache.accountedBytes()).toBe(80);
    cache.dispose();
  });
});

describe("render scheduler", () => {
  it("skips renders when clean and renders when dirty", () => {
    const scheduler = new RenderScheduler();
    expect(scheduler.shouldRender()).toBe(false);
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

  it("does not render when the canvas is not visible", () => {
    const scheduler = new RenderScheduler();
    scheduler.setAlwaysRender(true);
    scheduler.setVisible(false);
    expect(scheduler.shouldRender(0)).toBe(false);
  });

  it("does not render when obstructed by a modal", () => {
    const scheduler = new RenderScheduler();
    scheduler.setAlwaysRender(true);
    scheduler.setObstructed(true);
    expect(scheduler.shouldRender(0)).toBe(false);
  });

  it("does not render while the canvas is resizing", () => {
    const scheduler = new RenderScheduler();
    scheduler.setAlwaysRender(true);
    scheduler.setResizing(true);
    expect(scheduler.shouldRender(0)).toBe(false);
    scheduler.setResizing(false);
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

describe("snapshot interpolator", () => {
  it("lerps positions between two snapshots", () => {
    const floats = snapshotFloatCount(1);
    const a = new Float32Array(floats);
    const b = new Float32Array(floats);
    writeSnapshotHeader(a, {
      frameId: 1,
      tickIndex: 1,
      actorCount: 1,
      scriptMs: 0,
      physicsMs: 0,
    });
    writeActorSlot(a, 0, {
      slotId: 0,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: 1,
    });
    writeSnapshotHeader(b, {
      frameId: 2,
      tickIndex: 2,
      actorCount: 1,
      scriptMs: 0,
      physicsMs: 0,
    });
    writeActorSlot(b, 0, {
      slotId: 0,
      position: { x: 10, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: 1,
    });
    const interp = new SnapshotInterpolator(1);
    interp.push(a);
    interp.push(b);
    const out = interp.sample(0.5);
    expect(out).not.toBeNull();
    expect(out!.actorCount).toBe(1);
    expect(out!.actors[0]!.position.x).toBeCloseTo(5);
  });

  it("matches actors by slotId and includes newly spawned slots", () => {
    const a = new Float32Array(snapshotFloatCount(3));
    const b = new Float32Array(snapshotFloatCount(3));
    writeSnapshotHeader(a, {
      frameId: 1,
      tickIndex: 1,
      actorCount: 2,
      scriptMs: 0,
      physicsMs: 0,
    });
    writeActorSlot(a, 0, {
      slotId: 1,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: 1,
    });
    writeActorSlot(a, 1, {
      slotId: 2,
      position: { x: 10, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: 1,
    });
    writeSnapshotHeader(b, {
      frameId: 2,
      tickIndex: 2,
      actorCount: 3,
      scriptMs: 0,
      physicsMs: 0,
    });
    writeActorSlot(b, 0, {
      slotId: 2,
      position: { x: 20, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: 1,
    });
    writeActorSlot(b, 1, {
      slotId: 1,
      position: { x: 2, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: 1,
    });
    writeActorSlot(b, 2, {
      slotId: 3,
      position: { x: 30, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: 1,
    });

    const interp = new SnapshotInterpolator(3);
    interp.push(a);
    interp.push(b);
    const out = interp.sample(0.5)!;
    expect(out.actorCount).toBe(3);
    expect(out.actors.slice(0, 3).map((actor) => actor.slotId)).toEqual([
      2, 1, 3,
    ]);
    expect(out.actors[0]!.position.x).toBeCloseTo(15);
    expect(out.actors[1]!.position.x).toBeCloseTo(1);
    expect(out.actors[2]!.position.x).toBeCloseTo(30);
  });

  it("normalizes shortest-path quaternion interpolation", () => {
    const a = new Float32Array(snapshotFloatCount(1));
    const b = new Float32Array(snapshotFloatCount(1));
    for (const [buffer, frameId, w] of [
      [a, 1, 1],
      [b, 2, -1],
    ] as const) {
      writeSnapshotHeader(buffer, {
        frameId,
        tickIndex: frameId,
        actorCount: 1,
        scriptMs: 0,
        physicsMs: 0,
      });
      writeActorSlot(buffer, 0, {
        slotId: 7,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w },
        scale: { x: 1, y: 1, z: 1 },
        flags: 1,
      });
    }

    const interp = new SnapshotInterpolator(1);
    interp.push(a);
    interp.push(b);
    const rotation = interp.sample(0.5)!.actors[0]!.rotation;
    const length = Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w);
    expect(length).toBeCloseTo(1);
    expect(Math.abs(rotation.w)).toBeCloseTo(1);
  });

  it("ignores unpublished zeroed snapshot buffers", () => {
    const interp = new SnapshotInterpolator(4);
    interp.push(new Float32Array(snapshotFloatCount(4)));
    expect(interp.sample(1)).toBeNull();
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
    const interp = new SnapshotInterpolator(4);
    interp.push(buf);
    const out = interp.sample(1);
    expect(out).not.toBeNull();
    expect(out!.actorCount).toBe(0);
    expect(out!.frameId).toBe(2);
  });

  it("copies into owned ping-pong buffers instead of slicing each push", () => {
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
    const interp = new SnapshotInterpolator(2);
    try {
      for (let i = 0; i < 16; i++) interp.push(buf);
      expect(slice).not.toHaveBeenCalled();
    } finally {
      slice.mockRestore();
    }
    buf[snapshotFloatCount(0) + 1] = 99;
    const sampled = interp.sample(1);
    expect(sampled?.actors[0]?.position.x).toBe(1);
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
    writeSampledAudioPoses(sampled, out);
    const first = out[0];
    expect(first).toMatchObject({
      slotId: 3,
      position: { x: 1, y: 2, z: 3, qx: 0, qy: 0, qz: 0, qw: 1 },
    });
    sampled.actors[0]!.position.x = 8;
    writeSampledAudioPoses(sampled, out);
    expect(out[0]).toBe(first);
    expect(out[0]?.position.x).toBe(8);
  });
});
