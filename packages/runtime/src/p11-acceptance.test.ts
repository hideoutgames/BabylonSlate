import { beforeAll, describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  readActorSlot,
  snapshotFloatCount,
} from "@babylonslate/bridge";
import {
  createActor,
  createDefaultSceneSettings,
  type SerializedScene,
} from "@babylonslate/core";
import {
  encodeTraceDocument,
  decodeTraceDocument,
} from "@babylonslate/assets";
import type { BehaviourTreeDocument } from "@babylonslate/behaviour-tree";
import {
  generateNavMesh,
  initNavigation,
  recastWalkableQuadFromXy,
} from "@babylonslate/navigation";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

function groundPrism(): { positions: number[]; indices: number[] } {
  const half = 10;
  return {
    positions: [
      -half, 0, -half,
      half, 0, -half,
      half, 0, half,
      -half, 0, half,
    ],
    indices: [0, 3, 2, 0, 2, 1],
  };
}

function patrolTree(): BehaviourTreeDocument {
  return {
    name: "Patrol",
    rootId: "root",
    blackboardGuid: null,
    nodes: [
      {
        id: "root",
        kind: "selector",
        classId: "bt.composite.selector",
        children: ["alert", "move"],
        decorators: [],
        services: [],
        properties: {},
      },
      {
        id: "alert",
        kind: "sequence",
        classId: "bt.composite.sequence",
        children: ["poke"],
        decorators: [
          {
            id: "watch",
            classId: "bt.decorator.blackboardIsSet",
            abortMode: "lowerPriority",
            observedKeys: ["alert"],
            properties: { key: "alert" },
          },
        ],
        services: [],
        properties: {},
      },
      {
        id: "poke",
        kind: "task",
        classId: "bt.task.succeed",
        children: [],
        decorators: [],
        services: [],
        properties: {},
      },
      {
        id: "move",
        kind: "task",
        classId: "BTTask_MoveTo",
        children: [],
        decorators: [],
        services: [],
        properties: { destination: { x: 4, y: 0, z: 4 }, acceptRadius: 1.5 },
      },
    ],
  };
}

function throwTree(): BehaviourTreeDocument {
  return {
    name: "Throw",
    rootId: "boom",
    blackboardGuid: null,
    nodes: [
      {
        id: "boom",
        kind: "task",
        classId: "BTTask_Boom",
        children: [],
        decorators: [],
        services: [],
        properties: {},
      },
    ],
  };
}

function agentScene(
  viewportMode: "2d" | "3d",
  extras: SerializedScene["actors"] = [],
): SerializedScene {
  return {
    name: viewportMode === "2d" ? "Nav2d" : "Nav3d",
    viewportMode,
    settings: createDefaultSceneSettings(viewportMode),
    actors: [
      createActor("guard", "Guard", {
        transform: {
          position: viewportMode === "2d" ? [-4, -4, 0] : [-4, 0, -4],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          {
            id: "nav",
            classId: "NavAgentComponent",
            properties: { radius: 0.5, height: 2, maxSpeed: 3.5 },
          },
          {
            id: "bt",
            classId: "BehaviourTreeComponent",
            properties: { treeGuid: "tree-1" },
          },
        ],
      }),
      ...extras,
    ],
  };
}

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node ${typeId}`);
  return {
    id,
    typeId,
    position: { x: 0, y: 0 },
    pins: def.pins(properties),
    properties,
  };
}

function throwingTaskScript(): CompiledScript {
  const registry = createDefaultNodeRegistry();
  const graph: LogicGraph = {
    id: "event-graph",
    kind: "event",
    nodes: [
      node(registry, "tick", "bt.event.tick"),
      node(registry, "js", "debug.executeJavaScript", {
        body: "throw new Error('BT task boom');",
        inputs: [],
        outputs: [],
      }),
    ],
    edges: [
      {
        id: "e1",
        sourceNodeId: "tick",
        sourcePinId: "execOut",
        targetNodeId: "js",
        targetPinId: "execIn",
      },
    ],
  };
  const compiled = compileGraph(graph, { assetGuid: "boom-class", registry });
  return {
    assetGuid: "boom-class",
    classId: "BTTask_Boom",
    source: compiled.source,
    anchors: compiled.anchors,
    entryPoints: compiled.entryPoints,
  };
}

function agentX(runtime: ReturnType<typeof createInProcessRuntime>): number {
  const buf = new Float32Array(snapshotFloatCount(8));
  runtime.copySnapshot(buf);
  return readActorSlot(buf, 0).position.x;
}

describe("P11 §18 acceptance", () => {
  let soloBytes: Uint8Array;
  let tileBytes: Uint8Array;
  let floor2d: Uint8Array;

  beforeAll(async () => {
    await initNavigation();
    soloBytes = await generateNavMesh(groundPrism());
    tileBytes = await generateNavMesh({
      ...groundPrism(),
      settings: { supportDynamicObstacles: true },
    });
    floor2d = await generateNavMesh({
      ...recastWalkableQuadFromXy({
        minX: -10,
        minY: -10,
        maxX: 10,
        maxY: 10,
      }),
      settings: { supportDynamicObstacles: true },
    });
  });

  it("patrols a baked 3D navmesh with the same visual-scripted tree", async () => {
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 8,
      seedDemoActors: false,
      playScene: agentScene("3d"),
      behaviourTrees: { "tree-1": patrolTree() },
    });
    await runtime.loadNavMesh(soloBytes);
    runtime.start();
    runtime.realizePlayWorld();
    for (let i = 0; i < 180; i += 1) runtime.tick();
    expect(agentX(runtime)).toBeGreaterThan(-3);
    runtime.stop();
  });

  it("patrols a baked 2D navmesh with the same tree", async () => {
    const tree = patrolTree();
    const move = tree.nodes.find((node) => node.id === "move");
    if (move) {
      move.properties = { destination: { x: 4, y: 4, z: 0 }, acceptRadius: 1.5 };
    }
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 8,
      seedDemoActors: false,
      playScene: agentScene("2d"),
      behaviourTrees: { "tree-1": tree },
    });
    await runtime.loadNavMesh(floor2d);
    runtime.start();
    runtime.realizePlayWorld();
    for (let i = 0; i < 180; i += 1) runtime.tick();
    expect(agentX(runtime)).toBeGreaterThan(-3);
    runtime.stop();
  });

  it("reacts to a dynamic obstacle closing the straight route", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 8,
      seedDemoActors: false,
      playScene: agentScene("3d"),
      behaviourTrees: { "tree-1": patrolTree() },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadNavMesh(tileBytes);
    runtime.start();
    runtime.realizePlayWorld();
    const open = runtime.findNavPath(
      { x: -4, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
    );
    expect(open.length).toBeGreaterThan(1);
    expect(Math.max(...open.map((point) => Math.abs(point.z)))).toBeLessThan(1);

    for (let i = 0; i < 12; i += 1) runtime.tick();
    expect(commands.filter((command) => command.type === "btState").at(-1)).toMatchObject({
      type: "btState",
      btNodeId: "move",
    });

    runtime.addNavObstacle("box", { x: 0, y: 1, z: 0 }, { x: 2, y: 2, z: 8 });
    const closed = runtime.findNavPath(
      { x: -4, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
    );
    expect(closed.length).toBeGreaterThan(open.length);
    expect(Math.max(...closed.map((point) => Math.abs(point.z)))).toBeGreaterThan(1.5);

    const samples: Array<{ x: number; z: number }> = [];
    for (let i = 0; i < 160; i += 1) {
      runtime.tick();
      const buf = new Float32Array(snapshotFloatCount(8));
      runtime.copySnapshot(buf);
      const slot = readActorSlot(buf, 0);
      samples.push({ x: slot.position.x, z: slot.position.z });
    }
    expect(
      samples.some((point) => Math.abs(point.x) < 1 && Math.abs(point.z) < 1),
    ).toBe(false);
    expect(agentX(runtime)).toBeGreaterThan(-3);
    runtime.stop();
  });

  it("aborts a running MoveTo when a blackboard key changes", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 8,
      seedDemoActors: false,
      dt: 1 / 30,
      playScene: agentScene("3d"),
      behaviourTrees: { "tree-1": patrolTree() },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadNavMesh(soloBytes);
    runtime.start();
    runtime.realizePlayWorld();
    runtime.executeConsoleCommand("snapshot start");
    for (let i = 0; i < 20; i += 1) runtime.tick();
    const running = commands.filter((command) => command.type === "btState").at(-1);
    expect(running).toMatchObject({ type: "btState", btNodeId: "move" });
    runtime.executeConsoleCommand("snapshot stop");
    const payload = runtime.stopTrace();
    const last = payload?.frames.at(-1)?.bt?.[0];
    expect(last).toBeDefined();
    runtime.restoreBtFromTrace([
      {
        ...last!,
        blackboard: { ...last!.blackboard, alert: true },
      },
    ]);
    runtime.tick();
    const aborted = commands.filter((command) => command.type === "btState").at(-1);
    expect(aborted).toMatchObject({ type: "btState", status: "success" });
    expect(aborted && aborted.type === "btState" ? aborted.btNodeId : "move").not.toBe(
      "move",
    );
    runtime.stop();
  });

  it("a visual-scripted task throw reports btNodeId on the session diagnostic", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      playScene: {
        name: "Throw",
        viewportMode: "3d",
        settings: createDefaultSceneSettings(),
        actors: [
          createActor("guard", "Guard", {
            components: [
              {
                id: "bt",
                classId: "BehaviourTreeComponent",
                properties: { treeGuid: "tree-1" },
              },
            ],
          }),
        ],
      },
      behaviourTrees: { "tree-1": throwTree() },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([throwingTaskScript()]);
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    const diag = runtime.getDiagnostics().entries().find(
      (entry) => entry.btNodeId === "boom",
    );
    expect(diag?.message).toMatch(/boom/i);
    expect(diag?.assetGuid).toBe("tree-1");
    expect(
      commands.some(
        (command) =>
          command.type === "diagnostic" && command.btNodeId === "boom",
      ),
    ).toBe(true);
    runtime.stop();
  });

  it("replays recorded BT decisions from a .babtrace payload", async () => {
    const options = {
      seed: 1,
      maxActors: 8,
      seedDemoActors: false as const,
      dt: 1 / 30,
      playScene: agentScene("3d"),
      behaviourTrees: { "tree-1": patrolTree() },
    };
    const recorded = createInProcessRuntime(options);
    await recorded.loadNavMesh(soloBytes);
    recorded.start();
    recorded.realizePlayWorld();
    recorded.executeConsoleCommand("snapshot start");
    for (let i = 0; i < 24; i += 1) recorded.tick();
    recorded.executeConsoleCommand("snapshot stop");
    const payload = recorded.stopTrace();
    expect(payload?.frames.some((frame) => frame.bt?.[0]?.btNodeId === "move")).toBe(
      true,
    );
    const encoded = await encodeTraceDocument({
      name: "p11",
      guid: "trace-1",
      payload: payload as unknown as Record<string, unknown>,
    });
    const decoded = await decodeTraceDocument(encoded);
    const restoredFrames = (
      decoded.payload as { frames: NonNullable<typeof payload>["frames"] }
    ).frames;
    const last = restoredFrames.at(-1)?.bt?.[0];
    expect(last?.btNodeId).toBe("move");
    recorded.stop();

    const replay = createInProcessRuntime(options);
    await replay.loadNavMesh(soloBytes);
    replay.start();
    replay.realizePlayWorld();
    replay.restoreBtFromTrace(restoredFrames.at(-1)!.bt!);
    replay.executeConsoleCommand("snapshot start");
    replay.tick();
    replay.executeConsoleCommand("snapshot stop");
    const continued = replay.stopTrace()?.frames[0]?.bt?.[0];
    expect(continued?.btNodeId).toBe("move");
    expect(continued?.stack.some((frame) => frame.nodeId === "move")).toBe(true);
    replay.stop();
  });
});
