/**
 * Lightweight sub-phase timing milestones for Play launch (`performance.now()` deltas in ms from click).
 * Exposed only through `window.__hapticPlayTest.bootTimings()` in test/perf runs so every millisecond of Play boot
 * can be attributed without perturbing production behavior.
 */
export interface PlayReadinessSpan {
  owner: string;
  stage: "modelsReady" | "texturesReady" | "prewarm" | "presentFirstFrame";
  startMs: number;
  durationMs: number;
}

export interface PlayBootTimings {
  sourcesAcquiredMs: number | null;
  contentPreparedMs: number | null;
  sessionStartMs: number | null;
  workerPostedMs: number | null;
  engineCreatedMs: number | null;
  firstCommandMs: number | null;
  sceneLoadingStartMs: number | null;
  sceneLoadingEndMs: number | null;
  firstSnapshotMs: number | null;
  worldReadyMs: number | null;
  lastLayerReadyMs: number | null;
  readinessSpans: PlayReadinessSpan[];
}

export type PlayBootPhase =
  | "sourcesAcquiredMs"
  | "contentPreparedMs"
  | "sessionStartMs"
  | "workerPostedMs"
  | "engineCreatedMs"
  | "firstCommandMs"
  | "sceneLoadingStartMs"
  | "sceneLoadingEndMs"
  | "firstSnapshotMs"
  | "worldReadyMs"
  | "lastLayerReadyMs";

let startAt = 0;
let current: PlayBootTimings | null = null;

/** Begins a new Play launch timing window anchored at `performance.now()`. */
export function beginPlayBootTimings(): void {
  startAt = performance.now();
  current = {
    sourcesAcquiredMs: null,
    contentPreparedMs: null,
    sessionStartMs: null,
    workerPostedMs: null,
    engineCreatedMs: null,
    firstCommandMs: null,
    sceneLoadingStartMs: null,
    sceneLoadingEndMs: null,
    firstSnapshotMs: null,
    worldReadyMs: null,
    lastLayerReadyMs: null,
    readinessSpans: [],
  };
}

/** Records the first occurrence of `phase` relative to `beginPlayBootTimings()`. */
export function markPlayBootPhase(phase: PlayBootPhase, overwrite = false): void {
  if (!current) return;
  if (!overwrite && current[phase] !== null) return;
  current[phase] = Math.round((performance.now() - startAt) * 10) / 10;
}

/** Measures an async readiness stage and records its start offset and duration on the active boot timings. */
export async function measurePlayReadinessSpan<T>(
  owner: string,
  stage: PlayReadinessSpan["stage"],
  work: () => Promise<T>,
): Promise<T> {
  const target = current;
  if (!target) return work();
  const started = performance.now();
  try {
    return await work();
  } finally {
    const end = performance.now();
    target.readinessSpans.push({
      owner,
      stage,
      startMs: Math.round((started - startAt) * 10) / 10,
      durationMs: Math.round((end - started) * 10) / 10,
    });
  }
}

/** Returns a shallow copy of the active Play launch's timing breakdown, or null if not started. */
export function snapshotPlayBootTimings(): PlayBootTimings | null {
  return current ? { ...current, readinessSpans: [...current.readinessSpans] } : null;
}

export interface EditorViewportLoadTimings {
  blocking: boolean;
  remount: boolean;
  cacheHit: boolean;
  waitCanvasMs: number;
  collectMs: number;
  realizeMs: number;
  modelsReadyMs: number;
  texturesReadyMs: number;
  warmShadersMs: number;
  presentFirstFrameMs: number;
  totalMs: number;
}

export function recordEditorViewportLoadTimings(timings: EditorViewportLoadTimings): void {
  const host = globalThis as unknown as { __hapticEditorLoadTimings?: EditorViewportLoadTimings };
  host.__hapticEditorLoadTimings = timings;
}
