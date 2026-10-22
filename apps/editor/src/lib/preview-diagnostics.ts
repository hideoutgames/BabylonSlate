import type { SessionReportEntry } from "@haptic/runtime";
import { INFINITE_LOOP_DIAGNOSTIC_CODE } from "@haptic/debugger";
import type { PreviewDiagnosticsMessage } from "@haptic/exporter";

export function sessionEntriesFromPreviewDiagnostics(
  diagnostics: PreviewDiagnosticsMessage["diagnostics"],
): SessionReportEntry[] {
  return diagnostics.map((entry) => ({
    severity: entry.severity === "warning" ? "warning" : "error",
    code: entry.code?.trim() ? entry.code : "preview",
    message: entry.message,
    assetGuid: entry.assetGuid,
    graphId: entry.graphId,
    nodeId: entry.nodeId,
    btNodeId: entry.btNodeId,
    bodyLine: entry.bodyLine,
    frameId: 0,
    count: 1,
    firstFrameId: 0,
    lastFrameId: 0,
  }));
}

export function shouldClosePreviewOnDiagnostics(
  entries: ReadonlyArray<{ code?: string }>,
): boolean {
  return entries.some((entry) => entry.code === INFINITE_LOOP_DIAGNOSTIC_CODE);
}
