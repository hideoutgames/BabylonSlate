import type {
  GraphClassMember,
  GraphClassMemberPin,
  SerializedGraph,
} from "@babylonslate/core";
import { userInterfaceClassId } from "@babylonslate/core";
import { engineParentOf, formatEventMemberName, walkAncestry } from "@babylonslate/editor-kit";
import {
  DEFAULT_FUNCTION_PINS,
  nativeEventStubs,
  nativeEventTitle,
  WIDGET_POINTER_EVENT_TYPE_IDS,
} from "./class-members";

export type OverridableFunctionKind = "interface" | "function";

export type OverridableFunctionRow = {
  id: string;
  kind: OverridableFunctionKind;
  name: string;
  description: string;
  overwritten: boolean;
  pins: GraphClassMemberPin[];
  implementsInterface?: { assetGuid: string; methodName: string };
  overrides?: { classId: string; name: string };
};

export type ScriptInterfaceCatalogEntry = {
  guid: string;
  name: string;
  methods: Array<{ name: string; pins?: GraphClassMemberPin[] }>;
};

function parentLookup(
  parentOf?: (id: string) => string | null | undefined,
): (id: string) => string | null | undefined {
  return parentOf ?? ((id: string) => engineParentOf(id) ?? null);
}

function localFunctionNames(graph?: SerializedGraph): Set<string> {
  const names = new Set<string>();
  for (const member of graph?.members ?? []) {
    if (member.kind === "function" && member.name) names.add(member.name);
  }
  return names;
}

function interfaceMembersFromGraphs(
  classId: string | undefined,
  graph: SerializedGraph | undefined,
  parentGraphs: Record<string, SerializedGraph> | undefined,
  parentOf: (id: string) => string | null | undefined,
): GraphClassMember[] {
  const members: GraphClassMember[] = [];
  const seen = new Set<string>();
  const push = (list: GraphClassMember[] | undefined) => {
    for (const member of list ?? []) {
      if (member.kind !== "interface" || !member.assetGuid) continue;
      if (seen.has(member.assetGuid)) continue;
      seen.add(member.assetGuid);
      members.push(member);
    }
  };
  push(graph?.members);
  if (!classId) return members;
  for (const ancestor of walkAncestry(classId, parentOf)) {
    if (ancestor === classId) continue;
    push(parentGraphs?.[ancestor]?.members);
  }
  return members;
}

export function ensureFunctionExecPins(
  pins: GraphClassMemberPin[] | undefined,
): GraphClassMemberPin[] {
  const list = pins ?? [];
  if (list.some((pin) => pin.typeId === "exec")) return list;
  return [...DEFAULT_FUNCTION_PINS, ...list];
}

export function collectOverridableFunctionRows(options: {
  graph?: SerializedGraph;
  classId?: string;
  parentOf?: (id: string) => string | null | undefined;
  parentGraphs?: Record<string, SerializedGraph>;
  scriptInterfaces?: readonly ScriptInterfaceCatalogEntry[];
}): OverridableFunctionRow[] {
  const parentOf = parentLookup(options.parentOf);
  const taken = localFunctionNames(options.graph);
  const rows: OverridableFunctionRow[] = [];
  const seen = new Set<string>();

  const interfaces = interfaceMembersFromGraphs(
    options.classId,
    options.graph,
    options.parentGraphs,
    parentOf,
  );
  const catalog = new Map(
    (options.scriptInterfaces ?? []).map((entry) => [entry.guid, entry]),
  );
  for (const member of interfaces) {
    const guid = member.assetGuid ?? "";
    const iface = catalog.get(guid);
    if (!iface) continue;
    for (const method of iface.methods) {
      if (!method.name) continue;
      const id = `interface:${guid}:${method.name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({
        id,
        kind: "interface",
        name: method.name,
        description: `Interface · ${iface.name}`,
        overwritten: taken.has(method.name),
        pins: ensureFunctionExecPins(method.pins),
        implementsInterface: { assetGuid: guid, methodName: method.name },
      });
    }
  }

  if (options.classId) {
    for (const ancestor of walkAncestry(options.classId, parentOf)) {
      if (ancestor === options.classId) continue;
      const graph = options.parentGraphs?.[ancestor];
      for (const member of graph?.members ?? []) {
        if (member.kind !== "function" || !member.name) continue;
        if (member.overridable !== true) continue;
        const id = `function:${ancestor}:${member.name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        rows.push({
          id,
          kind: "function",
          name: member.name,
          description: `Parent · ${ancestor}`,
          overwritten: taken.has(member.name),
          pins: ensureFunctionExecPins(member.pins),
          overrides: { classId: ancestor, name: member.name },
        });
      }
    }
  }

  return rows;
}

export function collectImplementedInterfaceContexts(options: {
  graph?: SerializedGraph;
  classId?: string;
  parentOf?: (id: string) => string | null | undefined;
  parentGraphs?: Record<string, SerializedGraph>;
  scriptInterfaces?: readonly ScriptInterfaceCatalogEntry[];
}): Array<{
  guid: string;
  name: string;
  methods: Array<{
    name: string;
    pins: GraphClassMemberPin[];
  }>;
}> {
  const parentOf = parentLookup(options.parentOf);
  const catalog = new Map(
    (options.scriptInterfaces ?? []).map((entry) => [entry.guid, entry]),
  );
  const members = interfaceMembersFromGraphs(
    options.classId,
    options.graph,
    options.parentGraphs,
    parentOf,
  );
  const contexts = [];
  for (const member of members) {
    const guid = member.assetGuid ?? "";
    const iface = catalog.get(guid);
    if (!iface) continue;
    contexts.push({
      guid,
      name: iface.name,
      methods: iface.methods.map((method) => ({
        name: method.name,
        pins: method.pins ?? [],
      })),
    });
  }
  return contexts;
}

export function collectParentFunctionSignatures(options: {
  classId?: string;
  parentOf?: (id: string) => string | null | undefined;
  parentGraphs?: Record<string, SerializedGraph>;
}): Array<{
  classId: string;
  name: string;
  pins: GraphClassMemberPin[];
}> {
  const parentOf = parentLookup(options.parentOf);
  const rows = [];
  if (!options.classId) return rows;
  for (const ancestor of walkAncestry(options.classId, parentOf)) {
    if (ancestor === options.classId) continue;
    for (const member of options.parentGraphs?.[ancestor]?.members ?? []) {
      if (member.kind !== "function" || !member.name) continue;
      rows.push({
        classId: ancestor,
        name: member.name,
        pins: member.pins ?? [],
      });
    }
  }
  return rows;
}

export type OverridableEventKind = "native" | "parent" | "nested";

export type OverridableEventRow = {
  id: string;
  kind: OverridableEventKind;
  name: string;
  description: string;
  overwritten: boolean;
  eventType: string;
  pins: GraphClassMemberPin[];
  parentClassId?: string;
};

export type NestedUiLogicGraph = {
  guid: string;
  name: string;
  graph: SerializedGraph;
};

function localCustomEventNames(graph?: SerializedGraph): Set<string> {
  const names = new Set<string>();
  for (const node of graph?.nodes ?? []) {
    if (node.type !== "flow.event.custom") continue;
    const raw =
      typeof node.data.name === "string"
        ? node.data.name
        : typeof node.data.title === "string"
          ? node.data.title
          : "";
    const name = formatEventMemberName(raw);
    if (name) names.add(name);
  }
  for (const member of graph?.members ?? []) {
    if (member.kind !== "event") continue;
    const name = formatEventMemberName(member.name);
    if (name) names.add(name);
  }
  return names;
}

function localNativeEventTypes(graph?: SerializedGraph): Set<string> {
  const types = new Set<string>();
  for (const node of graph?.nodes ?? []) {
    if (!node.type.startsWith("flow.event.")) continue;
    if (node.type === "flow.event.custom") continue;
    types.add(node.type);
  }
  return types;
}

function customEventsFromGraph(
  graph: SerializedGraph | undefined,
): Array<{ name: string; pins: GraphClassMemberPin[] }> {
  const rows: Array<{ name: string; pins: GraphClassMemberPin[] }> = [];
  const seen = new Set<string>();
  const push = (name: string, pins: GraphClassMemberPin[] | undefined) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    rows.push({
      name,
      pins: (pins ?? []).filter(
        (pin) => pin.typeId !== "exec" && pin.direction !== "in",
      ),
    });
  };
  for (const member of graph?.members ?? []) {
    if (member.kind !== "event") continue;
    push(formatEventMemberName(member.name), member.pins);
  }
  for (const node of graph?.nodes ?? []) {
    if (node.type !== "flow.event.custom") continue;
    const raw =
      typeof node.data.name === "string"
        ? node.data.name
        : typeof node.data.title === "string"
          ? node.data.title
          : "";
    const pins = Array.isArray(node.data.pins)
      ? (node.data.pins as GraphClassMemberPin[])
      : [];
    push(formatEventMemberName(raw), pins);
  }
  return rows;
}

function isWidgetEventHost(options?: { assetType?: string | null }): boolean {
  return (
    options?.assetType === "UserInterface" ||
    options?.assetType === "EditorUtilityInterface"
  );
}

export function collectOverridableEventRows(options: {
  graph?: SerializedGraph;
  classId?: string;
  parentClass?: string | null;
  parentOf?: (id: string) => string | null | undefined;
  parentGraphs?: Record<string, SerializedGraph>;
  assetType?: string | null;
  nestedUis?: readonly NestedUiLogicGraph[];
}): OverridableEventRow[] {
  const takenNative = localNativeEventTypes(options.graph);
  const takenCustom = localCustomEventNames(options.graph);
  const rows: OverridableEventRow[] = [];
  const seen = new Set<string>();

  const native = [
    ...nativeEventStubs({
      parentClass: options.parentClass,
      parentOf: options.parentOf,
      assetType: options.assetType,
    }),
  ];
  const nativeTypes = new Set(native.map((stub) => stub.eventType));
  if (isWidgetEventHost(options)) {
    for (const eventType of WIDGET_POINTER_EVENT_TYPE_IDS) {
      if (nativeTypes.has(eventType)) continue;
      native.push({
        eventType,
        name: nativeEventTitle(eventType),
      });
    }
  }
  for (const stub of native) {
    const id = `native:${stub.eventType}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      kind: "native",
      name: stub.name,
      description: "Native",
      overwritten: takenNative.has(stub.eventType),
      eventType: stub.eventType,
      pins: [],
    });
  }

  const parentOf = parentLookup(options.parentOf);
  if (options.classId || options.parentClass) {
    const start = options.parentClass ?? options.classId;
    for (const ancestor of walkAncestry(start ?? "", parentOf)) {
      if (ancestor === options.classId) continue;
      const graph = options.parentGraphs?.[ancestor];
      for (const event of customEventsFromGraph(graph)) {
        const id = `parent:${ancestor}:${event.name}`;
        if (seen.has(id) || seen.has(`custom:${event.name}`)) continue;
        seen.add(id);
        seen.add(`custom:${event.name}`);
        rows.push({
          id,
          kind: "parent",
          name: event.name,
          description: `Parent · ${ancestor}`,
          overwritten: takenCustom.has(event.name),
          eventType: "flow.event.custom",
          pins: event.pins,
          parentClassId: ancestor,
        });
      }
    }
  }

  for (const nested of options.nestedUis ?? []) {
    for (const event of customEventsFromGraph(nested.graph)) {
      const id = `nested:${nested.guid}:${event.name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({
        id,
        kind: "nested",
        name: event.name,
        description: `Nested · ${nested.name}`,
        overwritten: takenCustom.has(event.name),
        eventType: "flow.event.custom",
        pins: event.pins,
        parentClassId: userInterfaceClassId(nested.guid),
      });
    }
  }

  return rows;
}
