import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  readActorSlot,
  readSnapshotHeader,
  snapshotFloatCount,
  type ActorSlot,
  type CommandMessage,
} from "@babylonslate/bridge";
import {
  createActor,
  createDefaultSceneLayer,
  createDefaultSceneSettings,
  type SerializedActor,
  type SerializedScene,
  type SerializedSceneLayer,
} from "@babylonslate/core";
import { generateNavMesh, initNavigation } from "@babylonslate/navigation";
import type { Actor } from "@babylonslate/object-model";
import { createInProcessRuntime, type RuntimeDriver } from "./driver";
import type { CompiledScript } from "./script-host";

type Vec3 = [number, number, number];

function pose(position: Vec3, rotation: [number, number, number, number] = [0, 0, 0, 1], scale: Vec3 = [1, 1, 1]) {
  return { transform: { position, rotation, scale } };
}

const navAgent = { id: "nav", classId: "NavAgentComponent", properties: { radius: 0.5, height: 2, maxSpeed: 3.5 } };

function tickScript(classId: string, body: string, parentClassId = "Actor"): CompiledScript {
  return {
    classId, parentClassId, assetGuid: `${classId}-script`, anchors: [],
    source: `export function onTick(ctx) { ${body} }`,
    entryPoints: [{ name: "onTick", event: "onTick", isAsync: false }],
  };
}

const scripts: CompiledScript[] = [
  tickScript("Mover", "ctx.addActorWorldOffset(ctx.self, { x: 1, y: 0, z: 0 });"),
  tickScript("Doomed", "if (ctx.tickIndex === 2) ctx.destroyActor(ctx.self);"),
  tickScript("Pauser", 'if (ctx.tickIndex === 2) ctx.executeConsoleCommand("pause");'),
  tickScript("Blocker", `if (ctx.tickIndex !== 2) return;
    ctx.loadSceneBlocking(ctx.getAllActorsOfClass("SceneStreamingActor")[0]).catch(() => {});`),
  tickScript("Spawner", 'if (ctx.tickIndex === 3) ctx.spawnActor("Mover", { position: { x: 0, y: 1, z: 0 } });'),
  tickScript("LateDoomed", "if (ctx.tickIndex === 6) ctx.destroyActor(ctx.self);"),
  tickScript("LayerBlocker", `if (ctx.tickIndex !== 2) return;
    ctx.setActorLocation(ctx.self, { x: 5, y: 5, z: 0 });
    ctx.loadSceneBlocking(ctx.getAllActorsOfClass("SceneStreamingActor")[0]).catch(() => {});`, "SceneLayerActor"),
];

function scene(actors: SerializedActor[]): SerializedScene {
  return { name: "Publish", viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [], actors };
}

/** A vertical box whose second row moves itself out of the box, then starts a blocking load. */
function overlayList(): SerializedSceneLayer {
  const row = (id: string, classId: string) => createActor(id, id, {
    classId, parentId: "list", components: [{ id: "panel", classId: "2DPanelComponent", properties: {} }],
  });
  return {
    ...createDefaultSceneLayer(),
    actors: [
      createActor("list", "List", {
        classId: "SceneLayerActor",
        components: [{ id: "box", classId: "2DVerticalBoxComponent", properties: { width: 4, heightMode: "content", gap: 1 } }],
      }),
      row("first", "SceneLayerActor"),
      row("second", "LayerBlocker"),
    ],
  };
}

const streamTarget = () => createActor("stream", "Stream", {
  classId: "SceneStreamingActor",
  components: [{ id: "stream", classId: "SceneStreamingComponent", properties: { sceneGuid: "child", sceneName: "Child" } }],
});

async function launch(playScene: SerializedScene, navMesh?: Uint8Array) {
  const commands: CommandMessage[] = [];
  const slots = new Map<string, number>();
  const despawnTicks: number[] = [];
  const runtime: RuntimeDriver = createInProcessRuntime({
    seed: 7, maxActors: 32, seedDemoActors: false, preferSoftwarePhysics: true,
    playScene, sceneLibrary: { child: scene([createActor("streamed", "Streamed", { classId: "Mover" })]) },
    sceneLayerLibrary: { list: overlayList() },
    onCommand: (command) => {
      commands.push(command);
      if (command.type === "spawn") slots.set(command.actorGuid, command.slotId);
      if (command.type === "despawn") despawnTicks.push(runtime.getWorld().clock.tickIndex);
    },
  });
  await runtime.loadScripts(scripts);
  if (navMesh) await runtime.loadNavMesh(navMesh);
  runtime.start();
  await runtime.realizePlayWorld();
  return { runtime, commands, slots, despawnTicks };
}

function published(runtime: RuntimeDriver) {
  const buf = new Float32Array(snapshotFloatCount(runtime.snapshotCapacity));
  expect(runtime.copySnapshot(buf)).toBe(true);
  const header = readSnapshotHeader(buf);
  const poses = Array.from({ length: header.actorCount }, (_, index) => readActorSlot(buf, index));
  return { header, poses };
}

/** Everything a host consumes except wall-clock timings and the seq-lock counter. */
function comparable(runtime: RuntimeDriver) {
  const { header, poses } = published(runtime);
  return { header: { ...header, scriptMs: 0, physicsMs: 0, seq: 0 }, poses };
}

function slotPose(frame: { poses: ActorSlot[] }, slotId: number | undefined): ActorSlot | undefined {
  return frame.poses.find((entry) => entry.slotId === slotId);
}

/** A root actor with no components is read only by passes that compose every actor. */
function countWholeWorldReads(actor: Actor): () => number {
  let transform = actor.transform;
  let reads = 0;
  Object.defineProperty(actor, "transform", {
    configurable: true,
    get: () => {
      reads += 1;
      return transform;
    },
    set: (value: Actor["transform"]) => {
      transform = value;
    },
  });
  return () => reads;
}

function burst(runtime: RuntimeDriver): void {
  // Over one dt per tick of backlog: advance() runs its four-tick catch-up cap.
  runtime.advance(1);
}

describe("snapshot publishing", () => {
  let navMesh: Uint8Array;

  beforeAll(async () => {
    await initNavigation();
    navMesh = await generateNavMesh({
      positions: [-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, 10],
      indices: [0, 3, 2, 0, 2, 1],
    });
  });

  it("composes the world once per catch-up burst and once per bare tick", async () => {
    const { runtime, slots } = await launch(scene([
      createActor("still", "Still"),
      createActor("mover", "Mover", { classId: "Mover" }),
    ]));
    try {
      const reads = countWholeWorldReads(runtime.getWorld().findActor("still")!);
      burst(runtime);
      expect(runtime.getWorld().clock.tickIndex).toBe(4);
      expect(reads()).toBe(1);
      expect(slotPose(published(runtime), slots.get("mover"))?.position.x).toBe(4);

      runtime.tick();
      runtime.tick();
      expect(reads()).toBe(3);
    } finally {
      runtime.stop();
    }
  });

  it("steers the crowd from NavAgent actors and their ancestors only", async () => {
    // The agent starts at world (-4, 0, -4) under a parent that a script moves
    // every tick; the crowd owns its world pose, so it must follow the path of
    // a root agent placed there.
    const parented = await launch(scene([
      createActor("still", "Still"),
      createActor("base", "Base", { classId: "Mover", ...pose([1, 0, 1]) }),
      createActor("agent", "Agent", { parentId: "base", ...pose([-5, 0, -5]), components: [navAgent] }),
      createActor("rider", "Rider", { parentId: "agent", ...pose([0, 2, 0]) }),
    ]), navMesh);
    const root = await launch(scene([
      createActor("agent", "Agent", { ...pose([-4, 0, -4]), components: [navAgent] }),
    ]), navMesh);
    try {
      for (const { runtime } of [parented, root]) {
        expect(runtime.setNavAgentTarget("agent", { x: 4, y: 0, z: -2 })).toBe(true);
      }
      const reads = countWholeWorldReads(parented.runtime.getWorld().findActor("still")!);
      for (let tick = 0; tick < 30; tick += 1) {
        parented.runtime.tick();
        root.runtime.tick();
      }
      // Only the published frame composes every actor; the crowd no longer does.
      expect(reads()).toBe(30);

      const expected = slotPose(published(root.runtime), root.slots.get("agent"))!;
      const frame = published(parented.runtime);
      const agent = slotPose(frame, parented.slots.get("agent"))!;
      const rider = slotPose(frame, parented.slots.get("rider"))!;
      expect(expected.position.x).toBeGreaterThan(-3.5);
      for (const axis of ["x", "y", "z"] as const) {
        expect(agent.position[axis]).toBeCloseTo(expected.position[axis], 4);
      }
      for (const axis of ["x", "y", "z", "w"] as const) {
        expect(agent.rotation[axis]).toBeCloseTo(expected.rotation[axis], 4);
      }
      // Yaw-only agent rotation leaves the rider's vertical offset unrotated.
      expect(rider.position.x).toBeCloseTo(agent.position.x, 4);
      expect(rider.position.y).toBeCloseTo(agent.position.y + 2, 4);
      expect(rider.position.z).toBeCloseTo(agent.position.z, 4);
      expect(rider.rotation).toEqual(agent.rotation);
    } finally {
      parented.runtime.stop();
      root.runtime.stop();
    }
  });

  it("resolves a duplicated parent guid to its first-spawned actor in the published poses, the crowd and physics", async () => {
    // Both children precede the parents in spawn order, so neither resolution
    // order nor a whole-world pass can pick the first parent by accident. The
    // later copy is offset and turned a quarter about Y.
    const duplicated = await launch(scene([
      createActor("probe", "Probe", { parentId: "base", ...pose([0, 0, 2]), components: [
        { id: "body", classId: "RigidBodyComponent", properties: { motionType: "static", mass: 0, gravityScale: 0 } },
        { id: "collider", classId: "ColliderComponent", properties: { shape: { kind: "sphere", radius: 0.25 } } },
      ] }),
      createActor("agent", "Agent", { parentId: "base", ...pose([-5, 0, -5]), components: [navAgent] }),
      createActor("base", "Base", pose([1, 0, 1])),
      createActor("base", "Base Copy", pose([3, 0, -3], [0, Math.SQRT1_2, 0, Math.SQRT1_2])),
    ]), navMesh);
    // The first Base places the agent at world (-4, 0, -4); the copy would place it at (-2, 0, 2).
    const root = await launch(scene([
      createActor("agent", "Agent", { ...pose([-4, 0, -4]), components: [navAgent] }),
    ]), navMesh);
    try {
      for (const { runtime } of [duplicated, root]) {
        expect(runtime.setNavAgentTarget("agent", { x: 4, y: 0, z: -2 })).toBe(true);
      }
      for (let tick = 0; tick < 30; tick += 1) {
        duplicated.runtime.tick();
        root.runtime.tick();
      }
      const frame = published(duplicated.runtime);
      // The guid's one render slot carries the first Base's pose, written once.
      const base = frame.poses.filter((entry) => entry.slotId === duplicated.slots.get("base"));
      expect(base).toHaveLength(1);
      expect(base[0]!.position).toEqual({ x: 1, y: 0, z: 1 });
      expect(base[0]!.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
      const probe = slotPose(frame, duplicated.slots.get("probe"))!;
      expect(probe.position.x).toBeCloseTo(1, 5);
      expect(probe.position.y).toBeCloseTo(0, 5);
      expect(probe.position.z).toBeCloseTo(3, 5);

      const physics = duplicated.runtime.getPhysicsSync()!.getBackend();
      expect(physics.sphereOverlap({ x: 1, y: 0, z: 3 }, 0.1).actorIds).toEqual(["probe"]);
      expect(physics.sphereOverlap({ x: 5, y: 0, z: -3 }, 0.1).actorIds).toEqual([]);

      const expected = slotPose(published(root.runtime), root.slots.get("agent"))!;
      const agent = slotPose(frame, duplicated.slots.get("agent"))!;
      expect(expected.position.x).toBeGreaterThan(-3.5);
      for (const axis of ["x", "y", "z"] as const) {
        expect(agent.position[axis]).toBeCloseTo(expected.position[axis], 4);
      }
    } finally {
      duplicated.runtime.stop();
      root.runtime.stop();
    }
  });

  it("publishes a burst's final tick after despawning actors removed in earlier ticks", async () => {
    const { runtime, commands, slots, despawnTicks } = await launch(scene([
      createActor("doomed", "Doomed", { classId: "Doomed" }),
      createActor("mover", "Mover", { classId: "Mover" }),
    ]));
    try {
      const doomedSlot = slots.get("doomed");
      burst(runtime);
      expect(commands.filter((command) => command.type === "despawn")).toEqual([
        { type: "despawn", slotId: doomedSlot, actorGuid: "doomed" },
      ]);
      // Doomed destroys itself in the third tick (ctx.tickIndex 2), before the burst ends.
      expect(despawnTicks).toEqual([3]);
      const frame = published(runtime);
      expect(frame.header.tickIndex).toBe(4);
      expect(frame.poses.map((entry) => entry.slotId)).toEqual([slots.get("mover")]);
      expect(slotPose(frame, slots.get("mover"))?.position.x).toBe(4);
    } finally {
      runtime.stop();
    }
  });

  it.each([
    ["pauses the session", "Pauser"],
    ["starts a blocking stream load", "Blocker"],
  ])("still publishes the last simulated tick when a burst tick %s", async (_label, classId) => {
    // The interrupting actor ticks first in the third tick (ctx.tickIndex 2). A pause lets
    // that tick finish and publish; a blocking load stops the Mover and skips the publish.
    const actors = () => [
      createActor("interrupt", "Interrupt", { classId }),
      createActor("mover", "Mover", { classId: "Mover" }),
      streamTarget(),
    ];
    const deferred = await launch(scene(actors()));
    const perTick = await launch(scene(actors()));
    try {
      burst(deferred.runtime);
      for (let tick = 0; tick < 4; tick += 1) perTick.runtime.tick();
      const lastTick = classId === "Pauser" ? 3 : 2;
      expect(deferred.runtime.getWorld().clock.tickIndex).toBe(3);
      const frame = published(deferred.runtime);
      expect(frame.header.tickIndex).toBe(lastTick);
      expect(slotPose(frame, deferred.slots.get("mover"))?.position.x).toBe(lastTick);
      expect(comparable(deferred.runtime)).toEqual(comparable(perTick.runtime));
    } finally {
      deferred.runtime.stop();
      perTick.runtime.stop();
    }
  });

  it("leaves removals from a tick stopped by a blocking load to the next publish", async () => {
    // Doomed destroys itself in the third tick (ctx.tickIndex 2), then the Blocker's
    // load stops that tick before its publish point.
    const actors = () => [
      createActor("doomed", "Doomed", { classId: "Doomed" }),
      createActor("blocker", "Blocker", { classId: "Blocker" }),
      createActor("mover", "Mover", { classId: "Mover" }),
      streamTarget(),
    ];
    const deferred = await launch(scene(actors()));
    const perTick = await launch(scene(actors()));
    const lifecycle = (commands: CommandMessage[]) =>
      commands.filter((command) => command.type === "spawn" || command.type === "despawn");
    try {
      burst(deferred.runtime);
      for (let tick = 0; tick < 4; tick += 1) perTick.runtime.tick();
      for (const { runtime, commands } of [deferred, perTick]) {
        expect(runtime.getWorld().findActor("doomed")).toBeUndefined();
        expect(commands.some((command) => command.type === "despawn")).toBe(false);
      }
      // Doomed keeps its slot until the streamed scene's readiness publish, so the
      // streamed actor cannot take it over.
      for (const { commands } of [deferred, perTick]) {
        await vi.waitFor(() => expect(commands.some((command) => command.type === "sceneStreamRealized")).toBe(true));
      }
      expect(lifecycle(deferred.commands)).toEqual(lifecycle(perTick.commands));
      expect(deferred.commands.filter((command) => command.type === "despawn")).toEqual([
        { type: "despawn", slotId: deferred.slots.get("doomed"), actorGuid: "doomed" },
      ]);
      expect(comparable(deferred.runtime)).toEqual(comparable(perTick.runtime));
    } finally {
      deferred.runtime.stop();
      perTick.runtime.stop();
    }
  });

  it("lays out overlay actors moved by a tick stopped by a blocking load before writing the burst", async () => {
    const playScene = () => ({
      ...scene([streamTarget()]),
      settings: { ...createDefaultSceneSettings(), sceneLayers: [{ assetGuid: "list", zOrder: 0, enabled: true }] },
    });
    const deferred = await launch(playScene());
    const perTick = await launch(playScene());
    try {
      const before = slotPose(published(deferred.runtime), deferred.slots.get("second"));
      expect(before).toBeDefined();
      burst(deferred.runtime);
      for (let tick = 0; tick < 4; tick += 1) perTick.runtime.tick();
      // The row moved itself in the third tick (ctx.tickIndex 2); the box puts it back.
      const frame = published(deferred.runtime);
      expect(frame.header.tickIndex).toBe(2);
      expect(slotPose(frame, deferred.slots.get("second"))).toEqual(before);
      expect(comparable(deferred.runtime)).toEqual(comparable(perTick.runtime));
    } finally {
      deferred.runtime.stop();
      perTick.runtime.stop();
    }
  });

  it("catch-up bursts publish the frames per-tick publishing would", async () => {
    const yaw30: [number, number, number, number] = [0, Math.sin(Math.PI / 12), 0, Math.cos(Math.PI / 12)];
    const actors = () => [
      createActor("pivot", "Pivot", { classId: "Mover", ...pose([2, 0, -1], yaw30, [2, 2, 2]) }),
      createActor("arm", "Arm", { parentId: "pivot", ...pose([1, 0.5, 0], yaw30) }),
      createActor("hand", "Hand", { parentId: "arm", ...pose([0, 0, 1]) }),
      createActor("base", "Base", pose([1, 0, 1])),
      createActor("agent", "Agent", { parentId: "base", ...pose([-5, 0, -5]), components: [navAgent] }),
      createActor("rider", "Rider", { parentId: "agent", ...pose([0, 2, 0]) }),
      createActor("walker", "Walker", { ...pose([3, 0, -3]), components: [navAgent] }),
      createActor("late", "Late", { classId: "LateDoomed", ...pose([0, 1, 0]) }),
      createActor("orphan", "Orphan", { parentId: "late", ...pose([0, 1, 0]) }),
      createActor("spawner", "Spawner", { classId: "Spawner" }),
    ];
    const deferred = await launch(scene(actors()), navMesh);
    const perTick = await launch(scene(actors()), navMesh);
    const lifecycle = (commands: CommandMessage[]) =>
      commands.filter((command) => command.type === "spawn" || command.type === "despawn");
    try {
      for (const { runtime } of [deferred, perTick]) {
        expect(runtime.setNavAgentTarget("agent", { x: 4, y: 0, z: 4 })).toBe(true);
        expect(runtime.setNavAgentTarget("walker", { x: -4, y: 0, z: 4 })).toBe(true);
      }
      for (let round = 0; round < 5; round += 1) {
        burst(deferred.runtime);
        for (let tick = 0; tick < 4; tick += 1) perTick.runtime.tick();
        expect(comparable(deferred.runtime)).toEqual(comparable(perTick.runtime));
      }
      expect(deferred.runtime.getWorld().clock.tickIndex).toBe(20);
      expect(lifecycle(deferred.commands)).toEqual(lifecycle(perTick.commands));
      // Late destroys itself in the second burst's third tick (ctx.tickIndex 6).
      expect(deferred.despawnTicks).toEqual([7]);
    } finally {
      deferred.runtime.stop();
      perTick.runtime.stop();
    }
  });
});
