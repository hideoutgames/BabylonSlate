import { describe, expect, it } from "vitest";
import type { SerializedPin } from "./graph-types";
import {
  FORMAT_GAP_X,
  FORMAT_GAP_Y,
  formatGraphNodes,
  type FormatEdge,
  type FormatNode,
  type FormatOptions,
  type FormatResult,
  formatPinOffsetKey,
} from "./graph-format";
import { REROUTE_KNOT_SIZE } from "./graph-virtualize";

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

// A one-column parameter block moves its consumer right by that column's width and gap.
const BLOCK = NODE_W + FORMAT_GAP_X;
// The lane after a node that branches to a lower row past parameter blocks: a knot and a gap.
const KNOT_LANE = REROUTE_KNOT_SIZE.width + FORMAT_GAP_X;
// A block's top below a consumer whose first data input is on the second pin row (after the
// exec row): that row's estimated bottom (50 + 2 × 44) plus the 64 gap.
const LANE = 202;
// Branch rows sit one and a half gaps apart, a little further than nodes within a block.
const ROW_GAP = 96;

/** The formatted nodes, for layouts that request no knots. */
function layout(
  nodes: FormatNode[],
  edges: readonly FormatEdge[],
  selectedIds: readonly string[],
  options?: FormatOptions,
): FormatNode[] {
  return formatGraphNodes(nodes, edges, selectedIds, options).nodes;
}

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

describe("formatGraphNodes", () => {
  it("is a no-op for an isolated selected node", () => {
    const nodes = [node("solo", 40, 80)];
    expect(layout(nodes, [], ["solo"])).toEqual(nodes);
  });

  it("lays out a then-chain left to right from the selected origin", () => {
    const nodes = [
      node("a", 10, 20),
      node("b", 12, 90),
      node("c", 15, 200),
    ];
    const edges = [execEdge("a", "b"), execEdge("b", "c")];
    const next = layout(nodes, edges, ["a"]);
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
    const next = layout(nodes, edges, ["branch"]);
    const yes = next.find((entry) => entry.id === "yes")!;
    const no = next.find((entry) => entry.id === "no")!;
    // Branch outputs in pin order: True keeps the row, False's row comes next.
    expect(yes.position.x).toBe(100 + FORMAT_GAP_X);
    expect(no.position.x).toBe(100 + FORMAT_GAP_X);
    expect(yes.position.y).toBe(0);
    expect(no.position.y).toBe(40 + ROW_GAP);
  });

  it("leaves disconnected selected nodes at their origins instead of merging them onto one row", () => {
    const nodes = [
      node("keep", 0, 0),
      node("b", 80, 40),
      node("a", 20, 90),
    ];
    const next = layout(nodes, [], ["a", "b"]);
    expect(pos(next, "keep")).toEqual({ x: 0, y: 0 });
    expect(pos(next, "a")).toEqual({ x: 20, y: 90 });
    expect(pos(next, "b")).toEqual({ x: 80, y: 40 });
  });

  it("leaves the exec-in source of a selected mid-chain node in place", () => {
    const nodes = [node("a", 0, 0), node("b", 200, 40), node("c", 10, 300)];
    const edges = [execEdge("a", "b"), execEdge("b", "c")];
    const next = layout(nodes, edges, ["b"]);
    expect(pos(next, "a")).toEqual({ x: 0, y: 0 });
    expect(pos(next, "b")).toEqual({ x: 200, y: 40 });
    expect(pos(next, "c")).toEqual({ x: 200 + EXEC_STEP, y: 40 });
  });

  it("returns the input nodes when nothing is selected", () => {
    const nodes = [node("a", 0, 0)];
    expect(layout(nodes, [], [])).toBe(nodes);
  });

  it("places a data input below-left of a subsequent then-chain node, not on the exec row", () => {
    const nodes = [
      node("a", 10, 20),
      node("b", 12, 90, execWithValueIn),
      node("get", 5, 200, dataOutPins),
    ];
    const edges = [execEdge("a", "b"), dataEdge("get", "b")];
    const next = layout(nodes, edges, ["a"]);
    expect(pos(next, "a")).toEqual({ x: 10, y: 20 });
    // The block's column is reserved between a and b, so its wires never run back under a.
    expect(pos(next, "b")).toEqual({ x: 10 + EXEC_STEP + BLOCK, y: 20 });
    expect(pos(next, "get")).toEqual({ x: 10 + EXEC_STEP, y: 20 + LANE });
    expectNoOverlaps(next);
  });

  it("counts an unmeasured node's Add Pin control as one more pin row when stacking below it", () => {
    // `upper` is unmeasured with one pin row per side: 120 tall (the fallback minimum), 138 with
    // the Add Pin row (50 + 2 × 44). `lower` feeds the next input and clears it by the gap.
    const stacked = (addPin: FormatNode["addPin"]) => {
      const nodes: FormatNode[] = [
        node("a", 0, 0),
        node("b", 0, 0, twoDataInPins),
        { id: "upper", position: { x: 0, y: 0 }, pins: dataThruPins, addPin },
        node("lower", 0, 0, dataOutPins),
      ];
      const edges = [
        execEdge("a", "b"),
        dataEdge("upper", "b", "first"),
        dataEdge("lower", "b", "second"),
      ];
      const next = layout(nodes, edges, ["a"]);
      return pos(next, "lower").y - pos(next, "upper").y;
    };
    expect(stacked(undefined)).toBe(120 + FORMAT_GAP_Y);
    expect(stacked({ side: "in", label: "Add Pin" })).toBe(138 + FORMAT_GAP_Y);
  });

  it("places a nested data input further left on its consumer's row, its wire level", () => {
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
    const next = layout(nodes, edges, ["a"]);
    expect(pos(next, "b")).toEqual({ x: 10 + EXEC_STEP + BLOCK * 2, y: 20 });
    expect(pos(next, "get")).toEqual({ x: 10 + EXEC_STEP + BLOCK, y: 20 + LANE });
    expect(pos(next, "nested")).toEqual({ x: 10 + EXEC_STEP, y: 20 + LANE });
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
    const next = layout(nodes, edges, ["a"]);
    expect(pos(next, "stolen")).toEqual({ x: 999, y: 888 });
    expect(pos(next, "prev")).toEqual({ x: 50, y: 50 });
    expect(pos(next, "b")).toEqual({ x: 10 + EXEC_STEP + BLOCK, y: 20 });
    expect(pos(next, "get")).toEqual({ x: 10 + EXEC_STEP, y: 20 + LANE });
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
    const next = layout(nodes, edges, ["a"]);
    expect(pos(next, "b")).toEqual({ x: 10 + EXEC_STEP + BLOCK, y: 20 });
    expect(pos(next, "getFirst")).toEqual({ x: 10 + EXEC_STEP, y: 20 + LANE });
    expect(pos(next, "getSecond")).toEqual({
      x: 10 + EXEC_STEP,
      y: 20 + LANE + HANG_Y,
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
    const next = layout(nodes, edges, ["a"]);
    expect(pos(next, "b")).toEqual({ x: 10 + EXEC_STEP + BLOCK, y: 20 });
    expect(pos(next, "c")).toEqual({ x: 10 + EXEC_STEP * 2 + BLOCK, y: 20 });
    expect(pos(next, "get")).toEqual({ x: 10 + EXEC_STEP, y: 20 + LANE });
    expectNoOverlaps(next);
  });

  it("places data inputs of the selected start node below-left of it", () => {
    const nodes = [
      node("b", 200, 50, execWithValueIn),
      node("get", 0, 0, dataOutPins),
    ];
    const edges = [dataEdge("get", "b")];
    const next = layout(nodes, edges, ["b"]);
    expect(pos(next, "b")).toEqual({ x: 200, y: 50 });
    expect(pos(next, "get")).toEqual({
      x: 200 - NODE_W - FORMAT_GAP_X,
      y: 50 + LANE,
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
    const next = layout(nodes, edges, ["event"]);
    expect(pos(next, "event")).toEqual({ x: 10, y: 20 });
    expect(pos(next, "call")).toEqual({ x: 10 + EXEC_STEP, y: 20 });
    expect(pos(next, "print")).toEqual({ x: 10 + EXEC_STEP * 2 + BLOCK, y: 20 });
    expect(pos(next, "toUpper").y).toBeGreaterThanOrEqual(20 + HANG_Y);
    expect(pos(next, "toUpper").x).toBe(10 + EXEC_STEP * 2);
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
    const next = layout(nodes, edges, ["get"]);
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
    const next = layout(nodes, edges, ["get"]);
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
    const next = layout(nodes, edges, ["a", "c"]);
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
    const next = layout(nodes, edges, ["a", "b"]);
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
      const next = layout(nodes, edges, ["branch"]);
      // True keeps the branch's row; a knot lane follows the branch because a child has a block.
      expect(pos(next, "yes")).toEqual({ x: EXEC_STEP + KNOT_LANE + BLOCK, y: 0 });
      expect(pos(next, "get")).toEqual({ x: EXEC_STEP + KNOT_LANE, y: LANE });
      // False's row starts below the data hanging between the branch and True.
      expect(pos(next, "no")).toEqual({ x: EXEC_STEP + KNOT_LANE, y: LANE + NODE_H + ROW_GAP });
      expectNoOverlaps(next);
    });

    it("hangs a lower branch row's data under that row, using the space under earlier columns", () => {
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
      const next = layout(nodes, edges, ["branch"]);
      expect(pos(next, "yes")).toEqual({ x: EXEC_STEP + KNOT_LANE, y: 0 });
      expect(pos(next, "no")).toEqual({ x: EXEC_STEP + KNOT_LANE, y: NODE_H + ROW_GAP });
      expect(pos(next, "get")).toEqual({ x: EXEC_STEP + KNOT_LANE - BLOCK, y: NODE_H + ROW_GAP + LANE });
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
      const next = layout(nodes, edges, ["branch"]);
      expect(pos(next, "yes")).toEqual({ x: EXEC_STEP + KNOT_LANE + BLOCK, y: 0 });
      expect(pos(next, "getYes")).toEqual({ x: EXEC_STEP + KNOT_LANE, y: LANE });
      expect(pos(next, "no")).toEqual({ x: EXEC_STEP + KNOT_LANE, y: LANE + NODE_H + ROW_GAP });
      expect(pos(next, "getNo")).toEqual({ x: EXEC_STEP + KNOT_LANE - BLOCK, y: LANE + NODE_H + ROW_GAP + LANE });
      expectNoOverlaps(next);
    });

    it("keeps the hanging data of stacked branches apart", () => {
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
      const next = layout(nodes, edges, ["branch"]);
      expect(pos(next, "yes")).toEqual({ x: EXEC_STEP + KNOT_LANE + BLOCK, y: 0 });
      expect(pos(next, "no").y).toBe(pos(next, "getYes").y + NODE_H + ROW_GAP);
      expect(pos(next, "getSecond").y).toBe(pos(next, "getFirst").y + HANG_Y);
      expectNoOverlaps(next);
      expect(layout(next, edges, ["branch"])).toEqual(next);
    });

  it("shifts overlapping isolated selected nodes apart", () => {
    const nodes = [node("a", 0, 0), node("b", 10, 10)];
    const next = layout(nodes, [], ["a", "b"]);
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
    const next = layout(nodes, edges, ["branch"]);
    expect(pos(next, "branch")).toEqual({ x: 10, y: 20 });
    for (const edge of edges) {
      expect(pos(next, edge.target).x).toBeGreaterThanOrEqual(
        pos(next, edge.source).x + NODE_W + FORMAT_GAP_X,
      );
    }
    expect(pos(next, "after").y).toBe(pos(next, "merge").y);
    expectNoOverlaps(next);
    expect(layout(next, edges, ["branch"])).toEqual(next);
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
    const next = layout(nodes, edges, ["root"]);
    expect(pos(next, "upperFirstEnd").y).toBe(pos(next, "upperFirst").y);
    expect(pos(next, "upperSecondEnd").y).toBe(pos(next, "upperSecond").y);
    expect(pos(next, "lowerEnd").y).toBe(pos(next, "lower").y);
    expect(pos(next, "lower").y).toBeGreaterThanOrEqual(
      pos(next, "upperSecondEnd").y + NODE_H + FORMAT_GAP_Y,
    );
    expectNoOverlaps(next);
    expect(layout(next, [...edges].reverse(), ["root"])).toEqual(next);
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
    const next = layout(nodes, edges, ["start"]);
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
    expect(layout(next, edges, ["start"])).toEqual(next);
  });

  it("keeps dense branch parameter groups separate, each branch row below the group above it", () => {
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
    const next = layout(nodes, edges, ["root"]);
    expect(pos(next, "consumer0").y).toBe(0);
    for (let index = 0; index < 72; index++) {
      if (index > 0) {
        expect(pos(next, `consumer${index}`).y).toBe(pos(next, `second${index - 1}`).y + NODE_H + ROW_GAP);
      }
      expect(pos(next, `first${index}`).y).toBe(pos(next, `consumer${index}`).y + LANE);
      expect(pos(next, `second${index}`).y - pos(next, `first${index}`).y).toBe(HANG_Y);
    }
    expectNoOverlaps(next);
    expect(layout(next, edges, ["root"])).toEqual(next);
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
    const next = layout(nodes, edges, ["consumer"]);
    expect(pos(next, "shared").x + NODE_W + FORMAT_GAP_X).toBeLessThanOrEqual(
      pos(next, "derived").x,
    );
    expect(pos(next, "derived").x + NODE_W + FORMAT_GAP_X).toBeLessThanOrEqual(
      pos(next, "consumer").x,
    );
    expectNoOverlaps(next);
    expect(layout(next, edges, ["consumer"])).toEqual(next);
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
    const next = layout(nodes, edges, ["pure0"]);
    for (const edge of edges) {
      expect(pos(next, edge.source).x + NODE_W + FORMAT_GAP_X)
        .toBeLessThanOrEqual(pos(next, edge.target).x);
    }
    expect(new Set(next.map((entry) => entry.position.y)).size).toBeLessThanOrEqual(2);
    expectNoOverlaps(next);
    expect(layout(next, edges, ["pure0"])).toEqual(next);
  });

  it("formats a selected execution cycle once instead of discarding all selected roots", () => {
    const nodes = [node("a", 0, 0), node("b", 0, 0), node("c", 0, 0)];
    const edges = [execEdge("a", "b"), execEdge("b", "c"), execEdge("c", "a")];
    const next = layout(nodes, edges, ["b", "a"]);
    expect(pos(next, "a")).toEqual({ x: 0, y: 0 });
    expect(pos(next, "b").x).toBeGreaterThan(pos(next, "a").x);
    expect(pos(next, "c").x).toBeGreaterThan(pos(next, "b").x);
    expectNoOverlaps(next);
    expect(layout(next, edges, ["b", "a"])).toEqual(next);
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
    const next = layout(nodes, edges, ["c", "a"]);
    expect(pos(next, "shared")).toEqual({ x: 10 + EXEC_STEP, y: 20 + LANE });
    expect(pos(next, "c")).toEqual({ x: 10, y: 400 });
    expectNoOverlaps(next);
    expect(layout(next, edges, ["a", "c"])).toEqual(next);
  });

  it("keeps a shortcut merge stable after its longer path becomes aligned", () => {
    const nodes = [node("root", 0, 0), node("z", 0, 10), node("a", 0, 100)];
    const edges = [execEdge("root", "z"), execEdge("root", "a"), execEdge("z", "a")];
    const next = layout(nodes, edges, ["root"]);
    expect(pos(next, "z").y).toBe(pos(next, "a").y);
    expect(layout(next, edges, ["root"])).toEqual(next);
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
    const next = layout(nodes, edges, ["second", "first"]);
    expect(pos(next, "first")).toEqual({ x: 10, y: 20 });
    for (const edge of edges) {
      expect(pos(next, edge.source).x + NODE_W + FORMAT_GAP_X)
        .toBeLessThanOrEqual(pos(next, edge.target).x);
    }
    expectNoOverlaps(next);
    expect(layout(next, edges, ["first", "second"])).toEqual(next);
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
    const next = layout(nodes, edges, ["pure", "consumer"]);
    expect(pos(next, "consumer")).toEqual({ x: 100, y: 100 });
    expect(pos(next, "after")).toEqual({ x: 100 + EXEC_STEP, y: 100 });
    expect(pos(next, "otherConsumer").x).toBeGreaterThan(pos(next, "pure").x);
    expect(pos(next, "otherConsumer")).not.toEqual(pos(nodes, "otherConsumer"));
    expectNoOverlaps(next);
    expect(layout(next, edges, ["consumer", "pure"])).toEqual(next);
  });
});

const wildcard = { kind: "resolvingWildcard" };
const knotPins: SerializedPin[] = [
  { id: "in", name: "In", kind: "data", direction: "in", type: wildcard, anyKind: true },
  { id: "out", name: "Out", kind: "data", direction: "out", type: wildcard, anyKind: true },
];

describe("formatGraphNodes with Reroute knots", () => {
  const bound = (kind: string) => (nodeId: string) => (nodeId === "knot" ? { kind } : undefined);

  it("lays out an exec knot's wire as if it were direct, keeping the knot level with its target", () => {
    const nodes = [node("a", 10, 20), { id: "knot", position: { x: 40, y: 300 }, pins: knotPins, reroute: true }, node("b", 12, 90)];
    const edges = [
      { source: "a", sourceHandle: "execOut", target: "knot", targetHandle: "in" },
      { source: "knot", sourceHandle: "out", target: "b", targetHandle: "execIn" },
    ];
    const next = layout(nodes, edges, ["a"], { displayType: bound("exec") });
    expect(pos(next, "b")).toEqual({ x: 10 + EXEC_STEP, y: 20 });
    // In the gap after a, centred on b's exec pin (estimated 50 + 22 below b's top).
    expect(pos(next, "knot")).toEqual({ x: 10 + NODE_W, y: 20 + 72 - REROUTE_KNOT_SIZE.height / 2 });
  });

  const knotNode = (id: string, x: number, y: number): FormatNode => ({
    id,
    position: { x, y },
    pins: knotPins,
    reroute: true,
  });

  it("keeps a knot on a clear wire, level with the target pin, without changing the layout", () => {
    const nodes = [
      node("a", 10, 20),
      node("b", 12, 90, execWithValueIn),
      knotNode("knot", 5, 200),
      node("get", 1, 300, dataOutPins),
    ];
    const edges = [
      execEdge("a", "b"),
      dataEdge("knot", "b", "value", "out"),
      dataEdge("get", "knot", "in"),
    ];
    const result = formatGraphNodes(nodes, edges, ["a"], {
      displayType: bound("string"),
      insertKnots: true,
    });
    const direct = layout(
      nodes.filter((entry) => entry.id !== "knot"),
      [execEdge("a", "b"), dataEdge("get", "b")],
      ["a"],
    );
    for (const id of ["a", "b", "get"]) {
      expect(pos(result.nodes, id)).toEqual(pos(direct, id));
    }
    expect(pos(result.nodes, "b")).toEqual({ x: 10 + EXEC_STEP + BLOCK, y: 20 });
    expect(pos(result.nodes, "get")).toEqual({ x: 10 + EXEC_STEP, y: 20 + LANE });
    // In the gap after get, centred on b's Value pin (estimated at 50 + 44 + 22 below b's top).
    expect(pos(result.nodes, "knot")).toEqual({
      x: 10 + EXEC_STEP + NODE_W,
      y: 20 + 116 - REROUTE_KNOT_SIZE.height / 2,
    });
    expect(result.knots).toEqual([]);
  });

  it("reads a chain of knots as one wire, keeping and placing every knot", () => {
    const nodes = [
      node("a", 10, 20),
      node("b", 12, 90, execWithValueIn),
      knotNode("first", 5, 200),
      knotNode("second", 300, 400),
      node("get", 1, 300, dataOutPins),
    ];
    const edges = [
      execEdge("a", "b"),
      dataEdge("get", "first", "in"),
      dataEdge("first", "second", "in", "out"),
      dataEdge("second", "b", "value", "out"),
    ];
    const result = formatGraphNodes(nodes, edges, ["a"], { displayType: bound("string"), insertKnots: true });
    const direct = layout(nodes.filter((entry) => !entry.reroute), [execEdge("a", "b"), dataEdge("get", "b")], ["a"]);
    for (const id of ["a", "b", "get"]) expect(pos(result.nodes, id)).toEqual(pos(direct, id));
    expect(result.knots).toEqual([]);
    const first = pos(result.nodes, "first");
    const second = pos(result.nodes, "second");
    expect(first).not.toEqual(second);
    expect(boxesOverlap({ ...first, ...REROUTE_KNOT_SIZE }, { ...second, ...REROUTE_KNOT_SIZE })).toBe(false);
    const again = formatGraphNodes(result.nodes, edges, ["a"], { displayType: bound("string"), insertKnots: true });
    expect(again.nodes).toEqual(result.nodes);
  });

  it("lays out a knot that feeds several inputs like a pure node", () => {
    const nodes = [
      node("a", 10, 20),
      node("b", 12, 90, execWithValueIn),
      node("c", 14, 160, execWithValueIn),
      knotNode("knot", 5, 200),
      node("get", 1, 300, dataOutPins),
    ];
    const edges = [
      execEdge("a", "b"),
      execEdge("b", "c"),
      dataEdge("knot", "b", "value", "out"),
      dataEdge("knot", "c", "value", "out"),
      dataEdge("get", "knot", "in"),
    ];
    const result = formatGraphNodes(nodes, edges, ["a"], {
      displayType: bound("string"),
      insertKnots: true,
    });
    const knotStep = REROUTE_KNOT_SIZE.width + FORMAT_GAP_X;
    expect(pos(result.nodes, "b")).toEqual({ x: 10 + EXEC_STEP + BLOCK + knotStep, y: 20 });
    expect(pos(result.nodes, "knot")).toEqual({ x: 10 + EXEC_STEP + BLOCK, y: 20 + LANE });
    expect(pos(result.nodes, "get")).toEqual({ x: 10 + EXEC_STEP, y: 20 + LANE });
    expect(result.knots).toEqual([]);
  });

  it("leaves a wire direct when no knot gets it around the node in its way", () => {
    const nodes = [
      node("a", 10, 20),
      node("b", 12, 90, execWithValueIn),
      node("c", 14, 160, execWithValueIn),
      node("get", 1, 300, dataOutPins),
      // An unrelated selected wall across every route from get to c: it stays where it is.
      node("wall", 370, -2000, [], { width: 40, height: 4000 }),
    ];
    const edges = [
      execEdge("a", "b"),
      execEdge("b", "c"),
      dataEdge("get", "b"),
      dataEdge("get", "c"),
    ];
    const result = formatGraphNodes(nodes, edges, ["a", "wall"], { insertKnots: true });
    expect(pos(result.nodes, "wall")).toEqual({ x: 370, y: -2000 });
    expect(pos(result.nodes, "get")).toEqual({ x: 10 + EXEC_STEP, y: 20 + LANE });
    expect(pos(result.nodes, "c")).toEqual({ x: 10 + EXEC_STEP * 2 + BLOCK, y: 20 });
    expect(result.knots).toEqual([]);
  });

  describe("a wire that passes close to a node", () => {
    // a → b → c. get (in b's block) feeds b.Value and c.Value, which is 400 below c's top, so
    // get's wire into c, leaving under b, drops from (330, 156) to (670, 420). An isolated node o
    // sits just right of b, above that curve: with its bottom at 340 the curve passes about 20
    // units from its box, at 305 about 40.
    function crowdedGraph(obstacleBottom: number): { nodes: FormatNode[]; edges: FormatEdge[]; cWire: FormatEdge } {
      const cWire = { id: "get-c", ...dataEdge("get", "c") };
      return {
        nodes: [
          node("a", 10, 20, [execPins[1]!]),
          { ...node("b", 0, 0, execWithValueIn, { width: 100, height: 92 }), pinOffsets: { [formatPinOffsetKey("in", "value")]: 30 } },
          { ...node("c", 0, 0, execWithValueIn, { width: 100, height: 450 }), pinOffsets: { [formatPinOffsetKey("in", "value")]: 400 } },
          { ...node("get", 0, 0, dataOutPins), pinOffsets: { [formatPinOffsetKey("out", "value")]: 20 } },
          node("o", 560, obstacleBottom - 40, [], { width: 60, height: 40 }),
        ],
        edges: [execEdge("a", "b"), execEdge("b", "c"), dataEdge("get", "b"), cWire],
        cWire,
      };
    }
    // How close get's wire into c (through any knots) comes to o.
    const distanceToO = (nodes: FormatNode[], edges: FormatEdge[]) => {
      const toC = edges.filter((edge) => edge.targetHandle !== "execIn" && (edge.target === "c" || edge.target.startsWith("knot")));
      return Math.min(...wireClearances(nodes, toC).filter((entry) => entry.node === "o").map((entry) => entry.distance));
    };

    it("takes a knot around the node when it passes 20 units from it", () => {
      const { nodes, edges, cWire } = crowdedGraph(340);
      const result = formatGraphNodes(nodes, edges, ["a", "o"], { insertKnots: true });
      expect(pos(result.nodes, "o")).toEqual({ x: 560, y: 300 });
      expect(pos(result.nodes, "get")).toEqual({ x: 230, y: 136 });
      expect(pos(result.nodes, "c")).toEqual({ x: 670, y: 20 });
      expect(result.knots.map((knot) => [knot.edge, knot.positions.length])).toEqual([[cWire, 1]]);
      const knotted = withKnots(result, edges);
      expect(distanceToO(knotted.nodes, knotted.edges)).toBeGreaterThanOrEqual(32);
    });

    it("stays direct when it passes 40 units from the node", () => {
      const { nodes, edges } = crowdedGraph(305);
      const result = formatGraphNodes(nodes, edges, ["a", "o"], { insertKnots: true });
      expect(pos(result.nodes, "get")).toEqual({ x: 230, y: 136 });
      expect(result.knots).toEqual([]);
      expect(distanceToO(result.nodes, edges)).toBeGreaterThanOrEqual(32);
    });

    it("changes nothing when formatted again with its knot in place", () => {
      const { nodes, edges } = crowdedGraph(340);
      const first = formatGraphNodes(nodes, edges, ["a", "o"], { insertKnots: true });
      expect(first.knots).toHaveLength(1);
      const knotted = withKnots(first, edges);
      const second = formatGraphNodes(knotted.nodes, knotted.edges, ["a", "o"], { insertKnots: true });
      expect(second.knots).toEqual([]);
      expect(second.nodes).toEqual(knotted.nodes);
    });
  });
});

describe("formatGraphNodes parameter rows", () => {
  // Measured cards: handle centres 20 below the top of a 40px getter.
  const getter = (id: string): FormatNode => ({
    ...node(id, 0, 0, dataOutPins),
    pinOffsets: { [formatPinOffsetKey("out", "value")]: 20 },
  });
  const consumer: FormatNode = {
    ...node("b", 0, 0, [
      ...twoDataInPins,
      { id: "third", name: "third", kind: "data", direction: "in", type: { kind: "float" } },
    ], { width: 100, height: 340 }),
    pinOffsets: {
      [formatPinOffsetKey("in", "execIn")]: 10,
      [formatPinOffsetKey("in", "first")]: 30,
      [formatPinOffsetKey("in", "second")]: 150,
      [formatPinOffsetKey("in", "third")]: 300,
    },
  };

  it("keeps a block below its owner's first data lane, and level below it", () => {
    const nodes = [node("a", 0, 0), consumer, getter("getFirst"), getter("getThird")];
    const edges = [
      execEdge("a", "b"),
      dataEdge("getFirst", "b", "first"),
      dataEdge("getThird", "b", "third"),
    ];
    const next = layout(nodes, edges, ["a"]);
    // The first lane's row ends 22 below its handle at 30; the block starts 40 below that.
    expect(pos(next, "getFirst").y).toBe(30 + 22 + FORMAT_GAP_Y);
    expect(pos(next, "getThird").y + 20).toBe(300);
    expectNoOverlaps(next);
  });

  it("pushes a member down when its level spot is taken", () => {
    const nodes = [node("a", 0, 0), consumer, getter("getFirst"), getter("getSecond")];
    const edges = [
      execEdge("a", "b"),
      dataEdge("getFirst", "b", "first"),
      dataEdge("getSecond", "b", "second"),
    ];
    const next = layout(nodes, edges, ["a"]);
    expect(pos(next, "getFirst").y).toBe(116);
    // Level would be 130, which is within FORMAT_GAP_Y of getFirst (92 to 132).
    expect(pos(next, "getSecond").y).toBe(116 + NODE_H + FORMAT_GAP_Y);
    expect(pos(next, "getSecond").x).toBe(pos(next, "getFirst").x);
    expectNoOverlaps(next);
  });
});

describe("formatGraphNodes on a Line Trace graph", () => {
  const exec = (id: string, direction: "in" | "out"): SerializedPin => ({
    id, name: id, kind: "exec", direction, type: { kind: "exec" },
  });
  const data = (id: string, direction: "in" | "out"): SerializedPin => ({
    id, name: id, kind: "data", direction, type: { kind: "vector3" },
  });
  // A measured card: 50px title, 44px pin rows, handle centres 72 + 44 × row below its top.
  function card(
    id: string,
    x: number,
    y: number,
    width: number,
    rows: { in?: SerializedPin; out?: SerializedPin }[],
  ): FormatNode {
    const pins: SerializedPin[] = [];
    const pinOffsets: Record<string, number> = {};
    rows.forEach((row, index) => {
      for (const entry of [row.in, row.out]) {
        if (!entry) continue;
        pins.push(entry);
        pinOffsets[formatPinOffsetKey(entry.direction, entry.id)] = 72 + 44 * index;
      }
    });
    return { id, position: { x, y }, width, height: 50 + 44 * rows.length, pins, pinOffsets };
  }
  const nodes: FormatNode[] = [
    card("event", 0, 0, 200, [{ out: exec("then", "out") }]),
    card("trace", 900, 300, 260, [
      { in: exec("exec", "in"), out: exec("then", "out") },
      { in: data("start", "in"), out: data("hit", "out") },
      { in: data("end", "in") },
      { in: data("ignore", "in") },
    ]),
    card("branch", 40, 900, 200, [
      { in: exec("exec", "in"), out: exec("true", "out") },
      { in: data("condition", "in"), out: exec("false", "out") },
    ]),
    card("setLocation", 700, 700, 260, [
      { in: exec("exec", "in"), out: exec("then", "out") },
      { in: data("target", "in") },
      { in: data("location", "in") },
    ]),
    card("self", 300, 600, 160, [{ out: data("self", "out") }]),
    card("location", 50, 500, 280, [{ in: data("target", "in"), out: data("location", "out") }]),
    card("add", 600, 40, 200, [
      { in: data("a", "in"), out: data("out", "out") },
      { in: data("b", "in") },
    ]),
    card("multiply", 120, 260, 200, [
      { in: data("a", "in"), out: data("out", "out") },
      { in: data("b", "in") },
    ]),
    card("forward", 1000, 1000, 280, [{ in: data("target", "in"), out: data("forward", "out") }]),
    card("array", 30, 1200, 200, [{ out: data("array", "out") }]),
    card("breakHit", 1500, 50, 220, [
      { in: data("in", "in"), out: data("hit", "out") },
      { out: data("location", "out") },
      { out: data("normal", "out") },
      { out: data("actor", "out") },
    ]),
    card("add2", 400, 400, 200, [
      { in: data("a", "in"), out: data("out", "out") },
      { in: data("b", "in") },
    ]),
    card("location2", 800, 1300, 280, [{ in: data("target", "in"), out: data("location", "out") }]),
  ];
  const wire = (source: string, sourceHandle: string, target: string, targetHandle: string): FormatEdge => ({
    id: `${source}.${sourceHandle}->${target}.${targetHandle}`,
    source,
    sourceHandle,
    target,
    targetHandle,
  });
  const startWire = wire("location", "location", "trace", "start");
  const targetWire = wire("breakHit", "actor", "setLocation", "target");
  const edges: FormatEdge[] = [
    wire("event", "then", "trace", "exec"),
    wire("trace", "then", "branch", "exec"),
    wire("branch", "true", "setLocation", "exec"),
    startWire,
    wire("self", "self", "location", "target"),
    wire("add", "out", "trace", "end"),
    wire("location", "location", "add", "a"),
    wire("multiply", "out", "add", "b"),
    wire("forward", "forward", "multiply", "a"),
    wire("self", "self", "forward", "target"),
    wire("array", "array", "trace", "ignore"),
    wire("trace", "hit", "breakHit", "in"),
    wire("breakHit", "hit", "branch", "condition"),
    targetWire,
    wire("add2", "out", "setLocation", "location"),
    wire("breakHit", "location", "add2", "a"),
    wire("location2", "location", "add2", "b"),
    wire("breakHit", "actor", "location2", "target"),
  ];
  const byId = (list: readonly FormatNode[], id: string) => list.find((entry) => entry.id === id)!;
  const pinAt = (list: readonly FormatNode[], id: string, direction: "in" | "out", pinId: string) => {
    const entry = byId(list, id);
    return entry.position.y + entry.pinOffsets![formatPinOffsetKey(direction, pinId)]!;
  };

  it("shares pure rows by column and keeps listed wires level", () => {
    const { nodes: next } = formatGraphNodes(nodes, edges, ["event"], { insertKnots: true });
    // The block starts just under the exec lane: the Start row ends at 116 + 22, plus the gap.
    expect(pos(next, "self").y).toBe(202);
    expect(pos(next, "location").y).toBe(202);
    expect(pos(next, "add").y).toBe(202);
    expect(pos(next, "multiply").y).toBe(pos(next, "forward").y);
    expect(pos(next, "multiply").y).toBeGreaterThan(202);
    expect(pos(next, "array").x).toBe(pos(next, "add").x);
    expect(pos(next, "array").y).toBe(pos(next, "add").y + byId(next, "add").height! + FORMAT_GAP_Y);
    expect(pinAt(next, "self", "out", "self")).toBe(pinAt(next, "location", "in", "target"));
    expect(pinAt(next, "location", "out", "location")).toBe(pinAt(next, "add", "in", "a"));
    expect(pinAt(next, "forward", "out", "forward")).toBe(pinAt(next, "multiply", "in", "a"));
    expect(pinAt(next, "breakHit", "out", "location")).toBe(pinAt(next, "add2", "in", "a"));
    expect(pinAt(next, "breakHit", "out", "actor")).toBe(pinAt(next, "location2", "in", "target"));
    for (const id of ["trace", "branch", "setLocation"]) expect(pos(next, id).y).toBe(0);
    expectNoOverlaps(next);
  });

  it("routes Start and Target around the block on level runs, clear of the exec wire", () => {
    const result = formatGraphNodes(nodes, edges, ["event"], { insertKnots: true });
    expect(new Set(result.knots.map((knot) => knot.edge))).toEqual(new Set([startWire, targetWire]));
    const knotted = withKnots(result, edges);
    expectWiresClear(knotted.nodes, knotted.edges);
    expectWiresLevelWithShortTransitions(knotted.nodes, knotted.edges, ["event.then", "trace.then", "branch.true"]);
    // Every knot keeps the wire spacing from the exec row's wire (its handles 72 below the row).
    for (const knot of result.knots.flatMap((entry) => entry.positions)) {
      expect(knot.y).toBeGreaterThanOrEqual(72 + 40);
    }
    expect(wireCrossings(knotted.nodes, knotted.edges)).toBe(1);
    const plain = formatGraphNodes(nodes, edges, ["event"], { insertKnots: false });
    expect(plain.knots).toEqual([]);
    expect(plain.nodes).toEqual(result.nodes);
  });

  it("runs no wire through a node it does not connect once its knots are in place", () => {
    const knotted = withKnots(formatGraphNodes(nodes, edges, ["event"], { insertKnots: true }), edges);
    expectWiresClear(knotted.nodes, knotted.edges);
    expectNoBoxOverlaps(knotted.nodes);
  });

  it("changes nothing when formatted again with its knots, single and chained, in place", () => {
    const first = formatGraphNodes(nodes, edges, ["event"], { insertKnots: true });
    expect(first.knots.some((knot) => knot.positions.length === 2)).toBe(true);
    const knotted = withKnots(first, edges);
    const second = formatGraphNodes(knotted.nodes, knotted.edges, ["event"], { insertKnots: true });
    expect(second.knots).toEqual([]);
    expect(second.nodes).toEqual(knotted.nodes);
  });
});

// ---- Whole-graph checks, written independently of the layout code ----

/** Every knot chain Format asked for, added as nodes with the wires that replace its wire. */
function withKnots(result: FormatResult, edges: readonly FormatEdge[]): { nodes: FormatNode[]; edges: FormatEdge[] } {
  const nodes = [...result.nodes];
  let wires = [...edges];
  let count = 0;
  for (const knot of result.knots) {
    wires = wires.filter((edge) => edge !== knot.edge);
    let from = { node: knot.edge.source, pin: knot.edge.sourceHandle };
    for (const position of knot.positions) {
      const id = `knot${count++}`;
      nodes.push({ id, position, pins: knotPins, reroute: true });
      wires.push({ id: `${from.node}>${id}`, source: from.node, sourceHandle: from.pin, target: id, targetHandle: "in" });
      from = { node: id, pin: "out" };
    }
    wires.push({ id: `${from.node}>${knot.edge.target}`, source: from.node, sourceHandle: from.pin, target: knot.edge.target, targetHandle: knot.edge.targetHandle });
  }
  return { nodes, edges: wires };
}

function sizeOf(entry: FormatNode): { width: number; height: number } {
  return entry.reroute && entry.width === undefined ? REROUTE_KNOT_SIZE : { width: entry.width!, height: entry.height! };
}

function handleY(entry: FormatNode, direction: "in" | "out", pinId: string | undefined): number {
  if (entry.reroute) return entry.position.y + sizeOf(entry).height / 2;
  return entry.position.y + entry.pinOffsets![formatPinOffsetKey(direction, pinId!)]!;
}

/**
 * The nearest any wire comes to a node it does not connect: the wire as the editor draws it
 * (a bezier leaving right and entering left, control points half the horizontal distance out, or
 * 25 × 0.25 × √distance when it runs backwards), sampled at 200 points.
 */
function wireClearances(nodes: readonly FormatNode[], edges: readonly FormatEdge[]): { wire: string; node: string; distance: number }[] {
  const byId = new Map(nodes.map((entry) => [entry.id, entry]));
  const found: { wire: string; node: string; distance: number }[] = [];
  for (const edge of edges) {
    const source = byId.get(edge.source)!;
    const target = byId.get(edge.target)!;
    const from = { x: source.position.x + sizeOf(source).width, y: handleY(source, "out", edge.sourceHandle) };
    const to = { x: target.position.x, y: handleY(target, "in", edge.targetHandle) };
    const dx = to.x - from.x;
    const pull = dx >= 0 ? dx / 2 : 6.25 * Math.sqrt(-dx);
    let nearest = { node: "", distance: Infinity };
    for (let step = 1; step < 200; step++) {
      const t = step / 200;
      const u = 1 - t;
      const x = u ** 3 * from.x + 3 * u * u * t * (from.x + pull) + 3 * u * t * t * (to.x - pull) + t ** 3 * to.x;
      const y = from.y + (to.y - from.y) * (3 * u * t * t + t ** 3);
      for (const other of nodes) {
        if (other.id === edge.source || other.id === edge.target) continue;
        const size = sizeOf(other);
        const gapX = Math.max(other.position.x - x, 0, x - other.position.x - size.width);
        const gapY = Math.max(other.position.y - y, 0, y - other.position.y - size.height);
        const distance = Math.hypot(gapX, gapY);
        if (distance < nearest.distance) nearest = { node: other.id, distance };
      }
    }
    found.push({ wire: `${edge.source}.${edge.sourceHandle} → ${edge.target}.${edge.targetHandle}`, ...nearest });
  }
  return found;
}

/** No wire runs through, or within the 8-unit clearance of, a node it does not connect. */
function expectWiresClear(nodes: readonly FormatNode[], edges: readonly FormatEdge[]): void {
  const close = wireClearances(nodes, edges).filter((entry) => entry.distance < 8);
  expect(close).toEqual([]);
}

function expectNoBoxOverlaps(nodes: readonly FormatNode[]): void {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = { ...nodes[i]!.position, ...sizeOf(nodes[i]!) };
      const b = { ...nodes[j]!.position, ...sizeOf(nodes[j]!) };
      expect(boxesOverlap(a, b), `${nodes[i]!.id} overlaps ${nodes[j]!.id}`).toBe(false);
    }
  }
}

// Cards as the editor measures them: a 52px title and padding, 44px pin rows with handle centres
// 69 + 44 × row below the top, 320 wide; Print String carries a 20px Development Only footer.
type Row = [string | null, string | null];
function editorCard(id: string, x: number, y: number, rows: Row[], options: { exec?: string[]; width?: number; footer?: number } = {}): FormatNode {
  const pins: SerializedPin[] = [];
  const pinOffsets: Record<string, number> = {};
  rows.forEach(([input, output], index) => {
    for (const [pinId, direction] of [[input, "in"], [output, "out"]] as const) {
      if (pinId === null) continue;
      const kind = options.exec?.includes(pinId) ? "exec" : "data";
      pins.push({ id: pinId, name: pinId, kind, direction, type: { kind: kind === "exec" ? "exec" : "float" } });
      pinOffsets[formatPinOffsetKey(direction, pinId)] = 69 + 44 * index;
    }
  });
  return { id, position: { x, y }, width: options.width ?? 320, height: 52 + 44 * rows.length + (options.footer ?? 0), pins, pinOffsets };
}

function customEvent(id: string): FormatNode {
  return {
    id,
    position: { x: 0, y: 0 },
    width: 328,
    height: 102,
    pins: [
      { id: "OutputDelegate", name: "Output Delegate", kind: "data", direction: "out", type: { kind: "delegate" }, placement: "header" },
      { id: "execOut", name: "then", kind: "exec", direction: "out", type: { kind: "exec" } },
    ],
    pinOffsets: { [formatPinOffsetKey("out", "OutputDelegate")]: 25, [formatPinOffsetKey("out", "execOut")]: 75 },
  };
}

const printString = (id: string, x: number, y: number) =>
  editorCard(id, x, y, [["execIn", "execOut"], ["inString", null], ["key", null], ["duration", null], ["color", null]], { exec: ["execIn", "execOut"], footer: 20 });
const getter = (id: string, x: number, y: number, input: string | null, output = "out") => editorCard(id, x, y, [[input, output]]);
const binary = (id: string, x: number, y: number) => editorCard(id, x, y, [["a", "out"], ["b", null]]);
const setter = (id: string, x: number, y: number, pin: string) =>
  editorCard(id, x, y, [["execIn", "execOut"], ["target", null], [pin, null]], { exec: ["execIn", "execOut"] });

function link(source: string, sourceHandle: string, target: string, targetHandle: string): FormatEdge {
  return { id: `${source}.${sourceHandle}>${target}.${targetHandle}`, source, sourceHandle, target, targetHandle };
}

function expectExecKnotsInLane(nodes: readonly FormatNode[], result: FormatResult): void {
  const byId = new Map(nodes.map((entry) => [entry.id, entry]));
  for (const knot of result.knots) {
    const source = byId.get(knot.edge.source)!;
    const pin = source.pins!.find((entry) => entry.id === knot.edge.sourceHandle)!;
    if (pin.kind !== "exec") continue;
    const target = byId.get(knot.edge.target)!;
    // One knot per drop, level with the child's exec pin, in its own lane beside the parent:
    // a gap, then lanes a knot and the 40-unit wire spacing apart.
    expect(knot.positions).toHaveLength(1);
    const [first] = knot.positions;
    expect(first!.y + REROUTE_KNOT_SIZE.height / 2).toBe(handleY(target, "in", knot.edge.targetHandle));
    const lane = (first!.x - source.position.x - source.width! - FORMAT_GAP_X) / (REROUTE_KNOT_SIZE.width + 40);
    expect(Number.isInteger(lane) && lane >= 0).toBe(true);
  }
}

/** The wires as the editor draws them, sampled at 200 points each. */
function sampledWires(nodes: readonly FormatNode[], edges: readonly FormatEdge[]): { edge: FormatEdge; from: { x: number; y: number }; to: { x: number; y: number }; points: { x: number; y: number }[] }[] {
  const byId = new Map(nodes.map((entry) => [entry.id, entry]));
  return edges.map((edge) => {
    const source = byId.get(edge.source)!;
    const target = byId.get(edge.target)!;
    const from = { x: source.position.x + sizeOf(source).width, y: handleY(source, "out", edge.sourceHandle) };
    const to = { x: target.position.x, y: handleY(target, "in", edge.targetHandle) };
    const dx = to.x - from.x;
    const pull = dx >= 0 ? dx / 2 : 6.25 * Math.sqrt(-dx);
    const points = [];
    for (let step = 0; step <= 200; step++) {
      const t = step / 200;
      const u = 1 - t;
      points.push({
        x: u ** 3 * from.x + 3 * u * u * t * (from.x + pull) + 3 * u * t * t * (to.x - pull) + t ** 3 * to.x,
        y: from.y + (to.y - from.y) * (3 * u * t * t + t ** 3),
      });
    }
    return { edge, from, to, points };
  });
}

/**
 * Wires are level runs joined by short transitions: a piece between knots, or between a node and a
 * knot, changes height over at most 480 across (240, plus two knot lanes beside a node with
 * several drops); a direct wire that changes height spans at most two columns (880) and, past the
 * next column (240), is no steeper than 45 degrees.
 */
function expectWiresLevelWithShortTransitions(nodes: readonly FormatNode[], edges: readonly FormatEdge[]): void {
  const knots = new Set(nodes.filter((entry) => entry.reroute).map((entry) => entry.id));
  for (const { edge, from, to } of sampledWires(nodes, edges)) {
    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);
    if (dy <= 8) continue;
    const label = `${edge.source}.${edge.sourceHandle} → ${edge.target}.${edge.targetHandle}`;
    if (knots.has(edge.source) || knots.has(edge.target)) {
      expect(dx, label).toBeLessThanOrEqual(480);
    } else {
      expect(dx, label).toBeLessThanOrEqual(880);
      if (dx > 240) expect(dy, label).toBeLessThanOrEqual(dx);
    }
  }
}

/** Crossings between wires that share no pin and do not continue one another through a knot. */
function wireCrossings(nodes: readonly FormatNode[], edges: readonly FormatEdge[]): number {
  const wires = sampledWires(nodes, edges);
  const side = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  let count = 0;
  for (let i = 0; i < wires.length; i++) {
    for (let j = i + 1; j < wires.length; j++) {
      const a = wires[i]!;
      const b = wires[j]!;
      if (a.edge.source === b.edge.source && a.edge.sourceHandle === b.edge.sourceHandle) continue;
      if (a.edge.target === b.edge.target && a.edge.targetHandle === b.edge.targetHandle) continue;
      if (a.edge.target === b.edge.source || b.edge.target === a.edge.source) continue;
      for (let m = 1; m < a.points.length; m++) {
        for (let n = 1; n < b.points.length; n++) {
          const [p, q, r, t] = [a.points[m - 1]!, a.points[m]!, b.points[n - 1]!, b.points[n]!];
          const d1 = side(r, t, p);
          const d2 = side(r, t, q);
          const d3 = side(p, q, r);
          const d4 = side(p, q, t);
          if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) count++;
        }
      }
    }
  }
  return count;
}

/** The closest two level runs of different wires come where they run side by side. */
function closestParallelRuns(nodes: readonly FormatNode[], edges: readonly FormatEdge[]): number {
  const level = sampledWires(nodes, edges).filter(({ from, to }) => Math.abs(to.y - from.y) <= 8);
  let closest = Infinity;
  for (let i = 0; i < level.length; i++) {
    for (let j = i + 1; j < level.length; j++) {
      const a = level[i]!;
      const b = level[j]!;
      if (a.edge.source === b.edge.source && a.edge.sourceHandle === b.edge.sourceHandle) continue;
      if (a.edge.target === b.edge.target && a.edge.targetHandle === b.edge.targetHandle) continue;
      const overlap = Math.min(a.to.x, b.to.x) - Math.max(a.from.x, b.from.x);
      if (overlap > 0) closest = Math.min(closest, Math.abs(a.from.y - b.from.y));
    }
  }
  return closest;
}

describe("formatGraphNodes on a branching graph", () => {
  // Custom Event → Branch. Condition ← Greater Than ← Length Vector3 ← Get Actor Location. True →
  // Print String (In String ← To String ← the same Length) → Set Actor Rotation (← Get Actor
  // Rotation). False → Set Actor Location (Location ← Add; A ← the same Get Actor Location;
  // B ← Multiply ← Get Actor Forward Vector, Get Delta Seconds).
  const nodes: FormatNode[] = [
    customEvent("event"),
    editorCard("branch", 400, 300, [["execIn", "true"], ["condition", "false"]], { exec: ["execIn", "true", "false"] }),
    binary("greater", 50, 600),
    getter("length", 900, 40, "v"),
    getter("location", 700, 700, "target"),
    printString("print", 1200, 100),
    getter("toString", 300, 900, "in"),
    setter("setRotation", 1500, 500, "rotation"),
    getter("rotation", 1700, 900, "target"),
    setter("setLocation", 1000, 1100, "location"),
    binary("add", 100, 1200),
    binary("multiply", 600, 1300),
    getter("forward", 1300, 1400, "target"),
    getter("delta", 1800, 1500, null, "deltaSeconds"),
  ];
  const edges: FormatEdge[] = [
    link("event", "execOut", "branch", "execIn"),
    link("greater", "out", "branch", "condition"),
    link("length", "out", "greater", "a"),
    link("location", "out", "length", "v"),
    link("branch", "true", "print", "execIn"),
    link("toString", "out", "print", "inString"),
    link("length", "out", "toString", "in"),
    link("print", "execOut", "setRotation", "execIn"),
    link("rotation", "out", "setRotation", "rotation"),
    link("branch", "false", "setLocation", "execIn"),
    link("add", "out", "setLocation", "location"),
    link("location", "out", "add", "a"),
    link("multiply", "out", "add", "b"),
    link("forward", "out", "multiply", "a"),
    link("delta", "deltaSeconds", "multiply", "b"),
  ];
  const result = formatGraphNodes(nodes, edges, ["event"], { insertKnots: true });
  const knotted = withKnots(result, edges);

  it("runs no wire through a node it does not connect, and overlaps nothing", () => {
    expectWiresClear(knotted.nodes, knotted.edges);
    expectNoBoxOverlaps(knotted.nodes);
    expectExecKnotsInLane(result.nodes, result);
  });

  it("lays wires level with short transitions, apart, crossing only where the branch must", () => {
    expectWiresLevelWithShortTransitions(knotted.nodes, knotted.edges);
    expect(closestParallelRuns(knotted.nodes, knotted.edges)).toBeGreaterThanOrEqual(40);
    // False drops from Branch to its row below while Length's wire runs under Branch to To String,
    // right of Branch: the two cannot both stay on their sides.
    expect(wireCrossings(knotted.nodes, knotted.edges)).toBe(1);
    // Get Actor Location's long wire to Add runs level, then drops beside Add through a knot.
    expect(result.knots.find((knot) => knot.edge.target === "add")?.positions).toHaveLength(1);
  });

  it("takes Length's wire to To String under Greater Than instead of level through it", () => {
    const next = result.nodes;
    expect(handleY(byIdOf(next, "length"), "out", "out")).toBe(handleY(byIdOf(next, "toString"), "in", "in"));
    const greater = byIdOf(next, "greater");
    expect(handleY(byIdOf(next, "length"), "out", "out")).toBeGreaterThanOrEqual(greater.position.y + greater.height! + 32);
  });

  it("lets the False row's block use the space under Branch instead of widening the True row", () => {
    const next = result.nodes;
    const branch = byIdOf(next, "branch");
    // Branch → Print String: a gap, a knot lane, and To String's column only.
    expect(pos(next, "print").x).toBe(branch.position.x + 320 + FORMAT_GAP_X + KNOT_LANE + 320 + FORMAT_GAP_X);
    expect(pos(next, "add").x).toBeLessThan(pos(next, "print").x);
    expect(pos(next, "setLocation").y).toBeGreaterThan(pos(next, "print").y);
  });

  it("changes nothing when formatted again with its knots in place", () => {
    const again = formatGraphNodes(knotted.nodes, knotted.edges, ["event"], { insertKnots: true });
    expect(again.knots).toEqual([]);
    expect(again.nodes).toEqual(knotted.nodes);
  });
});

describe("formatGraphNodes on a Sequence graph", () => {
  // Custom Event → Sequence. Then 0 → Print String (In String ← To String ← Add ← Get Array
  // Length ← Make Array ← three Make Int). Then 1 → For Each (Array ← the same Make Array; Loop
  // Body → Print String ← To String ← Index). Then 2 → Set Actor Location (Location ← Divide ←
  // Get Actor Location, Make Float).
  const nodes: FormatNode[] = [
    customEvent("event"),
    editorCard("sequence", 400, 300, [["execIn", "then0"], [null, "then1"], [null, "then2"]], { exec: ["execIn", "then0", "then1", "then2"] }),
    printString("print", 900, 50),
    getter("toString", 100, 800, "in"),
    binary("add", 500, 900),
    getter("length", 800, 600, "array"),
    editorCard("array", 300, 300, [["item0", "out"], ["item1", null], ["item2", null]]),
    getter("int0", 50, 50, "in"),
    getter("int1", 60, 450, "in"),
    getter("int2", 70, 650, "in"),
    editorCard("forEach", 1300, 400, [["execIn", "loopBody"], ["array", "completed"], [null, "element"], [null, "index"]], {
      exec: ["execIn", "loopBody", "completed"],
    }),
    printString("printIndex", 1700, 300),
    getter("indexString", 1600, 900, "in"),
    setter("setLocation", 1200, 1200, "location"),
    binary("divide", 900, 1300),
    getter("location", 400, 1400, "target"),
    getter("float", 300, 1500, "in"),
  ];
  const edges: FormatEdge[] = [
    link("event", "execOut", "sequence", "execIn"),
    link("sequence", "then0", "print", "execIn"),
    link("int0", "out", "array", "item0"),
    link("int1", "out", "array", "item1"),
    link("int2", "out", "array", "item2"),
    link("array", "out", "length", "array"),
    link("length", "out", "add", "a"),
    link("add", "out", "toString", "in"),
    link("toString", "out", "print", "inString"),
    link("sequence", "then1", "forEach", "execIn"),
    link("array", "out", "forEach", "array"),
    link("forEach", "loopBody", "printIndex", "execIn"),
    link("forEach", "index", "indexString", "in"),
    link("indexString", "out", "printIndex", "inString"),
    link("sequence", "then2", "setLocation", "execIn"),
    link("location", "out", "divide", "a"),
    link("float", "out", "divide", "b"),
    link("divide", "out", "setLocation", "location"),
  ];
  const result = formatGraphNodes(nodes, edges, ["event"], { insertKnots: true });
  const knotted = withKnots(result, edges);

  it("runs no wire through a node it does not connect, and overlaps nothing", () => {
    expectWiresClear(knotted.nodes, knotted.edges);
    expectNoBoxOverlaps(knotted.nodes);
  });

  it("drops each lower Then into a knot beside the Sequence and runs it level below the Then 0 block", () => {
    expectExecKnotsInLane(result.nodes, result);
    const lower = result.knots.filter((knot) => knot.edge.source === "sequence").map((knot) => knot.edge.sourceHandle);
    expect(lower).toEqual(expect.arrayContaining(["then1", "then2"]));
    const blockBottom = Math.max(...["array", "int0", "int1", "int2", "length", "add", "toString"].map((id) => {
      const entry = byIdOf(result.nodes, id);
      return entry.position.y + entry.height!;
    }));
    expect(pos(result.nodes, "forEach").y).toBeGreaterThanOrEqual(blockBottom + FORMAT_GAP_Y);
    expect(pos(result.nodes, "setLocation").y).toBeGreaterThan(pos(result.nodes, "forEach").y);
  });

  it("gives each lower Then its own lane, nearest the Sequence for the lowest row", () => {
    const then1 = result.knots.find((knot) => knot.edge.sourceHandle === "then1")!.positions[0]!;
    const then2 = result.knots.find((knot) => knot.edge.sourceHandle === "then2")!.positions[0]!;
    expect(then1.x - then2.x).toBe(REROUTE_KNOT_SIZE.width + 40);
    expectWiresLevelWithShortTransitions(knotted.nodes, knotted.edges);
    expect(closestParallelRuns(knotted.nodes, knotted.edges)).toBeGreaterThanOrEqual(40);
    // Make Array (in the Then 0 block, above) feeds For Each's Array, below the level run into
    // For Each's Exec: that wire has to cross the run.
    expect(wireCrossings(knotted.nodes, knotted.edges)).toBe(1);
  });

  it("brings the lower rows left of Then 0's block instead of past it", () => {
    expect(pos(result.nodes, "forEach").x).toBeLessThan(pos(result.nodes, "print").x);
    expect(pos(result.nodes, "setLocation").x).toBeLessThan(pos(result.nodes, "forEach").x);
    // For Each still sits right of the Make Array it reads.
    expect(pos(result.nodes, "forEach").x).toBeGreaterThanOrEqual(pos(result.nodes, "array").x + 320 + FORMAT_GAP_X);
  });

  it("changes nothing when formatted again with its knots in place", () => {
    const again = formatGraphNodes(knotted.nodes, knotted.edges, ["event"], { insertKnots: true });
    expect(again.knots).toEqual([]);
    expect(again.nodes).toEqual(knotted.nodes);
  });
});

function byIdOf(list: readonly FormatNode[], id: string): FormatNode {
  return list.find((entry) => entry.id === id)!;
}

describe("formatGraphNodes on a loop with branches sharing inputs", () => {
  // Custom Event → For Each (Array ← Make Array ← two Make Int). Loop Body → Branch (Condition ←
  // Greater Than ← Element). True and False print one To String (← Add ← Element, Index);
  // Completed prints the array's length (← the same Make Array).
  const nodes: FormatNode[] = [
    customEvent("event"),
    editorCard("forEach", 500, 400, [["execIn", "loopBody"], ["array", "completed"], [null, "element"], [null, "index"]], {
      exec: ["execIn", "loopBody", "completed"],
    }),
    editorCard("array", 300, 300, [["item0", "out"], ["item1", null]]),
    getter("int0", 50, 50, "in"),
    getter("int1", 60, 450, "in"),
    editorCard("branch", 900, 300, [["execIn", "true"], ["condition", "false"]], { exec: ["execIn", "true", "false"] }),
    binary("greater", 50, 600),
    printString("printTrue", 1200, 100),
    printString("printFalse", 1250, 600),
    printString("printDone", 1300, 900),
    getter("toString", 300, 900, "in"),
    binary("add", 100, 1200),
    getter("lengthString", 700, 1300, "in"),
    getter("length", 800, 1400, "array"),
  ];
  const edges: FormatEdge[] = [
    link("event", "execOut", "forEach", "execIn"),
    link("int0", "out", "array", "item0"),
    link("int1", "out", "array", "item1"),
    link("array", "out", "forEach", "array"),
    link("forEach", "loopBody", "branch", "execIn"),
    link("forEach", "element", "greater", "a"),
    link("greater", "out", "branch", "condition"),
    link("branch", "true", "printTrue", "execIn"),
    link("branch", "false", "printFalse", "execIn"),
    link("forEach", "element", "add", "a"),
    link("forEach", "index", "add", "b"),
    link("add", "out", "toString", "in"),
    link("toString", "out", "printTrue", "inString"),
    link("toString", "out", "printFalse", "inString"),
    link("forEach", "completed", "printDone", "execIn"),
    link("array", "out", "length", "array"),
    link("length", "out", "lengthString", "in"),
    link("lengthString", "out", "printDone", "inString"),
  ];
  const result = formatGraphNodes(nodes, edges, ["event"], { insertKnots: true });
  const knotted = withKnots(result, edges);

  it("routes Element and Index to Add in lanes of their own with two knots each, clear of every node", () => {
    for (const handle of ["element", "index"]) {
      expect(result.knots.find((knot) => knot.edge.sourceHandle === handle && knot.edge.target === "add")?.positions).toHaveLength(2);
    }
    expectWiresClear(knotted.nodes, knotted.edges);
    expectNoBoxOverlaps(knotted.nodes);
    expectExecKnotsInLane(result.nodes, result);
    expectWiresLevelWithShortTransitions(knotted.nodes, knotted.edges);
    expect(closestParallelRuns(knotted.nodes, knotted.edges)).toBeGreaterThanOrEqual(40);
    // For Each's three right-bound outputs fan past each other and the branch rows: a bound, not
    // a target; the editor capture reports the count.
    expect(wireCrossings(knotted.nodes, knotted.edges)).toBeLessThanOrEqual(10);
  });

  it("changes nothing when formatted again with its chained knots in place", () => {
    const again = formatGraphNodes(knotted.nodes, knotted.edges, ["event"], { insertKnots: true });
    expect(again.knots).toEqual([]);
    expect(again.nodes).toEqual(knotted.nodes);
  });
});
