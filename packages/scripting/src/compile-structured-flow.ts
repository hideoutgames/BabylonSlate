import type { GraphNode } from "./ir";
import { flowSwitchCaseValueFromPinId } from "./flow-switch-pins";
import {
  isFlowSwitchMeta,
  isLoopMeta,
  type StructuredFlowMeta,
} from "./structured-flow";
import { jsIdent } from "./compile-events";
import { entryPinMatches, execSuccessorEdges } from "./compile-graph-index";
import {
  emitBody,
  loopCheck,
  type CodegenState,
  type EmitAlong,
  type ExecPath,
} from "./compile-codegen-state";
import { makeCtx } from "./compile-expressions";
import { declareDataOuts, emitOutputProbe } from "./compile-statements";

export function emitFlowSwitch(
  s: CodegenState,
  node: GraphNode,
  meta: StructuredFlowMeta,
  visited: ExecPath,
  along: EmitAlong,
): boolean {
  if (!isFlowSwitchMeta(meta)) return false;
  const ctx = makeCtx(s, node);
  const anchor = {
    column: 1,
    assetGuid: s.options.assetGuid,
    graphId: s.graph.id,
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
    (pin) => execSuccessorEdges(s.index, node.id, pin.id).length > 0,
  );
  const defaultTargets = execSuccessorEdges(s.index, node.id, meta.defaultPin);
  if (wiredCases.length === 0 && defaultTargets.length === 0) {
    emitBody(s, `  /* ${node.typeId} ${node.id}: no exec outs */`, anchor);
    return true;
  }
  for (let i = 0; i < wiredCases.length; i++) {
    const pin = wiredCases[i]!;
    const raw = flowSwitchCaseValueFromPinId(pin.id) ?? pin.name;
    const compare =
      meta.kind === "switchOnInt" ? String(Number(raw)) : JSON.stringify(raw);
    const keyword = i === 0 ? "if" : "} else if";
    emitBody(s, `  ${keyword} (${valueExpr} === ${compare}) {`, anchor);
    along(s, execSuccessorEdges(s.index, node.id, pin.id), visited);
  }
  if (defaultTargets.length > 0) {
    if (wiredCases.length > 0) {
      emitBody(s, `  } else {`, anchor);
    }
    along(s, defaultTargets, visited);
    if (wiredCases.length > 0) {
      emitBody(s, `  }`, anchor);
    }
  } else if (wiredCases.length > 0) {
    emitBody(s, `  }`, anchor);
  }
  return true;
}

export function emitStructuredFlow(
  s: CodegenState,
  node: GraphNode,
  meta: StructuredFlowMeta,
  visited: ExecPath,
  entryPinId: string | undefined,
  along: EmitAlong,
): boolean {
  const ctx = makeCtx(s, node);
  const anchor = {
    column: 1,
    assetGuid: s.options.assetGuid,
    graphId: s.graph.id,
    nodeId: node.id,
  };

  if (meta.kind === "break") {
    const loop = s.loopStack.at(-1);
    // Outside a loop the validator reports flow.break_outside_loop; a bare
    // `break;` would stop the whole module from parsing.
    if (!loop) {
      emitBody(s, `  /* flow.break ${node.id}: not inside a loop */`, anchor);
      return true;
    }
    if (!loop.labeled) {
      loop.opening.text = `  ${loop.label}: ${loop.opening.text.trimStart()}`;
      loop.labeled = true;
    }
    emitBody(s, `  break ${loop.label};`, anchor);
    return true;
  }

  if (meta.kind === "whileLoop") {
    const conditionExpr = ctx.input(meta.conditionPin);
    // Each condition check is a statement of its own.
    const condition = s.useEpoch ? `(__stmt++, ${conditionExpr})` : conditionExpr;
    const opening = emitBody(s, `  while (${condition}) {`, anchor);
    if (s.instrumentLoops) emitBody(s, `    ${loopCheck(s, anchor.nodeId)}`, anchor);
    s.loopStack.push({ label: `__loop_${s.nextLabel++}`, opening });
    along(s, execSuccessorEdges(s.index, node.id, meta.loopBodyPin), visited);
    s.loopStack.pop();
    emitBody(s, `  }`, anchor);
    along(s, execSuccessorEdges(s.index, node.id, meta.completedPin), visited);
    return true;
  }

  if (isLoopMeta(meta)) {
    declareDataOuts(s, node, ctx);
    const indexSlot = ctx.output(meta.indexPin);
    if (meta.kind === "forLoop" || meta.kind === "forLoopWithBreak") {
      const firstExpr = ctx.input(meta.firstIndexPin);
      const lastExpr = ctx.input(meta.lastIndexPin);
      const iter = `__i_${jsIdent(node.id)}`;
      const bound = `__bound_${jsIdent(node.id)}`;
      emitBody(s, `  {`, anchor);
      // Like `| 0` without the int32 wrap: Int pins carry safe integers.
      // A non-finite bound (Int division by zero) is 0, not an endless loop.
      emitBody(
        s,
        `    const ${bound} = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; };`,
        anchor,
      );
      // The first Last Index check shares the For Loop's statement with
      // First Index; each later check is a statement of its own.
      const update = s.useEpoch ? `${iter}++, __stmt++` : `${iter}++`;
      const opening = emitBody(
        s,
        `    for (let ${iter} = ${bound}(${firstExpr}); ${iter} <= ${bound}(${lastExpr}); ${update}) {`,
        anchor,
      );
      if (s.instrumentLoops) emitBody(s, `      ${loopCheck(s, anchor.nodeId)}`, anchor);
      emitBody(s, `      ${indexSlot} = ${iter};`, anchor);
      emitOutputProbe(s, node, ctx);
      s.loopStack.push({ label: `__loop_${s.nextLabel++}`, opening });
      along(
        s,
        execSuccessorEdges(s.index, node.id, meta.loopBodyPin),
        visited,
      );
      s.loopStack.pop();
      emitBody(s, `    }`, anchor);
      emitBody(s, `  }`, anchor);
    } else if (meta.kind === "forEach" || meta.kind === "forEachWithBreak") {
      const arrayExpr = ctx.input(meta.arrayPin);
      const elementSlot = ctx.output(meta.elementPin);
      const source = `__src_${jsIdent(node.id)}`;
      const snap = `__snap_${jsIdent(node.id)}`;
      const iter = `__i_${jsIdent(node.id)}`;
      emitBody(s, `  {`, anchor);
      emitBody(s, `    const ${source} = ${arrayExpr};`, anchor);
      emitBody(
        s,
        `    const ${snap} = Array.isArray(${source}) ? ${source}.slice() : [];`,
        anchor,
      );
      const opening = emitBody(
        s,
        `    for (let ${iter} = 0; ${iter} < ${snap}.length; ${iter}++) {`,
        anchor,
      );
      if (s.instrumentLoops) emitBody(s, `      ${loopCheck(s, anchor.nodeId)}`, anchor);
      emitBody(s, `      ${indexSlot} = ${iter};`, anchor);
      emitBody(s, `      ${elementSlot} = ${snap}[${iter}];`, anchor);
      emitOutputProbe(s, node, ctx);
      s.loopStack.push({ label: `__loop_${s.nextLabel++}`, opening });
      along(
        s,
        execSuccessorEdges(s.index, node.id, meta.loopBodyPin),
        visited,
      );
      s.loopStack.pop();
      emitBody(s, `    }`, anchor);
      emitBody(s, `  }`, anchor);
    } else if (
      meta.kind === "forEachMap" ||
      meta.kind === "forEachMapWithBreak"
    ) {
      const mapExpr = ctx.input(meta.mapPin);
      const keySlot = ctx.output(meta.keyPin);
      const valueSlot = ctx.output(meta.valuePin);
      const snap = `__snap_${jsIdent(node.id)}`;
      const iter = `__i_${jsIdent(node.id)}`;
      emitBody(s, `  {`, anchor);
      emitBody(
        s,
        `    const ${snap} = [...(new Map(${mapExpr} ?? [])).entries()];`,
        anchor,
      );
      const opening = emitBody(
        s,
        `    for (let ${iter} = 0; ${iter} < ${snap}.length; ${iter}++) {`,
        anchor,
      );
      if (s.instrumentLoops) emitBody(s, `      ${loopCheck(s, anchor.nodeId)}`, anchor);
      emitBody(s, `      ${indexSlot} = ${iter};`, anchor);
      emitBody(s, `      ${keySlot} = ${snap}[${iter}][0];`, anchor);
      emitBody(s, `      ${valueSlot} = ${snap}[${iter}][1];`, anchor);
      emitOutputProbe(s, node, ctx);
      s.loopStack.push({ label: `__loop_${s.nextLabel++}`, opening });
      along(
        s,
        execSuccessorEdges(s.index, node.id, meta.loopBodyPin),
        visited,
      );
      s.loopStack.pop();
      emitBody(s, `    }`, anchor);
      emitBody(s, `  }`, anchor);
    }
    along(s, execSuccessorEdges(s.index, node.id, meta.completedPin), visited);
    return true;
  }

  if (meta.kind === "doOnce") {
    if (entryPinMatches(node, meta.resetPin, entryPinId)) {
      emitBody(
        s,
        `  ctx.flowState(${JSON.stringify(node.id)}).done = false;`,
        anchor,
      );
      return true;
    }
    emitBody(s, `  {`, anchor);
    emitBody(
      s,
      `    const __st = ctx.flowState(${JSON.stringify(node.id)});`,
      anchor,
    );
    emitBody(s, `    if (!__st.done) {`, anchor);
    emitBody(s, `      __st.done = true;`, anchor);
    along(s, execSuccessorEdges(s.index, node.id, meta.thenPin), visited);
    emitBody(s, `    }`, anchor);
    emitBody(s, `  }`, anchor);
    return true;
  }

  if (meta.kind === "doN") {
    declareDataOuts(s, node, ctx);
    const counterSlot = ctx.output(meta.counterPin);
    if (entryPinMatches(node, meta.resetPin, entryPinId)) {
      emitBody(
        s,
        `  ctx.flowState(${JSON.stringify(node.id)}).count = 0;`,
        anchor,
      );
      return true;
    }
    const nExpr = ctx.input(meta.nPin);
    emitBody(s, `  {`, anchor);
    emitBody(
      s,
      `    const __st = ctx.flowState(${JSON.stringify(node.id)});`,
      anchor,
    );
    emitBody(s, `    if (__st.count == null) __st.count = 0;`, anchor);
    emitBody(s, `    if ((__st.count | 0) < ((${nExpr}) | 0)) {`, anchor);
    emitBody(s, `      ${counterSlot} = __st.count | 0;`, anchor);
    emitOutputProbe(s, node, ctx);
    emitBody(s, `      __st.count = (__st.count | 0) + 1;`, anchor);
    along(s, execSuccessorEdges(s.index, node.id, meta.thenPin), visited);
    emitBody(s, `    }`, anchor);
    emitBody(s, `  }`, anchor);
    return true;
  }

  if (meta.kind === "flipFlop") {
    declareDataOuts(s, node, ctx);
    const isASlot = ctx.output(meta.isAPin);
    emitBody(s, `  {`, anchor);
    emitBody(
      s,
      `    const __st = ctx.flowState(${JSON.stringify(node.id)});`,
      anchor,
    );
    emitBody(s, `    const __isA = __st.nextIsB !== true;`, anchor);
    emitBody(s, `    __st.nextIsB = __isA;`, anchor);
    emitBody(s, `    ${isASlot} = __isA;`, anchor);
    emitOutputProbe(s, node, ctx);
    emitBody(s, `    if (__isA) {`, anchor);
    along(s, execSuccessorEdges(s.index, node.id, meta.aPin), visited);
    emitBody(s, `    } else {`, anchor);
    along(s, execSuccessorEdges(s.index, node.id, meta.bPin), visited);
    emitBody(s, `    }`, anchor);
    emitBody(s, `  }`, anchor);
    return true;
  }

  if (meta.kind === "gate") {
    if (entryPinMatches(node, meta.openPin, entryPinId)) {
      emitBody(
        s,
        `  ctx.flowState(${JSON.stringify(node.id)}).open = true;`,
        anchor,
      );
      return true;
    }
    if (entryPinMatches(node, meta.closePin, entryPinId)) {
      emitBody(
        s,
        `  ctx.flowState(${JSON.stringify(node.id)}).open = false;`,
        anchor,
      );
      return true;
    }
    if (entryPinMatches(node, meta.togglePin, entryPinId)) {
      emitBody(s, `  {`, anchor);
      emitBody(
        s,
        `    const __st = ctx.flowState(${JSON.stringify(node.id)});`,
        anchor,
      );
      emitBody(s, `    __st.open = !__st.open;`, anchor);
      emitBody(s, `  }`, anchor);
      return true;
    }
    // Enter (default)
    const startOpen = meta.startClosed === true ? "false" : "true";
    emitBody(s, `  {`, anchor);
    emitBody(
      s,
      `    const __st = ctx.flowState(${JSON.stringify(node.id)});`,
      anchor,
    );
    emitBody(s, `    if (__st.open == null) __st.open = ${startOpen};`, anchor);
    emitBody(s, `    if (__st.open) {`, anchor);
    along(s, execSuccessorEdges(s.index, node.id, meta.exitPin), visited);
    emitBody(s, `    }`, anchor);
    emitBody(s, `  }`, anchor);
    return true;
  }

  return false;
}
