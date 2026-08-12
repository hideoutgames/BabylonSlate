import { describe, expect, it, beforeEach } from "vitest";
import {
  clearValidationRules,
  registerValidationRule,
  listValidationRules,
} from "./type-context";
import { validateGraphs } from "./validate";
import { createEmptyLogicGraph, type LogicGraph } from "./ir";
import { pin } from "./node-registry";
import { EXEC, INT, STRING } from "./types";
import { diagnostic } from "./diagnostics";

function typedMismatchGraph(): LogicGraph {
  return {
    id: "g1",
    kind: "event",
    nodes: [
      {
        id: "a",
        typeId: "flow.entry",
        position: { x: 0, y: 0 },
        pins: [
          pin("execOut", "then", "out", EXEC),
          pin("out", "value", "out", INT),
        ],
        properties: {},
      },
      {
        id: "b",
        typeId: "debug.log",
        position: { x: 200, y: 0 },
        pins: [
          pin("execIn", "exec", "in", EXEC),
          pin("execOut", "then", "out", EXEC),
          pin("message", "message", "in", STRING),
        ],
        properties: {},
      },
    ],
    edges: [
      {
        id: "e1",
        sourceNodeId: "a",
        sourcePinId: "out",
        targetNodeId: "b",
        targetPinId: "message",
      },
    ],
  };
}

describe("validateGraphs", () => {
  beforeEach(() => clearValidationRules());

  it("flags type mismatches", () => {
    const diags = validateGraphs([typedMismatchGraph()], {
      assetGuid: "asset-1",
    });
    expect(diags.some((d) => d.code === "type.mismatch")).toBe(true);
  });

  it("supports rule registration hook", () => {
    registerValidationRule({
      id: "test.rule",
      run(graphs, ctx) {
        return graphs.map((g) =>
          diagnostic({
            code: "test.rule",
            message: "hook fired",
            assetGuid: ctx.assetGuid,
            graphId: g.id,
          }),
        );
      },
    });
    expect(listValidationRules()).toHaveLength(1);
    const diags = validateGraphs([createEmptyLogicGraph("empty")], {
      assetGuid: "a",
    });
    expect(diags.some((d) => d.code === "test.rule")).toBe(true);
  });

  it("reports ExecuteJavaScript parse errors", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "function",
      nodes: [
        {
          id: "js",
          typeId: "debug.executeJavaScript",
          position: { x: 0, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
          ],
          properties: { body: "this is !!! invalid js {" },
        },
      ],
      edges: [],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.some((d) => d.code === "js.parse")).toBe(true);
  });

  it("does not warn pin.missing_input when a default: property is authored", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "add",
          typeId: "math.add",
          position: { x: 0, y: 0 },
          pins: [
            pin("a", "a", "in", INT),
            pin("b", "b", "in", INT),
            pin("out", "out", "out", INT),
          ],
          properties: { "default:a": 2, "default:b": 3 },
        },
      ],
      edges: [],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.some((d) => d.code === "pin.missing_input")).toBe(false);
  });

  it("warns pin.missing_input for an unconnected required pin without a default", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "add",
          typeId: "math.add",
          position: { x: 0, y: 0 },
          pins: [
            pin("a", "a", "in", INT),
            pin("b", "b", "in", INT),
            pin("out", "out", "out", INT),
          ],
          properties: {},
        },
      ],
      edges: [],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.filter((d) => d.code === "pin.missing_input")).toHaveLength(2);
  });
});
