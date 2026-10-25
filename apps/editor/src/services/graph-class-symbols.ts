/**
 * Class lineage and the facts derived from Class graphs: the parent lookup,
 * latent functions, custom events, member symbols, known Class ids and script
 * pin compatibility. `graph-validation.ts` re-exports the public names.
 */
import type { GraphClassMemberPin, SerializedGraph } from "@haptic/core";
import { engineParentOf, formatEventMemberName, walkAncestry } from "@haptic/editor-kit";
import {
  isAssignable,
  pinTypeEquals,
  type ClassHierarchy,
  type ClassMemberSymbol,
  type NodeRegistry,
  type PinType,
  collectLatentFunctions,
  latentSourcesFromSerializedGraph,
} from "@haptic/scripting";
import {
  ENGINE_BASE_CLASS_IDS,
  ENGINE_BT_BUILTIN_CLASSES,
  ENGINE_CLASS_SCRIPT_APIS,
  ENGINE_COMPONENT_CLASS_IDS,
  isSceneAssetClassId,
} from "@haptic/object-model";
import { componentGraphMembersForClass } from "../lib/component-graph-members";
import type { PinCompatibilityRule } from "@haptic/graph-ui";

export function parentLookup(
  parentOf?: (id: string) => string | null | undefined,
): (id: string) => string | null | undefined {
  return (id) => {
    if (isSceneAssetClassId(id) && id !== "Scene") return "Scene";
    return parentOf?.(id) ?? engineParentOf(id);
  };
}

export function editorLatentFunctions(
  nodeRegistry: NodeRegistry,
  options?: {
    classId?: string;
    graph?: Pick<SerializedGraph, "members" | "functionGraphs">;
    otherClassGraphs?: Record<string, SerializedGraph>;
    parentOf?: (id: string) => string | null | undefined;
  },
): Set<string> {
  const sources = [
    ...latentSourcesFromSerializedGraph(
      options?.classId ?? "Object",
      options?.graph ?? {},
    ),
    ...Object.entries(options?.otherClassGraphs ?? {}).flatMap(
      ([classId, graph]) => latentSourcesFromSerializedGraph(classId, graph),
    ),
  ];
  const parentOf =
    options?.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
  return collectLatentFunctions(sources, nodeRegistry, parentOf);
}

export type CustomEventRow = {
  name: string;
  pins: GraphClassMemberPin[];
};

export function customEventRows(graph?: SerializedGraph): CustomEventRow[] {
  const byName = new Map<string, CustomEventRow>();
  for (const member of graph?.members ?? []) {
    if (member.kind !== "event" || !member.name) continue;
    const name = formatEventMemberName(member.name);
    if (!name) continue;
    byName.set(name, {
      name,
      pins: member.pins ?? [],
    });
  }
  for (const node of graph?.nodes ?? []) {
    if (node.type !== "flow.event.custom") continue;
    const raw =
      typeof node.data.name === "string"
        ? node.data.name
        : typeof node.data.title === "string"
          ? node.data.title
          : "";
    const name = formatEventMemberName(raw);
    if (!name || byName.has(name)) continue;
    const pins = Array.isArray(node.data.pins)
      ? (node.data.pins as GraphClassMemberPin[])
      : [];
    byName.set(name, { name, pins });
  }
  return [...byName.values()];
}

export function classHierarchyFromParentOf(
  parentOf: (id: string) => string | null | undefined,
): ClassHierarchy {
  return {
    isSubclassOf(childClassId, parentClassId) {
      if (childClassId === parentClassId) return true;
      return walkAncestry(childClassId, parentOf).includes(parentClassId);
    },
  };
}

export function classMemberSymbolsFromGraphs(
  graphs: Record<string, SerializedGraph>,
  options?: { parentOf?: (id: string) => string | null | undefined },
): ClassMemberSymbol[] {
  const symbols: ClassMemberSymbol[] = [];
  for (const [classId, graph] of Object.entries(graphs)) {
    for (const member of graph.members ?? []) {
      if (member.kind === "interface") continue;
      const name =
        member.kind === "event"
          ? formatEventMemberName(member.name)
          : member.name;
      if (!name) continue;
      const symbol: ClassMemberSymbol = {
        id: member.id,
        name,
        kind: member.kind,
        classId,
      };
      if (member.functionId) symbol.functionId = member.functionId;
      if (member.typeId) symbol.typeId = member.typeId;
      if (member.typeClassId) symbol.typeClassId = member.typeClassId;
      if (member.container === "array" || member.container === "map") {
        symbol.container = member.container;
      }
      if (member.keyTypeId) symbol.keyTypeId = member.keyTypeId;
      if (member.keyTypeClassId) symbol.keyTypeClassId = member.keyTypeClassId;
      if (member.kind === "function") {
        if (member.pins) symbol.pins = member.pins;
        if (member.implementsInterface) {
          symbol.implementsInterface = member.implementsInterface;
        }
        if (member.overrides) symbol.overrides = member.overrides;
        if (member.runtime) symbol.runtime = member.runtime;
      }
      if (member.componentId) symbol.componentId = member.componentId;
      if (member.propertyKey) symbol.propertyKey = member.propertyKey;
      symbols.push(symbol);
    }
    // Add Node's Event Custom places a canvas node without a member; Calls to
    // it resolve through these symbols.
    const declaredEvents = new Set(
      (graph.members ?? [])
        .filter((member) => member.kind === "event")
        .map((member) => formatEventMemberName(member.name)),
    );
    for (const event of customEventRows(graph)) {
      if (declaredEvents.has(event.name)) continue;
      symbols.push({
        id: `node-event:${classId}:${event.name}`,
        kind: "event",
        name: event.name,
        classId,
      });
    }
    for (const member of componentGraphMembersForClass({
      graph,
      classId,
      parentOf: options?.parentOf,
      parentGraphs: graphs,
    })) {
      symbols.push({
        id: member.id,
        name: member.name,
        kind: "variable",
        classId,
        typeId: member.typeId,
        typeClassId: member.typeClassId,
        componentId: member.componentId,
      });
    }
  }
  for (const api of ENGINE_CLASS_SCRIPT_APIS) {
    for (const variable of api.variables ?? []) {
      symbols.push({
        id: `engine:${api.classId}:var:${variable.propertyKey}`,
        name: variable.name,
        kind: "variable",
        classId: api.classId,
        typeId: variable.typeId,
        typeClassId: variable.typeClassId,
        propertyKey: variable.propertyKey,
        container: variable.container,
        ...(variable.getOnly ? { getOnly: true } : {}),
      });
    }
    for (const fn of api.functions ?? []) {
      symbols.push({
        id: `engine:${api.classId}:fn:${fn.runtime}`,
        name: fn.name,
        kind: "function",
        classId: api.classId,
        runtime: fn.runtime,
        pins: fn.pins.map((pin) => ({
          ...(pin.container ? { container: pin.container } : {}),
          name: pin.name,
          typeId: pin.typeId,
          direction: pin.direction,
          ...(pin.typeClassId ? { typeClassId: pin.typeClassId } : {}),
          ...(pin.container ? { container: pin.container } : {}),
        })),
      });
    }
  }
  return symbols;
}

export function knownClassIdSet(
  parentOf: (id: string) => string | null | undefined,
  classIds: readonly string[],
): Set<string> {
  const ids = new Set<string>([
    ...ENGINE_BASE_CLASS_IDS,
    ...ENGINE_COMPONENT_CLASS_IDS,
    ...ENGINE_BT_BUILTIN_CLASSES.map((entry) => entry.id),
  ]);
  for (const id of classIds) {
    ids.add(id);
    for (const ancestor of walkAncestry(id, parentOf)) ids.add(ancestor);
  }
  return ids;
}

export function scriptPinCompatibility(
  hierarchy?: ClassHierarchy,
): PinCompatibilityRule {
  return (outgoing, incoming) =>
    (incoming.reference !== "required" || (outgoing.reference === "writable" &&
      pinTypeEquals(outgoing.type as PinType, incoming.type as PinType))) &&
    isAssignable(outgoing.type as PinType, incoming.type as PinType, {
      hierarchy,
    });
}
