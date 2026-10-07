import { createPreviewDiagnosticClient, type PreviewDiagnosticResult } from "@babylonslate/exporter";
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
  let profileActive = false;
  let starting: Promise<PreviewDiagnosticResult> | null = null;
  let closing: Promise<void> | null = null;
  let disposed = false;
  let inputSuppressed = false;
  let inputTransition: Promise<PreviewDiagnosticResult> = Promise.resolve({ success: true });
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
      profileActive = false;
      options.onProfile(profile);
    },
    onError: options.onError,
  });
  const receive = (event: MessageEvent) => client.receive(event);
  window.addEventListener("message", receive);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("message", receive);
    client.dispose();
  };
  return {
    get lastProfile(): PerformanceProfile | null { return retained; },
    setInputSuppressed(suppressed: boolean): Promise<PreviewDiagnosticResult> {
      if (disposed || closing) return Promise.resolve({ success: false, reason: "Preview diagnostics are closing." });
      if (inputSuppressed === suppressed) return inputTransition;
      inputSuppressed = suppressed;
      inputTransition = inputTransition.then(() => client.request("input", { inputSuppressed: suppressed }));
      return inputTransition;
    },
    startProfile(settings: { durationMs?: number; byteBudget?: number } = {}): Promise<PreviewDiagnosticResult> {
      if (closing || disposed || starting || profileActive) return Promise.resolve({ success: false, reason: "Preview diagnostics are unavailable or already recording." });
      profileActive = true;
      starting = client.request("profile-start", settings).then((result) => {
        if (!result.success) profileActive = false;
        return result;
      }).finally(() => { starting = null; });
      return starting;
    },
    async stopProfile(): Promise<PreviewDiagnosticResult> {
      await starting;
      if (!profileActive) return { success: true };
      const reply = await client.request("profile-stop");
      if (reply.success) profileActive = false;
      return reply;
    },
    async captureFrame(): Promise<RenderFrameReport> {
      if (closing || disposed) throw new Error("Preview diagnostics are closing.");
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
    /** Drain an explicitly started profile before its iframe is detached. An
     * untouched Preview never performs the diagnostic handshake on Stop. */
    finish(): Promise<void> {
      if (closing) return closing;
      closing = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            (async () => {
              await starting;
              if (profileActive) {
                const reply = await client.request("profile-stop");
                if (!reply.success) throw new Error(reply.reason ?? "Preview recording could not be finalized.");
              }
            })(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Preview recording did not finish before Stop; its incomplete result was discarded.")), 3000);
            }),
          ]);
        } finally { clearTimeout(timer); dispose(); }
      })();
      return closing;
    },
    dispose,
  };
}
