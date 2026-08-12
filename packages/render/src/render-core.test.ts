import { describe, expect, it } from "vitest";
import {
  accountedTextureBytes,
  BYTES_PER_TEXEL,
} from "./texture-bytes";
import { ResourceCache } from "./resource-cache";
import { RenderScheduler } from "./render-scheduler";
import { SnapshotInterpolator } from "./snapshot-sync";
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
    const a = cache.blobUrlFor("guid-1", new Uint8Array([1, 2, 3]));
    const b = cache.blobUrlFor("guid-1", new Uint8Array([9, 9, 9]));
    expect(a).toBe(b);
    cache.release("guid-1");
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
});
