import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import type { BehaviourTreeDocument } from "@babylonslate/behaviour-tree";
import { createActor, createDefaultSceneSettings } from "@babylonslate/core";
import { generateNavMesh, initNavigation } from "@babylonslate/navigation";
import { createInProcessRuntime } from "./driver";

describe("Move To Blackboard Key", () => {
  let bytes: Uint8Array;
  const runtimes: ReturnType<typeof createInProcessRuntime>[] = [];

  beforeAll(async () => {
    await initNavigation();
    bytes = await generateNavMesh({
      positions: [-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, 10],
      indices: [0, 3, 2, 0, 2, 1],
    });
  });

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.stop();
  });

  async function setup(value: unknown, override?: unknown) {
    const commands: CommandMessage[] = [];
    const tree: BehaviourTreeDocument = {
      name: "Follow Target",
      rootId: "move",
      blackboardGuid: "board",
      nodes: [{
        id: "move", kind: "task", classId: "BTTask_MoveToBlackboardKey",
        children: [], decorators: [], services: [],
        properties: { key: "target", acceptRadius: 0.7 },
      }],
    };
    const runtime = createInProcessRuntime({
      seed: 1, dt: 1 / 30, maxActors: 8, seedDemoActors: false,
      onCommand: (command) => commands.push(command),
      playScene: {
        name: "Blackboard Navigation", viewportMode: "3d",
        settings: createDefaultSceneSettings(), folders: [],
        actors: [
          createActor("guard", "Guard", {
            transform: { position: [-4, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            components: [
              { id: "nav", classId: "NavAgentComponent", properties: { radius: 0.5, height: 2, maxSpeed: 3.5 } },
              { id: "bt", classId: "BehaviourTreeComponent", properties: override === undefined
                ? { treeGuid: "tree" }
                : { treeGuid: "tree", blackboardGuid: "override" } },
            ],
          }),
          createActor("parent", "Parent", {
            transform: { position: [3, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          }),
          createActor("target", "Target", {
            parentId: "parent",
            transform: { position: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            components: [
              {
                id: "anchor", classId: "MeshComponent", properties: {},
                transform: { position: [0.5, 1.5, 0], rotation: [0, 0, 0, 1], scale: [2, 1, 1] },
              },
              {
                id: "point", classId: "MeshComponent", parentId: "anchor", properties: {},
                transform: { position: [0.25, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              },
            ],
          }),
        ],
      },
      behaviourTrees: { tree },
      blackboards: {
        board: { name: "Targets", keys: [{ name: "target", type: { kind: "vec3" }, defaultValue: value }] },
        override: { name: "Override", keys: [{ name: "target", type: { kind: "vec3" }, defaultValue: override }] },
      },
    });
    runtimes.push(runtime);
    await runtime.loadNavMesh(bytes);
    runtime.start();
    runtime.realizePlayWorld();
    return { runtime, commands };
  }

  it.each([
    { name: "Vector", value: { x: 4, y: 0, z: 0 } },
    { name: "Vector 2D", value: { x: 4, y: 0 } },
  ])("navigates to a $name default from the tree's linked Blackboard", async ({ value }) => {
    const { runtime, commands } = await setup(value);
    for (let i = 0; i < 120; i += 1) runtime.tick();
    expect(runtime.getWorld().findActor("guard")!.transform.position.x).toBeGreaterThan(3.2);
    expect(commands.filter((command) => command.type === "btState").at(-1)).toMatchObject({ status: "success" });
  });

  it("honors the component's Blackboard override", async () => {
    const { runtime } = await setup({ x: 4, y: 0, z: 0 }, { x: -7, y: 0, z: 0 });
    for (let i = 0; i < 90; i += 1) runtime.tick();
    expect(runtime.getWorld().findActor("guard")!.transform.position.x).toBeLessThan(-6.2);
  });

  it.each([
    { kind: "actor", reference: "target", minimumX: 3.2 },
    { kind: "component", reference: 'ctx.getComponentById(target, "point")', minimumX: 4.2 },
  ])("uses a live $kind target spawned by its service in the same tick", async ({ reference, minimumX }) => {
    const { runtime, commands } = await setup(null);
    await runtime.loadScripts([
      {
        assetGuid: "spawned-target", classId: "SpawnedTarget", parentClassId: "Actor",
        source: "", anchors: [], entryPoints: [],
        components: [{
          id: "point", classId: "MeshComponent", properties: {},
          transform: { position: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        }],
      },
      {
        assetGuid: "spawn-service", classId: "SpawnTargetService", parentClassId: "BTService",
        anchors: [], entryPoints: [{ name: "onBtTick", event: "onBtTick", isAsync: false }],
        source: `export function onBtTick(ctx) {
          if (ctx.getBlackboard("target")) return;
          const target = ctx.spawnActor("SpawnedTarget", { position: { x: 4, y: 0, z: 0 } });
          ctx.setBlackboard("target", ${reference});
        }`,
      },
    ]);
    runtime.registerBehaviourTree("tree", {
      name: "Spawn And Follow", rootId: "move", blackboardGuid: "board",
      nodes: [{
        id: "move", kind: "task", classId: "BTTask_MoveToBlackboardKey",
        children: [], decorators: [], properties: { key: "target", acceptRadius: 0.7 },
        services: [{
          id: "spawn", classId: "SpawnTargetService", intervalMs: 0,
          randomDeviationMs: 0, properties: {},
        }],
      }],
    });
    runtime.tick();
    expect(runtime.getWorld().getActors().some((actor) => actor.classId === "SpawnedTarget")).toBe(true);
    expect(commands.filter((command) => command.type === "btState").at(-1)).toMatchObject({ status: "running" });
    for (let i = 0; i < 120; i += 1) runtime.tick();
    expect(runtime.getWorld().findActor("guard")!.transform.position.x).toBeGreaterThan(minimumX);
  });

  it("follows a live component reference in world space and records safe reference telemetry", async () => {
    const { runtime, commands } = await setup(null);
    const target = runtime.getWorld().findActor("target")!;
    const point = target.components.find((component) => component.sourceId === "point" || component.guid === "point")!;
    runtime.registerBlackboard("board", {
      name: "Targets", keys: [{ name: "target", type: { kind: "objectRef", classId: "BObject" }, defaultValue: point }],
    });
    runtime.executeConsoleCommand("snapshot start");
    for (let i = 0; i < 20; i += 1) runtime.tick();
    target.transform.position.x = 3;
    for (let i = 0; i < 180; i += 1) runtime.tick();
    expect(runtime.getWorld().findActor("guard")!.transform.position.x).toBeGreaterThan(6.2);
    expect(commands.filter((command) => command.type === "btState").at(-1)).toMatchObject({
      status: "success", blackboard: { target: { guid: point.guid, classId: "MeshComponent" } },
    });
    runtime.executeConsoleCommand("snapshot stop");
    const trace = runtime.stopTrace()!;
    expect(() => JSON.stringify(trace)).not.toThrow();
    runtime.restoreBtFromTrace(trace.frames.at(-1)!.bt!);
    target.transform.position.x = 1;
    for (let i = 0; i < 90; i += 1) runtime.tick();
    expect(runtime.getWorld().findActor("guard")!.transform.position.x).toBeLessThan(5.8);
  });

  it("stops and fails when the referenced actor is destroyed", async () => {
    const { runtime, commands } = await setup(null);
    const target = runtime.getWorld().findActor("target")!;
    runtime.registerBlackboard("board", {
      name: "Targets", keys: [{ name: "target", type: { kind: "actorRef", classId: "Actor" }, defaultValue: target }],
    });
    for (let i = 0; i < 20; i += 1) runtime.tick();
    const stoppedAt = runtime.getWorld().findActor("guard")!.transform.position.x;
    expect(stoppedAt).toBeGreaterThan(-3.5);
    runtime.getWorld().destroyActor(target.guid);
    for (let i = 0; i < 60; i += 1) runtime.tick();
    const brakedAt = runtime.getWorld().findActor("guard")!.transform.position.x;
    expect(brakedAt).toBeLessThan(3);
    for (let i = 0; i < 60; i += 1) runtime.tick();
    expect(runtime.getWorld().findActor("guard")!.transform.position.x).toBeCloseTo(brakedAt, 3);
    expect(commands.filter((command) => command.type === "btState").at(-1)).toMatchObject({ status: "failure" });
  });

  it.each([null, true, { x: 4, y: NaN, z: 0 }, { guid: "missing", classId: "Actor" }])(
    "fails safely for invalid or unset target %j", async (value) => {
      const { runtime, commands } = await setup(value);
      for (let i = 0; i < 10; i += 1) runtime.tick();
      expect(runtime.getWorld().findActor("guard")!.transform.position.x).toBeCloseTo(-4);
      expect(commands.filter((command) => command.type === "btState").at(-1)).toMatchObject({ status: "failure" });
    },
  );
});
