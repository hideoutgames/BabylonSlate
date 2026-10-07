import type { CommandMessage } from "@babylonslate/bridge";
import type { RuntimeDiagnostic } from "./diagnostics";
import type { ScriptHostServices } from "./script-host";
import { mapStackToAnchor, type AnchorEntry } from "./stack-map";

interface OutputHostDeps {
  frameId(): number;
  tickIndex(): number;
  /** Compiled script anchors, read when an error log maps its stack. */
  anchors: ReadonlyMap<string, readonly AnchorEntry[]>;
  recordDiagnostic(diagnostic: RuntimeDiagnostic): void;
  /** This tick's Print String entries (the stats overlay reads them). */
  recordPrint(print: { message: string; key: string }): void;
  emit(command: CommandMessage): void;
}

/** Script output: logs (errors also become diagnostics), prints, debug draws and the cursor. */
export function createOutputHostBindings(deps: OutputHostDeps): Pick<ScriptHostServices,
  "log" | "print" | "drawDebug" | "setCursorVisible"> {
  return {
    log: (severity, category, message) => {
      deps.emit({
        type: "log",
        severity,
        category,
        message,
        frameId: deps.frameId(),
      });
      if (severity === "error") {
        const stack = new Error().stack ?? "";
        const anchor = mapStackToAnchor(stack, deps.anchors);
        const diag: RuntimeDiagnostic = {
          code: "runtime.log",
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
      }
    },
    print: (message, key, duration, color) => {
      deps.recordPrint({ message, key });
      deps.emit({
        type: "print",
        message,
        key,
        duration,
        color,
        frameId: deps.frameId(),
      });
    },
    drawDebug: (payload) => {
      deps.emit({
        type: "debugDraw",
        ...(payload as Record<string, unknown>),
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
