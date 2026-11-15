/**
 * Animation Events as an Animation Graph fires them. Each player carries its clip's events (copied onto the node at
 * load by `resolveAnimGraphClips`); a tick fires the ones its players cross, by the rule Exit Time Reached uses (once
 * per pass, the wrap included), and the states' Enter, Exit and Fully Blended events.
 */

/** What an event does on its own: a sound from the actor, or a particle system at a bone or the actor. */
export type AnimEventAction =
  | { kind: "playSound"; assetGuid: string; volume: number }
  | { kind: "spawnParticles"; assetGuid: string; bone: string };

/** A clip's Animation Event on a player node: a single event, or a window when `durationMs` is above 0. */
export interface AnimClipEvent {
  name: string;
  /** Where it fires (a window: where it begins), in ms from the start of one pass. */
  timeMs: number;
  durationMs: number;
  /** The weight the clip must play at for it to fire, 0 to 1. */
  triggerWeight: number;
  action: AnimEventAction | null;
}

/** A single event fires `event`; a window fires `begin`, then `end`. */
export type AnimFiredEventPhase = "event" | "begin" | "end";

/** An Animation Event fired this tick. */
export interface AnimFiredEvent {
  name: string;
  phase: AnimFiredEventPhase;
  /** The Animation or Sprite Animation it is on; empty for a state's Enter, Exit or Fully Blended event. */
  clipAssetGuid: string;
  stateId: string;
  /** What it does on its own; only on a single event and a window's begin. */
  action: AnimEventAction | null;
}

/** A window that began and has not ended: its End fires when it is crossed, or when its source stops playing. */
export interface AnimOpenWindow {
  name: string;
  clipAssetGuid: string;
  stateId: string;
  /** The player (or Blend Space sample) it plays on. */
  source: string;
}

/** A state's own events: named Animation Events fired as it starts, as it is left, and once it plays alone. */
export interface AnimStateEvents {
  enter?: string;
  exit?: string;
  fullyBlended?: string;
}

/** A player that crossed many passes in one tick fires each event at most this often. */
const MAX_PASSES_PER_TICK = 4;

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseAnimEventAction(value: unknown): AnimEventAction | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "playSound" && text(record.assetGuid)) {
    return { kind: "playSound", assetGuid: text(record.assetGuid), volume: Math.max(0, finite(record.volume, 1)) };
  }
  if (record.kind === "spawnParticles" && text(record.assetGuid)) {
    return { kind: "spawnParticles", assetGuid: text(record.assetGuid), bone: text(record.bone) };
  }
  return null;
}

/** A player node's or Blend Space sample's events, as resolution stores them; unnamed events never fire. */
export function parseAnimClipEvents(value: unknown): AnimClipEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): AnimClipEvent[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const name = text(record.name);
    if (!name) return [];
    return [{
      name,
      timeMs: Math.max(0, finite(record.timeMs, 0)),
      durationMs: Math.max(0, finite(record.durationMs, 0)),
      triggerWeight: Math.min(1, Math.max(0, finite(record.triggerWeight, 0.5))),
      action: parseAnimEventAction(record.action),
    }];
  });
}

export function parseAnimStateEvents(value: unknown): AnimStateEvents | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const events: AnimStateEvents = {};
  for (const key of ["enter", "exit", "fullyBlended"] as const) {
    const name = text(record[key]);
    if (name) events[key] = name;
  }
  return Object.keys(events).length > 0 ? events : undefined;
}

/** Every Animation Event name a state fires itself. */
export function animStateEventNames(events: AnimStateEvents | undefined): string[] {
  return events ? [events.enter, events.exit, events.fullyBlended].filter((name): name is string => !!name) : [];
}

/**
 * One tick of a player's motion through its clip: from `from` to `to`, both as a position in the first pass (0 to 1)
 * plus the passes completed since. `inclusive` counts an event exactly at `from` (a player that starts there).
 */
export interface AnimClipSweep {
  from: number;
  to: number;
  inclusive: boolean;
  loop: boolean;
}

/**
 * The sweep a player made this tick from its previous clock to this one. A looping clock that came back round counts
 * the passes it completed; a Sync Group member whose phase wrapped without its own count counts one.
 */
export function animClipSweep(
  previous: { normalised: number; loopCount: number },
  next: { normalised: number; loopCount: number },
  loop: boolean,
  inclusive: boolean,
): AnimClipSweep {
  if (!loop) return { from: previous.normalised, to: next.normalised, inclusive, loop };
  let passes = Math.max(0, next.loopCount - previous.loopCount);
  if (passes === 0 && next.normalised + 1e-9 < previous.normalised) passes = 1;
  return { from: previous.normalised, to: Math.min(passes, MAX_PASSES_PER_TICK) + next.normalised, inclusive, loop };
}

/**
 * The positions in `sweep` where a clip position `at` (0 to 1) is crossed, in order: once per pass of a looping clip,
 * at most once for a clip that plays through once.
 */
export function animSweepCrossings(sweep: AnimClipSweep, at: number): number[] {
  const crossed = (position: number) =>
    (sweep.inclusive ? position >= sweep.from - 1e-9 : position > sweep.from + 1e-9) && position <= sweep.to + 1e-9;
  if (!sweep.loop) return crossed(at) ? [at] : [];
  // An event at the very end of a looping clip is the start of the next pass.
  const base = at >= 1 ? at - 1 : at;
  const positions: number[] = [];
  for (let pass = Math.floor(sweep.from - base) - 1; pass <= Math.ceil(sweep.to - base); pass += 1) {
    const position = pass + base;
    if (crossed(position)) positions.push(position);
  }
  return positions;
}

/** A clip event's begin and (for a window) end as positions in one pass of a clip `durationMs` long. */
export function animClipEventSpan(event: AnimClipEvent, durationMs: number): { begin: number; end: number | null } {
  const length = Math.max(1, durationMs);
  const begin = Math.min(1, event.timeMs / length);
  if (!(event.durationMs > 0)) return { begin, end: null };
  return { begin, end: Math.min(1, (event.timeMs + event.durationMs) / length) };
}
