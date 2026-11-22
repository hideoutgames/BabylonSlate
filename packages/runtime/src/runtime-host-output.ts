import type { CommandMessage } from "@haptic/bridge";
import type { RuntimeDiagnostic } from "./diagnostics";
import type { ScriptHostServices } from "./script-host";
import { mapStackToAnchor, type AnchorEntry } from "./stack-map";
import { DESTROYED_ACCESS_DIAGNOSTIC_CODE, destroyedAccessMessage } from "./destroyed-access";

interface OutputHostDeps {
  frameId(): number;
  tickIndex(): number;
  /** Compiled script anchors, read when an error log maps its stack. */
  anchors: ReadonlyMap<string, readonly AnchorEntry[]>;
  recordDiagnostic(diagnostic: RuntimeDiagnostic): void;
  /** This tick's Print String entries (the stats overlay reads them). */
  recordPrint(print: { message: string; key: string }): void;
  emit(command: CommandMessage): void;
  /** Play stopped: the World's end destroys every object, and touching one then is no script error. */
  stopped(): boolean;
}

/** Script output: logs (errors also become diagnostics), failed asserts, prints, debug draws and the cursor. */
export function createOutputHostBindings(deps: OutputHostDeps): Pick<ScriptHostServices,
  "log" | "assertFailed" | "print" | "drawDebug" | "setCursorVisible" | "reportDestroyedAccess"> {
  /** Destroyed accesses already reported this session, by asset, node and member. */
  const reportedDestroyedAccesses = new Set<string>();
  /**
   * An error line in the Output Log plus a diagnostic attributed to `location`, else to the script node on the
   * stack.
   */
  const reportError = (code: string, category: string, message: string,
    location?: Pick<AnchorEntry, "assetGuid" | "graphId" | "nodeId" | "bodyLine">) => {
    deps.emit({
      type: "log",
      severity: "error",
      category,
      message,
      frameId: deps.frameId(),
    });
    const stack = new Error().stack ?? "";
    const anchor: Pick<AnchorEntry, "assetGuid" | "graphId" | "nodeId" | "bodyLine"> | null = location ?? mapStackToAnchor(stack, deps.anchors);
    const diag: RuntimeDiagnostic = {
      code,
      message,
      severity: "error",
      assetGuid: anchor?.assetGuid,
      graphId: anchor?.graphId,
      nodeId: anchor?.nodeId,
      bodyLine: anchor?.bodyLine,
      stack,
      frameId: deps.frameId(),
      tickIndex: deps.tickIndex(),
    };
    deps.recordDiagnostic(diag);
    deps.emit({
      type: "diagnostic",
      code: diag.code,
      message: diag.message,
      assetGuid: diag.assetGuid,
      graphId: diag.graphId,
      nodeId: diag.nodeId,
      bodyLine: diag.bodyLine,
      stack: diag.stack,
      frameId: deps.frameId(),
      severity: "error",
    });
  };
  return {
    log: (severity, category, message) => {
      if (severity === "error") {
        reportError("runtime.log", category, message);
        return;
      }
      deps.emit({
        type: "log",
        severity,
        category,
        message,
        frameId: deps.frameId(),
      });
    },
    assertFailed: (message) => reportError("runtime.assert", "Assert", message),
    reportDestroyedAccess: (access) => {
      if (deps.stopped()) return;
      // Located where the compiled node says, else where the stack shows; a per-tick access reports once.
      const location: Pick<AnchorEntry, "assetGuid" | "graphId" | "nodeId" | "bodyLine"> | null =
        access.location ?? mapStackToAnchor(new Error().stack ?? "", deps.anchors);
      const key = `${location?.assetGuid ?? ""}|${location?.graphId ?? ""}|${location?.nodeId ?? ""}|` +
        `${location?.bodyLine ?? ""}|${access.kind}|${access.member}|${access.className}`;
      if (reportedDestroyedAccesses.has(key)) return;
      reportedDestroyedAccesses.add(key);
      reportError(DESTROYED_ACCESS_DIAGNOSTIC_CODE, "Script", destroyedAccessMessage(access), location ?? undefined);
    },
    print: (message, key, duration, color) => {
      deps.recordPrint({ message, key });
      deps.emit({
        type: "print",
        message,
        key,
        duration,
        // Copied at emit: a queued command must not see later edits to the script's color.
        color: structuredClone(color),
        frameId: deps.frameId(),
      });
    },
    drawDebug: (payload) => {
      deps.emit({
        type: "debugDraw",
        // Vectors can alias live Actor transforms that the same pump keeps moving in place.
        ...(structuredClone(payload) as Record<string, unknown>),
        frameId: deps.frameId(),
      } as CommandMessage);
    },
    setCursorVisible: (visible) => {
      deps.emit({
        type: "setCursorVisible",
        visible: visible === true,
        frameId: deps.frameId(),
      });
    },
  };
}
