import { describe, expect, it } from "vitest";
import type { FormatLayoutEdge, FormatLayoutNode } from "./format-layout";
import { formatTreeLayout } from "./format-tree-layout";

function node(id: string, x: number, y: number, width = 100, height = 50): FormatLayoutNode {
  return { id, position: { x, y }, width, height, data: {} };
}

function edge(source: string, target: string): FormatLayoutEdge {
  return { id: `${source}-${target}`, source, target };
}

/** Every node at its new position, or where it was when the layout left it out. */
function apply(nodes: FormatLayoutNode[], placed: ReturnType<typeof formatTreeLayout>): FormatLayoutNode[] {
  const byId = new Map(placed.map((row) => [row.id, row.position]));
  return nodes.map((entry) => ({ ...entry, position: byId.get(entry.id) ?? entry.position }));
}

function at(nodes: FormatLayoutNode[], id: string): FormatLayoutNode {
  return nodes.find((entry) => entry.id === id)!;
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

describe("formatTreeLayout", () => {
  it("centres a parent over its children's span, one level gap below the tallest node", () => {
    const nodes = [node("root", 0, 0), node("a", 300, 400), node("b", 900, 20, 200)];
    const result = apply(nodes, formatTreeLayout({ nodes, edges: [edge("root", "a"), edge("root", "b")], selectedIds: [] }));
    // a's centre at 0 and b's 198 to its right (50 + 48 + 100); the span [-50, 298] centres at 124 under root's 50.
    expect(at(result, "root").position).toEqual({ x: 0, y: 0 });
    expect(at(result, "a").position).toEqual({ x: -124, y: 146 });
    expect(at(result, "b").position).toEqual({ x: 24, y: 146 });
  });

  it("gives each level the height of its tallest node plus the gap", () => {
    const nodes = [node("root", 0, 0), node("a", 0, 0, 100, 200), node("b", 0, 0), node("a1", 0, 0), node("b1", 0, 0)];
    const edges = [edge("root", "a"), edge("root", "b"), edge("a", "a1"), edge("b", "b1")];
    const result = apply(nodes, formatTreeLayout({ nodes, edges, selectedIds: [] }));
    expect(at(result, "a").position.y).toBe(146);
    expect(at(result, "b").position.y).toBe(146);
    expect(at(result, "a1").position.y).toBe(146 + 200 + 96);
    expect(at(result, "b1").position.y).toBe(146 + 200 + 96);
  });

  it("places siblings in the host's order, whatever their current X", () => {
    const nodes = [node("root", 0, 0), node("first", 800, 300), node("second", -400, 300), node("third", 200, 300)];
    const order = ["first", "second", "third"];
    const result = apply(
      nodes,
      formatTreeLayout(
        { nodes, edges: [edge("root", "second"), edge("root", "third"), edge("root", "first")], selectedIds: [] },
        { compareSiblings: (a, b) => order.indexOf(a.id) - order.indexOf(b.id) },
      ),
    );
    const xs = order.map((id) => at(result, id).position.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(new Set(xs).size).toBe(3);
  });

  it("keeps the current left-to-right sibling order without a host order", () => {
    const nodes = [node("root", 0, 0), node("left", -50, 600), node("right", 40, 100)];
    const result = apply(nodes, formatTreeLayout({ nodes, edges: [edge("root", "right"), edge("root", "left")], selectedIds: [] }));
    expect(at(result, "left").position.x).toBeLessThan(at(result, "right").position.x);
  });

  it("packs a subtree beside a wider one by their outlines, not their bounding boxes", () => {
    // `wide` has two children, so its subtree is 248 across one level down; `leaf` has none and sits 48 from `wide`.
    const nodes = [node("root", 0, 0), node("wide", 0, 0), node("w1", 0, 0), node("w2", 10, 0), node("leaf", 500, 0)];
    const edges = [edge("root", "wide"), edge("root", "leaf"), edge("wide", "w1"), edge("wide", "w2")];
    const result = apply(nodes, formatTreeLayout({ nodes, edges, selectedIds: [] }));
    const wide = at(result, "wide");
    const leaf = at(result, "leaf");
    expect(leaf.position.x - (wide.position.x + wide.width)).toBe(48);
    // It starts left of the right edge of `wide`'s children, which a bounding box would have to clear.
    expect(leaf.position.x).toBeLessThan(at(result, "w2").position.x + 100);
  });

  it("spreads two subtrees apart where their deeper levels need the room", () => {
    // `deep`'s child must clear `wide`'s right child by 48, which sets them 222 apart centre to centre.
    const nodes = [node("root", 0, 0), node("wide", 0, 0), node("w1", 0, 0), node("w2", 10, 0), node("deep", 500, 0), node("d1", 0, 0)];
    const edges = [edge("root", "wide"), edge("root", "deep"), edge("wide", "w1"), edge("wide", "w2"), edge("deep", "d1")];
    const result = apply(nodes, formatTreeLayout({ nodes, edges, selectedIds: [] }));
    expect(at(result, "deep").position.x - at(result, "wide").position.x).toBe(222);
    expect(at(result, "d1").position.x - (at(result, "w2").position.x + 100)).toBe(48);
  });

  it("never overlaps nodes of mixed sizes", () => {
    const sizes: Array<[string, number, number]> = [
      ["root", 224, 120], ["s1", 224, 200], ["s2", 160, 80], ["s3", 300, 140], ["t1", 224, 90], ["t2", 120, 260],
      ["t3", 224, 90], ["t4", 400, 60], ["t5", 224, 120], ["u1", 224, 90], ["u2", 90, 90], ["u3", 224, 300],
    ];
    const nodes = sizes.map(([id, width, height], index) => node(id, (index * 137) % 500, (index * 71) % 300, width, height));
    const edges = [
      edge("root", "s1"), edge("root", "s2"), edge("root", "s3"), edge("s1", "t1"), edge("s1", "t2"), edge("s2", "t3"),
      edge("s3", "t4"), edge("s3", "t5"), edge("t2", "u1"), edge("t2", "u2"), edge("t4", "u3"),
    ];
    const result = apply(nodes, formatTreeLayout({ nodes, edges, selectedIds: [] }));
    expect(overlapping(result)).toEqual([]);
  });

  it("lays out only the subtree under a selected node, which keeps its position", () => {
    const nodes = [node("root", 0, 0), node("a", -300, 200), node("b", 300, 200), node("a1", 900, 900), node("a2", -900, 50)];
    const edges = [edge("root", "a"), edge("root", "b"), edge("a", "a1"), edge("a", "a2")];
    const placed = formatTreeLayout({ nodes, edges, selectedIds: ["a"] });
    expect(placed.map((row) => row.id).sort()).toEqual(["a", "a1", "a2"]);
    const result = apply(nodes, placed);
    expect(at(result, "a").position).toEqual({ x: -300, y: 200 });
    // a2 is left of a1 now (current X order), both one level below a and centred under it.
    expect(at(result, "a2").position).toEqual({ x: -374, y: 346 });
    expect(at(result, "a1").position).toEqual({ x: -226, y: 346 });
  });

  it("lays out the whole tree when the root is among the selection", () => {
    const nodes = [node("root", 0, 0), node("a", 500, 500), node("a1", 40, 40)];
    const placed = formatTreeLayout({ nodes, edges: [edge("root", "a"), edge("a", "a1")], selectedIds: ["a", "root"] });
    expect(placed.map((row) => row.id).sort()).toEqual(["a", "a1", "root"]);
  });

  it("moves a subtree down just enough to clear an orphan in its way, and never moves the orphan", () => {
    const nodes = [node("root", 0, 0), node("a", 0, 0), node("b", 0, 0), node("orphan", -60, 140, 100, 120)];
    const placed = formatTreeLayout({ nodes, edges: [edge("root", "a"), edge("root", "b")], selectedIds: [] });
    expect(placed.some((row) => row.id === "orphan")).toBe(false);
    const result = apply(nodes, placed);
    // The orphan ends at 260; children clear it by the sibling gap.
    expect(at(result, "a").position.y).toBe(308);
    expect(at(result, "b").position.y).toBe(308);
    expect(at(result, "root").position).toEqual({ x: 0, y: 0 });
    expect(overlapping(result)).toEqual([]);
  });

  it("moves nothing on a second Format", () => {
    const nodes = [
      node("root", 10, 10, 224, 120), node("a", 900, 400, 224, 180), node("b", -200, 300), node("c", 50, 700, 300, 90),
      node("a1", 0, 0), node("a2", 500, 0), node("c1", 9, 9), node("orphan", 0, 330, 100, 100),
    ];
    const edges = [edge("root", "a"), edge("root", "b"), edge("root", "c"), edge("a", "a1"), edge("a", "a2"), edge("c", "c1")];
    const once = apply(nodes, formatTreeLayout({ nodes, edges, selectedIds: [] }));
    const twice = apply(once, formatTreeLayout({ nodes: once, edges, selectedIds: [] }));
    expect(twice.map((entry) => entry.position)).toEqual(once.map((entry) => entry.position));
  });

  it("finishes on malformed data with a cycle and a node under two parents, placing each node once", () => {
    const nodes = [node("a", 0, 0), node("b", 0, 0), node("c", 0, 0), node("d", 0, 0)];
    const edges = [edge("a", "b"), edge("b", "a"), edge("b", "c"), edge("c", "a"), edge("a", "c"), edge("c", "c"), edge("b", "d")];
    const placed = formatTreeLayout({ nodes, edges, selectedIds: [] }, { rootId: "a" });
    expect(placed.map((row) => row.id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(overlapping(apply(nodes, placed))).toEqual([]);
  });
});
