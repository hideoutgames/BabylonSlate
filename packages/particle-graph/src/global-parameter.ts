import {
  GLOBAL_PARAMETER_TYPE_LABELS,
  findGlobalParameter,
  isGlobalParameterType,
  type GlobalParameterCatalog,
  type GlobalParameterType,
} from "@haptic/core";
import type { ParticleGraphDocument, ParticleGraphNode } from "./document";

/** The Particle Graph **Global Parameter** node: one parameter of a Global Parameter Collection. */
export const PARTICLE_GLOBAL_PARAMETER_NODE_TYPE = "global.parameter";

/** The parameter a Global Parameter node reads; `valueType` is its type when it was picked. */
export interface ParticleGlobalParameterSelection {
  collectionGuid: string;
  parameterId: string;
  valueType: GlobalParameterType;
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** The node's selection, or null while it has no collection, parameter or valid type. */
export function particleGlobalParameterSelection(
  properties: Readonly<Record<string, unknown>>,
): ParticleGlobalParameterSelection | null {
  const collectionGuid = text(properties.collectionGuid);
  const parameterId = text(properties.parameterId);
  const valueType = properties.valueType;
  if (!collectionGuid || !parameterId || !isGlobalParameterType(valueType)) return null;
  return { collectionGuid, parameterId, valueType };
}

/** "<name> (Global <Type>)" when `catalog` holds the parameter, else "Global Parameter". */
export function particleGlobalParameterTitle(
  properties: Readonly<Record<string, unknown>>,
  catalog: Readonly<GlobalParameterCatalog> | undefined,
): string {
  const selection = particleGlobalParameterSelection(properties);
  const parameter = selection && catalog
    ? findGlobalParameter(catalog, selection.collectionGuid, selection.parameterId)
    : null;
  return selection && parameter
    ? `${parameter.name} (Global ${GLOBAL_PARAMETER_TYPE_LABELS[selection.valueType]})`
    : "Global Parameter";
}

/**
 * Point a Global Parameter node at `collectionGuid` and, when given, one of its parameters; the
 * output takes the parameter's type. Without a parameter the node has no output, so its wires go.
 */
export function selectParticleGlobalParameter(
  doc: ParticleGraphDocument,
  nodeId: string,
  collectionGuid: string,
  parameter: { id: string; type: GlobalParameterType } | null,
): ParticleGraphDocument {
  const node = doc.nodes.find((entry) => entry.id === nodeId);
  if (!node || node.type !== PARTICLE_GLOBAL_PARAMETER_NODE_TYPE) return doc;
  const guid = collectionGuid.trim();
  const selected = guid && parameter;
  const properties: Record<string, unknown> = guid
    ? { collectionGuid: guid, ...(parameter ? { parameterId: parameter.id, valueType: parameter.type } : {}) }
    : {};
  return {
    ...doc,
    nodes: doc.nodes.map((entry) => (entry.id === nodeId ? { ...entry, properties } : entry)),
    edges: selected ? doc.edges : doc.edges.filter((edge) => edge.sourceNodeId !== nodeId),
  };
}

/** The Global Parameter Collections a graph's Global Parameter nodes read, sorted and unique. */
export function particleGraphGlobalParameterCollections(nodes: readonly ParticleGraphNode[]): string[] {
  const guids = new Set<string>();
  for (const node of nodes) {
    const guid = node.type === PARTICLE_GLOBAL_PARAMETER_NODE_TYPE ? text(node.properties.collectionGuid) : "";
    if (guid) guids.add(guid);
  }
  return [...guids].sort();
}

/**
 * The warning for a Global Parameter node: no parameter, or, given the project's `catalog`, a
 * parameter that is gone or has changed type since it was picked.
 */
export function particleGlobalParameterWarning(
  node: ParticleGraphNode,
  catalog: Readonly<GlobalParameterCatalog> | undefined,
): string | null {
  const selection = particleGlobalParameterSelection(node.properties);
  if (!selection) return "Global Parameter has no parameter selected";
  if (!catalog) return null;
  if (!catalog[selection.collectionGuid]) return "Global Parameter's collection is missing; it reads 0";
  const parameter = findGlobalParameter(catalog, selection.collectionGuid, selection.parameterId);
  if (!parameter) return "Global Parameter's parameter is no longer in its collection; it reads 0";
  return parameter.type === selection.valueType
    ? null
    : `"${parameter.name}" is now a ${GLOBAL_PARAMETER_TYPE_LABELS[parameter.type]} parameter; select it again to update this node`;
}
