import type { PerformanceLongTaskSample } from "./performance-recorder";

/**
 * Main-thread long tasks (50 ms or more) from the browser's `PerformanceObserver`, on the
 * performance.now() clock the frames use. Null where the browser reports none (Safari).
 */
export function observeBrowserLongTasks(consume: (task: PerformanceLongTaskSample) => void): (() => void) | null {
  if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("longtask")) return null;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) consume({ startedAtMs: entry.startTime, durationMs: entry.duration });
  });
  observer.observe({ type: "longtask" });
  return () => observer.disconnect();
}
