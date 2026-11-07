import type { MaterialGraphEdge, MaterialGraphNode } from "./document";
import { isMaterialParameterNode, materialParameterName } from "./parameters";

/** Longest parameter name the editor gives; longer authored names stay as they are. */
const NAME_MAX = 64;

type GraphDocument = { nodes: MaterialGraphNode[]; edges: MaterialGraphEdge[] };

/** Parameter node types by value type, and the Constant each converts to and from. */
const MATERIAL_PARAMETER_TYPES = {
  float: "param.float",
  vec2: "param.vec2",
  vec3: "param.vec3",
  color: "param.color",
  texture: "param.texture",
} as const;
export type MaterialParameterValueType = keyof typeof MATERIAL_PARAMETER_TYPES;

const CONSTANT_FOR_PARAMETER: Readonly<Record<string, string>> = {
  "param.float": "const.float",
  "param.vec2": "const.vec2",
  "param.vec3": "const.vec3",
  "param.color": "const.color",
};
const PARAMETER_FOR_CONSTANT: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CONSTANT_FOR_PARAMETER).map(([parameter, constant]) => [constant, parameter]),
);

/** The value type of a parameter node type, or null for other nodes. */
export function materialParameterValueType(type: string): MaterialParameterValueType | null {
  for (const [valueType, nodeType] of Object.entries(MATERIAL_PARAMETER_TYPES)) if (nodeType === type) return valueType as MaterialParameterValueType;
  return null;
}

/** Whether **Convert to Parameter** applies: a Float, Vector 2, Vector 3 or Color Constant. */
export function canConvertMaterialConstantToParameter(type: string): boolean {
  return Object.hasOwn(PARAMETER_FOR_CONSTANT, type);
}

/** Whether **Convert to Constant** applies: any parameter but a Texture. */
export function canConvertMaterialParameterToConstant(type: string): boolean {
  return Object.hasOwn(CONSTANT_FOR_PARAMETER, type);
}

/**
 * `name` when no other parameter node holds it, else its stem (a trailing `_N` removed) with
 * the first free `_1`, `_2`…. `exceptNodeId` is the node being renamed.
 */
export function uniqueMaterialParameterName(
  nodes: readonly MaterialGraphNode[],
  name = "Parameter",
  exceptNodeId?: string,
): string {
  const taken = new Set(nodes
    .filter((node) => node.id !== exceptNodeId && isMaterialParameterNode(node.type))
    .map(materialParameterName));
  if (!taken.has(name)) return name;
  const stem = name.replace(/_\d+$/, "") || name;
  for (let index = 1; ; index += 1) {
    const suffix = `_${index}`;
    const candidate = `${stem.slice(0, NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Parameter nodes `previous` did not have (added from Add Node, pasted or duplicated) get a free
 * name: their own when no other parameter holds it, else with a `_N` suffix; an empty name
 * starts as `Parameter`. Nodes `previous` had keep theirs.
 */
export function nameNewMaterialParameters(
  previous: readonly MaterialGraphNode[],
  nodes: readonly MaterialGraphNode[],
): MaterialGraphNode[] {
  const known = new Set(previous.map((node) => node.id));
  const named: MaterialGraphNode[] = nodes.filter((node) => known.has(node.id));
  return nodes.map((node) => {
    if (known.has(node.id) || !isMaterialParameterNode(node.type)) return node;
    const name = uniqueMaterialParameterName(named, materialParameterName(node) || "Parameter");
    const next = { ...node, properties: { ...node.properties, name } };
    named.push(next);
    return next;
  });
}

/** Rename a parameter node; a taken name gets the first free `_N` suffix. */
export function renameMaterialParameter<T extends GraphDocument>(doc: T, nodeId: string, name: string): T {
  const trimmed = name.trim();
  if (!trimmed) return doc;
  return {
    ...doc,
    nodes: doc.nodes.map((node) => node.id === nodeId
      ? { ...node, properties: { ...node.properties, name: uniqueMaterialParameterName(doc.nodes, trimmed, nodeId) } }
      : node),
  };
}

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.map((entry) => (typeof entry === "number" && Number.isFinite(entry) ? entry : 0)) : [];
}

/** `value` fitted to a value type's width: one number fills, missing components are 0, colour alpha 1. */
function fit(value: unknown, width: number, alpha: boolean): number[] {
  const source = numbers(value);
  if (source.length === 1) return Array.from({ length: width }, (_, index) => (alpha && index === 3 ? 1 : source[0]!));
  return Array.from({ length: width }, (_, index) => source[index] ?? (alpha && index === 3 ? 1 : 0));
}

const WIDTHS: Readonly<Record<string, number>> = {
  "param.float": 1, "param.vec2": 2, "param.vec3": 3, "param.color": 4,
  "const.float": 1, "const.vec2": 2, "const.vec3": 3, "const.color": 3,
};

/** Swap one node's type and properties in place; edges from a pin the new type lacks follow `pins` or are dropped. */
function replaceNode<T extends GraphDocument>(
  doc: T,
  nodeId: string,
  type: string,
  properties: Record<string, unknown>,
  pins: Readonly<Record<string, string | null>>,
): T {
  return {
    ...doc,
    nodes: doc.nodes.map((node) => (node.id === nodeId ? { ...node, type, properties } : node)),
    edges: doc.edges.flatMap((edge) => {
      if (edge.sourceNodeId !== nodeId || !Object.hasOwn(pins, edge.sourcePinId)) return [edge];
      const pin = pins[edge.sourcePinId];
      return pin ? [{ ...edge, sourcePinId: pin }] : [];
    }),
  };
}

/**
 * **Convert to Parameter**: a Float, Vector 2, Vector 3 or Color Constant becomes the parameter
 * of its type holding its value, under a free name. Its id, position and wires stay (a Color's
 * wires move to the parameter's RGB output). Null for other nodes.
 */
export function convertMaterialConstantToParameter<T extends GraphDocument>(doc: T, nodeId: string): T | null {
  const node = doc.nodes.find((entry) => entry.id === nodeId);
  const type = node ? PARAMETER_FOR_CONSTANT[node.type] : undefined;
  if (!node || !type) return null;
  const value = fit(node.properties.value, WIDTHS[type]!, type === "param.color");
  return replaceNode(doc, nodeId, type, { name: uniqueMaterialParameterName(doc.nodes), value },
    type === "param.color" ? { out: "rgb" } : {});
}

/**
 * **Convert to Constant**: a Float, Vector 2, Vector 3 or Color parameter becomes the Constant
 * of its type holding its default. Its id, position and wires stay (a Color's RGB and RGBA wires
 * both move to the Constant's output). Null for Texture parameters and other nodes.
 */
export function convertMaterialParameterToConstant<T extends GraphDocument>(doc: T, nodeId: string): T | null {
  const node = doc.nodes.find((entry) => entry.id === nodeId);
  const type = node ? CONSTANT_FOR_PARAMETER[node.type] : undefined;
  if (!node || !type) return null;
  const value = fit(node.properties.value, WIDTHS[type]!, false);
  return replaceNode(doc, nodeId, type, { value }, node.type === "param.color" ? { rgb: "out" } : {});
}

/**
 * The Inspector's **Type**: the parameter node becomes another parameter type, keeping its name,
 * id and position. The default is resized (a new Color starts opaque) and wires from an output
 * the new type lacks are dropped.
 */
export function retypeMaterialParameter<T extends GraphDocument>(doc: T, nodeId: string, valueType: MaterialParameterValueType): T {
  const node = doc.nodes.find((entry) => entry.id === nodeId);
  const type = MATERIAL_PARAMETER_TYPES[valueType];
  if (!node || !isMaterialParameterNode(node.type) || node.type === type) return doc;
  const name = materialParameterName(node);
  const properties: Record<string, unknown> = type === "param.texture"
    ? { name, textureGuid: null }
    : { name, value: fit(node.properties.value, WIDTHS[type]!, type === "param.color") };
  // Only the shared `out` survives a change of type; a Color's `rgb` exists on Colors alone.
  const pins: Record<string, string | null> = { rgb: type === "param.color" ? "rgb" : null };
  if (node.type === "param.texture" || type === "param.texture") pins.out = null;
  return replaceNode(doc, nodeId, type, properties, pins);
}
