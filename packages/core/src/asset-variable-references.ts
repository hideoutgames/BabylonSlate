import { parseMapDefaultEntries } from "./map-default";
import type { GraphClassMember, SerializedGraph } from "./project";

/** Typed asset defaults and Set Variable literals, including function locals. */
export function assetVariableGuidsFromGraph(graph: SerializedGraph): string[] {
  const guids = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) guids.add(value.trim());
  };
  const collect = (type: Partial<GraphClassMember>, value: unknown): void => {
    if (type.container === "map") {
      for (const entry of parseMapDefaultEntries(value)) {
        if (type.keyTypeId === "asset") add(entry.key);
        if (type.typeId === "asset") add(entry.value);
      }
    } else if (type.typeId === "asset" && type.container === "array") {
      if (Array.isArray(value)) value.forEach(add);
    } else if (type.typeId === "asset") add(value);
  };
  for (const member of graph.members ?? []) {
    if (member.kind === "variable") collect(member, member.defaultValue);
  }
  for (const slice of [graph, ...Object.values(graph.functionGraphs ?? {})]) {
    for (const node of slice.nodes ?? []) {
      if (node.type !== "variables.set") continue;
      // The Value pin's authored literal, typed by the node's variable type.
      const data = node.data ?? {};
      collect(data as Partial<GraphClassMember>, data["default:value"]);
    }
  }
  return [...guids];
}
