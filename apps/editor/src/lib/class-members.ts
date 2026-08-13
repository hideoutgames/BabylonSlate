import type {
  GraphClassMember,
  GraphClassMemberKind,
  GraphClassMemberPin,
  SerializedGraph,
} from "@babylonslate/core";
import {
  formatEventMemberName,
  formatEventTitle,
} from "@babylonslate/editor-kit";

export type { GraphClassMember, GraphClassMemberKind, GraphClassMemberPin };

export function memberNamePromptCopy(kind: GraphClassMemberKind): {
  title: string;
  label: string;
} {
  switch (kind) {
    case "function":
      return { title: "Add Function", label: "Function Name" };
    case "variable":
      return { title: "Add Variable", label: "Variable Name" };
    case "event":
      return { title: "Add Event", label: "Event Name" };
    default:
      return { title: "Add Interface", label: "Interface Name" };
  }
}

function nextId(factory?: () => string): string {
  return factory?.() ?? crypto.randomUUID();
}

function memberDefaults(
  kind: GraphClassMemberKind,
  extras?: Partial<GraphClassMember>,
): Partial<GraphClassMember> {
  if (kind === "variable") {
    return { typeId: extras?.typeId ?? "float", defaultValue: extras?.defaultValue };
  }
  if (kind === "function") {
    return { pins: extras?.pins ?? [] };
  }
  if (kind === "interface") {
    return { assetGuid: extras?.assetGuid ?? "" };
  }
  return {};
}

/** Append a named class member. Events insert a custom event node; variables do not spawn Get nodes. */
export function addClassMember(
  graph: SerializedGraph,
  kind: GraphClassMemberKind,
  name: string,
  idFactory?: () => string,
  extras?: Partial<GraphClassMember>,
): SerializedGraph {
  const trimmed = name.trim();
  if (!trimmed) return graph;
  const displayName =
    kind === "event" ? formatEventMemberName(trimmed) : trimmed;
  if (!displayName) return graph;
  const member: GraphClassMember = {
    id: nextId(idFactory),
    kind,
    name: displayName,
    ...memberDefaults(kind, extras),
  };
  const members = [...(graph.members ?? []), member];
  if (kind === "event") {
    return {
      ...graph,
      members,
      nodes: [
        ...graph.nodes,
        {
          id: member.id,
          type: "flow.event.custom",
          position: {
            x: 80,
            y: 80 + graph.nodes.length * 80,
          },
          data: {
            title: formatEventTitle(trimmed),
            name: displayName,
            __nodeType: "flow.event.custom",
          },
        },
      ],
    };
  }
  return { ...graph, members };
}

export function patchClassMember(
  graph: SerializedGraph,
  memberId: string,
  patch: Partial<GraphClassMember>,
): SerializedGraph {
  const members = (graph.members ?? []).map((member) =>
    member.id === memberId ? { ...member, ...patch } : member,
  );
  return { ...graph, members };
}

export function removeClassMember(
  graph: SerializedGraph,
  memberId: string,
): SerializedGraph {
  const members = (graph.members ?? []).filter((member) => member.id !== memberId);
  const eventMember = (graph.members ?? []).find(
    (member) => member.id === memberId && member.kind === "event",
  );
  if (!eventMember) {
    return { ...graph, members };
  }
  return {
    ...graph,
    members,
    nodes: graph.nodes.filter((node) => {
      if (!node.type.startsWith("flow.event.")) return true;
      const named = node.data.name;
      return named !== eventMember.name && node.id !== memberId;
    }),
  };
}
