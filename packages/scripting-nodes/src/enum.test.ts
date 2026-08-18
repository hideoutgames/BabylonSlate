import { describe, expect, it } from "vitest";
import {
  BOOL,
  compileGraph,
  enumRef,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";
import { enumNodes, enumSwitchCasePinId } from "./enum";

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

const team = {
  enumGuid: "enum-team",
  members: [
    { name: "None", value: 0 },
    { name: "Red", value: 1 },
    { name: "Blue", value: 2 },
  ],
};

describe("enum nodes", () => {
  it("registers Make, Equal, Not Equal, to String, and Switch", () => {
    expect(enumNodes.map((entry) => entry.id)).toEqual([
      "enum.make",
      "enum.equals",
      "enum.notEquals",
      "enum.toString",
      "enum.switch",
    ]);
  });

  it("types Make/Equal/Switch from the bound enum guid and members", () => {
    const registry = createDefaultNodeRegistry();
    const makePins = registry.get("enum.make")!.pins({ ...team, value: "Red" });
    expect(makePins).toEqual([
      expect.objectContaining({
        id: "out",
        type: enumRef("enum-team"),
        direction: "out",
      }),
    ]);
    const equalPins = registry.get("enum.equals")!.pins(team);
    expect(equalPins.find((pin) => pin.id === "a")?.type).toEqual(
      enumRef("enum-team"),
    );
    expect(equalPins.find((pin) => pin.id === "out")?.type).toEqual(BOOL);
    const sw = registry.get("enum.switch")!.pins(team);
    expect(sw.map((pin) => pin.id)).toEqual([
      "execIn",
      "value",
      enumSwitchCasePinId("None"),
      enumSwitchCasePinId("Red"),
      enumSwitchCasePinId("Blue"),
      "default",
    ]);
    expect(sw.find((pin) => pin.id === "value")?.type).toEqual(
      enumRef("enum-team"),
    );
    expect(sw.find((pin) => pin.name === "Default")?.kind).toBe("exec");
    const idleTeam = {
      enumGuid: "enum-idle",
      members: [{ name: "idle", value: 0 }],
    };
    const idlePins = registry.get("enum.switch")!.pins(idleTeam);
    expect(idlePins.find((pin) => pin.id === enumSwitchCasePinId("idle"))?.name).toBe(
      "Idle",
    );
  });

  it("compiles Make Enum to the selected member name string", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "make", "enum.make", { ...team, value: "Blue" }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "make",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain('"Blue"');
  });

  it("compiles Switch on Enum to if/else if/else on member names", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "make", "enum.make", { ...team, value: "Red" }),
        node(registry, "sw", "enum.switch", team),
        node(registry, "red", "debug.log", { "default:message": "red" }),
        node(registry, "fallback", "debug.log", { "default:message": "other" }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "sw",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "make",
          sourcePinId: "out",
          targetNodeId: "sw",
          targetPinId: "value",
        },
        {
          id: "e3",
          sourceNodeId: "sw",
          sourcePinId: enumSwitchCasePinId("Red"),
          targetNodeId: "red",
          targetPinId: "execIn",
        },
        {
          id: "e4",
          sourceNodeId: "sw",
          sourcePinId: "default",
          targetNodeId: "fallback",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain('=== "Red"');
    expect(compiled.source).toContain("} else {");
    expect(compiled.source).toContain('"red"');
    expect(compiled.source).toContain('"other"');
  });

  it("compares Switch cases against the member name, not the Title Case pin label", () => {
    const registry = createDefaultNodeRegistry();
    const idle = {
      enumGuid: "enum-idle",
      members: [{ name: "idle", value: 0 }],
    };
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "make", "enum.make", { ...idle, value: "idle" }),
        node(registry, "sw", "enum.switch", idle),
        node(registry, "log", "debug.log", { "default:message": "hit" }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "sw",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "make",
          sourcePinId: "out",
          targetNodeId: "sw",
          targetPinId: "value",
        },
        {
          id: "e3",
          sourceNodeId: "sw",
          sourcePinId: enumSwitchCasePinId("idle"),
          targetNodeId: "log",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain('=== "idle"');
    expect(compiled.source).not.toContain('=== "Idle"');
  });
});
