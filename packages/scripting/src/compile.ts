import type { LogicGraph, GraphNode, GraphPin } from "./ir";
import { findNode, findPin } from "./ir";
import type { NodeRegistry, CodegenContext, HoistBodyAnchor } from "./node-registry";
import { defaultValueLiteral } from "./types";
import { pinRejectsStoredDefault, readPinDefaultForPin } from "./pin-defaults";
import { isDevelopmentOnlyNode } from "./development-only";
import { instrumentJsLoops } from "@babylonslate/debugger";
import { entryNodes } from "./compiled-nodes";
import { enumSwitchMemberNameFromPinId } from "./enum-switch-pins";
import {
  flowSwitchCaseValueFromPinId,
} from "./flow-switch-pins";
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
export type ScriptEventName = "onBeginPlay" | "onTick" | "onCommandRun" | string;

export const EVENT_BY_TYPE_ID: Record<string, ScriptEventName> = {
  "flow.event.beginPlay": "onBeginPlay",
  "flow.event.tick": "onTick",
  "flow.event.destroyed": "onDestroyed",
  "flow.event.init": "onInit",
  "flow.event.end": "onEnd",
  "flow.event.firstSceneLoaded": "onFirstSceneLoaded",
  "flow.event.sceneStartLoading": "onSceneStartLoading",
  "flow.event.sceneFinishLoading": "onSceneFinishLoading",
  "flow.event.sceneExit": "onSceneExit",
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
  "flow.event.audioFinished": "onAudioFinished",
  "bt.event.activate": "onActivate",
  "bt.event.tick": "onBtTick",
  "bt.event.abort": "onAbort",
  "bt.event.evaluate": "onEvaluate",
  "anim.event.initialize": "onInitializeAnimation",
  "anim.event.update": "onUpdateAnimation",
  // Input event entries gate internally; they run on the tick like Event Tick.
  "input.onAction": "onTick",
  "input.onGamepadConnected": "onTick",
  "input.onGamepadDisconnected": "onTick",
};

/** Custom events use the member name; catalog events use EVENT_BY_TYPE_ID. */
export function eventNameForEntry(entry: GraphNode): ScriptEventName | undefined {
  if (entry.typeId === "flow.event.custom") {
    const raw = entry.properties.name ?? entry.properties.title ?? "";
    const ident = jsIdent(String(raw));
    return ident.length > 0 ? ident : undefined;
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

function edgeToInput(
  graph: LogicGraph,
  nodeId: string,
  pinId: string,
): { sourceNodeId: string; sourcePinId: string } | undefined {
  const edge = graph.edges.find(
    (e) => e.targetNodeId === nodeId && e.targetPinId === pinId,
  );
  return edge
    ? { sourceNodeId: edge.sourceNodeId, sourcePinId: edge.sourcePinId }
    : undefined;
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
function stripExecSuccessors(graph: LogicGraph, node: GraphNode): string[] {
  const passthrough = node.pins.filter(isPassthroughExecOut);
  if (passthrough.length > 0) {
    const targets: string[] = [];
    for (const out of passthrough) {
      targets.push(...execSuccessors(graph, node.id, out.name));
    }
    return targets;
  }
  const outs = node.pins.filter(
    (pin) => pin.kind === "exec" && pin.direction === "out",
  );
  if (outs.length === 1) {
    return execSuccessors(graph, node.id, outs[0]!.name);
  }
  return [];
}

function execSuccessors(
  graph: LogicGraph,
  nodeId: string,
  pinName?: string,
): string[] {
  return execSuccessorEdges(graph, nodeId, pinName).map((e) => e.targetNodeId);
}

function execSuccessorEdges(
  graph: LogicGraph,
  nodeId: string,
  pinName?: string,
): Array<{ targetNodeId: string; targetPinId: string }> {
  const node = findNode(graph, nodeId);
  if (!node) return [];
  const outs = node.pins.filter(
    (p) =>
      p.kind === "exec" &&
      p.direction === "out" &&
      (pinName === undefined || p.name === pinName),
  );
  const result: Array<{ targetNodeId: string; targetPinId: string }> = [];
  for (const out of outs) {
    for (const e of graph.edges) {
      if (e.sourceNodeId === nodeId && e.sourcePinId === out.id) {
        result.push({
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

function pinForCodegen(
  node: GraphNode,
  pinName: string,
  direction: "in" | "out",
): GraphPin | undefined {
  return (
    node.pins.find((pin) => pin.direction === direction && pin.id === pinName) ??
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

function disconnectedPinLiteral(
  node: GraphNode,
  dataPin: GraphPin,
  registry: NodeRegistry,
  fallbackLiteral?: string,
): string {
  const prop = readPinDefaultForPin(node.properties, dataPin);
  if (prop !== undefined && !pinRejectsStoredDefault(dataPin.type)) {
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
  const exportName = options.exportName ?? "run";
  const preamble = [`//# sourceURL=babylonslate:///${options.assetGuid}.js`];
  type HoistChunk = {
    source: string;
    nodeId: string;
    bodyAnchors?: readonly HoistBodyAnchor[];
  };
  const hoisted: HoistChunk[] = [];
  type BodyLine = { text: string; anchor?: Omit<CompileAnchor, "line"> };
  const body: BodyLine[] = [];
  const shouldStrip = (node: GraphNode) =>
    options.stripDevelopmentOnly === true && isDevelopmentOnlyNode(node);
  const instrumentLoops = options.instrumentInfiniteLoops === true;
  const loopCheck = "ctx.checkInfiniteLoop();";
  const exprCache = new Map<string, string>();
  /**
   * Impure output slots are declared once at the top of the entry point so a
   * node emitted under several exec branches neither redeclares them nor
   * traps its results inside a block scope.
   */
  const outputDecls = new Map<string, string>();
  let isAsync = false;

  const emitBody = (text: string, anchor?: Omit<CompileAnchor, "line">) => {
    body.push({ text, anchor });
  };

  function pinExpr(node: GraphNode, dataPin: GraphPin): string {
    const key = `${node.id}:${dataPin.id}`;
    const cached = exprCache.get(key);
    if (cached) return cached;
    const incoming = edgeToInput(graph, node.id, dataPin.id);
    if (incoming) {
      const srcNode = findNode(graph, incoming.sourceNodeId)!;
      const srcPin = findPin(srcNode, incoming.sourcePinId)!;
      if (shouldStrip(srcNode)) {
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

  function makeCtx(node: GraphNode): CodegenContext {
    return {
      graph,
      node,
      indent: "  ",
      input(pinName) {
        const p = pinForCodegen(node, pinName, "in");
        if (!p) return "undefined";
        return pinExpr(node, p);
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
        if (instrumentLoops) emitBody(`  ${loopCheck}`, anchor);
        emitBody(`  ${statement}`, anchor);
      },
      hoist(source, bodyAnchors) {
        const next = instrumentLoops
          ? instrumentJsLoops(source, "ctx.checkInfiniteLoop()")
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
    if (shouldStrip(node)) return;
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
    const result = def.codegen(makeCtx(node));
    if (result && typeof result === "object") {
      for (const [name, expr] of Object.entries(result)) {
        const outPin = pinForCodegen(node, name, "out");
        if (outPin) exprCache.set(`${node.id}:${outPin.id}`, `(${expr})`);
      }
    }
  }

  function emitAlong(
    edges: Array<{ targetNodeId: string; targetPinId: string }>,
    visited: Set<string>,
  ) {
    for (const edge of edges) {
      emitExecChain(edge.targetNodeId, new Set(visited), edge.targetPinId);
    }
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
    visited: Set<string>,
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
      (pin) => execSuccessors(graph, node.id, pin.name).length > 0,
    );
    const defaultTargets = execSuccessors(graph, node.id, "Default");
    if (wiredCases.length === 0 && defaultTargets.length === 0) {
      emitBody(`  /* ${node.typeId} ${node.id}: no exec outs */`, anchor);
      return true;
    }
    for (let i = 0; i < wiredCases.length; i++) {
      const pin = wiredCases[i]!;
      const raw = flowSwitchCaseValueFromPinId(pin.id) ?? pin.name;
      const compare =
        meta.kind === "switchOnInt"
          ? String(Number(raw))
          : JSON.stringify(raw);
      const keyword = i === 0 ? "if" : "} else if";
      emitBody(`  ${keyword} (${valueExpr} === ${compare}) {`, anchor);
      for (const target of execSuccessors(graph, node.id, pin.name)) {
        emitExecChain(target, new Set(visited));
      }
    }
    if (defaultTargets.length > 0) {
      if (wiredCases.length > 0) {
        emitBody(`  } else {`, anchor);
      }
      for (const target of defaultTargets) {
        emitExecChain(target, new Set(visited));
      }
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
    visited: Set<string>,
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
      emitBody(`  break;`, anchor);
      return true;
    }

    if (meta.kind === "whileLoop") {
      const conditionExpr = ctx.input(meta.conditionPin);
      emitBody(`  while (${conditionExpr}) {`, anchor);
      if (instrumentLoops) emitBody(`    ${loopCheck}`, anchor);
      emitAlong(execSuccessorEdges(graph, node.id, meta.loopBodyPin), visited);
      emitBody(`  }`, anchor);
      emitAlong(execSuccessorEdges(graph, node.id, meta.completedPin), visited);
      return true;
    }

    if (isLoopMeta(meta)) {
      declareDataOuts(node, ctx);
      const indexSlot = ctx.output(meta.indexPin);
      if (meta.kind === "forLoop" || meta.kind === "forLoopWithBreak") {
        const firstExpr = ctx.input(meta.firstIndexPin);
        const lastExpr = ctx.input(meta.lastIndexPin);
        const iter = `__i_${jsIdent(node.id)}`;
        emitBody(`  {`, anchor);
        emitBody(
          `    for (let ${iter} = (${firstExpr}) | 0; ${iter} <= ((${lastExpr}) | 0); ${iter}++) {`,
          anchor,
        );
        if (instrumentLoops) emitBody(`      ${loopCheck}`, anchor);
        emitBody(`      ${indexSlot} = ${iter};`, anchor);
        emitAlong(execSuccessorEdges(graph, node.id, meta.loopBodyPin), visited);
        emitBody(`    }`, anchor);
        emitBody(`  }`, anchor);
      } else if (meta.kind === "forEach" || meta.kind === "forEachWithBreak") {
        const arrayExpr = ctx.input(meta.arrayPin);
        const elementSlot = ctx.output(meta.elementPin);
        const snap = `__snap_${jsIdent(node.id)}`;
        const iter = `__i_${jsIdent(node.id)}`;
        emitBody(`  {`, anchor);
        emitBody(
          `    const ${snap} = Array.isArray(${arrayExpr}) ? (${arrayExpr}).slice() : [];`,
          anchor,
        );
        emitBody(
          `    for (let ${iter} = 0; ${iter} < ${snap}.length; ${iter}++) {`,
          anchor,
        );
        if (instrumentLoops) emitBody(`      ${loopCheck}`, anchor);
        emitBody(`      ${indexSlot} = ${iter};`, anchor);
        emitBody(`      ${elementSlot} = ${snap}[${iter}];`, anchor);
        emitAlong(execSuccessorEdges(graph, node.id, meta.loopBodyPin), visited);
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
        emitBody(
          `    for (let ${iter} = 0; ${iter} < ${snap}.length; ${iter}++) {`,
          anchor,
        );
        if (instrumentLoops) emitBody(`      ${loopCheck}`, anchor);
        emitBody(`      ${indexSlot} = ${iter};`, anchor);
        emitBody(`      ${keySlot} = ${snap}[${iter}][0];`, anchor);
        emitBody(`      ${valueSlot} = ${snap}[${iter}][1];`, anchor);
        emitAlong(execSuccessorEdges(graph, node.id, meta.loopBodyPin), visited);
        emitBody(`    }`, anchor);
        emitBody(`  }`, anchor);
      }
      emitAlong(execSuccessorEdges(graph, node.id, meta.completedPin), visited);
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
      emitAlong(execSuccessorEdges(graph, node.id, meta.thenPin), visited);
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
      emitBody(`      __st.count = (__st.count | 0) + 1;`, anchor);
      emitAlong(execSuccessorEdges(graph, node.id, meta.thenPin), visited);
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
      emitBody(`    if (__isA) {`, anchor);
      emitAlong(execSuccessorEdges(graph, node.id, meta.aPin), visited);
      emitBody(`    } else {`, anchor);
      emitAlong(execSuccessorEdges(graph, node.id, meta.bPin), visited);
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
      emitBody(
        `    if (__st.open == null) __st.open = ${startOpen};`,
        anchor,
      );
      emitBody(`    if (__st.open) {`, anchor);
      emitAlong(execSuccessorEdges(graph, node.id, meta.exitPin), visited);
      emitBody(`    }`, anchor);
      emitBody(`  }`, anchor);
      return true;
    }

    return false;
  }

  function emitExecChain(
    startId: string,
    visited = new Set<string>(),
    entryPinId?: string,
  ) {
    let current: string | undefined = startId;
    let currentEntryPin = entryPinId;
    while (current && !visited.has(current)) {
      visited.add(current);
      const node = findNode(graph, current);
      if (!node) break;
      if (shouldStrip(node)) {
        const targets = stripExecSuccessors(graph, node);
        if (targets.length === 0) break;
        if (targets.length === 1) {
          current = targets[0];
          currentEntryPin = undefined;
          continue;
        }
        for (const t of targets) emitExecChain(t, new Set(visited));
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

      if (node.typeId === "flow.branch") {
        const ctx = makeCtx(node);
        const anchor = {
          column: 1,
          assetGuid: options.assetGuid,
          graphId: graph.id,
          nodeId: node.id,
        };
        emitBody(`  if (${ctx.input("condition")}) {`, anchor);
        emitAlong(execSuccessorEdges(graph, node.id, "true"), visited);
        emitBody(`  } else {`, anchor);
        emitAlong(execSuccessorEdges(graph, node.id, "false"), visited);
        emitBody(`  }`, anchor);
        break;
      }

      if (node.typeId === "variables.getValidated") {
        const ctx = makeCtx(node);
        const anchor = {
          column: 1,
          assetGuid: options.assetGuid,
          graphId: graph.id,
          nodeId: node.id,
        };
        declareDataOuts(node, ctx);
        def.codegen(ctx);
        const value = ctx.output("value");
        emitBody(`  if (${value} != null) {`, anchor);
        emitAlong(execSuccessorEdges(graph, node.id, "Is Valid"), visited);
        emitBody(`  } else {`, anchor);
        emitAlong(execSuccessorEdges(graph, node.id, "Not Valid"), visited);
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
          (pin) => execSuccessors(graph, node.id, pin.name).length > 0,
        );
        const defaultTargets = execSuccessorEdges(graph, node.id, "Default");
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
          emitAlong(execSuccessorEdges(graph, node.id, pin.name), visited);
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

      if (
        def.structuredFlow &&
        emitFlowSwitch(node, def.structuredFlow, visited)
      ) {
        break;
      }

      // Input event entries gate their then-chain on the resolved tick state.
      if (
        node.typeId === "input.onAction" ||
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
        for (const p of node.pins) {
          if (p.kind === "data" && p.direction === "out") {
            const name = ctx.output(p.id);
            emitBody(`  let ${name} = ${defaultValueLiteral(p.type)};`, anchor);
          }
        }
        if (node.typeId === "input.onAction") {
          const action = ctx.input("action");
          const phase = ctx.input("phase");
          emitBody(
            `  if (((${phase} === "released" ? ctx.wasActionReleased?.(${action}) : ctx.wasActionPressed?.(${action})) ?? false)) {`,
            anchor,
          );
          emitAlong(execSuccessorEdges(graph, node.id, "then"), visited);
          emitBody(`  }`, anchor);
        } else {
          const connected = node.typeId === "input.onGamepadConnected";
          const index = ctx.output("index");
          emitBody(
            `  for (const __pad of (ctx.gamepadConnections ?? []).filter((c) => c.connected === ${connected})) {`,
            anchor,
          );
          if (instrumentLoops) emitBody(`    ${loopCheck}`, anchor);
          emitBody(`    ${index} = __pad.gamepadIndex;`, anchor);
          emitAlong(execSuccessorEdges(graph, node.id, "then"), visited);
          emitBody(`  }`, anchor);
        }
        break;
      }

      if (node.typeId === "flow.sequence") {
        for (const outPin of node.pins.filter(
          (p) => p.kind === "exec" && p.direction === "out",
        )) {
          for (const e of graph.edges) {
            if (e.sourceNodeId === node.id && e.sourcePinId === outPin.id) {
              emitExecChain(
                e.targetNodeId,
                new Set(visited),
                e.targetPinId,
              );
            }
          }
        }
        break;
      }

      if (
        def.structuredFlow &&
        emitStructuredFlow(node, def.structuredFlow, visited, currentEntryPin)
      ) {
        break;
      }

      if (def.pure) {
        ensurePure(node);
      } else {
        const ctx = makeCtx(node);
        if (def.latent) isAsync = true;
        declareDataOuts(node, ctx);
        def.codegen(ctx);
      }

      const thenEdges = execSuccessorEdges(graph, node.id, "then");
      const edges =
        thenEdges.length > 0 ? thenEdges : execSuccessorEdges(graph, node.id);
      if (edges.length === 0) break;
      if (edges.length === 1) {
        current = edges[0]!.targetNodeId;
        currentEntryPin = edges[0]!.targetPinId;
        continue;
      }
      emitAlong(edges, visited);
      break;
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
    isAsync = false;

    for (const node of graph.nodes) {
      if (shouldStrip(node)) continue;
      if (options.registry.get(node.typeId)?.pure) ensurePure(node);
    }

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
        isAsync,
        ...(entry ? entryComponentId(entry) : {}),
      },
      declLines: [...outputDecls.values()],
      bodyLines: [...body],
    });
  }

  const finalLines = [...preamble];
  const anchors: CompileAnchor[] = [];

  for (const chunk of hoisted) {
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
  return eventNameForEntry(entry) ?? fallback;
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
  const exprCache = new Map<string, string>();
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
    const incoming = edgeToInput(graph, node.id, dataPin.id);
    if (incoming) {
      const srcNode = findNode(graph, incoming.sourceNodeId);
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

  function makeCtx(node: GraphNode): CodegenContext {
    return {
      graph,
      node,
      indent: "  ",
      input(pinName) {
        const p = pinForCodegen(node, pinName, "in");
        if (!p) return "undefined";
        return pinExpr(node, p);
      },
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
      hoist() {
        /* unused */
      },
      requestAsync() {
        /* unused */
      },
      isLatentFunction: options.isLatentFunction,
    };
  }

  function ensurePure(node: GraphNode) {
    if (shouldStrip(node)) return;
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
    const result = def.codegen(makeCtx(node));
    if (result && typeof result === "object") {
      for (const [name, expr] of Object.entries(result)) {
        const outPin = pinForCodegen(node, name, "out");
        if (outPin) exprCache.set(`${node.id}:${outPin.id}`, `(${expr})`);
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

  const source = [
    `//# sourceURL=babylonslate:///${options.assetGuid}.js`,
    `export function evaluate(ctx) {`,
    `  return { enter: (${results.enter}), exit: (${results.exit}) };`,
    `}`,
    "",
  ].join("\n");

  return {
    source,
    anchors: [
      {
        line: 2,
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
        nodeId: graph.nodes.find((entry) => entry.typeId === "anim.rule.exitState")
          ?.id,
      },
    ],
  };
}
