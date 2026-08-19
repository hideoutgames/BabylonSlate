import { describe, expect, it } from "vitest";
import { validateGraphs } from "./validate";
import { type GraphNode, type LogicGraph } from "./ir";
import { pin } from "./node-registry";
import { EXEC, INT, STRING } from "./types";
import {
  flowSwitchCasePinId,
  normalizeIntSwitchCases,
  normalizeStringSwitchCases,
} from "./flow-switch-pins";

function switchIntNode(id: string, cases: unknown): GraphNode {
  const normalized = normalizeIntSwitchCases(cases).cases;
  return {
    id,
    typeId: "flow.switchInt",
    position: { x: 0, y: 0 },
    pins: [
      pin("execIn", "exec", "in", EXEC),
      pin("value", "value", "in", INT),
      ...normalized.map((value) =>
        pin(flowSwitchCasePinId(String(value)), String(value), "out", EXEC),
      ),
      pin("default", "Default", "out", EXEC),
    ],
    properties: { cases },
  };
}

function switchStringNode(id: string, cases: unknown): GraphNode {
  const normalized = normalizeStringSwitchCases(cases).cases;
  return {
    id,
    typeId: "flow.switchString",
    position: { x: 0, y: 0 },
    pins: [
      pin("execIn", "exec", "in", EXEC),
      pin("value", "value", "in", STRING),
      ...normalized.map((value) =>
        pin(flowSwitchCasePinId(value), value, "out", EXEC),
      ),
      pin("default", "Default", "out", EXEC),
    ],
    properties: { cases },
  };
}

function entry(id = "entry"): GraphNode {
  return {
    id,
    typeId: "flow.event.beginPlay",
    position: { x: 0, y: 0 },
    pins: [pin("execOut", "then", "out", EXEC)],
    properties: {},
  };
}

describe("validate flow switch cases", () => {
  it("warns when Switch on Int cases need normalization", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [entry(), switchIntNode("sw", [1, "", 1, "x"])],
      edges: [
        {
          id: "e1",
          sourceNodeId: "entry",
          sourcePinId: "execOut",
          targetNodeId: "sw",
          targetPinId: "execIn",
        },
      ],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    const codes = diags.map((d) => d.code);
    expect(codes).toContain("flow.switch.empty_case");
    expect(codes).toContain("flow.switch.duplicate_case");
    expect(codes).toContain("flow.switch.invalid_int");
    expect(diags.filter((d) => d.code.startsWith("flow.switch.")).every((d) => d.severity === "warning")).toBe(
      true,
    );
    expect(
      diags.filter((d) => d.code.startsWith("flow.switch.")).every((d) => d.nodeId === "sw"),
    ).toBe(true);
  });

  it("warns when Switch on String cases need normalization", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [entry(), switchStringNode("sw", ["a", "", "a"])],
      edges: [
        {
          id: "e1",
          sourceNodeId: "entry",
          sourcePinId: "execOut",
          targetNodeId: "sw",
          targetPinId: "execIn",
        },
      ],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.map((d) => d.code)).toEqual(
      expect.arrayContaining([
        "flow.switch.empty_case",
        "flow.switch.duplicate_case",
      ]),
    );
  });

  it("emits no switch warnings for already-normalized cases", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [entry(), switchIntNode("sw", [0, 1])],
      edges: [
        {
          id: "e1",
          sourceNodeId: "entry",
          sourcePinId: "execOut",
          targetNodeId: "sw",
          targetPinId: "execIn",
        },
      ],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" }).filter((d) =>
      d.code.startsWith("flow.switch."),
    );
    expect(diags).toEqual([]);
  });
});
