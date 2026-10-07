import type { DiagnosticOperationRequest, DiagnosticOperationResult } from "@babylonslate/bridge";
import type { PerformanceIdentity } from "@babylonslate/debugger";
import type { EngineHandle, RenderFrameReport } from "@babylonslate/render";

/** These ports exist only in an editor-hosted, debugger-enabled Preview. */
export type PlayerPreviewDiagnosticPorts = {
  sessionGeneration: number;
  identity: () => PerformanceIdentity;
  observeFrames: EngineHandle["observePerformance"];
  captureFrame: (signal: AbortSignal) => Promise<RenderFrameReport>;
  send: (request: DiagnosticOperationRequest) => Promise<DiagnosticOperationResult | undefined>;
  subscribe: (receive: (command: { type: string } & Record<string, unknown>) => void) => () => void;
  own: (dispose: () => void) => () => void;
};
