import { describe, expect, it } from "vitest";
import { NullEngine, Scene } from "@babylonjs/core";
import { HardwareScalingController } from "./hardware-scaling";
import {
  applySnapshotToScene,
  createSnapshotSceneBinding,
  disposeSnapshotBinding,
} from "./snapshot-apply";
import { ResourceCache } from "./resource-cache";
import { RenderScheduler } from "./render-scheduler";

describe("hardware scaling", () => {
  it("drops a tier and applies levels on a NullEngine", () => {
    const engine = new NullEngine();
    const scaling = new HardwareScalingController(engine, {
      minLevel: 1,
      maxLevel: 2,
      cooldownFrames: 0,
    });
    expect(scaling.getLevel()).toBe(1);
    scaling.dropTier();
    expect(scaling.getLevel()).toBe(1.25);
    for (let i = 0; i < 10; i++) {
      scaling.noteFrameTime(30);
    }
    engine.dispose();
  });
});

describe("snapshot apply under NullEngine", () => {
  it("creates and disposes meshes for actors", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const binding = createSnapshotSceneBinding();
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actors: [
        {
          slotId: 0,
          position: { x: 1, y: 2, z: 3 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
      ],
    });
    expect(binding.meshes.size).toBe(1);
    applySnapshotToScene(scene, binding, {
      frameId: 2,
      tickIndex: 2,
      alpha: 1,
      actors: [],
    });
    expect(binding.meshes.size).toBe(0);
    disposeSnapshotBinding(binding);
    scene.dispose();
    engine.dispose();
  });
});

describe("resource cache retain/release", () => {
  it("accounts and retains bytes", () => {
    const cache = new ResourceCache({ byteCeiling: 1000 });
    cache.account("x", 100);
    cache.retain("x");
    cache.release("x");
    expect(cache.accountedBytes()).toBe(100);
    cache.flushUnreferenced();
    // still referenced once
    expect(cache.accountedBytes()).toBe(100);
    cache.release("x");
    cache.flushUnreferenced();
    expect(cache.accountedBytes()).toBe(0);
    cache.dispose();
  });
});

describe("render scheduler pause", () => {
  it("does not render while paused", () => {
    const scheduler = new RenderScheduler();
    scheduler.invalidate("manual");
    scheduler.setPaused(true);
    expect(scheduler.shouldRender()).toBe(false);
    scheduler.setPaused(false);
    expect(scheduler.shouldRender()).toBe(true);
    const stats = scheduler.stats();
    expect(stats.invalidations).toBeGreaterThan(0);
  });
});
