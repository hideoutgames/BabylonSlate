import { BREAKPOINT_PAUSE_CODE } from "@haptic/bridge";
import { INFINITE_LOOP_DIAGNOSTIC_CODE, isInfiniteLoopError } from "@haptic/debugger";
import type { RuntimeDiagnostic } from "./diagnostics";
import type { RuntimeComposition } from "./runtime-composition";
import type { BreakpointHit } from "./script-breakpoints";
import { debugInstanceLabel } from "./script-debug";
import { RuntimeContinuationCancelled } from "./simulation-waits";
import { mapStackToAnchor } from "./stack-map";

/** `RuntimeDriver.reportError`: records, logs and emits an uncaught error as a session diagnostic. */
export function reportRuntimeError(
  rt: RuntimeComposition,
  error: unknown,
  frameId: number,
  hint?: { btNodeId?: string; assetGuid?: string },
): RuntimeDiagnostic | null {
  if (error instanceof RuntimeContinuationCancelled && rt.stopped) return null;
  const err = error instanceof Error ? error : new Error(String(error));
  const stack = err.stack ?? "";
  const anchor = mapStackToAnchor(stack, rt.anchors);
  const location = isInfiniteLoopError(err) ? err.scriptLocation : undefined;
  const diag: RuntimeDiagnostic = {
    code: isInfiniteLoopError(err)
      ? INFINITE_LOOP_DIAGNOSTIC_CODE
      : "runtime.uncaught",
    message: err.message,
    severity: "error",
    assetGuid: hint?.assetGuid ?? rt.behaviourTrees.currentAssetGuid ?? location?.assetGuid ?? anchor?.assetGuid,
    graphId: location?.graphId ?? anchor?.graphId,
    nodeId: hint?.btNodeId ? undefined : location?.nodeId ?? anchor?.nodeId,
    bodyLine: anchor?.bodyLine,
    btNodeId: hint?.btNodeId ?? rt.behaviourTrees.currentNodeId ?? anchor?.btNodeId,
    stack,
    frameId,
    tickIndex: rt.world.clock.tickIndex,
  };
  recordDiagnostic(rt, diag);
  rt.logs.push({
    severity: "error",
    category: "runtime",
    message: err.message,
    frameId,
    tickIndex: rt.world.clock.tickIndex,
  });
  rt.emit({
    type: "diagnostic",
    code: diag.code,
    message: diag.message,
    assetGuid: diag.assetGuid,
    graphId: diag.graphId,
    nodeId: diag.nodeId,
    btNodeId: diag.btNodeId,
    bodyLine: diag.bodyLine,
    stack: diag.stack,
    frameId,
    severity: "error",
  });
  return diag;
}

/**
 * Every session diagnostic. With Pause On Errors, the first error from a source pauses the session
 * (at the end of the tick when one is running) and tells the editor what it paused on. A runaway
 * loop ends the session instead.
 */
export function recordDiagnostic(rt: RuntimeComposition, diagnostic: RuntimeDiagnostic): void {
  rt.diagnostics.push(diagnostic);
  if (!rt.pauseOnErrors || rt.stopped || diagnostic.severity !== "error" || diagnostic.code === INFINITE_LOOP_DIAGNOSTIC_CODE) return;
  const source = `${diagnostic.code}|${diagnostic.assetGuid ?? ""}|${diagnostic.nodeId ?? diagnostic.btNodeId ?? ""}`;
  if (rt.pausedErrorSources.has(source)) return;
  rt.pausedErrorSources.add(source);
  rt.pause();
  const { code, message, assetGuid, graphId, nodeId, btNodeId, bodyLine } = diagnostic;
  rt.emit({ type: "sessionPaused", paused: true, cause: { code, message, assetGuid, graphId, nodeId, btNodeId, bodyLine } });
}

/**
 * A node with a breakpoint ran: the session pauses (at the end of the tick when one is running) and
 * tells the editor where and on which object. Later hits in the same tick are not reported.
 */
export function breakpointHit(rt: RuntimeComposition, { assetGuid, graphId, nodeId, entryNodeId, instance, owner, event }: BreakpointHit): void {
  if (rt.stopped || rt.breakpointReported) return;
  rt.breakpointReported = true;
  rt.pause();
  rt.emit({ type: "sessionPaused", paused: true, cause: {
    code: BREAKPOINT_PAUSE_CODE,
    message: "Breakpoint",
    assetGuid,
    graphId,
    nodeId,
    ...(entryNodeId ? { entryNodeId } : {}),
    ...(instance ? { instanceId: instance.guid, instanceLabel: debugInstanceLabel(owner ?? instance) } : {}),
    ...(event ? { breakpointEvent: event } : {}),
  } });
}
