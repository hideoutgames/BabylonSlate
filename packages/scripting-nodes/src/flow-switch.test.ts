import { describe, expect, it } from "vitest";
import {
  INT,
  STRING,
  compileGraph,
  flowSwitchCasePinId,
  isFlowSwitchKind,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";

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

describe("Switch on Int / Switch on String catalog", () => {
  it("registers both flow switch nodes with structuredFlow metadata", () => {
    const registry = createDefaultNodeRegistry();
    const intDef = registry.get("flow.switchInt");
    const stringDef = registry.get("flow.switchString");
    expect(intDef?.title).toBe("Switch on Int");
    expect(stringDef?.title).toBe("Switch on String");
    expect(intDef?.category).toBe("flow");
    expect(stringDef?.category).toBe("flow");
    expect(isFlowSwitchKind(intDef?.structuredFlow?.kind)).toBe(true);
    expect(isFlowSwitchKind(stringDef?.structuredFlow?.kind)).toBe(true);
    expect(intDef?.structuredFlow).toEqual({
      kind: "switchOnInt",
      valuePin: "value",
      defaultPin: "default",
    });
    expect(stringDef?.structuredFlow).toEqual({
      kind: "switchOnString",
      valuePin: "value",
      defaultPin: "default",
    });
  });

  it("builds exec in, typed selector, encoded case outs, and Default from cases", () => {
    const registry = createDefaultNodeRegistry();
    const intPins = registry.get("flow.switchInt")!.pins({ cases: [0, 2, 1] });
    expect(intPins.map((pin) => pin.id)).toEqual([
      "execIn",
      "value",
      flowSwitchCasePinId("0"),
      flowSwitchCasePinId("2"),
      flowSwitchCasePinId("1"),
      "default",
    ]);
    expect(intPins.find((pin) => pin.id === "value")?.type).toEqual(INT);
    expect(intPins.find((pin) => pin.id === flowSwitchCasePinId("2"))?.name).toBe(
      "2",
    );
    expect(intPins.find((pin) => pin.id === "default")?.name).toBe("Default");

    const stringPins = registry
      .get("flow.switchString")!
      .pins({ cases: ["idle", "a/b"] });
    expect(stringPins.map((pin) => pin.id)).toEqual([
      "execIn",
      "value",
      flowSwitchCasePinId("idle"),
      flowSwitchCasePinId("a/b"),
      "default",
    ]);
    expect(stringPins.find((pin) => pin.id === "value")?.type).toEqual(STRING);
    expect(
      stringPins.find((pin) => pin.id === flowSwitchCasePinId("a/b"))?.name,
    ).toBe("a/b");
  });

  it("normalizes duplicate and empty cases when building pins", () => {
    const registry = createDefaultNodeRegistry();
    const intPins = registry
      .get("flow.switchInt")!
      .pins({ cases: [1, "", 1, "x", 2] });
    expect(intPins.map((pin) => pin.id)).toEqual([
      "execIn",
      "value",
      flowSwitchCasePinId("1"),
      flowSwitchCasePinId("2"),
      "default",
    ]);

    const stringPins = registry
      .get("flow.switchString")!
      .pins({ cases: ["a", "", "a", "b"] });
    expect(stringPins.map((pin) => pin.id)).toEqual([
      "execIn",
      "value",
      flowSwitchCasePinId("a"),
      flowSwitchCasePinId("b"),
      "default",
    ]);
  });
});

describe("Switch on Int / Switch on String compile", () => {
  it("compiles Switch on Int to if/else if/else on integer literals", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "make", "literal.makeInt", { "default:in": 2 }),
        node(registry, "sw", "flow.switchInt", { cases: [1, 2] }),
        node(registry, "two", "debug.log", { "default:message": "two" }),
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
          sourcePinId: flowSwitchCasePinId("2"),
          targetNodeId: "two",
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
    expect(compiled.source).toContain("=== 2");
    expect(compiled.source).toContain("} else {");
    expect(compiled.source).toContain('"two"');
    expect(compiled.source).toContain('"other"');
    expect(compiled.anchors.some((anchor) => anchor.nodeId === "sw")).toBe(
      true,
    );
  });

  it("compiles Switch on String against encoded case pin values", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "make", "literal.makeString", {
          "default:in": "a/b",
        }),
        node(registry, "sw", "flow.switchString", {
          cases: ["idle", "a/b"],
        }),
        node(registry, "hit", "debug.log", { "default:message": "hit" }),
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
          sourcePinId: flowSwitchCasePinId("a/b"),
          targetNodeId: "hit",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain('=== "a/b"');
    expect(compiled.source).toContain('"hit"');
    expect(compiled.source).not.toContain("a%2Fb");
  });

  it("skips unwired case arms and still reaches Default", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "make", "literal.makeInt", { "default:in": 9 }),
        node(registry, "sw", "flow.switchInt", { cases: [1, 2] }),
        node(registry, "fallback", "debug.log", { "default:message": "def" }),
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
          sourcePinId: "default",
          targetNodeId: "fallback",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).not.toContain("=== 1");
    expect(compiled.source).not.toContain("=== 2");
    expect(compiled.source).toContain('"def"');
  });
});
