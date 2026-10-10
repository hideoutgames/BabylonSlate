import { formatGlErrorTrace, glErrorTraceActive, glErrorTraceEntries } from "@babylonslate/render";
import { collectDiagnosticEnvironment, describeError, formatDiagnosticEnvironment, recentDiagnosticLog, type DiagnosticEnvironment } from "./diagnostic-info";

/** Report lines for the WebGL call trace, or how to turn it on. */
export function graphicsErrorTraceLines(): string[] {
  if (!glErrorTraceActive()) return ["Graphics error trace: off (Engine Settings → Debugger → Trace Graphics Errors)"];
  const count = glErrorTraceEntries().length;
  return count
    ? [`Graphics error trace (${count} failing WebGL call${count === 1 ? "" : "s"}, newest last):`, ...formatGlErrorTrace().map((line) => `  ${line}`)]
    : ["Graphics error trace: on, no failing WebGL calls recorded"];
}

export interface SceneLoadReportInput {
  surface: "Scene Viewport" | "Play" | "Scene Document";
  scene: string | null;
  phase: string;
  progress: number | null;
  failed: boolean;
  rendering?: boolean;
  elapsedMs: number | null;
  error?: unknown;
  gpu?: { api: string; vendor: string | null; renderer: string | null; version: string | null } | null;
  /** Further `Label: value` lines the surface knows, such as render settings or Play state. */
  details?: string[];
}

/**
 * Text a Debug Mode user copies from the Scene Loading dialog. Built
 * synchronously so the clipboard write stays inside the tap.
 */
export function formatSceneLoadReport(
  input: SceneLoadReportInput,
  environment: DiagnosticEnvironment = collectDiagnosticEnvironment(),
  log: string[] = recentDiagnosticLog(),
  graphicsTrace: string[] = graphicsErrorTraceLines(),
): string {
  const status = input.failed
    ? `FAILED (${input.rendering ? "Rendering Update Failed" : "Scene Loading Failed"})`
    : "still loading";
  const lines = [
    `BabylonSlate Scene Load Report · ${new Date().toISOString()}`,
    `Status: ${status} · ${input.surface}${input.scene ? ` · ${input.scene}` : ""}`,
    `Phase: ${input.phase}${input.progress === null ? "" : ` (${Math.round(input.progress)}%)`}${input.elapsedMs === null ? "" : ` · ${(input.elapsedMs / 1000).toFixed(1)} s since loading started`}`,
    ...formatDiagnosticEnvironment(environment),
    `GPU: ${input.gpu ? `${input.gpu.api} · ${input.gpu.vendor ?? "?"} · ${input.gpu.renderer ?? "?"}${input.gpu.version ? ` · ${input.gpu.version}` : ""}` : "unknown (no engine)"}`,
    ...(input.details ?? []),
  ];
  if (input.error !== undefined) lines.push("Error:", ...describeError(input.error).map((line) => `  ${line}`));
  lines.push(log.length ? `Recent console errors and warnings (${log.length}):` : "Recent console errors and warnings: none recorded since Debug Mode was enabled");
  lines.push(...log.map((line) => `  ${line}`));
  lines.push(...graphicsTrace);
  return lines.join("\n");
}
