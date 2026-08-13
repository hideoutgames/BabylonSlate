import type { SerializedGraph } from "@babylonslate/core";
import type { ShaderGraphDocument, ShaderNodeKind } from "./graph";
import { createDefaultShaderGraph } from "./graph";

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
      properties: { ...node.data },
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
