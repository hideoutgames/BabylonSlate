import { describe, expect, it } from "vitest";
import { claimFocusRouting, graphOwningNode } from "./function-graph-focus";

const node = (id: string) => ({
  id,
  type: "debug.printString",
  position: { x: 0, y: 0 },
  data: {},
});

const CLASS_GRAPH = {
  nodes: [node("print")],
  edges: [],
  functionGraphs: {
    "fn-jump": { nodes: [node("land")], edges: [] },
    "fn-dash": { nodes: [node("boost")], edges: [] },
  },
};

describe("graphOwningNode", () => {
  it("finds a node in the Event Graph or in the function that holds it", () => {
    expect(graphOwningNode(CLASS_GRAPH, "print")).toEqual({ kind: "event" });
    expect(graphOwningNode(CLASS_GRAPH, "boost")).toEqual({ kind: "function", functionId: "fn-dash" });
  });

  it("has no owner for a node the document does not hold", () => {
    expect(graphOwningNode(CLASS_GRAPH, "gone")).toBeNull();
    expect(graphOwningNode(null, "print")).toBeNull();
    expect(graphOwningNode({ nodes: [node("a")], edges: [] }, "b")).toBeNull();
  });
});

describe("claimFocusRouting", () => {
  it("lets one graph panel route a focus request, and none that mounts afterwards", () => {
    const focus = { nodeId: "land" };
    expect(claimFocusRouting(focus)).toBe(true);
    expect(claimFocusRouting(focus)).toBe(false);
    expect(claimFocusRouting({ nodeId: "land" })).toBe(true);
  });
});
