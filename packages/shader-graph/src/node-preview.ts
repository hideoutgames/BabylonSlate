import { terminalNodeTypeFor } from "./catalog";
import type { MaterialDocument, MaterialGraphNode } from "./document";
import { createTypeResolver, type TypeResolverOptions } from "./resolve";

/** The node output the Material preview shows instead of the Material's own output. */
export interface MaterialNodePreviewTarget {
  nodeId: string;
  pinId: string;
}

/** An output the preview can show: its pin id and display name. */
export interface MaterialNodePreviewOutput {
  pinId: string;
  name: string;
}

/**
 * The outputs of a node that **Preview Node** can show: every numeric output, in pin order. A Texture
 * output is not a colour, and output nodes have no outputs, so both give none.
 */
export function materialNodePreviewOutputs(
  document: MaterialDocument,
  nodeId: string,
  options: Pick<TypeResolverOptions, "functions"> = {},
): MaterialNodePreviewOutput[] {
  if (!document.nodes.some((node) => node.id === nodeId)) return [];
  const resolver = createTypeResolver(document, { functions: options.functions });
  return (resolver.definitionOf(nodeId)?.outputs ?? [])
    .filter((pin) => (resolver.outputType(nodeId, pin.id) ?? pin.type.kind) !== "texture")
    .map((pin) => ({ pinId: pin.id, name: pin.name }));
}

/** An id no node in `nodes` has, from `base`. */
function freeNodeId(nodes: readonly MaterialGraphNode[], base: string): string {
  let id = base;
  for (let suffix = 1; nodes.some((node) => node.id === id); suffix += 1) id = `${base}_${suffix}`;
  return id;
}

/**
 * The document the preview compiles while a node is previewed: the output wired alone into the output
 * node's colour, unlit and opaque, so the preview shows the value itself. Every other input of the
 * output node, and its pin defaults, are dropped. The value goes through Split and Combine, so a Float
 * is grey, a Vector2 is X red, Y green and blue 0, a Vector4 drops W, and a colour output's alpha is 1.
 * Null when the node or output no longer exists or cannot be shown.
 */
export function materialNodePreviewDocument(
  document: MaterialDocument,
  target: MaterialNodePreviewTarget,
  options: Pick<TypeResolverOptions, "functions"> = {},
): MaterialDocument | null {
  const terminal = document.nodes.find((node) => node.type === terminalNodeTypeFor(document.domain));
  const source = document.nodes.find((node) => node.id === target.nodeId);
  if (!terminal || !source) return null;
  if (!materialNodePreviewOutputs(document, source.id, options).some((output) => output.pinId === target.pinId)) return null;
  const vector2 = createTypeResolver(document, { functions: options.functions }).outputType(source.id, target.pinId) === "vec2";
  const split = freeNodeId(document.nodes, "__previewSplit");
  const combine = freeNodeId(document.nodes, "__previewCombine");
  const edge = (sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) =>
    ({ id: `${sourceNodeId}:${sourcePinId}:${targetNodeId}:${targetPinId}`, sourceNodeId, sourcePinId, targetNodeId, targetPinId });
  const surface = document.domain === "surface" || document.domain === "landscape" || document.domain === "decal";
  return {
    ...document,
    shadingModel: "unlit",
    blendMode: "opaque",
    nodes: [
      ...document.nodes.map((node) => node.id === terminal.id
        ? { ...node, properties: Object.fromEntries(Object.entries(node.properties).filter(([key]) => !key.startsWith("default:"))) }
        : node),
      { id: split, type: "vector.split", position: source.position, properties: {} },
      { id: combine, type: "vector.combine", position: source.position, properties: {} },
    ],
    edges: [
      ...document.edges.filter((entry) => entry.targetNodeId !== terminal.id),
      edge(source.id, target.pinId, split, "value"),
      edge(split, "x", combine, "x"),
      edge(split, "y", combine, "y"),
      // A Vector2 widens to (X, Y, 1, 1); Combine's own Z default (0) keeps blue out of it.
      ...(vector2 ? [] : [edge(split, "z", combine, "z")]),
      edge(combine, "xyz", terminal.id, surface ? "baseColor" : "color"),
    ],
  };
}
