import { useEffect, useState } from "react";
import type { DebugConsoleLogEntry } from "../components/debug-console";

/** Lines a Debug Console host keeps; older lines can never be shown. */
export const DEBUG_CONSOLE_LOG_CAP = 500;

/** The newest `cap` entries of `previous` followed by `batch`, in arrival order. */
export function appendDebugConsoleLogs(
  previous: readonly DebugConsoleLogEntry[],
  batch: readonly DebugConsoleLogEntry[],
  cap = DEBUG_CONSOLE_LOG_CAP,
): DebugConsoleLogEntry[] {
  if (batch.length >= cap) return batch.slice(-cap);
  const keep = cap - batch.length;
  return (previous.length <= keep ? previous : previous.slice(-keep)).concat(batch);
}

/**
 * Runs `flush` once on the next animation frame however often `schedule` is
 * called before it. Frames do not run in a hidden tab, so a timer flushes
 * after `fallbackMs` there instead. `cancel` drops a pending flush only.
 */
export function createFrameFlush(flush: () => void, fallbackMs = 250) {
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
    frame = null;
    timer = null;
  };
  const run = () => {
    cancel();
    flush();
  };
  const schedule = () => {
    if (frame !== null || timer !== null) return;
    if (typeof requestAnimationFrame === "function") {
      frame = requestAnimationFrame(run);
    }
    timer = setTimeout(run, fallbackMs);
  };
  return { schedule, cancel };
}

/**
 * Debug Console lines for a Play or Preview Build host. Each line gets its
 * id and timestamp on arrival, so ordering against command entries is
 * unchanged, but a burst commits once per frame instead of once per line.
 * `pushLog` keeps its identity, so session callbacks may capture it once.
 */
export function useDebugConsoleLogs() {
  const [logs, setLogs] = useState<DebugConsoleLogEntry[]>([]);
  const [feed] = useState(() => {
    let sequence = 0;
    let pending: DebugConsoleLogEntry[] = [];
    let disposed = false;
    const frame = createFrameFlush(() => {
      const batch = pending;
      pending = [];
      if (!disposed && batch.length > 0) {
        setLogs((previous) => appendDebugConsoleLogs(previous, batch));
      }
    });
    return {
      push(severity: string, message: string) {
        // Hosts stop their sessions after this hook's cleanup; late lines
        // from that shutdown have nowhere to show.
        if (disposed) return;
        pending.push({ id: ++sequence, timestamp: Date.now(), severity, message });
        // A hidden tab flushes slowly; lines older than the cap never show.
        if (pending.length > DEBUG_CONSOLE_LOG_CAP * 2) {
          pending.splice(0, pending.length - DEBUG_CONSOLE_LOG_CAP);
        }
        frame.schedule();
      },
      attach() {
        disposed = false;
      },
      detach() {
        disposed = true;
        pending = [];
        frame.cancel();
      },
    };
  });
  useEffect(() => {
    feed.attach();
    return () => feed.detach();
  }, [feed]);
  return { logs, pushLog: feed.push };
}
