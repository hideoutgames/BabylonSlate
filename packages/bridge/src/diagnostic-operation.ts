export type DiagnosticOperation = {
  kind: "profile" | "frame"; action: "start" | "stop"; recordingId: string;
  durationMs?: number; byteBudget?: number;
};
export type DiagnosticOperationRequest = { sessionGeneration: number; requestId: number; operation: DiagnosticOperation };
export type DiagnosticOperationResult = { sessionGeneration: number; requestId: number; recordingId: string; success: boolean; reason?: string };
export type PerformanceTickChunk = {
  sessionGeneration: number; recordingId: string; sequence: number;
  /** Interleaved PERFORMANCE_TICK_COLUMNS; transferred only during explicit recording. */
  rows: Float64Array; droppedRecords: number;
};
