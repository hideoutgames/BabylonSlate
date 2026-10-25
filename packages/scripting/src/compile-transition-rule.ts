import type { LogicGraph, GraphNode, GraphPin } from "./ir";
import { findPin } from "./ir";
import type { CodegenContext } from "./node-registry";
import { defaultValueLiteral } from "./types";
import { isDevelopmentOnlyNode } from "./development-only";
import { createPureExpressions } from "./pure-expressions";
import { tagRuntimeSource } from "./tags";
import type { CompileOptions, CompileResult } from "./compile-types";
import { jsIdent } from "./compile-events";
import {
  indexGraph,
  pinForCodegen,
  wiredSourceType,
  withResolvedPinTypes,
} from "./compile-graph-index";
import {
  disconnectedPinLiteral,
  guardPureExpression,
  subjectPinsOf,
} from "./compile-pin-values";

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
