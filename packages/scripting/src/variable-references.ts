import type { GraphNode, GraphPin } from "./ir";
import type { ClassMemberSymbol } from "./type-context";

/** Only variable getters identify storage. Object-valued expressions are still values. */
export function isWritableVariableOutput(
  node: GraphNode,
  pin: GraphPin,
  members?: readonly ClassMemberSymbol[],
): boolean {
  if (node.typeId !== "variables.get" || pin.id !== "value" ||
      node.properties.getOnly === true || node.properties.componentId) return false;
  const member = members?.find((entry) => entry.kind === "variable" && (
    entry.id === node.properties.variableId ||
    (entry.classId === node.properties.classId && entry.name === node.properties.variableName &&
      (node.properties.scope !== "local" || entry.functionId === node.properties.functionId))
  ));
  return member?.getOnly !== true && !member?.componentId;
}
