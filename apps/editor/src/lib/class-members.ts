import type {
  GraphClassMember,
  GraphClassMemberKind,
  SerializedGraph,
} from "@babylonslate/core";

export type { GraphClassMember, GraphClassMemberKind };

function nextId(factory?: () => string): string {
  return factory?.() ?? crypto.randomUUID();
}

/** Append a named class member; events and variables also drop a graph node. */
export function addClassMember(
  graph: SerializedGraph,
  kind: GraphClassMemberKind,
  name: string,
  idFactory?: () => string,
): SerializedGraph {
  const trimmed = name.trim();
  if (!trimmed) return graph;
  const member: GraphClassMember = {
    id: nextId(idFactory),
    kind,
    name: trimmed,
  };
  const members = [...(graph.members ?? []), member];
  if (kind === "event") {
    const nodeId = nextId(idFactory);
    return {
      ...graph,
      members,
      nodes: [
        ...graph.nodes,
        {
          id: nodeId,
          type: "flow.event.custom",
          position: {
            x: 80,
            y: 80 + graph.nodes.length * 80,
          },
          data: {
            title: `Event ${trimmed}`,
            name: trimmed,
            __nodeType: "flow.event.custom",
          },
        },
      ],
    };
  }
  if (kind === "variable") {
    const nodeId = nextId(idFactory);
    return {
      ...graph,
      members,
      nodes: [
        ...graph.nodes,
        {
          id: nodeId,
          type: "variables.get",
          position: {
            x: 80,
            y: 80 + graph.nodes.length * 80,
          },
          data: {
            title: `Get ${trimmed}`,
            name: trimmed,
            __nodeType: "variables.get",
          },
        },
      ],
    };
  }
  return { ...graph, members };
}
