import { instrumentJsLoops } from "@haptic/debugger";
import type { GraphNode, GraphPin } from "./ir";
import { findPin } from "./ir";
import type { CodegenContext } from "./node-registry";
import { defaultValueLiteral, pinTypeEquals } from "./types";
import { isWritableVariableOutput } from "./variable-references";
import { jsIdent, localVariableIdent } from "./compile-events";
import { pinForCodegen, wiredSourceType } from "./compile-graph-index";
import {
  disconnectedPinLiteral,
  guardPureExpression,
  subjectPinsOf,
} from "./compile-pin-values";
import {
  emitBody,
  loopCheck,
  memoExpression,
  type CodegenState,
} from "./compile-codegen-state";

function pinExpr(s: CodegenState, node: GraphNode, dataPin: GraphPin): string {
  const key = `${node.id}:${dataPin.id}`;
  const cached = s.exprCache.get(key);
  if (cached) return cached;
  const incoming = s.index.incoming(node.id, dataPin.id);
  if (incoming) {
    const srcNode = s.index.node(incoming.sourceNodeId);
    const srcPin = srcNode && findPin(srcNode, incoming.sourcePinId);
    // A dangling wire (reported as ref.missing_*) reads like a stripped source.
    if (!srcNode || !srcPin || s.shouldStrip(srcNode)) {
      const lit = defaultValueLiteral(dataPin.type);
      s.exprCache.set(key, lit);
      return lit;
    }
    const srcDef = s.options.registry.get(srcNode.typeId);
    if (srcDef?.pure) {
      ensurePure(s, srcNode);
    } else {
      const slot = `_n_${jsIdent(srcNode.id)}_${jsIdent(srcPin.id)}`;
      if (!s.exprCache.has(`${srcNode.id}:${srcPin.id}`)) {
        s.exprCache.set(`${srcNode.id}:${srcPin.id}`, slot);
        s.outputDecls.set(
          slot,
          `  let ${slot} = ${defaultValueLiteral(srcPin.type)};`,
        );
      }
    }
    const varName = s.exprCache.get(`${srcNode.id}:${srcPin.id}`);
    if (varName) {
      s.exprCache.set(key, varName);
      return varName;
    }
  }
  const lit = disconnectedPinLiteral(node, dataPin, s.options.registry);
  s.exprCache.set(key, lit);
  return lit;
}

function referenceExpr(s: CodegenState, node: GraphNode, pinName: string): string {
  const targetPin = pinForCodegen(node, pinName, "in");
  const edge = targetPin && s.index.incoming(node.id, targetPin.id);
  const source = edge && s.index.node(edge.sourceNodeId);
  const sourcePin = source && edge && findPin(source, edge.sourcePinId);
  if (!source || !sourcePin || !targetPin || s.shouldStrip(source) ||
      !pinTypeEquals(sourcePin.type, targetPin.type) || !isWritableVariableOutput(source, sourcePin)) return "null";
  const name = String(source.properties.variableName ?? "Value").trim() || "Value";
  if (source.properties.scope === "local") {
    const local = localVariableIdent(name);
    const reference = `__ref_${local}`;
    s.outputDecls.set(reference, `  const ${reference} = { identity: {}, property: ${JSON.stringify(name)}, set: value => { ${local} = value; } };`);
    return reference;
  }
  const property = typeof source.properties.propertyKey === "string" && source.properties.propertyKey
    ? source.properties.propertyKey : name;
  const ownerPin = pinForCodegen(source, "target", "in");
  const connected = ownerPin && s.index.incoming(source.id, ownerPin.id);
  const implicitSelf = !ownerPin || (!connected && source.properties.implicitSelf === true);
  const owner = implicitSelf ? "null" : pinExpr(s, source, ownerPin!);
  return `ctx.variableReference(${owner}, ${JSON.stringify(property)}, ${implicitSelf})`;
}

/** An input's expression, memoized per statement when its pure node feeds several outputs. */
export function inputExpression(s: CodegenState, node: GraphNode, p: GraphPin): string {
  const expression = pinExpr(s, node, p);
  if (!s.sharedInputNodes.has(node.id)) return expression;
  const edge = s.index.incoming(node.id, p.id);
  const source = edge && s.index.node(edge.sourceNodeId);
  if (!source || s.shouldStrip(source) || !s.options.registry.get(source.typeId)?.pure) {
    return expression;
  }
  return memoExpression(s, `in:${node.id}:${p.id}`, expression);
}

/**
 * A pure node's output expression, recording the value each time a consumer evaluates it. The
 * wrapper evaluates `expression` exactly where it already ran, so a pure node is never evaluated
 * an extra time and a chain of pure nodes records every link of it.
 */
function tracedPureOutput(s: CodegenState, node: GraphNode, p: GraphPin, expression: string): string {
  if (!s.traceExecution) return expression;
  return `__dw(__dbg, ${JSON.stringify(node.id)}, ${JSON.stringify(p.id)}, ${expression})`;
}

/**
 * A node that runs records what it read from a wired data input, and checks it against the node's
 * breakpoint. A pure node records its outputs instead (`tracedPureOutput`); what flowed into its
 * inputs is what their sources produced, and an unwired input shows its literal on the node.
 */
export function tracedRead(s: CodegenState, node: GraphNode, p: GraphPin, expression: string): string {
  if ((!s.traceExecution && !s.checkBreakpoints) || s.options.registry.get(node.typeId)?.pure) return expression;
  const edge = s.index.incoming(node.id, p.id);
  if (!edge || !s.index.node(edge.sourceNodeId)) return expression;
  const ids = `${JSON.stringify(node.id)}, ${JSON.stringify(p.id)}`;
  const checked = s.checkBreakpoints ? `__bv(__bp, ${ids}, ${expression})` : expression;
  return s.traceExecution ? `__dv(__dbg, ${ids}, ${checked})` : checked;
}

/** `bound` names the variables that already hold a node's subject inputs. */
export function makeCtx(s: CodegenState, node: GraphNode, continuation?: (expression: string) => void,
  branch?: (expression: string, truePin: string, falsePin: string) => void,
  bound?: ReadonlyMap<string, string>): CodegenContext {
  return {
    graph: s.graph,
    node,
    indent: "  ",
    input(pinName) {
      const p = pinForCodegen(node, pinName, "in");
      if (!p) return "undefined";
      // A bound subject was recorded where it was bound; every other wired read is recorded here.
      return bound?.get(p.id) ?? tracedRead(s, node, p, inputExpression(s, node, p));
    },
    isWired(pinId) { return s.index.incoming(node.id, pinId) !== undefined; },
    reference(pinName) { return referenceExpr(s, node, pinName); },
    shared(expression) {
      // With one wired output there is nothing to share.
      if (!s.sharedInputNodes.has(node.id)) return expression;
      return memoExpression(s, `shared:${node.id}:${expression}`, expression);
    },
    continueIf(expression) { continuation?.(expression); },
    branch(expression, truePin, falsePin) { branch?.(expression, truePin, falsePin); },
    inputType(pinName) {
      const p = pinForCodegen(node, pinName, "in");
      return p ? wiredSourceType(s.index, node, p.id, s.shouldStrip) : undefined;
    },
    output(pinName) {
      const p = pinForCodegen(node, pinName, "out");
      const slotKey = p?.id ?? pinName;
      const name = `_n_${jsIdent(node.id)}_${jsIdent(slotKey)}`;
      if (p) s.exprCache.set(`${node.id}:${p.id}`, name);
      return name;
    },
    emit(statement, anchorNodeId) {
      const anchor = {
        column: 1,
        assetGuid: s.options.assetGuid,
        graphId: s.graph.id,
        nodeId: anchorNodeId ?? node.id,
      };
      if (s.instrumentLoops) emitBody(s, `  ${loopCheck(s, anchor.nodeId)}`, anchor);
      emitBody(s, `  ${statement}`, anchor);
    },
    hoist(source, bodyAnchors) {
      const next = s.instrumentLoops
        ? instrumentJsLoops(source, loopCheck(s, node.id))
        : source;
      if (s.hoisted.some((chunk) => chunk.source === next)) return;
      s.hoisted.push({ source: next, nodeId: node.id, bodyAnchors });
    },
    requestAsync() {
      s.isAsync = true;
    },
    isLatentFunction: s.options.isLatentFunction,
  };
}

export function ensurePure(s: CodegenState, node: GraphNode) {
  if (s.shouldStrip(node) || s.pureInProgress.has(node.id)) return;
  const def = s.options.registry.get(node.typeId);
  if (!def?.pure) return;
  if (
    node.pins.some(
      (p) =>
        p.direction === "out" &&
        p.kind === "data" &&
        s.exprCache.has(`${node.id}:${p.id}`),
    )
  ) {
    return;
  }
  const subjects = subjectPinsOf(node, s.options.registry, s.options.className);
  s.pureInProgress.add(node.id);
  let result: ReturnType<typeof def.codegen>;
  let subjectArgs: string[];
  try {
    // Read in progress: a pure cycle through a subject input ends here.
    subjectArgs = subjects.map((subject) => inputExpression(s, node, subject.pin));
    const bound = new Map(subjects.map((subject, i) => [subject.pin.id, `__s${i}`] as const));
    result = def.codegen(makeCtx(s, node, undefined, undefined, bound));
  } finally {
    s.pureInProgress.delete(node.id);
  }
  if (result && typeof result === "object") {
    for (const [name, expr] of Object.entries(result)) {
      const outPin = pinForCodegen(node, name, "out");
      if (!outPin) continue;
      const guarded = subjects.length > 0
        ? guardPureExpression(subjects, subjectArgs, expr, defaultValueLiteral(outPin.type))
        : expr;
      s.exprCache.set(
        `${node.id}:${outPin.id}`,
        tracedPureOutput(s, node, outPin, s.pureExpressions.expression(node, outPin, guarded)),
      );
    }
  }
}
