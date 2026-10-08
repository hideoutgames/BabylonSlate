import type { TraceInputEvent, TracePayload } from "@babylonslate/debugger";
import type { RawInputEvent } from "@babylonslate/input";

export function rawInputFromTraceEvents(
  events: readonly TraceInputEvent[] | undefined,
): RawInputEvent[] {
  if (!events) return [];
  const out: RawInputEvent[] = [];
  for (const event of events) {
    if (event.type === "key" && event.code) {
      out.push({
        kind: "key",
        tick: event.tick,
        code: event.code,
        phase: event.down ? "down" : "up",
      });
    }
  }
  return out;
}

/** Feed each frame's input and time dilation, then tick, so every replayed tick takes the recorded step. */
export function replayTracePayload(
  runtime: {
    pushInput: (events: readonly RawInputEvent[]) => void;
    setTimeDilation: (rate: number) => void;
    tick: () => void;
  },
  payload: TracePayload,
): void {
  for (const frame of payload.frames) {
    runtime.pushInput(rawInputFromTraceEvents(frame.inputEvents));
    runtime.setTimeDilation(frame.timeDilation ?? 1);
    runtime.tick();
  }
}
