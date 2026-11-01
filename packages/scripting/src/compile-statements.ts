import type { GraphNode } from "./ir";
import type { CodegenContext, NodeDefinition } from "./node-registry";
import { defaultValueLiteral } from "./types";
import { jsIdent } from "./compile-events";
import { deadReference, reportDeadReference, subjectPinsOf } from "./compile-pin-values";
import { emitBody, traceProbe, type CodegenState } from "./compile-codegen-state";
import { inputExpression, makeCtx, tracedRead } from "./compile-expressions";

/** An exec node runs: the followed instance records it, and a breakpoint on it stops the session. */
export function emitExecProbes(s: CodegenState, nodeId: string): void {
  const id = JSON.stringify(nodeId);
  if (s.traceExecution) emitBody(s, traceProbe(`__dbg.exec(${id})`));
  if (s.checkBreakpoints) {
    emitBody(s, `  if (__bp !== null && __bp.has(${id})) __bp.hit(${id}, ${JSON.stringify(s.entryNodeId)}, ctx.self);`);
  }
}

/**
 * Evaluates a statement node's subject inputs once and logs each null one. The
 * node's statements run only when none is null; otherwise its data outputs read
 * their defaults. Returns the context for the node's codegen and, for a node
 * with subjects, the condition under which it runs.
 */
export function emitStatementNode(
  s: CodegenState,
  node: GraphNode,
  def: NodeDefinition,
  flow?: {
    continuation: (expression: string) => void;
    branch: (expression: string, truePin: string, falsePin: string) => void;
  },
): { ctx: CodegenContext; condition?: string } {
  const anchor = { column: 1, assetGuid: s.options.assetGuid, graphId: s.graph.id, nodeId: node.id };
  const subjects = subjectPinsOf(node, s.options.registry, s.options.className);
  const bound = new Map<string, string>();
  for (const subject of subjects) {
    const slot = `__s_${jsIdent(node.id)}_${jsIdent(subject.pin.id)}`;
    bound.set(subject.pin.id, slot);
    s.outputDecls.set(slot, `  let ${slot};`);
    emitBody(s, `  ${slot} = ${tracedRead(s, node, subject.pin, inputExpression(s, node, subject.pin))};`, anchor);
  }
  for (const subject of subjects) {
    emitBody(s, `  ${reportDeadReference(subject, bound.get(subject.pin.id)!)}`, anchor);
  }
  const ctx = makeCtx(s, node, flow?.continuation, flow?.branch, bound);
  if (def.latent) s.isAsync = true;
  declareDataOuts(s, node, ctx);
  if (subjects.length === 0) {
    def.codegen(ctx);
    emitOutputProbe(s, node, ctx);
    return { ctx };
  }
  const condition = subjects.map((subject) => `!${deadReference(bound.get(subject.pin.id)!)}`).join(" && ");
  emitBody(s, `  if (${condition}) {`, anchor);
  const start = s.body.length;
  def.codegen(ctx);
  if (s.body.length === start) {
    // The node emitted nothing (its work is a continuation): no empty block.
    s.body.pop();
    emitOutputProbe(s, node, ctx);
    return { ctx, condition };
  }
  const resets = node.pins
    .filter((pin) => pin.kind === "data" && pin.direction === "out")
    .map((pin) => `    ${ctx.output(pin.id)} = ${defaultValueLiteral(pin.type)};`);
  if (resets.length > 0) {
    emitBody(s, "  } else {", anchor);
    for (const reset of resets) emitBody(s, reset, anchor);
  }
  emitBody(s, "  }", anchor);
  emitOutputProbe(s, node, ctx);
  return { ctx, condition };
}

/** Records every data output of `node` once its statements have run, and checks it against the node's breakpoint. */
export function emitOutputProbe(s: CodegenState, node: GraphNode, ctx: CodegenContext) {
  if (!s.traceExecution && !s.checkBreakpoints) return;
  const outs = node.pins.filter((p) => p.kind === "data" && p.direction === "out");
  if (outs.length === 0) return;
  const writes = (target: string) => outs.map((p) =>
    `${target}.write(${JSON.stringify(node.id)}, ${JSON.stringify(p.id)}, ${ctx.output(p.id)});`).join(" ");
  if (s.traceExecution) emitBody(s, `  if (__dbg !== null) { ${writes("__dbg")} }`);
  if (s.checkBreakpoints) emitBody(s, `  if (__bp !== null && __bp.has(${JSON.stringify(node.id)})) { ${writes("__bp")} }`);
}

export function declareDataOuts(s: CodegenState, node: GraphNode, ctx: CodegenContext) {
  for (const p of node.pins) {
    if (p.kind === "data" && p.direction === "out") {
      const name = ctx.output(p.id);
      s.outputDecls.set(
        name,
        `  let ${name} = ${defaultValueLiteral(p.type)};`,
      );
    }
  }
}
