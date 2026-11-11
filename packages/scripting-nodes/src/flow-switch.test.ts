import { describe, expect, it } from "vitest";
import {
  INT,
  STRING,
  compileGraph,
  enumSwitchCasePinId,
  flowSwitchCasePinId,
  pin,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@haptic/scripting";
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

  it.each([
    ["flow.switchInt", { cases: [1, 2, 3] }, 3, flowSwitchCasePinId("3")],
    ["flow.switchString", { cases: ["a", "b", "c"] }, "c", flowSwitchCasePinId("c")],
    ["enum.switch", { members: [{ name: "A", value: 0 }, { name: "B", value: 1 }, { name: "C", value: 2 }] }, "C", enumSwitchCasePinId("C")],
  ] as const)("%s reads its value once, whichever case matches", (typeId, properties, value, casePin) => {
    const registry = createDefaultNodeRegistry();
    const sw = node(registry, "sw", typeId, properties);
    registry.register({
      id: "test.read", title: "Read", category: "test", pure: true,
      pins: () => [pin("out", "Out", "out", sw.pins.find((entry) => entry.id === "value")!.type)],
      codegen: () => ({ out: "ctx.read()" }),
    });
    // Every wired case is tested in turn; the last one matching means all of them were.
    const cases = sw.pins.filter((pin) => pin.kind === "exec" && pin.direction === "out" && pin.id !== "default");
    expect(cases.map((pin) => pin.id)).toContain(casePin);
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "read", "test.read"),
        sw,
        ...cases.map((pin, index) => node(registry, `log${index}`, "debug.log", { "default:message": pin.id })),
      ],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "sw", targetPinId: "execIn" },
        { id: "e2", sourceNodeId: "read", sourcePinId: "out", targetNodeId: "sw", targetPinId: "value" },
        ...cases.map((pin, index) => ({ id: `c${index}`, sourceNodeId: "sw", sourcePinId: pin.id, targetNodeId: `log${index}`, targetPinId: "execIn" })),
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    let reads = 0;
    const logs: string[] = [];
    const body = compiled.source.replace(/export\s+function\s+/g, "function ");
    (new Function(`${body}\nreturn onBeginPlay;`)() as (ctx: unknown) => void)({
      read: () => { reads += 1; return value; },
      formatValue: (v: unknown) => String(v),
      log: (_severity: string, _category: string, message: string) => logs.push(message),
    });
    expect({ reads, logs }).toEqual({ reads: 1, logs: [casePin] });
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
