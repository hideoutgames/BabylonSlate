/**
 * Animation Events: named moments on an Animation (a single event, or a window with a begin and an end) and on a
 * Sprite Animation's frames. An Animation Graph fires them as its players cross them; each name is its own event in
 * the graph's Animation Object, and an event may also act on its own (Play Sound, Spawn Particle System).
 */

/** What an event does on its own, with no script: a sound from the actor, or a particle system at a bone or the actor. */
export type AnimationEventAction =
  | { kind: "playSound"; assetGuid: string; volume: number }
  | { kind: "spawnParticles"; assetGuid: string; bone: string };

export type AnimationEventActionKind = AnimationEventAction["kind"];

/** A named moment on an Animation; a window when `durationMs` is above 0. */
export interface AnimationEventPayload {
  /** Stable within its Animation, for editing. */
  id: string;
  name: string;
  /** Where it fires (a window: where it begins), in ms from the start of one pass. */
  timeMs: number;
  /** A window's length in ms; 0 is a single event. */
  durationMs: number;
  /** The weight its Animation must play at for it to fire, 0 to 1. */
  triggerWeight: number;
  action: AnimationEventAction | null;
}

/** A named event on a Sprite Animation frame: it fires as the frame starts. */
export interface SpriteAnimationFrameEventPayload {
  id: string;
  name: string;
  triggerWeight: number;
  action: AnimationEventAction | null;
}

/** A fading-out Animation below half weight does not fire, so a crossfade does not double a footstep. */
export const DEFAULT_ANIMATION_EVENT_TRIGGER_WEIGHT = 0.5;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function normalizeAnimationEventAction(value: unknown): AnimationEventAction | null {
  const record = asRecord(value);
  if (record.kind === "playSound") {
    return { kind: "playSound", assetGuid: text(record.assetGuid), volume: Math.max(0, finite(record.volume, 1)) };
  }
  if (record.kind === "spawnParticles") {
    return { kind: "spawnParticles", assetGuid: text(record.assetGuid), bone: text(record.bone) };
  }
  return null;
}

/** An Animation's events, each with a unique id, sorted by time (then by name). */
export function normalizeAnimationEvents(value: unknown): AnimationEventPayload[] {
  if (!Array.isArray(value)) return [];
  const used = new Set<string>();
  const events = value.map((entry, index): AnimationEventPayload => {
    const record = asRecord(entry);
    let id = text(record.id) || `event-${index + 1}`;
    while (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    return {
      id,
      name: text(record.name),
      timeMs: Math.max(0, finite(record.timeMs, 0)),
      durationMs: Math.max(0, finite(record.durationMs, 0)),
      triggerWeight: clamp01(finite(record.triggerWeight, DEFAULT_ANIMATION_EVENT_TRIGGER_WEIGHT)),
      action: normalizeAnimationEventAction(record.action),
    };
  });
  return events.sort((a, b) => a.timeMs - b.timeMs || a.name.localeCompare(b.name));
}

/** A frame's events, each with a unique id, in authored order. */
export function normalizeSpriteAnimationFrameEvents(value: unknown): SpriteAnimationFrameEventPayload[] {
  if (!Array.isArray(value)) return [];
  const used = new Set<string>();
  return value.map((entry, index) => {
    const record = asRecord(entry);
    let id = text(record.id) || `event-${index + 1}`;
    while (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    return {
      id,
      name: text(record.name),
      triggerWeight: clamp01(finite(record.triggerWeight, DEFAULT_ANIMATION_EVENT_TRIGGER_WEIGHT)),
      action: normalizeAnimationEventAction(record.action),
    };
  });
}

/** The assets events act with (sounds and particle systems), which load with the Animation. */
export function animationEventActionGuids(events: ReadonlyArray<{ action: AnimationEventAction | null }>): string[] {
  const guids = new Set<string>();
  for (const event of events) if (event.action?.assetGuid) guids.add(event.action.assetGuid);
  return [...guids];
}

/** An id not used by `events`, for a new event. */
export function nextAnimationEventId(events: ReadonlyArray<{ id: string }>): string {
  const used = new Set(events.map((event) => event.id));
  let index = events.length + 1;
  while (used.has(`event-${index}`)) index += 1;
  return `event-${index}`;
}
