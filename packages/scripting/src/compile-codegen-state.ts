import { generatedCommentText, type TrustGatedNode } from "@haptic/core";
import type { GraphNode, LogicGraph } from "./ir";
import { findPin } from "./ir";
import { isPureNode, type HoistBodyAnchor, type UnboxedVector } from "./node-registry";
import { isDevelopmentOnlyNode } from "./development-only";
import { createPureExpressions } from "./pure-expressions";
import { subjectAccessOf } from "./compile-pin-values";
import type { CompileAnchor, CompileOptions } from "./compile-types";
import { collapseReroutes } from "./reroute";
import {
  execSuccessorEdges,
  indexGraph,
  withResolvedPinTypes,
  type ExecTarget,
  type GraphIndex,
} from "./compile-graph-index";

export type HoistChunk = {
  source: string;
  nodeId: string;
  bodyAnchors?: readonly HoistBodyAnchor[];
};

export type BodyLine = {
  text: string;
  anchor?: Omit<CompileAnchor, "line">;
  /** A line that only starts a statement epoch; dropped when the entry reads no memo. */
  epoch?: boolean;
};
/** A line that starts an epoch inline: `fragment` becomes `plain` when the entry reads no memo. */
export type EpochFragment = { line: BodyLine; fragment: string; plain: string };
export type ExecScope = { label: string; opening: BodyLine; repeats: boolean };
export type ExecPath = Map<string, ExecScope>;
/** A loop Break can leave; its opening gains a label once a Break uses it. */
export type LoopFrame = { label: string; opening: BodyLine; labeled?: boolean };

/**
 * Follows exec wires into their chains. compile-exec-chain passes its own, so
 * the flow modules that call it never import that module.
 */
export type EmitAlong = (s: CodegenState, edges: ExecTarget[], visited: ExecPath) => void;

/**
 * compileGraph's code generation state. `nextLabel`, `hoisted`, `loopStack`
 * and `pureInProgress` span the whole module; `beginEntry` resets the
 * per-entry fields before each entry point.
 */
export type CodegenState = {
  /** The compiled graph with its wildcard pin types resolved. */
  readonly graph: LogicGraph;
  readonly index: GraphIndex;
  readonly options: CompileOptions;
  readonly hoisted: HoistChunk[];
  /** Module-scope location constant per node a loop guard names, so a guard allocates nothing. */
  readonly loopLocations: Map<string, string>;
  /** Nodes whose destroyed-access location constant is hoisted. */
  readonly accessLocations: Set<string>;
  /** Deduplicated module-scope frozen constants (`literal -> var name`). */
  readonly constPool: Map<string, string>;
  /** Deduplicated module-scope hoisted pure helper expressions (`expression -> var name`). */
  readonly hoistedPureHelpers: Map<string, string>;
  /** True when the graph contains an ExecuteJavaScript node (disables shared empty Map sentinel). */
  readonly hasExecuteJavaScript: boolean;
  /** Container mutator node ids proven to be linear self-updates (`SetVar(v, Mutate(GetVar(v)))`). */
  readonly linearSelfUpdates: ReadonlySet<string>;
  /** `variables.get` node ids reading an array/map whose value escapes and must be marked shared. */
  readonly sharedContainerReads: ReadonlySet<string>;
  readonly body: BodyLine[];
  readonly loopStack: LoopFrame[];
  nextLabel: number;
  readonly shouldStrip: (node: GraphNode) => boolean;
  readonly instrumentLoops: boolean;
  /** True when the current entry emitted at least one inline loop-guard check referencing `__lg`. */
  usesLoopGuard: boolean;
  readonly traceExecution: boolean;
  /**
   * Breakpoint probes run for every instance: `__bp` is the graph's breakpoints, null when it has none.
   * In a graph with breakpoints the values exec nodes read and produce also reach `__bp`, which
   * checks a breakpoint's condition against them.
   */
  readonly checkBreakpoints: boolean;
  /** The event or function entry the exec chain being emitted starts from, for breakpoint hits. */
  entryNodeId: string;
  readonly exprCache: Map<string, string>;
  /** Unboxed scalar outputs per `<nodeId>:<pinId>`, reset per entry. */
  readonly unboxedCache: Map<string, UnboxedVector | null>;
  /** Pure nodes whose unboxed codegen is running (cycle guard). */
  readonly unboxedInProgress: Set<string>;
  /** Monotonic per-entry counter for subject guard temps (`__s0`, …). */
  nextGuardTemp: number;
  /** Monotonic per-entry counter for unboxed scalar temps (`__u0`, …). */
  nextScalarTemp: number;
  /** Pure nodes whose codegen is running; a re-entry is a pure cycle. */
  readonly pureInProgress: Set<string>;
  pureExpressions: ReturnType<typeof createPureExpressions>;
  /**
   * Pure nodes with two or more wired data outputs. Each output expression
   * reads the node's inputs, so a wired pure input is memoized per executing
   * statement: outputs used by one statement see one evaluation of it.
   */
  readonly sharedInputNodes: ReadonlySet<string>;
  /**
   * Pure data outputs (`<node id>:<pin id>`) that two or more wires read. Each is memoized per
   * executing statement, so its readers see one evaluation of it.
   */
  readonly sharedOutputs: ReadonlySet<string>;
  /**
   * Statement-scoped memos: each holds the value computed during the current
   * `__stmt` epoch. Every emitted exec node, each While Loop condition check
   * and each For Loop bound check after the first starts a new epoch.
   * Declared per entry point, and only when the entry reads them
   * (`entryDeclarations`).
   */
  memoDecls: string[];
  readonly memoByKey: Map<string, string>;
  readonly memoUnboxedByKey: Map<string, UnboxedVector>;
  useEpoch: boolean;
  /** Loop headers that start an epoch inline, for `entryDeclarations` to undo. */
  readonly epochFragments: EpochFragment[];
  /**
   * Impure output slots are declared once at the top of the entry point so a
   * node emitted under several exec branches neither redeclares them nor
   * traps its results inside a block scope.
   */
  readonly outputDecls: Map<string, string>;
  isAsync: boolean;
  /**
   * Trust-gated nodes (`NodeDefinition.trustGate`) that code generation reached, by node id: exactly
   * the gated code this module carries (`CompileResult.trustGatedNodes`).
   */
  readonly trustGatedNodes: Map<string, TrustGatedNode>;
};

/**
 * Collapses Reroutes and resolves wildcard pin types first, so no generator sees the authored
 * graph: a wire through Reroutes compiles as a direct wire.
 */
export function createCodegenState(
  graph: LogicGraph,
  options: CompileOptions,
): CodegenState {
  graph = withResolvedPinTypes(collapseReroutes(graph));
  const index = indexGraph(graph);
  const hasExecuteJavaScript = graph.nodes.some((node) => node.typeId === "debug.executeJavaScript");
  const { linearSelfUpdates, sharedContainerReads } = analyzeContainerOwnership(graph, index);
  const hoisted: HoistChunk[] = [];
  const hoistedPureHelpers = new Map<string, string>();
  const hoistPureHelper = (namePrefix: string, source: string): string => {
    const existing = hoistedPureHelpers.get(source);
    if (existing) return existing;
    const name = `${namePrefix}_${identifierSafe(graph.id)}_${hoistedPureHelpers.size}`;
    hoistedPureHelpers.set(source, name);
    hoisted.push({ nodeId: "", source: source.replaceAll("__NAME__", name) });
    return name;
  };
  return {
    graph,
    index,
    options,
    hoisted,
    loopLocations: new Map(),
    accessLocations: new Set(),
    constPool: new Map(),
    hoistedPureHelpers,
    hasExecuteJavaScript,
    linearSelfUpdates,
    sharedContainerReads,
    body: [],
    loopStack: [],
    nextLabel: 0,
    shouldStrip: (node: GraphNode) =>
      options.stripDevelopmentOnly === true && isDevelopmentOnlyNode(node),
    instrumentLoops: options.instrumentInfiniteLoops === true,
    usesLoopGuard: false,
    traceExecution:
      options.instrumentExecutionTrace === true && options.stripDevelopmentOnly !== true,
    checkBreakpoints:
      options.instrumentExecutionTrace === true && options.stripDevelopmentOnly !== true,
    entryNodeId: "",
    exprCache: new Map<string, string>(),
    unboxedCache: new Map<string, UnboxedVector | null>(),
    unboxedInProgress: new Set<string>(),
    nextGuardTemp: 0,
    nextScalarTemp: 0,
    pureInProgress: new Set<string>(),
    pureExpressions: createPureExpressions(graph, options.registry, hoistPureHelper),
    sharedInputNodes: new Set(
      graph.nodes
        .filter((node) => {
          if (!isPureNode(options.registry.get(node.typeId), node)) return false;
          const wired = new Set(
            index.outgoing(node.id)
              .filter((edge) => findPin(node, edge.sourcePinId)?.kind === "data")
              .map((edge) => edge.sourcePinId),
          );
          return wired.size >= 2;
        })
        .map((node) => node.id),
    ),
    sharedOutputs: sharedPureOutputs(graph, index, options),
    memoDecls: [],
    memoByKey: new Map<string, string>(),
    memoUnboxedByKey: new Map<string, UnboxedVector>(),
    useEpoch: false,
    epochFragments: [],
    outputDecls: new Map<string, string>(),
    isAsync: false,
    trustGatedNodes: new Map<string, TrustGatedNode>(),
  };
}

/** Container mutators that support copy-on-write in-place mutation on linear self-updates. */
const COW_PURE_MUTATORS: Readonly<Record<string, string>> = {
  "array.append": "array",
  "array.appendArray": "array",
};
const COW_EXEC_MUTATORS: Readonly<Record<string, string>> = {
  "array.set": "array",
  "array.insert": "array",
  "array.removeIndex": "array",
  "array.removeItem": "array",
  "map.set": "map",
  "map.remove": "map",
};
/** Nodes that only inspect (or clone) a container pin without retaining an alias to it. */
const NON_ESCAPING_CONTAINER_CONSUMERS: Readonly<Record<string, ReadonlySet<string>>> = {
  "array.length": new Set(["array"]),
  "array.isEmpty": new Set(["array"]),
  "array.lastIndex": new Set(["array"]),
  "array.get": new Set(["array"]),
  "array.isValidIndex": new Set(["array"]),
  "array.contains": new Set(["array"]),
  "array.find": new Set(["array"]),
  "array.first": new Set(["array"]),
  "array.last": new Set(["array"]),
  "array.slice": new Set(["array"]),
  "array.reverse": new Set(["array"]),
  "array.append": new Set(["array"]),
  "array.appendArray": new Set(["array", "other"]),
  "array.set": new Set(["array"]),
  "array.insert": new Set(["array"]),
  "array.removeIndex": new Set(["array"]),
  "array.removeItem": new Set(["array"]),
  "array.clear": new Set(["array"]),
  "map.size": new Set(["map"]),
  "map.isEmpty": new Set(["map"]),
  "map.has": new Set(["map"]),
  "map.get": new Set(["map"]),
  "map.keys": new Set(["map"]),
  "map.values": new Set(["map"]),
  "map.break": new Set(["map"]),
  "map.set": new Set(["map"]),
  "map.remove": new Set(["map"]),
  "map.clear": new Set(["map"]),
};

function variableIdentityKey(node: GraphNode): string | undefined {
  if (node.typeId !== "variables.get" && node.typeId !== "variables.set") return undefined;
  if (typeof node.properties.componentId === "string" && node.properties.componentId.length > 0) return undefined;
  const name = typeof node.properties.variableName === "string" && node.properties.variableName.trim()
    ? node.properties.variableName.trim()
    : "Value";
  if (node.properties.scope === "local") return `local:${name}`;
  if (node.properties.implicitSelf !== true) return undefined;
  const propertyKey = typeof node.properties.propertyKey === "string" && node.properties.propertyKey.length > 0
    ? node.properties.propertyKey
    : name;
  return `self:${propertyKey}`;
}

/**
 * Identifies linear container self-updates (`SetVar(v, Mutate(GetVar(v), ...))`)
 * and `variables.get` reads of containers whose references escape to non-observer nodes.
 */
function analyzeContainerOwnership(
  graph: LogicGraph,
  index: GraphIndex,
): { linearSelfUpdates: Set<string>; sharedContainerReads: Set<string> } {
  const linearSelfUpdates = new Set<string>();
  const linearReadNodes = new Set<string>();

  for (const node of graph.nodes) {
    const purePin = COW_PURE_MUTATORS[node.typeId];
    const execPin = COW_EXEC_MUTATORS[node.typeId];
    const containerPin = purePin ?? execPin;
    if (!containerPin) continue;

    // Input container must come directly from a local or implicitSelf `variables.get`.
    const inEdge = index.incoming(node.id, containerPin);
    if (!inEdge) continue;
    const getter = index.node(inEdge.sourceNodeId);
    if (!getter || getter.typeId !== "variables.get") continue;
    const getVarKey = variableIdentityKey(getter);
    if (!getVarKey) continue;

    // Getter must only feed this mutator's container pin (no other consumer can alias it).
    const getterOuts = index.outgoing(getter.id).filter((edge) => edge.sourcePinId === "value");
    if (getterOuts.length !== 1 || getterOuts[0]!.targetNodeId !== node.id || getterOuts[0]!.targetPinId !== containerPin) {
      continue;
    }

    // Mutator's `out` must feed a single `variables.set` writing back to the exact same variable,
    // and that `variables.set`'s `out` must be unwired (no downstream alias).
    const mutOuts = index.outgoing(node.id).filter((edge) => edge.sourcePinId === "out");
    if (mutOuts.length !== 1 || mutOuts[0]!.targetPinId !== "value") continue;
    const setter = index.node(mutOuts[0]!.targetNodeId);
    if (!setter || setter.typeId !== "variables.set") continue;
    if (variableIdentityKey(setter) !== getVarKey) continue;
    const setterOuts = index.outgoing(setter.id).filter((edge) => edge.sourcePinId === "out");
    if (setterOuts.length > 0) continue;

    // For exec mutators, exec flow must run directly from the mutator into the setter.
    if (execPin !== undefined) {
      const nextExec = execSuccessorEdges(index, node.id);
      if (nextExec.length !== 1 || nextExec[0]!.targetNodeId !== setter.id) continue;
    }

    linearSelfUpdates.add(node.id);
    linearReadNodes.add(getter.id);
  }

  const sharedContainerReads = new Set<string>();
  for (const node of graph.nodes) {
    if (node.typeId !== "variables.get") continue;
    if (linearReadNodes.has(node.id)) continue;
    const outPin = findPin(node, "value");
    if (!outPin || (outPin.type.kind !== "array" && outPin.type.kind !== "map")) continue;
    const outs = index.outgoing(node.id).filter((edge) => edge.sourcePinId === "value");
    const escapes = outs.some((edge) => {
      const target = index.node(edge.targetNodeId);
      if (!target) return true;
      const safePins = NON_ESCAPING_CONTAINER_CONSUMERS[target.typeId];
      return !safePins || !safePins.has(edge.targetPinId);
    });
    if (escapes) sharedContainerReads.add(node.id);
  }

  return { linearSelfUpdates, sharedContainerReads };
}

function sharedPureOutputs(graph: LogicGraph, index: GraphIndex, options: CompileOptions): Set<string> {
  const shared = new Set<string>();
  for (const node of graph.nodes) {
    if (!isPureNode(options.registry.get(node.typeId), node)) continue;
    const readers = new Map<string, number>();
    for (const edge of index.outgoing(node.id)) {
      const pin = findPin(node, edge.sourcePinId);
      if (pin?.kind !== "data") continue;
      // A variable's own output stays a live read: a node of the same statement can write it
      // through a reference (a Seeded Random draw moves its Seed on), and a later reader of the
      // statement must see that.
      if (pin.reference === "writable" || pin.byReference === true) continue;
      const count = (readers.get(edge.sourcePinId) ?? 0) + 1;
      readers.set(edge.sourcePinId, count);
      if (count === 2) shared.add(`${node.id}:${edge.sourcePinId}`);
    }
  }
  return shared;
}

/** Resets the per-entry fields before an entry point is emitted. */
export function beginEntry(s: CodegenState): void {
  s.body.length = 0;
  s.outputDecls.clear();
  s.exprCache.clear();
  s.unboxedCache.clear();
  s.unboxedInProgress.clear();
  s.nextGuardTemp = 0;
  s.nextScalarTemp = 0;
  const hoistPureHelper = (namePrefix: string, source: string): string => {
    const existing = s.hoistedPureHelpers.get(source);
    if (existing) return existing;
    const name = `${namePrefix}_${identifierSafe(s.graph.id)}_${s.hoistedPureHelpers.size}`;
    s.hoistedPureHelpers.set(source, name);
    s.hoisted.push({ nodeId: "", source: source.replaceAll("__NAME__", name) });
    return name;
  };
  s.pureExpressions = createPureExpressions(s.graph, s.options.registry, hoistPureHelper);
  s.memoDecls = [];
  s.memoByKey.clear();
  s.memoUnboxedByKey.clear();
  s.epochFragments.length = 0;
  s.isAsync = false;
  s.usesLoopGuard = false;
}

/**
 * Deduplicates an immutable value literal at module scope (`Object.freeze(...)`),
 * returning the hoisted `var` identifier so entry points allocate nothing per call.
 */
export function poolFrozenConstant(s: CodegenState, literal: string): string {
  const existing = s.constPool.get(literal);
  if (existing) return existing;
  const name = `__c_${identifierSafe(s.graph.id)}_${s.constPool.size}`;
  s.constPool.set(literal, name);
  s.hoisted.push({ nodeId: "", source: `var ${name} = Object.freeze(${literal});` });
  return name;
}

/** Module-scope shared empty Map sentinel (used only in graphs without ExecuteJavaScript). */
export function emptyMapSentinel(s: CodegenState): string {
  const key = "__EMPTY_MAP_SENTINEL__";
  const existing = s.constPool.get(key);
  if (existing) return existing;
  const name = `__c_${identifierSafe(s.graph.id)}_${s.constPool.size}`;
  s.constPool.set(key, name);
  s.hoisted.push({ nodeId: "", source: `var ${name} = new Map();` });
  return name;
}

/** Allocates a per-entry scalar temporary name (`__u0`, …), declared only when referenced. */
export function allocScalarTemp(s: CodegenState): string {
  return `__u${s.nextScalarTemp++}`;
}

/** Allocates a per-entry pure-guard temporary name (`__s0`, …), declared only when referenced. */
export function allocGuardTemp(s: CodegenState): string {
  return `__s${s.nextGuardTemp++}`;
}

export function emitBody(
  s: CodegenState,
  text: string,
  anchor?: Omit<CompileAnchor, "line">,
): BodyLine {
  const line = { text, anchor };
  s.body.push(line);
  return line;
}

/**
 * Emit a `/* … *\/` comment line. Node ids and types are asset text, so the comment goes through
 * `generatedCommentText`: nothing in it can end the comment and become code.
 */
export function emitComment(
  s: CodegenState,
  text: string,
  anchor?: Omit<CompileAnchor, "line">,
): BodyLine {
  return emitBody(s, `  /* ${generatedCommentText(text)} */`, anchor);
}

/**
 * Execution-trace probes run only for the observed instance: `__dbg` is its
 * recorder, null for every other instance, so an unobserved probe is one
 * null check. Probe text never allocates and never changes evaluation order.
 */
export function traceProbe(call: string): string {
  return `  if (__dbg !== null) ${call};`;
}

/**
 * The module-scope constant naming where `node` touches its subject and how (`subjectAccessOf`), passed by a
 * destroyed-object report so the report allocates nothing on the path that never fails.
 */
export function accessLocation(s: CodegenState, node: GraphNode): string {
  const name = `__access_${identifierSafe(s.graph.id)}_${identifierSafe(node.id)}`;
  if (!s.accessLocations.has(node.id)) {
    s.accessLocations.add(node.id);
    s.hoisted.push({ nodeId: node.id, source: `var ${name} = Object.freeze(${JSON.stringify({
      assetGuid: s.options.assetGuid, graphId: s.graph.id, nodeId: node.id, ...subjectAccessOf(node, s.options.registry),
    })});` });
  }
  return name;
}

/** `id` as identifier text, one-to-one: every character outside [A-Za-z0-9] becomes `$<hex>$`. */
function identifierSafe(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, (char) => `$${char.charCodeAt(0).toString(16)}$`);
}

export function loopCheck(s: CodegenState, nodeId: string, inlineLocal = true): string {
  let name = s.loopLocations.get(nodeId);
  if (name === undefined) {
    // Unique per graph and node: one module joins the graphs of an asset. `var` lets the same graph's
    // identical declaration repeat.
    name = `__loop_${identifierSafe(s.graph.id)}_${identifierSafe(nodeId)}`;
    s.loopLocations.set(nodeId, name);
    s.hoisted.push({ nodeId, source: `var ${name} = Object.freeze(${JSON.stringify({
      assetGuid: s.options.assetGuid, graphId: s.graph.id, nodeId,
    })});` });
  }
  if (inlineLocal) {
    s.usesLoopGuard = true;
    return `if (__lg === undefined || ++__lg.n > __lg.max) ctx.checkInfiniteLoop(${name});`;
  }
  return `if (ctx.loopGuard === undefined || ++ctx.loopGuard.n > ctx.loopGuard.max) ctx.checkInfiniteLoop(${name});`;
}

/** Starts a statement epoch on a line of its own. */
export function emitEpoch(s: CodegenState): void {
  if (s.useEpoch) emitBody(s, "  __stmt++;").epoch = true;
}

/**
 * `expression` behind an epoch start, for a loop header that checks it once per iteration. The
 * caller passes the line it put the result on to `trackEpochFragment`.
 */
export function epochFragment(s: CodegenState, fragment: string, plain: string): string {
  return s.useEpoch ? fragment : plain;
}

export function trackEpochFragment(s: CodegenState, line: BodyLine, fragment: string, plain: string): void {
  if (s.useEpoch) s.epochFragments.push({ line, fragment, plain });
}

/** Names of memo slots, pure-expression helpers and entry-local temps referenced by `text`. */
const DECLARED_CLOSURE = /(?<![\w$])(__memo_\d+|_pure_\d+)(?:_at|_v|_x|_y|_z|_w)?(?![\w$])/g;
const ENTRY_TEMP = /(?<![\w$])(__s\d+|__u\d+)(?![\w$])/g;

/**
 * The memo, pure-expression and temporary declarations an entry point needs: those its statements
 * reference, and those referenced transitively. Every pure node of the graph is compiled for every
 * entry point, so without this an entry would declare slots for chains it never runs. An entry
 * that reads no memo also loses its epoch counter.
 */
export function entryDeclarations(s: CodegenState): string[] {
  const pure = s.pureExpressions.declarations;
  const declarationOf = (name: string): string | undefined => {
    const index = Number(name.slice(name.lastIndexOf("_") + 1));
    return name.startsWith("__memo_") ? s.memoDecls[index] : pure[index];
  };
  const used = new Set<string>();
  const usedTemps = new Set<string>();
  const pending: string[] = [...s.body.map((line) => line.text), ...s.outputDecls.values()];
  while (pending.length > 0) {
    const text = pending.pop()!;
    for (const match of text.matchAll(ENTRY_TEMP)) {
      usedTemps.add(match[1]!);
    }
    for (const match of text.matchAll(DECLARED_CLOSURE)) {
      const name = match[1]!;
      if (used.has(name)) continue;
      used.add(name);
      const declaration = declarationOf(name);
      if (declaration !== undefined) pending.push(declaration);
    }
  }
  const memos = s.memoDecls.filter((_, index) => used.has(`__memo_${index}`));
  if (memos.length === 0) {
    for (const line of s.body) if (line.epoch) line.text = "";
    for (const { line, fragment, plain } of s.epochFragments) {
      line.text = line.text.replace(fragment, () => plain);
    }
  }
  const tempNames = [...usedTemps].sort();
  return [
    ...(tempNames.length > 0 ? [`  let ${tempNames.join(", ")};`] : []),
    ...pure.filter((_, index) => used.has(`_pure_${index}`)),
    ...(memos.length > 0 ? ["  let __stmt = 0;", ...memos] : []),
  ];
}

/** Max inline memo expression length before falling back to a bounded helper function. */
const INLINE_MEMO_LIMIT = 320;

export function memoExpression(s: CodegenState, key: string, expression: string): string {
  const cached = s.memoByKey.get(key);
  if (cached) return cached;
  const name = `__memo_${s.memoDecls.length}`;
  if (expression.length <= INLINE_MEMO_LIMIT) {
    s.memoDecls.push(`  let ${name}_at = -1, ${name}_v;`);
    const inline = `(${name}_at === __stmt ? ${name}_v : (${name}_v = (${expression}), ${name}_at = __stmt, ${name}_v))`;
    s.memoByKey.set(key, inline);
    return inline;
  }
  s.memoDecls.push(
    `  let ${name}_at = -1, ${name}_v; const ${name} = () => (${name}_at === __stmt ? ${name}_v : (${name}_v = (${expression}), ${name}_at = __stmt, ${name}_v));`,
  );
  const call = `${name}()`;
  s.memoByKey.set(key, call);
  return call;
}

/** Statement-scoped unboxed vector memo: stores scalar components with zero closure or object allocation. */
export function memoUnboxedVector(s: CodegenState, key: string, vec: UnboxedVector): UnboxedVector {
  const cached = s.memoUnboxedByKey.get(key);
  if (cached) return cached;
  const axes = vec.kind === "vec2" ? (["x", "y"] as const)
    : vec.kind === "vec3" ? (["x", "y", "z"] as const)
      : (["x", "y", "z", "w"] as const);
  const name = `__memo_${s.memoDecls.length}`;
  const slots = axes.map((a) => `${name}_${a}`).join(", ");
  s.memoDecls.push(`  let ${name}_at = -1, ${slots};`);
  const assigns = axes.map((a) => `${name}_${a} = ${(vec as Record<string, string>)[a]}`).join(", ");
  const compute = vec.setup ? `(${vec.setup}, ${assigns}, ${name}_at = __stmt)` : `(${assigns}, ${name}_at = __stmt)`;
  const setup = `(${name}_at === __stmt ? 0 : ${compute})`;
  const result: UnboxedVector = vec.kind === "vec2"
    ? { kind: "vec2", x: `${name}_x`, y: `${name}_y`, setup }
    : vec.kind === "vec3"
      ? { kind: "vec3", x: `${name}_x`, y: `${name}_y`, z: `${name}_z`, setup }
      : { kind: vec.kind, x: `${name}_x`, y: `${name}_y`, z: `${name}_z`, w: `${name}_w`, setup };
  s.memoUnboxedByKey.set(key, result);
  return result;
}
