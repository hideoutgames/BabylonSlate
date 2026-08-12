import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import { addClassMember } from "./class-members";

function emptyGraph(): SerializedGraph {
  return { nodes: [], edges: [] };
}

describe("addClassMember", () => {
  it("ignores a blank name", () => {
    const graph = emptyGraph();
    expect(addClassMember(graph, "function", "  ")).toBe(graph);
  });

  it("records functions, variables, and interfaces on the graph members list", () => {
    let graph = emptyGraph();
    graph = addClassMember(graph, "function", "Jump", () => "fn-1");
    graph = addClassMember(graph, "interface", "Damageable", () => "if-1");
    expect(graph.members).toEqual([
      { id: "fn-1", kind: "function", name: "Jump" },
      { id: "if-1", kind: "interface", name: "Damageable" },
    ]);
    expect(graph.nodes).toEqual([]);
  });

  it("adds a named custom event node for Events +", () => {
    const graph = addClassMember(emptyGraph(), "event", "On Hit", () => "id");
    expect(graph.members).toEqual([
      { id: "id", kind: "event", name: "On Hit" },
    ]);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.type).toBe("flow.event.custom");
    expect(graph.nodes[0]?.data.title).toBe("Event On Hit");
    expect(graph.nodes[0]?.data.name).toBe("On Hit");
  });

  it("drops a Get Variable node when adding a variable", () => {
    const graph = addClassMember(emptyGraph(), "variable", "Health", () => "id");
    expect(graph.members?.[0]).toEqual({
      id: "id",
      kind: "variable",
      name: "Health",
    });
    expect(graph.nodes[0]?.type).toBe("variables.get");
    expect(graph.nodes[0]?.data.name).toBe("Health");
  });
});
