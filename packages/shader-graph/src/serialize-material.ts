import type { SerializedGraph } from "@babylonslate/core";
import {
  materialNodeDefinition,
  materialPaletteEntries,
  type MaterialDomain,
  type MaterialPinDefinition,
} from "./catalog";
import {
  normalizeMaterialDocument,
  type MaterialDocument,
  type MaterialFunctionDocument,
} from "./document";
import { isNumericType, typesAreAssignable, type MaterialValueType } from "./types";
import { isMaterialParameterNode, materialParameterName } from "./parameters";
import { customGlslDefinition, newCustomGlslProperties } from "./custom-glsl";
import { createTypeResolver } from "./resolve";
import { vectorMaskDefinition } from "./vector-mask";

/** Pin shape the shared graph shell renders and connects. */
export interface MaterialGraphPin {
  typeLabel?: string;
  group?: string;
  id: string;
  name: string;
  kind: "data";
  direction: "in" | "out";
  type: { kind: string };
  defaultValue?: number[];
  colorHint?: boolean;
}

export interface MaterialPinContext {
  properties?: Record<string, unknown>;
  functions?: Record<string, MaterialFunctionDocument>;
  /** Interface used to hydrate `function.input` / `function.output` nodes. */
  functionInterface?: MaterialFunctionDocument;
  /** Selected function for a `function.call` node. */
  functionGuid?: string;
}

function toPin(
  pin: MaterialPinDefinition,
  direction: "in" | "out",
): MaterialGraphPin {
  return {
    id: pin.id,
    name: pin.name,
    kind: "data",
    direction,
    type: { kind: pin.type.kind },
    ...(pin.defaultValue ? { defaultValue: pin.defaultValue } : {}),
    ...(pin.colorHint ? { colorHint: true } : {}),
  };
}

export function pinsForMaterialNode(
  type: string,
  context: MaterialPinContext = {},
): MaterialGraphPin[] {
  if (type === "function.call") {
    const fn = context.functionGuid
      ? context.functions?.[context.functionGuid]
      : undefined;
    if (!fn) return [];
    return [
      ...fn.inputs.map((pin) =>
        toPin(
          {
            id: pin.id,
            name: pin.name,
            type: { kind: pin.type },
            ...(pin.defaultValue ? { defaultValue: pin.defaultValue } : {}),
          },
          "in",
        ),
      ),
      ...fn.outputs.map((pin) =>
        toPin({ id: pin.id, name: pin.name, type: { kind: pin.type } }, "out"),
      ),
    ];
  }
  if (type === "function.input" || type === "function.output") {
    const fn = context.functionInterface;
    if (!fn) return [];
    const pins = type === "function.input" ? fn.inputs : fn.outputs;
    const direction = type === "function.input" ? "out" : "in";
    return pins.map((pin) =>
      toPin(
        {
          id: pin.id,
          name: pin.name,
          type: { kind: pin.type },
          ...(pin.defaultValue ? { defaultValue: pin.defaultValue } : {}),
        },
        direction,
      ),
    );
  }
  let definition = materialNodeDefinition(type);
  if (definition && type === "vector.mask") definition = vectorMaskDefinition({ id: "", type, position: { x: 0, y: 0 }, properties: context.properties ?? {} }, definition);
  if (definition && type === "custom.glsl" && context.properties) {
    definition = customGlslDefinition({ id: "", type, position: { x: 0, y: 0 }, properties: context.properties }, definition);
  }
  if (!definition) return [];
  return [
    ...definition.inputs.map((pin) => toPin(pin, "in")),
    ...definition.outputs.map((pin) => toPin(pin, "out")),
  ];
}

export interface MaterialPaletteNode {
  defaultData?: Record<string, unknown>;
  id: string;
  title: string;
  category: string;
  pins: MaterialGraphPin[];
}

export function materialPaletteNodes(
  domain: MaterialDomain,
): MaterialPaletteNode[] {
  return materialPaletteEntries(domain).map((definition) => ({
    id: definition.type,
    title: definition.title,
    category: definition.category,
    pins: pinsForMaterialNode(definition.type, { properties: newNodeDefaults(definition.type, {}) }),
    defaultData: { ...newNodeDefaults(definition.type, {}), __material: true },
  }));
}

const EDITOR_NODE_KEYS = new Set([
  "__pins",
  "__material",
  "__nodeType",
  "__category",
  "__pure",
  "__latent",
  "__editorOnly",
  "title",
]);

function propertiesFromNodeData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!EDITOR_NODE_KEYS.has(key)) properties[key] = value;
  }
  return properties;
}

function newNodeDefaults(type: string, data: Record<string, unknown>): Record<string, unknown> {
  if (type === "custom.glsl" && typeof data.body !== "string" && typeof data.glsl !== "string") return newCustomGlslProperties();
  if (type === "input.time") return { timeMode: "seconds", ...data };
  if (type === "math.divide" || type === "math.mod") return { "default:b": [1], ...data };
  if (type === "math.pow") return { "default:exponent": [1], ...data };
  return {};
}

export function materialGraphToSerialized(
  doc: MaterialDocument | MaterialFunctionDocument,
): SerializedGraph {
  return {
    nodes: doc.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: { ...node.properties },
    })),
    edges: doc.edges.map((edge) => ({
      id: edge.id,
      source: edge.sourceNodeId,
      target: edge.targetNodeId,
      sourceHandle: edge.sourcePinId,
      targetHandle: edge.targetPinId,
    })),
  };
}

/**
 * Fold canvas edits back into the document. Everything the canvas does not own
 * (domain, blend mode, preview settings) comes from `previous`.
 */
export function serializedToMaterialGraph(
  graph: SerializedGraph,
  previous?: MaterialDocument,
): MaterialDocument {
  const base = previous ?? normalizeMaterialDocument({});
  return normalizeMaterialDocument({
    ...base,
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      properties: {
        ...propertiesFromNodeData(node.data),
        ...(previous && isMaterialParameterNode(node.type) && !previous.nodes.some((entry) => entry.id === node.id) ? { name: "" } : {}),
      },
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      sourceNodeId: edge.source,
      targetNodeId: edge.target,
      sourcePinId: edge.sourceHandle ?? "out",
      targetPinId: edge.targetHandle ?? "in",
    })),
  });
}

export function serializedToMaterialFunctionGraph(
  graph: SerializedGraph,
  previous: MaterialFunctionDocument,
): MaterialFunctionDocument {
  return {
    ...previous,
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      properties: {
        ...propertiesFromNodeData(node.data),
        ...(isMaterialParameterNode(node.type) && !previous.nodes.some((entry) => entry.id === node.id) ? { name: "" } : {}),
      },
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      sourceNodeId: edge.source,
      targetNodeId: edge.target,
      sourcePinId: edge.sourceHandle ?? "out",
      targetPinId: edge.targetHandle ?? "in",
    })),
  };
}

/** Inject catalog pins and titles so the canvas can draw and connect nodes. */
export function hydrateMaterialGraphForEditor(
  graph: SerializedGraph,
  context: MaterialPinContext = {},
): SerializedGraph {
  const resolver = createTypeResolver({
    nodes: graph.nodes.map((node) => ({ ...node, properties: propertiesFromNodeData(node.data) })),
    edges: graph.edges.map((edge) => ({ id: edge.id, sourceNodeId: edge.source, sourcePinId: edge.sourceHandle ?? "out", targetNodeId: edge.target, targetPinId: edge.targetHandle ?? "in" })),
  }, context);
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const data = { ...(node.data as Record<string, unknown>) };
      const functionGuid =
        typeof data.functionGuid === "string" ? data.functionGuid : undefined;
      const pins = pinsForMaterialNode(node.type, { ...context, functionGuid, properties: data });
      for (const pin of pins) {
        if (node.type === "output.surface") pin.group = ({ baseColor: "Surface", emissive: "Emission", opacity: "Transparency", worldPositionOffset: "Geometry" } as Record<string, string>)[pin.id];
        const resolved = pin.direction === "in" ? resolver.inputType(node.id, pin.id) : resolver.outputType(node.id, pin.id);
        const unconnectedMask = node.type === "vector.mask" && pin.direction === "in" && !graph.edges.some((edge) => edge.target === node.id && edge.targetHandle === pin.id);
        if (pin.type.kind === "generic" && resolved && resolved !== "float" && !unconnectedMask) pin.type = { kind: resolved };
        const kind = resolved ?? pin.type.kind;
        pin.typeLabel = kind === "float" ? "Float" : kind === "texture" ? "Texture" : /^vec[234]$/.test(kind) ? `V${kind.slice(-1)}` : "Numeric";
      }
      const definition = resolver.definitionOf(node.id);
      const calledFunction = functionGuid
        ? context.functions?.[functionGuid]
        : undefined;
      return {
        ...node,
        data: {
          ...data,
          __pins: pins,
          __material: true,
          __nodeType: node.type,
          ...(definition ? { __category: definition.category } : {}),
          title: isMaterialParameterNode(node.type)
            ? materialParameterName({ ...node, properties: data }) || definition?.title || node.type
            : calledFunction?.name ?? definition?.title ?? node.type,
        },
      };
    }),
  };
}

type CanvasPin = { direction: "in" | "out"; type: { kind: string } };

/**
 * Canvas connection rule for material graphs: a Float splats into any vector,
 * generic pins take any numeric value, and textures only meet textures.
 * Truncation stays explicit through a Split node.
 */
export function materialPinsAreCompatible(
  outgoing: CanvasPin,
  incoming: CanvasPin,
): boolean {
  const from = outgoing.type.kind;
  const to = incoming.type.kind;
  if (from === "generic" && to === "generic") return true;
  if (from === "generic") return to !== "texture";
  if (to === "generic") return from !== "texture";
  if (from === "texture" || to === "texture") return from === to;
  return typesAreAssignable(
    from as MaterialValueType,
    to as MaterialValueType,
  );
}

export function materialPinTypeIsNumeric(kind: string): boolean {
  return kind === "generic" || isNumericType(kind as MaterialValueType);
}
