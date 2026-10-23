import { useCallback, useRef, useSyncExternalStore } from "react";
import type { GraphDebugStore } from "../services/graph-debug-store";
import { classIdForGraphPath } from "../services/script-compiler";
import type { WatchEntry } from "../services/watch-store";

/** What a watch shows: the value text, or why there is none. */
export type WatchReading =
  | { kind: "value"; text: string }
  /** No Simulation, or stopped Play, is debugging the watch's Class. */
  | { kind: "notDebugged" }
  /** Debug Instance follows no object. */
  | { kind: "noObject" }
  /** The followed object has not run the node, or has no such variable. */
  | { kind: "noValue" };

const READING_TEXT: Record<Exclude<WatchReading["kind"], "value">, string> = {
  notDebugged: "Not Debugged",
  noObject: "No Object",
  noValue: "No Value Yet",
};

/** The text a watch's row shows. */
export function watchReadingText(reading: WatchReading): string {
  return reading.kind === "value" ? reading.text : READING_TEXT[reading.kind];
}

/** What `entry` shows from the graph debugger's followed object. */
export function readWatch(entry: WatchEntry, debug: GraphDebugStore): WatchReading {
  const { target, selectedId } = debug.getSnapshot();
  if (target?.kind !== "class" || target.classId !== classIdForGraphPath(entry.assetGuid)) return { kind: "notDebugged" };
  if (selectedId === null) return { kind: "noObject" };
  const text = entry.kind === "pin"
    ? debug.value(entry.assetGuid, entry.graphId, entry.nodeId, entry.pinId, entry.direction)
    : debug.variable(entry.name);
  return text === undefined ? { kind: "noValue" } : { kind: "value", text };
}

/**
 * Each watch's reading, read again when the followed object reports values (at most once a tick) or the
 * debugger's target or object changes. Renders only when a reading changed.
 */
export function useWatchReadings(entries: readonly WatchEntry[], debug: GraphDebugStore | null): readonly WatchReading[] {
  const cache = useRef<{ key: string; readings: readonly WatchReading[] } | null>(null);
  const subscribe = useCallback((listener: () => void) => {
    if (!debug) return () => {};
    const unsubscribeSnapshot = debug.subscribe(listener);
    const unsubscribeValues = debug.subscribeValues(listener);
    return () => {
      unsubscribeSnapshot();
      unsubscribeValues();
    };
  }, [debug]);
  const getSnapshot = useCallback(() => {
    const readings = entries.map((entry): WatchReading => debug ? readWatch(entry, debug) : { kind: "notDebugged" });
    const key = JSON.stringify(readings);
    if (cache.current?.key !== key) cache.current = { key, readings };
    return cache.current.readings;
  }, [debug, entries]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
