import type { GlobalParameterType } from "@haptic/core";
import type { ParticleGraphDocument, ParticleGraphNode } from "./document";
import type { ParticleNumericType } from "./types";

/** The Particle Graph **Global Parameter** node: one parameter of a Global Parameter Collection. */
export const PARTICLE_GLOBAL_PARAMETER_NODE_TYPE = "global.parameter";

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * The Particle Graph type a Global Parameter of `type` is read as. A Particle Graph has no Vector4
 * (Babylon's particle nodes have none): its four-component type is Color, which it passes as raw
 * numbers, so a Vector4 arrives on a Color pin unchanged.
 */
export function particleGlobalParameterValueType(type: GlobalParameterType): ParticleNumericType {
  return type === "vec4" ? "color" : type;
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
