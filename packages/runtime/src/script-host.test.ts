import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import { GameInstance } from "@babylonslate/object-model";
import { interfaceHandlerKey } from "@babylonslate/object-model";
import {
  compileGraph,
  pin,
  EXEC,
  FLOAT,
  STRING,
  VEC2,
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

  it("dispatches flow.event.custom through ScriptHost.invokeEvent", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "hit", "flow.event.custom", { name: "On Hit" }),
        node(registry, "log", "debug.log", { message: "hit" }),
      ],
      edges: [edge("e1", "hit", "execOut", "log", "execIn")],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 5,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([toScript(graph, registry, "Hero", "hero-asset")]);
    runtime.invokeScriptEvent("Hero", "On_Hit");
    const logs = commands.filter((c) => c.type === "log");
    expect(logs).toHaveLength(1);
    expect(String((logs[0] as { message: string }).message)).toContain("hit");
    runtime.stop();
  });

  it("GetAxis2D Move from the resolver moves the actor on Tick", async () => {
    const registry = createDefaultNodeRegistry();
    const jsProps = {
      inputs: [{ name: "stick", type: VEC2 }],
      outputs: [{ name: "location", type: VEC3 }],
      body: "location = { x: stick.x, y: 0, z: 0 };",
    };
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "tick", "flow.event.tick"),
        node(registry, "axis", "input.getAxis2D", { axis: "Move" }),
        node(registry, "js", "debug.executeJavaScript", jsProps),
        node(registry, "move", "transform.setLocation"),
        node(registry, "self", "actor.getSelf"),
      ],
      edges: [
        edge("e1", "tick", "execOut", "js", "execIn"),
        edge("e2", "axis", "out", "js", "in_stick"),
        edge("e3", "js", "execOut", "move", "execIn"),
        edge("e4", "js", "out_location", "move", "location"),
        edge("e5", "self", "out", "move", "target"),
      ],
    };
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      dt: 0.1,
    });
    await runtime.loadScripts([
      toScript(graph, registry, "Player", "player-asset"),
    ]);
    const actor = runtime.spawnScriptedActor({ classId: "Player" });
    expect(actor).not.toBeNull();
    runtime.start();
    runtime.pushInput([
      { kind: "key", tick: 0, code: "KeyD", phase: "down" },
    ]);
    runtime.tick();
    expect(actor!.transform.position.x).toBeGreaterThan(0.5);
    runtime.stop();
  });

  it("IsActionHeld Jump from the resolver is true while Space is down", async () => {
    const registry = createDefaultNodeRegistry();
    const jsProps = {
      inputs: [{ name: "held", type: FLOAT }],
      outputs: [{ name: "location", type: VEC3 }],
      body: "location = { x: 0, y: held, z: 0 };",
    };
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "tick", "flow.event.tick"),
        node(registry, "held", "input.isActionHeld", { action: "Jump" }),
        node(registry, "js", "debug.executeJavaScript", {
          ...jsProps,
          inputs: [{ name: "held", type: { kind: "bool" } }],
        }),
        node(registry, "move", "transform.setLocation"),
        node(registry, "self", "actor.getSelf"),
      ],
      edges: [
        edge("e1", "tick", "execOut", "js", "execIn"),
        edge("e2", "held", "out", "js", "in_held"),
        edge("e3", "js", "execOut", "move", "execIn"),
        edge("e4", "js", "out_location", "move", "location"),
        edge("e5", "self", "out", "move", "target"),
      ],
    };
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
    });
    await runtime.loadScripts([
      toScript(graph, registry, "JumperHeld", "jumper-held-asset"),
    ]);
    const actor = runtime.spawnScriptedActor({ classId: "JumperHeld" });
    runtime.start();
    runtime.pushInput([
      { kind: "key", tick: 0, code: "Space", phase: "down" },
    ]);
    runtime.tick();
    expect(actor!.transform.position.y).toBe(1);
    runtime.stop();
  });

  it("OnAction pressed Jump from the resolver runs the then-chain on Tick", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "onJump", "input.onAction", {
          action: "Jump",
          phase: "pressed",
        }),
        node(registry, "print", "debug.print", {
          value: "jumped",
          key: "jump",
          duration: 1,
        }),
      ],
      edges: [edge("e1", "onJump", "execOut", "print", "execIn")],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    const script = toScript(graph, registry, "Jumper", "jumper-asset");
    expect(script.entryPoints[0]?.event).toBe("onTick");
    await runtime.loadScripts([script]);
    runtime.spawnScriptedActor({ classId: "Jumper" });
    runtime.start();
    runtime.pushInput([
      { kind: "key", tick: 0, code: "Space", phase: "down" },
    ]);
    runtime.tick();
    const prints = commands.filter((c) => c.type === "print");
    expect(prints).toHaveLength(1);
    expect(prints[0]).toMatchObject({ message: "jumped" });
    runtime.stop();
  });

  it("Delay completes after tick time, not wall-clock, and does not advance while paused", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "delay", "timers.delay", { duration: 0.25 }),
        node(registry, "log", "debug.log", { message: "after delay" }),
      ],
      edges: [
        edge("e1", "begin", "execOut", "delay", "execIn"),
        edge("e2", "delay", "execOut", "log", "execIn"),
      ],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      dt: 0.1,
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(graph, registry, "Waiter", "waiter-tick-asset"),
    ]);
    runtime.spawnScriptedActor({ classId: "Waiter" });
    runtime.start();
    runtime.tick();
    runtime.tick();
    await Promise.resolve();
    expect(commands.filter((c) => c.type === "log")).toHaveLength(0);

    runtime.pause();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await Promise.resolve();
    expect(commands.filter((c) => c.type === "log")).toHaveLength(0);
    runtime.resume();

    runtime.tick();
    await Promise.resolve();
    expect(commands.filter((c) => c.type === "log")).toHaveLength(1);
    runtime.stop();
  });

  it("Add Component attaches a live component on the target actor", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "self", "actor.getSelf"),
        node(registry, "add", "component.add", { classId: "MeshComponent" }),
      ],
      edges: [
        edge("e1", "begin", "execOut", "add", "execIn"),
        edge("e2", "self", "out", "add", "actor"),
      ],
    };
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
    });
    await runtime.loadScripts([
      toScript(graph, registry, "Holder", "holder-asset"),
    ]);
    const actor = runtime.spawnScriptedActor({ classId: "Holder" });
    runtime.start();
    runtime.tick();
    expect(actor!.components.some((c) => c.classId === "MeshComponent")).toBe(
      true,
    );
    runtime.stop();
  });

  it("Spawn Actor from a compiled graph creates the class with its Begin Play", async () => {
    const registry = createDefaultNodeRegistry();
    const childGraph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "print", "debug.print", {
          value: "spawned",
          key: "child",
          duration: 1,
        }),
      ],
      edges: [edge("e1", "begin", "execOut", "print", "execIn")],
    };
    const spawnerGraph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "spawn", "actor.spawn", { classId: "Child" }),
      ],
      edges: [edge("e1", "begin", "execOut", "spawn", "execIn")],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(childGraph, registry, "Child", "child-asset"),
      toScript(spawnerGraph, registry, "Spawner", "spawner-asset"),
    ]);
    runtime.spawnScriptedActor({ classId: "Spawner" });
    runtime.start();
    runtime.tick();
    expect(
      runtime.getWorld().getActors().some((actor) => actor.classId === "Child"),
    ).toBe(true);
    expect(commands.filter((c) => c.type === "print")).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "child" })]),
    );
    runtime.stop();
  });

  it("Call Interface uses colon handler keys and compiled custom events", async () => {
    const registry = createDefaultNodeRegistry();
    const implGraph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "hit", "flow.event.custom", { name: "ApplyDamage" }),
        node(registry, "log", "debug.log", { message: "damaged" }),
      ],
      edges: [edge("e1", "hit", "execOut", "log", "execIn")],
    };
    const callerGraph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "self", "actor.getSelf"),
        node(registry, "call", "interface.call", {
          interfaceGuid: "iface-damageable",
          method: "ApplyDamage",
        }),
      ],
      edges: [
        edge("e1", "begin", "execOut", "call", "execIn"),
        edge("e2", "self", "out", "call", "target"),
      ],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 8,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(implGraph, registry, "Enemy", "enemy-asset"),
      toScript(callerGraph, registry, "Enemy", "enemy-caller"),
    ]);
    const actor = runtime.spawnScriptedActor({
      classId: "Enemy",
      implementedInterfaces: ["iface-damageable"],
    });
    expect(actor).not.toBeNull();
    runtime.start();
    runtime.tick();
    expect(
      actor!.interfaceHandlers.has(
        interfaceHandlerKey("iface-damageable", "ApplyDamage"),
      ),
    ).toBe(true);
    expect(commands.filter((c) => c.type === "log")).toHaveLength(1);
    runtime.stop();
  });

  it("LineTrace from a compiled graph returns a hit on the same tick", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "tick", "flow.event.tick"),
        node(registry, "trace", "physics.lineTrace", {
          start: { x: 0, y: 10, z: 0 },
          end: { x: 0, y: -1, z: 0 },
        }),
        node(registry, "print", "debug.print", {
          key: "hit",
          duration: 1,
        }),
      ],
      edges: [
        edge("e1", "tick", "execOut", "trace", "execIn"),
        edge("e2", "trace", "execOut", "print", "execIn"),
        edge("e3", "trace", "hit", "print", "value"),
      ],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 11,
      maxActors: 8,
      preferSoftwarePhysics: true,
      physicsWorld: "3d",
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    const world = runtime.getWorld();
    const ground = world.createActor({
      classId: "Actor",
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    ground.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        variables: { motionType: "static", mass: 0, gravityScale: 0 },
      }),
    );
    ground.attachComponent(
      world.createComponent({
        classId: "ColliderComponent",
        variables: {
          shape: { kind: "box", halfExtents: { x: 5, y: 0.5, z: 5 } },
        },
      }),
    );
    world.spawnActorNow(ground);
    await runtime.loadScripts([
      toScript(graph, registry, "Tracer", "tracer-asset"),
    ]);
    runtime.spawnScriptedActor({ classId: "Tracer" });
    runtime.start();
    runtime.tick();
    runtime.tick();
    const prints = commands.filter((c) => c.type === "print");
    expect(
      prints.some((c) => String((c as { message: string }).message) === "true"),
    ).toBe(true);
    runtime.stop();
  });

  it("runs GameInstance subclass Begin Play when gameInstanceClass is set", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "print", "debug.print", {
          value: "gi-ready",
          key: "gi",
          duration: 1,
        }),
      ],
      edges: [edge("e1", "begin", "execOut", "print", "execIn")],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      gameInstanceClass: "MyGame",
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(graph, registry, "MyGame", "gi-asset"),
    ]);
    runtime.start();
    runtime.tick();
    expect(commands.filter((c) => c.type === "print")).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "gi" })]),
    );
    expect(runtime.getWorld().gameInstance?.classId).toBe("MyGame");
    runtime.stop();
  });

  it("emits a playSound command when Begin Play runs audio.play", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "play", "audio.play", { asset: "jump.wav", volume: 0.5 }),
      ],
      edges: [edge("e1", "begin", "execOut", "play", "execIn")],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(graph, registry, "Speaker", "audio-asset"),
    ]);
    runtime.spawnScriptedActor({ classId: "Speaker" });
    runtime.start();
    runtime.tick();
    expect(commands.filter((command) => command.type === "playSound")).toEqual([
      expect.objectContaining({
        type: "playSound",
        assetGuid: "jump.wav",
        volume: 0.5,
      }),
    ]);
    runtime.stop();
  });
});
