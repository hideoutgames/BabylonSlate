import { describe, expect, it } from "vitest";
import type { FormatLayoutEdge, FormatLayoutNode } from "./format-layout";
import { formatStateMachineLayout } from "./format-state-machine-layout";
import { ANIM_TRANSITION_MIN_STUB } from "./anim-transition-path";

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

function centre(entry: FormatLayoutNode) {
  return { x: entry.position.x + entry.width / 2, y: entry.position.y + entry.height / 2 };
}

/** Whether the straight line between two points enters the box, sampled finely (independent of the layout's clip). */
function lineEntersBox(a: { x: number; y: number }, b: { x: number; y: number }, box: FormatLayoutNode): boolean {
  for (let step = 0; step <= 400; step += 1) {
    const t = step / 400;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (x > box.position.x && x < box.position.x + box.width && y > box.position.y && y < box.position.y + box.height) {
      return true;
    }
  }
  return false;
}

/** Transitions whose straight centre-to-centre line runs through a state other than its two ends. */
function throughThirdState(nodes: FormatLayoutNode[], edges: FormatLayoutEdge[]): string[] {
  const hits: string[] = [];
  for (const row of edges) {
    for (const other of nodes) {
      if (other.id === row.source || other.id === row.target) continue;
      if (lineEntersBox(centre(at(nodes, row.source)), centre(at(nodes, row.target)), other)) hits.push(`${row.id} through ${other.id}`);
    }
  }
  return hits;
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

  it("moves a middle state off a long back transition's straight path", () => {
    const nodes = [state("entry", 0, 0), state("x", 400, 0), state("y", 800, 0), state("z", 1200, 0)];
    const edges = [edge("entry", "x"), edge("x", "y"), edge("y", "z"), edge("z", "entry")];
    const result = apply(nodes, formatStateMachineLayout({ nodes, edges, selectedIds: [] }, { entryId: "entry" }));
    expect(throughThirdState(result, edges)).toEqual([]);
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

  it("puts states the entry cannot reach in one row below, in their current left-to-right order", () => {
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

  it("lays out a larger machine with cycles, pairs and an unreachable state cleanly, and moves nothing the second time", () => {
    const ids = ["idle", "walk", "run", "jump", "fall", "land", "crouch", "slide", "orphan"];
    const nodes = ids.map((id, index) => state(id, (index * 389) % 1100, (index * 241) % 700, 200 + (index % 3) * 30, 88));
    const edges = [
      edge("idle", "walk"), edge("walk", "idle"), edge("walk", "run"), edge("run", "walk"), edge("idle", "jump"),
      edge("run", "jump"), edge("jump", "fall"), edge("fall", "land"), edge("land", "idle"), edge("idle", "crouch"),
      edge("crouch", "slide"), edge("run", "slide"), edge("slide", "crouch"), edge("crouch", "idle"),
    ];
    const once = apply(nodes, formatStateMachineLayout({ nodes, edges, selectedIds: [] }, { entryId: "idle" }));
    expect(overlapping(once)).toEqual([]);
    expect(throughThirdState(once, edges)).toEqual([]);
    expect(at(once, "idle").position).toEqual(at(nodes, "idle").position);
    const twice = formatStateMachineLayout({ nodes: once, edges, selectedIds: [] }, { entryId: "idle" });
    expect(apply(once, twice).map((entry) => entry.position)).toEqual(once.map((entry) => entry.position));
  });
});
