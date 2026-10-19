import type {
  GraphClassMember,
  GraphClassMemberPin,
  SerializedGraph,
} from "@babylonslate/core";
import { nextCopyName } from "@babylonslate/assets";
import {
  engineParentOf,
  formatEventMemberName,
  formatEventTitle,
  walkAncestry,
} from "@babylonslate/editor-kit";
import {
  NODE_PLACEMENT_GAP,
  estimateGraphNodeSize,
  graphNodesBounds,
} from "@babylonslate/graph-ui";
import { singletonEventKey } from "@babylonslate/scripting";
import {
  canRenameCustomEvent,
  classAllowsMemberKind,
  isScriptCatalogNodeAllowed,
  joinNames,
  nativeEventTitle,
  patchVariableAccessNode,
  seedFunctionGraph,
  type ClassEventOptions,
} from "./class-members";
import { eventNameKeys } from "./graph-paste";
import { customEventsFromGraph } from "./overridable-functions";

type GraphNode = SerializedGraph["nodes"][number];
type GraphEdge = SerializedGraph["edges"][number];

const CUSTOM_EVENT = "flow.event.custom";
const FUNCTION_INPUT = "flow.function.input";
const FUNCTION_OUTPUT = "flow.function.output";

/** A copied variable with its full definition. */
export type ClipboardVariable = {
  member: GraphClassMember;
  /** The Class whose names its function bodies were written against. */
  sourceClassId?: string;
};

/** A copied function: signature, local variables and the whole function graph. */
export type ClipboardFunction = {
  member: GraphClassMember;
  locals: GraphClassMember[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  sourceClassId?: string;
};

/** A copied event: the event node alone, never the nodes it runs. */
export type ClipboardEvent = {
  node: GraphNode;
  /** A custom event the Class does not own (an override, a component event) keeps its binding. */
  bound: boolean;
  sourceClassId?: string;
};

/** Snapshot of Class members that survives switching between Class assets. */
export type ClassMemberClipboard = {
  variables: ClipboardVariable[];
  functions: ClipboardFunction[];
  events: ClipboardEvent[];
};

/** A Class tree row, as far as Copy needs to know it. */
export type ClassMemberCopyRow = {
  id: string;
  kind: GraphClassMember["kind"];
  name: string;
  inheritedFrom?: string;
  componentId?: string;
  functionId?: string;
};

export type ClassMemberCopySource = {
  graph: SerializedGraph;
  classId?: string;
  /** Class graphs by class id, where rows inherited from a parent are read. */
  parentGraphs?: Record<string, SerializedGraph>;
};

function collectClassMembers(
  rows: readonly ClassMemberCopyRow[],
  source: ClassMemberCopySource,
): ClassMemberClipboard | null {
  if (rows.length === 0) return null;
  const clip: ClassMemberClipboard = { variables: [], functions: [], events: [] };
  for (const row of rows) {
    if (row.kind === "interface" || row.componentId || row.functionId) return null;
    const owner = row.inheritedFrom ? source.parentGraphs?.[row.inheritedFrom] : source.graph;
    const sourceClassId = row.inheritedFrom ?? source.classId;
    if (!owner) return null;
    if (row.kind === "event") {
      if (row.inheritedFrom) return null;
      const node = owner.nodes.find((entry) => entry.id === row.id);
      if (!node) return null;
      clip.events.push({
        node,
        bound: node.type === CUSTOM_EVENT && !canRenameCustomEvent(owner, node.id),
        ...(sourceClassId ? { sourceClassId } : {}),
      });
      continue;
    }
    // A row inherited from a parent is told apart by name; its id is a stub.
    const member = (owner.members ?? []).find((entry) =>
      entry.kind === row.kind &&
      !entry.functionId &&
      (row.inheritedFrom ? entry.name === row.name : entry.id === row.id),
    );
    if (!member) return null;
    if (row.kind === "variable") {
      clip.variables.push({ member, ...(sourceClassId ? { sourceClassId } : {}) });
      continue;
    }
    const slice = owner.functionGraphs?.[member.id];
    clip.functions.push({
      member,
      locals: (owner.members ?? []).filter(
        (entry) => entry.kind === "variable" && entry.functionId === member.id,
      ),
      nodes: slice?.nodes ?? [],
      edges: slice?.edges ?? [],
      ...(sourceClassId ? { sourceClassId } : {}),
    });
  }
  return clip;
}

/**
 * Whether Copy applies to the selected rows: at least one, and only
 * variables, functions and events. A Script Interface, a component, a local
 * variable (it travels with its function) or a row whose source is gone rules
 * it out.
 */
export function canCopyClassMembers(
  rows: readonly ClassMemberCopyRow[],
  source: ClassMemberCopySource,
): boolean {
  return collectClassMembers(rows, source) !== null;
}

/**
 * Snapshot the selected rows (see `canCopyClassMembers`), or null. Rows come
 * in tree order; so do the members of the snapshot.
 */
export function copyClassMembers(
  rows: readonly ClassMemberCopyRow[],
  source: ClassMemberCopySource,
): ClassMemberClipboard | null {
  const clip = collectClassMembers(rows, source);
  return clip ? structuredClone(clip) : null;
}

/** The parent Classes whose graphs are known, nearest first. */
export function classAncestorGraphs(options: {
  parentClass?: string | null;
  parentOf?: (id: string) => string | null | undefined;
  parentGraphs?: Record<string, SerializedGraph>;
}): Array<{ classId: string; graph: SerializedGraph }> {
  const parentOf = options.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
  return walkAncestry(options.parentClass ?? null, parentOf).flatMap((classId) => {
    const graph = options.parentGraphs?.[classId];
    return graph ? [{ classId, graph }] : [];
  });
}

export type ClassMemberPasteOptions = {
  graph: SerializedGraph;
  clipboard: ClassMemberClipboard;
  /** The target Class's id; its own Call nodes carry it. */
  classId?: string;
  /** Every name the target lists per kind: its own, inherited, component and local rows. */
  takenNames: { variable: readonly string[]; function: readonly string[] };
  /** Parent Classes, nearest first: where inherited members and events come from. */
  ancestors?: ReadonlyArray<{ classId: string; graph: SerializedGraph }>;
  /** Parent and asset type of the target, which decide the events it can have. */
  eventOptions?: ClassEventOptions;
  /** Components of the target, for events bound to one. */
  componentIds?: ReadonlySet<string>;
  idFactory?: () => string;
};

export type PastedClassMember = {
  kind: "variable" | "function" | "event";
  id: string;
  name: string;
};

export type SkippedClassMember = {
  kind: "variable" | "function" | "event";
  name: string;
  /** `kind`: the Class cannot have that member. `unavailable`: the Class lacks what it needs. `present`: it already has it. */
  reason: "kind" | "unavailable" | "present";
};

export type ClassMemberPasteResult = {
  graph: SerializedGraph;
  pasted: PastedClassMember[];
  skipped: SkippedClassMember[];
};

type TargetMember = { member: GraphClassMember; classId?: string };
type TargetEvent = { name: string; pins: GraphClassMemberPin[]; classId?: string };

/** `Source Class + name` keys a member of the paste by what its function bodies call it. */
function nameKey(classId: string | undefined, name: string): string {
  return `${classId ?? ""}\0${name}`;
}

function typeKey(spec: {
  typeId?: unknown;
  typeClassId?: unknown;
  container?: unknown;
  keyTypeId?: unknown;
  keyTypeClassId?: unknown;
}): string {
  const container = spec.container === "array" || spec.container === "map" ? spec.container : "single";
  return [
    spec.typeId ?? "float",
    spec.typeClassId ?? "",
    container,
    container === "map" ? (spec.keyTypeId ?? "string") : "",
    container === "map" ? (spec.keyTypeClassId ?? "") : "",
  ].join("\0");
}

/** The data pins of a signature, whatever their order; exec pins are not part of the type. */
function signatureKey(pins: unknown): string {
  if (!Array.isArray(pins)) return "";
  return (pins as GraphClassMemberPin[])
    .filter((pin) => pin && pin.typeId !== "exec")
    .map((pin) => [
      pin.direction,
      pin.name,
      pin.container === "array" || pin.container === "map" ? pin.container : "single",
      pin.typeId,
      pin.typeClassId ?? "",
    ].join(":"))
    .sort()
    .join("|");
}

function eventKey(node: Pick<GraphNode, "type" | "data">): string | undefined {
  return singletonEventKey({ typeId: node.type, properties: node.data }, false);
}

function customEventName(node: Pick<GraphNode, "data">): string {
  return formatEventMemberName(String(node.data.name ?? node.data.title ?? ""));
}

/** `Event Begin Play` → `Begin Play`; a component qualifier is not part of the name. */
function nativeEventBaseName(node: Pick<GraphNode, "type" | "data">): string {
  const title =
    typeof node.data.title === "string" && node.data.title
      ? node.data.title
      : nativeEventTitle(node.type);
  return formatEventMemberName(title).replace(/\s*\([^)]*\)\s*$/, "").trim() || "Event";
}

function eventTitleForNotice(node: Pick<GraphNode, "type" | "data">): string {
  return node.type === CUSTOM_EVENT
    ? customEventName(node)
    : formatEventTitle(nativeEventBaseName(node));
}

/** A name that is not taken: unchanged when free, else the repo's duplicate naming (`Name_1`). */
function uniqueName(name: string, taken: Set<string>): string {
  const unique = taken.has(name) ? nextCopyName(name, [...taken]) : name;
  taken.add(unique);
  return unique;
}

/**
 * Events show a copy index as a space (`Open Door 1`) where a variable keeps
 * the underscore, and are unique across case and compiled identifier.
 */
function uniqueEventName(name: string, taken: ReadonlySet<string>): string {
  const base = formatEventMemberName(name);
  const isTaken = (candidate: string) =>
    eventNameKeys({ name: candidate }).some((key) => taken.has(key));
  if (!isTaken(base)) return base;
  const stored = base.replace(/ (\d+)$/, "_$1");
  const used = [stored];
  for (;;) {
    const raw = nextCopyName(stored, used);
    const candidate = formatEventMemberName(raw);
    if (!isTaken(candidate)) return candidate;
    used.push(raw);
  }
}

function withClassId(node: GraphNode, classId: string | undefined): GraphNode {
  const data = { ...node.data };
  if (classId) data.classId = classId;
  else delete data.classId;
  return { ...node, data };
}

type FunctionPaste = {
  source: ClipboardFunction;
  member: GraphClassMember;
  /** Source local id → its copy. */
  locals: Map<string, GraphClassMember>;
};

type ReferenceTargets = {
  classId?: string;
  pastedVariablesById: Map<string, GraphClassMember>;
  pastedVariablesByName: Map<string, GraphClassMember>;
  pastedFunctionsByName: Map<string, GraphClassMember>;
  pastedEventsByName: Map<string, { name: string; classId?: string }>;
  variables: TargetMember[];
  functions: TargetMember[];
  events: TargetEvent[];
};

/**
 * Point a node of a pasted function body at the member it meant, in the order
 * of the paste: the copy that came with it, then the target Class's member of
 * the same name and type. Anything else is left as it was, so validation
 * reports it; no member is created. Only references to the running object
 * qualify; a node that wires in its target object keeps its binding.
 */
function remapReferences(node: GraphNode, fn: FunctionPaste, refs: ReferenceTargets): GraphNode {
  const data = node.data;
  const sourceClassId = fn.source.sourceClassId;
  const isSelf = data.implicitSelf !== false && !data.componentId;
  const isOwn = !data.classId || data.classId === sourceClassId;
  switch (node.type) {
    case "variables.get":
    case "variables.set":
    case "variables.getValidated": {
      if (data.scope === "local" || typeof data.functionId === "string") {
        const local =
          fn.locals.get(String(data.variableId)) ??
          [...fn.locals.values()].find((entry) => entry.name === data.variableName);
        return local ? patchVariableAccessNode(node, local) : node;
      }
      if (!isSelf || data.propertyKey) return node;
      const pasted = isOwn
        ? (refs.pastedVariablesById.get(String(data.variableId)) ??
          refs.pastedVariablesByName.get(nameKey(sourceClassId, String(data.variableName))))
        : undefined;
      if (pasted) return withClassId(patchVariableAccessNode(node, pasted), refs.classId);
      const type = typeKey(data);
      const found = refs.variables.find(
        (entry) => entry.member.name === data.variableName && typeKey(entry.member) === type,
      );
      return found ? withClassId(patchVariableAccessNode(node, found.member), found.classId) : node;
    }
    case "functions.call": {
      if (!isSelf || data.runtime) return node;
      const name = String(data.functionName);
      const pasted = isOwn ? refs.pastedFunctionsByName.get(nameKey(sourceClassId, name)) : undefined;
      if (pasted) {
        return withClassId(
          { ...node, data: { ...data, functionName: pasted.name, title: `Call ${pasted.name}` } },
          refs.classId,
        );
      }
      const signature = signatureKey(data.pins);
      const found = refs.functions.find(
        (entry) => entry.member.name === name && signatureKey(entry.member.pins) === signature,
      );
      return found ? withClassId(node, found.classId) : node;
    }
    case "flow.event.call": {
      if (!isSelf) return node;
      const name = formatEventMemberName(String(data.name ?? ""));
      const pasted = isOwn ? refs.pastedEventsByName.get(nameKey(sourceClassId, name)) : undefined;
      if (pasted) {
        return withClassId(
          { ...node, data: { ...data, name: pasted.name, title: `Call ${pasted.name}` } },
          refs.classId,
        );
      }
      const signature = signatureKey(data.pins);
      const found = refs.events.find(
        (entry) => entry.name === name && signatureKey(entry.pins) === signature,
      );
      return found ? withClassId(node, found.classId) : node;
    }
    default:
      return node;
  }
}

/** The function graph of a copy: fresh ids, wires kept, references remapped. */
function pastedFunctionGraph(
  fn: FunctionPaste,
  refs: ReferenceTargets,
  newId: () => string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (fn.source.nodes.length === 0) return seedFunctionGraph(fn.member);
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const node of fn.source.nodes) {
    const conventional =
      node.type === FUNCTION_INPUT
        ? `${fn.member.id}-input`
        : node.type === FUNCTION_OUTPUT
          ? `${fn.member.id}-output`
          : undefined;
    const id = conventional && !used.has(conventional) ? conventional : newId();
    used.add(id);
    ids.set(node.id, id);
  }
  const nodes = fn.source.nodes.map((node) =>
    remapReferences({ ...node, id: ids.get(node.id)! }, fn, refs),
  );
  const edges = fn.source.edges.flatMap((edge) => {
    const source = ids.get(edge.source);
    const target = ids.get(edge.target);
    if (!source || !target) return [];
    return [{
      ...edge,
      id: `e:${source}:${edge.sourceHandle ?? ""}:${target}:${edge.targetHandle ?? ""}`,
      source,
      target,
    }];
  });
  return { nodes, edges };
}

/** Members a graph declares directly: not a function's locals, not a component's virtual variable. */
function declaredMembers(graph: SerializedGraph | undefined, kind: GraphClassMember["kind"]): GraphClassMember[] {
  return (graph?.members ?? []).filter(
    (member) => member.kind === kind && !member.functionId && !member.componentId,
  );
}

/**
 * Paste the snapshot into a Class as duplicates, in one graph change.
 *
 * - Variables, functions (and their locals) and custom events take a free
 *   name when theirs is taken, by the repo's duplicate naming.
 * - Function bodies are copied with fresh node ids and their references
 *   remapped (see `remapReferences`); a function's interface and override
 *   bindings stay with the original.
 * - Events go into the event graph below the existing nodes. A native event
 *   the target does not have, authored or inherited, is pasted as that
 *   event; one it has becomes a custom event named like a duplicate (`Begin Play 1`).
 */
export function pasteClassMembers(options: ClassMemberPasteOptions): ClassMemberPasteResult {
  const { clipboard, classId } = options;
  const newId = options.idFactory ?? (() => crypto.randomUUID());
  const ancestors = options.ancestors ?? [];
  const added: GraphClassMember[] = [];
  const pasted: PastedClassMember[] = [];
  const skipped: SkippedClassMember[] = [];

  const takenVariables = new Set(options.takenNames.variable);
  const takenFunctions = new Set(options.takenNames.function);
  for (const member of options.graph.members ?? []) {
    if (member.kind === "variable") takenVariables.add(member.name);
    else if (member.kind === "function") takenFunctions.add(member.name);
  }

  const refs: ReferenceTargets = {
    classId,
    pastedVariablesById: new Map(),
    pastedVariablesByName: new Map(),
    pastedFunctionsByName: new Map(),
    pastedEventsByName: new Map(),
    variables: [
      ...declaredMembers(options.graph, "variable").map((member) => ({ member, classId })),
      ...ancestors.flatMap((ancestor) =>
        declaredMembers(ancestor.graph, "variable").map((member) => ({ member, classId: ancestor.classId })),
      ),
    ],
    functions: [
      ...declaredMembers(options.graph, "function").map((member) => ({ member, classId })),
      ...ancestors.flatMap((ancestor) =>
        declaredMembers(ancestor.graph, "function").map((member) => ({ member, classId: ancestor.classId })),
      ),
    ],
    events: [
      ...customEventsFromGraph(options.graph).map((event) => ({ ...event, classId })),
      ...ancestors.flatMap((ancestor) =>
        customEventsFromGraph(ancestor.graph).map((event) => ({ ...event, classId: ancestor.classId })),
      ),
    ],
  };

  if (clipboard.variables.length > 0 && !classAllowsMemberKind("variable", options.eventOptions)) {
    for (const entry of clipboard.variables) {
      skipped.push({ kind: "variable", name: entry.member.name, reason: "kind" });
    }
  } else {
    for (const entry of clipboard.variables) {
      const copy: GraphClassMember = {
        ...structuredClone(entry.member),
        id: newId(),
        name: uniqueName(entry.member.name, takenVariables),
      };
      delete copy.functionId;
      added.push(copy);
      refs.pastedVariablesById.set(entry.member.id, copy);
      refs.pastedVariablesByName.set(nameKey(entry.sourceClassId, entry.member.name), copy);
      pasted.push({ kind: "variable", id: copy.id, name: copy.name });
    }
  }

  const functions: FunctionPaste[] = [];
  for (const entry of clipboard.functions) {
    const member: GraphClassMember = {
      ...structuredClone(entry.member),
      id: newId(),
      name: uniqueName(entry.member.name, takenFunctions),
    };
    // The original keeps the interface it implements and the function it overrides.
    delete member.implementsInterface;
    delete member.overrides;
    const locals = new Map<string, GraphClassMember>();
    for (const local of entry.locals) {
      locals.set(local.id, {
        ...structuredClone(local),
        id: newId(),
        name: uniqueName(local.name, takenVariables),
        functionId: member.id,
      });
    }
    functions.push({ source: entry, member, locals });
    refs.pastedFunctionsByName.set(nameKey(entry.sourceClassId, entry.member.name), member);
    pasted.push({ kind: "function", id: member.id, name: member.name });
  }

  // Events: names and nodes first, so function bodies can call the copies.
  const eventNodes: GraphNode[] = [];
  const eventsAllowed = classAllowsMemberKind("event", options.eventOptions);
  const presentEvents = new Set<string>();
  const takenEvents = new Set<string>();
  const claimEvent = (name: string) => {
    for (const key of eventNameKeys({ name })) takenEvents.add(key);
  };
  for (const node of options.graph.nodes) {
    const key = eventKey(node);
    if (key !== undefined) presentEvents.add(key);
  }
  const inheritedEvents = new Set<string>();
  for (const ancestor of ancestors) {
    for (const node of ancestor.graph.nodes) {
      const key = eventKey(node);
      if (key !== undefined) inheritedEvents.add(key);
    }
    for (const event of customEventsFromGraph(ancestor.graph)) {
      claimEvent(event.name);
      inheritedEvents.add(`${CUSTOM_EVENT}\0${event.name}`);
    }
  }
  for (const event of customEventsFromGraph(options.graph)) claimEvent(event.name);
  for (const slice of Object.values(options.graph.functionGraphs ?? {})) {
    for (const node of slice.nodes) {
      if (node.type === CUSTOM_EVENT) claimEvent(customEventName(node));
    }
  }

  const bounds = graphNodesBounds(options.graph.nodes);
  const cursor = bounds
    ? { x: bounds.x, y: bounds.y + bounds.height + NODE_PLACEMENT_GAP }
    : { x: 80, y: 80 };
  const placeEvent = (node: GraphNode, pins: ReadonlyArray<{ direction?: string }>): GraphNode => {
    const placed = { ...node, id: newId(), position: { x: cursor.x, y: cursor.y } };
    cursor.y += estimateGraphNodeSize([{ direction: "out" }, ...pins]).height + NODE_PLACEMENT_GAP;
    eventNodes.push(placed);
    return placed;
  };
  const customEvent = (name: string, pins: GraphClassMemberPin[]): void => {
    const node = placeEvent(
      {
        id: "",
        type: CUSTOM_EVENT,
        position: { x: 0, y: 0 },
        data: { title: formatEventTitle(name), name, pins, __nodeType: CUSTOM_EVENT },
      },
      pins,
    );
    claimEvent(name);
    added.push({ id: node.id, kind: "event", name, pins });
    pasted.push({ kind: "event", id: node.id, name });
  };

  for (const entry of clipboard.events) {
    const source = structuredClone(entry.node);
    const title = eventTitleForNotice(source);
    if (!eventsAllowed) {
      skipped.push({ kind: "event", name: title, reason: "kind" });
      continue;
    }
    if (source.type === CUSTOM_EVENT) {
      const pins = Array.isArray(source.data.pins) ? (source.data.pins as GraphClassMemberPin[]) : [];
      if (!entry.bound) {
        const name = uniqueEventName(customEventName(source), takenEvents);
        customEvent(name, pins);
        refs.pastedEventsByName.set(nameKey(entry.sourceClassId, customEventName(source)), {
          name,
          classId,
        });
        continue;
      }
      const key = eventKey(source);
      if (key !== undefined && presentEvents.has(key)) {
        skipped.push({ kind: "event", name: title, reason: "present" });
      } else if (
        (typeof source.data.componentId === "string" && !options.componentIds?.has(source.data.componentId)) ||
        (source.data.eventQualifier === "Inherited" && !inheritedEvents.has(`${CUSTOM_EVENT}\0${customEventName(source)}`))
      ) {
        skipped.push({ kind: "event", name: title, reason: "unavailable" });
      } else {
        if (key !== undefined) presentEvents.add(key);
        const node = placeEvent(source, pins);
        pasted.push({ kind: "event", id: node.id, name: customEventName(source) });
      }
      continue;
    }
    if (!isScriptCatalogNodeAllowed(source.type, options.eventOptions)) {
      skipped.push({ kind: "event", name: title, reason: "unavailable" });
      continue;
    }
    if (typeof source.data.componentId === "string" && !options.componentIds?.has(source.data.componentId)) {
      skipped.push({ kind: "event", name: title, reason: "unavailable" });
      continue;
    }
    const key = eventKey(source);
    if (key !== undefined && (presentEvents.has(key) || inheritedEvents.has(key))) {
      // The native event holds its own name, so its copy is the first duplicate of it.
      const base = nativeEventBaseName(source);
      customEvent(uniqueEventName(base, new Set([...takenEvents, ...eventNameKeys({ name: base })])), []);
      continue;
    }
    if (key !== undefined) presentEvents.add(key);
    const node = placeEvent(source, []);
    pasted.push({ kind: "event", id: node.id, name: title });
  }

  const functionGraphs: NonNullable<SerializedGraph["functionGraphs"]> = {};
  for (const fn of functions) {
    added.push(fn.member, ...fn.locals.values());
    functionGraphs[fn.member.id] = pastedFunctionGraph(fn, refs, newId);
  }

  if (pasted.length === 0) return { graph: options.graph, pasted, skipped };
  return {
    graph: {
      ...options.graph,
      members: [...(options.graph.members ?? []), ...added],
      nodes: [...options.graph.nodes, ...eventNodes],
      ...(functions.length > 0
        ? { functionGraphs: { ...options.graph.functionGraphs, ...functionGraphs } }
        : {}),
    },
    pasted,
    skipped,
  };
}

/** One sentence per reason for the members a paste left out, or null when it left out none. */
export function skippedMembersNotice(skipped: readonly SkippedClassMember[]): string | null {
  const sentences: string[] = [];
  const reasons: Array<[SkippedClassMember["reason"], (plural: boolean) => string]> = [
    ["kind", () => "can't be added to this Class."],
    ["unavailable", (plural) => `${plural ? "aren't" : "isn't"} available in this Class.`],
    ["present", (plural) => `${plural ? "are" : "is"} already in this graph.`],
  ];
  for (const [reason, tail] of reasons) {
    const names = skipped.filter((entry) => entry.reason === reason).map((entry) => entry.name);
    if (names.length > 0) sentences.push(`${joinNames(names)} ${tail(names.length > 1)}`);
  }
  return sentences.length > 0 ? sentences.join(" ") : null;
}
