import { useSyncExternalStore } from "react";

/**
 * The Timeline playhead of one Scene or Scene Layer tab, in seconds. A store
 * rather than React state, so playback and scrubbing re-render only the
 * windows that read it.
 */
export class TimelinePlayhead {
  private time = 0;
  private readonly listeners = new Set<() => void>();

  get = (): number => this.time;

  set(time: number): void {
    if (!Number.isFinite(time) || time === this.time) return;
    this.time = time;
    for (const listener of [...this.listeners]) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export function useTimelinePlayheadTime(playhead: TimelinePlayhead): number {
  return useSyncExternalStore(playhead.subscribe, playhead.get, playhead.get);
}
