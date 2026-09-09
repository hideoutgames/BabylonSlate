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

const execWithResultOut: SerializedPin[] = [
  execPins[0]!,
  execPins[1]!,
  {
    id: "result",
    name: "result",
    kind: "data",
    direction: "out",
    type: { kind: "string" },
  },
];

const dataInPins: SerializedPin[] = [
  {
    id: "value",
    name: "value",
    kind: "data",
    direction: "in",
    type: { kind: "string" },
  },
];

const dataThruPins: SerializedPin[] = [
  {
    id: "in",
    name: "in",
    kind: "data",
    direction: "in",
    type: { kind: "string" },
  },
  ...dataOutPins,
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

const NODE_W = 100;
const NODE_H = 40;
const EXEC_STEP = NODE_W + FORMAT_GAP_X;
const HANG_Y = NODE_H + FORMAT_GAP_Y;

function pos(
  nodes: readonly FormatNode[],
  id: string,
): { x: number; y: number } {
  return nodes.find((entry) => entry.id === id)!.position;
}

function boxOf(entry: FormatNode): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: entry.position.x,
    y: entry.position.y,
    width: entry.width ?? entry.measured?.width ?? NODE_W,
    height: entry.height ?? entry.measured?.height ?? NODE_H,
  };
}

function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function expectNoOverlaps(nodes: readonly FormatNode[]): void {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      expect(boxesOverlap(boxOf(nodes[i]!), boxOf(nodes[j]!))).toBe(false);
    }
  }
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

  it("does not include data-out successors of an exec chain", () => {
    const nodes = [
      node("event", 0, 0),
      node("call", 200, 0, execWithResultOut),
      node("print", 400, 0, execWithValueIn),
      node("toUpper", 400, 80, dataThruPins),
    ];
    const edges = [
      execEdge("event", "call"),
      execEdge("call", "print"),
      dataEdge("call", "toUpper", "in", "result"),
      dataEdge("toUpper", "print", "value", "value"),
    ];
    expect(collectThenChain("event", nodes, edges)).toEqual([
      "event",
      "call",
      "print",
    ]);
  });

  it("includes data-out successors when the start node is pure", () => {
    const nodes = [
      node("get", 0, 0, dataOutPins),
      node("left", 200, 0, dataInPins),
      node("right", 200, 80, dataInPins),
    ];
    const edges = [
      dataEdge("get", "left"),
      dataEdge("get", "right"),
    ];
    expect(collectThenChain("get", nodes, edges)).toEqual([
      "get",
      "left",
      "right",
    ]);
  });

  it("does not follow exec-out from an impure data consumer of a pure start", () => {
    const nodes = [
      node("get", 0, 0, dataOutPins),
      node("print", 200, 0, execWithValueIn),
      node("later", 400, 0),
    ];
    const edges = [dataEdge("get", "print"), execEdge("print", "later")];
    expect(collectThenChain("get", nodes, edges)).toEqual(["get", "print"]);
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

  it("leaves disconnected selected nodes at their origins instead of merging them onto one row", () => {
    const nodes = [
      node("keep", 0, 0),
      node("b", 80, 40),
      node("a", 20, 90),
    ];
    const next = formatGraphNodes(nodes, [], ["a", "b"]);
    expect(pos(next, "keep")).toEqual({ x: 0, y: 0 });
    expect(pos(next, "a")).toEqual({ x: 20, y: 90 });
    expect(pos(next, "b")).toEqual({ x: 80, y: 40 });
  });

  it("returns the input nodes when nothing is selected", () => {
    const nodes = [node("a", 0, 0)];
    expect(formatGraphNodes(nodes, [], [])).toBe(nodes);
  });

  it("places a data input below-left of a subsequent then-chain node, not on the exec row", () => {
    const nodes = [
      node("a", 10, 20),
      node("b", 12, 90, execWithValueIn),
      node("get", 5, 200, dataOutPins),
    ];
    const edges = [execEdge("a", "b"), dataEdge("get", "b")];
    const next = formatGraphNodes(nodes, edges, ["a"]);
    expect(pos(next, "a")).toEqual({ x: 10, y: 20 });
    expect(pos(next, "b")).toEqual({ x: 10 + EXEC_STEP, y: 20 });
    expect(pos(next, "get")).toEqual({
      x: 10 + EXEC_STEP - NODE_W - FORMAT_GAP_X,
      y: 20 + HANG_Y,
    });
    expectNoOverlaps(next);
  });

  it("places nested data inputs further down-left of their consumer", () => {
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
    expect(pos(next, "b")).toEqual({ x: 10 + EXEC_STEP, y: 20 });
    expect(pos(next, "get")).toEqual({
      x: 10 + EXEC_STEP - NODE_W - FORMAT_GAP_X,
      y: 20 + HANG_Y,
    });
    expect(pos(next, "nested")).toEqual({
      x: 10 + EXEC_STEP - (NODE_W + FORMAT_GAP_X) * 2,
      y: 20 + HANG_Y * 2,
    });
    expectNoOverlaps(next);
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
    expect(pos(next, "stolen")).toEqual({ x: 999, y: 888 });
    expect(pos(next, "prev")).toEqual({ x: 50, y: 50 });
    expect(pos(next, "b")).toEqual({ x: 10 + EXEC_STEP, y: 20 });
    expect(pos(next, "get")).toEqual({
      x: 10 + EXEC_STEP - NODE_W - FORMAT_GAP_X,
      y: 20 + HANG_Y,
    });
  });

  it("stacks a consumer’s data inputs in pin order below the exec row", () => {
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
    expect(pos(next, "b")).toEqual({ x: 10 + EXEC_STEP, y: 20 });
    expect(pos(next, "getFirst")).toEqual({
      x: 10 + EXEC_STEP - NODE_W - FORMAT_GAP_X,
      y: 20 + HANG_Y,
    });
    expect(pos(next, "getSecond")).toEqual({
      x: 10 + EXEC_STEP - NODE_W - FORMAT_GAP_X,
      y: 20 + HANG_Y + NODE_H + FORMAT_GAP_Y,
    });
    expectNoOverlaps(next);
  });

  it("places a shared data input once, below-left of the earliest consumer", () => {
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
    expect(pos(next, "b")).toEqual({ x: 10 + EXEC_STEP, y: 20 });
    expect(pos(next, "c")).toEqual({ x: 10 + EXEC_STEP * 2, y: 20 });
    expect(pos(next, "get")).toEqual({
      x: 10 + EXEC_STEP - NODE_W - FORMAT_GAP_X,
      y: 20 + HANG_Y,
    });
    expectNoOverlaps(next);
  });

  it("places data inputs of the selected start node below-left of it", () => {
    const nodes = [
      node("b", 200, 50, execWithValueIn),
      node("get", 0, 0, dataOutPins),
    ];
    const edges = [dataEdge("get", "b")];
    const next = formatGraphNodes(nodes, edges, ["b"]);
    expect(pos(next, "b")).toEqual({ x: 200, y: 50 });
    expect(pos(next, "get")).toEqual({
      x: 200 - NODE_W - FORMAT_GAP_X,
      y: 50 + HANG_Y,
    });
    expectNoOverlaps(next);
  });

  it("places a call return-value pure below-left of its consumer, not on the exec row", () => {
    const nodes = [
      node("event", 10, 20),
      node("call", 12, 90, execWithResultOut),
      node("print", 15, 200, execWithValueIn),
      node("toUpper", 5, 400, dataThruPins),
    ];
    const edges = [
      execEdge("event", "call"),
      execEdge("call", "print"),
      dataEdge("call", "toUpper", "in", "result"),
      dataEdge("toUpper", "print", "value", "value"),
    ];
    const next = formatGraphNodes(nodes, edges, ["event"]);
    expect(pos(next, "event")).toEqual({ x: 10, y: 20 });
    expect(pos(next, "call")).toEqual({ x: 10 + EXEC_STEP, y: 20 });
    expect(pos(next, "print")).toEqual({ x: 10 + EXEC_STEP * 2, y: 20 });
    expect(pos(next, "toUpper").y).toBeGreaterThanOrEqual(20 + HANG_Y);
    expect(pos(next, "toUpper").x).toBe(10 + EXEC_STEP * 2 - NODE_W - FORMAT_GAP_X);
    expectNoOverlaps(next);
  });

  it("stacks data-out branches of a selected pure node below-right of the source", () => {
    const nodes = [
      node("get", 10, 20, dataOutPins),
      node("first", 0, 200, dataInPins),
      node("second", 0, 0, dataInPins),
    ];
    const edges = [
      dataEdge("get", "first"),
      dataEdge("get", "second"),
    ];
    const next = formatGraphNodes(nodes, edges, ["get"]);
    expect(pos(next, "get")).toEqual({ x: 10, y: 20 });
    expect(pos(next, "second")).toEqual({
      x: 10 + EXEC_STEP,
      y: 20 + HANG_Y,
    });
    expect(pos(next, "first")).toEqual({
      x: 10 + EXEC_STEP,
      y: 20 + HANG_Y + NODE_H + FORMAT_GAP_Y,
    });
    expectNoOverlaps(next);
  });

  it("does not pull exec successors when formatting from a pure node", () => {
    const nodes = [
      node("get", 10, 20, dataOutPins),
      node("print", 200, 50, execWithValueIn),
      node("later", 400, 80),
    ];
    const edges = [dataEdge("get", "print"), execEdge("print", "later")];
    const next = formatGraphNodes(nodes, edges, ["get"]);
    expect(pos(next, "get")).toEqual({ x: 10, y: 20 });
    expect(pos(next, "print")).toEqual({
      x: 10 + EXEC_STEP,
      y: 20 + HANG_Y,
    });
    expect(pos(next, "later")).toEqual({ x: 400, y: 80 });
  });

  it("formats two unconnected chain parents independently instead of merging onto one row", () => {
    const nodes = [
      node("a", 10, 20),
      node("b", 12, 90),
      node("c", 10, 400),
      node("d", 50, 480),
    ];
    const edges = [execEdge("a", "b"), execEdge("c", "d")];
    const next = formatGraphNodes(nodes, edges, ["a", "c"]);
    expect(pos(next, "a")).toEqual({ x: 10, y: 20 });
    expect(pos(next, "b")).toEqual({ x: 10 + EXEC_STEP, y: 20 });
    expect(pos(next, "c")).toEqual({ x: 10, y: 400 });
    expect(pos(next, "d")).toEqual({ x: 10 + EXEC_STEP, y: 400 });
    expectNoOverlaps(next);
  });

  it("formats from the ancestor when two selected nodes share one then-chain", () => {
    const nodes = [
      node("a", 10, 20),
      node("b", 12, 90),
      node("c", 15, 200),
    ];
    const edges = [execEdge("a", "b"), execEdge("b", "c")];
    const next = formatGraphNodes(nodes, edges, ["a", "b"]);
    expect(pos(next, "a")).toEqual({ x: 10, y: 20 });
    expect(pos(next, "b")).toEqual({ x: 10 + EXEC_STEP, y: 20 });
    expect(pos(next, "c")).toEqual({ x: 10 + EXEC_STEP * 2, y: 20 });
  });

    it("keeps branch exec stacked and hangs data off the branch without overlapping", () => {
      const nodes = [
        node("branch", 0, 0, branchPins),
        node("yes", 20, 40, execWithValueIn),
        node("no", 25, 10),
        node("get", 1, 300, dataOutPins),
      ];
      const edges = [
        execEdge("branch", "yes", "true"),
        execEdge("branch", "no", "false"),
        dataEdge("get", "yes"),
      ];
      const next = formatGraphNodes(nodes, edges, ["branch"]);
      expect(pos(next, "no")).toEqual({ x: EXEC_STEP, y: 0 });
      expect(pos(next, "yes")).toEqual({ x: EXEC_STEP, y: NODE_H + FORMAT_GAP_Y });
      expect(pos(next, "get").x).toBe(EXEC_STEP - NODE_W - FORMAT_GAP_X);
      expect(pos(next, "get").y).toBeGreaterThanOrEqual(
        pos(next, "yes").y + HANG_Y,
      );
      expectNoOverlaps(next);
    });

    it("does not push the next branch exec below the first successor’s hanging data", () => {
      const nodes = [
        node("branch", 0, 0, branchPins),
        node("yes", 20, 40),
        node("no", 25, 10, execWithValueIn),
        node("get", 1, 300, dataOutPins),
      ];
      const edges = [
        execEdge("branch", "yes", "true"),
        execEdge("branch", "no", "false"),
        dataEdge("get", "no"),
      ];
      const next = formatGraphNodes(nodes, edges, ["branch"]);
      expect(pos(next, "no")).toEqual({ x: EXEC_STEP, y: 0 });
      expect(pos(next, "yes")).toEqual({ x: EXEC_STEP, y: NODE_H + FORMAT_GAP_Y });
      expect(pos(next, "get")).toEqual({
        x: EXEC_STEP - NODE_W - FORMAT_GAP_X,
        y: HANG_Y,
      });
      expectNoOverlaps(next);
    });

    it("hangs data off both stacked branch execs without merging them onto one hang row", () => {
      const nodes = [
        node("branch", 0, 0, branchPins),
        node("yes", 20, 40, execWithValueIn),
        node("no", 25, 10, execWithValueIn),
        node("getNo", 1, 300, dataOutPins),
        node("getYes", 2, 400, dataOutPins),
      ];
      const edges = [
        execEdge("branch", "yes", "true"),
        execEdge("branch", "no", "false"),
        dataEdge("getNo", "no"),
        dataEdge("getYes", "yes"),
      ];
      const next = formatGraphNodes(nodes, edges, ["branch"]);
      expect(pos(next, "no")).toEqual({ x: EXEC_STEP, y: 0 });
      expect(pos(next, "yes")).toEqual({ x: EXEC_STEP, y: NODE_H + FORMAT_GAP_Y });
      expect(pos(next, "getNo")).toEqual({
        x: EXEC_STEP - NODE_W - FORMAT_GAP_X,
        y: HANG_Y,
      });
      expect(pos(next, "getYes").x).toBe(EXEC_STEP - NODE_W - FORMAT_GAP_X);
      expect(pos(next, "getYes").y).toBeGreaterThanOrEqual(
        pos(next, "yes").y + HANG_Y,
      );
      expectNoOverlaps(next);
    });

    it("nudges hanging data of stacked branches apart without moving the later exec", () => {
      const nodes = [
        node("branch", 0, 0, branchPins),
        node("yes", 20, 40, execWithValueIn),
        node("no", 25, 10, twoDataInPins),
        node("getFirst", 1, 300, dataOutPins),
        node("getSecond", 2, 320, dataOutPins),
        node("getYes", 3, 400, dataOutPins),
      ];
      const edges = [
        execEdge("branch", "yes", "true"),
        execEdge("branch", "no", "false"),
        dataEdge("getFirst", "no", "first"),
        dataEdge("getSecond", "no", "second"),
        dataEdge("getYes", "yes"),
      ];
      const next = formatGraphNodes(nodes, edges, ["branch"]);
      expect(pos(next, "no")).toEqual({ x: EXEC_STEP, y: 0 });
      expect(pos(next, "yes")).toEqual({ x: EXEC_STEP, y: NODE_H + FORMAT_GAP_Y });
      expectNoOverlaps(next);
    });

  it("shifts overlapping isolated selected nodes apart", () => {
    const nodes = [node("a", 0, 0), node("b", 10, 10)];
    const next = formatGraphNodes(nodes, [], ["a", "b"]);
    expect(pos(next, "a")).toEqual({ x: 0, y: 0 });
    expect(pos(next, "b").y).toBeGreaterThanOrEqual(NODE_H + FORMAT_GAP_Y);
    expectNoOverlaps(next);
  });

  it("places an asymmetric merge after every incoming execution path", () => {
    const nodes = [
      node("branch", 10, 20, branchPins),
      node("merge", 0, 0),
      node("after", 0, 400),
      ...Array.from({ length: 8 }, (_, index) =>
        node(`long${index}`, 0, 100 + index * 10),
      ),
    ];
    const edges = [
      execEdge("branch", "merge", "true"),
      execEdge("branch", "long0", "false"),
      ...Array.from({ length: 7 }, (_, index) =>
        execEdge(`long${index}`, `long${index + 1}`),
      ),
      execEdge("long7", "merge"),
      execEdge("merge", "after"),
    ];
    const next = formatGraphNodes(nodes, edges, ["branch"]);
    expect(pos(next, "branch")).toEqual({ x: 10, y: 20 });
    for (const edge of edges) {
      expect(pos(next, edge.target).x).toBeGreaterThanOrEqual(
        pos(next, edge.source).x + NODE_W + FORMAT_GAP_X,
      );
    }
    expect(pos(next, "after").y).toBe(pos(next, "merge").y);
    expectNoOverlaps(next);
    expect(formatGraphNodes(next, edges, ["branch"])).toEqual(next);
  });

  it("keeps nested execution branches on continuous rows despite scrambled node positions", () => {
    const nodes = [
      node("root", 0, 0, branchPins),
      node("upper", 0, 10, branchPins),
      node("lower", 0, 20),
      node("upperFirst", 0, 200),
      node("upperSecond", 0, 300),
      node("upperFirstEnd", 0, 900),
      node("upperSecondEnd", 0, 0),
      node("lowerEnd", 0, -50),
    ];
    const edges = [
      execEdge("root", "upper", "true"),
      execEdge("root", "lower", "false"),
      execEdge("upper", "upperFirst", "true"),
      execEdge("upper", "upperSecond", "false"),
      execEdge("upperFirst", "upperFirstEnd"),
      execEdge("upperSecond", "upperSecondEnd"),
      execEdge("lower", "lowerEnd"),
    ];
    const next = formatGraphNodes(nodes, edges, ["root"]);
    expect(pos(next, "upperFirstEnd").y).toBe(pos(next, "upperFirst").y);
    expect(pos(next, "upperSecondEnd").y).toBe(pos(next, "upperSecond").y);
    expect(pos(next, "lowerEnd").y).toBe(pos(next, "lower").y);
    expect(pos(next, "lower").y).toBeGreaterThanOrEqual(
      pos(next, "upperSecondEnd").y + NODE_H + FORMAT_GAP_Y,
    );
    expectNoOverlaps(next);
    expect(formatGraphNodes(next, [...edges].reverse(), ["root"])).toEqual(next);
  });

  it("compacts a deep pure input tree into left-side rows and reserves space ahead of execution", () => {
    const nodes = [
      node("start", 10, 20),
      node("consumer", 30, 40, execWithValueIn),
      ...Array.from({ length: 12 }, (_, index) =>
        node(`pure${index}`, index * 20, index * 100, dataThruPins),
      ),
      {
        id: "wide",
        position: { x: 0, y: 0 },
        measured: { width: 250, height: 140 },
        pins: dataOutPins,
      },
      node("unrelated", 9999, 9999),
    ];
    const edges = [
      execEdge("start", "consumer"),
      dataEdge("pure0", "consumer"),
      ...Array.from({ length: 11 }, (_, index) =>
        dataEdge(`pure${index + 1}`, `pure${index}`, "in"),
      ),
      dataEdge("wide", "pure11", "in"),
    ];
    const next = formatGraphNodes(nodes, edges, ["start"]);
    const parameters = next.filter((entry) => entry.id.startsWith("pure") || entry.id === "wide");
    expect(new Set(parameters.map((entry) => entry.position.y)).size).toBe(1);
    expect(pos(next, "wide").x).toBeGreaterThanOrEqual(
      pos(next, "start").x + NODE_W + FORMAT_GAP_X,
    );
    for (const edge of edges.slice(1)) {
      const source = next.find((entry) => entry.id === edge.source)!;
      expect(source.position.x + boxOf(source).width + FORMAT_GAP_X)
        .toBeLessThanOrEqual(pos(next, edge.target).x);
    }
    expect(pos(next, "consumer").y).toBe(pos(next, "start").y);
    expect(next.find((entry) => entry.id === "unrelated")).toBe(nodes[nodes.length - 1]);
    expect(pos(nodes, "consumer")).toEqual({ x: 30, y: 40 });
    expectNoOverlaps(next);
    expect(formatGraphNodes(next, edges, ["start"])).toEqual(next);
  });

  it("keeps dense branch parameter groups separate without displacing execution rows", () => {
    const nodes = [node("root", 0, 0)];
    const edges: FormatEdge[] = [];
    for (let index = 0; index < 72; index++) {
      nodes.push(
        node(`consumer${index}`, 0, index, twoDataInPins),
        node(`first${index}`, 0, 0, dataOutPins),
        node(`second${index}`, 0, 0, dataOutPins),
      );
      edges.push(
        execEdge("root", `consumer${index}`),
        dataEdge(`first${index}`, `consumer${index}`, "first"),
        dataEdge(`second${index}`, `consumer${index}`, "second"),
      );
    }
    const next = formatGraphNodes(nodes, edges, ["root"]);
    for (let index = 0; index < 72; index++) {
      expect(pos(next, `consumer${index}`).y).toBe(index * HANG_Y);
      expect(pos(next, `second${index}`).y - pos(next, `first${index}`).y).toBe(HANG_Y);
    }
    expectNoOverlaps(next);
    expect(formatGraphNodes(next, edges, ["root"])).toEqual(next);
  });

  it("places a shared pure dependency before both its direct and indirect consumers", () => {
    const nodes = [
      node("consumer", 500, 50, twoDataInPins),
      node("shared", 0, 0, dataOutPins),
      node("derived", 0, 100, dataThruPins),
    ];
    const edges = [
      dataEdge("shared", "consumer", "first"),
      dataEdge("derived", "consumer", "second"),
      dataEdge("shared", "derived", "in"),
    ];
    const next = formatGraphNodes(nodes, edges, ["consumer"]);
    expect(pos(next, "shared").x + NODE_W + FORMAT_GAP_X).toBeLessThanOrEqual(
      pos(next, "derived").x,
    );
    expect(pos(next, "derived").x + NODE_W + FORMAT_GAP_X).toBeLessThanOrEqual(
      pos(next, "consumer").x,
    );
    expectNoOverlaps(next);
    expect(formatGraphNodes(next, edges, ["consumer"])).toEqual(next);
  });

  it("compacts a long selected pure chain while keeping a data merge after every predecessor", () => {
    const nodes = [
      ...Array.from({ length: 9 }, (_, index) =>
        node(`pure${index}`, 0, index * 100, dataThruPins),
      ),
      node("merge", 0, -100, dataThruPins),
    ];
    const edges = [
      ...Array.from({ length: 8 }, (_, index) =>
        dataEdge(`pure${index}`, `pure${index + 1}`, "in"),
      ),
      dataEdge("pure0", "merge", "in"),
      dataEdge("pure8", "merge", "in"),
    ];
    const next = formatGraphNodes(nodes, edges, ["pure0"]);
    for (const edge of edges) {
      expect(pos(next, edge.source).x + NODE_W + FORMAT_GAP_X)
        .toBeLessThanOrEqual(pos(next, edge.target).x);
    }
    expect(new Set(next.map((entry) => entry.position.y)).size).toBeLessThanOrEqual(2);
    expectNoOverlaps(next);
    expect(formatGraphNodes(next, edges, ["pure0"])).toEqual(next);
  });

  it("formats a selected execution cycle once instead of discarding all selected roots", () => {
    const nodes = [node("a", 0, 0), node("b", 0, 0), node("c", 0, 0)];
    const edges = [execEdge("a", "b"), execEdge("b", "c"), execEdge("c", "a")];
    const next = formatGraphNodes(nodes, edges, ["b", "a"]);
    expect(pos(next, "a")).toEqual({ x: 0, y: 0 });
    expect(pos(next, "b").x).toBeGreaterThan(pos(next, "a").x);
    expect(pos(next, "c").x).toBeGreaterThan(pos(next, "b").x);
    expectNoOverlaps(next);
    expect(formatGraphNodes(next, edges, ["b", "a"])).toEqual(next);
  });

  it("keeps a shared parameter with the first independently selected chain", () => {
    const nodes = [
      node("a", 10, 20),
      node("b", 0, 0, execWithValueIn),
      node("c", 10, 400),
      node("d", 0, 0, execWithValueIn),
      node("shared", 0, 800, dataOutPins),
    ];
    const edges = [
      execEdge("a", "b"),
      execEdge("c", "d"),
      dataEdge("shared", "b"),
      dataEdge("shared", "d"),
    ];
    const next = formatGraphNodes(nodes, edges, ["c", "a"]);
    expect(pos(next, "shared")).toEqual({ x: 10, y: 20 + HANG_Y });
    expect(pos(next, "c")).toEqual({ x: 10, y: 400 });
    expectNoOverlaps(next);
    expect(formatGraphNodes(next, edges, ["a", "c"])).toEqual(next);
  });

  it("keeps a shortcut merge stable after its longer path becomes aligned", () => {
    const nodes = [node("root", 0, 0), node("z", 0, 10), node("a", 0, 100)];
    const edges = [execEdge("root", "z"), execEdge("root", "a"), execEdge("z", "a")];
    const next = formatGraphNodes(nodes, edges, ["root"]);
    expect(pos(next, "z").y).toBe(pos(next, "a").y);
    expect(formatGraphNodes(next, edges, ["root"])).toEqual(next);
  });

  it("formats selected roots that converge using the full length of both paths", () => {
    const nodes = [
      node("first", 10, 20),
      node("second", 10, 300),
      node("long0", 0, 400),
      node("long1", 0, 500),
      node("merge", 0, 0),
      node("after", 0, 100),
    ];
    const edges = [
      execEdge("first", "merge"),
      execEdge("second", "long0"),
      execEdge("long0", "long1"),
      execEdge("long1", "merge"),
      execEdge("merge", "after"),
    ];
    const next = formatGraphNodes(nodes, edges, ["second", "first"]);
    expect(pos(next, "first")).toEqual({ x: 10, y: 20 });
    for (const edge of edges) {
      expect(pos(next, edge.source).x + NODE_W + FORMAT_GAP_X)
        .toBeLessThanOrEqual(pos(next, edge.target).x);
    }
    expectNoOverlaps(next);
    expect(formatGraphNodes(next, edges, ["first", "second"])).toEqual(next);
  });

  it("honors both selected pure and execution walks without moving shared nodes twice", () => {
    const nodes = [
      node("pure", 0, 0, dataOutPins),
      node("consumer", 100, 100, execWithValueIn),
      node("after", 0, 999),
      node("otherConsumer", 0, -200, dataInPins),
    ];
    const edges = [
      dataEdge("pure", "consumer"),
      dataEdge("pure", "otherConsumer"),
      execEdge("consumer", "after"),
    ];
    const next = formatGraphNodes(nodes, edges, ["pure", "consumer"]);
    expect(pos(next, "consumer")).toEqual({ x: 100, y: 100 });
    expect(pos(next, "after")).toEqual({ x: 100 + EXEC_STEP, y: 100 });
    expect(pos(next, "otherConsumer").x).toBeGreaterThan(pos(next, "pure").x);
    expect(pos(next, "otherConsumer")).not.toEqual(pos(nodes, "otherConsumer"));
    expectNoOverlaps(next);
    expect(formatGraphNodes(next, edges, ["consumer", "pure"])).toEqual(next);
  });
});
