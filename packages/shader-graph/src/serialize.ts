import type { SerializedGraph } from "@babylonslate/core";
import type { ShaderGraphDocument, ShaderNodeKind, ShaderValueKind } from "./graph";
import { createDefaultShaderGraph, SHADER_CATALOG } from "./graph";

export type ShaderGraphPin = {
  id: string;
  name: string;
  kind: "data";
  direction: "in" | "out";
  type: { kind: ShaderValueKind };
};

function dataPin(
  id: string,
  direction: "in" | "out",
  type: ShaderValueKind,
): ShaderGraphPin {
  return { id, name: id, kind: "data", direction, type: { kind: type } };
}

const SHADER_NODE_PINS: Record<ShaderNodeKind, ShaderGraphPin[]> = {
  "input.uv": [dataPin("uv", "out", "vec2")],
  "input.time": [dataPin("time", "out", "float")],
  "texture.sample": [dataPin("uv", "in", "vec2"), dataPin("rgba", "out", "vec4")],
  "math.multiply": [
    dataPin("a", "in", "float"),
    dataPin("b", "in", "float"),
    dataPin("out", "out", "float"),
  ],
  "math.add": [
    dataPin("a", "in", "float"),
    dataPin("b", "in", "float"),
    dataPin("out", "out", "float"),
  ],
  "output.fragment": [dataPin("color", "in", "color")],
  "output.postProcess": [dataPin("color", "in", "color")],
  custom: [dataPin("in", "in", "float"), dataPin("out", "out", "float")],
};

export function pinsForShaderNode(type: ShaderNodeKind): ShaderGraphPin[] {
  return SHADER_NODE_PINS[type] ?? SHADER_NODE_PINS.custom;
}

export function shaderPaletteNodes(): Array<{
  id: ShaderNodeKind;
  title: string;
  category: string;
  pins: ShaderGraphPin[];
}> {
  return SHADER_CATALOG.map((entry) => ({
    id: entry.type,
    title: entry.title,
    category: entry.category,
    pins: pinsForShaderNode(entry.type),
  }));
}

const EDITOR_NODE_KEYS = new Set([
  "__pins",
  "__nodeType",
  "__category",
  "__pure",
  "__latent",
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

export function shaderGraphToSerialized(doc: ShaderGraphDocument): SerializedGraph {
  return {
    nodes: doc.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: { ...node.properties, postProcess: doc.postProcess },
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

export function serializedToShaderGraph(
  graph: SerializedGraph,
  previous: ShaderGraphDocument = createDefaultShaderGraph(),
): ShaderGraphDocument {
  return {
    ...previous,
    postProcess: graph.nodes.some(
      (node) => node.type === "output.postProcess" || node.data.postProcess === true,
    ),
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: node.type as ShaderNodeKind,
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

export function hydrateShaderGraphForEditor(
  graph: SerializedGraph,
): SerializedGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const data = { ...(node.data as Record<string, unknown>) };
      if (Array.isArray(data.__pins) && data.__pins.length > 0) {
        return { ...node, data };
      }
      return {
        ...node,
        data: {
          ...data,
          __pins: pinsForShaderNode(node.type as ShaderNodeKind),
        },
      };
    }),
  };
}
