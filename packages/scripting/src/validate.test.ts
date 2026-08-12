import { describe, expect, it, beforeEach } from "vitest";
import {
  clearValidationRules,
  registerValidationRule,
  listValidationRules,
} from "./type-context";
import { validateGraphs } from "./validate";
import { createEmptyLogicGraph, type LogicGraph } from "./ir";
import { pin } from "./node-registry";
import {
  EXEC,
  FLOAT,
  INT,
  RESOLVING_WILDCARD,
  STRING,
  arrayOf,
} from "./types";
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

  it("flags incompatible wildcard resolution groups", () => {
    const T = RESOLVING_WILDCARD;
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "itemSrc",
          typeId: "const.float",
          position: { x: 0, y: 0 },
          pins: [pin("out", "out", "out", FLOAT)],
          properties: {},
        },
        {
          id: "arraySrc",
          typeId: "const.array",
          position: { x: 0, y: 80 },
          pins: [pin("out", "out", "out", arrayOf(STRING))],
          properties: {},
        },
        {
          id: "append",
          typeId: "array.append",
          position: { x: 200, y: 40 },
          pins: [
            pin("array", "array", "in", arrayOf(T)),
            pin("item", "item", "in", T),
            pin("out", "out", "out", arrayOf(T)),
          ],
          properties: {},
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "itemSrc",
          sourcePinId: "out",
          targetNodeId: "append",
          targetPinId: "item",
        },
        {
          id: "e2",
          sourceNodeId: "arraySrc",
          sourcePinId: "out",
          targetNodeId: "append",
          targetPinId: "array",
        },
      ],
    };
    const diags = validateGraphs([graph], { assetGuid: "asset-1" });
    expect(diags.some((d) => d.code === "type.wildcard_group")).toBe(true);
  });

  it("flags a mismatch after resolving a wildcard to a concrete type", () => {
    const T = RESOLVING_WILDCARD;
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "src",
          typeId: "const.array",
          position: { x: 0, y: 0 },
          pins: [pin("out", "out", "out", arrayOf(FLOAT))],
          properties: {},
        },
        {
          id: "get",
          typeId: "array.get",
          position: { x: 160, y: 0 },
          pins: [
            pin("array", "array", "in", arrayOf(T)),
            pin("out", "out", "out", T),
          ],
          properties: {},
        },
        {
          id: "log",
          typeId: "debug.log",
          position: { x: 320, y: 0 },
          pins: [pin("message", "message", "in", STRING, "data", true)],
          properties: { message: "" },
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "src",
          sourcePinId: "out",
          targetNodeId: "get",
          targetPinId: "array",
        },
        {
          id: "e2",
          sourceNodeId: "get",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const diags = validateGraphs([graph], { assetGuid: "asset-1" });
    expect(diags.some((d) => d.code === "type.mismatch")).toBe(true);
  });
});
