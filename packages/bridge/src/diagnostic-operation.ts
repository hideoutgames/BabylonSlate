export type DiagnosticOperation = {
  kind: "profile" | "frame"; action: "start" | "stop"; recordingId: string;
  durationMs?: number; byteBudget?: number;
};
export type DiagnosticOperationRequest = { sessionGeneration: number; requestId: number; operation: DiagnosticOperation };
export type DiagnosticOperationResult = { sessionGeneration: number; requestId: number; recordingId: string; success: boolean; reason?: string };
/** A script entry point a profile timed: the Class, the event or function, and where its entry node is. */
export type PerformanceScriptEntry = {
  assetGuid: string; classId: string; className?: string;
  /** The compiled export the runtime called. */
  exportName: string; event?: string; title?: string;
  graphId?: string; nodeId?: string;
};
export type PerformanceTickChunk = {
  sessionGeneration: number; recordingId: string; sequence: number;
  /** Interleaved PERFORMANCE_TICK_COLUMNS; transferred only during explicit recording. */
  rows: Float64Array; droppedRecords: number;
  /**
   * Interleaved PERFORMANCE_SCRIPT_COLUMNS for these ticks: one row per entry point that ran in a tick.
   * `scriptEntries` are the entries first used since the previous chunk; a row's entry is its index
   * in every chunk's entries so far, in order.
   */
  scripts?: Float64Array; scriptEntries?: PerformanceScriptEntry[];
};
