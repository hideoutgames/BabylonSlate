import type { GlobalParameterType } from "@haptic/core";
import type { PinDefaultEditorRequest } from "@haptic/graph-ui";

/** Set/Get Global Parameter nodes, with the parameter types each one's Parameter pin lists. */
const GLOBAL_PARAMETER_NODE_TYPES: Readonly<Record<string, readonly GlobalParameterType[]>> = {
  "globalParameters.setFloatParameter": ["float"],
  "globalParameters.getFloatParameter": ["float"],
  "globalParameters.setVectorParameter": ["vec2", "vec3"],
  "globalParameters.getVectorParameter": ["vec2", "vec3"],
  "globalParameters.setColorParameter": ["color"],
  "globalParameters.getColorParameter": ["color"],
};

/**
 * The parameter types a node's Parameter pin lists, when the node is a Set or Get Global
 * Parameter node whose Collection is set and unwired; `undefined` otherwise (a free text pin).
 */
export function globalParameterPinTypes(request: Pick<PinDefaultEditorRequest, "nodeType" | "nodeData" | "pin" | "connectedInputIds">):
  readonly GlobalParameterType[] | undefined {
  if (request.pin.id !== "parameter" || request.connectedInputIds?.includes("collection")) return undefined;
  const collection = request.nodeData["default:collection"];
  if (typeof collection !== "string" || !collection) return undefined;
  return GLOBAL_PARAMETER_NODE_TYPES[request.nodeType ?? ""];
}
