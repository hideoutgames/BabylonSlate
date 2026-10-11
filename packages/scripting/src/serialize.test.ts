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
import type { LogicGraph } from "./ir";

describe("serialize adapter", () => {
  it("round-trips pins and wire handles, keeping wires on their own exec outputs", () => {
    const logic: LogicGraph = {
      id: "main",
      kind: "event",
      nodes: [
        {
          id: "branch",
          typeId: "flow.branch",
          position: { x: 0, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("condition", "condition", "in", BOOL),
            pin("true", "true", "out", EXEC),
            pin("false", "false", "out", EXEC),
          ],
          properties: { "default:condition": true },
        },
        {
          id: "log",
          typeId: "debug.log",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("message", "message", "in", STRING),
          ],
          properties: {},
        },
      ],
      edges: [
        {
          id: "e",
          sourceNodeId: "branch",
          sourcePinId: "false",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
      ],
    };
    const back = fromSerializedGraph(toSerializedGraph(logic));
    expect(back.edges).toEqual(logic.edges);
    expect(back.nodes.map((node) => node.pins)).toEqual(logic.nodes.map((node) => node.pins));
    expect(back.nodes[0]?.typeId).toBe("flow.branch");
    expect(back.nodes[0]?.properties["default:condition"]).toBe(true);
    expect(isLogicGraphPayload(back)).toBe(true);
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
