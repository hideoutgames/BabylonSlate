/** The row's full text when its host gives no `details`: severity and code, message, location. */
export function diagnosticRowDetails({
  severity,
  message,
  code,
  location,
}: {
  severity: "error" | "warning" | "info";
  message: string;
  code?: string;
  location?: string;
}): string {
  return [code ? `${severity}: ${code}` : severity, message, location]
    .filter(Boolean)
    .join("\n");
}

/** Diagnostic Details for a graph asset's own checks: severity and code, message, node. */
export function nodeDiagnosticDetails(diagnostic: {
  severity: string;
  code: string;
  message: string;
  nodeId?: string;
}): string {
  return `${diagnostic.severity}: ${diagnostic.code}\n${diagnostic.message}${diagnostic.nodeId ? `\nNode: ${diagnostic.nodeId}` : ""}`;
}
