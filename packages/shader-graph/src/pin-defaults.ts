import {
  materialNodeDefinition,
  type MaterialPinDefinition,
} from "./catalog";
import type {
  MaterialFunctionDocument,
  MaterialGraphEdge,
  MaterialGraphNode,
} from "./document";
import { componentCount, isNumericType, type MaterialValueType } from "./types";
import { customGlslDefinition } from "./custom-glsl";
import { createTypeResolver } from "./resolve";

export function materialPinDefaultPropertyKey(pinId: string): string {
  return `default:${pinId}`;
}

export function asNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((component) =>
    typeof component === "number" && Number.isFinite(component) ? component : 0,
  );
}

export function readMaterialPinDefault(
  properties: Record<string, unknown>,
  pinId: string,
): number[] | undefined {
  return asNumberArray(properties[materialPinDefaultPropertyKey(pinId)]);
}

/**
 * An unwired value at `type`'s width: a scalar fills every channel; a vector
 * keeps its leading channels, drops extra ones and fills missing ones with 1,
 * like every widening conversion. Lowering and Details both read this, so the
 * shader and the inspector show the same value.
 */
export function materialDefaultComponents(
  type: MaterialValueType,
  value: readonly number[] | undefined,
): number[] {
  const width = Math.max(1, componentCount(type));
  const source = value && value.length > 0 ? value : [0];
  if (source.length === 1) return Array<number>(width).fill(source[0]!);
  return Array.from({ length: width }, (_, index) => source[index] ?? 1);
}

function zeroComponents(type: MaterialValueType | "generic"): number[] {
  if (type === "generic" || type === "float") return [0];
  if (type === "texture") return [];
  return Array.from({ length: componentCount(type) }, () => 0);
}

export type MaterialPinDefault = {
  pinId: string;
  name: string;
  type: MaterialValueType | "generic";
  colorHint?: boolean;
  value: number[];
};

export type MaterialPinDefaultContext = {
  functions?: Record<string, MaterialFunctionDocument>;
};

function inputPins(
  node: MaterialGraphNode,
  context: MaterialPinDefaultContext,
): MaterialPinDefinition[] {
  if (node.type === "function.call") {
    const guid =
      typeof node.properties.functionGuid === "string"
        ? node.properties.functionGuid
        : undefined;
    const fn = guid ? context.functions?.[guid] : undefined;
    if (!fn) return [];
    return fn.inputs.map((pin) => ({
      id: pin.id,
      name: pin.name,
      type: { kind: pin.type },
      ...(pin.defaultValue ? { defaultValue: pin.defaultValue } : {}),
    }));
  }
  const definition = materialNodeDefinition(node.type);
  return [...(definition && node.type === "custom.glsl" ? customGlslDefinition(node, definition).inputs : definition?.inputs ?? [])];
}

export function listUnconnectedMaterialPinDefaults(
  graph: { nodes: MaterialGraphNode[]; edges: MaterialGraphEdge[] },
  nodeId: string,
  context: MaterialPinDefaultContext = {},
): MaterialPinDefault[] {
  const node = graph.nodes.find((entry) => entry.id === nodeId);
  if (!node) return [];
  const connected = new Set(
    graph.edges
      .filter((edge) => edge.targetNodeId === nodeId)
      .map((edge) => edge.targetPinId),
  );
  const listed: MaterialPinDefault[] = [];
  const resolver = createTypeResolver(graph, context);
  for (const pin of inputPins(node, context)) {
    if (connected.has(pin.id)) continue;
    const kind = pin.type.kind;
    if (kind === "texture") continue;
    if (kind !== "generic" && !isNumericType(kind as MaterialValueType)) continue;
    const authored = readMaterialPinDefault(node.properties, pin.id);
    if (authored === undefined && pin.defaultValue === undefined) continue;
    const type = kind === "generic" ? resolver.inputType(node.id, pin.id) ?? "generic" : kind as MaterialValueType;
    const value = authored ?? pin.defaultValue ?? zeroComponents(type);
    listed.push({
      pinId: pin.id,
      name: pin.name,
      type,
      ...(pin.colorHint ? { colorHint: true } : {}),
      value: type === "generic" ? value : materialDefaultComponents(type, value),
    });
  }
  return listed;
}

export function resolveMaterialPinDefault(
  node: MaterialGraphNode,
  pin: Pick<MaterialPinDefinition, "id" | "defaultValue">,
): number[] | undefined {
  return readMaterialPinDefault(node.properties, pin.id) ?? pin.defaultValue;
}
