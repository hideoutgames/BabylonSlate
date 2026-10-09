import type {
  GraphClassMember,
  GraphClassMemberPin,
  SerializedComponent,
  SerializedGraph,
} from "@babylonslate/core";

/**
 * Deterministic SerializedGraph builders for FeatureTest Classes. Edge handles
 * are pin ids (not display names): an unknown handle is silently dropped by
 * graph materialization, so validate scaffolded graphs in tests.
 */

export type GraphNode = SerializedGraph["nodes"][number];
export type GraphEdge = SerializedGraph["edges"][number];

/** Node with registry `type`; pin literals go in `data` as `default:<pinId>`. Never stores `__pins`. */
export function gNode(
  id: string,
  type: string,
  x: number,
  y: number,
  data: Record<string, unknown> = {},
): GraphNode {
  return { id, type, position: { x, y }, data: { ...data, __nodeType: type } };
}

/** Data or exec wire between pin ids. */
export function gWire(source: string, sourceHandle: string, target: string, targetHandle: string): GraphEdge {
  return {
    id: `e:${source}:${sourceHandle}:${target}:${targetHandle}`,
    source,
    sourceHandle,
    target,
    targetHandle,
  };
}

/** Exec wire; most exec nodes use `execOut` → `execIn`. */
export function gExec(from: string, to: string, fromPin = "execOut", toPin = "execIn"): GraphEdge {
  return gWire(from, fromPin, to, toPin);
}

/** Chain exec nodes in order (`execOut` → `execIn`). */
export function gChain(...ids: string[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (let index = 1; index < ids.length; index += 1) edges.push(gExec(ids[index - 1]!, ids[index]!));
  return edges;
}

export const EXEC_IN: GraphClassMemberPin = { name: "exec", typeId: "exec", direction: "in" };
export const EXEC_OUT: GraphClassMemberPin = { name: "then", typeId: "exec", direction: "out" };

/** Variable member. */
export function varMember(
  id: string,
  name: string,
  typeId: string,
  defaultValue?: unknown,
  extras: Partial<GraphClassMember> = {},
): GraphClassMember {
  return {
    id,
    kind: "variable",
    name,
    typeId,
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    ...extras,
  };
}

/** Function member with the default exec rows (Call Function then uses `exec` / `then`). */
export function fnMember(
  id: string,
  name: string,
  data: GraphClassMemberPin[] = [],
  extras: Partial<GraphClassMember> = {},
): GraphClassMember {
  return { id, kind: "function", name, pins: [EXEC_IN, EXEC_OUT, ...data], ...extras };
}

/**
 * Function body with protected Input / Output nodes. Input exposes `exec` and
 * each `in` row; Output takes `then` and each `out` row.
 */
export function fnGraph(
  member: GraphClassMember,
  body: { nodes?: GraphNode[]; edges?: GraphEdge[] } = {},
  wireExec = true,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const input = gNode(`${member.id}-input`, "flow.function.input", 80, 120, {
    title: "Input",
    __protected: true,
    pins: member.pins,
  });
  const output = gNode(`${member.id}-output`, "flow.function.output", 760, 120, {
    title: "Output",
    __protected: true,
    pins: member.pins,
  });
  return {
    nodes: [input, output, ...(body.nodes ?? [])],
    edges: [...(wireExec ? [gWire(input.id, "exec", output.id, "then")] : []), ...(body.edges ?? [])],
  };
}

/** Member Get Variable with implicit self. */
export function getVar(id: string, member: GraphClassMember, x: number, y: number): GraphNode {
  return gNode(id, "variables.get", x, y, {
    variableName: member.name,
    variableId: member.id,
    scope: "member",
    implicitSelf: true,
    typeId: member.typeId ?? "float",
    ...(member.typeClassId ? { typeClassId: member.typeClassId } : {}),
  });
}

/** Member Set Variable with implicit self; `value` becomes the pin literal. */
export function setVar(id: string, member: GraphClassMember, x: number, y: number, value?: unknown): GraphNode {
  return gNode(id, "variables.set", x, y, {
    variableName: member.name,
    variableId: member.id,
    scope: "member",
    implicitSelf: true,
    typeId: member.typeId ?? "float",
    ...(member.typeClassId ? { typeClassId: member.typeClassId } : {}),
    ...(value !== undefined ? { "default:value": value } : {}),
  });
}

/** Print String (development only unless `keepInExport`). */
export function printString(id: string, x: number, y: number, text: string, keepInExport = false): GraphNode {
  return gNode(id, "debug.printString", x, y, {
    "default:inString": text,
    ...(keepInExport ? { developmentOnly: false } : {}),
  });
}

/** Assemble a Class document graph. */
export function classGraph(parts: {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  members?: GraphClassMember[];
  components?: SerializedComponent[];
  functionGraphs?: SerializedGraph["functionGraphs"];
  actorDefaults?: SerializedGraph["actorDefaults"];
}): SerializedGraph {
  return {
    nodes: parts.nodes ?? [],
    edges: parts.edges ?? [],
    members: parts.members ?? [],
    ...(parts.components ? { components: parts.components } : {}),
    ...(parts.functionGraphs ? { functionGraphs: parts.functionGraphs } : {}),
    ...(parts.actorDefaults ? { actorDefaults: parts.actorDefaults } : {}),
  };
}
