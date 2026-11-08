import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DebugConsoleLogEntry } from "../components/debug-console";

/** Lines a Debug Console host keeps; older lines can never be shown. */
const DEBUG_CONSOLE_LOG_CAP = 500;

/** The newest `cap` entries of `previous` followed by `batch`, in arrival order. */
function appendDebugConsoleLogs(
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
 * A Debug Console host's lines, outside React state. A flush re-renders only
 * the components that read them with `useShownDebugConsoleLogs`, and only
 * while their console is open. `push` keeps its identity, so session
 * callbacks may capture it once; `getSnapshot` is the same array until a
 * frame adds lines.
 */
export type DebugConsoleLogFeed = {
  push: (severity: string, message: string) => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => readonly DebugConsoleLogEntry[];
};

const NO_LOGS: readonly DebugConsoleLogEntry[] = [];

/**
 * Debug Console lines for a Play or Preview Build host. Each line gets its
 * id and timestamp on arrival, so ordering against command entries is
 * unchanged, but a burst reaches subscribers once per frame instead of once
 * per line. The feed keeps its identity while the host is mounted; read it
 * with `useShownDebugConsoleLogs`, or call `getSnapshot` when a handler runs.
 */
export function useDebugConsoleLogs(): DebugConsoleLogFeed {
  const [feed] = useState(() => {
    let sequence = 0;
    let logs: readonly DebugConsoleLogEntry[] = NO_LOGS;
    let pending: DebugConsoleLogEntry[] = [];
    let disposed = false;
    const listeners = new Set<() => void>();
    const frame = createFrameFlush(() => {
      const batch = pending;
      pending = [];
      if (disposed || batch.length === 0) return;
      logs = appendDebugConsoleLogs(logs, batch);
      for (const listener of [...listeners]) listener();
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
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      getSnapshot: () => logs,
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
  return feed;
}

/**
 * The feed's lines for a Debug Console that is `open`. While it is open,
 * each flush re-renders the component that calls this. While it is closed
 * the caller keeps the lines it last showed, so a flush neither re-renders
 * the caller nor rebuilds the console's transcript; opening it reads the
 * newest lines.
 */
export function useShownDebugConsoleLogs(
  feed: DebugConsoleLogFeed,
  open: boolean,
): readonly DebugConsoleLogEntry[] {
  const shown = useRef(NO_LOGS);
  const getShown = useCallback(() => {
    if (open) shown.current = feed.getSnapshot();
    return shown.current;
  }, [feed, open]);
  return useSyncExternalStore(feed.subscribe, getShown);
}
