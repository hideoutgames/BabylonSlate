import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import { GameInstance } from "@babylonslate/object-model";
import {
  compileGraph,
  pin,
  EXEC,
  FLOAT,
  STRING,
  VEC3,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node definition ${typeId}`);
  return {
    id,
    typeId,
    position: { x: 0, y: 0 },
    pins: def.pins(properties),
    properties,
  };
}

function edge(
  id: string,
  sourceNodeId: string,
  sourcePinId: string,
  targetNodeId: string,
  targetPinId: string,
) {
  return { id, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
}

/**
 * Event Tick → ExecuteJavaScript (advance x by dt) → Set Actor Location → Log.
 * Mirrors the smallest actor a user can script in the editor.
 */
function movingActorGraph(registry: NodeRegistry): LogicGraph {
  const jsProps = {
    inputs: [{ name: "dt", type: FLOAT }],
    outputs: [{ name: "location", type: VEC3 }],
    body: "location = { x: dt * 10, y: 1, z: 0 };",
  };
  return {
    id: "event-graph",
    kind: "event",
    nodes: [
      node(registry, "tick", "flow.event.tick"),
      node(registry, "js", "debug.executeJavaScript", jsProps),
      node(registry, "move", "transform.setLocation"),
      node(registry, "self", "actor.getSelf"),
      node(registry, "log", "debug.log", { category: "Script" }),
    ],
    edges: [
      edge("e1", "tick", "execOut", "js", "execIn"),
      edge("e2", "tick", "deltaSeconds", "js", "in_dt"),
      edge("e3", "js", "execOut", "move", "execIn"),
      edge("e4", "js", "out_location", "move", "location"),
      edge("e5", "self", "out", "move", "target"),
      edge("e6", "move", "execOut", "log", "execIn"),
      edge("e7", "js", "out_location", "log", "message"),
    ],
  };
}

function toScript(
  graph: LogicGraph,
  registry: NodeRegistry,
  classId: string,
  assetGuid: string,
): CompiledScript {
  const compiled = compileGraph(graph, { assetGuid, registry });
  return {
    assetGuid,
    classId,
    source: compiled.source,
    anchors: compiled.anchors,
    entryPoints: compiled.entryPoints,
  };
}

describe("script host runs compiled graphs", () => {
  it("ticks an actor scripted from the node catalog", async () => {
    const registry = createDefaultNodeRegistry();
    const graph = movingActorGraph(registry);
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      dt: 0.1,
      onCommand: (command) => commands.push(command),
    });

    await runtime.loadScripts([
      toScript(graph, registry, "Mover", "mover-asset"),
    ]);
    const actor = runtime.spawnScriptedActor({ classId: "Mover" });
    expect(actor).not.toBeNull();

    runtime.start();
    runtime.tick();

    expect(actor!.transform.position.x).toBeCloseTo(1, 5);
    expect(actor!.transform.position.y).toBeCloseTo(1, 5);
    const logs = commands.filter((c) => c.type === "log");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ category: "Script" });
    expect(String((logs[0] as { message: string }).message)).toContain("x: 1");
  });

  it("ticks moveCharacter on a kinematic body through the compiled graph", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "tick", "flow.event.tick"),
        node(registry, "self", "actor.getSelf"),
        node(registry, "move", "physics.moveCharacter", {
          translation: { x: 1, y: 0, z: 0 },
        }),
      ],
      edges: [
        edge("e1", "tick", "execOut", "move", "execIn"),
        edge("e2", "self", "out", "move", "target"),
      ],
    };
    const runtime = createInProcessRuntime({
      seed: 2,
      seedDemoActors: false,
      dt: 1 / 60,
      preferSoftwarePhysics: true,
      physicsWorld: "2d",
    });
    await runtime.loadScripts([
      toScript(graph, registry, "Walker", "walker-asset"),
    ]);
    const actor = runtime.spawnScriptedActor({ classId: "Walker" });
    expect(actor).not.toBeNull();
    actor!.attachComponent(
      runtime.getWorld().createComponent({
        classId: "RigidBodyComponent",
        variables: { motionType: "kinematic", mass: 1, gravityScale: 0 },
      }),
    );
    actor!.attachComponent(
      runtime.getWorld().createComponent({
        classId: "ColliderComponent",
        variables: {
          shape: { kind: "box2d", halfExtents: { x: 0.4, y: 0.4 } },
        },
      }),
    );

    runtime.start();
    runtime.tick();

    expect(actor!.transform.position.x).toBeCloseTo(1, 5);
    runtime.stop();
  });

  it("emits Begin Play prints once and maps runtime errors to graph nodes", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "print", "debug.print", {
          value: "ready",
          key: "status",
          duration: 2,
        }),
      ],
      edges: [edge("e1", "begin", "execOut", "print", "execIn")],
    };

    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(graph, registry, "Greeter", "greeter-asset"),
    ]);
    runtime.spawnScriptedActor({ classId: "Greeter" });
    runtime.start();
    runtime.tick();

    const prints = commands.filter((c) => c.type === "print");
    expect(prints).toHaveLength(1);
    expect(prints[0]).toMatchObject({ key: "status", duration: 2 });

    // Anchors registered from the compiled module map a thrown stack back to
    // the graph node that produced the line.
    const anchorLine = compileGraph(graph, {
      assetGuid: "greeter-asset",
      registry,
    }).anchors[0]!;
    const err = new Error("boom");
    err.stack = `Error: boom\n    at onBeginPlay (babylonslate:///greeter-asset.js:${anchorLine.line}:1)`;
    const diagnostic = runtime.reportError(err);
    expect(diagnostic?.nodeId).toBe("print");
    expect(diagnostic?.graphId).toBe("event-graph");
  });

  it("does not re-enter a latent entry point while it is pending", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "tick", "flow.event.tick"),
        node(registry, "delay", "timers.delay", { duration: 5 }),
        node(registry, "log", "debug.log", { message: "after delay" }),
      ],
      edges: [
        edge("e1", "tick", "execOut", "delay", "execIn"),
        edge("e2", "delay", "execOut", "log", "execIn"),
      ],
    };

    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    const script = toScript(graph, registry, "Waiter", "waiter-asset");
    expect(script.entryPoints[0]).toMatchObject({
      event: "onTick",
      isAsync: true,
    });

    await runtime.loadScripts([script]);
    runtime.spawnScriptedActor({ classId: "Waiter" });
    runtime.start();
    runtime.tick();
    runtime.tick();
    runtime.tick();
    await Promise.resolve();

    expect(commands.filter((c) => c.type === "log")).toHaveLength(0);
    void STRING;
    void EXEC;
    void pin;
  });

  it("runs OnCommandRun from the console and ExecuteConsoleCommand", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "run", "flow.event.commandRun", {
          parameters: [{ name: "amount", type: "float" }],
        }),
        node(registry, "report", "debug.reportCommand", {
          success: true,
          output: "ok",
        }),
      ],
      edges: [edge("e1", "run", "execOut", "report", "execIn")],
    };
    const runtime = createInProcessRuntime({
      seed: 4,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      includeDebugCommands: false,
    });
    await runtime.loadScripts([
      {
        ...toScript(graph, registry, "HealCommand", "heal-asset"),
        command: {
          name: "heal",
          description: "Heal",
          category: "game",
          parameters: [{ name: "amount", type: "float" }],
        },
      },
    ]);
    expect(runtime.executeConsoleCommand("heal 3")).toEqual({
      success: true,
      output: "ok",
    });
    runtime.stop();
  });

  it("Change Scene graph node calls World.loadScene like the console host", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "change", "scene.change", { scene: "Level2" }),
      ],
      edges: [edge("e1", "begin", "execOut", "change", "execIn")],
    };
    let loaded: string | undefined;
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
    });
    runtime.getWorld().setGameInstance(
      new GameInstance({
        classId: "GameInstance",
        guid: "gi",
        hooks: {
          onSceneLoaded: (_self, sceneName) => {
            loaded = sceneName;
          },
        },
      }),
    );
    await runtime.loadScripts([
      toScript(graph, registry, "Loader", "loader-asset"),
    ]);
    runtime.spawnScriptedActor({ classId: "Loader" });
    runtime.start();
    runtime.tick();
    expect(loaded).toBe("Level2");
    runtime.stop();
  });
});
