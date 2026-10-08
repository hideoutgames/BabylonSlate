import { describe, expect, it, vi } from "vitest";
import { createActor, createDefaultScene, createDefaultSceneLayer, createDefaultSceneSettings } from "@babylonslate/core";
import { generateNavMesh } from "@babylonslate/navigation";
import * as physics from "@babylonslate/physics";
import { createInProcessRuntime } from "./driver";
import { createRuntimeFromLoad } from "./play-load";

function scene(name: string, kind: "2d" | "3d" = "3d") {
  return { ...createDefaultScene(kind), name, settings: { ...createDefaultSceneSettings(kind), gravity: [0, 0, 0] as [number, number, number] } };
}

describe("scene backend ownership", () => {
  it("cancels a pending native replacement promptly and disposes its late result", async () => {
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, playScene: scene("Spatial"),
      sceneLibrary: { planar: scene("Planar", "2d") } });
    const createBackend = physics.createPhysicsBackend;
    let release!: (backend: physics.PhysicsBackend) => void;
    let late: physics.PhysicsBackend | undefined;
    let factory: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await runtime.loadPhysics();
      await runtime.realizePlayWorld();
      factory = vi.spyOn(physics, "createPhysicsBackend").mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
      runtime.executeConsoleCommand("changescene Planar");
      const loading = runtime.realizePlayWorld();
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      runtime.stop();
      await expect(loading).rejects.toMatchObject({ name: "AbortError" });
      late = await createBackend({ kind: "2d", gravity: { x: 0, y: 0, z: 0 }, allowSoftwareFallback: false });
      const disposed = vi.spyOn(late, "dispose");
      release(late);
      await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce());
    } finally { factory?.mockRestore(); runtime.stop(); late?.dispose(); }
  });

  it("selects each scene's baked mesh before Begin Play and clears navigation when absent", async () => {
    const bake = (x: number) => generateNavMesh({ positions: [x - 10, 0, -10, x + 10, 0, -10, x + 10, 0, 10, x - 10, 0, 10], indices: [0, 3, 2, 0, 2, 1] });
    const a = scene("Origin"), b = scene("Destination"), c = scene("Unbaked");
    for (const [document, x] of [[a, 0], [b, 100], [c, 200]] as const) document.actors = [createActor("probe", "Probe", { classId: "Probe",
      transform: { position: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } })];
    const runtime = createRuntimeFromLoad({ type: "load", seed: 1, sceneAssetGuid: "a", scene: a,
      scenes: [{ guid: "a", scene: a }, { guid: "b", scene: b }, { guid: "c", scene: c }],
      sceneNavmeshBytes: { a: await bake(0), b: await bake(100) },
    }, () => {});
    try {
      await runtime.loadScripts([{ assetGuid: "probe", classId: "Probe", anchors: [],
        source: 'export function begin(ctx) { const x = ctx.self.transform.position.x; ctx.setVariable("pathCount", ctx.findPathTo({x:x-4,y:0,z:0},{x:x+4,y:0,z:0}).length); }',
        entryPoints: [{ name: "begin", event: "onBeginPlay", isAsync: false }] }]);
      await runtime.realizePlayWorld();
      expect(runtime.getWorld().findActor("probe")!.getVariable("pathCount")).toBeGreaterThan(1);
      runtime.executeConsoleCommand("changescene Destination");
      await runtime.realizePlayWorld();
      expect(runtime.getWorld().findActor("probe")!.getVariable("pathCount")).toBeGreaterThan(1);
      expect(runtime.findNavPath({ x: -4, y: 0, z: 0 }, { x: 4, y: 0, z: 0 })).toEqual([]);
      runtime.executeConsoleCommand("changescene Unbaked");
      await runtime.realizePlayWorld();
      expect(runtime.getWorld().findActor("probe")!.getVariable("pathCount")).toBe(0);
      expect(runtime.findNavPath({ x: 96, y: 0, z: 0 }, { x: 104, y: 0, z: 0 })).toEqual([]);
    } finally { runtime.stop(); }
  });

  it.each([false, true])("changes 3D/2D physics in both directions while retaining overlay ownership (software=%s)", async (software) => {
    const a = scene("Spatial"), b = scene("Planar", "2d");
    for (const document of [a, b]) document.actors = [createActor("box", "Box", { components: [
      { id: "body", classId: "RigidBodyComponent", properties: { motionType: "static" } },
      { id: "shape", classId: "ColliderComponent", properties: { shape: document.viewportMode === "2d"
        ? { kind: "box2d", halfExtents: { x: 1, y: 1 } } : { kind: "box", halfExtents: { x: 1, y: 1, z: 1 } } } },
    ] })];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: software,
      playScene: a, playSceneGuid: "a", sceneLibrary: { a, b },
      sceneLayerLibrary: { overlay: { ...createDefaultSceneLayer(), settings: { ...createDefaultSceneLayer().settings, physicsEnabled: true } } } });
    try {
      if (!software) await runtime.loadPhysics();
      await runtime.realizePlayWorld();
      const layer = runtime.createSceneLayer("overlay")!;
      const overlay = runtime.getSceneLayerPhysicsSync(layer.guid);
      expect(overlay).not.toBeNull();
      for (const [name, kind] of [["Planar", "2d"], ["Spatial", "3d"]] as const) {
        const oldBackend = runtime.getPhysicsSync()!.getBackend();
        const disposed = vi.spyOn(oldBackend, "dispose");
        runtime.executeConsoleCommand(`changescene ${name}`);
        await runtime.realizePlayWorld();
        const sync = runtime.getPhysicsSync()!;
        expect(sync.getBackend().kind).toBe(kind);
        expect(disposed).toHaveBeenCalledOnce();
        expect(runtime.getSceneLayerPhysicsSync(layer.guid)).toBe(overlay);
        sync.syncFromWorld(runtime.getWorld());
        expect(sync.lineTrace({ x: -3, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }).actorId).toBe("box");
      }
    } finally { runtime.stop(); }
  });
});
