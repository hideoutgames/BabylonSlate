import type { AnimationEventPayload } from "@haptic/assets";
import type { KeyRef } from "@haptic/editor-kit";

/** The Animation Timeline's rows: single events on one, each window on its own, keyed by its begin and its end. */
export const EVENTS_ROW = "events";
export const windowRowId = (eventId: string) => `window:${eventId}`;
export const BEGIN = ":begin";
export const END = ":end";

/** The event a timeline key stands for, and which end of a window it is. */
export function eventOfKey(ref: KeyRef): { id: string; end: "begin" | "end" | null } {
  if (ref.rowId === EVENTS_ROW) return { id: ref.keyId, end: null };
  if (ref.keyId.endsWith(END)) return { id: ref.keyId.slice(0, -END.length), end: "end" };
  return { id: ref.keyId.endsWith(BEGIN) ? ref.keyId.slice(0, -BEGIN.length) : ref.keyId, end: "begin" };
}

/**
 * The events moved by `deltaMs`: a single event or a whole window (both ends selected) shifts; a window's begin alone
 * moves while its end stays; its end alone changes its Duration. Times stay within the clip and windows keep a length.
 */
export function moveAnimationEvents(
  events: readonly AnimationEventPayload[],
  keys: readonly KeyRef[],
  deltaMs: number,
  lengthMs: number,
): AnimationEventPayload[] {
  const moved = new Map<string, { begin: boolean; end: boolean }>();
  for (const ref of keys) {
    const { id, end } = eventOfKey(ref);
    const entry = moved.get(id) ?? { begin: false, end: false };
    if (end === "end") entry.end = true;
    else entry.begin = true;
    moved.set(id, entry);
  }
  return events.map((event) => {
    const move = moved.get(event.id);
    if (!move) return event;
    const clamp = (ms: number) => Math.min(lengthMs, Math.max(0, Math.round(ms)));
    if (!(event.durationMs > 0)) return { ...event, timeMs: clamp(event.timeMs + deltaMs) };
    const endMs = event.timeMs + event.durationMs;
    if (move.begin && move.end) {
      const timeMs = Math.min(clamp(event.timeMs + deltaMs), Math.max(0, lengthMs - event.durationMs));
      return { ...event, timeMs };
    }
    if (move.begin) {
      const timeMs = Math.min(clamp(event.timeMs + deltaMs), endMs - 1);
      return { ...event, timeMs, durationMs: endMs - timeMs };
    }
    return { ...event, durationMs: Math.max(1, clamp(endMs + deltaMs) - event.timeMs) };
  });
}

