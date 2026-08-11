import { describe, expect, it } from "vitest";
import { DEFAULT_NODE_TYPE, toSerializedGraph } from "./graph-model";

describe("toSerializedGraph", () => {
  it("keeps id, type, position and data for each node", () => {
    expect(
      toSerializedGraph(
        [
          {
            id: "n1",
            type: "logMessage",
            position: { x: 10, y: 20 },
            data: { message: "hi" },
          },
        ],
        [],
      ),
    ).toEqual({
      nodes: [
        {
          id: "n1",
          type: "logMessage",
          position: { x: 10, y: 20 },
          data: { message: "hi" },
        },
      ],
      edges: [],
    });
  });

  it("falls back to the default node type when the canvas omits one", () => {
    const graph = toSerializedGraph(
      [{ id: "n1", position: { x: 0, y: 0 }, data: {} }],
      [],
    );
    expect(graph.nodes[0].type).toBe(DEFAULT_NODE_TYPE);
  });

  it("substitutes an empty object for missing node data", () => {
    const graph = toSerializedGraph(
      [{ id: "n1", type: "logMessage", position: { x: 0, y: 0 }, data: null }],
      [],
    );
    expect(graph.nodes[0].data).toEqual({});
  });

  it("passes edges through untouched", () => {
    const edges = [{ id: "e1", source: "n1", target: "n2" }];
    expect(toSerializedGraph([], edges).edges).toBe(edges);
  });

  it("returns an empty node list for an empty canvas", () => {
    expect(toSerializedGraph([], [])).toEqual({ nodes: [], edges: [] });
  });
});
