import {
  diagnostic,
  emitMathExpression,
  listValidationRules,
  mathExpressionInputPinId,
  mathExpressionNodeState,
  mathExpressionOutputPinId,
  mathExpressionPins,
  registerValidationRule,
  MATH_EXPRESSION_NODE_ID,
  type Diagnostic,
  type LogicGraph,
  type MathExpressionError,
  type NodeDefinition,
  type TypeContext,
} from "@haptic/scripting";

/** A formula error as the Inspector, the node and the Problems list word it. */
export function mathExpressionErrorText(error: MathExpressionError): string {
  return `Line ${error.line}, column ${error.column}: ${error.message}`;
}

/**
 * Math Expression: a formula of numbers and vectors typed on the node. Each output compiles to one
 * module-level helper that computes only what it needs (`emitMathExpression`), so the node stays a
 * pure node returning one call per output pin.
 */
export const mathExpressionNode: NodeDefinition = {
  id: MATH_EXPRESSION_NODE_ID,
  title: "Math Expression",
  category: "math",
  description: "A formula of numbers and vectors. Its names become input and output pins.",
  searchAliases: ["expression", "formula", "equation", "math formula", "calculate"],
  pure: true,
  referentiallyTransparent: true,
  pins: (properties) => mathExpressionPins(properties),
  codegen: (ctx) => {
    const state = mathExpressionNodeState(ctx.node.properties);
    if (state.error || !state.analysis) {
      throw new Error(`Math Expression: ${state.error ? mathExpressionErrorText(state.error) : "invalid formula"}`);
    }
    const { inputs, outputs } = state.analysis.signature;
    const helpers = emitMathExpression(state.analysis);
    const out: Record<string, string> = {};
    helpers.forEach((helper, index) => {
      ctx.hoist(helper.declaration);
      const args = helper.inputs.map((input) => ctx.input(mathExpressionInputPinId(inputs[input]!.name)));
      out[mathExpressionOutputPinId(outputs[index]!.name)] = `${helper.name}(${args.join(", ")})`;
    });
    return out;
  },
};

/** Each Math Expression node's first formula error, with its line and column. */
function validateMathExpressions(graphs: readonly LogicGraph[], ctx: TypeContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      if (node.typeId !== MATH_EXPRESSION_NODE_ID) continue;
      const { error } = mathExpressionNodeState(node.properties);
      if (!error) continue;
      out.push(diagnostic({
        code: error.code,
        message: `Math Expression: ${mathExpressionErrorText(error)}`,
        assetGuid: ctx.assetGuid,
        graphId: graph.id,
        nodeId: node.id,
      }));
    }
  }
  return out;
}

export function registerMathExpressionValidationRules(): void {
  if (listValidationRules().some((rule) => rule.id === "mathExpression.formula")) return;
  registerValidationRule({ id: "mathExpression.formula", run: validateMathExpressions });
}
