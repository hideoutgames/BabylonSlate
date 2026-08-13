import { describe, expect, it } from "vitest";
import type { SerializedPin } from "./graph-types";
import {
  FORMAT_GAP_X,
  FORMAT_GAP_Y,
  collectThenChain,
  formatGraphNodes,
  type FormatEdge,
  type FormatNode,
} from "./graph-format";

const execPins: SerializedPin[] = [
  {
    id: "execIn",
    name: "exec",
    kind: "exec",
    direction: "in",
    type: { kind: "exec" },
  },
  {
    id: "execOut",
    name: "then",
    kind: "exec",
    direction: "out",
    type: { kind: "exec" },
  },
];

const branchPins: SerializedPin[] = [
  {
    id: "execIn",
    name: "exec",
    kind: "exec",
    direction: "in",
    type: { kind: "exec" },
  },
  {
    id: "true",
    name: "true",
    kind: "exec",
    direction: "out",
    type: { kind: "exec" },
  },
  {
    id: "false",
    name: "false",
    kind: "exec",
    direction: "out",
    type: { kind: "exec" },
  },
];

const dataOutPins: SerializedPin[] = [
  {
    id: "value",
    name: "value",
    kind: "data",
    direction: "out",
    type: { kind: "string" },
  },
];

const execWithValueIn: SerializedPin[] = [
  execPins[0]!,
  {
    id: "value",
    name: "value",
    kind: "data",
    direction: "in",
    type: { kind: "string" },
  },
  execPins[1]!,
];

const twoDataInPins: SerializedPin[] = [
  execPins[0]!,
  {
    id: "first",
    name: "first",
    kind: "data",
    direction: "in",
    type: { kind: "float" },
  },
  {
    id: "second",
    name: "second",
    kind: "data",
    direction: "in",
    type: { kind: "float" },
  },
  execPins[1]!,
];

function node(
  id: string,
  x: number,
  y: number,
  pins: SerializedPin[] = execPins,
  size = { width: 100, height: 40 },
): FormatNode {
  return { id, position: { x, y }, pins, ...size };
}

function execEdge(
  source: string,
  target: string,
  sourceHandle = "execOut",
): FormatEdge {
  return { source, target, sourceHandle, targetHandle: "execIn" };
}

function dataEdge(
  source: string,
  target: string,
  targetHandle = "value",
  sourceHandle = "value",
): FormatEdge {
  return { source, target, sourceHandle, targetHandle };
}

describe("collectThenChain", () => {
  it("includes the start node and exec-out successors", () => {
    const nodes = [node("a", 0, 0), node("b", 40, 80), node("c", 10, 200)];
    const edges = [execEdge("a", "b"), execEdge("b", "c")];
    expect(collectThenChain("a", nodes, edges)).toEqual(["a", "b", "c"]);
  });

  it("does not walk left into exec-in sources", () => {
    const nodes = [node("a", 0, 0), node("b", 200, 0)];
    const edges = [execEdge("a", "b")];
    expect(collectThenChain("b", nodes, edges)).toEqual(["b"]);
  });

  it("stops on cycles", () => {
    const nodes = [node("a", 0, 0), node("b", 200, 0)];
    const edges = [execEdge("a", "b"), execEdge("b", "a")];
    expect(collectThenChain("a", nodes, edges)).toEqual(["a", "b"]);
  });

  it("includes data-out successors of the exec chain", () => {
    const nodes = [
      node("a", 0, 0),
      node("b", 200, 0),
      node("pure", 400, 80, dataOutPins),
    ];
    const edges = [
      execEdge("a", "b"),
      { source: "b", target: "pure", sourceHandle: "message" },
    ];
    expect(collectThenChain("a", nodes, edges)).toEqual(["a", "b", "pure"]);
  });

  it("does not include data-in sources of the exec chain", () => {
    const nodes = [
      node("a", 0, 0),
      node("b", 200, 0, execWithValueIn),
      node("get", 5, 200, dataOutPins),
    ];
    const edges = [execEdge("a", "b"), dataEdge("get", "b")];
    expect(collectThenChain("a", nodes, edges)).toEqual(["a", "b"]);
  });
});

describe("formatGraphNodes", () => {
  it("is a no-op for an isolated selected node", () => {
    const nodes = [node("solo", 40, 80)];
    expect(formatGraphNodes(nodes, [], ["solo"])).toEqual(nodes);
  });

  it("lays out a then-chain left to right from the selected origin", () => {
    const nodes = [
      node("a", 10, 20),
      node("b", 12, 90),
      node("c", 15, 200),
    ];
    const edges = [execEdge("a", "b"), execEdge("b", "c")];
    const next = formatGraphNodes(nodes, edges, ["a"]);
    expect(next.find((entry) => entry.id === "a")?.position).toEqual({
      x: 10,
      y: 20,
    });
    expect(next.find((entry) => entry.id === "b")?.position).toEqual({
      x: 10 + 100 + FORMAT_GAP_X,
      y: 20,
    });
    expect(next.find((entry) => entry.id === "c")?.position).toEqual({
      x: 10 + (100 + FORMAT_GAP_X) * 2,
      y: 20,
    });
  });

  it("stacks branch exec-out successors in one layer", () => {
    const nodes = [
      node("branch", 0, 0, branchPins),
      node("yes", 20, 40),
      node("no", 25, 10),
    ];
    const edges = [
      execEdge("branch", "yes", "true"),
      execEdge("branch", "no", "false"),
    ];
    const next = formatGraphNodes(nodes, edges, ["branch"]);
    const yes = next.find((entry) => entry.id === "yes")!;
    const no = next.find((entry) => entry.id === "no")!;
    expect(yes.position.x).toBe(100 + FORMAT_GAP_X);
    expect(no.position.x).toBe(100 + FORMAT_GAP_X);
    expect(no.position.y).toBe(0);
    expect(yes.position.y).toBe(40 + FORMAT_GAP_Y);
  });

  it("tidies several selected nodes into a row from the selection top-left", () => {
    const nodes = [
      node("keep", 0, 0),
      node("b", 80, 40),
      node("a", 20, 90),
    ];
    const next = formatGraphNodes(nodes, [], ["a", "b"]);
    expect(next.find((entry) => entry.id === "keep")?.position).toEqual({
      x: 0,
      y: 0,
    });
    expect(next.find((entry) => entry.id === "a")?.position).toEqual({
      x: 20,
      y: 40,
    });
    expect(next.find((entry) => entry.id === "b")?.position).toEqual({
      x: 20 + 100 + FORMAT_GAP_X,
      y: 40,
    });
  });

  it("returns the input nodes when nothing is selected", () => {
    const nodes = [node("a", 0, 0)];
    expect(formatGraphNodes(nodes, [], [])).toBe(nodes);
  });

  it("places a data input immediately left of a subsequent then-chain node", () => {
    const nodes = [
      node("a", 10, 20),
      node("b", 12, 90, execWithValueIn),
      node("get", 5, 200, dataOutPins),
    ];
    const edges = [execEdge("a", "b"), dataEdge("get", "b")];
    const next = formatGraphNodes(nodes, edges, ["a"]);
    expect(next.find((entry) => entry.id === "a")?.position).toEqual({
      x: 10,
      y: 20,
    });
    expect(next.find((entry) => entry.id === "get")?.position).toEqual({
      x: 10 + 100 + FORMAT_GAP_X,
      y: 20,
    });
    expect(next.find((entry) => entry.id === "b")?.position).toEqual({
      x: 10 + (100 + FORMAT_GAP_X) * 2,
      y: 20,
    });
  });

  it("places nested data inputs further left of their consumer", () => {
    const nodes = [
      node("a", 10, 20),
      node("b", 12, 90, execWithValueIn),
      node("get", 5, 200, [
        ...dataOutPins,
        {
          id: "in",
          name: "in",
          kind: "data",
          direction: "in",
          type: { kind: "string" },
        },
      ]),
      node("nested", 1, 300, dataOutPins),
    ];
    const edges = [
      execEdge("a", "b"),
      dataEdge("get", "b"),
      dataEdge("nested", "get", "in"),
    ];
    const next = formatGraphNodes(nodes, edges, ["a"]);
    expect(next.find((entry) => entry.id === "nested")?.position).toEqual({
      x: 10 + 100 + FORMAT_GAP_X,
      y: 20,
    });
    expect(next.find((entry) => entry.id === "get")?.position).toEqual({
      x: 10 + (100 + FORMAT_GAP_X) * 2,
      y: 20,
    });
    expect(next.find((entry) => entry.id === "b")?.position).toEqual({
      x: 10 + (100 + FORMAT_GAP_X) * 3,
      y: 20,
    });
  });

  it("moves a dangling data input but does not steal a source with incoming exec", () => {
    const nodes = [
      node("a", 10, 20),
      node("b", 12, 90, twoDataInPins),
      node("get", 1, 2, dataOutPins),
      node("prev", 50, 50),
      node("stolen", 999, 888, [...execPins, ...dataOutPins]),
    ];
    const edges = [
      execEdge("a", "b"),
      dataEdge("get", "b", "first"),
      execEdge("prev", "stolen"),
      dataEdge("stolen", "b", "second"),
    ];
    const next = formatGraphNodes(nodes, edges, ["a"]);
    expect(next.find((entry) => entry.id === "stolen")?.position).toEqual({
      x: 999,
      y: 888,
    });
    expect(next.find((entry) => entry.id === "prev")?.position).toEqual({
      x: 50,
      y: 50,
    });
    expect(next.find((entry) => entry.id === "get")?.position).toEqual({
      x: 10 + 100 + FORMAT_GAP_X,
      y: 20,
    });
    expect(next.find((entry) => entry.id === "b")?.position).toEqual({
      x: 10 + (100 + FORMAT_GAP_X) * 2,
      y: 20,
    });
  });

  it("stacks a consumer’s data inputs in pin order", () => {
    const nodes = [
      node("a", 10, 20),
      node("b", 12, 90, twoDataInPins),
      node("getSecond", 0, 0, dataOutPins),
      node("getFirst", 0, 200, dataOutPins),
    ];
    const edges = [
      execEdge("a", "b"),
      dataEdge("getSecond", "b", "second"),
      dataEdge("getFirst", "b", "first"),
    ];
    const next = formatGraphNodes(nodes, edges, ["a"]);
    expect(next.find((entry) => entry.id === "getFirst")?.position).toEqual({
      x: 10 + 100 + FORMAT_GAP_X,
      y: 20,
    });
    expect(next.find((entry) => entry.id === "getSecond")?.position).toEqual({
      x: 10 + 100 + FORMAT_GAP_X,
      y: 20 + 40 + FORMAT_GAP_Y,
    });
    expect(next.find((entry) => entry.id === "b")?.position).toEqual({
      x: 10 + (100 + FORMAT_GAP_X) * 2,
      y: 20,
    });
  });

  it("places a shared data input once, next to the earliest consumer", () => {
    const nodes = [
      node("a", 10, 20),
      node("b", 12, 90, execWithValueIn),
      node("c", 15, 200, execWithValueIn),
      node("get", 5, 400, dataOutPins),
    ];
    const edges = [
      execEdge("a", "b"),
      execEdge("b", "c"),
      dataEdge("get", "b"),
      dataEdge("get", "c"),
    ];
    const next = formatGraphNodes(nodes, edges, ["a"]);
    expect(next.find((entry) => entry.id === "get")?.position).toEqual({
      x: 10 + 100 + FORMAT_GAP_X,
      y: 20,
    });
    expect(next.find((entry) => entry.id === "b")?.position).toEqual({
      x: 10 + (100 + FORMAT_GAP_X) * 2,
      y: 20,
    });
    expect(next.find((entry) => entry.id === "c")?.position).toEqual({
      x: 10 + (100 + FORMAT_GAP_X) * 3,
      y: 20,
    });
  });

  it("places data inputs of the selected start node to its left", () => {
    const nodes = [
      node("b", 200, 50, execWithValueIn),
      node("get", 0, 0, dataOutPins),
    ];
    const edges = [dataEdge("get", "b")];
    const next = formatGraphNodes(nodes, edges, ["b"]);
    expect(next.find((entry) => entry.id === "b")?.position).toEqual({
      x: 200,
      y: 50,
    });
    expect(next.find((entry) => entry.id === "get")?.position).toEqual({
      x: 200 - 100 - FORMAT_GAP_X,
      y: 50,
    });
  });
});
