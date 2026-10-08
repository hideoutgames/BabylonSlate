import { describe, expect, it, vi } from "vitest";
import {
  createActor,
  createDefaultScene,
  createDefaultSceneLayer,
  type SerializedComponent,
  type SerializedScene,
} from "@babylonslate/core";
import { readActorSlot, readSnapshotHeader, snapshotFloatCount, type CommandMessage } from "@babylonslate/bridge";
import type { Actor } from "@babylonslate/object-model";
import { createInProcessRuntime, type RuntimeDriver } from "./driver";

function at(x: number, y: number, z: number) {
  return { transform: { position: [x, y, z] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] } };
}

const staticSphere: SerializedComponent[] = [
  { id: "body", classId: "RigidBodyComponent", properties: { motionType: "static", mass: 0, gravityScale: 0 } },
  { id: "collider", classId: "ColliderComponent", properties: { shape: { kind: "sphere", radius: 0.25 } } },
];

function launch(playScene: SerializedScene, libraries: Pick<Parameters<typeof createInProcessRuntime>[0], "sceneLibrary" | "sceneLayerLibrary"> = {}) {
  const commands: CommandMessage[] = [];
  const slots = new Map<string, number>();
  const runtime = createInProcessRuntime({
    seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, playScene, playSceneGuid: "cycle", ...libraries,
    onCommand: (command) => {
      commands.push(command);
      if (command.type === "spawn") slots.set(command.actorGuid, command.slotId);
    },
  });
  return { runtime, commands, slots };
}

function actorWarnings(commands: readonly CommandMessage[]): string[] {
  return commands.flatMap((command) =>
    command.type === "log" && command.severity === "warning" && command.category === "actor" ? [command.message] : []);
}

function publishedPosition(runtime: RuntimeDriver, slotId: number | undefined) {
  const buf = new Float32Array(snapshotFloatCount(runtime.snapshotCapacity));
  expect(runtime.copySnapshot(buf)).toBe(true);
  const count = readSnapshotHeader(buf).actorCount;
  for (let index = 0; index < count; index += 1) {
    const slot = readActorSlot(buf, index);
    if (slot.slotId === slotId) return slot.position;
  }
  return undefined;
}

function named(runtime: RuntimeDriver, name: string): Actor {
  return runtime.getWorld().getActors().find((actor) => actor.getVariable("name") === name)!;
}

describe("parent cycles in loaded data", () => {
  it("clears the link that closes a scene's A -> B -> A cycle once and keeps acyclic links", async () => {
    const { runtime, commands, slots } = launch({ ...createDefaultScene(), name: "Cycle", actors: [
      createActor("a", "A", { parentId: "b", ...at(1, 0, 0), components: staticSphere }),
      createActor("b", "B", { parentId: "a", ...at(0, 2, 0) }),
      createActor("c", "C", { parentId: "d", ...at(0, 0, 3) }),
      createActor("d", "D", at(4, 0, 0)),
      createActor("e", "E", { parentId: "missing", ...at(0, 0, 5) }),
    ] });
    try {
      await runtime.realizePlayWorld();
      runtime.start();
      // Physics composes A's chain every tick; a remaining cycle would throw.
      for (let tick = 0; tick < 3; tick += 1) runtime.tick();
      const world = runtime.getWorld();
      // B spawned after A, so applying links in spawn order its link closes the cycle.
      expect(world.findActor("b")!.getVariable("parentId")).toBeNull();
      expect(world.findActor("a")!.getVariable("parentId")).toBe("b");
      expect(world.findActor("c")!.getVariable("parentId")).toBe("d");
      expect(world.findActor("e")!.getVariable("parentId")).toBe("missing");

      const warnings = actorWarnings(commands);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("B (b)");
      expect(warnings[0]).toContain("A (a)");

      expect(runtime.getPhysicsSync()!.getBackend().sphereOverlap({ x: 1, y: 2, z: 0 }, 0.1).actorIds).toEqual(["a"]);
      expect(publishedPosition(runtime, slots.get("a"))).toEqual({ x: 1, y: 2, z: 0 });
      expect(publishedPosition(runtime, slots.get("c"))).toEqual({ x: 4, y: 0, z: 3 });
      expect(publishedPosition(runtime, slots.get("e"))).toEqual({ x: 0, y: 0, z: 5 });
    } finally {
      runtime.stop();
    }
  });

  it("breaks cycles in a scene and a SceneLayer loaded from inside a tick on the immediate runtime", async () => {
    // Mid-tick, the World only queues the loaded actors until the phase ends.
    const next: SerializedScene = { ...createDefaultScene(), name: "Next", actors: [
      createActor("a", "A", { parentId: "b", ...at(1, 0, 0), components: staticSphere }),
      createActor("b", "B", { parentId: "a", ...at(0, 2, 0) }),
    ] };
    const layer = { ...createDefaultSceneLayer(), actors: [
      createActor("x", "Layer X", { classId: "SceneLayerActor", parentId: "y" }),
      createActor("y", "Layer Y", { classId: "SceneLayerActor", parentId: "x" }),
    ] };
    const { runtime, commands } = launch({ ...createDefaultScene(), name: "Host", actors: [] },
      { sceneLibrary: { next }, sceneLayerLibrary: { layer } });
    try {
      await runtime.realizePlayWorld();
      runtime.start();
      const world = runtime.getWorld();
      let loaded = false;
      world.setGameInstance(world.createGameInstance({ classId: "GameInstance", hooks: { onTick: () => {
        if (loaded) return;
        loaded = true;
        runtime.executeConsoleCommand("changescene next");
        runtime.createSceneLayer("layer");
      } } }));
      for (let tick = 0; tick < 3; tick += 1) runtime.tick();

      expect(world.findActor("b")!.getVariable("parentId")).toBeNull();
      expect(world.findActor("a")!.getVariable("parentId")).toBe("b");
      const layerY = named(runtime, "Layer Y");
      const layerX = named(runtime, "Layer X");
      expect(layerY.getVariable("parentId")).toBeNull();
      expect(layerX.getVariable("parentId")).toBe(layerY.guid);
      expect(runtime.getPhysicsSync()!.getBackend().sphereOverlap({ x: 1, y: 2, z: 0 }, 0.1).actorIds).toEqual(["a"]);
      const warnings = actorWarnings(commands);
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain("B (b)");
      expect(warnings[1]).toContain("Layer Y (" + layerY.guid + ")");
    } finally {
      runtime.stop();
    }
  });

  it("breaks streamed scene and SceneLayer cycles once each, re-rooting a streamed actor under its streaming actor", async () => {
    const child: SerializedScene = { ...createDefaultScene(), name: "Child", actors: [
      createActor("a", "Streamed A", { parentId: "b", ...at(1, 0, 0), components: staticSphere }),
      createActor("b", "Streamed B", { parentId: "a", ...at(0, 2, 0) }),
    ] };
    const layer = { ...createDefaultSceneLayer(), actors: [
      createActor("x", "Layer X", { classId: "SceneLayerActor", parentId: "y" }),
      createActor("y", "Layer Y", { classId: "SceneLayerActor", parentId: "x" }),
    ] };
    const { runtime, commands, slots } = launch({ ...createDefaultScene(), name: "Host", actors: [
      createActor("stream", "Stream", { classId: "SceneStreamingActor", ...at(10, 0, 0), components: [
        { id: "stream", classId: "SceneStreamingComponent", properties: { sceneGuid: "child", sceneName: "Child" } },
      ] }),
    ] }, { sceneLibrary: { child }, sceneLayerLibrary: { layer } });
    try {
      await runtime.realizePlayWorld();
      runtime.start();
      const world = runtime.getWorld();
      await runtime.loadSceneStream(world.findActor("stream"));
      for (let tick = 0; tick < 3; tick += 1) runtime.tick();

      const streamedA = named(runtime, "Streamed A");
      const streamedB = named(runtime, "Streamed B");
      // B is now a root of the streamed instance, placed under the streaming actor.
      expect(streamedB.getVariable("parentId")).toBe("stream");
      expect(streamedA.getVariable("parentId")).toBe(streamedB.guid);
      expect(runtime.getPhysicsSync()!.getBackend().sphereOverlap({ x: 11, y: 2, z: 0 }, 0.1).actorIds).toEqual([streamedA.guid]);
      expect(publishedPosition(runtime, slots.get(streamedA.guid))).toEqual({ x: 11, y: 2, z: 0 });

      const layer = runtime.createSceneLayer("layer");
      expect(layer).not.toBeNull();
      // Scene Layer actor guids are scoped to their layer instance.
      await vi.waitFor(() => expect(world.findActor(layer!.guid + ":y")).toBeDefined());
      expect(world.findActor(layer!.guid + ":y")!.getVariable("parentId")).toBeNull();
      expect(world.findActor(layer!.guid + ":x")!.getVariable("parentId")).toBe(layer!.guid + ":y");
      runtime.tick();

      const warnings = actorWarnings(commands);
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain(`Streamed B (${streamedB.guid})`);
      expect(warnings[1]).toContain("Layer Y (" + layer!.guid + ":y)");
    } finally {
      runtime.stop();
    }
  });
});
