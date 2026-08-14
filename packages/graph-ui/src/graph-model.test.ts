import { describe, expect, it } from "vitest";
import {
  canonicalGraphSignature,
  createEdgeId,
  DEFAULT_NODE_TYPE,
  deletableNodeIds,
  lockNodeDragAxis,
  nodeChangesMutateGraph,
  reconcileCanvasGraph,
  toSerializedGraph,
} from "./graph-model";
import type { GraphDocument } from "./graph-types";

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

const twoNodeGraph: GraphDocument = {
  nodes: [
    {
      id: "a",
      type: "debug.log",
      position: { x: 0, y: 0 },
      data: { message: "A" },
    },
    {
      id: "b",
      type: "debug.log",
      position: { x: 280, y: 0 },
      data: { message: "B" },
    },
  ],
  edges: [
    {
      id: "e:a:out:b:in",
      source: "a",
      target: "b",
      sourceHandle: "out",
      targetHandle: "in",
    },
  ],
};

describe("canonicalGraphSignature", () => {
  it("is equal for the same ids, types, positions, data, and edges regardless of order", () => {
    const reversed: GraphDocument = {
      nodes: [...twoNodeGraph.nodes].reverse(),
      edges: [...twoNodeGraph.edges],
    };
    expect(canonicalGraphSignature(reversed)).toBe(
      canonicalGraphSignature(twoNodeGraph),
    );
  });

  it("ignores __nodeType in data so hydrated echoes match the serialized canvas", () => {
    const hydrated: GraphDocument = {
      ...twoNodeGraph,
      nodes: twoNodeGraph.nodes.map((node) => ({
        ...node,
        data: { ...node.data, __nodeType: node.type },
      })),
    };
    expect(canonicalGraphSignature(hydrated)).toBe(
      canonicalGraphSignature(twoNodeGraph),
    );
  });

  it("differs when a node is removed, moved, or data changes", () => {
    const removed: GraphDocument = {
      ...twoNodeGraph,
      nodes: twoNodeGraph.nodes.slice(0, 1),
    };
    const moved: GraphDocument = {
      ...twoNodeGraph,
      nodes: twoNodeGraph.nodes.map((node) =>
        node.id === "a"
          ? { ...node, position: { x: 40, y: 12 } }
          : node,
      ),
    };
    const patched: GraphDocument = {
      ...twoNodeGraph,
      nodes: twoNodeGraph.nodes.map((node) =>
        node.id === "a" ? { ...node, data: { message: "patched" } } : node,
      ),
    };
    expect(canonicalGraphSignature(removed)).not.toBe(
      canonicalGraphSignature(twoNodeGraph),
    );
    expect(canonicalGraphSignature(moved)).not.toBe(
      canonicalGraphSignature(twoNodeGraph),
    );
    expect(canonicalGraphSignature(patched)).not.toBe(
      canonicalGraphSignature(twoNodeGraph),
    );
  });
});

describe("reconcileCanvasGraph", () => {
  const localNodes = twoNodeGraph.nodes.map((node) => ({
    ...node,
    selected: node.id === "a",
    measured: { width: 180, height: 80 },
    width: 180,
    height: 80,
  }));
  const localEdges = twoNodeGraph.edges;

  it("returns null when incoming matches local serialization", () => {
    expect(
      reconcileCanvasGraph({
        localNodes,
        localEdges,
        incoming: twoNodeGraph,
      }),
    ).toBeNull();
  });

  it("returns null when incoming matches lastEmitted so a parent echo is ignored", () => {
    const dragged = {
      ...twoNodeGraph,
      nodes: twoNodeGraph.nodes.map((node) =>
        node.id === "a"
          ? { ...node, position: { x: 64, y: 8 } }
          : node,
      ),
    };
    const localDragged = dragged.nodes.map((node) => ({ ...node }));
    expect(
      reconcileCanvasGraph({
        localNodes: localDragged,
        localEdges,
        incoming: twoNodeGraph,
        lastEmitted: twoNodeGraph,
      }),
    ).toBeNull();
  });

  it("drops nodes removed from incoming", () => {
    const incoming: GraphDocument = {
      ...twoNodeGraph,
      nodes: twoNodeGraph.nodes.slice(0, 1),
      edges: [],
    };
    const next = reconcileCanvasGraph({
      localNodes,
      localEdges,
      incoming,
    });
    expect(next).not.toBeNull();
    expect(next!.nodes.map((node) => node.id)).toEqual(["a"]);
    expect(next!.edges).toEqual([]);
  });

  it("applies moved positions from incoming", () => {
    const incoming: GraphDocument = {
      ...twoNodeGraph,
      nodes: twoNodeGraph.nodes.map((node) =>
        node.id === "a"
          ? { ...node, position: { x: 100, y: 40 } }
          : node,
      ),
    };
    const next = reconcileCanvasGraph({
      localNodes,
      localEdges,
      incoming,
    });
    expect(next?.nodes.find((node) => node.id === "a")?.position).toEqual({
      x: 100,
      y: 40,
    });
  });

  it("applies edge rewires from incoming", () => {
    const incoming: GraphDocument = {
      ...twoNodeGraph,
      edges: [],
    };
    const next = reconcileCanvasGraph({
      localNodes,
      localEdges,
      incoming,
    });
    expect(next?.edges).toEqual([]);
  });

  it("applies data patches from incoming", () => {
    const incoming: GraphDocument = {
      ...twoNodeGraph,
      nodes: twoNodeGraph.nodes.map((node) =>
        node.id === "a" ? { ...node, data: { message: "undo" } } : node,
      ),
    };
    const next = reconcileCanvasGraph({
      localNodes,
      localEdges,
      incoming,
    });
    expect(next?.nodes.find((node) => node.id === "a")?.data).toEqual({
      message: "undo",
    });
  });

  it("keeps selected and measured on surviving node ids", () => {
    const incoming: GraphDocument = {
      ...twoNodeGraph,
      nodes: twoNodeGraph.nodes.map((node) =>
        node.id === "a"
          ? { ...node, position: { x: 12, y: 24 } }
          : node,
      ),
    };
    const next = reconcileCanvasGraph({
      localNodes,
      localEdges,
      incoming,
    });
    const surviving = next?.nodes.find((node) => node.id === "a");
    expect(surviving?.selected).toBe(true);
    expect(surviving?.measured).toEqual({ width: 180, height: 80 });
    expect(surviving?.width).toBe(180);
    expect(surviving?.height).toBe(80);
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

describe("deletableNodeIds", () => {
  it("skips protected nodes in a mixed selection", () => {
    expect(
      deletableNodeIds([
        { id: "in-1", selected: true, data: { __protected: true } },
        { id: "log-a", selected: true, data: {} },
      ]),
    ).toEqual(["log-a"]);
  });
});

describe("lockNodeDragAxis", () => {
  it("keeps Y when locking to X", () => {
    const next = lockNodeDragAxis(
      [{ type: "position", id: "a", position: { x: 40, y: 99 } }],
      [{ id: "a", position: { x: 0, y: 12 } }],
      "x",
    );
    expect(next[0]?.position).toEqual({ x: 40, y: 12 });
  });
});
