export type DiagnosticSeverity = "error" | "warning" | "info";

export type Diagnostic = {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  assetGuid: string;
  graphId: string;
  nodeId?: string;
  pinId?: string;
  relatedNodeId?: string;
  bodyLine?: number;
  bodyColumn?: number;
};

export function diagnostic(
  partial: Omit<Diagnostic, "severity"> & { severity?: DiagnosticSeverity },
): Diagnostic {
  return {
    severity: partial.severity ?? "error",
    code: partial.code,
    message: partial.message,
    assetGuid: partial.assetGuid,
    graphId: partial.graphId,
    nodeId: partial.nodeId,
    pinId: partial.pinId,
    relatedNodeId: partial.relatedNodeId,
    bodyLine: partial.bodyLine,
    bodyColumn: partial.bodyColumn,
  };
}

export function hasBlockingErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}
