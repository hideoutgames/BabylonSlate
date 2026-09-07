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

describe("H14 current compiled Map Has controls", () => {
  for (const stored of [false, true]) {
    it.each(["present", "missing", "removed"] as const)(
      `reports %s membership and matching values (class writeback=${stored})`,
      async (state) => {
        const graph: LogicGraph = {
          id: "map-probe",
          kind: "event",
          nodes: [
            node("begin", "flow.event.beginPlay"),
            node("key", "literal.makeString", { "default:in": "a" }),
            node("value", "literal.makeString", { "default:in": "v" }),
            node("make", "map.make", { count: 1 }),
            node("has", "map.has", {
              "default:key": state === "missing" ? "missing" : "a",
            }),
            node("get", "map.get", {
              "default:key": state === "missing" ? "missing" : "a",
            }),
            node("size", "map.size"),
            node("keys", "map.keys"),
            variable("storeHas", "Has", "bool"),
            variable("storeValue", "Value", "string"),
            variable("storeSize", "Size", "int"),
            variable("storeKeys", "Keys", "string", { container: "array" }),
            node("print", "debug.print", {
              value: "QA_HOTRELOAD_MARKER",
              key: "probe",
              duration: 1,
            }),
          ],
          edges: [
            edge("key", "out", "make", "key0"),
            edge("value", "out", "make", "value0"),
            edge("has", "out", "storeHas", "value"),
            edge("get", "out", "storeValue", "value"),
            edge("size", "out", "storeSize", "value"),
            edge("keys", "out", "storeKeys", "value"),
            edge("storeHas", "execOut", "storeValue", "execIn"),
            edge("storeValue", "execOut", "storeSize", "execIn"),
            edge("storeSize", "execOut", "storeKeys", "execIn"),
            edge("storeKeys", "execOut", "print", "execIn"),
          ],
        };
        let dataSource = "make";
        let execSource = "begin";
        let dataPin = "out";
        if (state === "removed") {
          graph.nodes.push(
            node("remove", "map.remove", { "default:key": "a" }),
          );
          graph.edges.push(
            edge("make", "out", "remove", "map"),
            edge("begin", "execOut", "remove", "execIn"),
          );
          dataSource = execSource = "remove";
        }
        if (stored) {
          const mapType = { container: "map", keyTypeId: "string" };
          graph.nodes.push(
            variable("writeMap", "MACC", "string", mapType),
            node("readMap", "variables.get", {
              variableName: "MACC",
              typeId: "string",
              implicitSelf: true,
              ...mapType,
            }),
          );
          graph.edges.push(
            edge(dataSource, dataPin, "writeMap", "value"),
            edge(execSource, "execOut", "writeMap", "execIn"),
          );
          execSource = "writeMap";
          dataSource = "readMap";
          dataPin = "value";
        }
        graph.edges.push(edge(execSource, "execOut", "storeHas", "execIn"));
        for (const id of ["has", "get", "size", "keys"])
          graph.edges.push(edge(dataSource, dataPin, id, "map"));
        const { runtime, commands } = await load(graph);
        try {
          const actor = runtime.spawnScriptedActor({ classId: "Probe" })!;
          expect(actor.getVariable("Has")).toBe(state === "present");
          expect(actor.getVariable("Value")).toBe(
            state === "present" ? "v" : "",
          );
          expect(actor.getVariable("Size")).toBe(state === "removed" ? 0 : 1);
          expect(actor.getVariable("Keys")).toEqual(
            state === "removed" ? [] : ["a"],
          );
          expect(
            commands.filter((command) => command.type === "print"),
          ).toEqual([
            expect.objectContaining({ message: "QA_HOTRELOAD_MARKER" }),
          ]);
        } finally {
          runtime.stop();
        }
      },
    );
  }
});

it("H4: Delay updates runtime state once after resumed simulation time and cancels at Stop", async () => {
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
  for (const stopEarly of [false, true]) {
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
      if (stopEarly) runtime.stop();
      else runtime.resume();
      for (let i = 0; i < 10; i++) {
        runtime.tick();
        await Promise.resolve();
      }
      expect(actor.getVariable("Done") === true).toBe(!stopEarly);
      expect(
        commands.filter((command) => command.type === "print"),
      ).toHaveLength(stopEarly ? 0 : 1);
    } finally {
      runtime.stop();
    }
  }
});
