import type {
  GraphClassMember,
  GraphClassMemberPin,
  SerializedGraph,
} from "@haptic/core";
import { NODE_PLACEMENT_GAP, estimateGraphNodeSize } from "@haptic/graph-ui";
import {
  addCallEventNode,
  addCallFunctionNode,
  addVariableAccessNode,
  isObjectInstanceVariableType,
  type GraphSpawnOptions,
  type VariableAccessKind,
} from "./class-member-nodes";
import type { ClassBlueprintMemberKind } from "./class-member-sections";

/** `A`, `A and B`, `A, B and C`. */
export function joinNames(names: readonly string[]): string {
  return names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
    : (names[0] ?? "");
}

/**
 * One sentence for the rows a drop left out, or null when it left out none:
 * rows that are not variables, functions or custom events, and variables the
 * chosen access cannot apply to.
 */
export function droppedRowsNotice(
  unsupported: readonly string[],
  refused: readonly string[] = [],
  access?: VariableAccessKind,
): string | null {
  const sentences = [
    unsupported.length > 0 ? `${joinNames(unsupported)} can't be added to a graph.` : null,
    refused.length > 0
      ? `${joinNames(refused)} can't be added as ${access === "set" ? "Set" : "Validated Get"}.`
      : null,
  ].filter((sentence): sentence is string => sentence !== null);
  return sentences.length > 0 ? sentences.join(" ") : null;
}

export type ClassMemberDropKind = ClassBlueprintMemberKind;

export type ClassMemberDropRow = {
  id: string;
  kind: ClassMemberDropKind;
  name: string;
  eventType?: string;
  inherited?: boolean;
  inheritedFrom?: string;
  pins?: GraphClassMemberPin[];
  /** Variables: the type a row that is not declared on this graph carries. */
  typeId?: string;
  typeClassId?: string;
  componentId?: string;
};

export type GraphDropPoint = {
  containsClientPoint(clientX: number, clientY: number): boolean;
  clientToFlow(clientX: number, clientY: number): { x: number; y: number };
};

export type ClassMemberDropResult =
  | { kind: "ignore" }
  | {
      kind: "choose-access";
      /** Droppable rows, in drop order; the variables among them take the chosen access. */
      memberIds: string[];
      position: { x: number; y: number };
      /** Names of the dragged rows that cannot be dropped on a graph. */
      skipped: string[];
    }
  | { kind: "spawn"; graph: SerializedGraph; skipped: string[] };

/** Whether dragging this member onto a graph spawns a node: variables, functions and custom events. */
export function canDropClassMember(
  row: Pick<ClassMemberDropRow, "kind" | "eventType">,
): boolean {
  return (
    row.kind === "variable" ||
    row.kind === "function" ||
    (row.kind === "event" && row.eventType === "flow.event.custom")
  );
}

/** The variable a dropped row stands for: its declaration on this graph, else what the row carries. */
export function dropVariableBinding(
  graph: SerializedGraph,
  row: ClassMemberDropRow,
): GraphClassMember {
  return (
    (graph.members ?? []).find(
      (entry) => entry.id === row.id && entry.kind === "variable",
    ) ?? {
      id: row.id,
      kind: "variable",
      name: row.name,
      typeId: row.typeId ?? "float",
      ...(row.typeClassId ? { typeClassId: row.typeClassId } : {}),
      ...(row.componentId ? { componentId: row.componentId } : {}),
    }
  );
}

/** Component variables are read-only, and only single Object / Actor variables validate. */
export function variableAccessAllowed(
  variable: Pick<GraphClassMember, "typeId" | "container" | "componentId">,
  access: VariableAccessKind,
): boolean {
  if (access === "set") return !variable.componentId;
  if (access === "validatedGet") {
    return isObjectInstanceVariableType(variable.typeId, variable.container);
  }
  return true;
}

/** A Get node is a compact pill; every other node is as tall as its pin rows. */
const GET_PILL_HEIGHT = 56;

function dropNodeHeight(
  access: VariableAccessKind | null,
  pins: ReadonlyArray<{ direction?: string }> | undefined,
): number {
  if (access === "get") return GET_PILL_HEIGHT;
  const rows =
    access === "set"
      ? [{ direction: "in" }, { direction: "in" }, { direction: "out" }, { direction: "out" }]
      : access === "validatedGet"
        ? [{ direction: "in" }, { direction: "out" }, { direction: "out" }, { direction: "out" }]
        : // exec in / out plus the Target (Self) input of a member Call.
          [{ direction: "in" }, ...(pins ?? [])];
  return estimateGraphNodeSize(rows).height;
}

/**
 * Spawn one node per dropped row onto the event graph or the open function,
 * stacked downwards from `position` as one graph change. A variable takes
 * `access`; one that cannot (Set on a component, Validated Get on a value
 * type) is reported by name instead of placed.
 */
export function placeClassMemberDrop(options: {
  graph: SerializedGraph;
  rows: readonly ClassMemberDropRow[];
  position: { x: number; y: number };
  access?: VariableAccessKind;
  functionId?: string | null;
  classId?: string;
  idFactory?: () => string;
}): { graph: SerializedGraph; skipped: string[] } {
  let graph = options.graph;
  let y = options.position.y;
  const skipped: string[] = [];
  for (const row of options.rows) {
    const spawn: GraphSpawnOptions = {
      position: { x: options.position.x, y },
      functionId: options.functionId,
      classId: row.inheritedFrom ?? options.classId,
      idFactory: options.idFactory,
    };
    let height: number;
    if (row.kind === "variable") {
      const binding = dropVariableBinding(graph, row);
      const access = options.access ?? "get";
      if (!variableAccessAllowed(binding, access)) {
        skipped.push(row.name);
        continue;
      }
      graph = addVariableAccessNode(graph, binding, access, spawn);
      height = dropNodeHeight(access, undefined);
    } else if (row.kind === "function") {
      const declared = (graph.members ?? []).find(
        (entry) => entry.kind === "function" && (entry.id === row.id || entry.name === row.name),
      );
      graph = addCallFunctionNode(graph, declared ?? row, spawn);
      height = dropNodeHeight(null, (declared ?? row).pins);
    } else if (canDropClassMember(row)) {
      const declared = (graph.members ?? []).find(
        (entry) => entry.kind === "event" && (entry.id === row.id || entry.name === row.name),
      );
      graph = addCallEventNode(graph, declared ?? row, spawn);
      height = dropNodeHeight(null, (declared ?? row).pins);
    } else {
      skipped.push(row.name);
      continue;
    }
    y += height + NODE_PLACEMENT_GAP;
  }
  return { graph, skipped };
}

function dropRows(
  members: readonly ClassMemberDropRow[],
  memberIds: readonly string[],
): { droppable: ClassMemberDropRow[]; skipped: string[] } {
  const byId = new Map(members.map((row) => [row.id, row]));
  const droppable: ClassMemberDropRow[] = [];
  const skipped: string[] = [];
  for (const id of new Set(memberIds)) {
    const row = id.startsWith("section-") ? undefined : byId.get(id);
    if (!row) continue;
    if (canDropClassMember(row)) droppable.push(row);
    else skipped.push(row.name);
  }
  return { droppable, skipped };
}

/**
 * Decide what dropping Class tree rows on the graph does: a function or custom
 * event spawns its Call node at once, a variable asks Get / Set first. Several
 * rows land in one stack from the drop point; rows that cannot drop are skipped.
 */
export function resolveClassMemberDrop(options: {
  graph: SerializedGraph;
  memberIds: readonly string[];
  members: readonly ClassMemberDropRow[];
  clientX: number;
  clientY: number;
  canvas: GraphDropPoint | null;
  functionId?: string | null;
  classId?: string;
  idFactory?: () => string;
}): ClassMemberDropResult {
  if (
    !options.canvas?.containsClientPoint(options.clientX, options.clientY)
  ) {
    return { kind: "ignore" };
  }
  const { droppable, skipped } = dropRows(options.members, options.memberIds);
  if (droppable.length === 0) return { kind: "ignore" };
  const position = options.canvas.clientToFlow(
    options.clientX,
    options.clientY,
  );
  if (droppable.some((row) => row.kind === "variable")) {
    return {
      kind: "choose-access",
      memberIds: droppable.map((row) => row.id),
      position,
      skipped,
    };
  }
  const placed = placeClassMemberDrop({ ...options, rows: droppable, position });
  return { kind: "spawn", graph: placed.graph, skipped };
}

/** Finish a drop that asked Get / Set first: place every row with the chosen `access`. */
export function completeClassMemberDrop(options: {
  graph: SerializedGraph;
  memberIds: readonly string[];
  members: readonly ClassMemberDropRow[];
  position: { x: number; y: number };
  access: VariableAccessKind;
  functionId?: string | null;
  classId?: string;
  idFactory?: () => string;
}): { graph: SerializedGraph; skipped: string[] } {
  const { droppable } = dropRows(options.members, options.memberIds);
  return placeClassMemberDrop({ ...options, rows: droppable });
}
