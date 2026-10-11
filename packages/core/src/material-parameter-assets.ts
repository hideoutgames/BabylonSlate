import { parseMapDefaultEntries } from "./map-default";
import type { GraphClassMember, SerializedGraph } from "./project";
import { isMaterialTextureAssetType } from "./render-target";

/** Texture references in typed variable defaults, including function locals. */
function textureVariableGuidsFromMembers(
  members: readonly GraphClassMember[],
): string[] {
  const guids = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) guids.add(value.trim());
  };
  for (const member of members) {
    if (member.kind !== "variable") continue;
    const valueIsTexture =
      member.typeId === "asset" && isMaterialTextureAssetType(member.typeClassId ?? "");
    const value = member.defaultValue;
    if (member.container === "map") {
      const keyIsTexture =
        member.keyTypeId === "asset" && isMaterialTextureAssetType(member.keyTypeClassId ?? "");
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
      // The Value pin's authored literal, where the compiler reads it.
      const value = node.data["default:value"];
      if (typeof value === "string" && value.trim()) guids.add(value.trim());
    }
  }
  return [...guids];
}
