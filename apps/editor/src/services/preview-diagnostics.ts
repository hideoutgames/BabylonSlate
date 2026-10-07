import { createPreviewDiagnosticClient } from "@babylonslate/exporter";
import { parsePerformanceProfile, type PerformanceProfile } from "@babylonslate/debugger";
import type { RenderFrameReport } from "@babylonslate/render";

/** One owner per iframe. Destroy it when the iframe/source is replaced; the
 * transport additionally verifies its player session and request identities. */
export function createPreviewDiagnostics(options: {
  source: () => Window | null | undefined;
  origin: string;
  onProfile: (profile: PerformanceProfile) => void;
  onError: (reason: string) => void;
}) {
  let retained: PerformanceProfile | null = null;
  const client = createPreviewDiagnosticClient({ source: options.source, origin: () => options.origin,
    send: (message, transfer) => {
      const source = options.source();
      if (!source) throw new Error("Preview player is unavailable.");
      source.postMessage(message, options.origin, transfer ?? []);
    } }, {
    onProfile: (transfer) => {
      const frames = transfer.metadata.frames as Record<string, unknown> | undefined;
      const ticks = transfer.metadata.ticks as Record<string, unknown> | undefined;
      const profile = parsePerformanceProfile({ ...transfer.metadata,
        frames: { ...frames, chunks: transfer.frames }, ticks: { ...ticks, chunks: transfer.ticks } });
      if (!profile) { options.onError("Preview returned an invalid or incomplete performance profile."); return; }
      retained = profile;
      options.onProfile(profile);
    },
    onError: options.onError,
  });
  const receive = (event: MessageEvent) => client.receive(event);
  window.addEventListener("message", receive);
  return {
    get lastProfile(): PerformanceProfile | null { return retained; },
    startProfile: (settings: { durationMs?: number; byteBudget?: number } = {}) => client.request("profile-start", settings),
    stopProfile: () => client.request("profile-stop"),
    async captureFrame(): Promise<RenderFrameReport> {
      const reply = await client.request("frame");
      if (!reply.success) throw new Error(reply.reason ?? "Preview frame capture failed.");
      const report = reply.result as RenderFrameReport | undefined;
      if (report?.version !== 1 || !report.frame || !Array.isArray(report.stages) ||
        !Array.isArray(report.tasks) || !Array.isArray(report.resources) || !Array.isArray(report.graphs) ||
        report.stages.length > 256 || report.tasks.length > 256 || report.resources.length > 256 || report.graphs.length > 16 ||
        !Number.isSafeInteger(report.frame.renderFrameId) || !Number.isFinite(report.frame.width) || !Number.isFinite(report.frame.height) ||
        !report.stages.every((stage) => typeof stage.name === "string" && stage.name.length <= 160 && Number.isSafeInteger(stage.id)))
        throw new Error("Preview returned an invalid frame report.");
      return report;
    },
    dispose(): void { window.removeEventListener("message", receive); client.dispose(); },
  };
}
