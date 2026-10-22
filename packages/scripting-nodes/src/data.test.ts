import { describe, expect, it } from "vitest";
import { compileGraph, type LogicGraph } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "./index";

describe("data nodes", () => {
  it.each(["data.getChildren", "data.getDescendants"])("%s Found reads a changing Entry Path once", (typeId) => {
    const registry = createDefaultNodeRegistry();
    const node = (id: string, type: string, properties: Record<string, unknown> = {}) => ({
      id, typeId: type, position: { x: 0, y: 0 }, pins: registry.get(type)!.pins(properties), properties,
    });
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node("begin", "flow.event.beginPlay"),
        node("roll", "math.randomInt", { "default:min": 0, "default:max": 9 }),
        node("path", "literal.toStringInt"),
        node("query", typeId, { "default:tree": "shop" }),
        node("log", "debug.log"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "log", targetPinId: "execIn" },
        { id: "e2", sourceNodeId: "roll", sourcePinId: "out", targetNodeId: "path", targetPinId: "in" },
        { id: "e3", sourceNodeId: "path", sourcePinId: "out", targetNodeId: "query", targetPinId: "entryPath" },
        { id: "e4", sourceNodeId: "query", sourcePinId: "found", targetNodeId: "log", targetPinId: "message" },
      ],
    };
    const body = compileGraph(graph, { assetGuid: "a", registry }).source
      .replace(/export\s+(async\s+)?function\s+/g, "$1function ");
    const rolls = [0, 5];
    const checked: unknown[][] = [];
    const logs: unknown[] = [];
    (new Function(`${body}\nreturn onBeginPlay;`)() as (ctx: unknown) => void)({
      random: { int: () => rolls.shift() },
      formatValue: (value: unknown) => String(value),
      data: {
        hasTree: (tree: string) => checked.push(["tree", tree]) > 0,
        hasEntry: (tree: string, path: string) => checked.push(["entry", tree, path]) > 0,
      },
      log: (_severity: string, _category: string, value: unknown) => logs.push(value),
    });
    expect({ rolls, checked, logs }).toEqual({ rolls: [5], checked: [["entry", "shop", "0"]], logs: ["true"] });
  });
});
