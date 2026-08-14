import type {
  GraphClassMember,
  GraphClassMemberKind,
  GraphClassMemberPin,
  SerializedGraph,
} from "@babylonslate/core";
import {
  engineParentOf,
  formatEventMemberName,
  formatEventTitle,
  walkAncestry,
} from "@babylonslate/editor-kit";

export type { GraphClassMember, GraphClassMemberKind, GraphClassMemberPin };

export const DEFAULT_FUNCTION_PINS: GraphClassMemberPin[] = [
  { name: "exec", typeId: "exec", direction: "in" },
  { name: "then", typeId: "exec", direction: "out" },
];

export const NATIVE_CLASS_EVENT_TYPES = [
  "flow.event.beginPlay",
  "flow.event.tick",
] as const;

const NATIVE_EVENT_TITLES: Record<string, string> = {
  "flow.event.beginPlay": "Event Begin Play",
  "flow.event.tick": "Event Tick",
  "flow.event.commandRun": "Event On Command Run",
};

export function nativeStubId(eventType: string): string {
  return `native:${eventType}`;
}

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
    return { pins: extras?.pins ?? DEFAULT_FUNCTION_PINS };
  }
  if (kind === "interface") {
    return { assetGuid: extras?.assetGuid ?? "" };
  }
  return {};
}

function seedFunctionGraph(
  member: GraphClassMember,
): NonNullable<SerializedGraph["functionGraphs"]>[string] {
  const pins = member.pins ?? DEFAULT_FUNCTION_PINS;
  return {
    nodes: [
      {
        id: `${member.id}-input`,
        type: "flow.function.input",
        position: { x: 80, y: 120 },
        data: {
          title: "Input",
          __protected: true,
          __nodeType: "flow.function.input",
          pins,
        },
      },
      {
        id: `${member.id}-output`,
        type: "flow.function.output",
        position: { x: 420, y: 120 },
        data: {
          title: "Output",
          __protected: true,
          __nodeType: "flow.function.output",
          pins,
        },
      },
    ],
    edges: [],
  };
}

export function nativeEventStubs(options?: {
  parentClass?: string | null;
  parentOf?: (id: string) => string | null | undefined;
}): Array<{ eventType: string; name: string }> {
  const parentOf =
    options?.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
  const chain = walkAncestry(options?.parentClass ?? "Actor", parentOf);
  const types: string[] = [...NATIVE_CLASS_EVENT_TYPES];
  if (chain.includes("BDebugCommand")) {
    types.push("flow.event.commandRun");
  }
  return types.map((eventType) => ({
    eventType,
    name: NATIVE_EVENT_TITLES[eventType] ?? formatEventTitle(eventType),
  }));
}

export function ensureEventNodeOnGraph(
  graph: SerializedGraph,
  eventType: string,
  extras?: { name?: string; title?: string; idFactory?: () => string },
): SerializedGraph {
  const existing = graph.nodes.find((node) => {
    if (node.type !== eventType) return false;
    if (eventType !== "flow.event.custom") return true;
    const named = node.data.name;
    return extras?.name ? named === extras.name : true;
  });
  if (existing) return graph;
  const id = nextId(extras?.idFactory);
  const title =
    extras?.title ??
    NATIVE_EVENT_TITLES[eventType] ??
    formatEventTitle(extras?.name ?? eventType);
  return {
    ...graph,
    nodes: [
      ...graph.nodes,
      {
        id,
        type: eventType,
        position: {
          x: 80,
          y: 80 + graph.nodes.length * 80,
        },
        data: {
          title,
          ...(extras?.name ? { name: extras.name } : {}),
          __nodeType: eventType,
        },
      },
    ],
  };
}

function syncFunctionGraphPins(
  graph: SerializedGraph,
  memberId: string,
  pins: GraphClassMemberPin[],
): SerializedGraph {
  const slice = graph.functionGraphs?.[memberId];
  if (!slice) return graph;
  return {
    ...graph,
    functionGraphs: {
      ...graph.functionGraphs,
      [memberId]: {
        ...slice,
        nodes: slice.nodes.map((node) => {
          if (
            node.type !== "flow.function.input" &&
            node.type !== "flow.function.output"
          ) {
            return node;
          }
          return {
            ...node,
            data: { ...node.data, pins },
          };
        }),
      },
    },
  };
}

/** Append a named class member. Events insert a custom event node; functions seed a graph. */
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
  if (kind === "function") {
    return {
      ...graph,
      members,
      functionGraphs: {
        ...graph.functionGraphs,
        [member.id]: seedFunctionGraph(member),
      },
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
  const next = { ...graph, members };
  if (!patch.pins) return next;
  return syncFunctionGraphPins(next, memberId, patch.pins);
}

export function removeClassMember(
  graph: SerializedGraph,
  memberId: string,
): SerializedGraph {
  const members = (graph.members ?? []).filter((member) => member.id !== memberId);
  const declared = (graph.members ?? []).find((member) => member.id === memberId);
  if (declared?.kind === "function") {
    const functionGraphs = { ...graph.functionGraphs };
    delete functionGraphs[memberId];
    return { ...graph, members, functionGraphs };
  }
  if (declared?.kind === "event") {
    const dropIds = new Set(
      graph.nodes
        .filter((node) => {
          if (!node.type.startsWith("flow.event.")) return false;
          const named = node.data.name;
          return named === declared.name || node.id === memberId;
        })
        .map((node) => node.id),
    );
    return {
      ...graph,
      members,
      nodes: graph.nodes.filter((node) => !dropIds.has(node.id)),
      edges: graph.edges.filter(
        (edge) => !dropIds.has(edge.source) && !dropIds.has(edge.target),
      ),
    };
  }
  if (declared) {
    return { ...graph, members };
  }
  const node = graph.nodes.find((entry) => entry.id === memberId);
  if (!node) return graph;
  return {
    ...graph,
    nodes: graph.nodes.filter((entry) => entry.id !== memberId),
    edges: graph.edges.filter(
      (edge) => edge.source !== memberId && edge.target !== memberId,
    ),
  };
}
