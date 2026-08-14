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
  BOOL,
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

function compileBtClass(
  classId: string,
  assetGuid: string,
  build: (registry: NodeRegistry) => LogicGraph,
): CompiledScript {
  const registry = createDefaultNodeRegistry();
  const compiled = compileGraph(build(registry), { assetGuid, registry });
  return {
    assetGuid,
    classId,
    source: compiled.source,
    anchors: compiled.anchors,
    entryPoints: compiled.entryPoints,
  };
}

function throwingTaskScript(): CompiledScript {
  return compileBtClass("BTTask_Boom", "boom-class", (registry) => ({
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
  }));
}

function blockingDecoratorScript(): CompiledScript {
  return compileBtClass("BTDecorator_Alert", "alert-class", (registry) => ({
    id: "event-graph",
    kind: "event",
    nodes: [
      node(registry, "eval", "bt.event.evaluate"),
      node(registry, "ret", "bt.returnCondition", {
        "default:condition": false,
      }),
    ],
    edges: [
      {
        id: "e1",
        sourceNodeId: "eval",
        sourcePinId: "execOut",
        targetNodeId: "ret",
        targetPinId: "execIn",
      },
    ],
  }));
}

function abortHoldTaskScript(): CompiledScript {
  return compileBtClass("BTTask_Hold", "hold-class", (registry) => ({
    id: "event-graph",
    kind: "event",
    nodes: [
      node(registry, "tick", "bt.event.tick"),
      node(registry, "abort", "bt.event.abort"),
      node(registry, "log", "debug.log", {
        message: "aborted",
        severity: "log",
        category: "BT",
      }),
    ],
    edges: [
      {
        id: "e1",
        sourceNodeId: "abort",
        sourcePinId: "execOut",
        targetNodeId: "log",
        targetPinId: "execIn",
      },
    ],
  }));
}

function pulseServiceScript(): CompiledScript {
  return compileBtClass("BTService_Pulse", "pulse-class", (registry) => ({
    id: "event-graph",
    kind: "event",
    nodes: [
      node(registry, "tick", "bt.event.tick"),
      node(registry, "set", "bt.blackboard.set", {
        "default:key": "pulse",
        "default:value": true,
      }),
    ],
    edges: [
      {
        id: "e1",
        sourceNodeId: "tick",
        sourcePinId: "execOut",
        targetNodeId: "set",
        targetPinId: "execIn",
      },
    ],
  }));
}

function classScene(
  treeGuid: string,
  blackboardGuid?: string,
): SerializedScene {
  return {
    name: "BtClass",
    viewportMode: "3d",
    settings: createDefaultSceneSettings(),
    actors: [
      createActor("guard", "Guard", {
        components: [
          {
            id: "bt",
            classId: "BehaviourTreeComponent",
            properties: blackboardGuid
              ? { treeGuid, blackboardGuid }
              : { treeGuid },
          },
        ],
      }),
    ],
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

  it("fails a Wait when a subclassed decorator returns false from On Evaluate", async () => {
    const commands: CommandMessage[] = [];
    const tree: BehaviourTreeDocument = {
      name: "Gated",
      rootId: "wait",
      blackboardGuid: null,
      nodes: [
        {
          id: "wait",
          kind: "task",
          classId: "bt.task.wait",
          children: [],
          decorators: [
            {
              id: "gate",
              classId: "BTDecorator_Alert",
              abortMode: "none",
              observedKeys: [],
              properties: {},
            },
          ],
          services: [],
          properties: { durationMs: 10_000 },
        },
      ],
    };
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      playScene: classScene("tree-1"),
      behaviourTrees: { "tree-1": tree },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([blockingDecoratorScript()]);
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    const state = commands.filter((command) => command.type === "btState").at(-1);
    expect(state).toMatchObject({ type: "btState", status: "failure" });
    runtime.stop();
  });

  it("fires On Abort when a running custom task is popped", async () => {
    const commands: CommandMessage[] = [];
    const tree: BehaviourTreeDocument = {
      name: "Hold",
      rootId: "root",
      blackboardGuid: null,
      nodes: [
        {
          id: "root",
          kind: "sequence",
          classId: "bt.composite.sequence",
          children: ["hold"],
          decorators: [
            {
              id: "alive",
              classId: "bt.decorator.blackboardIsSet",
              abortMode: "self",
              observedKeys: ["ok"],
              properties: { key: "ok" },
            },
          ],
          services: [],
          properties: {},
        },
        {
          id: "hold",
          kind: "task",
          classId: "BTTask_Hold",
          children: [],
          decorators: [],
          services: [],
          properties: {},
        },
      ],
    };
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      dt: 0.05,
      playScene: classScene("tree-1", "bb-1"),
      behaviourTrees: { "tree-1": tree },
      blackboards: {
        "bb-1": {
          name: "Guard",
          keys: [{ name: "ok", type: BOOL, defaultValue: true }],
        },
      },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([abortHoldTaskScript()]);
    runtime.start();
    runtime.realizePlayWorld();
    runtime.executeConsoleCommand("snapshot start");
    runtime.tick();
    const running = commands.filter((command) => command.type === "btState").at(-1);
    expect(running).toMatchObject({ type: "btState", status: "running", btNodeId: "hold" });
    runtime.executeConsoleCommand("snapshot stop");
    const payload = runtime.stopTrace();
    const last = payload?.frames.at(-1)?.bt?.[0];
    expect(last).toBeDefined();
    runtime.restoreBtFromTrace([
      {
        ...last!,
        blackboard: {},
      },
    ]);
    runtime.tick();
    const logs = commands.filter((command) => command.type === "log");
    expect(
      logs.some(
        (command) => command.type === "log" && String(command.message).includes("aborted"),
      ),
    ).toBe(true);
    runtime.stop();
  });

  it("lets a custom service set a blackboard key from On Tick", async () => {
    const commands: CommandMessage[] = [];
    const tree: BehaviourTreeDocument = {
      name: "Pulse",
      rootId: "root",
      blackboardGuid: null,
      nodes: [
        {
          id: "root",
          kind: "sequence",
          classId: "bt.composite.sequence",
          children: ["idle"],
          decorators: [],
          services: [
            {
              id: "pulse",
              classId: "BTService_Pulse",
              intervalMs: 0,
              randomDeviationMs: 0,
              properties: {},
            },
          ],
          properties: {},
        },
        {
          id: "idle",
          kind: "task",
          classId: "bt.task.wait",
          children: [],
          decorators: [],
          services: [],
          properties: { durationMs: 10_000 },
        },
      ],
    };
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      playScene: classScene("tree-1"),
      behaviourTrees: { "tree-1": tree },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([pulseServiceScript()]);
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    const state = commands.filter((command) => command.type === "btState").at(-1);
    expect(state).toMatchObject({
      type: "btState",
      status: "running",
      blackboard: { pulse: true },
    });
    runtime.stop();
  });
});
