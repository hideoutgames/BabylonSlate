import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HavokPhysicsBackend,
  Rapier2DPhysicsBackend,
} from "@babylonslate/physics";
import { createActor, createDefaultScene } from "@babylonslate/core";
import { createInProcessRuntime } from "./driver";
import { createPlayBootCoordinator } from "./play-boot";

afterEach(() => vi.restoreAllMocks());

describe("Play physics startup", () => {
  it("keeps simulation stopped when the requested physics engine cannot load", async () => {
    vi.spyOn(HavokPhysicsBackend, "create").mockRejectedValue(
      new Error("Havok download failed"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false });
    try {
      await expect(createPlayBootCoordinator().play(runtime)).rejects.toThrow(
        "Havok download failed",
      );
      runtime.resume();
      runtime.tick();
      expect(runtime.getWorld().clock.tickIndex).toBe(0);
    } finally {
      runtime.stop();
    }
  });

  it("releases a newly loaded world backend if overlay physics cannot load", async () => {
    const havok = await HavokPhysicsBackend.create({
      kind: "3d",
      gravity: { x: 0, y: -9.81, z: 0 },
    });
    const dispose = vi.spyOn(havok, "dispose");
    vi.spyOn(HavokPhysicsBackend, "create").mockResolvedValue(havok);
    vi.spyOn(Rapier2DPhysicsBackend, "create").mockRejectedValue(
      new Error("Overlay physics unavailable"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false });
    const initialBackend = runtime.getPhysicsSync()!.getBackend();
    try {
      await expect(runtime.loadPhysics()).rejects.toThrow(
        "Overlay physics unavailable",
      );
      expect(dispose).toHaveBeenCalledOnce();
      expect(runtime.getPhysicsSync()!.getBackend()).toBe(initialBackend);
    } finally {
      runtime.stop();
    }
  });

  it("releases both new engines and preserves the prior world when body creation fails", async () => {
    const options = { gravity: { x: 0, y: -9.81, z: 0 } };
    const havok = await HavokPhysicsBackend.create({ ...options, kind: "3d" });
    const rapier = await Rapier2DPhysicsBackend.create({
      ...options,
      kind: "2d",
    });
    const worldDispose = vi.spyOn(havok, "dispose");
    const overlayDispose = vi.spyOn(rapier, "dispose");
    vi.spyOn(HavokPhysicsBackend, "create").mockResolvedValue(havok);
    vi.spyOn(Rapier2DPhysicsBackend, "create").mockResolvedValue(rapier);
    vi.spyOn(havok, "createBody").mockImplementation(() => {
      throw new Error("Body creation failed");
    });
    const scene = createDefaultScene();
    scene.actors = [
      createActor("box", "Box", {
        components: [
          {
            id: "mesh",
            classId: "MeshComponent",
            properties: { meshKind: "box" },
          },
        ],
      }),
    ];
    const runtime = createInProcessRuntime({ seed: 1, playScene: scene });
    runtime.realizePlayWorld();
    const initialWorld = runtime.getPhysicsSync()!.getBackend();
    const initialOverlay = runtime.getOverlayPhysicsSync()!.getBackend();
    try {
      await expect(runtime.loadPhysics()).rejects.toThrow(
        "Body creation failed",
      );
      expect(worldDispose).toHaveBeenCalledOnce();
      expect(overlayDispose).toHaveBeenCalledOnce();
      expect(runtime.getPhysicsSync()!.getBackend()).toBe(initialWorld);
      expect(runtime.getOverlayPhysicsSync()!.getBackend()).toBe(
        initialOverlay,
      );
    } finally {
      runtime.stop();
      if (worldDispose.mock.calls.length === 0) havok.dispose();
      if (overlayDispose.mock.calls.length === 0) rapier.dispose();
    }
  });
});
