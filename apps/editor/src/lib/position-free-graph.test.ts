import { describe, expect, it } from "vitest";
import { createPositionFreeGraphSelector, equalIgnoringNodePositions } from "./position-free-graph";

const node = (id: string, x: number, data: Record<string, unknown> = {}) => ({ id, type: "flow.print", position: { x, y: 0 }, data });
const graph = () => ({
  nodes: [node("a", 0), node("b", 200, { text: "Hi" })],
  edges: [{ id: "e", source: "a", target: "b" }],
  members: [{ id: "m", kind: "variable", name: "Health" }],
  functionGraphs: { f: { nodes: [node("entry", 0)], edges: [] } },
});

describe("equalIgnoringNodePositions", () => {
  it.each([
    ["a moved node", (g: ReturnType<typeof graph>) => { g.nodes[1]!.position = { x: 900, y: 40 }; }, true],
    ["a moved node in a function graph", (g: ReturnType<typeof graph>) => { g.functionGraphs.f.nodes[0]!.position.y = 12; }, true],
    ["a node's data", (g: ReturnType<typeof graph>) => { g.nodes[1]!.data.text = "Bye"; }, false],
    ["a wire", (g: ReturnType<typeof graph>) => { g.edges[0]!.target = "a"; }, false],
    ["a member", (g: ReturnType<typeof graph>) => { g.members[0]!.name = "Mana"; }, false],
    ["an added node", (g: ReturnType<typeof graph>) => { g.nodes.push(node("c", 0)); }, false],
    ["a node's type", (g: ReturnType<typeof graph>) => { g.nodes[0]!.type = "flow.branch"; }, false],
    ["a position-like field outside a node", (g: ReturnType<typeof graph>) => { (g.members[0] as Record<string, unknown>).position = 1; }, false],
  ] as const)("%s: equal %s", (_name, change, equal) => {
    const next = graph();
    change(next);
    expect(equalIgnoringNodePositions(graph(), next)).toBe(equal);
  });
});

describe("createPositionFreeGraphSelector", () => {
  it("keeps the graph it returned while only positions change, and takes the next real change", () => {
    const select = createPositionFreeGraphSelector<ReturnType<typeof graph>>();
    const first = graph();
    expect(select(first)).toBe(first);
    const moved = graph();
    moved.nodes[0]!.position = { x: 50, y: 50 };
    expect(select(moved)).toBe(first);
    expect(select(moved)).toBe(first);
    const edited = structuredClone(moved);
    edited.nodes[0]!.data.text = "Hi";
    expect(select(edited)).toBe(edited);
    // Undo of the edit: back to the moved graph's content, a real change from the edited one.
    expect(select(moved)).toBe(moved);
  });
});
