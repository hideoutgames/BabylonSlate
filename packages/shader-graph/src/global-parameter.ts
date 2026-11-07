import {
  globalParameterNodeWarning,
  globalParameterSelection,
  type GlobalParameterCatalog,
  type GlobalParameterType,
} from "@haptic/core";
import type { MaterialNodeDefinition, MaterialPinDefinition } from "./catalog";
import type { MaterialGraphNode } from "./document";
import type { MaterialDiagnostic } from "./validate";

/** The Material **Global Parameter** node: one parameter of a Global Parameter Collection. */
export const MATERIAL_GLOBAL_PARAMETER_NODE_TYPE = "global.parameter";

const OUTPUTS: Readonly<Record<GlobalParameterType, readonly MaterialPinDefinition[]>> = {
  float: [{ id: "out", name: "Out", type: { kind: "float" } }],
  vec2: [{ id: "out", name: "Out", type: { kind: "vec2" } }],
  vec3: [{ id: "out", name: "Out", type: { kind: "vec3" } }],
  // As a Color Parameter: the full color and its RGB.
  color: [
    { id: "out", name: "RGBA", type: { kind: "vec4" }, colorHint: true },
    { id: "rgb", name: "RGB", type: { kind: "vec3" }, colorHint: true },
  ],
};

/** The node's outputs follow its parameter's type; without a parameter it has none. */
export function materialGlobalParameterDefinition(
  node: Pick<MaterialGraphNode, "properties">,
  base: MaterialNodeDefinition,
): MaterialNodeDefinition {
  const selection = globalParameterSelection(node.properties);
  return { ...base, outputs: selection ? OUTPUTS[selection.valueType] : [] };
}

/**
 * Point a Global Parameter node at `collectionGuid` and, when given, one of its parameters.
 * Wires from an output the new selection lacks are dropped (all of them without a parameter).
 */
export function selectMaterialGlobalParameter<T extends { nodes: MaterialGraphNode[]; edges: { sourceNodeId: string; sourcePinId: string }[] }>(
  doc: T,
  nodeId: string,
  collectionGuid: string,
  parameter: { id: string; type: GlobalParameterType } | null,
): T {
  const node = doc.nodes.find((entry) => entry.id === nodeId);
  if (!node || node.type !== MATERIAL_GLOBAL_PARAMETER_NODE_TYPE) return doc;
  const properties: Record<string, unknown> = collectionGuid.trim()
    ? { collectionGuid: collectionGuid.trim(), ...(parameter ? { parameterId: parameter.id, valueType: parameter.type } : {}) }
    : {};
  const outputs = new Set((parameter && collectionGuid.trim() ? OUTPUTS[parameter.type] : []).map((pin) => pin.id));
  return {
    ...doc,
    nodes: doc.nodes.map((entry) => (entry.id === nodeId ? { ...entry, properties } : entry)),
    edges: doc.edges.filter((edge) => edge.sourceNodeId !== nodeId || outputs.has(edge.sourcePinId)),
  };
}

/**
 * The warning for a Global Parameter node: one without a parameter, and, given the project's
 * `catalog`, one whose parameter is gone or has changed type since it was picked.
 */
export function validateMaterialGlobalParameter(
  node: MaterialGraphNode,
  catalog: Readonly<GlobalParameterCatalog> | undefined,
): MaterialDiagnostic | null {
  const message = globalParameterNodeWarning(node.properties, catalog);
  return message === null ? null : { code: "material.globalParameter", message, severity: "warning", nodeId: node.id };
}
