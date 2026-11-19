import { describe, expect, it } from "vitest";
import { Position } from "@xyflow/react";
import type { FormatLayoutEdge, FormatLayoutNode } from "./format-layout";
import { formatStateMachineLayout, formatStateMachineSides } from "./format-state-machine-layout";
import { ANIM_TRANSITION_MIN_STUB, animTransitionPath, type AnimStateSide } from "./anim-transition-path";

function state(id: string, x: number, y: number, width = 200, height = 88): FormatLayoutNode {
  return { id, position: { x, y }, width, height, data: {} };
}

function edge(source: string, target: string): FormatLayoutEdge {
  return { id: `${source}-${target}`, source, target };
}

function apply(nodes: FormatLayoutNode[], placed: ReturnType<typeof formatStateMachineLayout>): FormatLayoutNode[] {
  const byId = new Map(placed.map((row) => [row.id, row.position]));
  return nodes.map((entry) => ({ ...entry, position: byId.get(entry.id) ?? entry.position }));
}

function at(nodes: FormatLayoutNode[], id: string): FormatLayoutNode {
  return nodes.find((entry) => entry.id === id)!;
}

const POSITION: Record<AnimStateSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

/** Where the editor's wire meets a side: its midpoint, 2px outside the card (the plates and the wire's insets). */
function wireEnd(entry: FormatLayoutNode, side: AnimStateSide) {
  const { x, y } = entry.position;
  if (side === "top") return { x: x + entry.width / 2, y: y - 2 };
  if (side === "bottom") return { x: x + entry.width / 2, y: y + entry.height + 2 };
  if (side === "left") return { x: x - 2, y: y + entry.height / 2 };
  return { x: x + entry.width + 2, y: y + entry.height / 2 };
}

/** The wire the editor draws for a transition after Format: the real path function's cubic, sampled finely. */
function drawnWire(nodes: FormatLayoutNode[], row: FormatLayoutEdge): Array<{ x: number; y: number }> {
  const from = at(nodes, row.source);
  const to = at(nodes, row.target);
  const box = (entry: FormatLayoutNode) => ({ ...entry.position, width: entry.width, height: entry.height });
  const sides = formatStateMachineSides(box(from), box(to));
  const source = wireEnd(from, sides.source);
  const target = wireEnd(to, sides.target);
  const { path } = animTransitionPath({
    sourceX: source.x,
    sourceY: source.y,
    sourcePosition: POSITION[sides.source],
    targetX: target.x,
    targetY: target.y,
    targetPosition: POSITION[sides.target],
  });
  const numbers = path.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g)!.map(Number);
  const [p0x, p0y, c1x, c1y, c2x, c2y, p3x, p3y] = numbers as [number, number, number, number, number, number, number, number];
  const points: Array<{ x: number; y: number }> = [];
  for (let step = 0; step <= 400; step += 1) {
    const t = step / 400;
    const u = 1 - t;
    points.push({
      x: u * u * u * p0x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * p3x,
      y: u * u * u * p0y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * p3y,
    });
  }
  return points;
}

/** The least distance from any drawn wire to a state it does not connect, and the wires closer than 32 to one. */
function wireClearance(nodes: FormatLayoutNode[], edges: FormatLayoutEdge[]) {
  let least = Infinity;
  const tooClose: string[] = [];
  for (const row of edges) {
    const wire = drawnWire(nodes, row);
    for (const other of nodes) {
      if (other.id === row.source || other.id === row.target) continue;
      let distance = Infinity;
      for (const point of wire) {
        const dx = Math.max(other.position.x - point.x, 0, point.x - (other.position.x + other.width));
        const dy = Math.max(other.position.y - point.y, 0, point.y - (other.position.y + other.height));
        distance = Math.min(distance, Math.hypot(dx, dy));
      }
      least = Math.min(least, distance);
      if (distance < 32) tooClose.push(`${row.id} near ${other.id}`);
    }
  }
  return { least, tooClose };
}

function overlapping(nodes: FormatLayoutNode[]): string[] {
  const pairs: string[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      if (
        a.position.x < b.position.x + b.width &&
        b.position.x < a.position.x + a.width &&
        a.position.y < b.position.y + b.height &&
        b.position.y < a.position.y + a.height
      ) {
        pairs.push(`${a.id}/${b.id}`);
      }
    }
  }
  return pairs;
}

describe("formatStateMachineSides", () => {
  it("joins states in different columns by their facing left and right sides, and one column by top and bottom", () => {
    const box = (x: number, y: number) => ({ x, y, width: 200, height: 88 });
    expect(formatStateMachineSides(box(0, 0), box(300, 400))).toEqual({ source: "right", target: "left" });
    expect(formatStateMachineSides(box(300, 400), box(0, 0))).toEqual({ source: "left", target: "right" });
    expect(formatStateMachineSides(box(0, 0), box(100, 400))).toEqual({ source: "bottom", target: "top" });
    expect(formatStateMachineSides(box(100, 400), box(0, 0))).toEqual({ source: "top", target: "bottom" });
  });
});

describe("formatStateMachineLayout", () => {
  it("puts each state in the column of its shortest distance from the entry, which keeps its place", () => {
    const nodes = [state("entry", 100, 50), state("a", 700, 600), state("b", -300, 0), state("c", 40, 900)];
    const edges = [edge("entry", "a"), edge("a", "b"), edge("b", "c"), edge("entry", "c")];
    const result = apply(nodes, formatStateMachineLayout({ nodes, edges, selectedIds: [] }, { entryId: "entry" }));
    expect(at(result, "entry").position).toEqual({ x: 100, y: 50 });
    // c is one transition from the entry, like a, though the chain through b also reaches it.
    expect(at(result, "a").position.x).toBe(at(result, "c").position.x);
    expect(at(result, "a").position.x).toBeGreaterThan(300);
    expect(at(result, "b").position.x).toBeGreaterThan(at(result, "a").position.x + 200);
    expect(overlapping(result)).toEqual([]);
  });

  it("does not stretch the graph for a cycle or back transitions", () => {
    const nodes = [state("entry", 0, 0), state("a", 0, 300), state("b", 0, 600)];
    const edges = [edge("entry", "a"), edge("a", "b"), edge("b", "entry"), edge("b", "a")];
    const result = apply(nodes, formatStateMachineLayout({ nodes, edges, selectedIds: [] }, { entryId: "entry" }));
    const step = at(result, "a").position.x - at(result, "entry").position.x;
    expect(step).toBeGreaterThan(200);
    expect(at(result, "b").position.x - at(result, "a").position.x).toBe(step);
  });

  it("leaves room for a pair's arrowheads and badge between neighbouring layers", () => {
    const nodes = [state("entry", 0, 0), state("a", 210, 0)];
    const edges = [edge("entry", "a"), edge("a", "entry")];
    const result = apply(nodes, formatStateMachineLayout({ nodes, edges, selectedIds: [] }, { entryId: "entry" }));
    const gap = at(result, "a").position.x - (at(result, "entry").position.x + 200);
    expect(gap).toBeGreaterThanOrEqual(2 * ANIM_TRANSITION_MIN_STUB);
  });

  it("keeps a long back transition's drawn wire 32 units clear of the states between its ends", () => {
    const nodes = [state("entry", 0, 0), state("x", 400, 0), state("y", 800, 0), state("z", 1200, 0)];
    const edges = [edge("entry", "x"), edge("x", "y"), edge("y", "z"), edge("z", "entry")];
    const result = apply(nodes, formatStateMachineLayout({ nodes, edges, selectedIds: [] }, { entryId: "entry" }));
    expect(wireClearance(result, edges).tooClose).toEqual([]);
    expect(overlapping(result)).toEqual([]);
  });

  it("opens a lane for a back transition past a column of states", () => {
    // land -> entry runs back over the middle columns, each holding two states.
    const nodes = [
      state("entry", 0, 0), state("jump", 400, -100), state("walk", 400, 100), state("fall", 800, -100),
      state("run", 800, 100), state("land", 1200, 0),
    ];
    const edges = [
      edge("entry", "jump"), edge("entry", "walk"), edge("jump", "fall"), edge("walk", "run"), edge("fall", "land"),
      edge("run", "land"), edge("land", "entry"),
    ];
    const result = apply(nodes, formatStateMachineLayout({ nodes, edges, selectedIds: [] }, { entryId: "entry" }));
    expect(wireClearance(result, edges).tooClose).toEqual([]);
    expect(overlapping(result)).toEqual([]);
  });

  it("orders a layer to remove a crossing the current order has", () => {
    const nodes = [
      state("entry", 0, 150), state("a", 400, 0), state("b", 400, 300), state("d", 800, 0), state("c", 800, 300),
    ];
    const edges = [edge("entry", "a"), edge("entry", "b"), edge("a", "c"), edge("b", "d")];
    const result = apply(nodes, formatStateMachineLayout({ nodes, edges, selectedIds: [] }, { entryId: "entry" }));
    expect(at(result, "c").position.y).toBeLessThan(at(result, "d").position.y);
  });

  it("puts a state that only leads into the machine one layer before the earliest state it leads to", () => {
    const nodes = [state("entry", 0, 0), state("a", 0, 300), state("lead", 900, 900), state("first", 500, 900)];
    const edges = [edge("entry", "a"), edge("lead", "a"), edge("first", "entry")];
    const result = apply(nodes, formatStateMachineLayout({ nodes, edges, selectedIds: [] }, { entryId: "entry" }));
    // lead goes to a (layer 1), so it shares the entry's column; first leads to the entry, so it sits left of it.
    expect(at(result, "entry").position).toEqual({ x: 0, y: 0 });
    expect(at(result, "lead").position.x).toBe(at(result, "entry").position.x);
    expect(at(result, "first").position.x + 200).toBeLessThan(at(result, "entry").position.x);
    expect(overlapping(result)).toEqual([]);
    expect(wireClearance(result, edges).tooClose).toEqual([]);
  });

  it("puts states with no transition into the machine in one row below, in their current left-to-right order", () => {
    const nodes = [state("entry", 0, 0), state("a", 0, 200), state("late", 900, -500), state("early", 100, 900)];
    const edges = [edge("entry", "a"), edge("early", "late")];
    const result = apply(nodes, formatStateMachineLayout({ nodes, edges, selectedIds: [] }, { entryId: "entry" }));
    const mainBottom = Math.max(at(result, "entry").position.y + 88, at(result, "a").position.y + 88);
    expect(at(result, "early").position.y).toBe(at(result, "late").position.y);
    expect(at(result, "early").position.y).toBeGreaterThan(mainBottom);
    expect(at(result, "early").position.x).toBeLessThan(at(result, "late").position.x);
    expect(overlapping(result)).toEqual([]);
  });

  it("lays out a State Alias one layer after the states it stands for, and its targets after it", () => {
    const nodes = [state("entry", 0, 0), state("walk", 300, 0), state("any", 0, 400), state("death", 50, 700)];
    const edges = [edge("entry", "walk"), edge("any", "death")];
    const result = apply(
      nodes,
      formatStateMachineLayout(
        { nodes, edges, selectedIds: [] },
        { entryId: "entry", aliasStates: (entry) => (entry.id === "any" ? ["entry", "walk"] : undefined) },
      ),
    );
    expect(at(result, "any").position.x).toBe(at(result, "walk").position.x);
    expect(at(result, "death").position.x).toBeGreaterThan(at(result, "any").position.x + 200);
    expect(overlapping(result)).toEqual([]);
  });

  it("lays out only a selection of states, as a block at the selection's top-left", () => {
    const nodes = [state("entry", 0, 0), state("a", 500, 300), state("b", 260, 700), state("c", 900, 120), state("d", 0, 900)];
    const edges = [edge("entry", "a"), edge("a", "b"), edge("b", "c"), edge("c", "d")];
    const placed = formatStateMachineLayout({ nodes, edges, selectedIds: ["c", "a", "b"] }, { entryId: "entry" });
    expect(placed.map((row) => row.id).sort()).toEqual(["a", "b", "c"]);
    const result = apply(nodes, placed);
    const moved = ["a", "b", "c"].map((id) => at(result, id));
    expect(Math.min(...moved.map((entry) => entry.position.x))).toBe(260);
    expect(Math.min(...moved.map((entry) => entry.position.y))).toBe(120);
    // a leads the selection, so it is its first column.
    expect(at(result, "a").position.x).toBe(260);
    expect(at(result, "b").position.x).toBeGreaterThan(at(result, "a").position.x);
    expect(at(result, "c").position.x).toBeGreaterThan(at(result, "b").position.x);
  });

  it("lays out the whole machine for a single selected state", () => {
    const nodes = [state("entry", 0, 0), state("a", 500, 300), state("b", 260, 700)];
    const edges = [edge("entry", "a"), edge("a", "b")];
    const placed = formatStateMachineLayout({ nodes, edges, selectedIds: ["a"] }, { entryId: "entry" });
    expect(placed.map((row) => row.id).sort()).toEqual(["a", "b", "entry"]);
  });

  it("lays out a larger machine with cycles, pairs and a leading state 32 units clear, and moves nothing the second time", () => {
    const ids = ["idle", "walk", "run", "jump", "fall", "land", "crouch", "slide", "hidden", "lonely"];
    const nodes = ids.map((id, index) => state(id, (index * 389) % 1100, (index * 241) % 700, 200 + (index % 3) * 30, 88));
    const edges = [
      edge("idle", "walk"), edge("walk", "idle"), edge("walk", "run"), edge("run", "walk"), edge("idle", "jump"),
      edge("run", "jump"), edge("jump", "fall"), edge("fall", "land"), edge("land", "idle"), edge("idle", "crouch"),
      edge("crouch", "slide"), edge("run", "slide"), edge("slide", "crouch"), edge("crouch", "idle"),
      edge("hidden", "idle"),
    ];
    const once = apply(nodes, formatStateMachineLayout({ nodes, edges, selectedIds: [] }, { entryId: "idle" }));
    expect(overlapping(once)).toEqual([]);
    expect(wireClearance(once, edges).tooClose).toEqual([]);
    expect(at(once, "idle").position).toEqual(at(nodes, "idle").position);
    expect(at(once, "hidden").position.x + at(once, "hidden").width).toBeLessThan(at(once, "idle").position.x);
    const twice = formatStateMachineLayout({ nodes: once, edges, selectedIds: [] }, { entryId: "idle" });
    expect(apply(once, twice).map((entry) => entry.position)).toEqual(once.map((entry) => entry.position));
  });
});
