import type { TracePayload } from "@babylonslate/debugger";
import { TICK_BUDGET_MS } from "@babylonslate/debugger";

export const TRACE_LOG_WINDOW_FRAMES = 30;

export type TraceLogLine = {
  id: string;
  frameIndex: number;
  tickIndex: number;
  kind: "log" | "print";
  severity: string;
  category: string;
  key?: string;
  text: string;
};

export function asTracePayload(content: unknown): TracePayload | null {
  if (!content || typeof content !== "object") return null;
  const record = content as Record<string, unknown>;
  if (
    !Number.isFinite(record.seed) ||
    !Number.isFinite(record.dt) ||
    !Array.isArray(record.frames) ||
    !record.frames.every((frame: unknown) => {
      if (!frame || typeof frame !== "object") return false;
      const row = frame as Record<string, unknown>;
      return (
        Number.isInteger(row.tickIndex) &&
        Number.isFinite(row.scriptMs) &&
        Number.isFinite(row.physicsMs) &&
        Array.isArray(row.logs) &&
        row.logs.every(
          (log: unknown) =>
            !!log &&
            typeof log === "object" &&
            typeof (log as Record<string, unknown>).message === "string",
        ) &&
        Array.isArray(row.prints) &&
        row.prints.every(
          (log: unknown) =>
            !!log &&
            typeof log === "object" &&
            typeof (log as Record<string, unknown>).message === "string",
        ) &&
        (row.snapshotText === undefined || typeof row.snapshotText === "string")
      );
    })
  ) {
    return null;
  }
  return content as TracePayload;
}

export function collectTraceLogWindow(
  payload: TracePayload,
  frameIndex: number,
  windowFrames = TRACE_LOG_WINDOW_FRAMES,
): TraceLogLine[] {
  if (payload.frames.length === 0) return [];
  const end = Math.min(Math.max(0, frameIndex), payload.frames.length - 1);
  const start = Math.max(0, end - windowFrames + 1);
  const lines: TraceLogLine[] = [];
  for (let i = start; i <= end; i++) {
    const frame = payload.frames[i];
    if (!frame) continue;
    for (const [entryIndex, entry] of frame.logs.entries()) {
      lines.push({
        id: `${i}:log:${entryIndex}`,
        frameIndex: i,
        tickIndex: frame.tickIndex,
        kind: "log",
        severity: entry.severity ?? "log",
        category: entry.category ?? "",
        text: entry.message,
      });
    }
    for (const [entryIndex, entry] of frame.prints.entries()) {
      lines.push({
        id: `${i}:print:${entryIndex}`,
        frameIndex: i,
        tickIndex: frame.tickIndex,
        kind: "print",
        severity: "print",
        category: "Print",
        key: entry.key,
        text: entry.message,
      });
    }
  }
  return lines;
}

export function validTraceIndex(
  next: number,
  length: number,
  previous = 0,
): number {
  return Math.min(
    Math.max(0, length - 1),
    Math.max(0, Number.isInteger(next) ? next : previous),
  );
}

export function filterTraceLogs(
  lines: TraceLogLine[],
  query: string,
  severity: string,
): TraceLogLine[] {
  const q = query.trim().toLowerCase();
  return lines.filter(
    (line) =>
      (severity === "all" || line.severity === severity) &&
      `${line.tickIndex} ${line.kind} ${line.severity} ${line.category} ${line.key ?? ""} ${line.text}`
        .toLowerCase()
        .includes(q),
  );
}

export type TraceGraphBucket = {
  start: number;
  end: number;
  peak: number;
  scriptMs: number;
  physicsMs: number;
  overBudget: boolean;
  hasEvents: boolean;
};

export function traceGraphBuckets(
  payload: TracePayload,
  start: number,
  end: number,
  limit: number,
): TraceGraphBucket[] {
  const count = end - start + 1;
  if (count <= 0 || payload.frames.length === 0) return [];
  const size = Math.max(1, Math.ceil(count / Math.max(1, limit)));
  const buckets: TraceGraphBucket[] = [];
  for (let first = start; first <= end; first += size) {
    const last = Math.min(end, first + size - 1);
    let peak = first,
      hasEvents = false;
    for (let i = first; i <= last; i++) {
      const frame = payload.frames[i]!;
      if (frameTickMs(frame) > frameTickMs(payload.frames[peak]!)) peak = i;
      hasEvents ||=
        frame.logs.length > 0 ||
        frame.prints.length > 0 ||
        !!frame.inputEvents?.length;
    }
    const frame = payload.frames[peak]!;
    buckets.push({
      start: first,
      end: last,
      peak,
      scriptMs: Math.max(0, frame.scriptMs),
      physicsMs: Math.max(0, frame.physicsMs),
      overBudget: frameTickMs(frame) > TICK_BUDGET_MS,
      hasEvents,
    });
  }
  return buckets;
}

export function frameTickMs(frame: {
  scriptMs: number;
  physicsMs: number;
}): number {
  return frame.scriptMs + frame.physicsMs;
}
