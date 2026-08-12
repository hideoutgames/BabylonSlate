import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import { membersForGraph } from "./my-class-panel";

describe("My Class members", () => {
  it("lists the event nodes a graph declares", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "begin",
          type: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: "tick",
          type: "flow.event.tick",
          position: { x: 0, y: 120 },
          data: {},
        },
        {
          id: "log",
          type: "debug.log",
          position: { x: 200, y: 0 },
          data: {},
        },
      ],
      edges: [],
    };
    expect(membersForGraph(graph)).toEqual([
      { kind: "event", name: "Event Begin Play", detail: "begin" },
      { kind: "event", name: "Event Tick", detail: "tick" },
    ]);
  });

  it("reports nothing for a graph with no events", () => {
    expect(membersForGraph({ nodes: [], edges: [] })).toEqual([]);
    expect(membersForGraph(null)).toEqual([]);
  });
});
