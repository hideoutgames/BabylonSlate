import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import {
  createEmptyLogicGraph,
  diagnostic,
  pin,
  EXEC,
  STRING,
  type LogicGraph,
} from "@babylonslate/scripting";
import {
  materializeLogicGraph,
  projectHasBlockingErrors,
  validateSerializedGraph,
} from "./graph-validation";

describe("materializeLogicGraph", () => {
  it("returns LogicGraph payloads unchanged", () => {
    const logic = createEmptyLogicGraph("direct");
    expect(materializeLogicGraph(logic, "ignored")).toBe(logic);
  });

  it("overlays embedded __pins and __nodeType from serialized node data", () => {
    const pins = [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("message", "message", "in", STRING, "data", true),
    ];
    const serialized: SerializedGraph = {
      nodes: [
        {
          id: "n1",
          type: "legacy.log",
          position: { x: 1, y: 2 },
          data: {
            __pins: pins,
            __nodeType: "debug.log",
            message: "hi",
          },
        },
      ],
      edges: [],
    };

    const logic = materializeLogicGraph(serialized, "g1");
    expect(logic.id).toBe("g1");
    expect(logic.nodes[0]?.typeId).toBe("debug.log");
    expect(logic.nodes[0]?.pins).toEqual(pins);
  });

  it("fills pins from the default registry when __pins are absent", () => {
    const serialized: SerializedGraph = {
      nodes: [
        {
          id: "entry",
          type: "flow.entry",
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: "log",
          type: "debug.log",
          position: { x: 120, y: 0 },
          data: { message: "x" },
        },
      ],
      edges: [
        {
          id: "e",
          source: "entry",
          target: "log",
          sourceHandle: "execOut",
          targetHandle: "execIn",
        },
      ],
    };

    const logic = materializeLogicGraph(serialized, "main");
    expect(logic.nodes[0]?.pins.some((p) => p.id === "execOut")).toBe(true);
    expect(logic.nodes[1]?.pins.some((p) => p.id === "message")).toBe(true);
    expect(logic.edges[0]).toMatchObject({
      sourceNodeId: "entry",
      sourcePinId: "execOut",
      targetNodeId: "log",
      targetPinId: "execIn",
    });
  });

  it("defaults missing edge handles to execOut/execIn", () => {
    const serialized: SerializedGraph = {
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
          data: { message: "m" },
        },
      ],
      edges: [{ id: "e", source: "a", target: "b" }],
    };

    const logic = materializeLogicGraph(serialized, "g");
    expect(logic.edges[0]?.sourcePinId).toBe("execOut");
    expect(logic.edges[0]?.targetPinId).toBe("execIn");
  });
});

describe("validateSerializedGraph", () => {
  it("surfaces type mismatches after materialization", () => {
    const pinsOut = [
      pin("execOut", "then", "out", EXEC),
      pin("out", "value", "out", { kind: "int" as const }),
    ];
    const pinsIn = [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("message", "message", "in", STRING),
    ];
    const serialized: SerializedGraph = {
      nodes: [
        {
          id: "a",
          type: "flow.entry",
          position: { x: 0, y: 0 },
          data: { __pins: pinsOut, __nodeType: "flow.entry" },
        },
        {
          id: "b",
          type: "debug.log",
          position: { x: 100, y: 0 },
          data: { __pins: pinsIn, __nodeType: "debug.log" },
        },
      ],
      edges: [
        {
          id: "e",
          source: "a",
          target: "b",
          sourceHandle: "out",
          targetHandle: "message",
        },
      ],
    };

    const diags = validateSerializedGraph(serialized, {
      assetGuid: "asset",
      graphId: "g",
    });
    expect(diags.some((d) => d.code === "type.mismatch")).toBe(true);
  });
});

describe("projectHasBlockingErrors", () => {
  it("treats only error severity as blocking", () => {
    expect(
      projectHasBlockingErrors([
        diagnostic({
          severity: "warning",
          code: "exec.unreachable",
          message: "warn",
          assetGuid: "a",
          graphId: "g",
        }),
      ]),
    ).toBe(false);
    expect(
      projectHasBlockingErrors([
        diagnostic({
          code: "type.mismatch",
          message: "bad",
          assetGuid: "a",
          graphId: "g",
        }),
      ]),
    ).toBe(true);
  });
});

describe("LogicGraph validate path", () => {
  it("accepts already-materialized graphs", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "entry",
          typeId: "flow.entry",
          position: { x: 0, y: 0 },
          pins: [pin("execOut", "then", "out", EXEC)],
          properties: {},
        },
      ],
      edges: [],
    };
    const diags = validateSerializedGraph(graph, {
      assetGuid: "a",
      graphId: "g",
    });
    expect(diags.every((d) => d.severity !== "error")).toBe(true);
  });
});
