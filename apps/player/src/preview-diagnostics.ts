import { SessionDiagnostics, createDiagnosticOperationClient } from "@babylonslate/debugger";
import { createPreviewDiagnosticServer, type PreviewDiagnosticEndpoint } from "@babylonslate/exporter";
import type { DiagnosticOperationResult, PerformanceTickChunk } from "@babylonslate/bridge";
import type { RenderFrameReport } from "@babylonslate/render";
import type { PlayerPreviewDiagnosticPorts } from "./player-diagnostic-types";

/** Separate Preview-only entry. No renderer/runtime substitute: all samples
 * arrive through the packaged player's existing owners. */
export function installPreviewDiagnostics(ports: PlayerPreviewDiagnosticPorts, endpoint: PreviewDiagnosticEndpoint) {
  let transfer = Promise.resolve();
  let closed = false;
  const client = createDiagnosticOperationClient({ sessionGeneration: ports.sessionGeneration,
    send: async (request) => { const reply = await ports.send(request); if (reply) client.receive(reply); } });
  const session = new SessionDiagnostics<RenderFrameReport>({ mode: "preview", identity: ports.identity,
    observeFrames: ports.observeFrames, captureFrame: ports.captureFrame,
    runtimeOperation: (request) => client.request(request),
    onProfile: (profile) => {
      const { frames, ticks, ...metadata } = profile;
      transfer = server.publishProfile({ metadata: { ...metadata,
        frames: { columns: frames.columns, count: frames.count }, ticks: { columns: ticks.columns, count: ticks.count } },
        frames: frames.chunks, ticks: ticks.chunks }).finally(() => session.forgetProfile(profile));
    },
  });
  const server = createPreviewDiagnosticServer(endpoint, {
    execute: async (operation, settings) => {
      if (closed) return { success: false, reason: "Preview diagnostics stopped." };
      if (operation === "profile-start") return session.startProfile(settings);
      if (operation === "profile-stop") { await session.stopProfile(); await transfer; return { success: true }; }
      return { success: true, result: await session.captureFrame() };
    },
    close: () => session.cancel(),
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
