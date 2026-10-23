import { SessionDiagnostics, createDiagnosticOperationClient, observeBrowserLongTasks } from "@haptic/debugger";
import { createPreviewDiagnosticServer, type PreviewDiagnosticEndpoint, type PreviewDiagnosticResult } from "@haptic/exporter";
import type { DiagnosticOperationResult, PerformanceTickChunk } from "@haptic/bridge";
import type { RenderFrameReport } from "@haptic/render";
import type { PlayerPreviewDiagnosticPorts } from "./player-diagnostic-types";

/** Separate Preview-only entry. No renderer/runtime substitute: all samples
 * arrive through the packaged player's existing owners. */
export function installPreviewDiagnostics(ports: PlayerPreviewDiagnosticPorts, endpoint: PreviewDiagnosticEndpoint) {
  /** The latest recording's profile transfer; Stop reports its outcome. */
  let transfer: Promise<PreviewDiagnosticResult> = Promise.resolve({ success: true });
  let closed = false;
  const client = createDiagnosticOperationClient({ sessionGeneration: ports.sessionGeneration,
    send: async (request) => { const reply = await ports.send(request); if (reply) client.receive(reply); } });
  const session = new SessionDiagnostics<RenderFrameReport>({ mode: "preview", identity: ports.identity,
    observeFrames: ports.observeFrames, observeGpuTiming: ports.observeGpuTiming, captureFrame: ports.captureFrame,
    sampleMemory: ports.sampleMemory, observeLongTasks: observeBrowserLongTasks,
    runtimeOperation: (request) => client.request(request),
    onProfile: (profile) => {
      const { frames, ticks, gpu, memory, longTasks, ...metadata } = profile;
      const streams = { frames, ticks, gpu, memory, longTasks };
      transfer = server.publishProfile({
        metadata: { ...metadata, ...Object.fromEntries(Object.entries(streams).map(([name, stream]) => [name, { columns: stream.columns, count: stream.count }])) },
        frames: frames.chunks, ticks: ticks.chunks, gpu: gpu.chunks, memory: memory.chunks, longTasks: longTasks.chunks,
      }).finally(() => session.forgetProfile(profile));
    },
  });
  const server = createPreviewDiagnosticServer(endpoint, {
    execute: async (operation, settings) => {
      if (closed) return { success: false, reason: "Preview diagnostics stopped." };
      if (operation === "profile-start") {
        transfer = Promise.resolve({ success: true });
        return session.startProfile(settings);
      }
      if (operation === "profile-stop") { await session.stopProfile(); return transfer; }
      if (operation === "input") { await ports.setEditorInputSuppressed(settings.inputSuppressed === true); return { success: true }; }
      return { success: true, result: await session.captureFrame() };
    },
    close: async () => {
      await session.cancel();
      if (!closed) await ports.setEditorInputSuppressed(false).catch(error => console.warn("Preview input ownership could not be restored.", error));
    },
  });
  const unsubscribe = ports.subscribe((command) => {
    if (command.sessionGeneration !== ports.sessionGeneration) return;
    if (command.type === "diagnosticOperationResult") client.receive(command as DiagnosticOperationResult & { type: string });
    else if (command.type === "performanceTicks") session.receiveTicks(command as PerformanceTickChunk & { type: string });
    else if (command.type === "diagnosticOperationStopped") session.runtimeStopped(command as unknown as Parameters<typeof session.runtimeStopped>[0]);
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    await session.dispose();
    await transfer;
    unsubscribe(); client.dispose(); server.dispose();
  };
  ports.own(() => { void close(); });
  return { receive: server.receive, close };
}
