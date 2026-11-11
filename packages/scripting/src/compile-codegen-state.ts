import type { GraphNode, LogicGraph } from "./ir";
import { findPin } from "./ir";
import type { HoistBodyAnchor } from "./node-registry";
import { isDevelopmentOnlyNode } from "./development-only";
import { createPureExpressions } from "./pure-expressions";
import type { CompileAnchor, CompileOptions } from "./compile-types";
import {
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
  readonly body: BodyLine[];
  readonly loopStack: LoopFrame[];
  nextLabel: number;
  readonly shouldStrip: (node: GraphNode) => boolean;
  readonly instrumentLoops: boolean;
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
};

/** Resolves wildcard pin types first, so no generator sees the authored graph. */
export function createCodegenState(
  graph: LogicGraph,
  options: CompileOptions,
): CodegenState {
  graph = withResolvedPinTypes(graph);
  const index = indexGraph(graph);
  return {
    graph,
    index,
    options,
    hoisted: [],
    body: [],
    loopStack: [],
    nextLabel: 0,
    shouldStrip: (node: GraphNode) =>
      options.stripDevelopmentOnly === true && isDevelopmentOnlyNode(node),
    instrumentLoops: options.instrumentInfiniteLoops === true,
    traceExecution:
      options.instrumentExecutionTrace === true && options.stripDevelopmentOnly !== true,
    checkBreakpoints:
      options.instrumentExecutionTrace === true && options.stripDevelopmentOnly !== true,
    entryNodeId: "",
    exprCache: new Map<string, string>(),
    pureInProgress: new Set<string>(),
    pureExpressions: createPureExpressions(graph, options.registry),
    sharedInputNodes: new Set(
      graph.nodes
        .filter((node) => {
          if (!options.registry.get(node.typeId)?.pure) return false;
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
    useEpoch: false,
    epochFragments: [],
    outputDecls: new Map<string, string>(),
    isAsync: false,
  };
}

function sharedPureOutputs(graph: LogicGraph, index: GraphIndex, options: CompileOptions): Set<string> {
  const shared = new Set<string>();
  for (const node of graph.nodes) {
    if (!options.registry.get(node.typeId)?.pure) continue;
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
  s.pureExpressions = createPureExpressions(s.graph, s.options.registry);
  s.memoDecls = [];
  s.memoByKey.clear();
  s.epochFragments.length = 0;
  s.isAsync = false;
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
 * Execution-trace probes run only for the observed instance: `__dbg` is its
 * recorder, null for every other instance, so an unobserved probe is one
 * null check. Probe text never allocates and never changes evaluation order.
 */
export function traceProbe(call: string): string {
  return `  if (__dbg !== null) ${call};`;
}

export function loopCheck(s: CodegenState, nodeId: string): string {
  return `ctx.checkInfiniteLoop(${JSON.stringify({
    assetGuid: s.options.assetGuid, graphId: s.graph.id, nodeId,
  })});`;
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

/** Names of the memo and pure-expression closures `text` calls. */
const DECLARED_CLOSURE = /(?<![\w$])(__memo_\d+|_pure_\d+)(?![\w$])/g;

/**
 * The memo and pure-expression declarations an entry point needs: those its statements call, and
 * those these call in turn. Every pure node of the graph is compiled for every entry point, so
 * without this an entry would build the closures of chains it never runs on each call. An entry
 * that reads no memo also loses its epoch counter.
 */
export function entryDeclarations(s: CodegenState): string[] {
  const pure = s.pureExpressions.declarations;
  const declarationOf = (name: string): string | undefined => {
    const index = Number(name.slice(name.lastIndexOf("_") + 1));
    return name.startsWith("__memo_") ? s.memoDecls[index] : pure[index];
  };
  const used = new Set<string>();
  const pending: string[] = [...s.body.map((line) => line.text), ...s.outputDecls.values()];
  while (pending.length > 0) {
    for (const match of pending.pop()!.matchAll(DECLARED_CLOSURE)) {
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
  return [
    ...pure.filter((_, index) => used.has(`_pure_${index}`)),
    ...(memos.length > 0 ? ["  let __stmt = 0;", ...memos] : []),
  ];
}

export function memoExpression(s: CodegenState, key: string, expression: string): string {
  const cached = s.memoByKey.get(key);
  if (cached) return cached;
  const name = `__memo_${s.memoDecls.length}`;
  s.memoDecls.push(
    `  let ${name}_at = -1, ${name}_v; const ${name} = () => (${name}_at === __stmt ? ${name}_v : (${name}_v = (${expression}), ${name}_at = __stmt, ${name}_v));`,
  );
  const call = `${name}()`;
  s.memoByKey.set(key, call);
  return call;
}
