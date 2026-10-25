import {
  declaredValueUnit,
  type GraphClassMember,
  type SerializedGraph,
} from "@haptic/core";
import { formatEventMemberName } from "@haptic/editor-kit";

export function nextId(factory?: () => string): string {
  return factory?.() ?? crypto.randomUUID();
}

/** Get / Set / Validated Get nodes bound to `member` by its id. */
export function isVariableAccessNode(
  node: SerializedGraph["nodes"][number],
  member: GraphClassMember,
): boolean {
  if (
    node.type !== "variables.get" &&
    node.type !== "variables.set" &&
    node.type !== "variables.getValidated"
  ) {
    return false;
  }
  return node.data.variableId === member.id;
}

function stampVariableTypeOnData(
  data: Record<string, unknown>,
  member: Pick<
    GraphClassMember,
    "typeId" | "typeClassId" | "container" | "keyTypeId" | "keyTypeClassId" | "unit"
  >,
): void {
  data.typeId = member.typeId ?? "float";
  const unit = declaredValueUnit(member.typeId ?? "float", member.unit);
  if (unit) data.unit = unit;
  else delete data.unit;
  if (member.typeClassId) data.typeClassId = member.typeClassId;
  else delete data.typeClassId;
  if (member.container === "array" || member.container === "map") {
    data.container = member.container;
  } else {
    delete data.container;
  }
  if (member.container === "map") {
    data.keyTypeId = member.keyTypeId ?? "string";
    if (member.keyTypeClassId) data.keyTypeClassId = member.keyTypeClassId;
    else delete data.keyTypeClassId;
  } else {
    delete data.keyTypeId;
    delete data.keyTypeClassId;
  }
}

/** Rebind a Get / Set / Validated Get node to `member`: id, name, title, scope and type. */
export function patchVariableAccessNode(
  node: SerializedGraph["nodes"][number],
  member: GraphClassMember,
): SerializedGraph["nodes"][number] {
  const access =
    node.type === "variables.set"
      ? "Set"
      : node.type === "variables.getValidated"
        ? "Validated Get"
        : "Get";
  const nextData: Record<string, unknown> = {
    ...node.data,
    variableId: member.id,
    variableName: member.name,
    title: `${access} ${member.name}`,
    scope: member.functionId ? "local" : (node.data.scope ?? "member"),
  };
  stampVariableTypeOnData(nextData, member);
  if (member.functionId) nextData.functionId = member.functionId;
  delete nextData.__pins;
  return { ...node, data: nextData };
}

export function mapGraphNodes(
  graph: SerializedGraph,
  mapNode: (
    node: SerializedGraph["nodes"][number],
  ) => SerializedGraph["nodes"][number],
): SerializedGraph {
  const functionGraphs = graph.functionGraphs
    ? Object.fromEntries(
        Object.entries(graph.functionGraphs).map(([id, slice]) => [
          id,
          { ...slice, nodes: slice.nodes.map(mapNode) },
        ]),
      )
    : graph.functionGraphs;
  return {
    ...graph,
    nodes: graph.nodes.map(mapNode),
    ...(functionGraphs ? { functionGraphs } : {}),
  };
}

/** Remove matching nodes and their wires from the event graph and every function graph. */
export function dropGraphNodes(
  graph: SerializedGraph,
  drop: (node: SerializedGraph["nodes"][number]) => boolean,
): SerializedGraph {
  const slice = <T extends Pick<SerializedGraph, "nodes" | "edges">>(entry: T): T => {
    const dropIds = new Set(entry.nodes.filter(drop).map((node) => node.id));
    if (dropIds.size === 0) return entry;
    return {
      ...entry,
      nodes: entry.nodes.filter((node) => !dropIds.has(node.id)),
      edges: entry.edges.filter(
        (edge) => !dropIds.has(edge.source) && !dropIds.has(edge.target),
      ),
    };
  };
  const functionGraphs = graph.functionGraphs
    ? Object.fromEntries(
        Object.entries(graph.functionGraphs).map(([id, entry]) => [id, slice(entry)]),
      )
    : graph.functionGraphs;
  return {
    ...slice(graph),
    ...(functionGraphs ? { functionGraphs } : {}),
  };
}

/**
 * A Call Function node bound to this Class's own function `name`. Function
 * Library, parent and other-class Calls of the same name carry that class's id.
 */
export function isOwnFunctionCall(
  node: SerializedGraph["nodes"][number],
  name: string,
  classId: string | undefined,
): boolean {
  if (node.type !== "functions.call" || node.data.functionName !== name) return false;
  const bound = typeof node.data.classId === "string" ? node.data.classId.trim() : "";
  return !bound || bound === classId;
}

export function syncVariableAccessNodes(
  graph: SerializedGraph,
  member: GraphClassMember,
): SerializedGraph {
  return mapGraphNodes(graph, (node) =>
    isVariableAccessNode(node, member)
      ? patchVariableAccessNode(node, member)
      : node,
  );
}

export type VariableAccessKind = "get" | "set" | "validatedGet";

export function isObjectInstanceVariableType(
  typeId: string | undefined,
  container?: string | null,
): boolean {
  if (container === "array" || container === "map") return false;
  return typeId === "object";
}

export type GraphSpawnOptions = {
  position?: { x: number; y: number };
  functionId?: string | null;
  classId?: string;
  implicitSelf?: boolean;
  idFactory?: () => string;
};

function sliceNodeCount(
  graph: SerializedGraph,
  functionId?: string | null,
): number {
  if (functionId) return graph.functionGraphs?.[functionId]?.nodes.length ?? 0;
  return graph.nodes.length;
}

function spawnPosition(
  graph: SerializedGraph,
  options?: GraphSpawnOptions,
): { x: number; y: number } {
  if (options?.position) return options.position;
  return { x: 80, y: 80 + sliceNodeCount(graph, options?.functionId) * 80 };
}

function appendGraphNode(
  graph: SerializedGraph,
  node: {
    id: string;
    type: string;
    position: { x: number; y: number };
    data: Record<string, unknown>;
  },
  functionId?: string | null,
): SerializedGraph {
  if (functionId) {
    const slice = graph.functionGraphs?.[functionId];
    if (!slice) return graph;
    return {
      ...graph,
      functionGraphs: {
        ...graph.functionGraphs,
        [functionId]: { ...slice, nodes: [...slice.nodes, node] },
      },
    };
  }
  return { ...graph, nodes: [...graph.nodes, node] };
}

/** Spawn a bound Get/Set/Validated Get node onto the event graph or a function slice. */
export function addVariableAccessNode(
  graph: SerializedGraph,
  member: GraphClassMember,
  access: VariableAccessKind,
  options?: GraphSpawnOptions,
): SerializedGraph {
  const type =
    access === "set"
      ? "variables.set"
      : access === "validatedGet"
        ? "variables.getValidated"
        : "variables.get";
  const title =
    access === "set"
      ? `Set ${member.name}`
      : access === "validatedGet"
        ? `Validated Get ${member.name}`
        : `Get ${member.name}`;
  const data: Record<string, unknown> = {
    title,
    variableName: member.name,
    variableId: member.id,
    scope: member.functionId ? "local" : "member",
    implicitSelf: options?.implicitSelf ?? true,
    __nodeType: type,
  };
  stampVariableTypeOnData(data, member);
  if (options?.classId) data.classId = options.classId;
  if (member.functionId) data.functionId = member.functionId;
  if (member.componentId) data.componentId = member.componentId;
  if (member.propertyKey) data.propertyKey = member.propertyKey;
  return appendGraphNode(
    graph,
    {
      id: nextId(options?.idFactory),
      type,
      position: spawnPosition(graph, options),
      data,
    },
    options?.functionId,
  );
}

/** Spawn a Call Custom Event node bound to a class event. */
export function addCallEventNode(
  graph: SerializedGraph,
  member: Pick<GraphClassMember, "name" | "pins">,
  options?: GraphSpawnOptions,
): SerializedGraph {
  const type = "flow.event.call";
  const bodyName = formatEventMemberName(member.name);
  const data: Record<string, unknown> = {
    title: `Call ${bodyName}`,
    name: bodyName,
    implicitSelf: options?.implicitSelf ?? true,
    pins: member.pins ?? [],
    __nodeType: type,
  };
  if (options?.classId) data.classId = options.classId;
  return appendGraphNode(
    graph,
    {
      id: nextId(options?.idFactory),
      type,
      position: spawnPosition(graph, options),
      data,
    },
    options?.functionId,
  );
}

/** Spawn a Call Function node bound to a class function. */
export function addCallFunctionNode(
  graph: SerializedGraph,
  member: Pick<GraphClassMember, "name" | "pins" | "runtime">,
  options?: GraphSpawnOptions,
): SerializedGraph {
  const type = "functions.call";
  const data: Record<string, unknown> = {
    title: `Call ${member.name}`,
    functionName: member.name,
    implicitSelf: options?.implicitSelf ?? true,
    pins: member.pins ?? [],
    __nodeType: type,
  };
  if (options?.classId) data.classId = options.classId;
  if (member.runtime) data.runtime = member.runtime;
  return appendGraphNode(
    graph,
    {
      id: nextId(options?.idFactory),
      type,
      position: spawnPosition(graph, options),
      data,
    },
    options?.functionId,
  );
}
