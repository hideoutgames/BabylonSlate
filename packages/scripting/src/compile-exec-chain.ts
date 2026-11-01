import { enumSwitchMemberNameFromPinId } from "./enum-switch-pins";
import { tagCasesConstant, tagCasesOf, tagCasePinId } from "./tags";
import { GATED_EVENT_TYPE_IDS } from "./compile-events";
import {
  execSuccessorEdges,
  stripExecSuccessors,
  type ExecTarget,
} from "./compile-graph-index";
import {
  emitBody,
  loopCheck,
  traceProbe,
  type CodegenState,
  type ExecPath,
  type ExecScope,
} from "./compile-codegen-state";
import { ensurePure, makeCtx } from "./compile-expressions";
import { deadReference } from "./compile-pin-values";
import { emitExecProbes, emitStatementNode } from "./compile-statements";
import { emitFlowSwitch, emitStructuredFlow } from "./compile-structured-flow";
import { emitInputEventEntry } from "./compile-input-events";

/**
 * Several successor chains share one function scope, so each gets its own
 * block: a node reached on two of them must not declare a local twice.
 */
export function emitAlong(s: CodegenState, edges: ExecTarget[], visited: ExecPath) {
  const scoped = edges.length > 1;
  for (const edge of edges) {
    if (scoped) emitBody(s, "  {");
    emitExecChain(s, edge.targetNodeId, new Map(visited), edge.targetPinId, edge.id);
    if (scoped) emitBody(s, "  }");
  }
}

export function emitExecChain(
  s: CodegenState,
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
    const node = s.index.node(current);
    if (!node) break;
    // Taking a wire is reported before the node's loop wrapper opens (once per
    // arrival) and also before a back edge's `continue`, never on loop re-entry.
    if (s.traceExecution && currentVia !== undefined) {
      emitBody(s, traceProbe(`__dbg.edge(${JSON.stringify(currentVia)})`));
    }
    // Control inputs (Gate Open/Close, Do Once Reset) are distinct states.
    const input = currentEntryPin ?? node.pins.find(
      (pin) => pin.kind === "exec" && pin.direction === "in",
    )?.id;
    const key = JSON.stringify([node.id, input]);
    const anchor = {
      column: 1,
      assetGuid: s.options.assetGuid,
      graphId: s.graph.id,
      nodeId: node.id,
    };
    const previous = visited.get(key);
    if (previous) {
      previous.repeats = true;
      previous.opening.text = `  ${previous.label}: while (true) {`;
      if (s.instrumentLoops) emitBody(s, `  ${loopCheck(s, anchor.nodeId)}`, anchor);
      emitBody(s, `  continue ${previous.label};`, anchor);
      break;
    }
    // Reserve an opening; only back-edge targets need a loop wrapper.
    // Native loops keep await, output slots and function locals in this invocation.
    const scope = {
      label: `__exec_${s.nextLabel++}`,
      opening: emitBody(s, "", anchor),
      repeats: false,
    };
    visited.set(key, scope);
    scopes.push(scope);
    if (s.shouldStrip(node)) {
      const targets = stripExecSuccessors(s.index, node);
      if (targets.length === 0) break;
      if (targets.length === 1) {
        current = targets[0]!.targetNodeId;
        currentEntryPin = targets[0]!.targetPinId;
        currentVia = targets[0]!.id;
        continue;
      }
      emitAlong(s, targets, visited);
      break;
    }
    const def = s.options.registry.get(node.typeId);
    if (!def) {
      emitBody(s, `  // missing node type ${node.typeId}`, {
        column: 1,
        assetGuid: s.options.assetGuid,
        graphId: s.graph.id,
        nodeId: node.id,
      });
      break;
    }
    // Event entries that gate their chain on live input report inside the gate.
    if (!GATED_EVENT_TYPE_IDS.has(node.typeId)) emitExecProbes(s, node.id);
    if (s.useEpoch) emitBody(s, "  __stmt++;");

    if (node.typeId === "flow.branch") {
      const ctx = makeCtx(s, node);
      const anchor = {
        column: 1,
        assetGuid: s.options.assetGuid,
        graphId: s.graph.id,
        nodeId: node.id,
      };
      emitBody(s, `  if (${ctx.input("condition")}) {`, anchor);
      emitAlong(s, execSuccessorEdges(s.index, node.id, "true"), visited);
      emitBody(s, `  } else {`, anchor);
      emitAlong(s, execSuccessorEdges(s.index, node.id, "false"), visited);
      emitBody(s, `  }`, anchor);
      break;
    }

    if (node.typeId === "variables.getValidated") {
      const anchor = {
        column: 1,
        assetGuid: s.options.assetGuid,
        graphId: s.graph.id,
        nodeId: node.id,
      };
      // An empty Target leaves the value empty, so execution takes Not Valid,
      // as does a destroyed object.
      const { ctx } = emitStatementNode(s, node, def);
      const value = ctx.output("value");
      emitBody(s, `  if (!${deadReference(value)}) {`, anchor);
      emitAlong(s, execSuccessorEdges(s.index, node.id, "isValid"), visited);
      emitBody(s, `  } else {`, anchor);
      emitAlong(s, execSuccessorEdges(s.index, node.id, "notValid"), visited);
      emitBody(s, `  }`, anchor);
      break;
    }

    if (node.typeId === "enum.switch") {
      const ctx = makeCtx(s, node);
      const anchor = {
        column: 1,
        assetGuid: s.options.assetGuid,
        graphId: s.graph.id,
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
        (pin) => execSuccessorEdges(s.index, node.id, pin.id).length > 0,
      );
      const defaultTargets = execSuccessorEdges(s.index, node.id, "default");
      if (wiredCases.length === 0 && defaultTargets.length === 0) {
        emitBody(s, `  /* enum.switch ${node.id}: no exec outs */`, anchor);
        break;
      }
      for (let i = 0; i < wiredCases.length; i++) {
        const pin = wiredCases[i]!;
        const memberName = enumSwitchMemberNameFromPinId(pin.id) ?? pin.name;
        const keyword = i === 0 ? "if" : "} else if";
        emitBody(
          s,
          `  ${keyword} (${valueExpr} === ${JSON.stringify(memberName)}) {`,
          anchor,
        );
        emitAlong(s, execSuccessorEdges(s.index, node.id, pin.id), visited);
      }
      if (defaultTargets.length > 0) {
        if (wiredCases.length > 0) {
          emitBody(s, `  } else {`, anchor);
        }
        emitAlong(s, defaultTargets, visited);
        if (wiredCases.length > 0) {
          emitBody(s, `  }`, anchor);
        }
      } else if (wiredCases.length > 0) {
        emitBody(s, `  }`, anchor);
      }
      break;
    }

    if (def.structuredFlow?.kind === "switchOnTag") {
      const ctx = makeCtx(s, node);
      const anchor = { column: 1, assetGuid: s.options.assetGuid, graphId: s.graph.id, nodeId: node.id };
      const cases = tagCasesOf(node.properties);
      emitBody(s, `  {`, anchor);
      const list = tagCasesConstant(cases);
      ctx.hoist(list.declaration);
      emitBody(s, `  const __tagCase = __tags.select(${ctx.input("value")}, ${list.name}, ${ctx.input("exact")});`, anchor);
      for (let i = 0; i < cases.length; i++) {
        const tag = cases[i]!;
        emitBody(s, `  ${i === 0 ? "if" : "} else if"} (__tagCase === ${tag}) {`, anchor);
        emitAlong(s, s.index.outgoing(node.id).filter((edge) =>
          edge.sourcePinId === tagCasePinId(tag)), visited);
      }
      if (cases.length) emitBody(s, `  } else {`, anchor);
      emitAlong(s, s.index.outgoing(node.id).filter((edge) =>
        edge.sourcePinId === "default"), visited);
      if (cases.length) emitBody(s, `  }`, anchor);
      emitBody(s, `  }`, anchor);
      break;
    }

    if (
      def.structuredFlow &&
      emitFlowSwitch(s, node, def.structuredFlow, visited, emitAlong)
    ) {
      break;
    }

    if (emitInputEventEntry(s, node, visited, emitAlong)) break;

    if (node.typeId === "flow.sequence") {
      emitAlong(s, execSuccessorEdges(s.index, node.id), visited);
      break;
    }

    if (
      def.structuredFlow &&
      emitStructuredFlow(s, node, def.structuredFlow, visited, currentEntryPin, emitAlong)
    ) {
      break;
    }

    let continuation: string | undefined;
    let runs: string | undefined;
    const flow: { branch?: { expression: string; truePin: string; falsePin: string } } = {};
    if (def.pure) {
      ensurePure(s, node);
    } else {
      runs = emitStatementNode(s, node, def, {
        continuation: (expression) => { continuation = expression; },
        branch: (expression, truePin, falsePin) => { flow.branch = { expression, truePin, falsePin }; },
      }).condition;
    }

    if (flow.branch) {
      const branch = flow.branch;
      const anchor = { column: 1, assetGuid: s.options.assetGuid, graphId: s.graph.id, nodeId: node.id };
      if (s.instrumentLoops) emitBody(s, `  ${loopCheck(s, anchor.nodeId)}`, anchor);
      emitBody(s, `  if (${runs ? `${runs} && (${branch.expression})` : branch.expression}) {`, anchor);
      emitAlong(s, execSuccessorEdges(s.index, node.id, branch.truePin), visited);
      emitBody(s, "  } else {", anchor);
      emitAlong(s, execSuccessorEdges(s.index, node.id, branch.falsePin), visited);
      emitBody(s, "  }", anchor);
      break;
    }

    const thenEdges = execSuccessorEdges(s.index, node.id, "then");
    const edges =
      thenEdges.length > 0 ? thenEdges : execSuccessorEdges(s.index, node.id);
    if (continuation !== undefined) {
      const anchor = { column: 1, assetGuid: s.options.assetGuid, graphId: s.graph.id, nodeId: node.id };
      if (s.instrumentLoops) emitBody(s, `  ${loopCheck(s, anchor.nodeId)}`, anchor);
      emitBody(s, `  if (${runs ? `${runs} && (${continuation})` : continuation}) {`, anchor);
      emitAlong(s, edges, visited);
      emitBody(s, "  }");
      break;
    }
    if (edges.length === 0) break;
    if (edges.length === 1) {
      current = edges[0]!.targetNodeId;
      currentEntryPin = edges[0]!.targetPinId;
      currentVia = edges[0]!.id;
      continue;
    }
    emitAlong(s, edges, visited);
    break;
  }
  for (const scope of scopes.reverse()) {
    if (scope.repeats) {
      emitBody(s, `  break ${scope.label};`);
      emitBody(s, "  }");
    }
  }
}
