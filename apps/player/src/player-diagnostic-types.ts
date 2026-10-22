import type { DiagnosticOperationRequest, DiagnosticOperationResult } from "@haptic/bridge";
import type { PerformanceIdentity } from "@haptic/debugger";
import type { EngineHandle, RenderFrameReport } from "@haptic/render";

/** These ports exist only in an editor-hosted, debugger-enabled Preview. */
export type PlayerPreviewDiagnosticPorts = {
  sessionGeneration: number;
  identity: () => PerformanceIdentity;
  observeFrames: EngineHandle["observePerformance"];
  observeGpuTiming: EngineHandle["observeGpuTiming"];
  setEditorInputSuppressed: (suppressed: boolean) => Promise<void>;
  captureFrame: (signal: AbortSignal) => Promise<RenderFrameReport>;
  send: (request: DiagnosticOperationRequest) => Promise<DiagnosticOperationResult | undefined>;
  subscribe: (receive: (command: { type: string } & Record<string, unknown>) => void) => () => void;
  own: (dispose: () => void) => () => void;
};
