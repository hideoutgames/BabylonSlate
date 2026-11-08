import type { GraphNode, GraphPin } from "./ir";
import type { ClassMemberSymbol } from "./type-context";

/** The function Input node, whose Pass-By-Reference outputs forward the caller's storage. */
export const FUNCTION_INPUT_NODE_TYPE = "flow.function.input";

/** True when `pin` on a function Input node is a Pass-By-Reference input of the function's signature. */
export function isByReferenceFunctionInput(node: GraphNode, pin: GraphPin): boolean {
  if (node.typeId !== FUNCTION_INPUT_NODE_TYPE || pin.direction !== "out" || pin.kind !== "data") return false;
  const rows = Array.isArray(node.properties.pins) ? node.properties.pins as Array<Record<string, unknown>> : [];
  return rows.some((row) => row?.direction === "in" && row.name === pin.id && row.byReference === true);
}

/** Where a Call node puts the references for its Pass-By-Reference arguments, beside their values. */
export const BY_REFERENCE_ARGS_KEY = "__refs";

/**
 * Expression for the reference a caller passed for a Pass-By-Reference function input, or null when the
 * function was entered without one (an event, a console command, Call In Editor).
 */
export function byReferenceArgument(name: string): string {
  return `(ctx.args.${BY_REFERENCE_ARGS_KEY}?.[${JSON.stringify(name)}] ?? null)`;
}

/**
 * Expression reading a Pass-By-Reference input's current value: through the caller's reference, so a
 * write made earlier in the function (Set By-Ref Var, a Seeded Random node) is seen, else the passed value.
 */
export function byReferenceArgumentValue(name: string): string {
  const key = JSON.stringify(name);
  return `((__r) => __r ? __r.get() : ctx.args[${key}])(${byReferenceArgument(name)})`;
}

/**
 * Only variable getters and Pass-By-Reference function inputs identify storage. Object-valued
 * expressions are still values.
 */
export function isWritableVariableOutput(
  node: GraphNode,
  pin: GraphPin,
  members?: readonly ClassMemberSymbol[],
): boolean {
  if (isByReferenceFunctionInput(node, pin)) return true;
  if (node.typeId !== "variables.get" || pin.id !== "value" ||
      node.properties.getOnly === true || node.properties.componentId) return false;
  const member = members?.find((entry) => entry.kind === "variable" && (
    entry.id === node.properties.variableId ||
    (entry.classId === node.properties.classId && entry.name === node.properties.variableName &&
      (node.properties.scope !== "local" || entry.functionId === node.properties.functionId))
  ));
  return member?.getOnly !== true && !member?.componentId;
}
