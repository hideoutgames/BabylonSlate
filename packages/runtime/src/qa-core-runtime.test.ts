import { describe, expect, it } from "vitest";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import type { CommandMessage } from "@babylonslate/bridge";
import { createInProcessRuntime } from "./driver";

const registry = createDefaultNodeRegistry();
function node(
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  return {
    id,
    typeId,
    properties,
    position: { x: 0, y: 0 },
    pins: registry.get(typeId)!.pins(properties),
  };
}
function edge(
  sourceNodeId: string,
  sourcePinId: string,
  targetNodeId: string,
  targetPinId: string,
) {
  return {
    id: `${sourceNodeId}-${sourcePinId}-${targetNodeId}-${targetPinId}`,
    sourceNodeId,
    sourcePinId,
    targetNodeId,
    targetPinId,
  };
}
function variable(
  id: string,
  name: string,
  typeId: string,
  extra: Record<string, unknown> = {},
) {
  return node(id, "variables.set", {
    variableName: name,
    typeId,
    implicitSelf: true,
    ...extra,
  });
}
async function load(graph: LogicGraph) {
  const compiled = compileGraph(graph, { registry, assetGuid: "qa-core" });
  const commands: CommandMessage[] = [];
  const runtime = createInProcessRuntime({
    seed: 1,
    seedDemoActors: false,
    dt: 0.1,
    onCommand: (command) => commands.push(command),
  });
  await runtime.loadScripts([
    {
      assetGuid: "qa-core",
      classId: "Probe",
      source: compiled.source,
      anchors: compiled.anchors,
      entryPoints: compiled.entryPoints,
    },
  ]);
  return { runtime, commands };
}

// Map Has/Get/Size semantics are owned by scripting-nodes map.test.ts; this
// keeps the one compile -> runtime path where a Map round-trips through a
// class variable.
describe("H14 compiled Map class-variable writeback", () => {
  it("reads membership and values back from a stored Map variable", async () => {
    const mapType = { container: "map", keyTypeId: "string" };
    const graph: LogicGraph = {
      id: "map-probe",
      kind: "event",
      nodes: [
        node("begin", "flow.event.beginPlay"),
        node("key", "literal.makeString", { "default:in": "a" }),
        node("value", "literal.makeString", { "default:in": "v" }),
        node("make", "map.make", { count: 1 }),
        variable("writeMap", "MACC", "string", mapType),
        node("readMap", "variables.get", {
          variableName: "MACC",
          typeId: "string",
          implicitSelf: true,
          ...mapType,
        }),
        node("has", "map.has", { "default:key": "a" }),
        node("get", "map.get", { "default:key": "a" }),
        node("size", "map.size"),
        node("keys", "map.keys"),
        variable("storeHas", "Has", "bool"),
        variable("storeValue", "Value", "string"),
        variable("storeSize", "Size", "int"),
        variable("storeKeys", "Keys", "string", { container: "array" }),
      ],
      edges: [
        edge("key", "out", "make", "key0"),
        edge("value", "out", "make", "value0"),
        edge("make", "out", "writeMap", "value"),
        edge("begin", "execOut", "writeMap", "execIn"),
        edge("writeMap", "execOut", "storeHas", "execIn"),
        edge("storeHas", "execOut", "storeValue", "execIn"),
        edge("storeValue", "execOut", "storeSize", "execIn"),
        edge("storeSize", "execOut", "storeKeys", "execIn"),
        ...["has", "get", "size", "keys"].map((id) =>
          edge("readMap", "value", id, "map"),
        ),
        edge("has", "out", "storeHas", "value"),
        edge("get", "out", "storeValue", "value"),
        edge("size", "out", "storeSize", "value"),
        edge("keys", "out", "storeKeys", "value"),
      ],
    };
    const { runtime } = await load(graph);
    try {
      const actor = runtime.spawnScriptedActor({ classId: "Probe" })!;
      expect(actor.getVariable("Has")).toBe(true);
      expect(actor.getVariable("Value")).toBe("v");
      expect(actor.getVariable("Size")).toBe(1);
      expect(actor.getVariable("Keys")).toEqual(["a"]);
    } finally {
      runtime.stop();
    }
  });
});

// Resumed Delay completion is owned by script-host.test.ts; this keeps the
// Stop-cancels-a-pending-Delay case.
it("H4: Stop cancels a Delay pending from paused simulation", async () => {
  const graph: LogicGraph = {
    id: "delay-probe",
    kind: "event",
    nodes: [
      node("begin", "flow.event.beginPlay"),
      node("delay", "timers.delay", { duration: 0.5 }),
      variable("done", "Done", "bool", { "default:Done": true }),
      node("print", "debug.print", {
        value: "after delay",
        key: "delay",
        duration: 1,
      }),
    ],
    edges: [
      edge("begin", "execOut", "delay", "execIn"),
      edge("delay", "execOut", "done", "execIn"),
      edge("done", "execOut", "print", "execIn"),
    ],
  };
  const { runtime, commands } = await load(graph);
  try {
    const actor = runtime.spawnScriptedActor({ classId: "Probe" })!;
    runtime.start();
    runtime.tick();
    runtime.tick();
    runtime.pause();
    for (let i = 0; i < 10; i++) runtime.tick();
    await Promise.resolve();
    expect(actor.getVariable("Done")).not.toBe(true);
    runtime.stop();
    for (let i = 0; i < 10; i++) {
      runtime.tick();
      await Promise.resolve();
    }
    expect(actor.getVariable("Done")).not.toBe(true);
    expect(commands.filter((command) => command.type === "print")).toHaveLength(0);
  } finally {
    runtime.stop();
  }
});
