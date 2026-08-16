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

/** Pin shape the shared graph shell renders and connects. */
export interface MaterialGraphPin {
  id: string;
  name: string;
  kind: "data";
  direction: "in" | "out";
  type: { kind: string };
}

export interface MaterialPinContext {
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
          { id: pin.id, name: pin.name, type: { kind: pin.type } },
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
      toPin({ id: pin.id, name: pin.name, type: { kind: pin.type } }, direction),
    );
  }
  const definition = materialNodeDefinition(type);
  if (!definition) return [];
  return [
    ...definition.inputs.map((pin) => toPin(pin, "in")),
    ...definition.outputs.map((pin) => toPin(pin, "out")),
  ];
}

export interface MaterialPaletteNode {
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
    pins: pinsForMaterialNode(definition.type),
  }));
}

const EDITOR_NODE_KEYS = new Set([
  "__pins",
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
      properties: propertiesFromNodeData(node.data),
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
      properties: propertiesFromNodeData(node.data),
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
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const data = { ...(node.data as Record<string, unknown>) };
      const functionGuid =
        typeof data.functionGuid === "string" ? data.functionGuid : undefined;
      const pins = pinsForMaterialNode(node.type, { ...context, functionGuid });
      const definition = materialNodeDefinition(node.type);
      const calledFunction = functionGuid
        ? context.functions?.[functionGuid]
        : undefined;
      return {
        ...node,
        data: {
          ...data,
          __pins: pins,
          __nodeType: node.type,
          ...(definition ? { __category: definition.category } : {}),
          title: calledFunction?.name ?? definition?.title ?? node.type,
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
