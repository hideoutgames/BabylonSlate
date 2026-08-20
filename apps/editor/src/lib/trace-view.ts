import type { TracePayload } from "@babylonslate/debugger";

export const TRACE_LOG_WINDOW_FRAMES = 30;

export type TraceLogLine = {
  tickIndex: number;
  kind: "log" | "print";
  text: string;
};

export function asTracePayload(content: unknown): TracePayload | null {
  if (!content || typeof content !== "object") return null;
  const record = content as Record<string, unknown>;
  if (
    typeof record.seed !== "number" ||
    typeof record.dt !== "number" ||
    !Array.isArray(record.frames)
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
    for (const entry of frame.logs) {
      lines.push({
        tickIndex: frame.tickIndex,
        kind: "log",
        text: entry.message,
      });
    }
    for (const entry of frame.prints) {
      lines.push({
        tickIndex: frame.tickIndex,
        kind: "print",
        text: entry.message,
      });
    }
  }
  return lines;
}

export function frameTickMs(frame: {
  scriptMs: number;
  physicsMs: number;
}): number {
  return frame.scriptMs + frame.physicsMs;
}
