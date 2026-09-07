import { parseMapDefaultEntries } from "./map-default";
import type { GraphClassMember, SerializedGraph } from "./project";

/** Texture references in typed variable defaults, including function locals. */
export function textureVariableGuidsFromMembers(
  members: readonly GraphClassMember[],
): string[] {
  const guids = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) guids.add(value.trim());
  };
  for (const member of members) {
    if (member.kind !== "variable") continue;
    const valueIsTexture = member.typeId === "asset" && member.typeClassId === "Texture";
    const value = member.defaultValue;
    if (member.container === "map") {
      const keyIsTexture = member.keyTypeId === "asset" && member.keyTypeClassId === "Texture";
      for (const entry of parseMapDefaultEntries(value)) {
        if (keyIsTexture) add(entry.key);
        if (valueIsTexture) add(entry.value);
      }
    } else if (valueIsTexture && member.container === "array") {
      if (Array.isArray(value)) value.forEach(add);
    } else if (valueIsTexture) {
      add(value);
    }
  }
  return [...guids];
}

/** Asset dependencies carried by Texture parameter setters, including functions. */
export function materialParameterTextureGuidsFromGraph(
  graph: SerializedGraph,
): string[] {
  const guids = new Set(textureVariableGuidsFromMembers(graph.members ?? []));
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
