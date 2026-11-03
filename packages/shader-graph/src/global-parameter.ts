import {
  GLOBAL_PARAMETER_TYPE_LABELS,
  findGlobalParameter,
  isGlobalParameterType,
  type GlobalParameterCatalog,
  type GlobalParameterType,
} from "@haptic/core";
import type { MaterialNodeDefinition, MaterialPinDefinition } from "./catalog";
import type { MaterialGraphNode } from "./document";
import type { MaterialDiagnostic } from "./validate";

/** The Material **Global Parameter** node: one parameter of a Global Parameter Collection. */
export const MATERIAL_GLOBAL_PARAMETER_NODE_TYPE = "global.parameter";

/**
 * The parameter a Global Parameter node reads. `valueType` is the parameter's type when it was
 * picked; the node's output and the compiled program follow it.
 */
export interface MaterialGlobalParameterSelection {
  collectionGuid: string;
  parameterId: string;
  valueType: GlobalParameterType;
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** The node's selection, or null while it has no collection, parameter or valid type. */
export function materialGlobalParameterSelection(
  properties: Readonly<Record<string, unknown>>,
): MaterialGlobalParameterSelection | null {
  const collectionGuid = text(properties.collectionGuid);
  const parameterId = text(properties.parameterId);
  const valueType = properties.valueType;
  if (!collectionGuid || !parameterId || !isGlobalParameterType(valueType)) return null;
  return { collectionGuid, parameterId, valueType };
}

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
  const selection = materialGlobalParameterSelection(node.properties);
  return { ...base, outputs: selection ? OUTPUTS[selection.valueType] : [] };
}

/** "<name> (Global <Type>)" when `catalog` holds the parameter, else "Global Parameter". */
export function materialGlobalParameterTitle(
  properties: Readonly<Record<string, unknown>>,
  catalog: Readonly<GlobalParameterCatalog> | undefined,
): string {
  const selection = materialGlobalParameterSelection(properties);
  const parameter = selection && catalog
    ? findGlobalParameter(catalog, selection.collectionGuid, selection.parameterId)
    : null;
  return selection && parameter
    ? `${parameter.name} (Global ${GLOBAL_PARAMETER_TYPE_LABELS[selection.valueType]})`
    : "Global Parameter";
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
 * Warnings for Global Parameter nodes: one without a parameter, and, given the project's
 * `catalog`, one whose parameter is gone or has changed type since it was picked.
 */
export function validateMaterialGlobalParameter(
  node: MaterialGraphNode,
  catalog: Readonly<GlobalParameterCatalog> | undefined,
): MaterialDiagnostic | null {
  const selection = materialGlobalParameterSelection(node.properties);
  const warn = (message: string): MaterialDiagnostic => ({ code: "material.globalParameter", message, severity: "warning", nodeId: node.id });
  if (!selection) return warn("Global Parameter has no parameter selected");
  if (!catalog) return null;
  if (!catalog[selection.collectionGuid]) return warn("Global Parameter's collection is missing; it reads 0");
  const parameter = findGlobalParameter(catalog, selection.collectionGuid, selection.parameterId);
  if (!parameter) return warn("Global Parameter's parameter is no longer in its collection; it reads 0");
  return parameter.type === selection.valueType
    ? null
    : warn(`"${parameter.name}" is now a ${GLOBAL_PARAMETER_TYPE_LABELS[parameter.type]} parameter; select it again to update this node`);
}
