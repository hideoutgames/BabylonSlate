import type { LogicGraph, GraphNode, GraphPin } from "./ir";
import { findNode, findPin } from "./ir";
import type { NodeRegistry, CodegenContext, HoistBodyAnchor } from "./node-registry";
import { defaultValueLiteral } from "./types";
import { pinRejectsStoredDefault, readPinDefaultForPin } from "./pin-defaults";
import { isDevelopmentOnlyNode } from "./development-only";
import { instrumentJsLoops } from "@babylonslate/debugger";
import { entryNodes } from "./compiled-nodes";
import { enumSwitchMemberNameFromPinId } from "./enum-switch-pins";

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
  "flow.event.commandRun": "onCommandRun",
  "flow.event.editorBeginPlay": "onEditorBeginPlay",
  "flow.event.mouseEnter": "onMouseEnter",
  "flow.event.mouseExit": "onMouseExit",
  "flow.event.mousePress": "onMousePress",
  "flow.event.mouseRelease": "onMouseRelease",
  "flow.event.widgetClick": "onWidgetClick",
  "flow.event.editorStartup": "onEditorStartup",
  "flow.event.sceneOpen": "onSceneOpen",
  "flow.event.sceneSaved": "onSceneSaved",
  "flow.event.editorShutdown": "onEditorShutdown",
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
  const node = findNode(graph, nodeId);
  if (!node) return [];
  const outs = node.pins.filter(
    (p) =>
      p.kind === "exec" &&
      p.direction === "out" &&
      (pinName === undefined || p.name === pinName),
  );
  const result: string[] = [];
  for (const out of outs) {
    for (const e of graph.edges) {
      if (e.sourceNodeId === nodeId && e.sourcePinId === out.id) {
        result.push(e.targetNodeId);
      }
    }
  }
  return result;
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
        const slot = `_n_${jsIdent(srcNode.id)}_${jsIdent(srcPin.name)}`;
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
    const prop = readPinDefaultForPin(node.properties, dataPin);
    const lit =
      prop !== undefined && !pinRejectsStoredDefault(dataPin.type)
        ? JSON.stringify(prop)
        : defaultValueLiteral(dataPin.type);
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
        const name = `_n_${jsIdent(node.id)}_${jsIdent(pinName)}`;
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

  function emitExecChain(startId: string, visited = new Set<string>()) {
    let current: string | undefined = startId;
    while (current && !visited.has(current)) {
      visited.add(current);
      const node = findNode(graph, current);
      if (!node) break;
      if (shouldStrip(node)) {
        const targets = stripExecSuccessors(graph, node);
        if (targets.length === 0) break;
        if (targets.length === 1) {
          current = targets[0];
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
        for (const t of execSuccessors(graph, node.id, "true")) {
          emitExecChain(t, new Set(visited));
        }
        emitBody(`  } else {`, anchor);
        for (const t of execSuccessors(graph, node.id, "false")) {
          emitExecChain(t, new Set(visited));
        }
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
        const defaultTargets = execSuccessors(graph, node.id, "Default");
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
            const name = ctx.output(p.name);
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
          for (const t of execSuccessors(graph, node.id, "then")) {
            emitExecChain(t, new Set(visited));
          }
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
          for (const t of execSuccessors(graph, node.id, "then")) {
            emitExecChain(t, new Set(visited));
          }
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
              emitExecChain(e.targetNodeId, new Set(visited));
            }
          }
        }
        break;
      }

      if (def.pure) {
        ensurePure(node);
      } else {
        const ctx = makeCtx(node);
        if (def.latent) isAsync = true;
        for (const p of node.pins) {
          if (p.kind === "data" && p.direction === "out") {
            const name = ctx.output(p.name);
            outputDecls.set(
              name,
              `  let ${name} = ${defaultValueLiteral(p.type)};`,
            );
          }
        }
        def.codegen(ctx);
      }

      const thenTargets = execSuccessors(graph, node.id, "then");
      const targets =
        thenTargets.length > 0 ? thenTargets : execSuccessors(graph, node.id);
      if (targets.length === 0) break;
      if (targets.length === 1) {
        current = targets[0];
        continue;
      }
      for (const t of targets) emitExecChain(t, new Set(visited));
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
    const prop = readPinDefaultForPin(node.properties, dataPin);
    const lit =
      prop !== undefined && !pinRejectsStoredDefault(dataPin.type)
        ? JSON.stringify(prop)
        : (disconnectedLiteral ?? defaultValueLiteral(dataPin.type));
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
        const name = `_n_${jsIdent(node.id)}_${jsIdent(pinName)}`;
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
    if (!node) {
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
