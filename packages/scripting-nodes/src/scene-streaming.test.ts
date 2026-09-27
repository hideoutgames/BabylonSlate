import { describe, expect, it } from "vitest";
import {
  actorRef,
  compileGraph,
  EXEC,
  pin,
  validateGraphs,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
  type PinType,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";

function node(registry: NodeRegistry, id: string, typeId: string): GraphNode {
  return { id, typeId, pins: registry.get(typeId)!.pins({}), position: { x: 0, y: 0 }, properties: {} };
}

function edge(from: string, fromPin: string, to: string, toPin: string) {
  return { id: `${from}-${fromPin}-${to}-${toPin}`, sourceNodeId: from, sourcePinId: fromPin, targetNodeId: to, targetPinId: toPin };
}

function graphFor(method: string, result?: PinType) {
  const registry = createDefaultNodeRegistry();
  registry.register({
    id: "test.target", title: "Target", category: "test", pure: true,
    pins: () => [pin("out", "Out", "out", actorRef("SceneStreamingActor"))],
    codegen: () => ({ out: "ctx.target" }),
  });
  registry.register({
    id: "test.capture", title: "Capture", category: "test",
    pins: () => [pin("execIn", "Exec", "in", EXEC), ...(result ? [pin("value", "Value", "in", result)] : [])],
    codegen: (ctx) => { ctx.emit(`ctx.capture(${result ? ctx.input("value") : JSON.stringify("continued")});`); },
  });
  const graph: LogicGraph = {
    id: "graph", kind: "event",
    nodes: [node(registry, "begin", "flow.event.beginPlay"), node(registry, "target", "test.target"),
      node(registry, "stream", `sceneStreaming.${method}`), node(registry, "capture", "test.capture")],
    edges: [edge("target", "out", "stream", "target"), ...(result
      ? [edge("begin", "execOut", "capture", "execIn"), edge("stream", "out", "capture", "value")]
      : [edge("begin", "execOut", "stream", "execIn"), edge("stream", "execOut", "capture", "execIn")])],
  };
  return { graph, registry };
}

function executable(graph: LogicGraph, registry: NodeRegistry) {
  const compiled = compileGraph(graph, { assetGuid: "asset", registry });
  const source = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  return new Function(`${source}\nreturn onBeginPlay;`)() as (context: Record<string, unknown>) => unknown;
}

describe("Scene Streaming Actor nodes", () => {
  it.each(["loadSceneAsync", "unloadSceneAsync"])("%s continues immediately with the selected instance", (method) => {
    const { graph, registry } = graphFor(method);
    const target = { guid: "selected-stream" };
    const calls: unknown[] = [];
    executable(graph, registry)({ target, [method]: (value: unknown) => { calls.push(value); }, capture: (value: unknown) => { calls.push(value); } });
    expect(calls).toEqual([target, "continued"]);
  });

  it.each(["loadSceneBlocking", "unloadSceneBlocking"])("%s waits for host completion before following Then", async (method) => {
    const { graph, registry } = graphFor(method);
    const target = { guid: "selected-stream" };
    const calls: unknown[] = [];
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    const run = executable(graph, registry)({
      target,
      [method]: (value: unknown) => { calls.push(value); return completion; },
      capture: (value: unknown) => { calls.push(value); },
    });
    expect(calls).toEqual([target]);
    finish();
    await run;
    expect(calls).toEqual([target, "continued"]);
  });

  it.each([
    ["getTargetSceneName", { kind: "string" }, "Courtyard"],
    ["isSceneLoaded", { kind: "bool" }, false],
    ["getSceneLoadProgress", { kind: "float" }, 0.625],
    ["getSceneState", { kind: "enumRef", guid: "engine:SceneStreamingState" }, "Loading"],
  ] as const)("%s reads its typed output from the selected instance", (method, type, value) => {
    const { graph, registry } = graphFor(method, type);
    expect(validateGraphs([graph], { assetGuid: "asset" }, { registry }).filter((entry) => entry.severity === "error")).toEqual([]);
    const target = { guid: "selected-stream" };
    const observed: unknown[] = [];
    executable(graph, registry)({
      target,
      [method]: (selected: unknown) => selected === target ? value : null,
      capture: (result: unknown) => { observed.push(result); },
    });
    expect(observed).toEqual([value]);
  });

  it("requires an explicit SceneStreamingActor target and rejects a generic Actor reference", () => {
    const { graph, registry } = graphFor("loadSceneAsync");
    graph.edges = graph.edges.filter((entry) => entry.targetPinId !== "target");
    graph.nodes.find((entry) => entry.id === "stream")!.properties.implicitSelf = true;
    expect(validateGraphs([graph], { assetGuid: "asset" }, { registry })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "pin.missing_input", severity: "error", nodeId: "stream", pinId: "target" }),
    ]));
    graph.edges.push(edge("target", "out", "stream", "target"));
    graph.nodes.find((entry) => entry.id === "target")!.pins[0]!.type = actorRef("Actor");
    expect(validateGraphs([graph], { assetGuid: "asset" }, { registry })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "type.mismatch", nodeId: "stream", pinId: "target" }),
    ]));
    graph.nodes.find((entry) => entry.id === "target")!.pins[0]!.type = actorRef("SceneStreamingActor");
    expect(validateGraphs([graph], { assetGuid: "asset" }, { registry }).filter((entry) => entry.severity === "error")).toEqual([]);
  });
});
