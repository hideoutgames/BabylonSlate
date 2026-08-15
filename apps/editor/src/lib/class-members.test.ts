import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import { addClassMember, memberNamePromptCopy, patchClassMember, removeClassMember } from "./class-members";

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
      {
        id: "fn-1",
        kind: "function",
        name: "Jump",
        pins: [
          { name: "exec", typeId: "exec", direction: "in" },
          { name: "then", typeId: "exec", direction: "out" },
        ],
      },
      { id: "if-1", kind: "interface", name: "Damageable", assetGuid: "" },
    ]);
    expect(graph.nodes).toEqual([]);
  });

  it("seeds a protected Input/Output function graph when adding a function", () => {
    const graph = addClassMember(emptyGraph(), "function", "Jump", () => "fn-1");
    const slice = graph.functionGraphs?.["fn-1"];
    expect(slice?.nodes).toHaveLength(2);
    expect(slice?.nodes.map((node) => node.type)).toEqual([
      "flow.function.input",
      "flow.function.output",
    ]);
    expect(slice?.nodes.every((node) => node.data.__protected === true)).toBe(
      true,
    );
  });

  it("drops the function graph when the function member is removed", () => {
    let graph = addClassMember(emptyGraph(), "function", "Jump", () => "fn-1");
    graph = removeClassMember(graph, "fn-1");
    expect(graph.members).toEqual([]);
    expect(graph.functionGraphs?.["fn-1"]).toBeUndefined();
  });

  it("adds a named custom event node for Events +", () => {
    const graph = addClassMember(emptyGraph(), "event", "On Hit", () => "id");
    expect(graph.members).toEqual([
      { id: "id", kind: "event", name: "On Hit", pins: [] },
    ]);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.type).toBe("flow.event.custom");
    expect(graph.nodes[0]?.data.title).toBe("Event On Hit");
    expect(graph.nodes[0]?.data.name).toBe("On Hit");
    expect(graph.nodes[0]?.data.pins).toEqual([]);
  });

  it("syncs custom event output pins onto the event node and matching Call nodes", () => {
    let graph = addClassMember(emptyGraph(), "event", "On Hit", () => "evt-1");
    graph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: "call-1",
          type: "flow.event.call",
          position: { x: 200, y: 80 },
          data: {
            title: "Call On Hit",
            name: "On Hit",
            __nodeType: "flow.event.call",
          },
        },
      ],
    };
    const pins = [{ name: "amount", typeId: "float", direction: "out" as const }];
    graph = patchClassMember(graph, "evt-1", { pins });
    expect(graph.members?.[0]?.pins).toEqual(pins);
    expect(graph.nodes[0]?.data.pins).toEqual(pins);
    expect(graph.nodes[1]?.data.pins).toEqual(pins);
  });

  it("uses one id for the event member and node so Class tree remove matches", () => {
    let n = 0;
    const graph = addClassMember(emptyGraph(), "event", "On Hit", () => `id-${++n}`);
    expect(graph.nodes[0]?.id).toBe(graph.members?.[0]?.id);
    expect(graph.nodes[0]?.id).toBe("id-1");
    const next = removeClassMember(graph, graph.nodes[0]!.id);
    expect(next.nodes).toEqual([]);
    expect(next.members).toEqual([]);
  });

  it("removes a native event canvas node without dropping the rest of the graph", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "begin",
          type: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [],
    };
    const next = removeClassMember(graph, "begin");
    expect(next.nodes).toEqual([]);
  });

  it("Title Cases typed event names and prefixes Event on the node", () => {
    const graph = addClassMember(emptyGraph(), "event", "on hit", () => "id");
    expect(graph.members?.[0]?.name).toBe("On Hit");
    expect(graph.nodes[0]?.data.name).toBe("On Hit");
    expect(graph.nodes[0]?.data.title).toBe("Event On Hit");
  });

  it("does not double-prefix Event when the typed name already has it", () => {
    const graph = addClassMember(
      emptyGraph(),
      "event",
      "Event beginPlay",
      () => "id",
    );
    expect(graph.members?.[0]?.name).toBe("Begin Play");
    expect(graph.nodes[0]?.data.title).toBe("Event Begin Play");
  });

  it("adds a variable with a pin type and does not spawn a Get node", () => {
    const graph = addClassMember(emptyGraph(), "variable", "Health", () => "id");
    expect(graph.members?.[0]).toEqual({
      id: "id",
      kind: "variable",
      name: "Health",
      typeId: "float",
    });
    expect(graph.nodes).toEqual([]);
  });

  it("patches and removes a declared member", () => {
    let graph = addClassMember(emptyGraph(), "variable", "Health", () => "var-1");
    graph = patchClassMember(graph, "var-1", { typeId: "bool", defaultValue: "true" });
    expect(graph.members?.[0]).toMatchObject({
      typeId: "bool",
      defaultValue: "true",
    });
    graph = removeClassMember(graph, "var-1");
    expect(graph.members).toEqual([]);
  });

  it("syncs function Input/Output node pin lists when the signature changes", () => {
    let graph = addClassMember(emptyGraph(), "function", "Jump", () => "fn-1");
    const pins = [
      { name: "exec", typeId: "exec", direction: "in" as const },
      { name: "height", typeId: "float", direction: "in" as const },
      { name: "then", typeId: "exec", direction: "out" as const },
    ];
    graph = patchClassMember(graph, "fn-1", { pins });
    expect(graph.members?.[0]?.pins).toEqual(pins);
    const slice = graph.functionGraphs?.["fn-1"];
    expect(slice?.nodes.map((node) => node.data.pins)).toEqual([pins, pins]);
  });
});

describe("memberNamePromptCopy", () => {
  it("returns Title Case titles and labels for each member kind", () => {
    expect(memberNamePromptCopy("function")).toEqual({
      title: "Add Function",
      label: "Function Name",
    });
    expect(memberNamePromptCopy("variable").title).toBe("Add Variable");
    expect(memberNamePromptCopy("event").label).toBe("Event Name");
    expect(memberNamePromptCopy("interface").title).toBe("Add Interface");
  });
});
