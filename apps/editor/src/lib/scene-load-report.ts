import { formatGlErrorTrace, glErrorTraceActive, glErrorTraceEntries } from "@haptic/render/gl-error-trace";
import type { RenderDiagnostics } from "@haptic/render";
import type { HostMemoryStats } from "@haptic/vfs";
import { collectDiagnosticEnvironment, describeError, formatDiagnosticEnvironment, recentDiagnosticLog, type DiagnosticEnvironment } from "./diagnostic-info";

/** Report lines for the WebGL call trace, or how to turn it on. */
export function graphicsErrorTraceLines(): string[] {
  if (!glErrorTraceActive()) return ["Graphics error trace: off (Engine Settings → Debugger → Trace Graphics Errors)"];
  const count = glErrorTraceEntries().length;
  return count
    ? [`Graphics error trace (${count} failing WebGL call${count === 1 ? "" : "s"}, newest last):`, ...formatGlErrorTrace().map((line) => `  ${line}`)]
    : ["Graphics error trace: on, no failing WebGL calls recorded"];
}

/** What the world's first frame waits on: its draw attempts and the load rehearsal of light changes. */
export function worldLoadLine(load: NonNullable<RenderDiagnostics["worldLoad"]>): string {
  const frame = load.presentation;
  const rehearsal = load.rehearsal;
  return `World load: first frame ${frame
    ? `ready ${frame.ready} · draws ${frame.draws} · rendered ${frame.rendered} · GPU pending ${frame.gpuPending} · copied ${frame.copied}`
    : "not requested"} · rehearsal ${rehearsal
    ? `${rehearsal.done ? "done" : "running"} ${rehearsal.steps}/${rehearsal.total} steps · timed out ${rehearsal.timedOut} · left out ${rehearsal.omitted} · ${Math.round(rehearsal.ms / 1000)} s`
    : "none"}`;
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1048576)} MB`;

/**
 * The host's real memory counters. On iOS and Android the web content runs in a separate system process that
 * the app cannot measure, so "app process" there is the native host only; the desktop app reports every process.
 */
export function hostMemoryLine(stats: HostMemoryStats, ageMs: number): string {
  const parts = [
    stats.rendererProcessBytes === undefined ? null : `renderer process ${megabytes(stats.rendererProcessBytes)}`,
    stats.gpuProcessBytes === undefined ? null : `GPU process ${megabytes(stats.gpuProcessBytes)}`,
    stats.mainProcessBytes === undefined ? null : `main process ${megabytes(stats.mainProcessBytes)}`,
    stats.allProcessesBytes === undefined ? null : `all app processes ${megabytes(stats.allProcessesBytes)}`,
    stats.jsHeapBytes === undefined ? null : `JS heap ${megabytes(stats.jsHeapBytes)}`,
    stats.appFootprintBytes === undefined ? null : `app process (not web content) ${megabytes(stats.appFootprintBytes)}`,
    stats.appAvailableBytes === undefined ? null : `app may still allocate ${megabytes(stats.appAvailableBytes)}`,
    stats.systemAvailableBytes === undefined ? null : `device available ${megabytes(stats.systemAvailableBytes)}`,
  ].filter((part) => part !== null);
  return `Memory: ${parts.join(" · ")} (sampled ${(ageMs / 1000).toFixed(1)} s ago)`;
}

/** Estimated GPU memory of the textures the Engine holds (render targets and shadow maps included). */
export function textureMemoryLine(memory: NonNullable<RenderDiagnostics["textureMemory"]>): string {
  return `GPU textures (estimate): ${memory.textures} textures, about ${megabytes(memory.bytes)}`;
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
    `Haptic Scene Load Report · ${new Date().toISOString()}`,
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
