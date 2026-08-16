import type {
  GraphClassMember,
  GraphClassMemberPin,
  SerializedGraph,
} from "@babylonslate/core";
import { engineParentOf, walkAncestry } from "@babylonslate/editor-kit";
import { DEFAULT_FUNCTION_PINS } from "./class-members";

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
