import { describe, expect, it } from "vitest";
import {
  createEdgeId,
  DEFAULT_NODE_TYPE,
  nodeChangesMutateGraph,
  nodesMissingFromLocal,
  toSerializedGraph,
} from "./graph-model";

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

  it("preserves optional source and target handles on edges", () => {
    const edges = [
      {
        id: "e1",
        source: "n1",
        target: "n2",
        sourceHandle: "execOut",
        targetHandle: "execIn",
      },
    ];
    expect(toSerializedGraph([], edges).edges).toEqual(edges);
  });

  it("omits handle keys when they are absent", () => {
    const edges = [{ id: "e1", source: "n1", target: "n2" }];
    expect(toSerializedGraph([], edges).edges[0]).toEqual({
      id: "e1",
      source: "n1",
      target: "n2",
    });
  });

  it("round-trips scripting node type via internal __nodeType data", () => {
    expect(
      toSerializedGraph(
        [
          {
            id: "n1",
            type: "pinNode",
            position: { x: 0, y: 0 },
            data: { title: "Log", __nodeType: "debug.log", __pins: [] },
          },
        ],
        [],
      ).nodes[0],
    ).toEqual({
      id: "n1",
      type: "debug.log",
      position: { x: 0, y: 0 },
      data: { title: "Log", __pins: [] },
    });
  });

  it("returns an empty node list for an empty canvas", () => {
    expect(toSerializedGraph([], [])).toEqual({ nodes: [], edges: [] });
  });

  it("preserves class members when they are passed through", () => {
    expect(
      toSerializedGraph([], [], {
        members: [{ id: "fn-1", kind: "function", name: "Jump" }],
      }).members,
    ).toEqual([{ id: "fn-1", kind: "function", name: "Jump" }]);
  });

  it("preserves empty prefab components so a cleared Class document stays empty", () => {
    expect(
      toSerializedGraph([], [], { components: [] }).components,
    ).toEqual([]);
  });
});

describe("nodesMissingFromLocal", () => {
  it("returns incoming nodes the local canvas does not already have", () => {
    expect(
      nodesMissingFromLocal(
        [{ id: "a" }],
        [{ id: "a" }, { id: "b" }, { id: "c" }],
      ),
    ).toEqual([{ id: "b" }, { id: "c" }]);
  });
});

describe("createEdgeId", () => {
  it("builds a stable id from node and pin endpoints", () => {
    expect(createEdgeId("a", "out", "b", "in")).toBe("e:a:out:b:in");
  });
});

describe("nodeChangesMutateGraph", () => {
  it("ignores select-only changes so selection does not dirty the document", () => {
    expect(
      nodeChangesMutateGraph([{ type: "select" }, { type: "select" }]),
    ).toBe(false);
  });

  it("treats position and remove changes as document mutations", () => {
    expect(
      nodeChangesMutateGraph([{ type: "select" }, { type: "position" }]),
    ).toBe(true);
    expect(nodeChangesMutateGraph([{ type: "remove" }])).toBe(true);
  });
});
