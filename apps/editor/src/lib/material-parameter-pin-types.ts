import type { PinDefaultEditorRequest } from "@haptic/graph-ui";
import type { MaterialParameterValueType } from "@haptic/shader-graph";

/** Set, Get and Reset Material Parameter nodes, with the parameter types each one's Name pin lists. */
const MATERIAL_PARAMETER_NODE_TYPES: Readonly<Record<string, readonly MaterialParameterValueType[]>> = Object.fromEntries(
  ([["Float", ["float"]], ["Vector2", ["vec2"]], ["Vector3", ["vec3"]], ["Vector4", ["vec4"]], ["Color", ["color"]], ["Texture", ["texture"]]] as const)
    .flatMap(([kind, types]) => ["set", "get", "reset"].map((action) => [`material.${action}${kind}Parameter`, types])),
);

/** The parameter types a node's Name pin lists, or `undefined` when it is not a Material parameter node's Name pin. */
export function materialParameterPinTypes(request: Pick<PinDefaultEditorRequest, "nodeType" | "pin">):
  readonly MaterialParameterValueType[] | undefined {
  return request.pin.id === "name" ? MATERIAL_PARAMETER_NODE_TYPES[request.nodeType ?? ""] : undefined;
}
