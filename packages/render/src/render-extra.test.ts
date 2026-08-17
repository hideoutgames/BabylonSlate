import { describe, expect, it, vi } from "vitest";
import { NullEngine, Scene } from "@babylonjs/core";
import {
  createDefaultTilemapPayload,
  normalizeTilesetPayload,
  setTile,
} from "@babylonslate/assets";
import { HardwareScalingController } from "./hardware-scaling";
import {
  applySnapshotToScene,
  applyAssignMesh,
  createSnapshotSceneBinding,
  disposeSnapshotBinding,
} from "./snapshot-apply";
import { ResourceCache } from "./resource-cache";
import { RenderScheduler } from "./render-scheduler";

describe("hardware scaling", () => {
  it("drops a hardware scaling tier and applies an initial Engine Settings level", () => {
    const engine = new NullEngine();
    const scaling = new HardwareScalingController(engine, {
      minLevel: 1,
      maxLevel: 2,
      cooldownFrames: 0,
      initialLevel: 1.5,
    });
    expect(scaling.getLevel()).toBe(1.5);
    scaling.dropTier();
    expect(scaling.getLevel()).toBe(1.75);
    engine.dispose();
  });

  it("does not call setHardwareScalingLevel when the clamped level is unchanged", () => {
    const engine = new NullEngine();
    const scaling = new HardwareScalingController(engine, {
      minLevel: 1,
      maxLevel: 4,
      initialLevel: 1,
    });
    const apply = vi.spyOn(engine, "setHardwareScalingLevel");
    const calls = apply.mock.calls.length;
    scaling.setLevel(1);
    expect(apply.mock.calls.length).toBe(calls);
    engine.dispose();
  });

  it("does not hunt below the Engine Settings floor on cheap frames", () => {
    const engine = new NullEngine();
    const scaling = new HardwareScalingController(engine, {
      minLevel: 1,
      maxLevel: 4,
      cooldownFrames: 0,
      initialLevel: 1,
      targetFrameMs: 1000 / 30,
    });
    for (let i = 0; i < 20; i++) {
      scaling.noteFrameTime(4);
    }
    expect(scaling.getLevel()).toBe(1);
    engine.dispose();
  });

  it("steps toward maxLevel on slow frames after cooldown", () => {
    const engine = new NullEngine();
    const scaling = new HardwareScalingController(engine, {
      minLevel: 1,
      maxLevel: 4,
      cooldownFrames: 30,
      initialLevel: 1,
      targetFrameMs: 1000 / 60,
    });
    for (let i = 0; i < 5; i++) {
      scaling.noteFrameTime(40);
    }
    expect(scaling.getLevel()).toBe(1.25);
    engine.dispose();
  });

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
      actorCount: 1,
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
      actorCount: 0,
      actors: [],
    });
    expect(binding.meshes.size).toBe(0);
    disposeSnapshotBinding(binding);
    scene.dispose();
    engine.dispose();
  });

  it("honors assignMesh meshKind so Play is not always a box", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 0,
      meshAssetGuid: null,
      meshKind: "sphere",
    });
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actorCount: 1,
      actors: [
        {
          slotId: 0,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
      ],
    });
    const mesh = binding.meshes.get(0);
    expect(mesh).toBeDefined();
    expect(mesh!.name).toBe("actor-0");
    expect(mesh!.getTotalVertices()).toBeGreaterThan(24);
    disposeSnapshotBinding(binding);
    scene.dispose();
    engine.dispose();
  });

  it("records meshAssetGuid from assignMesh so sprite clips can look up payloads", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 2,
      meshAssetGuid: "sprite-guid",
      meshKind: "sprite",
    });
    expect(binding.meshAssetGuids.get(2)).toBe("sprite-guid");
    expect(binding.meshKinds.get(2)).toBe("sprite");
    disposeSnapshotBinding(binding);
    scene.dispose();
    engine.dispose();
  });

  it("builds chunk child meshes when assignMesh is a tilemap with payloads", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const tileset = normalizeTilesetPayload({
      atlasWidth: 16,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
    });
    let tilemap = createDefaultTilemapPayload();
    tilemap = { ...tilemap, tilesetGuid: "set-1", chunkSize: 2 };
    tilemap = setTile(tilemap, "layer-1", 0, 0, 1);
    const binding = createSnapshotSceneBinding();
    binding.tilemaps = new Map([["map-1", tilemap]]);
    binding.tilesets = new Map([["set-1", tileset]]);
    binding.pixelsPerUnit = 16;
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 0,
      meshAssetGuid: "map-1",
      meshKind: "tilemap",
    });
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actorCount: 1,
      actors: [
        {
          slotId: 0,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
      ],
    });
    const mesh = binding.meshes.get(0);
    expect(mesh?.name).toBe("actor-0");
    expect(mesh?.getChildren()).toHaveLength(1);
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
