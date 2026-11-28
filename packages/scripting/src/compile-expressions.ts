import { instrumentJsLoops } from "@haptic/debugger";
import type { GraphNode, GraphPin } from "./ir";
import { findPin } from "./ir";
import { isPureNode, trustGateOf, type CodegenContext, type UnboxedVector } from "./node-registry";
import { pinTypeEquals } from "./types";
import { byReferenceArgument, isByReferenceFunctionInput, isWritableVariableOutput } from "./variable-references";
import { jsIdent, localVariableIdent } from "./compile-events";
import { pinForCodegen, wiredSourceType } from "./compile-graph-index";
import {
  deadReference,
  disconnectedPinLiteral,
  disconnectedVectorComponents,
  guardPureExpression,
  pooledDefaultValueLiteral,
  subjectPinsOf,
} from "./compile-pin-values";
import {
  accessLocation,
  allocGuardTemp,
  allocScalarTemp,
  emitBody,
  emptyMapSentinel,
  loopCheck,
  memoExpression,
  memoUnboxedVector,
  poolFrozenConstant,
  type CodegenState,
} from "./compile-codegen-state";

/** A name or a member read off one: nothing to evaluate twice. */
const PLAIN_READ = /^[\w$]+(\.[\w$]+)*$/;

function pooledDefault(s: CodegenState, type: GraphPin["type"]): string {
  return pooledDefaultValueLiteral(
    type,
    (literal) => poolFrozenConstant(s, literal),
    () => emptyMapSentinel(s),
    !s.hasExecuteJavaScript,
  );
}

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
      const lit = pooledDefault(s, dataPin.type);
      s.exprCache.set(key, lit);
      return lit;
    }
    const srcDef = s.options.registry.get(srcNode.typeId);
    if (isPureNode(srcDef, srcNode)) {
      ensurePure(s, srcNode);
    } else {
      const slot = `_n_${jsIdent(srcNode.id)}_${jsIdent(srcPin.id)}`;
      if (!s.exprCache.has(`${srcNode.id}:${srcPin.id}`)) {
        s.exprCache.set(`${srcNode.id}:${srcPin.id}`, slot);
        s.outputDecls.set(
          slot,
          `  let ${slot} = ${pooledDefault(s, srcPin.type)};`,
        );
      }
    }
    const varName = s.exprCache.get(`${srcNode.id}:${srcPin.id}`);
    if (varName) {
      s.exprCache.set(key, varName);
      return varName;
    }
  }
  const lit = disconnectedPinLiteral(
    node,
    dataPin,
    s.options.registry,
    undefined,
    (literal) => poolFrozenConstant(s, literal),
    () => emptyMapSentinel(s),
    !s.hasExecuteJavaScript,
  );
  s.exprCache.set(key, lit);
  return lit;
}

/** Combine two optional comma-expression setup fragments in order. */
function joinSetup(a?: string, b?: string): string | undefined {
  if (a && b) return `${a}, ${b}`;
  return a || b;
}

/** Box an `UnboxedVector`'s current components into an object literal (without running setup). */
function boxComponentsLiteral(vec: UnboxedVector): string {
  if (vec.kind === "vec2") return `{ x: ${vec.x}, y: ${vec.y} }`;
  if (vec.kind === "vec3") return `{ x: ${vec.x}, y: ${vec.y}, z: ${vec.z} }`;
  return `{ x: ${vec.x}, y: ${vec.y}, z: ${vec.z}, w: ${vec.w} }`;
}

/**
 * Unboxed scalar representation for `dataPin` on `node` when available:
 * - Disconnected vector/quat/color pins return numeric literals directly.
 * - Wired pure producers implementing `codegenUnboxed` return scalar expressions
 *   with zero intermediate object allocations.
 * - Tracing and breakpoint probes still emit the exact boxed value lazily when
 *   `__dbg !== null` / `__bp !== null`.
 */
function inputUnboxedExpr(s: CodegenState, node: GraphNode, dataPin: GraphPin): UnboxedVector | undefined {
  const incoming = s.index.incoming(node.id, dataPin.id);
  if (!incoming) {
    return disconnectedVectorComponents(node, dataPin, s.options.registry);
  }
  const srcNode = s.index.node(incoming.sourceNodeId);
  const srcPin = srcNode && findPin(srcNode, incoming.sourcePinId);
  if (!srcNode || !srcPin || s.shouldStrip(srcNode)) {
    return disconnectedVectorComponents(node, dataPin, s.options.registry);
  }
  const srcDef = s.options.registry.get(srcNode.typeId);
  if (!isPureNode(srcDef, srcNode) || !srcDef?.codegenUnboxed) return undefined;

  let vec = ensurePureUnboxed(s, srcNode, srcPin.id);
  if (!vec) return undefined;

  if (s.sharedInputNodes.has(node.id) && vec.setup) {
    vec = memoUnboxedVector(s, `in:${node.id}:${dataPin.id}`, vec);
  }

  // Non-pure (statement) consumers record traced/breakpoint reads lazily only when observing.
  if ((s.traceExecution || s.checkBreakpoints) && !isPureNode(s.options.registry.get(node.typeId), node)) {
    const ids = `${JSON.stringify(node.id)}, ${JSON.stringify(dataPin.id)}`;
    const boxed = boxComponentsLiteral(vec);
    const probes: string[] = [];
    if (s.checkBreakpoints) probes.push(`(__bp !== null && __bp.read(${ids}, ${boxed}))`);
    if (s.traceExecution) probes.push(`(__dbg !== null && __dbg.read(${ids}, ${boxed}))`);
    vec = { ...vec, setup: joinSetup(vec.setup, probes.join(", ")) };
  }
  return vec;
}

function ensurePureUnboxed(s: CodegenState, node: GraphNode, pinId: string): UnboxedVector | undefined {
  const key = `${node.id}:${pinId}`;
  if (s.unboxedCache.has(key)) return s.unboxedCache.get(key) ?? undefined;
  if (s.shouldStrip(node) || s.unboxedInProgress.has(node.id)) return undefined;
  const def = s.options.registry.get(node.typeId);
  if (!def || !isPureNode(def, node) || !def.codegenUnboxed) return undefined;

  const subjects = subjectPinsOf(node, s.options.registry, s.options.className);
  s.unboxedInProgress.add(node.id);
  let result: Record<string, UnboxedVector> | undefined;
  let subjectArgs: string[];
  let guardNames: string[];
  try {
    subjectArgs = subjects.map((subject) => inputExpression(s, node, subject.pin));
    guardNames = subjects.map(() => allocGuardTemp(s));
    const bound = new Map(subjects.map((subject, i) => [subject.pin.id, guardNames[i]!] as const));
    const boundArgs = new Map(subjectArgs.map((arg, i) => [guardNames[i]!, arg] as const));
    result = def.codegenUnboxed(makeCtx(s, node, undefined, undefined, bound, undefined, boundArgs));
  } finally {
    s.unboxedInProgress.delete(node.id);
  }
  if (!result) {
    s.unboxedCache.set(key, null);
    return undefined;
  }

  for (const [name, rawVec] of Object.entries(result)) {
    const outPin = pinForCodegen(node, name, "out");
    if (!outPin) continue;
    let vec = rawVec;
    if (subjects.length > 0) {
      const location = accessLocation(s, node);
      const binds = subjectArgs.map((arg, i) => `${guardNames[i]} = (${arg})`).join(", ");
      const report = subjects
        .map((subject, i) => {
          const g = guardNames[i];
          return `(${g} == null ? ctx.nullAccess(${JSON.stringify(subject.message)}) : ${g}.destroyed === true && ctx.destroyedAccess(${location}, ${g}))`;
        })
        .join(", ");
      const anyDead = guardNames.map((g) => deadReference(g)).join(" || ");
      const axes = vec.kind === "vec2" ? (["x", "y"] as const)
        : vec.kind === "vec3" ? (["x", "y", "z"] as const)
          : (["x", "y", "z", "w"] as const);
      const temps = axes.map(() => allocScalarTemp(s));
      const fallbacks = axes.map((axis) => (vec.kind === "quat" && axis === "w" ? "1" : "0"));
      const deadAssigns = temps.map((t, i) => `${t} = ${fallbacks[i]}`).join(", ");
      const liveAssigns = temps.map((t, i) => `${t} = ${(vec as Record<string, string>)[axes[i]!]}`).join(", ");
      const liveBranch = vec.setup ? `(${vec.setup}, ${liveAssigns})` : `(${liveAssigns})`;
      const guardedSetup = `(${binds}, ${anyDead} ? (${report}, ${deadAssigns}) : ${liveBranch})`;
      vec = vec.kind === "vec2"
        ? { kind: "vec2", x: temps[0]!, y: temps[1]!, setup: guardedSetup }
        : vec.kind === "vec3"
          ? { kind: "vec3", x: temps[0]!, y: temps[1]!, z: temps[2]!, setup: guardedSetup }
          : { kind: vec.kind, x: temps[0]!, y: temps[1]!, z: temps[2]!, w: temps[3]!, setup: guardedSetup };
    }
    if (s.sharedOutputs.has(`${node.id}:${outPin.id}`) && !s.pureExpressions.isConstant(node, outPin)) {
      vec = memoUnboxedVector(s, `out:${node.id}:${outPin.id}`, vec);
    }
    if (s.traceExecution) {
      const trace = `(__dbg !== null && __dbg.write(${JSON.stringify(node.id)}, ${JSON.stringify(outPin.id)}, ${boxComponentsLiteral(vec)}))`;
      vec = { ...vec, setup: joinSetup(vec.setup, trace) };
    }
    s.unboxedCache.set(`${node.id}:${outPin.id}`, vec);
  }
  return s.unboxedCache.get(key) ?? undefined;
}

function referenceExpr(s: CodegenState, node: GraphNode, pinName: string): string {
  const targetPin = pinForCodegen(node, pinName, "in");
  const edge = targetPin && s.index.incoming(node.id, targetPin.id);
  const source = edge && s.index.node(edge.sourceNodeId);
  const sourcePin = source && edge && findPin(source, edge.sourcePinId);
  // A wildcard reference input (Set By-Ref Var) takes its type from the variable wired to it.
  const typed = targetPin?.type.kind === "resolvingWildcard" || (sourcePin && targetPin && pinTypeEquals(sourcePin.type, targetPin.type));
  if (!source || !sourcePin || !targetPin || s.shouldStrip(source) ||
      !typed || !isWritableVariableOutput(source, sourcePin)) return "null";
  // A Pass-By-Reference input forwards the reference its caller passed.
  if (isByReferenceFunctionInput(source, sourcePin)) return byReferenceArgument(sourcePin.id);
  const name = String(source.properties.variableName ?? "Value").trim() || "Value";
  if (source.properties.scope === "local") {
    const local = localVariableIdent(name);
    const reference = `__ref_${local}`;
    s.outputDecls.set(reference, `  const ${reference} = { identity: {}, property: ${JSON.stringify(name)}, get: () => ${local}, set: value => { ${local} = value; } };`);
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
  if (!source || s.shouldStrip(source) || !isPureNode(s.options.registry.get(source.typeId), source)) {
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
  if ((!s.traceExecution && !s.checkBreakpoints) || isPureNode(s.options.registry.get(node.typeId), node)) return expression;
  const edge = s.index.incoming(node.id, p.id);
  if (!edge || !s.index.node(edge.sourceNodeId)) return expression;
  const ids = `${JSON.stringify(node.id)}, ${JSON.stringify(p.id)}`;
  const checked = s.checkBreakpoints ? `__bv(__bp, ${ids}, ${expression})` : expression;
  return s.traceExecution ? `__dv(__dbg, ${ids}, ${checked})` : checked;
}

/**
 * `bound` names the variables that already hold a node's subject inputs.
 * `boundArgs` gives a pure node's bound names their expressions: a shared
 * value is memoized outside the guard that binds them.
 */
export function makeCtx(s: CodegenState, node: GraphNode, continuation?: (expression: string) => void,
  branch?: (expression: string, truePin: string, falsePin: string) => void,
  bound?: ReadonlyMap<string, string>,
  runOutput?: (expression: string, pinId: string) => void,
  boundArgs?: ReadonlyMap<string, string>,
  usedOutputs?: Set<string>): CodegenContext {
  // Every node's code generation starts here, so whatever reaches the module is recorded.
  const definition = s.options.registry.get(node.typeId);
  const trustGate = trustGateOf(definition, node);
  if (trustGate && definition) s.trustGatedNodes.set(node.id, { nodeId: node.id, kind: trustGate, title: definition.title });
  let loopCheckedThisNode = false;
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
    inputUnboxed(pinName) {
      const p = pinForCodegen(node, pinName, "in");
      if (!p || bound?.has(p.id)) return undefined;
      return inputUnboxedExpr(s, node, p);
    },
    isWired(pinId) { return s.index.incoming(node.id, pinId) !== undefined; },
    isOutputWired(pinId) {
      if (s.traceExecution || s.checkBreakpoints) return true;
      return s.index.outgoing(node.id).some((edge) => edge.sourcePinId === pinId);
    },
    poolConstant(literal) { return poolFrozenConstant(s, literal); },
    allocTemp() { return allocScalarTemp(s); },
    isLinearSelfUpdate: s.linearSelfUpdates.has(node.id),
    mustShareContainer: s.sharedContainerReads.has(node.id),
    reference(pinName) { return referenceExpr(s, node, pinName); },
    shared(expression) {
      // With one wired output there is nothing to share.
      if (!s.sharedInputNodes.has(node.id)) return expression;
      // The memo is evaluated lazily, inside the guard, so it may read the subject again.
      const unbound = boundArgs?.size
        ? expression.replace(/\b__s\d+\b/g, (name) => boundArgs.get(name) ?? name)
        : expression;
      return memoExpression(s, `shared:${node.id}:${unbound}`, unbound);
    },
    continueIf(expression) { continuation?.(expression); },
    branch(expression, truePin, falsePin) { branch?.(expression, truePin, falsePin); },
    ...(runOutput ? { runOutputIf(expression: string, pinId: string) { runOutput(expression, pinId); } } : {}),
    inputType(pinName) {
      const p = pinForCodegen(node, pinName, "in");
      return p ? wiredSourceType(s.index, node, p.id, s.shouldStrip) : undefined;
    },
    output(pinName) {
      const p = pinForCodegen(node, pinName, "out");
      const slotKey = p?.id ?? pinName;
      if (p) usedOutputs?.add(p.id);
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
      if (s.instrumentLoops && !loopCheckedThisNode) {
        loopCheckedThisNode = true;
        emitBody(s, `  ${loopCheck(s, anchor.nodeId)}`, anchor);
      }
      emitBody(s, `  ${statement}`, anchor);
    },
    hoist(source, bodyAnchors) {
      // Only an authored body can loop without end, and only its function takes `ctx`: a guard
      // in a module-scope helper would name a `ctx` that is not in scope there.
      const next = s.instrumentLoops && (bodyAnchors?.length ?? 0) > 0
        ? instrumentJsLoops(source, loopCheck(s, node.id, false))
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
  if (!def || !isPureNode(def, node)) return;
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
  let guardNames: string[];
  try {
    // Read in progress: a pure cycle through a subject input ends here.
    subjectArgs = subjects.map((subject) => inputExpression(s, node, subject.pin));
    guardNames = subjects.map(() => allocGuardTemp(s));
    const bound = new Map(subjects.map((subject, i) => [subject.pin.id, guardNames[i]!] as const));
    const boundArgs = new Map(subjectArgs.map((arg, i) => [guardNames[i]!, arg] as const));
    result = def.codegen(makeCtx(s, node, undefined, undefined, bound, undefined, boundArgs));
  } finally {
    s.pureInProgress.delete(node.id);
  }
  if (result && typeof result === "object") {
    for (const [name, expr] of Object.entries(result)) {
      const outPin = pinForCodegen(node, name, "out");
      if (!outPin) continue;
      const guarded = subjects.length > 0
        ? guardPureExpression(subjects, subjectArgs, expr, pooledDefault(s, outPin.type), accessLocation(s, node), guardNames)
        : expr;
      // An output several wires read is evaluated once per statement, as the inputs of a node
      // with several outputs are: every reader of one exec node sees one value (a Random Float
      // wired to both inputs of an Add is one number), and a chain that fans out and joins again
      // costs one evaluation per node instead of one per path. A constant needs no memo, and
      // neither does a plain read (`ctx.deltaSeconds`, an output slot), which costs less.
      const memoized = s.sharedOutputs.has(`${node.id}:${outPin.id}`) &&
        !PLAIN_READ.test(guarded) && !s.pureExpressions.isConstant(node, outPin);
      const expression = memoized
        ? memoExpression(s, `out:${node.id}:${outPin.id}`, guarded)
        : s.pureExpressions.expression(node, outPin, guarded);
      s.exprCache.set(`${node.id}:${outPin.id}`, tracedPureOutput(s, node, outPin, expression));
    }
  }
}
