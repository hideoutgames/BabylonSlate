import type { GraphNode } from "./ir";
import { defaultValueLiteral } from "./types";
import { jsIdent, TOUCH_EVENT_PHASES } from "./compile-events";
import { execSuccessorEdges } from "./compile-graph-index";
import {
  emitBody,
  loopCheck,
  type CodegenState,
  type EmitAlong,
  type ExecPath,
} from "./compile-codegen-state";
import { makeCtx } from "./compile-expressions";
import {
  declareDataOuts,
  emitExecProbes,
  emitOutputProbe,
} from "./compile-statements";

/**
 * Input event entries (Input Action and Axis, Any Key, the touch events and the
 * gamepad connection events) run their chain only for the input this tick
 * resolved. Returns false when `node` is not one of them.
 */
export function emitInputEventEntry(
  s: CodegenState,
  node: GraphNode,
  visited: ExecPath,
  along: EmitAlong,
): boolean {
  if (
    node.typeId === "input.actionEvent" ||
    node.typeId === "input.axisEvent"
  ) {
    const ctx = makeCtx(s, node);
    const anchor = {
      column: 1,
      assetGuid: s.options.assetGuid,
      graphId: s.graph.id,
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
      s,
      `  const ${candidate} = ctx.getInputState?.(${input});`,
      anchor,
    );
    emitBody(
      s,
      `  const ${snapshot} = ${candidate}?.valueType === ${JSON.stringify(valueType)} ? ${candidate} : null;`,
      anchor,
    );
    // Function-level declarations: a pure consumer may already have hoisted these slots.
    declareDataOuts(s, node, ctx);
    for (const p of node.pins.filter(
      (p) => p.kind === "data" && p.direction === "out",
    )) {
      emitBody(
        s,
        `  ${ctx.output(p.id)} = ${snapshot}?.${p.id} ?? ${defaultValueLiteral(p.type)};`,
        anchor,
      );
    }
    // A release/repress in one tick finishes the old hold before starting anew.
    const phases = `__phases_${jsIdent(node.id)}`;
    emitBody(
      s,
      `  const ${phases} = ${snapshot}?.held ? ["released", "started", "held"] : ["started", "released"];`,
      anchor,
    );
    emitBody(s, `  for (const __phase of ${phases}) {`, anchor);
    for (const phase of ["started", "held", "released"]) {
      emitBody(
        s,
        `    if (__phase === "${phase}" && ${snapshot}?.${phase}) {`,
        anchor,
      );
      emitExecProbes(s, node.id);
      emitOutputProbe(s, node, ctx);
      along(s, execSuccessorEdges(s.index, node.id, phase), new Map(visited));
      emitBody(s, "    }", anchor);
    }
    emitBody(s, "  }", anchor);
    return true;
  }

  if (node.typeId === "input.onAnyKeyPressed") {
    const ctx = makeCtx(s, node);
    const anchor = {
      column: 1,
      assetGuid: s.options.assetGuid,
      graphId: s.graph.id,
      nodeId: node.id,
    };
    declareDataOuts(s, node, ctx);
    const pressedKey = `__key_${jsIdent(node.id)}`;
    emitBody(
      s,
      `  for (const ${pressedKey} of (ctx.getPressedKeys?.() ?? [])) {`,
      anchor,
    );
    if (s.instrumentLoops) emitBody(s, `    ${loopCheck(s, anchor.nodeId)}`, anchor);
    emitBody(s, `    ${ctx.output("key")} = ${pressedKey};`, anchor);
    emitExecProbes(s, node.id);
    emitOutputProbe(s, node, ctx);
    along(s, execSuccessorEdges(s.index, node.id, "Then"), visited);
    emitBody(s, "  }", anchor);
    return true;
  }

  const touchPhases = TOUCH_EVENT_PHASES[node.typeId];
  if (touchPhases) {
    const ctx = makeCtx(s, node);
    const anchor = {
      column: 1,
      assetGuid: s.options.assetGuid,
      graphId: s.graph.id,
      nodeId: node.id,
    };
    declareDataOuts(s, node, ctx);
    const touch = `__touch_${jsIdent(node.id)}`;
    const matches = touchPhases.map((phase) => `${touch}.Phase === ${JSON.stringify(phase)}`).join(" || ");
    emitBody(
      s,
      `  for (const ${touch} of (ctx.getTouchEvents?.() ?? [])) {`,
      anchor,
    );
    emitBody(s, `    if (!(${matches})) continue;`, anchor);
    if (s.instrumentLoops) emitBody(s, `    ${loopCheck(s, anchor.nodeId)}`, anchor);
    const outputs: Record<string, string> = {
      touch,
      finger: `${touch}.Finger`,
      position: `${touch}.Position`,
      delta: `${touch}.Delta`,
      cancelled: `${touch}.Phase === "Cancelled"`,
    };
    for (const pin of node.pins) {
      const value = pin.kind === "data" && pin.direction === "out" ? outputs[pin.id] : undefined;
      if (value) emitBody(s, `    ${ctx.output(pin.id)} = ${value};`, anchor);
    }
    emitExecProbes(s, node.id);
    emitOutputProbe(s, node, ctx);
    along(s, execSuccessorEdges(s.index, node.id, "execOut"), visited);
    emitBody(s, "  }", anchor);
    return true;
  }

  // Input event entries gate their then-chain on the resolved tick state.
  if (
    node.typeId === "input.onGamepadConnected" ||
    node.typeId === "input.onGamepadDisconnected"
  ) {
    const ctx = makeCtx(s, node);
    const anchor = {
      column: 1,
      assetGuid: s.options.assetGuid,
      graphId: s.graph.id,
      nodeId: node.id,
    };
    declareDataOuts(s, node, ctx);
    const connected = node.typeId === "input.onGamepadConnected";
    const padIndexSlot = ctx.output("index");
    emitBody(
      s,
      `  for (const __pad of (ctx.gamepadConnections ?? []).filter((c) => c.connected === ${connected})) {`,
      anchor,
    );
    if (s.instrumentLoops) emitBody(s, `    ${loopCheck(s, anchor.nodeId)}`, anchor);
    emitBody(s, `    ${padIndexSlot} = __pad.gamepadIndex;`, anchor);
    emitExecProbes(s, node.id);
    emitOutputProbe(s, node, ctx);
    along(s, execSuccessorEdges(s.index, node.id, "then"), visited);
    emitBody(s, `  }`, anchor);
    return true;
  }

  return false;
}
