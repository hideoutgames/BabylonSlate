import { describe, expect, it } from "vitest";
import type { CommandMessage, DebugGraphTrace } from "@babylonslate/bridge";
import { createActor, createDefaultSceneSettings, type SerializedScene } from "@babylonslate/core";
import { FLOAT, compileGraph, type GraphNode, type LogicGraph } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { BObject } from "@babylonslate/object-model";
import { createInProcessRuntime } from "./driver";
import { DEBUG_ROSTER_LIMIT, ExecutionTraceSink, formatDebugValue } from "./script-debug";
import type { CompiledScript } from "./script-host";

const registry = createDefaultNodeRegistry();

function node(id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node definition ${typeId}`);
  return { id, typeId, position: { x: 0, y: 0 }, pins: def.pins(properties), properties };
}

/** Event Tick -> Execute JavaScript doubling the tick's Delta Seconds, compiled with the Simulation's trace probes. */
function tickScript(classId: string, parentClassId = "Actor"): CompiledScript {
  const graph: LogicGraph = {
    id: "event-graph",
    kind: "event",
    nodes: [
      node("tick", "flow.event.tick"),
      node("js", "debug.executeJavaScript", {
        inputs: [{ name: "dt", type: FLOAT }],
        outputs: [{ name: "doubled", type: FLOAT }],
        body: "doubled = dt * 2;",
      }),
    ],
    edges: [
      { id: "exec", sourceNodeId: "tick", sourcePinId: "execOut", targetNodeId: "js", targetPinId: "execIn" },
      { id: "data", sourceNodeId: "tick", sourcePinId: "deltaSeconds", targetNodeId: "js", targetPinId: "in_dt" },
    ],
  };
  const assetGuid = `${classId}.class`;
  const compiled = compileGraph(graph, { assetGuid, registry, instrumentExecutionTrace: true });
  return { assetGuid, classId, parentClassId, source: compiled.source, anchors: compiled.anchors, entryPoints: compiled.entryPoints };
}

function emptyScript(classId: string, parentClassId: string): CompiledScript {
  return { assetGuid: `${classId}.class`, classId, parentClassId, source: "", anchors: [], entryPoints: [] };
}

function sceneWith(actors: SerializedScene["actors"]): SerializedScene {
  return { name: "Level", viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [], actors };
}

async function startSimulation(actors: SerializedScene["actors"], scripts: CompiledScript[]) {
  const commands: CommandMessage[] = [];
  const runtime = createInProcessRuntime({
    seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
    playScene: sceneWith(actors), playSceneGuid: "scene-1",
    onCommand: (command) => commands.push(command),
  });
  await runtime.loadScripts(scripts);
  runtime.realizePlayWorld();
  runtime.start();
  const since = (from: number) => commands.slice(from);
  const traces = (from = 0) => since(from).flatMap((command) => command.type === "executionTrace" ? [command] : []);
  const rosters = (from = 0) => since(from).flatMap((command) => command.type === "debugRoster" ? [command] : []);
  return { runtime, commands, traces, rosters };
}

const DOOR = { kind: "class", classId: "Door" } as const;

describe("ExecutionTraceSink", () => {
  const run = (sink: ExecutionTraceSink) => sink.graph("Door.class", "event-graph")!;

  it("sends what ran once, and a value only when its text changes", () => {
    const sink = new ExecutionTraceSink();
    const graph = run(sink);
    graph.exec("a");
    graph.exec("a");
    graph.edge("e1");
    expect(graph.read("a", "x", 1.23456)).toBe(1.23456);
    graph.write("a", "y", "hello");
    expect(sink.drain()).toEqual<DebugGraphTrace[]>([{
      assetGuid: "Door.class", graphId: "event-graph", nodes: ["a"], edges: ["e1"],
      values: [["a", "x", "in", "1.2346"], ["a", "y", "out", "hello"]],
    }]);
    graph.exec("a");
    graph.read("a", "x", 1.23459);
    graph.write("a", "y", "changed");
    expect(sink.drain()[0]!.values).toEqual([["a", "y", "out", "changed"]]);
    expect(sink.drain()).toEqual([]);
  });

  it("keeps an input and an output of the same pin id apart", () => {
    const sink = new ExecutionTraceSink();
    const graph = run(sink);
    graph.read("a", "value", 1);
    graph.write("a", "value", 2);
    expect(sink.drain()[0]!.values).toEqual([["a", "value", "in", "1"], ["a", "value", "out", "2"]]);
  });

  it("separates graphs of one asset and ignores a recorder after the sink closes", () => {
    const sink = new ExecutionTraceSink();
    const event = sink.graph("Door.class", "event-graph")!;
    const open = sink.graph("Door.class", "Open")!;
    event.exec("a");
    open.exec("b");
    expect(sink.drain().map((trace) => [trace.graphId, trace.nodes])).toEqual([["event-graph", ["a"]], ["Open", ["b"]]]);
    sink.close();
    // An async run that began before the selection changed finishes into nothing.
    event.exec("late");
    expect(event.read("late", "x", 5)).toBe(5);
    expect(sink.drain()).toEqual([]);
    expect(sink.graph("Door.class", "event-graph")).toBeNull();
  });
});

describe("formatDebugValue", () => {
  it.each([
    [3, "3"],
    [0.1 + 0.2, "0.3"],
    [-0.00001, "0"],
    [1 / 3, "0.3333"],
    [Infinity, "Infinity"],
    [true, "true"],
    [null, "null"],
    [undefined, "undefined"],
    ["text", "text"],
    [{ x: 1.00004, y: 2, z: -3.5 }, "{x: 1, y: 2, z: -3.5}"],
    [[1, 2.55555], "[1, 2.5556]"],
    [new Map([["a", 1.23456]]), "{a: 1.2346}"],
  ])("shows %j as %s", (value, text) => {
    expect(formatDebugValue(value)).toBe(text);
  });

  it("shows an object reference, not the object's state", () => {
    const actor = new BObject({ classId: "Door", guid: "door-1", variables: { hp: 3 } });
    expect(formatDebugValue(actor)).toBe("Door(door-1)");
    expect(formatDebugValue({ owner: actor })).toBe("{owner: Door(door-1)}");
  });

  it("truncates long text and long collections", () => {
    expect(formatDebugValue("x".repeat(250))).toBe(`${"x".repeat(100)}…`);
    expect(formatDebugValue(Array.from({ length: 40 }, (_, i) => i)))
      .toBe("[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, …]");
  });

  it("does not follow a cycle past its depth limit", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatDebugValue(cyclic)).toBe("{self: {self: {self: {self: …}}}}");
  });
});

describe("runtime graph debugging", () => {
  const doors = [createActor("d1", "Front", { classId: "Door" }), createActor("d2", "Back", { classId: "Door" })];
  const scripts = () => [tickScript("Door"), emptyScript("SlidingDoor", "Door")];

  it("sends nothing until the editor observes a target", async () => {
    const { runtime, commands } = await startSimulation(doors, scripts());
    runtime.tick();
    runtime.tick();
    expect(commands.filter((command) => command.type === "executionTrace" || command.type === "debugRoster")).toEqual([]);
  });

  it("lists exactly the class's live instances and traces only the followed one", async () => {
    const { runtime, commands, traces, rosters } = await startSimulation(
      [...doors, createActor("s1", "Slider", { classId: "SlidingDoor" }), createActor("w1", "Wall", { classId: "Actor" })],
      scripts());
    runtime.tick();
    const mark = commands.length;
    runtime.applyDebugObserve(DOOR, "d2");
    expect(rosters(mark)).toEqual([{
      type: "debugRoster", target: DOOR, reset: true, removed: [],
      added: [{ id: "d1", kind: "actor", label: "Front" }, { id: "d2", kind: "actor", label: "Back" }],
    }]);
    runtime.tick();
    const [trace, ...others] = traces(mark);
    expect(others).toEqual([]);
    expect(trace).toMatchObject({ type: "executionTrace", target: DOOR, instanceId: "d2", tickIndex: 2 });
    expect(trace!.graphs).toEqual([{
      assetGuid: "Door.class", graphId: "event-graph",
      nodes: ["tick", "js"], edges: ["exec"],
      values: [
        ["tick", "deltaSeconds", "out", "0.0167"],
        ["js", "in_dt", "in", "0.0167"],
        ["js", "out_doubled", "out", "0.0333"],
      ],
    }]);
  });

  it("repeats a visit every tick but sends an unchanged value once", async () => {
    const { runtime, commands, traces } = await startSimulation(doors, scripts());
    runtime.applyDebugObserve(DOOR, "d1");
    const mark = commands.length;
    runtime.tick();
    runtime.tick();
    const [first, second] = traces(mark);
    expect(first!.graphs[0]!.values).toHaveLength(3);
    expect(second!.graphs[0]!).toMatchObject({ nodes: ["tick", "js"], edges: ["exec"], values: [] });
  });

  it("follows another instance when asked and stops reporting the old one", async () => {
    const { runtime, commands, traces } = await startSimulation(doors, scripts());
    runtime.applyDebugObserve(DOOR, "d1");
    runtime.tick();
    runtime.applyDebugObserve(DOOR, "d2");
    const mark = commands.length;
    runtime.tick();
    expect(traces(mark).map((trace) => trace.instanceId)).toEqual(["d2"]);
    // The new instance starts with no history, so its values arrive again.
    expect(traces(mark)[0]!.graphs[0]!.values).toHaveLength(3);
  });

  it("follows nothing for a null instance and stops entirely for a null target", async () => {
    const { runtime, commands, traces, rosters } = await startSimulation(doors, scripts());
    runtime.applyDebugObserve(DOOR, null);
    runtime.tick();
    expect(traces()).toEqual([]);
    runtime.applyDebugObserve(DOOR, "d1");
    runtime.tick();
    expect(traces()).toHaveLength(1);
    runtime.applyDebugObserve(null, null);
    const mark = commands.length;
    runtime.getWorld().destroyActor("d2");
    runtime.tick();
    runtime.tick();
    expect(traces(mark)).toEqual([]);
    expect(rosters(mark)).toEqual([]);
  });

  it("reports spawns and despawns as roster changes and ends the trace of a destroyed instance", async () => {
    const { runtime, commands, traces, rosters } = await startSimulation(doors, scripts());
    runtime.applyDebugObserve(DOOR, "d1");
    runtime.tick();
    const mark = commands.length;
    runtime.getWorld().destroyActor("d1");
    runtime.spawnScriptedActor({ classId: "Door", variables: { name: "Side" } });
    runtime.tick();
    runtime.tick();
    const [change, ...later] = rosters(mark);
    expect(later).toEqual([]);
    expect(change).toMatchObject({ reset: false, removed: ["d1"] });
    expect(change!.added).toHaveLength(1);
    expect(change!.added[0]).toMatchObject({ kind: "actor", label: "Side" });
    // The destroyed instance is no longer followed, so the tick after it reports nothing.
    expect(traces(mark).filter((trace) => trace.tickIndex > 3)).toEqual([]);
  });

  it("starts a fresh roster when the target changes", async () => {
    const { runtime, commands, rosters } = await startSimulation(
      [...doors, createActor("s1", "Slider", { classId: "SlidingDoor" })], scripts());
    runtime.applyDebugObserve(DOOR, null);
    const mark = commands.length;
    runtime.applyDebugObserve({ kind: "class", classId: "SlidingDoor" }, null);
    expect(rosters(mark)).toEqual([{
      type: "debugRoster", target: { kind: "class", classId: "SlidingDoor" }, reset: true, removed: [],
      added: [{ id: "s1", kind: "actor", label: "Slider" }],
    }]);
  });

  it("lists components, the Game Instance and subsystems by their own class", async () => {
    const { runtime, rosters } = await startSimulation([
      createActor("d1", "Front", {
        classId: "Door", components: [{ id: "c1", classId: "Hinge", name: "Left Hinge", properties: {} }],
      }),
    ], [
      emptyScript("Door", "Actor"), emptyScript("Hinge", "ActorComponent"),
      emptyScript("GameInstance", "GameInstance"), emptyScript("Saves", "GameSubsystem"),
    ]);
    const roster = async (classId: string) => {
      runtime.applyDebugObserve({ kind: "class", classId }, null);
      return rosters().filter((message) => message.target.kind === "class" && message.target.classId === classId).at(-1)!.added;
    };
    // Runtime components carry no editor name, so a component reads as its class under its actor.
    expect(await roster("Hinge")).toEqual([{ id: "c1", kind: "component", label: "Hinge", ownerLabel: "Front" }]);
    expect((await roster("GameInstance")).map((entry) => entry.kind)).toEqual(["gameInstance"]);
    expect((await roster("Saves")).map((entry) => [entry.kind, entry.label])).toEqual([["subsystem", "Saves"]]);
  });

  it("caps the roster at the first instances in world order", async () => {
    const many = Array.from({ length: DEBUG_ROSTER_LIMIT + 5 }, (_, i) => createActor(`d${i}`, `Door ${i}`, { classId: "Door" }));
    const { runtime, rosters } = await startSimulation(many, scripts());
    runtime.applyDebugObserve(DOOR, null);
    const [roster] = rosters();
    expect(roster!.added).toHaveLength(DEBUG_ROSTER_LIMIT);
    expect(roster!.added[0]!.id).toBe("d0");
  });

  it("does not advance the command revision, which a final capture compares across a fence", async () => {
    const revisionAfterTicks = async (observe: boolean) => {
      const { runtime } = await startSimulation(doors, scripts());
      if (observe) runtime.applyDebugObserve(DOOR, "d1");
      for (let i = 0; i < 3; i++) runtime.tick();
      const result = await runtime.requestSessionBoundary({ sessionGeneration: 0, requestId: 1, action: { kind: "resetInput" } });
      return result.commandRevision;
    };
    expect(await revisionAfterTicks(true)).toBe(await revisionAfterTicks(false));
  });
});
