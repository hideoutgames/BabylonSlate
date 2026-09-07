import type { SerializedGraph } from "./project";

/** Asset dependencies carried by Texture parameter setters, including functions. */
export function materialParameterTextureGuidsFromGraph(
  graph: SerializedGraph,
): string[] {
  const guids = new Set<string>();
  const slices = [graph, ...Object.values(graph.functionGraphs ?? {})];
  for (const slice of slices) {
    for (const node of slice.nodes) {
      if (node.type !== "material.setTextureParameter") continue;
      const nested = node.data.properties;
      const properties =
        nested && typeof nested === "object" && !Array.isArray(nested)
          ? (nested as Record<string, unknown>)
          : node.data;
      // Match script pin-default precedence. Explicitly cleared defaults mask legacy values.
      const value = ["default:value", "value", "default:Value", "Value"]
        .map((key) => properties[key])
        .find((entry) => entry !== undefined);
      if (typeof value === "string" && value.trim()) guids.add(value.trim());
    }
  }
  return [...guids];
}
