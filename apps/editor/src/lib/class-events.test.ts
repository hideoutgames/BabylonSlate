import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import { ensureEventNodeOnGraph, nativeEventStubs } from "./class-members";

describe("nativeEventStubs", () => {
  it("always lists Begin Play and Tick", () => {
    const stubs = nativeEventStubs({ parentClass: "Actor" });
    expect(stubs.map((stub) => stub.eventType)).toEqual([
      "flow.event.beginPlay",
      "flow.event.tick",
    ]);
  });

  it("adds On Command Run when ancestry includes BDebugCommand", () => {
    const stubs = nativeEventStubs({
      parentClass: "BDebugCommand",
      parentOf: (id) => (id === "BDebugCommand" ? "BObject" : null),
    });
    expect(stubs.some((stub) => stub.eventType === "flow.event.commandRun")).toBe(
      true,
    );
  });
});

describe("ensureEventNodeOnGraph", () => {
  it("inserts a missing Begin Play node", () => {
    const graph: SerializedGraph = { nodes: [], edges: [] };
    const next = ensureEventNodeOnGraph(graph, "flow.event.beginPlay");
    expect(next.nodes).toHaveLength(1);
    expect(next.nodes[0]?.type).toBe("flow.event.beginPlay");
  });

  it("returns the existing node when Begin Play is already on the graph", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "begin",
          type: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [],
    };
    const next = ensureEventNodeOnGraph(graph, "flow.event.beginPlay");
    expect(next).toBe(graph);
    expect(next.nodes[0]?.id).toBe("begin");
  });
});
