import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  readSnapshotHeader,
  snapshotFloatCount,
  type ActorSlot,
  type CommandMessage,
} from "@haptic/bridge";
import { readActorSlot } from "@haptic/bridge/read-actor-slot";
import {
  createActor,
  createDefaultSceneLayer,
  createDefaultSceneSettings,
  type SerializedActor,
  type SerializedScene,
  type SerializedSceneLayer,
} from "@haptic/core";
import { initNavigation } from "@haptic/navigation";
import { generateNavMesh } from "@haptic/navigation/bake";
import { ClassRegistry, World, type Actor } from "@haptic/object-model";
import { createInProcessRuntime, type RuntimeDriver } from "./driver";
import { RenderSlots } from "./render-slots";
import { RuntimeSubsystems } from "./runtime-subsystems";
import type { CompiledScript } from "./script-host";
import { SnapshotPublisher } from "./snapshot-publisher";

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
    seed: 7, maxActors: 32, preferSoftwarePhysics: true,
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

  it("composes only dirty actors once per catch-up burst and once per bare tick", async () => {
    const { runtime, slots } = await launch(scene([
      createActor("still", "Still"),
      createActor("mover", "Mover", { classId: "Mover" }),
    ]));
    try {
      const stillReads = countWholeWorldReads(runtime.getWorld().findActor("still")!);
      const writesBefore = runtime.snapshotSerial;
      burst(runtime);
      expect(runtime.getWorld().clock.tickIndex).toBe(4);
      // Untouched actors are never recomposed on incremental publishes; the burst writes once.
      expect(stillReads()).toBe(0);
      expect(runtime.snapshotSerial - writesBefore).toBe(1);
      expect(slotPose(published(runtime), slots.get("mover"))?.position.x).toBe(4);

      runtime.tick();
      runtime.tick();
      expect(stillReads()).toBe(0);
      expect(runtime.snapshotSerial - writesBefore).toBe(3);
      expect(slotPose(published(runtime), slots.get("mover"))?.position.x).toBe(6);
    } finally {
      runtime.stop();
    }
  });

  it("stops observing the World when the session ends", async () => {
    const dispose = vi.spyOn(SnapshotPublisher.prototype, "dispose");
    const { runtime } = await launch(scene([createActor("still", "Still")]));
    try {
      expect(dispose).not.toHaveBeenCalled();
      runtime.stop();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      runtime.stop();
      dispose.mockRestore();
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
      // Neither the crowd nor incremental snapshot publishing recomposes an untouched root actor.
      expect(reads()).toBe(0);

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

  it("publishes the editor's hierarchy matrices and warns once per sheared actor", async () => {
    // Parent scale (2, 1, 1): a quarter turn about Z permutes it; a 45 degree
    // turn shears, while the grandchild at local (1, 0, 0) keeps its exact place.
    const { runtime, commands, slots } = await launch(scene([
      createActor("parent", "Parent", pose([0, 0, 0], [0, 0, 0, 1], [2, 1, 1])),
      createActor("quarter", "Quarter", { parentId: "parent", ...pose([0, 0, 0], [0, 0, Math.SQRT1_2, Math.SQRT1_2]) }),
      createActor("oblique", "Oblique", { parentId: "parent", ...pose([0, 0, 0], [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)]) }),
      createActor("tip", "Tip", { parentId: "oblique", ...pose([1, 0, 0]) }),
    ]));
    try {
      runtime.tick();
      runtime.tick();
      const frame = published(runtime);
      const quarter = slotPose(frame, slots.get("quarter"))!;
      expect(quarter.scale.x).toBeCloseTo(1, 6);
      expect(quarter.scale.y).toBeCloseTo(2, 6);
      expect(quarter.scale.z).toBeCloseTo(1, 6);
      const tip = slotPose(frame, slots.get("tip"))!;
      expect(tip.position.x).toBeCloseTo(1.414214, 5);
      expect(tip.position.y).toBeCloseTo(0.707107, 5);
      expect(tip.position.z).toBeCloseTo(0, 6);
      const warnings = commands.flatMap((command) =>
        command.type === "log" && command.severity === "warning" ? [command.message] : []);
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toMatch(/^Oblique \(oblique\) has a sheared world transform/);
      expect(warnings[1]).toMatch(/^Tip \(tip\) has a sheared world transform/);
    } finally {
      runtime.stop();
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
    // Scene Layer actor guids are scoped to their layer instance.
    const second = deferred.runtime.getWorld().getSceneLayers()[0]!.guid + ":second";
    try {
      const before = slotPose(published(deferred.runtime), deferred.slots.get(second));
      expect(before).toBeDefined();
      burst(deferred.runtime);
      for (let tick = 0; tick < 4; tick += 1) perTick.runtime.tick();
      // The row moved itself in the third tick (ctx.tickIndex 2); the box puts it back.
      const frame = published(deferred.runtime);
      expect(frame.header.tickIndex).toBe(2);
      expect(slotPose(frame, deferred.slots.get(second))).toEqual(before);
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

describe("snapshot removal pass", () => {
  function publisher(now: () => number = () => 0) {
    const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
    const slots = new RenderSlots(new RuntimeSubsystems(), {
      ensureCapacity: () => {},
      findActor: (guid) => world.findActor(guid),
    });
    const despawns: string[] = [];
    const snapshots = new SnapshotPublisher(4, world, slots, {
      stopped: () => false,
      frameId: () => 0,
      lastScriptMs: () => 0,
      lastPhysicsMs: () => 0,
      canPublish: () => true,
      cameraActor: () => null,
      layerCameraCentre: () => null,
      applyOverlayLayouts: () => {},
      retireDetachedStreams: () => {},
      removedActors: () => {},
      recorder: () => null,
      profilePublish: () => {},
      reportLog: () => {},
      reportError: (error) => { throw error; },
      emit: (command) => { if (command.type === "despawn") despawns.push(command.actorGuid); },
    }, now);
    const actor = (guid: string) => {
      const created = world.createActor({ classId: "Actor", guid });
      slots.allocate(created);
      return created;
    };
    return { world, slots, snapshots, despawns, actor };
  }

  it("checks no slot while neither the World structure nor the slot table changed", () => {
    const { world, snapshots, despawns, actor } = publisher();
    world.spawnActorNow(actor("still"));
    world.spawnActorNow(actor("doomed"));
    snapshots.publish();
    const lookups = vi.spyOn(world, "findActor");
    snapshots.publish();
    snapshots.publish();
    expect(lookups).not.toHaveBeenCalled();

    world.destroyActor("doomed");
    world.flushPending();
    snapshots.publish();
    expect(despawns).toEqual(["doomed"]);
    // Its own release names no other slot to check.
    lookups.mockClear();
    snapshots.publish();
    expect(lookups).not.toHaveBeenCalled();
  });

  it("walks a moved actor's subtree once per publish, not once per coordinate write", () => {
    const { world, slots, snapshots, actor } = publisher();
    const root = world.spawnActorNow(actor("root"));
    const middle = actor("middle");
    middle.setVariable("parentId", root.guid);
    world.spawnActorNow(middle);
    const leaf = actor("leaf");
    leaf.setVariable("parentId", middle.guid);
    world.spawnActorNow(leaf);
    snapshots.publish();

    const children = vi.spyOn(world, "getChildren");
    root.transform.position.x = 1;
    const firstWalk = children.mock.calls.length;
    expect(firstWalk).toBeGreaterThan(0);
    root.transform.position.y = 2;
    root.transform.position.z = 3;
    middle.transform.position.x = 1;
    expect(children).toHaveBeenCalledTimes(firstWalk);

    snapshots.publish();
    const buf = new Float32Array(snapshotFloatCount(snapshots.capacity));
    expect(snapshots.copy(buf)).toBe(true);
    const poses = Array.from({ length: readSnapshotHeader(buf).actorCount }, (_, index) => readActorSlot(buf, index));
    expect(poses.find((entry) => entry.slotId === slots.recordedSlot(leaf))?.position).toEqual({ x: 2, y: 2, z: 3 });
    // The next publish cycle walks again.
    root.transform.position.x = 5;
    expect(children.mock.calls.length).toBeGreaterThan(firstWalk);
  });

  it("reports the mean publish time since it was last read, and the last publish's when none happened since", () => {
    // Each publish reads the clock as it starts and ends: 1 ms, 0 ms, then 2 ms.
    const readings = [0, 1, 10, 10, 20, 22];
    const { snapshots } = publisher(() => readings.shift() ?? 22);
    snapshots.publish();
    snapshots.publish();
    snapshots.publish();
    expect(snapshots.lastPublishMs).toBe(2);
    expect(snapshots.takeMeanPublishMs()).toBe(1);
    expect(snapshots.takeMeanPublishMs()).toBe(2);
  });

  it("keeps checking a spawn-queued actor's slot, so a cancelled spawn despawns without a structural change", () => {
    const { world, snapshots, despawns, actor } = publisher();
    world.spawnActorNow(actor("still"));
    const queued = world.spawnActor(actor("queued"));
    snapshots.publish();
    expect(despawns).toEqual([]);

    const structure = world.structuralRevision;
    world.destroyActorInstance(queued);
    expect(world.structuralRevision).toBe(structure);
    snapshots.publish();
    expect(despawns).toEqual(["queued"]);
  });

  it("propagates incremental transform, descendant, visibility, and floating-origin updates across both seq-lock buffers", () => {
    const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
    let cam: Actor | null = null;
    const slots = new RenderSlots({ releaseSlot: () => {} } as unknown as RuntimeSubsystems, {
      ensureCapacity: (required) => snapshots.ensureCapacity(required),
      findActor: (guid) => world.findActor(guid),
    });
    let frameCounter = 0;
    const snapshots: SnapshotPublisher = new SnapshotPublisher(8, world, slots, {
      stopped: () => false,
      frameId: () => ++frameCounter,
      lastScriptMs: () => 0,
      lastPhysicsMs: () => 0,
      canPublish: () => true,
      cameraActor: () => cam,
      layerCameraCentre: () => null,
      applyOverlayLayouts: () => {},
      retireDetachedStreams: () => {},
      removedActors: () => {},
      recorder: () => null,
      profilePublish: () => {},
      reportLog: () => {},
      reportError: (error) => { throw error; },
      emit: () => {},
    }, () => 0);

    const spawn = (guid: string, x: number, parentId?: string) => {
      const a = world.createActor({
        classId: "Actor",
        guid,
        variables: parentId ? { parentId } : {},
        transform: { position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
      });
      const slotId = slots.allocate(a);
      world.spawnActorNow(a);
      return { actor: a, slotId };
    };

    const readAll = () => {
      const buf = new Float32Array(snapshotFloatCount(snapshots.capacity));
      expect(snapshots.copy(buf)).toBe(true);
      const header = readSnapshotHeader(buf);
      const poses = Array.from({ length: header.actorCount }, (_, i) => readActorSlot(buf, i));
      return { header, poses };
    };

    const s1 = spawn("static", 5);
    const parent = spawn("parent", 1);
    const child = spawn("child", 2, "parent");
    cam = s1.actor;

    // Seed both double buffers.
    snapshots.publish();
    snapshots.publish();

    // Steady frame: untouched static actor transform is never read again.
    const staticReads = countWholeWorldReads(s1.actor);
    parent.actor.transform.position.x = 10;
    child.actor.setVariable("visible", false);

    // Frame A updates buffer 0; Frame B updates buffer 1 with the same pose and visibility.
    for (let frame = 0; frame < 3; frame++) {
      snapshots.publish();
      const snap = readAll();
      expect(slotPose(snap, s1.slotId)?.position.x).toBe(5);
      expect(slotPose(snap, parent.slotId)?.position.x).toBe(10);
      expect(slotPose(snap, child.slotId)?.position.x).toBe(12);
      expect(slotPose(snap, child.slotId)?.flags).toBe(0);
    }
    expect(staticReads()).toBe(0);

    // Floating-origin shift rewrites all rows relative to the new origin across both buffers
    // so readActorSlot reconstructs exact world coordinates (not offset by +2048).
    s1.actor.transform.position.x = 2050;
    for (let frame = 0; frame < 2; frame++) {
      snapshots.publish();
      const snap = readAll();
      expect(snap.header.origin?.x).toBe(2048);
      expect(slotPose(snap, s1.slotId)?.position.x).toBeCloseTo(2050, 4);
      expect(slotPose(snap, parent.slotId)?.position.x).toBeCloseTo(10, 4);
      expect(slotPose(snap, child.slotId)?.position.x).toBeCloseTo(12, 4);
    }
    snapshots.dispose();
  });
});
