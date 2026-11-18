import { describe, expect, it } from "vitest";
import { collapsePassThroughNodes, passThroughSources, passThroughTargets, type PinEdgeLike } from "./graph-reroute";

type Node = { id: string; knot?: boolean };

const edge = (id: string, from: string, to: string): PinEdgeLike => {
  const [sourceNodeId, sourcePinId] = from.split(".") as [string, string];
  const [targetNodeId, targetPinId] = to.split(".") as [string, string];
  return { id, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
};

const knot = (id: string): Node => ({ id, knot: true });
const real = (id: string): Node => ({ id });
const collapse = (nodes: Node[], edges: PinEdgeLike[]) =>
  collapsePassThroughNodes(nodes, edges, (node) => node.knot === true);

/** The same wires in the serialized (canvas) shape. */
const serialized = (edges: PinEdgeLike[]) =>
  edges.map((entry) => ({
    source: entry.sourceNodeId,
    sourceHandle: entry.sourcePinId,
    target: entry.targetNodeId,
    targetHandle: entry.targetPinId,
  }));
const sourcesOf = (nodes: Node[], edges: PinEdgeLike[], target: string) => {
  const knots = new Set(nodes.filter((node) => node.knot).map((node) => node.id));
  const [nodeId, pinId] = target.split(".") as [string, string];
  return passThroughSources(serialized(edges), (id) => knots.has(id), nodeId, pinId);
};


/** `count` diamonds in a row from a.then to c.execIn: each knot splits to two knots that join again. */
function stackedDiamonds(count: number) {
  const nodes: Node[] = [real("a"), real("c")];
  const edges: PinEdgeLike[] = [];
  let previous = "a.then";
  for (let index = 0; index < count; index++) {
    const [split, left, right, join] = ["s", "l", "r", "j"].map((part) => `${part}${index}`) as [string, string, string, string];
    nodes.push(knot(split), knot(left), knot(right), knot(join));
    edges.push(
      edge(`in${index}`, previous, `${split}.in`),
      edge(`sl${index}`, `${split}.out`, `${left}.in`),
      edge(`sr${index}`, `${split}.out`, `${right}.in`),
      edge(`lj${index}`, `${left}.out`, `${join}.in`),
      edge(`rj${index}`, `${right}.out`, `${join}.in`),
    );
    previous = `${join}.out`;
  }
  edges.push(edge("last", previous, "c.execIn"));
  return { nodes, edges };
}

describe("collapsePassThroughNodes", () => {
  it("returns the same arrays when no node passes through", () => {
    const nodes = [real("a"), real("b")];
    const edges = [edge("e1", "a.value", "b.value")];
    const result = collapse(nodes, edges);
    expect(result.nodes).toBe(nodes);
    expect(result.edges).toBe(edges);
  });

  it("wires a single knot's source straight to its target", () => {
    const direct = edge("d", "a.x", "b.y");
    const result = collapse(
      [real("a"), knot("k"), real("b"), real("c")],
      [edge("e1", "a.value", "k.in"), edge("e2", "k.out", "b.value"), direct],
    );
    expect(result.nodes.map((node) => node.id)).toEqual(["a", "b", "c"]);
    expect(result.edges).toEqual([
      { id: "e1|e2", sourceNodeId: "a", sourcePinId: "value", targetNodeId: "b", targetPinId: "value", viaEdgeIds: ["e1", "e2"] },
      direct,
    ]);
    expect(result.edges[1]).toBe(direct);
  });

  it("lists every segment of a chain of three knots in source to target order", () => {
    const result = collapse(
      [real("a"), knot("k1"), knot("k2"), knot("k3"), real("b")],
      [
        edge("e3", "k2.out", "k3.in"),
        edge("e4", "k3.out", "b.execIn"),
        edge("e1", "a.then", "k1.in"),
        edge("e2", "k1.out", "k2.in"),
      ],
    );
    expect(result.edges).toEqual([
      {
        id: "e1|e2|e3|e4",
        sourceNodeId: "a", sourcePinId: "then", targetNodeId: "b", targetPinId: "execIn",
        viaEdgeIds: ["e1", "e2", "e3", "e4"],
      },
    ]);
  });

  it("fans one source out to every target of a knot", () => {
    const result = collapse(
      [real("a"), knot("k"), real("b"), real("c")],
      [edge("e1", "a.value", "k.in"), edge("e2", "k.out", "b.x"), edge("e3", "k.out", "c.y")],
    );
    expect(result.edges.map(({ id, sourceNodeId, targetNodeId, targetPinId }) => [id, sourceNodeId, targetNodeId, targetPinId])).toEqual([
      ["e1|e2", "a", "b", "x"],
      ["e1|e3", "a", "c", "y"],
    ]);
  });

  it("gives each source of an exec fan-in its own edge", () => {
    const result = collapse(
      [real("a"), real("b"), knot("k"), real("c")],
      [edge("e1", "a.then", "k.in"), edge("e2", "b.then", "k.in"), edge("e3", "k.out", "c.execIn")],
    );
    expect(result.edges.map(({ id, sourceNodeId, targetNodeId }) => [id, sourceNodeId, targetNodeId])).toEqual([
      ["e1|e3", "a", "c"],
      ["e2|e3", "b", "c"],
    ]);
  });

  it("drops the outgoing edge of a knot that nothing feeds", () => {
    const result = collapse([knot("k"), real("b")], [edge("e1", "k.out", "b.value")]);
    expect(result.nodes.map((node) => node.id)).toEqual(["b"]);
    expect(result.edges).toEqual([]);
  });

  it("drops a knot that feeds nothing, with its incoming edge", () => {
    const result = collapse([real("a"), knot("k")], [edge("e1", "a.value", "k.in")]);
    expect(result.nodes.map((node) => node.id)).toEqual(["a"]);
    expect(result.edges).toEqual([]);
  });

  it("drops a cycle made only of knots", () => {
    const result = collapse(
      [knot("k1"), knot("k2"), real("b")],
      [edge("e1", "k1.out", "k2.in"), edge("e2", "k2.out", "k1.in"), edge("e3", "k2.out", "b.value")],
    );
    expect(result.nodes.map((node) => node.id)).toEqual(["b"]);
    expect(result.edges).toEqual([]);
  });

  it("keeps a real source that also feeds a knot cycle", () => {
    const result = collapse(
      [real("a"), knot("k1"), knot("k2"), real("b")],
      [
        edge("e1", "a.value", "k1.in"),
        edge("e2", "k1.out", "k2.in"),
        edge("e3", "k2.out", "k1.in"),
        edge("e4", "k2.out", "b.value"),
      ],
    );
    expect(result.edges.map((entry) => entry.viaEdgeIds)).toEqual([["e1", "e2", "e4"]]);
  });

  it("extends the segments of an edge that is already collapsed", () => {
    const result = collapse(
      [real("a"), knot("k"), real("b")],
      [
        { ...edge("e1|e2", "a.value", "k.in"), viaEdgeIds: ["e1", "e2"] },
        edge("e3", "k.out", "b.value"),
      ],
    );
    expect(result.edges).toEqual([
      { id: "e1|e2|e3", sourceNodeId: "a", sourcePinId: "value", targetNodeId: "b", targetPinId: "value", viaEdgeIds: ["e1", "e2", "e3"] },
    ]);
  });

  it("wires a diamond of knots as one edge, along its first path in authored order", () => {
    const result = collapse(...Object.values(stackedDiamonds(1)) as [Node[], PinEdgeLike[]]);
    expect(result.edges).toEqual([
      {
        id: "in0|sl0|lj0|last",
        sourceNodeId: "a", sourcePinId: "then", targetNodeId: "c", targetPinId: "execIn",
        viaEdgeIds: ["in0", "sl0", "lj0", "last"],
      },
    ]);
  });

  it("wires twenty stacked diamonds as one edge", () => {
    const { nodes, edges } = stackedDiamonds(20);
    const result = collapse(nodes, edges);
    expect(result.edges.map(({ sourceNodeId, targetNodeId }) => [sourceNodeId, targetNodeId])).toEqual([["a", "c"]]);
    expect(result.edges[0]!.viaEdgeIds).toHaveLength(20 * 3 + 1);
  });

  it("copies the target-side edge's other fields", () => {
    const result = collapsePassThroughNodes(
      [real("a"), knot("k"), real("b")],
      [
        { ...edge("e1", "a.value", "k.in"), color: "red" },
        { ...edge("e2", "k.out", "b.value"), color: "blue" },
      ],
      (node) => node.knot === true,
    );
    expect(result.edges.map((entry) => entry.color)).toEqual(["blue"]);
  });
});

describe("passThroughSources", () => {
  it("returns the direct source of an input without knots", () => {
    expect(sourcesOf([real("a"), real("b")], [edge("e1", "a.value", "b.x")], "b.x")).toEqual([
      { nodeId: "a", pinId: "value" },
    ]);
  });

  it("looks through a single knot", () => {
    const nodes = [real("a"), knot("k"), real("b")];
    const edges = [edge("e1", "a.value", "k.in"), edge("e2", "k.out", "b.x")];
    expect(sourcesOf(nodes, edges, "b.x")).toEqual([{ nodeId: "a", pinId: "value" }]);
  });

  it("looks through a chain of three knots", () => {
    const nodes = [real("a"), knot("k1"), knot("k2"), knot("k3"), real("b")];
    const edges = [
      edge("e1", "a.value", "k1.in"),
      edge("e2", "k1.out", "k2.in"),
      edge("e3", "k2.out", "k3.in"),
      edge("e4", "k3.out", "b.x"),
    ];
    expect(sourcesOf(nodes, edges, "b.x")).toEqual([{ nodeId: "a", pinId: "value" }]);
  });

  it("finds the one source behind a knot that fans out", () => {
    const nodes = [real("a"), knot("k"), real("b"), real("c")];
    const edges = [edge("e1", "a.value", "k.in"), edge("e2", "k.out", "b.x"), edge("e3", "k.out", "c.y")];
    expect(sourcesOf(nodes, edges, "c.y")).toEqual([{ nodeId: "a", pinId: "value" }]);
  });

  it("returns every exec source merged by a knot", () => {
    const nodes = [real("a"), real("b"), knot("k"), real("c")];
    const edges = [edge("e1", "a.then", "k.in"), edge("e2", "b.then", "k.in"), edge("e3", "k.out", "c.execIn")];
    expect(sourcesOf(nodes, edges, "c.execIn")).toEqual([
      { nodeId: "a", pinId: "then" },
      { nodeId: "b", pinId: "then" },
    ]);
  });

  it("returns nothing behind a dangling knot or a knot cycle", () => {
    expect(sourcesOf([knot("k"), real("b")], [edge("e1", "k.out", "b.x")], "b.x")).toEqual([]);
    const cycle = [edge("e1", "k1.out", "k2.in"), edge("e2", "k2.out", "k1.in"), edge("e3", "k2.out", "b.x")];
    expect(sourcesOf([knot("k1"), knot("k2"), real("b")], cycle, "b.x")).toEqual([]);
  });

  it("returns the one source behind twenty stacked diamonds", () => {
    const { nodes, edges } = stackedDiamonds(20);
    expect(sourcesOf(nodes, edges, "c.execIn")).toEqual([{ nodeId: "a", pinId: "then" }]);
  });

  it("returns nothing for an unwired input", () => {
    expect(sourcesOf([real("a"), real("b")], [edge("e1", "a.value", "b.x")], "b.y")).toEqual([]);
  });
});

describe("passThroughTargets", () => {
  const targetsOf = (nodes: Node[], edges: PinEdgeLike[], source: string) => {
    const knots = new Set(nodes.filter((node) => node.knot).map((node) => node.id));
    const [nodeId, pinId] = source.split(".") as [string, string];
    return passThroughTargets(serialized(edges), (id) => knots.has(id), nodeId, pinId);
  };

  it("returns every real input behind knots, in wire order", () => {
    const nodes = [real("a"), knot("k1"), knot("k2"), real("b"), real("c"), real("d")];
    const edges = [
      edge("e1", "a.value", "k1.in"),
      edge("e2", "k1.out", "k2.in"),
      edge("e3", "k2.out", "b.x"),
      edge("e4", "k1.out", "c.y"),
      edge("e5", "a.value", "d.z"),
    ];
    expect(targetsOf(nodes, edges, "a.value")).toEqual([
      { nodeId: "b", pinId: "x" },
      { nodeId: "c", pinId: "y" },
      { nodeId: "d", pinId: "z" },
    ]);
  });

  it("returns the one target behind twenty stacked diamonds", () => {
    const { nodes, edges } = stackedDiamonds(20);
    const knots = new Set(nodes.filter((node) => node.knot).map((node) => node.id));
    expect(passThroughTargets(serialized(edges), (id) => knots.has(id), "a", "then")).toEqual([{ nodeId: "c", pinId: "execIn" }]);
  });

  it("returns nothing behind a knot that feeds nothing or a knot cycle", () => {
    expect(targetsOf([real("a"), knot("k")], [edge("e1", "a.value", "k.in")], "a.value")).toEqual([]);
    const cycle = [edge("e1", "a.value", "k1.in"), edge("e2", "k1.out", "k2.in"), edge("e3", "k2.out", "k1.in")];
    expect(targetsOf([real("a"), knot("k1"), knot("k2")], cycle, "a.value")).toEqual([]);
  });
});
