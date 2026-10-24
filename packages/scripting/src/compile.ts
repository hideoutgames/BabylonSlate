import type { LogicGraph, GraphEdge, GraphNode, GraphPin } from "./ir";
import { findPin } from "./ir";
import type {
  NodeRegistry,
  NodeDefinition,
  CodegenContext,
  HoistBodyAnchor,
} from "./node-registry";
import { defaultValueLiteral, pinTypeEquals, type PinType } from "./types";
import { pinTypeKey, resolveWildcardPinTypes } from "./wildcard-resolve";
import { pinRejectsStoredDefault, readPinDefaultForPin } from "./pin-defaults";
import { isDevelopmentOnlyNode } from "./development-only";
import { createPureExpressions } from "./pure-expressions";
import { instrumentJsLoops } from "@haptic/debugger";
import { entryNodes } from "./compiled-nodes";
import { isWritableVariableOutput } from "./variable-references";
import { enumSwitchMemberNameFromPinId } from "./enum-switch-pins";
import { flowSwitchCaseValueFromPinId } from "./flow-switch-pins";
import { humanizePropertyLabel, normalizeTag, normalizeTagContainer, type TagRegistry } from "@haptic/core";
import { tagCasesConstant, tagCasesOf, tagCasePinId, tagRuntimeSource } from "./tags";
import {
  isFlowSwitchMeta,
  isLoopMeta,
  type StructuredFlowMeta,
} from "./structured-flow";

export type CompileAnchor = {
  line: number;
  column: number;
  assetGuid: string;
  graphId: string;
  nodeId: string;
  bodyLine?: number;
};

/** Lifecycle events an entry node can bind to at runtime. */
export type ScriptEventName =
  "onBeginPlay" | "onTick" | "onCommandRun" | string;

export const EVENT_BY_TYPE_ID: Record<string, ScriptEventName> = {
  "flow.event.beginPlay": "onBeginPlay",
  "flow.event.scalabilityChanged": "onScalabilityChanged",
  "flow.event.gameLoaded": "onGameLoaded",
  "flow.event.saveMigration": "onSaveMigration",
  "flow.event.tick": "onTick",
  "flow.event.destroyed": "onDestroyed",
  "flow.event.init": "onInit",
  "flow.event.end": "onEnd",
  "flow.event.firstSceneLoaded": "onFirstSceneLoaded",
  "flow.event.sceneStartLoading": "onSceneStartLoading",
  "flow.event.sceneFinishLoading": "onSceneFinishLoading",
  "flow.event.sceneExit": "onSceneExit",
  "flow.event.sceneLoaded": "onSceneLoaded",
  "flow.event.streamedSceneLoaded": "onStreamedSceneLoaded",
  "flow.event.streamedSceneUnloaded": "onStreamedSceneUnloaded",
  "flow.event.sceneLayerAdded": "onSceneLayerAdded",
  "flow.event.sceneLayerRemoved": "onSceneLayerRemoved",
  "flow.event.sceneActorSpawned": "onSceneActorSpawned",
  "flow.event.sceneActorDestroyed": "onSceneActorDestroyed",
  "flow.event.hit": "onHit",
  "flow.event.beginOverlap": "onBeginOverlap",
  "flow.event.endOverlap": "onEndOverlap",
  "flow.event.commandRun": "onCommandRun",
  "flow.event.editorBeginPlay": "onEditorBeginPlay",
  "flow.event.editorStartup": "onEditorStartup",
  "flow.event.sceneOpen": "onSceneOpen",
  "flow.event.sceneSaved": "onSceneSaved",
  "flow.event.editorShutdown": "onEditorShutdown",
  "flow.event.onMouseEnter": "onMouseEnter",
  "flow.event.onMouseLeave": "onMouseLeave",
  "flow.event.onClick": "onClick",
  "flow.event.onPressStart": "onPressStart",
  "flow.event.onPressEnd": "onPressEnd",
  "flow.event.textChanged": "onTextChanged",
  "flow.event.focusEnter": "onFocusEnter",
  "flow.event.focusLeave": "onFocusLeave",
  "flow.event.focusActivate": "onFocusActivate",
  "flow.event.uiValueChanged": "onUIValueChanged",
  "flow.event.uiRangeChanged": "onUIRangeChanged",
  "flow.event.uiCheckedChanged": "onUICheckedChanged",
  "flow.event.uiTextChanged": "onUITextChanged",
  "flow.event.uiTextSubmitted": "onUITextSubmitted",
  "flow.event.uiSelectionChanged": "onUISelectionChanged",
  "flow.event.sceneLayerActorSwitching": "onSceneLayerActorSwitching",
  "flow.event.sceneLayerActorSwitched": "onSceneLayerActorSwitched",
  "flow.event.sceneLayerActorSwitchedTo": "onSceneLayerActorSwitchedTo",
  "flow.event.sceneLayerActorSwitchedFrom": "onSceneLayerActorSwitchedFrom",
  "flow.event.audioFinished": "onAudioFinished",
  "flow.event.movementStarted": "onMovementStarted",
  "flow.event.movementStopped": "onMovementStopped",
  "flow.event.movementJumped": "onMovementJumped",
  "flow.event.movementLeftGround": "onMovementLeftGround",
  "flow.event.movementLanded": "onMovementLanded",
  "bt.event.activate": "onActivate",
  "bt.event.tick": "onBtTick",
  "bt.event.abort": "onAbort",
  "bt.event.evaluate": "onEvaluate",
  "anim.event.initialize": "onInitializeAnimation",
  "anim.event.update": "onUpdateAnimation",
  // Input event entries gate internally; they run on the tick like Event Tick.
  "input.actionEvent": "onTick",
  "input.axisEvent": "onTick",
  "input.onAnyKeyPressed": "onTick",
  "input.onGamepadConnected": "onTick",
  "input.onGamepadDisconnected": "onTick",
  "input.onTouchBegan": "onTick",
  "input.onTouchMoved": "onTick",
  "input.onTouchEnded": "onTick",
};

/** Touch event nodes and the `engine:TouchPhase` records each one runs for. */
const TOUCH_EVENT_PHASES: Readonly<Record<string, readonly string[]>> = {
  "input.onTouchBegan": ["Began"],
  "input.onTouchMoved": ["Moved"],
  "input.onTouchEnded": ["Ended", "Cancelled"],
};

/** On Touch Began, On Touch Moved and On Touch Ended. */
export function isTouchEventNodeType(typeId: string): boolean {
  return Object.hasOwn(TOUCH_EVENT_PHASES, typeId);
}

/** Custom events use the member name; catalog events use EVENT_BY_TYPE_ID. */
export function eventNameForEntry(
  entry: Pick<GraphNode, "typeId" | "properties">,
): ScriptEventName | undefined {
  if (entry.typeId === "flow.event.custom") {
    const raw = entry.properties.name;
    return typeof raw === "string" && raw.length > 0 ? jsIdent(raw) : undefined;
  }
  return EVENT_BY_TYPE_ID[entry.typeId];
}

export type CompiledEntryPoint = {
  /** Exported function name. */
  name: string;
  /** Lifecycle event when the entry node is an event node. */
  event?: ScriptEventName;
  /** Entry node id, for diagnostics. */
  nodeId?: string;
  /** The graph the entry node is in, for diagnostics that open it. */
  graphId?: string;
  /** True when the entry point awaits a latent node and must be awaited. */
  isAsync: boolean;
  /** Prefab component id when this entry is bound to an attached component. */
  componentId?: string;
};

export type CompileResult = {
  source: string;
  anchors: CompileAnchor[];
  /** Name of the first exported entry point. */
  exportName: string;
  /** True when any entry point is async. */
  isAsync: boolean;
  entryPoints: CompiledEntryPoint[];
};

export type CompileOptions = {
  assetGuid: string;
  registry: NodeRegistry;
  /**
   * Display name of the class whose graph this is. Null-access errors name it:
   * "Hero: Destroy Actor (Target) tried to access null."
   */
  className?: string;
  /** Project definitions are embedded so numeric Tag matching survives export. */
  tagRegistry?: TagRegistry;
  exportName?: string;
  /**
   * Export compiles omit Development Only nodes (Print defaults on) and
   * continue exec at `then` / Sequence `then_*`. Editor Play leaves this unset.
   */
  stripDevelopmentOnly?: boolean;
  /**
   * Editor / debugger compiles insert `ctx.checkInfiniteLoop()` so Play can
   * abort runaway scripts. Release export leaves this unset.
   */
  instrumentInfiniteLoops?: boolean;
  /**
   * Editor Simulation compiles report what runs for the instance the editor
   * observes (`ctx.debugTrace`): each exec node visit, the exec edge taken, and
   * the values nodes read and produce. An unobserved instance pays one null
   * check per probe. Ignored when `stripDevelopmentOnly` is set, so release
   * exports never carry it.
   */
  instrumentExecutionTrace?: boolean;
  /**
   * Editor Simulation compiles check each exec node against the session's
   * breakpoints (`ctx.breakpoints`), for every instance. With no breakpoint in
   * the graph a check is one null check. Ignored when `stripDevelopmentOnly`
   * is set, so release exports never carry it.
   */
  instrumentBreakpoints?: boolean;
  /** Function-local `let` lines inserted at the start of each export. */
  localPreamble?: string[];
  /**
   * Call Function awaits `invokeFunction` when this returns true for the
   * target class + export name.
   */
  isLatentFunction?: (classId: string, functionName: string) => boolean;
};

function jsIdent(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/** Words a strict-mode module cannot use as a function declaration name. */
const RESERVED_WORDS = new Set([
  "arguments", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "enum", "eval", "export",
  "extends", "false", "finally", "for", "function", "if", "implements",
  "import", "in", "instanceof", "interface", "let", "new", "null", "package",
  "private", "protected", "public", "return", "static", "super", "switch",
  "this", "throw", "true", "try", "typeof", "var", "void", "while", "with",
  "yield",
]);

/** The runtime dispatches events by `CompiledEntryPoint.event`, so only the export is renamed. */
function exportIdent(name: string): string {
  return RESERVED_WORDS.has(name) ? `${name}_` : name;
}

/** Node, incoming and outgoing edge lookups built once per compile. */
type GraphIndex = {
  node(nodeId: string): GraphNode | undefined;
  /** First edge into an input pin, in authored edge order. */
  incoming(nodeId: string, pinId: string): GraphEdge | undefined;
  /** Edges leaving a node, in authored edge order. */
  outgoing(nodeId: string): readonly GraphEdge[];
};

function indexGraph(graph: LogicGraph): GraphIndex {
  const nodes = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  }
  const incoming = new Map<string, GraphEdge>();
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    const key = `${edge.targetNodeId}\0${edge.targetPinId}`;
    if (!incoming.has(key)) incoming.set(key, edge);
    const leaving = outgoing.get(edge.sourceNodeId);
    if (leaving) leaving.push(edge);
    else outgoing.set(edge.sourceNodeId, [edge]);
  }
  return {
    node: (nodeId) => nodes.get(nodeId),
    incoming: (nodeId, pinId) => incoming.get(`${nodeId}\0${pinId}`),
    outgoing: (nodeId) => outgoing.get(nodeId) ?? [],
  };
}

/** Codegen sees concrete pin types; the authored graph keeps its wildcards. */
function withResolvedPinTypes(graph: LogicGraph): LogicGraph {
  const resolved = resolveWildcardPinTypes(graph).resolved;
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      pins: node.pins.map((pin) => ({
        ...pin,
        type: resolved.get(pinTypeKey(node.id, pin.id)) ?? pin.type,
      })),
    })),
  };
}

function isPassthroughExecOut(pin: GraphPin): boolean {
  return (
    pin.kind === "exec" &&
    pin.direction === "out" &&
    (pin.name === "then" || pin.name.startsWith("then_"))
  );
}

/**
 * Skip-as-no-op: continue at `then`, or Sequence `then_*` pins in order.
 * Exclusive Branch true/false (and any other multi-out that is not `then`)
 * are not entered — the stripped node cannot choose an arm.
 */
function stripExecSuccessors(index: GraphIndex, node: GraphNode) {
  const passthrough = node.pins.filter(isPassthroughExecOut);
  if (passthrough.length > 0) {
    return passthrough.flatMap((out) => execSuccessorEdges(index, node.id, out.id));
  }
  const outs = node.pins.filter(
    (pin) => pin.kind === "exec" && pin.direction === "out",
  );
  if (outs.length === 1) {
    return execSuccessorEdges(index, node.id, outs[0]!.id);
  }
  return [];
}

/**
 * Exec outputs named by pin id, or by display name when no pin has that id
 * (generic `then`, `ctx.branch` arms). Ids keep a case such as "Default" or a
 * Title Case label from also matching another pin's name.
 */
function execOutPins(node: GraphNode, pinRef?: string): GraphPin[] {
  const outs = node.pins.filter(
    (pin) => pin.kind === "exec" && pin.direction === "out",
  );
  if (pinRef === undefined) return outs;
  const byId = outs.filter((pin) => pin.id === pinRef);
  return byId.length > 0 ? byId : outs.filter((pin) => pin.name === pinRef);
}

/**
 * Input events whose chain runs only on ticks where the input fired; the
 * trace reports their visit inside the gate, not on every tick.
 */
const GATED_EVENT_TYPE_IDS: ReadonlySet<string> = new Set([
  "input.actionEvent",
  "input.axisEvent",
  "input.onAnyKeyPressed",
  "input.onGamepadConnected",
  "input.onGamepadDisconnected",
  ...Object.keys(TOUCH_EVENT_PHASES),
]);

/** An exec wire followed to its target; `GraphEdge` fits. */
type ExecTarget = { id: string; targetNodeId: string; targetPinId: string };

function execSuccessorEdges(
  index: GraphIndex,
  nodeId: string,
  pinRef?: string,
): ExecTarget[] {
  const node = index.node(nodeId);
  if (!node) return [];
  const leaving = index.outgoing(nodeId);
  const result: ExecTarget[] = [];
  for (const out of execOutPins(node, pinRef)) {
    for (const e of leaving) {
      if (e.sourcePinId === out.id) {
        result.push({
          id: e.id,
          targetNodeId: e.targetNodeId,
          targetPinId: e.targetPinId,
        });
      }
    }
  }
  return result;
}

function entryPinMatches(
  node: GraphNode,
  pinRef: string,
  entryPinId: string | undefined,
): boolean {
  if (!entryPinId) {
    const preferred = pinForCodegen(node, pinRef, "in");
    if (!preferred) return false;
    const execIns = node.pins.filter(
      (p) => p.kind === "exec" && p.direction === "in",
    );
    if (execIns.length <= 1) return true;
    return preferred.id === execIns[0]?.id;
  }
  const pin = findPin(node, entryPinId);
  return !!pin && (pin.id === pinRef || pin.name === pinRef);
}

/** Static type of the pin wired into `pinId`, unless disconnected or stripped. */
function wiredSourceType(
  index: GraphIndex,
  node: GraphNode,
  pinId: string,
  shouldStrip: (node: GraphNode) => boolean,
): PinType | undefined {
  const incoming = index.incoming(node.id, pinId);
  if (!incoming) return undefined;
  const srcNode = index.node(incoming.sourceNodeId);
  const srcPin = srcNode && findPin(srcNode, incoming.sourcePinId);
  if (!srcNode || !srcPin || shouldStrip(srcNode)) return undefined;
  return srcPin.type;
}

function pinForCodegen(
  node: GraphNode,
  pinName: string,
  direction: "in" | "out",
): GraphPin | undefined {
  return (
    node.pins.find(
      (pin) => pin.direction === direction && pin.id === pinName,
    ) ??
    node.pins.find((pin) => pin.direction === direction && pin.name === pinName)
  );
}

function catalogPinDefault(
  node: GraphNode,
  dataPin: GraphPin,
  registry: NodeRegistry,
): unknown {
  if (dataPin.defaultValue !== undefined) return dataPin.defaultValue;
  const def = registry.get(node.typeId);
  if (!def) return undefined;
  const catalogPins = def.pins(node.properties);
  const catalogPin =
    catalogPins.find((pin) => pin.id === dataPin.id) ??
    catalogPins.find((pin) => pin.name === dataPin.name);
  return catalogPin?.defaultValue;
}

/** Object reference inputs are the only pins that read Self or act as a node's subject. */
function isObjectReferenceInput(pin: GraphPin): boolean {
  return pin.direction === "in" && pin.kind === "data" && pin.type.kind === "objectRef";
}

/**
 * The catalog's flag wins over the saved pin's, so a flag added to a node type
 * reaches graphs saved before it.
 */
function catalogFlag(
  node: GraphNode,
  pin: GraphPin,
  registry: NodeRegistry,
  flag: "selfWhenUnwired" | "subject",
): boolean {
  if (!isObjectReferenceInput(pin)) return false;
  const catalog = registry.get(node.typeId)?.pins(node.properties).find((entry) => entry.id === pin.id);
  return (catalog ?? pin)[flag] === true;
}

type SubjectPin = { pin: GraphPin; message: string };

/**
 * A node's subject inputs: the objects it reads, writes, calls or moves. The
 * message is logged each time one is null as the node runs.
 */
function subjectPinsOf(
  node: GraphNode,
  registry: NodeRegistry,
  className: string | undefined,
): SubjectPin[] {
  const def = registry.get(node.typeId);
  const references = node.pins.filter(isObjectReferenceInput);
  if (!def || references.length === 0) return [];
  const catalog = def.pins(node.properties);
  const authored = typeof node.properties.title === "string" ? node.properties.title.trim() : "";
  const where = `${className ? `${className}: ` : ""}${authored || def.title}`;
  return references
    .filter((pin) => (catalog.find((entry) => entry.id === pin.id) ?? pin).subject === true)
    .map((pin) => ({
      pin,
      message: `${where} (${humanizePropertyLabel(pin.name)}) tried to access null.`,
    }));
}

/**
 * A pure node's output expression behind its subject guard: a null subject logs
 * and the output reads `fallback`. The inputs are bound to `__s<n>` so each is
 * evaluated once.
 */
function guardPureExpression(
  subjects: readonly SubjectPin[],
  args: readonly string[],
  expression: string,
  fallback: string,
): string {
  const names = subjects.map((_, index) => `__s${index}`);
  const report = subjects
    .map((subject, index) => {
      const log = `ctx.nullAccess(${JSON.stringify(subject.message)})`;
      return subjects.length === 1 ? log : `${names[index]} == null && ${log}`;
    })
    .join(", ");
  const anyNull = names.map((name) => `${name} == null`).join(" || ");
  return `((${names.join(", ")}) => ${anyNull} ? (${report}, ${fallback}) : (${expression}))(${args.join(", ")})`;
}

function disconnectedPinLiteral(
  node: GraphNode,
  dataPin: GraphPin,
  registry: NodeRegistry,
  fallbackLiteral?: string,
): string {
  if (catalogFlag(node, dataPin, registry, "selfWhenUnwired")) return "ctx.self";
  const prop = readPinDefaultForPin(node.properties, dataPin);
  if (prop !== undefined && !pinRejectsStoredDefault(dataPin.type)) {
    if (dataPin.type.kind === "tag") return JSON.stringify(normalizeTag(prop));
    if (dataPin.type.kind === "structRef" && dataPin.type.guid === "engine:TagContainer") {
      return JSON.stringify(normalizeTagContainer(prop));
    }
    return JSON.stringify(prop);
  }
  const catalog = catalogPinDefault(node, dataPin, registry);
  if (catalog !== undefined) return JSON.stringify(catalog);
  return fallbackLiteral ?? defaultValueLiteral(dataPin.type);
}

/**
 * Deterministic JS module compiler with line/column anchors.
 */
export function compileGraph(
  graph: LogicGraph,
  options: CompileOptions,
): CompileResult {
  graph = withResolvedPinTypes(graph);
  const index = indexGraph(graph);
  const exportName = options.exportName ?? "run";
  const preamble = [`//# sourceURL=haptic:///${options.assetGuid}.js`];
  // `var` stays valid when a document concatenates its graphs' modules.
  if (options.instrumentExecutionTrace === true && options.stripDevelopmentOnly !== true) {
    preamble.push("var __dv = (t, node, pin, value) => (t === null ? value : t.read(node, pin, value));");
    preamble.push("var __dw = (t, node, pin, value) => (t === null ? value : (t.write(node, pin, value), value));");
  }
  if (options.instrumentBreakpoints === true && options.stripDevelopmentOnly !== true) {
    preamble.push("var __bv = (b, node, pin, value) => (b === null ? value : b.read(node, pin, value));");
  }
  if (graph.nodes.some((node) => node.typeId.startsWith("tags."))) {
    preamble.push(...tagRuntimeSource(options.tagRegistry).split("\n"));
  }
  type HoistChunk = {
    source: string;
    nodeId: string;
    bodyAnchors?: readonly HoistBodyAnchor[];
  };
  const hoisted: HoistChunk[] = [];
  type BodyLine = { text: string; anchor?: Omit<CompileAnchor, "line"> };
  type ExecScope = { label: string; opening: BodyLine; repeats: boolean };
  type ExecPath = Map<string, ExecScope>;
  const body: BodyLine[] = [];
  const loopStack: Array<{ label: string; opening: BodyLine; labeled?: boolean }> = [];
  let nextLabel = 0;
  const shouldStrip = (node: GraphNode) =>
    options.stripDevelopmentOnly === true && isDevelopmentOnlyNode(node);
  const instrumentLoops = options.instrumentInfiniteLoops === true;
  const traceExecution =
    options.instrumentExecutionTrace === true && options.stripDevelopmentOnly !== true;
  /**
   * Execution-trace probes run only for the observed instance: `__dbg` is its
   * recorder, null for every other instance, so an unobserved probe is one
   * null check. Probe text never allocates and never changes evaluation order.
   */
  const traceProbe = (call: string) => `  if (__dbg !== null) ${call};`;
  /**
   * Breakpoint probes run for every instance: `__bp` is the graph's breakpoints, null when it has none.
   * In a graph with breakpoints the values exec nodes read and produce also reach `__bp`, which
   * checks a breakpoint's condition against them.
   */
  const checkBreakpoints =
    options.instrumentBreakpoints === true && options.stripDevelopmentOnly !== true;
  /** The event or function entry the exec chain being emitted starts from, for breakpoint hits. */
  let entryNodeId = "";
  /** An exec node runs: the followed instance records it, and a breakpoint on it stops the session. */
  const emitExecProbes = (nodeId: string) => {
    const id = JSON.stringify(nodeId);
    if (traceExecution) emitBody(traceProbe(`__dbg.exec(${id})`));
    if (checkBreakpoints) {
      emitBody(`  if (__bp !== null && __bp.has(${id})) __bp.hit(${id}, ${JSON.stringify(entryNodeId)}, ctx.self);`);
    }
  };
  const loopCheck = (nodeId: string) => `ctx.checkInfiniteLoop(${JSON.stringify({
    assetGuid: options.assetGuid, graphId: graph.id, nodeId,
  })});`;
  const exprCache = new Map<string, string>();
  /** Pure nodes whose codegen is running; a re-entry is a pure cycle. */
  const pureInProgress = new Set<string>();
  let pureExpressions = createPureExpressions(graph, options.registry);
  /**
   * Pure nodes with two or more wired data outputs. Each output expression
   * reads the node's inputs, so a wired pure input is memoized per executing
   * statement: outputs used by one statement see one evaluation of it.
   */
  const sharedInputNodes = new Set(
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
  );
  /**
   * Statement-scoped memos: each holds the value computed during the current
   * `__stmt` epoch. Every emitted exec node, each While Loop condition check
   * and each For Loop bound check after the first starts a new epoch.
   * Declared per entry point.
   */
  let memoDecls: string[] = [];
  const memoByKey = new Map<string, string>();
  let useEpoch = false;
  function memoExpression(key: string, expression: string): string {
    const cached = memoByKey.get(key);
    if (cached) return cached;
    const name = `__memo_${memoDecls.length}`;
    memoDecls.push(
      `  let ${name}_at = -1, ${name}_v; const ${name} = () => (${name}_at === __stmt ? ${name}_v : (${name}_v = (${expression}), ${name}_at = __stmt, ${name}_v));`,
    );
    const call = `${name}()`;
    memoByKey.set(key, call);
    return call;
  }
  /**
   * Impure output slots are declared once at the top of the entry point so a
   * node emitted under several exec branches neither redeclares them nor
   * traps its results inside a block scope.
   */
  const outputDecls = new Map<string, string>();
  let isAsync: boolean;

  const emitBody = (text: string, anchor?: Omit<CompileAnchor, "line">) => {
    const line = { text, anchor };
    body.push(line);
    return line;
  };

  function pinExpr(node: GraphNode, dataPin: GraphPin): string {
    const key = `${node.id}:${dataPin.id}`;
    const cached = exprCache.get(key);
    if (cached) return cached;
    const incoming = index.incoming(node.id, dataPin.id);
    if (incoming) {
      const srcNode = index.node(incoming.sourceNodeId);
      const srcPin = srcNode && findPin(srcNode, incoming.sourcePinId);
      // A dangling wire (reported as ref.missing_*) reads like a stripped source.
      if (!srcNode || !srcPin || shouldStrip(srcNode)) {
        const lit = defaultValueLiteral(dataPin.type);
        exprCache.set(key, lit);
        return lit;
      }
      const srcDef = options.registry.get(srcNode.typeId);
      if (srcDef?.pure) {
        ensurePure(srcNode);
      } else {
        const slot = `_n_${jsIdent(srcNode.id)}_${jsIdent(srcPin.id)}`;
        if (!exprCache.has(`${srcNode.id}:${srcPin.id}`)) {
          exprCache.set(`${srcNode.id}:${srcPin.id}`, slot);
          outputDecls.set(
            slot,
            `  let ${slot} = ${defaultValueLiteral(srcPin.type)};`,
          );
        }
      }
      const varName = exprCache.get(`${srcNode.id}:${srcPin.id}`);
      if (varName) {
        exprCache.set(key, varName);
        return varName;
      }
    }
    const lit = disconnectedPinLiteral(node, dataPin, options.registry);
    exprCache.set(key, lit);
    return lit;
  }

  function referenceExpr(node: GraphNode, pinName: string): string {
    const targetPin = pinForCodegen(node, pinName, "in");
    const edge = targetPin && index.incoming(node.id, targetPin.id);
    const source = edge && index.node(edge.sourceNodeId);
    const sourcePin = source && edge && findPin(source, edge.sourcePinId);
    if (!source || !sourcePin || !targetPin || shouldStrip(source) ||
        !pinTypeEquals(sourcePin.type, targetPin.type) || !isWritableVariableOutput(source, sourcePin)) return "null";
    const name = String(source.properties.variableName ?? "Value").trim() || "Value";
    if (source.properties.scope === "local") {
      const local = `__lv_${jsIdent(name)}`;
      const reference = `__ref_${local}`;
      outputDecls.set(reference, `  const ${reference} = { identity: {}, property: ${JSON.stringify(name)}, set: value => { ${local} = value; } };`);
      return reference;
    }
    const property = typeof source.properties.propertyKey === "string" && source.properties.propertyKey
      ? source.properties.propertyKey : name;
    const ownerPin = pinForCodegen(source, "target", "in");
    const connected = ownerPin && index.incoming(source.id, ownerPin.id);
    const implicitSelf = !ownerPin || (!connected && source.properties.implicitSelf === true);
    const owner = implicitSelf ? "null" : pinExpr(source, ownerPin!);
    return `ctx.variableReference(${owner}, ${JSON.stringify(property)}, ${implicitSelf})`;
  }

  /** An input's expression, memoized per statement when its pure node feeds several outputs. */
  function inputExpression(node: GraphNode, p: GraphPin): string {
    const expression = pinExpr(node, p);
    if (!sharedInputNodes.has(node.id)) return expression;
    const edge = index.incoming(node.id, p.id);
    const source = edge && index.node(edge.sourceNodeId);
    if (!source || shouldStrip(source) || !options.registry.get(source.typeId)?.pure) {
      return expression;
    }
    return memoExpression(`in:${node.id}:${p.id}`, expression);
  }

  /**
   * A pure node's output expression, recording the value each time a consumer evaluates it. The
   * wrapper evaluates `expression` exactly where it already ran, so a pure node is never evaluated
   * an extra time and a chain of pure nodes records every link of it.
   */
  function tracedPureOutput(node: GraphNode, p: GraphPin, expression: string): string {
    if (!traceExecution) return expression;
    return `__dw(__dbg, ${JSON.stringify(node.id)}, ${JSON.stringify(p.id)}, ${expression})`;
  }

  /**
   * A node that runs records what it read from a wired data input, and checks it against the node's
   * breakpoint. A pure node records its outputs instead (`tracedPureOutput`); what flowed into its
   * inputs is what their sources produced, and an unwired input shows its literal on the node.
   */
  function tracedRead(node: GraphNode, p: GraphPin, expression: string): string {
    if ((!traceExecution && !checkBreakpoints) || options.registry.get(node.typeId)?.pure) return expression;
    const edge = index.incoming(node.id, p.id);
    if (!edge || !index.node(edge.sourceNodeId)) return expression;
    const ids = `${JSON.stringify(node.id)}, ${JSON.stringify(p.id)}`;
    const checked = checkBreakpoints ? `__bv(__bp, ${ids}, ${expression})` : expression;
    return traceExecution ? `__dv(__dbg, ${ids}, ${checked})` : checked;
  }

  /** `bound` names the variables that already hold a node's subject inputs. */
  function makeCtx(node: GraphNode, continuation?: (expression: string) => void,
    branch?: (expression: string, truePin: string, falsePin: string) => void,
    bound?: ReadonlyMap<string, string>): CodegenContext {
    return {
      graph,
      node,
      indent: "  ",
      input(pinName) {
        const p = pinForCodegen(node, pinName, "in");
        if (!p) return "undefined";
        // A bound subject was recorded where it was bound; every other wired read is recorded here.
        return bound?.get(p.id) ?? tracedRead(node, p, inputExpression(node, p));
      },
      isWired(pinId) { return index.incoming(node.id, pinId) !== undefined; },
      reference(pinName) { return referenceExpr(node, pinName); },
      shared(expression) {
        // With one wired output there is nothing to share.
        if (!sharedInputNodes.has(node.id)) return expression;
        return memoExpression(`shared:${node.id}:${expression}`, expression);
      },
      continueIf(expression) { continuation?.(expression); },
      branch(expression, truePin, falsePin) { branch?.(expression, truePin, falsePin); },
      inputType(pinName) {
        const p = pinForCodegen(node, pinName, "in");
        return p ? wiredSourceType(index, node, p.id, shouldStrip) : undefined;
      },
      output(pinName) {
        const p = pinForCodegen(node, pinName, "out");
        const slotKey = p?.id ?? pinName;
        const name = `_n_${jsIdent(node.id)}_${jsIdent(slotKey)}`;
        if (p) exprCache.set(`${node.id}:${p.id}`, name);
        return name;
      },
      emit(statement, anchorNodeId) {
        const anchor = {
          column: 1,
          assetGuid: options.assetGuid,
          graphId: graph.id,
          nodeId: anchorNodeId ?? node.id,
        };
        if (instrumentLoops) emitBody(`  ${loopCheck(anchor.nodeId)}`, anchor);
        emitBody(`  ${statement}`, anchor);
      },
      hoist(source, bodyAnchors) {
        const next = instrumentLoops
          ? instrumentJsLoops(source, loopCheck(node.id))
          : source;
        if (hoisted.some((chunk) => chunk.source === next)) return;
        hoisted.push({ source: next, nodeId: node.id, bodyAnchors });
      },
      requestAsync() {
        isAsync = true;
      },
      isLatentFunction: options.isLatentFunction,
    };
  }

  function ensurePure(node: GraphNode) {
    if (shouldStrip(node) || pureInProgress.has(node.id)) return;
    const def = options.registry.get(node.typeId);
    if (!def?.pure) return;
    if (
      node.pins.some(
        (p) =>
          p.direction === "out" &&
          p.kind === "data" &&
          exprCache.has(`${node.id}:${p.id}`),
      )
    ) {
      return;
    }
    const subjects = subjectPinsOf(node, options.registry, options.className);
    pureInProgress.add(node.id);
    let result: ReturnType<typeof def.codegen>;
    let subjectArgs: string[];
    try {
      // Read in progress: a pure cycle through a subject input ends here.
      subjectArgs = subjects.map((subject) => inputExpression(node, subject.pin));
      const bound = new Map(subjects.map((subject, i) => [subject.pin.id, `__s${i}`] as const));
      result = def.codegen(makeCtx(node, undefined, undefined, bound));
    } finally {
      pureInProgress.delete(node.id);
    }
    if (result && typeof result === "object") {
      for (const [name, expr] of Object.entries(result)) {
        const outPin = pinForCodegen(node, name, "out");
        if (!outPin) continue;
        const guarded = subjects.length > 0
          ? guardPureExpression(subjects, subjectArgs, expr, defaultValueLiteral(outPin.type))
          : expr;
        exprCache.set(
          `${node.id}:${outPin.id}`,
          tracedPureOutput(node, outPin, pureExpressions.expression(node, outPin, guarded)),
        );
      }
    }
  }

  /**
   * Evaluates a statement node's subject inputs once and logs each null one. The
   * node's statements run only when none is null; otherwise its data outputs read
   * their defaults. Returns the context for the node's codegen and, for a node
   * with subjects, the condition under which it runs.
   */
  function emitStatementNode(
    node: GraphNode,
    def: NodeDefinition,
    flow?: {
      continuation: (expression: string) => void;
      branch: (expression: string, truePin: string, falsePin: string) => void;
    },
  ): { ctx: CodegenContext; condition?: string } {
    const anchor = { column: 1, assetGuid: options.assetGuid, graphId: graph.id, nodeId: node.id };
    const subjects = subjectPinsOf(node, options.registry, options.className);
    const bound = new Map<string, string>();
    for (const subject of subjects) {
      const slot = `__s_${jsIdent(node.id)}_${jsIdent(subject.pin.id)}`;
      bound.set(subject.pin.id, slot);
      outputDecls.set(slot, `  let ${slot};`);
      emitBody(`  ${slot} = ${tracedRead(node, subject.pin, inputExpression(node, subject.pin))};`, anchor);
    }
    for (const subject of subjects) {
      emitBody(`  if (${bound.get(subject.pin.id)} == null) ctx.nullAccess(${JSON.stringify(subject.message)});`, anchor);
    }
    const ctx = makeCtx(node, flow?.continuation, flow?.branch, bound);
    if (def.latent) isAsync = true;
    declareDataOuts(node, ctx);
    if (subjects.length === 0) {
      def.codegen(ctx);
      emitOutputProbe(node, ctx);
      return { ctx };
    }
    const condition = subjects.map((subject) => `${bound.get(subject.pin.id)} != null`).join(" && ");
    emitBody(`  if (${condition}) {`, anchor);
    const start = body.length;
    def.codegen(ctx);
    if (body.length === start) {
      // The node emitted nothing (its work is a continuation): no empty block.
      body.pop();
      emitOutputProbe(node, ctx);
      return { ctx, condition };
    }
    const resets = node.pins
      .filter((pin) => pin.kind === "data" && pin.direction === "out")
      .map((pin) => `    ${ctx.output(pin.id)} = ${defaultValueLiteral(pin.type)};`);
    if (resets.length > 0) {
      emitBody("  } else {", anchor);
      for (const reset of resets) emitBody(reset, anchor);
    }
    emitBody("  }", anchor);
    emitOutputProbe(node, ctx);
    return { ctx, condition };
  }

  /**
   * Several successor chains share one function scope, so each gets its own
   * block: a node reached on two of them must not declare a local twice.
   */
  function emitAlong(edges: ExecTarget[], visited: ExecPath) {
    const scoped = edges.length > 1;
    for (const edge of edges) {
      if (scoped) emitBody("  {");
      emitExecChain(edge.targetNodeId, new Map(visited), edge.targetPinId, edge.id);
      if (scoped) emitBody("  }");
    }
  }

  /** Records every data output of `node` once its statements have run, and checks it against the node's breakpoint. */
  function emitOutputProbe(node: GraphNode, ctx: CodegenContext) {
    if (!traceExecution && !checkBreakpoints) return;
    const outs = node.pins.filter((p) => p.kind === "data" && p.direction === "out");
    if (outs.length === 0) return;
    const writes = (target: string) => outs.map((p) =>
      `${target}.write(${JSON.stringify(node.id)}, ${JSON.stringify(p.id)}, ${ctx.output(p.id)});`).join(" ");
    if (traceExecution) emitBody(`  if (__dbg !== null) { ${writes("__dbg")} }`);
    if (checkBreakpoints) emitBody(`  if (__bp !== null && __bp.has(${JSON.stringify(node.id)})) { ${writes("__bp")} }`);
  }

  function declareDataOuts(node: GraphNode, ctx: CodegenContext) {
    for (const p of node.pins) {
      if (p.kind === "data" && p.direction === "out") {
        const name = ctx.output(p.id);
        outputDecls.set(
          name,
          `  let ${name} = ${defaultValueLiteral(p.type)};`,
        );
      }
    }
  }

  function emitFlowSwitch(
    node: GraphNode,
    meta: StructuredFlowMeta,
    visited: ExecPath,
  ): boolean {
    if (!isFlowSwitchMeta(meta)) return false;
    const ctx = makeCtx(node);
    const anchor = {
      column: 1,
      assetGuid: options.assetGuid,
      graphId: graph.id,
      nodeId: node.id,
    };
    const valueExpr = ctx.input(meta.valuePin);
    const cases = node.pins.filter(
      (pin) =>
        pin.kind === "exec" &&
        pin.direction === "out" &&
        flowSwitchCaseValueFromPinId(pin.id) !== undefined,
    );
    const wiredCases = cases.filter(
      (pin) => execSuccessorEdges(index, node.id, pin.id).length > 0,
    );
    const defaultTargets = execSuccessorEdges(index, node.id, meta.defaultPin);
    if (wiredCases.length === 0 && defaultTargets.length === 0) {
      emitBody(`  /* ${node.typeId} ${node.id}: no exec outs */`, anchor);
      return true;
    }
    for (let i = 0; i < wiredCases.length; i++) {
      const pin = wiredCases[i]!;
      const raw = flowSwitchCaseValueFromPinId(pin.id) ?? pin.name;
      const compare =
        meta.kind === "switchOnInt" ? String(Number(raw)) : JSON.stringify(raw);
      const keyword = i === 0 ? "if" : "} else if";
      emitBody(`  ${keyword} (${valueExpr} === ${compare}) {`, anchor);
      emitAlong(execSuccessorEdges(index, node.id, pin.id), visited);
    }
    if (defaultTargets.length > 0) {
      if (wiredCases.length > 0) {
        emitBody(`  } else {`, anchor);
      }
      emitAlong(defaultTargets, visited);
      if (wiredCases.length > 0) {
        emitBody(`  }`, anchor);
      }
    } else if (wiredCases.length > 0) {
      emitBody(`  }`, anchor);
    }
    return true;
  }

  function emitStructuredFlow(
    node: GraphNode,
    meta: StructuredFlowMeta,
    visited: ExecPath,
    entryPinId: string | undefined,
  ): boolean {
    const ctx = makeCtx(node);
    const anchor = {
      column: 1,
      assetGuid: options.assetGuid,
      graphId: graph.id,
      nodeId: node.id,
    };

    if (meta.kind === "break") {
      const loop = loopStack.at(-1);
      // Outside a loop the validator reports flow.break_outside_loop; a bare
      // `break;` would stop the whole module from parsing.
      if (!loop) {
        emitBody(`  /* flow.break ${node.id}: not inside a loop */`, anchor);
        return true;
      }
      if (!loop.labeled) {
        loop.opening.text = `  ${loop.label}: ${loop.opening.text.trimStart()}`;
        loop.labeled = true;
      }
      emitBody(`  break ${loop.label};`, anchor);
      return true;
    }

    if (meta.kind === "whileLoop") {
      const conditionExpr = ctx.input(meta.conditionPin);
      // Each condition check is a statement of its own.
      const condition = useEpoch ? `(__stmt++, ${conditionExpr})` : conditionExpr;
      const opening = emitBody(`  while (${condition}) {`, anchor);
      if (instrumentLoops) emitBody(`    ${loopCheck(anchor.nodeId)}`, anchor);
      loopStack.push({ label: `__loop_${nextLabel++}`, opening });
      emitAlong(execSuccessorEdges(index, node.id, meta.loopBodyPin), visited);
      loopStack.pop();
      emitBody(`  }`, anchor);
      emitAlong(execSuccessorEdges(index, node.id, meta.completedPin), visited);
      return true;
    }

    if (isLoopMeta(meta)) {
      declareDataOuts(node, ctx);
      const indexSlot = ctx.output(meta.indexPin);
      if (meta.kind === "forLoop" || meta.kind === "forLoopWithBreak") {
        const firstExpr = ctx.input(meta.firstIndexPin);
        const lastExpr = ctx.input(meta.lastIndexPin);
        const iter = `__i_${jsIdent(node.id)}`;
        const bound = `__bound_${jsIdent(node.id)}`;
        emitBody(`  {`, anchor);
        // Like `| 0` without the int32 wrap: Int pins carry safe integers.
        // A non-finite bound (Int division by zero) is 0, not an endless loop.
        emitBody(
          `    const ${bound} = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; };`,
          anchor,
        );
        // The first Last Index check shares the For Loop's statement with
        // First Index; each later check is a statement of its own.
        const update = useEpoch ? `${iter}++, __stmt++` : `${iter}++`;
        const opening = emitBody(
          `    for (let ${iter} = ${bound}(${firstExpr}); ${iter} <= ${bound}(${lastExpr}); ${update}) {`,
          anchor,
        );
        if (instrumentLoops) emitBody(`      ${loopCheck(anchor.nodeId)}`, anchor);
        emitBody(`      ${indexSlot} = ${iter};`, anchor);
        emitOutputProbe(node, ctx);
        loopStack.push({ label: `__loop_${nextLabel++}`, opening });
        emitAlong(
          execSuccessorEdges(index, node.id, meta.loopBodyPin),
          visited,
        );
        loopStack.pop();
        emitBody(`    }`, anchor);
        emitBody(`  }`, anchor);
      } else if (meta.kind === "forEach" || meta.kind === "forEachWithBreak") {
        const arrayExpr = ctx.input(meta.arrayPin);
        const elementSlot = ctx.output(meta.elementPin);
        const source = `__src_${jsIdent(node.id)}`;
        const snap = `__snap_${jsIdent(node.id)}`;
        const iter = `__i_${jsIdent(node.id)}`;
        emitBody(`  {`, anchor);
        emitBody(`    const ${source} = ${arrayExpr};`, anchor);
        emitBody(
          `    const ${snap} = Array.isArray(${source}) ? ${source}.slice() : [];`,
          anchor,
        );
        const opening = emitBody(
          `    for (let ${iter} = 0; ${iter} < ${snap}.length; ${iter}++) {`,
          anchor,
        );
        if (instrumentLoops) emitBody(`      ${loopCheck(anchor.nodeId)}`, anchor);
        emitBody(`      ${indexSlot} = ${iter};`, anchor);
        emitBody(`      ${elementSlot} = ${snap}[${iter}];`, anchor);
        emitOutputProbe(node, ctx);
        loopStack.push({ label: `__loop_${nextLabel++}`, opening });
        emitAlong(
          execSuccessorEdges(index, node.id, meta.loopBodyPin),
          visited,
        );
        loopStack.pop();
        emitBody(`    }`, anchor);
        emitBody(`  }`, anchor);
      } else if (
        meta.kind === "forEachMap" ||
        meta.kind === "forEachMapWithBreak"
      ) {
        const mapExpr = ctx.input(meta.mapPin);
        const keySlot = ctx.output(meta.keyPin);
        const valueSlot = ctx.output(meta.valuePin);
        const snap = `__snap_${jsIdent(node.id)}`;
        const iter = `__i_${jsIdent(node.id)}`;
        emitBody(`  {`, anchor);
        emitBody(
          `    const ${snap} = [...(new Map(${mapExpr} ?? [])).entries()];`,
          anchor,
        );
        const opening = emitBody(
          `    for (let ${iter} = 0; ${iter} < ${snap}.length; ${iter}++) {`,
          anchor,
        );
        if (instrumentLoops) emitBody(`      ${loopCheck(anchor.nodeId)}`, anchor);
        emitBody(`      ${indexSlot} = ${iter};`, anchor);
        emitBody(`      ${keySlot} = ${snap}[${iter}][0];`, anchor);
        emitBody(`      ${valueSlot} = ${snap}[${iter}][1];`, anchor);
        emitOutputProbe(node, ctx);
        loopStack.push({ label: `__loop_${nextLabel++}`, opening });
        emitAlong(
          execSuccessorEdges(index, node.id, meta.loopBodyPin),
          visited,
        );
        loopStack.pop();
        emitBody(`    }`, anchor);
        emitBody(`  }`, anchor);
      }
      emitAlong(execSuccessorEdges(index, node.id, meta.completedPin), visited);
      return true;
    }

    if (meta.kind === "doOnce") {
      if (entryPinMatches(node, meta.resetPin, entryPinId)) {
        emitBody(
          `  ctx.flowState(${JSON.stringify(node.id)}).done = false;`,
          anchor,
        );
        return true;
      }
      emitBody(`  {`, anchor);
      emitBody(
        `    const __st = ctx.flowState(${JSON.stringify(node.id)});`,
        anchor,
      );
      emitBody(`    if (!__st.done) {`, anchor);
      emitBody(`      __st.done = true;`, anchor);
      emitAlong(execSuccessorEdges(index, node.id, meta.thenPin), visited);
      emitBody(`    }`, anchor);
      emitBody(`  }`, anchor);
      return true;
    }

    if (meta.kind === "doN") {
      declareDataOuts(node, ctx);
      const counterSlot = ctx.output(meta.counterPin);
      if (entryPinMatches(node, meta.resetPin, entryPinId)) {
        emitBody(
          `  ctx.flowState(${JSON.stringify(node.id)}).count = 0;`,
          anchor,
        );
        return true;
      }
      const nExpr = ctx.input(meta.nPin);
      emitBody(`  {`, anchor);
      emitBody(
        `    const __st = ctx.flowState(${JSON.stringify(node.id)});`,
        anchor,
      );
      emitBody(`    if (__st.count == null) __st.count = 0;`, anchor);
      emitBody(`    if ((__st.count | 0) < ((${nExpr}) | 0)) {`, anchor);
      emitBody(`      ${counterSlot} = __st.count | 0;`, anchor);
      emitOutputProbe(node, ctx);
      emitBody(`      __st.count = (__st.count | 0) + 1;`, anchor);
      emitAlong(execSuccessorEdges(index, node.id, meta.thenPin), visited);
      emitBody(`    }`, anchor);
      emitBody(`  }`, anchor);
      return true;
    }

    if (meta.kind === "flipFlop") {
      declareDataOuts(node, ctx);
      const isASlot = ctx.output(meta.isAPin);
      emitBody(`  {`, anchor);
      emitBody(
        `    const __st = ctx.flowState(${JSON.stringify(node.id)});`,
        anchor,
      );
      emitBody(`    const __isA = __st.nextIsB !== true;`, anchor);
      emitBody(`    __st.nextIsB = __isA;`, anchor);
      emitBody(`    ${isASlot} = __isA;`, anchor);
      emitOutputProbe(node, ctx);
      emitBody(`    if (__isA) {`, anchor);
      emitAlong(execSuccessorEdges(index, node.id, meta.aPin), visited);
      emitBody(`    } else {`, anchor);
      emitAlong(execSuccessorEdges(index, node.id, meta.bPin), visited);
      emitBody(`    }`, anchor);
      emitBody(`  }`, anchor);
      return true;
    }

    if (meta.kind === "gate") {
      if (entryPinMatches(node, meta.openPin, entryPinId)) {
        emitBody(
          `  ctx.flowState(${JSON.stringify(node.id)}).open = true;`,
          anchor,
        );
        return true;
      }
      if (entryPinMatches(node, meta.closePin, entryPinId)) {
        emitBody(
          `  ctx.flowState(${JSON.stringify(node.id)}).open = false;`,
          anchor,
        );
        return true;
      }
      if (entryPinMatches(node, meta.togglePin, entryPinId)) {
        emitBody(`  {`, anchor);
        emitBody(
          `    const __st = ctx.flowState(${JSON.stringify(node.id)});`,
          anchor,
        );
        emitBody(`    __st.open = !__st.open;`, anchor);
        emitBody(`  }`, anchor);
        return true;
      }
      // Enter (default)
      const startOpen = meta.startClosed === true ? "false" : "true";
      emitBody(`  {`, anchor);
      emitBody(
        `    const __st = ctx.flowState(${JSON.stringify(node.id)});`,
        anchor,
      );
      emitBody(`    if (__st.open == null) __st.open = ${startOpen};`, anchor);
      emitBody(`    if (__st.open) {`, anchor);
      emitAlong(execSuccessorEdges(index, node.id, meta.exitPin), visited);
      emitBody(`    }`, anchor);
      emitBody(`  }`, anchor);
      return true;
    }

    return false;
  }

  function emitExecChain(
    startId: string,
    visited: ExecPath = new Map(),
    entryPinId?: string,
    viaEdgeId?: string,
  ) {
    let current: string | undefined = startId;
    let currentEntryPin = entryPinId;
    let currentVia = viaEdgeId;
    const scopes: ExecScope[] = [];
    while (current) {
      const node = index.node(current);
      if (!node) break;
      // Taking a wire is reported before the node's loop wrapper opens (once per
      // arrival) and also before a back edge's `continue`, never on loop re-entry.
      if (traceExecution && currentVia !== undefined) {
        emitBody(traceProbe(`__dbg.edge(${JSON.stringify(currentVia)})`));
      }
      // Control inputs (Gate Open/Close, Do Once Reset) are distinct states.
      const input = currentEntryPin ?? node.pins.find(
        (pin) => pin.kind === "exec" && pin.direction === "in",
      )?.id;
      const key = JSON.stringify([node.id, input]);
      const anchor = {
        column: 1,
        assetGuid: options.assetGuid,
        graphId: graph.id,
        nodeId: node.id,
      };
      const previous = visited.get(key);
      if (previous) {
        previous.repeats = true;
        previous.opening.text = `  ${previous.label}: while (true) {`;
        if (instrumentLoops) emitBody(`  ${loopCheck(anchor.nodeId)}`, anchor);
        emitBody(`  continue ${previous.label};`, anchor);
        break;
      }
      // Reserve an opening; only back-edge targets need a loop wrapper.
      // Native loops keep await, output slots and function locals in this invocation.
      const scope = {
        label: `__exec_${nextLabel++}`,
        opening: emitBody("", anchor),
        repeats: false,
      };
      visited.set(key, scope);
      scopes.push(scope);
      if (shouldStrip(node)) {
        const targets = stripExecSuccessors(index, node);
        if (targets.length === 0) break;
        if (targets.length === 1) {
          current = targets[0]!.targetNodeId;
          currentEntryPin = targets[0]!.targetPinId;
          currentVia = targets[0]!.id;
          continue;
        }
        emitAlong(targets, visited);
        break;
      }
      const def = options.registry.get(node.typeId);
      if (!def) {
        emitBody(`  // missing node type ${node.typeId}`, {
          column: 1,
          assetGuid: options.assetGuid,
          graphId: graph.id,
          nodeId: node.id,
        });
        break;
      }
      // Event entries that gate their chain on live input report inside the gate.
      if (!GATED_EVENT_TYPE_IDS.has(node.typeId)) emitExecProbes(node.id);
      if (useEpoch) emitBody("  __stmt++;");

      if (node.typeId === "flow.branch") {
        const ctx = makeCtx(node);
        const anchor = {
          column: 1,
          assetGuid: options.assetGuid,
          graphId: graph.id,
          nodeId: node.id,
        };
        emitBody(`  if (${ctx.input("condition")}) {`, anchor);
        emitAlong(execSuccessorEdges(index, node.id, "true"), visited);
        emitBody(`  } else {`, anchor);
        emitAlong(execSuccessorEdges(index, node.id, "false"), visited);
        emitBody(`  }`, anchor);
        break;
      }

      if (node.typeId === "variables.getValidated") {
        const anchor = {
          column: 1,
          assetGuid: options.assetGuid,
          graphId: graph.id,
          nodeId: node.id,
        };
        // An empty Target leaves the value empty, so execution takes Not Valid.
        const { ctx } = emitStatementNode(node, def);
        const value = ctx.output("value");
        emitBody(`  if (${value} != null) {`, anchor);
        emitAlong(execSuccessorEdges(index, node.id, "isValid"), visited);
        emitBody(`  } else {`, anchor);
        emitAlong(execSuccessorEdges(index, node.id, "notValid"), visited);
        emitBody(`  }`, anchor);
        break;
      }

      if (node.typeId === "enum.switch") {
        const ctx = makeCtx(node);
        const anchor = {
          column: 1,
          assetGuid: options.assetGuid,
          graphId: graph.id,
          nodeId: node.id,
        };
        const valueExpr = ctx.input("value");
        const cases = node.pins.filter(
          (pin) =>
            pin.kind === "exec" &&
            pin.direction === "out" &&
            enumSwitchMemberNameFromPinId(pin.id) !== undefined,
        );
        const wiredCases = cases.filter(
          (pin) => execSuccessorEdges(index, node.id, pin.id).length > 0,
        );
        const defaultTargets = execSuccessorEdges(index, node.id, "default");
        if (wiredCases.length === 0 && defaultTargets.length === 0) {
          emitBody(`  /* enum.switch ${node.id}: no exec outs */`, anchor);
          break;
        }
        for (let i = 0; i < wiredCases.length; i++) {
          const pin = wiredCases[i]!;
          const memberName = enumSwitchMemberNameFromPinId(pin.id) ?? pin.name;
          const keyword = i === 0 ? "if" : "} else if";
          emitBody(
            `  ${keyword} (${valueExpr} === ${JSON.stringify(memberName)}) {`,
            anchor,
          );
          emitAlong(execSuccessorEdges(index, node.id, pin.id), visited);
        }
        if (defaultTargets.length > 0) {
          if (wiredCases.length > 0) {
            emitBody(`  } else {`, anchor);
          }
          emitAlong(defaultTargets, visited);
          if (wiredCases.length > 0) {
            emitBody(`  }`, anchor);
          }
        } else if (wiredCases.length > 0) {
          emitBody(`  }`, anchor);
        }
        break;
      }

      if (def.structuredFlow?.kind === "switchOnTag") {
        const ctx = makeCtx(node);
        const anchor = { column: 1, assetGuid: options.assetGuid, graphId: graph.id, nodeId: node.id };
        const cases = tagCasesOf(node.properties);
        emitBody(`  {`, anchor);
        const list = tagCasesConstant(cases);
        ctx.hoist(list.declaration);
        emitBody(`  const __tagCase = __tags.select(${ctx.input("value")}, ${list.name}, ${ctx.input("exact")});`, anchor);
        for (let i = 0; i < cases.length; i++) {
          const tag = cases[i]!;
          emitBody(`  ${i === 0 ? "if" : "} else if"} (__tagCase === ${tag}) {`, anchor);
          emitAlong(index.outgoing(node.id).filter((edge) =>
            edge.sourcePinId === tagCasePinId(tag)), visited);
        }
        if (cases.length) emitBody(`  } else {`, anchor);
        emitAlong(index.outgoing(node.id).filter((edge) =>
          edge.sourcePinId === "default"), visited);
        if (cases.length) emitBody(`  }`, anchor);
        emitBody(`  }`, anchor);
        break;
      }

      if (
        def.structuredFlow &&
        emitFlowSwitch(node, def.structuredFlow, visited)
      ) {
        break;
      }

      if (
        node.typeId === "input.actionEvent" ||
        node.typeId === "input.axisEvent"
      ) {
        const ctx = makeCtx(node);
        const anchor = {
          column: 1,
          assetGuid: options.assetGuid,
          graphId: graph.id,
          nodeId: node.id,
        };
        const snapshot = `__input_${jsIdent(node.id)}`;
        const candidate = `${snapshot}_candidate`;
        const valueType =
          node.typeId === "input.actionEvent"
            ? "button"
            : node.properties.valueType === "2d"
              ? "2d"
              : "1d";
        const input = `(${ctx.input("binding")})?.Input`;
        emitBody(
          `  const ${candidate} = ctx.getInputState?.(${input});`,
          anchor,
        );
        emitBody(
          `  const ${snapshot} = ${candidate}?.valueType === ${JSON.stringify(valueType)} ? ${candidate} : null;`,
          anchor,
        );
        // Function-level declarations: a pure consumer may already have hoisted these slots.
        declareDataOuts(node, ctx);
        for (const p of node.pins.filter(
          (p) => p.kind === "data" && p.direction === "out",
        )) {
          emitBody(
            `  ${ctx.output(p.id)} = ${snapshot}?.${p.id} ?? ${defaultValueLiteral(p.type)};`,
            anchor,
          );
        }
        // A release/repress in one tick finishes the old hold before starting anew.
        const phases = `__phases_${jsIdent(node.id)}`;
        emitBody(
          `  const ${phases} = ${snapshot}?.held ? ["released", "started", "held"] : ["started", "released"];`,
          anchor,
        );
        emitBody(`  for (const __phase of ${phases}) {`, anchor);
        for (const phase of ["started", "held", "released"]) {
          emitBody(
            `    if (__phase === "${phase}" && ${snapshot}?.${phase}) {`,
            anchor,
          );
          emitExecProbes(node.id);
          emitOutputProbe(node, ctx);
          emitAlong(execSuccessorEdges(index, node.id, phase), new Map(visited));
          emitBody("    }", anchor);
        }
        emitBody("  }", anchor);
        break;
      }

      if (node.typeId === "input.onAnyKeyPressed") {
        const ctx = makeCtx(node);
        const anchor = {
          column: 1,
          assetGuid: options.assetGuid,
          graphId: graph.id,
          nodeId: node.id,
        };
        declareDataOuts(node, ctx);
        const pressedKey = `__key_${jsIdent(node.id)}`;
        emitBody(
          `  for (const ${pressedKey} of (ctx.getPressedKeys?.() ?? [])) {`,
          anchor,
        );
        if (instrumentLoops) emitBody(`    ${loopCheck(anchor.nodeId)}`, anchor);
        emitBody(`    ${ctx.output("key")} = ${pressedKey};`, anchor);
        emitExecProbes(node.id);
        emitOutputProbe(node, ctx);
        emitAlong(execSuccessorEdges(index, node.id, "Then"), visited);
        emitBody("  }", anchor);
        break;
      }

      const touchPhases = TOUCH_EVENT_PHASES[node.typeId];
      if (touchPhases) {
        const ctx = makeCtx(node);
        const anchor = {
          column: 1,
          assetGuid: options.assetGuid,
          graphId: graph.id,
          nodeId: node.id,
        };
        declareDataOuts(node, ctx);
        const touch = `__touch_${jsIdent(node.id)}`;
        const matches = touchPhases.map((phase) => `${touch}.Phase === ${JSON.stringify(phase)}`).join(" || ");
        emitBody(
          `  for (const ${touch} of (ctx.getTouchEvents?.() ?? [])) {`,
          anchor,
        );
        emitBody(`    if (!(${matches})) continue;`, anchor);
        if (instrumentLoops) emitBody(`    ${loopCheck(anchor.nodeId)}`, anchor);
        const outputs: Record<string, string> = {
          touch,
          finger: `${touch}.Finger`,
          position: `${touch}.Position`,
          delta: `${touch}.Delta`,
          cancelled: `${touch}.Phase === "Cancelled"`,
        };
        for (const pin of node.pins) {
          const value = pin.kind === "data" && pin.direction === "out" ? outputs[pin.id] : undefined;
          if (value) emitBody(`    ${ctx.output(pin.id)} = ${value};`, anchor);
        }
        emitExecProbes(node.id);
        emitOutputProbe(node, ctx);
        emitAlong(execSuccessorEdges(index, node.id, "execOut"), visited);
        emitBody("  }", anchor);
        break;
      }

      // Input event entries gate their then-chain on the resolved tick state.
      if (
        node.typeId === "input.onGamepadConnected" ||
        node.typeId === "input.onGamepadDisconnected"
      ) {
        const ctx = makeCtx(node);
        const anchor = {
          column: 1,
          assetGuid: options.assetGuid,
          graphId: graph.id,
          nodeId: node.id,
        };
        declareDataOuts(node, ctx);
        const connected = node.typeId === "input.onGamepadConnected";
        const padIndexSlot = ctx.output("index");
        emitBody(
          `  for (const __pad of (ctx.gamepadConnections ?? []).filter((c) => c.connected === ${connected})) {`,
          anchor,
        );
        if (instrumentLoops) emitBody(`    ${loopCheck(anchor.nodeId)}`, anchor);
        emitBody(`    ${padIndexSlot} = __pad.gamepadIndex;`, anchor);
        emitExecProbes(node.id);
        emitOutputProbe(node, ctx);
        emitAlong(execSuccessorEdges(index, node.id, "then"), visited);
        emitBody(`  }`, anchor);
        break;
      }

      if (node.typeId === "flow.sequence") {
        emitAlong(execSuccessorEdges(index, node.id), visited);
        break;
      }

      if (
        def.structuredFlow &&
        emitStructuredFlow(node, def.structuredFlow, visited, currentEntryPin)
      ) {
        break;
      }

      let continuation: string | undefined;
      let runs: string | undefined;
      const flow: { branch?: { expression: string; truePin: string; falsePin: string } } = {};
      if (def.pure) {
        ensurePure(node);
      } else {
        runs = emitStatementNode(node, def, {
          continuation: (expression) => { continuation = expression; },
          branch: (expression, truePin, falsePin) => { flow.branch = { expression, truePin, falsePin }; },
        }).condition;
      }

      if (flow.branch) {
        const branch = flow.branch;
        const anchor = { column: 1, assetGuid: options.assetGuid, graphId: graph.id, nodeId: node.id };
        if (instrumentLoops) emitBody(`  ${loopCheck(anchor.nodeId)}`, anchor);
        emitBody(`  if (${runs ? `${runs} && (${branch.expression})` : branch.expression}) {`, anchor);
        emitAlong(execSuccessorEdges(index, node.id, branch.truePin), visited);
        emitBody("  } else {", anchor);
        emitAlong(execSuccessorEdges(index, node.id, branch.falsePin), visited);
        emitBody("  }", anchor);
        break;
      }

      const thenEdges = execSuccessorEdges(index, node.id, "then");
      const edges =
        thenEdges.length > 0 ? thenEdges : execSuccessorEdges(index, node.id);
      if (continuation !== undefined) {
        const anchor = { column: 1, assetGuid: options.assetGuid, graphId: graph.id, nodeId: node.id };
        if (instrumentLoops) emitBody(`  ${loopCheck(anchor.nodeId)}`, anchor);
        emitBody(`  if (${runs ? `${runs} && (${continuation})` : continuation}) {`, anchor);
        emitAlong(edges, visited);
        emitBody("  }");
        break;
      }
      if (edges.length === 0) break;
      if (edges.length === 1) {
        current = edges[0]!.targetNodeId;
        currentEntryPin = edges[0]!.targetPinId;
        currentVia = edges[0]!.id;
        continue;
      }
      emitAlong(edges, visited);
      break;
    }
    for (const scope of scopes.reverse()) {
      if (scope.repeats) {
        emitBody(`  break ${scope.label};`);
        emitBody("  }");
      }
    }
  }

  const entries = entryNodes(graph);
  const compiledEntries: Array<{
    entry: CompiledEntryPoint;
    declLines: string[];
    bodyLines: BodyLine[];
  }> = [];
  const usedNames = new Set<string>();

  for (const entry of entries.length > 0 ? entries : [null]) {
    if (entry && shouldStrip(entry)) continue;
    body.length = 0;
    outputDecls.clear();
    exprCache.clear();
    pureExpressions = createPureExpressions(graph, options.registry);
    memoDecls = [];
    memoByKey.clear();
    isAsync = false;

    for (const node of graph.nodes) {
      if (shouldStrip(node)) continue;
      if (options.registry.get(node.typeId)?.pure) ensurePure(node);
    }
    useEpoch = memoDecls.length > 0;

    entryNodeId = entry?.id ?? "";
    if (entry) emitExecChain(entry.id);
    else emitBody(`  // empty graph`);

    const name = uniqueName(
      entry ? entryExportName(entry, exportName) : exportName,
      usedNames,
    );
    compiledEntries.push({
      entry: {
        name,
        event: entry ? eventNameForEntry(entry) : undefined,
        nodeId: entry?.id,
        ...(entry ? { graphId: graph.id } : {}),
        isAsync,
        ...(entry ? entryComponentId(entry) : {}),
      },
      declLines: [
        ...(traceExecution
          ? [`  const __dbg = ctx.debugTrace === null ? null : ctx.debugTrace.graph(${JSON.stringify(options.assetGuid)}, ${JSON.stringify(graph.id)});`]
          : []),
        ...(checkBreakpoints
          ? [`  const __bp = ctx.breakpoints === null ? null : ctx.breakpoints.graph(${JSON.stringify(options.assetGuid)}, ${JSON.stringify(graph.id)});`]
          : []),
        ...outputDecls.values(),
        ...pureExpressions.declarations,
        ...(memoDecls.length > 0 ? ["  let __stmt = 0;", ...memoDecls] : []),
      ],
      bodyLines: body.filter((line) => line.text !== ""),
    });
  }

  const finalLines = [...preamble];
  const anchors: CompileAnchor[] = [];

  // Chunks without body anchors (math helpers) go first. A stack frame inside
  // one then has no preceding anchor, so error mapping falls through to the
  // calling statement instead of landing on an earlier ExecuteJavaScript body.
  const hasBodyAnchors = (chunk: HoistChunk) => (chunk.bodyAnchors?.length ?? 0) > 0;
  for (const chunk of [
    ...hoisted.filter((entry) => !hasBodyAnchors(entry)),
    ...hoisted.filter(hasBodyAnchors),
  ]) {
    const lines = chunk.source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      finalLines.push(lines[i]!);
      const bodyAnchor = chunk.bodyAnchors?.find(
        (entry) => entry.relativeLine === i + 1,
      );
      if (bodyAnchor) {
        anchors.push({
          line: finalLines.length,
          column: 1,
          assetGuid: options.assetGuid,
          graphId: graph.id,
          nodeId: chunk.nodeId,
          bodyLine: bodyAnchor.bodyLine,
        });
      }
    }
  }

  for (const compiled of compiledEntries) {
    finalLines.push(
      `export ${compiled.entry.isAsync ? "async " : ""}function ${compiled.entry.name}(ctx) {`,
    );
    if (options.localPreamble?.length) {
      finalLines.push(...options.localPreamble);
    }
    finalLines.push(...compiled.declLines);
    for (const line of compiled.bodyLines) {
      finalLines.push(line.text);
      if (line.anchor) {
        anchors.push({ ...line.anchor, line: finalLines.length });
      }
    }
    finalLines.push(`}`);
  }

  return {
    source: finalLines.join("\n") + "\n",
    anchors,
    exportName: compiledEntries[0]?.entry.name ?? exportName,
    isAsync: compiledEntries.some((c) => c.entry.isAsync),
    entryPoints: compiledEntries.map((c) => c.entry),
  };
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let index = 2;
  while (used.has(name)) name = `${base}_${index++}`;
  used.add(name);
  return name;
}

function entryExportName(entry: GraphNode, fallback: string): string {
  const event = eventNameForEntry(entry);
  return event === undefined ? fallback : exportIdent(event);
}

function entryComponentId(entry: GraphNode): { componentId?: string } {
  const id = entry.properties.componentId;
  if (typeof id !== "string" || !id.trim()) return {};
  return { componentId: id.trim() };
}

const ANIM_RULE_SINKS = [
  {
    typeId: "anim.rule.enterState",
    key: "enter",
    pinName: "value",
  },
  {
    typeId: "anim.rule.exitState",
    key: "exit",
    pinName: "value",
  },
] as const;

/**
 * Compile a pure animation transition graph into `evaluate(ctx) => { enter, exit }`.
 * Disconnected Enter State / Exit State inputs default to true.
 */
export function compileTransitionRuleGraph(
  graph: LogicGraph,
  options: CompileOptions,
): CompileResult {
  graph = withResolvedPinTypes(graph);
  const index = indexGraph(graph);
  const exprCache = new Map<string, string>();
  const pureInProgress = new Set<string>();
  const pureExpressions = createPureExpressions(graph, options.registry);
  /** Module-scope declarations pure nodes share across the rule expressions. */
  const hoisted: string[] = [];
  const shouldStrip = (node: GraphNode) =>
    options.stripDevelopmentOnly === true && isDevelopmentOnlyNode(node);

  function pinExpr(
    node: GraphNode,
    dataPin: GraphPin,
    disconnectedLiteral?: string,
  ): string {
    const key = `${node.id}:${dataPin.id}`;
    const cached = exprCache.get(key);
    if (cached) return cached;
    const incoming = index.incoming(node.id, dataPin.id);
    if (incoming) {
      const srcNode = index.node(incoming.sourceNodeId);
      const srcPin = srcNode && findPin(srcNode, incoming.sourcePinId);
      if (!srcNode || !srcPin || shouldStrip(srcNode)) {
        const lit = disconnectedLiteral ?? defaultValueLiteral(dataPin.type);
        exprCache.set(key, lit);
        return lit;
      }
      const srcDef = options.registry.get(srcNode.typeId);
      if (srcDef?.pure) {
        ensurePure(srcNode);
      }
      const varName = exprCache.get(`${srcNode.id}:${srcPin.id}`);
      if (varName) {
        exprCache.set(key, varName);
        return varName;
      }
    }
    const lit = disconnectedPinLiteral(
      node,
      dataPin,
      options.registry,
      disconnectedLiteral,
    );
    exprCache.set(key, lit);
    return lit;
  }

  function makeCtx(node: GraphNode, bound?: ReadonlyMap<string, string>): CodegenContext {
    return {
      graph,
      node,
      indent: "  ",
      input(pinName) {
        const p = pinForCodegen(node, pinName, "in");
        if (!p) return "undefined";
        return bound?.get(p.id) ?? pinExpr(node, p);
      },
      inputType(pinName) {
        const p = pinForCodegen(node, pinName, "in");
        return p ? wiredSourceType(index, node, p.id, shouldStrip) : undefined;
      },
      isWired(pinId) { return index.incoming(node.id, pinId) !== undefined; },
      output(pinName) {
        const p = pinForCodegen(node, pinName, "out");
        const slotKey = p?.id ?? pinName;
        const name = `_n_${jsIdent(node.id)}_${jsIdent(slotKey)}`;
        if (p) exprCache.set(`${node.id}:${p.id}`, name);
        return name;
      },
      emit() {
        /* pure transition rules do not emit statements */
      },
      hoist(source) {
        if (!hoisted.includes(source)) hoisted.push(source);
      },
      requestAsync() {
        /* unused */
      },
      isLatentFunction: options.isLatentFunction,
    };
  }

  function ensurePure(node: GraphNode) {
    if (shouldStrip(node) || pureInProgress.has(node.id)) return;
    const def = options.registry.get(node.typeId);
    if (!def?.pure) return;
    if (
      node.pins.some(
        (p) =>
          p.direction === "out" &&
          p.kind === "data" &&
          exprCache.has(`${node.id}:${p.id}`),
      )
    ) {
      return;
    }
    const subjects = subjectPinsOf(node, options.registry, options.className);
    pureInProgress.add(node.id);
    let result: ReturnType<typeof def.codegen>;
    let subjectArgs: string[];
    try {
      subjectArgs = subjects.map((subject) => pinExpr(node, subject.pin));
      const bound = new Map(subjects.map((subject, i) => [subject.pin.id, `__s${i}`] as const));
      result = def.codegen(makeCtx(node, bound));
    } finally {
      pureInProgress.delete(node.id);
    }
    if (result && typeof result === "object") {
      for (const [name, expr] of Object.entries(result)) {
        const outPin = pinForCodegen(node, name, "out");
        if (!outPin) continue;
        const guarded = subjects.length > 0
          ? guardPureExpression(subjects, subjectArgs, expr, defaultValueLiteral(outPin.type))
          : expr;
        exprCache.set(`${node.id}:${outPin.id}`, pureExpressions.expression(node, outPin, guarded));
      }
    }
  }

  for (const node of graph.nodes) {
    if (options.registry.get(node.typeId)?.pure) ensurePure(node);
  }

  const results: Record<string, string> = {};
  for (const sink of ANIM_RULE_SINKS) {
    const node = graph.nodes.find((entry) => entry.typeId === sink.typeId);
    if (!node || node.properties.__disabled === true) {
      results[sink.key] = "true";
      continue;
    }
    const pin = node.pins.find(
      (entry) => entry.name === sink.pinName && entry.direction === "in",
    );
    results[sink.key] = pin ? pinExpr(node, pin, "true") : "true";
  }

  const tagPreamble = graph.nodes.some((node) => node.typeId.startsWith("tags."))
    ? tagRuntimeSource(options.tagRegistry).split("\n") : [];
  const hoistedLines = hoisted.flatMap((chunk) => chunk.split("\n"));
  const source = [
    `//# sourceURL=haptic:///${options.assetGuid}.js`,
    ...tagPreamble,
    ...hoistedLines,
    `export function evaluate(ctx) {`,
    ...pureExpressions.declarations,
    `  return { enter: (${results.enter}), exit: (${results.exit}) };`,
    `}`,
    "",
  ].join("\n");

  return {
    source,
    anchors: [
      {
        line: 2 + tagPreamble.length + hoistedLines.length,
        column: 1,
        assetGuid: options.assetGuid,
        graphId: graph.id,
        nodeId:
          graph.nodes.find((entry) => entry.typeId === "anim.rule.exitState")
            ?.id ??
          graph.nodes.find((entry) => entry.typeId === "anim.rule.enterState")
            ?.id ??
          graph.id,
      },
    ],
    exportName: "evaluate",
    isAsync: false,
    entryPoints: [
      {
        name: "evaluate",
        event: "onAnimRule",
        isAsync: false,
        nodeId: graph.nodes.find(
          (entry) => entry.typeId === "anim.rule.exitState",
        )?.id,
      },
    ],
  };
}
