import { useCallback, useEffect, useRef, useState } from "react";
import { animClipEventSpan, animSweepCrossings, type AnimFiredEvent } from "@haptic/anim-graph";
import type { AnimationEventPayload } from "@haptic/assets";
import type { AnimationPreviewClock } from "./animation-preview-clock";

/** How long a fired event's name stays up. */
const FLASH_MS = 1200;
/** The longest step the Animation Preview's clock takes in one frame (`AnimationPreviewClock.advance`). */
const PREVIEW_FRAME_MS = 100;
/** At most this many names show at once; the oldest goes first. */
const MAX_FLASHES = 4;

export interface AnimEventFlash {
  id: number;
  label: string;
}

/** How a fired event reads: its name, with Begin or End for a window. */
export function animEventFlashLabel(event: Pick<AnimFiredEvent, "name" | "phase">): string {
  return event.phase === "begin" ? `${event.name} Begin` : event.phase === "end" ? `${event.name} End` : event.name;
}

/** Recent event names, each kept for a moment after it fires. */
export function useAnimEventFlashes(): { flashes: readonly AnimEventFlash[]; flash: (labels: readonly string[]) => void } {
  const [flashes, setFlashes] = useState<readonly AnimEventFlash[]>([]);
  const next = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);
  const flash = useCallback((labels: readonly string[]) => {
    if (labels.length === 0) return;
    const added = labels.map((label) => ({ id: next.current++, label }));
    setFlashes((current) => [...current, ...added].slice(-MAX_FLASHES));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      const ids = new Set(added.map((entry) => entry.id));
      setFlashes((current) => current.filter((entry) => !ids.has(entry.id)));
    }, FLASH_MS);
    timers.current.add(timer);
  }, []);
  return { flashes, flash };
}

/** Flashes the events an evaluation fired: subscribe to a Preview session and read its latest state's events. */
export function useFiredEventFlashes(
  subscribe: (listener: () => void) => () => void,
  firedEvents: () => readonly AnimFiredEvent[] | undefined,
) {
  const { flashes, flash } = useAnimEventFlashes();
  const last = useRef<readonly AnimFiredEvent[] | undefined>(undefined);
  useEffect(
    () =>
      subscribe(() => {
        const events = firedEvents();
        // Each evaluation publishes a new list; a repeat of the same list is the same tick.
        if (!events || events === last.current) return;
        last.current = events;
        flash(events.map(animEventFlashLabel));
      }),
    [firedEvents, flash, subscribe],
  );
  return flashes;
}

/**
 * Flashes an Animation's events as its Preview plays past them (the wrap included), as a graph playing it would fire
 * them. Scrubbing and seeking flash nothing.
 */
export function useClockEventFlashes(clock: AnimationPreviewClock, events: readonly AnimationEventPayload[], durationMs: number) {
  const { flashes, flash } = useAnimEventFlashes();
  const previous = useRef<number | null>(null);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  useEffect(() => {
    previous.current = clock.get();
    return clock.subscribe(() => {
      const now = clock.get();
      const before = previous.current;
      previous.current = now;
      const playback = clock.getPlayback();
      if (before === null || !playback.playing || now === before) return;
      const length = Math.max(1, durationMs);
      // A clock that came back round within one frame crossed the end of the pass; a bigger jump back is Restart.
      const wrapped = now < before;
      if (wrapped && length - before + now > PREVIEW_FRAME_MS * Math.max(1, playback.speed)) return;
      const sweep = { from: before / length, to: (wrapped ? length : 0) / length + now / length, inclusive: false, loop: true };
      const labels: string[] = [];
      for (const event of eventsRef.current) {
        if (!event.name) continue;
        const span = animClipEventSpan(event, length);
        if (animSweepCrossings(sweep, span.begin).length > 0) labels.push(span.end === null ? event.name : `${event.name} Begin`);
        if (span.end !== null && animSweepCrossings(sweep, span.end).length > 0) labels.push(`${event.name} End`);
      }
      flash(labels);
    });
  }, [clock, durationMs, flash]);
  return flashes;
}
