import { describe, expect, it } from "vitest";
import {
  fromSerializedGraph,
  toSerializedGraph,
  isLogicGraphPayload,
  pinTypeFromJson,
  defaultValueLiteral,
  pinTypeTag,
  arrayOf,
  mapOf,
  enumRef,
  structRef,
  hasBlockingErrors,
  diagnostic,
  NodeRegistry,
  pin,
  EXEC,
  STRING,
  FLOAT,
  VEC3,
  ROTATOR,
  TRANSFORM,
  COLOR,
  BOOL,
} from "./index";
import type { SerializedGraph } from "@babylonslate/core";

describe("serialize adapter", () => {
  it("round-trips legacy logMessage graphs", () => {
    const legacy: SerializedGraph = {
      nodes: [
        {
          id: "log-1",
          type: "logMessage",
          position: { x: 1, y: 2 },
          data: { message: "hi" },
        },
      ],
      edges: [],
    };
    const logic = fromSerializedGraph(legacy, "main");
    expect(logic.nodes[0]?.typeId).toBe("debug.log");
    expect(isLogicGraphPayload(logic)).toBe(true);
    const back = toSerializedGraph(logic);
    expect(back.nodes[0]?.type).toBe("debug.log");
  });

  it("maps legacy edges without handles", () => {
    const legacy: SerializedGraph = {
      nodes: [
        {
          id: "a",
          type: "flow.entry",
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: "b",
          type: "debug.log",
          position: { x: 1, y: 0 },
          data: { message: "x" },
        },
      ],
      edges: [{ id: "e", source: "a", target: "b" }],
    };
    const logic = fromSerializedGraph(legacy);
    expect(logic.edges[0]?.sourceNodeId).toBe("a");
    expect(logic.edges[0]?.targetNodeId).toBe("b");
  });

  it("keeps authored default:message on debug.log nodes", () => {
    const logic = fromSerializedGraph({
      nodes: [
        {
          id: "log",
          type: "debug.log",
          position: { x: 0, y: 0 },
          data: { "default:message": "hud-clicked" },
        },
      ],
      edges: [],
    });
    expect(logic.nodes[0]?.properties["default:message"]).toBe("hud-clicked");
    expect(logic.nodes[0]?.properties.message).not.toBe("");
  });

  it("compiles a function graph slice as kind function", () => {
    const slice: SerializedGraph = {
      nodes: [
        {
          id: "in",
          type: "flow.function.input",
          position: { x: 0, y: 0 },
          data: { __protected: true },
        },
      ],
      edges: [],
    };
    const logic = fromSerializedGraph(slice, "Jump", "function");
    expect(logic.kind).toBe("function");
    expect(logic.id).toBe("Jump");
  });
});

describe("type helpers", () => {
  it("covers default literals and tags", () => {
    expect(defaultValueLiteral(BOOL)).toBe("false");
    expect(defaultValueLiteral(FLOAT)).toBe("0");
    expect(defaultValueLiteral(STRING)).toBe('""');
    expect(defaultValueLiteral(VEC3)).toContain("x:");
    expect(defaultValueLiteral(ROTATOR)).toContain("yaw");
    expect(defaultValueLiteral(TRANSFORM)).toContain("position");
    expect(defaultValueLiteral(COLOR)).toContain("w:");
    expect(defaultValueLiteral(arrayOf(FLOAT))).toBe("[]");
    expect(defaultValueLiteral(mapOf(STRING, FLOAT))).toContain("Map");
    expect(defaultValueLiteral(EXEC)).toBe("null");
    expect(pinTypeTag(enumRef("e1"))).toContain("enumRef");
    expect(pinTypeTag(structRef("s1"))).toContain("structRef");
    expect(pinTypeTag(arrayOf(FLOAT))).toContain("array");
    expect(pinTypeFromJson({ kind: "float" }).kind).toBe("float");
    expect(pinTypeFromJson(null).kind).toBe("string");
  });
});

describe("diagnostics helpers", () => {
  it("detects blocking errors", () => {
    expect(hasBlockingErrors([])).toBe(false);
    expect(
      hasBlockingErrors([
        diagnostic({
          code: "x",
          message: "m",
          assetGuid: "a",
          graphId: "g",
          severity: "warning",
        }),
      ]),
    ).toBe(false);
    expect(
      hasBlockingErrors([
        diagnostic({
          code: "x",
          message: "m",
          assetGuid: "a",
          graphId: "g",
        }),
      ]),
    ).toBe(true);
  });
});

describe("node registry", () => {
  it("registers and lists by category", () => {
    const registry = new NodeRegistry();
    registry.register({
      id: "t.one",
      title: "One",
      category: "test",
      pins: () => [pin("o", "out", "out", EXEC)],
      codegen: () => undefined,
    });
    expect(registry.get("t.one")?.title).toBe("One");
    expect(registry.listByCategory("test")).toHaveLength(1);
    expect(() =>
      registry.register({
        id: "t.one",
        title: "dup",
        category: "test",
        pins: () => [],
        codegen: () => undefined,
      }),
    ).toThrow(/already registered/);
  });
});
