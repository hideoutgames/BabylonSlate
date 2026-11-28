import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import {
  compileGraph,
  type GraphEdge,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { INFINITE_LOOP_DIAGNOSTIC_CODE } from "@haptic/debugger";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node ${typeId}`);
  return { id, typeId, position: { x: 0, y: 0 }, pins: def.pins(properties), properties };
}

function edge(
  id: string,
  sourceNodeId: string,
  sourcePinId: string,
  targetNodeId: string,
  targetPinId: string,
): GraphEdge {
  return { id, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
}

function toScript(
  graph: LogicGraph,
  registry: NodeRegistry,
  classId: string,
  assetGuid: string,
  options: { instrumentInfiniteLoops?: boolean; exportName?: string } = {},
): CompiledScript {
  const compiled = compileGraph(graph, {
    assetGuid,
    registry,
    instrumentInfiniteLoops: options.instrumentInfiniteLoops ?? true,
    exportName: options.exportName,
  });
  return {
    assetGuid,
    classId,
    source: compiled.source,
    anchors: compiled.anchors,
    entryPoints: compiled.entryPoints,
  };
}

describe("Tier 1 scripting optimizations", () => {
  const registry = createDefaultNodeRegistry();

  it("inline loop guard allows large loops within budget, aborts with scriptLocation when exceeded, and skips checks when disabled", async () => {
    const graph: LogicGraph = {
      id: "loop",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "for", "flow.forLoop", { "default:firstIndex": 1, "default:lastIndex": 500 }),
        node(registry, "get", "variables.get", { variableName: "sum", typeId: "int", implicitSelf: true }),
        node(registry, "add", "math.add", { aType: "int", bType: "int" }),
        node(registry, "set", "variables.set", { variableName: "sum", typeId: "int", implicitSelf: true }),
      ],
      edges: [
        edge("e1", "begin", "execOut", "for", "execIn"),
        edge("e2", "for", "loopBody", "set", "execIn"),
        edge("d1", "get", "value", "add", "a"),
        edge("d2", "for", "index", "add", "b"),
        edge("d3", "add", "out", "set", "value"),
      ],
    };

    // Within budget: runs cleanly to completion.
    const okCommands: CommandMessage[] = [];
    const okRuntime = createInProcessRuntime({
      seed: 1,
      includeDebugCommands: true,
      infiniteLoopDetection: true,
      loopCount: 2000,
      onCommand: (cmd) => okCommands.push(cmd),
    });
    await okRuntime.loadScripts([toScript(graph, registry, "Summer", "summer-asset")]);
    const actor = okRuntime.spawnScriptedActor({ classId: "Summer", variables: { sum: 0 } })!;
    okRuntime.start();
    okRuntime.tick();
    expect(actor.getVariable("sum")).toBe(125_250);
    expect(okCommands.filter((c) => c.type === "diagnostic" && c.code === INFINITE_LOOP_DIAGNOSTIC_CODE)).toHaveLength(0);
    okRuntime.stop();

    // Exceeding budget: aborts with exact scriptLocation even without source anchors.
    const abortCommands: CommandMessage[] = [];
    const abortRuntime = createInProcessRuntime({
      seed: 1,
      includeDebugCommands: true,
      infiniteLoopDetection: true,
      loopCount: 20,
      onCommand: (cmd) => abortCommands.push(cmd),
    });
    const script = toScript(graph, registry, "Summer", "summer-asset");
    script.anchors = [];
    await abortRuntime.loadScripts([script]);
    abortRuntime.spawnScriptedActor({ classId: "Summer", variables: { sum: 0 } });
    abortRuntime.start();
    abortRuntime.tick();
    expect(abortRuntime.getDiagnostics().entries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: INFINITE_LOOP_DIAGNOSTIC_CODE,
          assetGuid: "summer-asset",
          graphId: "loop",
        }),
      ]),
    );
    abortRuntime.stop();

    // Disabled infiniteLoopDetection: completes even when loopCount is tiny.
    const disabledRuntime = createInProcessRuntime({
      seed: 1,
      infiniteLoopDetection: false,
      loopCount: 5,
    });
    await disabledRuntime.loadScripts([toScript(graph, registry, "Summer", "summer-asset")]);
    const disabledActor = disabledRuntime.spawnScriptedActor({ classId: "Summer", variables: { sum: 0 } })!;
    disabledRuntime.start();
    disabledRuntime.tick();
    expect(disabledActor.getVariable("sum")).toBe(125_250);
    disabledRuntime.stop();
  });

  it("zero-arg function calls and static Function Library calls execute without losing caller owner or return values", async () => {
    const fnPins = [
      { name: "exec", typeId: "exec", direction: "in" },
      { name: "then", typeId: "exec", direction: "out" },
      { name: "result", typeId: "int", direction: "out" },
    ];
    const libFnGraph: LogicGraph = {
      id: "GetFortyTwo",
      kind: "function",
      nodes: [
        node(registry, "in", "flow.function.input", { pins: fnPins }),
        node(registry, "out", "flow.function.output", { pins: fnPins, "default:result": 42 }),
      ],
      edges: [edge("e1", "in", "exec", "out", "then")],
    };
    const callerGraph: LogicGraph = {
      id: "caller",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "call", "functions.call", {
          classId: "MathLib",
          functionName: "GetFortyTwo",
          static: true,
          pins: fnPins,
        }),
        node(registry, "set", "variables.set", { variableName: "answer", typeId: "int", implicitSelf: true }),
      ],
      edges: [
        edge("e1", "begin", "execOut", "call", "exec"),
        edge("e2", "call", "then", "set", "execIn"),
        edge("d1", "call", "result", "set", "value"),
      ],
    };

    const libCompiled = compileGraph(libFnGraph, { assetGuid: "lib", registry, exportName: "GetFortyTwo" });
    const callerCompiled = compileGraph(callerGraph, { assetGuid: "caller", registry });
    // Zero-arg call omits empty `{}` object literal.
    expect(callerCompiled.source).toContain('ctx.invokeFunction("MathLib", "GetFortyTwo")');

    const runtime = createInProcessRuntime({ seed: 1 });
    await runtime.loadScripts([
      { assetGuid: "lib", classId: "MathLib", source: libCompiled.source, anchors: libCompiled.anchors, entryPoints: libCompiled.entryPoints },
      { assetGuid: "caller", classId: "Caller", source: callerCompiled.source, anchors: callerCompiled.anchors, entryPoints: callerCompiled.entryPoints },
    ]);
    const actor = runtime.spawnScriptedActor({ classId: "Caller", variables: { answer: 0 } })!;
    runtime.start();
    runtime.tick();
    expect(actor.getVariable("answer")).toBe(42);
    runtime.stop();
  });

  it("actorDistance root fast path matches world positions for both unparented and parented actors", async () => {
    const distGraph: LogicGraph = {
      id: "dist",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.tick"),
        node(registry, "other", "variables.get", { variableName: "target", typeId: "object", typeClassId: "Actor", implicitSelf: true }),
        node(registry, "dist", "actor.getDistanceTo"),
        node(registry, "set", "variables.set", { variableName: "d", typeId: "float", implicitSelf: true }),
      ],
      edges: [
        edge("e1", "begin", "execOut", "set", "execIn"),
        edge("d1", "other", "value", "dist", "other"),
        edge("d2", "dist", "distance", "set", "value"),
      ],
    };
    const runtime = createInProcessRuntime({ seed: 1 });
    await runtime.loadScripts([toScript(distGraph, registry, "Measurer", "dist-asset", { instrumentInfiniteLoops: false })]);
    const parent = runtime.spawnScriptedActor({ classId: "Measurer" })!;
    parent.transform.position = { x: 10, y: 0, z: 0 };
    const child = runtime.spawnScriptedActor({
      classId: "Measurer",
      variables: { parentId: parent.guid },
    })!;
    child.transform.position = { x: 0, y: 3, z: 4 };
    const a = runtime.spawnScriptedActor({
      classId: "Measurer",
      variables: { target: child, d: 0 },
    })!;
    a.transform.position = { x: 10, y: 0, z: 0 };
    const b = runtime.spawnScriptedActor({
      classId: "Measurer",
      variables: { target: parent, d: 0 },
    })!;
    b.transform.position = { x: 7, y: 4, z: 0 };
    runtime.start();
    runtime.tick();
    expect(a.getVariable("d")).toBeCloseTo(5, 6);
    expect(b.getVariable("d")).toBeCloseTo(5, 6);
    runtime.stop();
  });

  it("demand-driven ensurePure skips unreachable pure nodes in multi-entry graphs while keeping reachable ones", () => {
    const graph: LogicGraph = {
      id: "multi",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "tick", "flow.event.tick"),
        node(registry, "setA", "variables.set", { variableName: "a", typeId: "float", implicitSelf: true }),
        node(registry, "unused", "vector.make3", { "default:x": 9, "default:y": 8, "default:z": 7 }),
        node(registry, "used", "math.add", { aType: "float", bType: "float", "default:a": 1, "default:b": 2 }),
      ],
      edges: [
        edge("e1", "begin", "execOut", "setA", "execIn"),
        edge("d1", "used", "out", "setA", "value"),
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "multi", registry });
    expect(compiled.source).toContain("(1 + 2)");
    expect(compiled.source).not.toContain("9");
  });
});
