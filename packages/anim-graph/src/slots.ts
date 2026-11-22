import type { AnimClipEvent } from "./events";
import type { AnimClipRootMotion } from "./root-motion";

/**
 * Slots: named places in state graphs (Slot nodes) where scripts play one-shot Animations (Play Slot Animation). A
 * slot's playback belongs to the whole graph evaluation, not to a state: it runs, blends in and out and ends by
 * itself, whichever state shows it, and a Slot node shows it over its Source pose.
 */

/** The name a Slot node and Play Slot Animation use when none is given. */
export const ANIM_DEFAULT_SLOT = "DefaultSlot";

/** A clip a slot plays: an Animation (3D) or a Sprite Animation (2D), as the clip catalog describes it. */
export interface AnimSlotClip {
  assetGuid: string;
  clipName: string;
  clipKind: "animation" | "sprite";
  durationMs: number;
  events?: AnimClipEvent[];
  /** An Animation's root motion, which moves the actor while it plays. */
  rootMotion?: AnimClipRootMotion;
}

/** One play of a slot animation. Plain data, so trace frames record it. */
export interface AnimSlotPlayback {
  /** The play's handle, which reports its blend out and its end. */
  id: number;
  clip: AnimSlotClip;
  playRate: number;
  /** Passes to play; 0 loops until stopped. */
  loopCount: number;
  blendInMs: number;
  blendOutMs: number;
  /** Time since the play began, for the blend in. */
  elapsedMs: number;
  /** Clip time played across its passes. */
  playedMs: number;
  /** Set while blending out: how far into it, how long it takes, and whether a stop or a newer play started it. */
  blendOut?: { elapsedMs: number; durationMs: number; stopped: boolean };
  /** Its weight this tick, 0 to 1. */
  weight: number;
}

/** A slot's plays: the one playing, and one a newer play replaced, still blending out under it. */
export interface AnimSlotState {
  active?: AnimSlotPlayback;
  outgoing?: AnimSlotPlayback;
}

/** A script's request, applied at the start of the next evaluation, in order. */
export type AnimSlotRequest =
  | {
      kind: "play";
      id: number;
      slot: string;
      clip: AnimSlotClip;
      blendInSeconds: number;
      blendOutSeconds: number;
      playRate: number;
      loopCount: number;
      startSeconds: number;
    }
  | { kind: "stop"; slot: string; blendOutSeconds: number };

/**
 * What happened to a play this tick: it began blending out (by itself near its end, or stopped or replaced), ended
 * after playing through (`completed`), or ended early (`interrupted`).
 */
export interface AnimSlotEvent {
  id: number;
  phase: "blendOut" | "completed" | "interrupted";
}

/** A play's clock this tick, before and after its advance, for its clip events. */
export interface AnimSlotSweep {
  slot: string;
  playback: AnimSlotPlayback;
  previous: { normalised: number; loopCount: number };
  next: { normalised: number; loopCount: number };
  /** The play began this tick: an event at its start counts. */
  fresh: boolean;
}

function seconds(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value * 1000 : fallback;
}

/** Where a play is in its clip: the pass it is on and how far through it, holding the last frame once played through. */
export function slotClock(playback: AnimSlotPlayback): { normalised: number; loopCount: number } {
  const duration = Math.max(1, playback.clip.durationMs);
  if (playback.loopCount > 0 && playback.playedMs >= playback.loopCount * duration) {
    return { normalised: 1, loopCount: playback.loopCount - 1 };
  }
  const loopCount = Math.floor(playback.playedMs / duration);
  return { normalised: (playback.playedMs - loopCount * duration) / duration, loopCount };
}

function weightOf(playback: AnimSlotPlayback): number {
  const blendIn = playback.blendInMs > 0 ? Math.min(1, playback.elapsedMs / playback.blendInMs) : 1;
  const out = playback.blendOut;
  if (!out) return blendIn;
  const fade = out.durationMs > 0 ? Math.max(0, 1 - out.elapsedMs / out.durationMs) : 0;
  return blendIn * fade;
}

function beginBlendOut(playback: AnimSlotPlayback, durationMs: number, stopped: boolean, events: AnimSlotEvent[]): AnimSlotPlayback {
  if (playback.blendOut) return playback;
  events.push({ id: playback.id, phase: "blendOut" });
  return { ...playback, blendOut: { elapsedMs: 0, durationMs: Math.max(0, durationMs), stopped } };
}

/** Ends a play at once: its blend out begins (if it had not) and it is interrupted. */
function interrupt(playback: AnimSlotPlayback, events: AnimSlotEvent[]): void {
  if (!playback.blendOut) events.push({ id: playback.id, phase: "blendOut" });
  events.push({ id: playback.id, phase: "interrupted" });
}

/**
 * Advances one play by `dtMs`: it begins blending out by itself `blendOutMs` before its last pass ends, and ends once
 * its blend out has run. Null when it ended this tick.
 */
function advance(playback: AnimSlotPlayback, dtMs: number, events: AnimSlotEvent[]): AnimSlotPlayback | null {
  let next: AnimSlotPlayback = {
    ...playback,
    elapsedMs: playback.elapsedMs + dtMs,
    playedMs: playback.playedMs + dtMs * Math.max(0, playback.playRate),
    ...(playback.blendOut ? { blendOut: { ...playback.blendOut, elapsedMs: playback.blendOut.elapsedMs + dtMs } } : {}),
  };
  const total = next.loopCount > 0 ? next.loopCount * Math.max(1, next.clip.durationMs) : Infinity;
  // Play Rate shortens the clip's time left; the blend out takes real time.
  const rate = Math.max(1e-6, next.playRate);
  if (!next.blendOut && (total - next.playedMs) / rate <= next.blendOutMs) next = beginBlendOut(next, next.blendOutMs, false, events);
  const out = next.blendOut;
  if (out && out.elapsedMs >= out.durationMs && (out.stopped || next.playedMs >= total)) {
    events.push({ id: next.id, phase: out.stopped ? "interrupted" : "completed" });
    return null;
  }
  return { ...next, weight: weightOf(next) };
}

const NO_SLOT_TICK = Object.freeze({
  slots: Object.freeze({}) as Readonly<Record<string, AnimSlotState>>,
  events: Object.freeze([]) as readonly AnimSlotEvent[],
  sweeps: Object.freeze([]) as readonly AnimSlotSweep[],
});

function hasSlots(slots: Readonly<Record<string, AnimSlotState>> | undefined): boolean {
  for (const name in slots) if (Object.hasOwn(slots, name)) return true;
  return false;
}

/**
 * One tick of every slot: the scripts' requests in order (a play replaces the slot's playing one, which blends out
 * under it over the new one's blend in; a stop starts the blend out), then each play advanced by `dtMs`. Returns the
 * slots that still play, the plays' events, and each play's clock sweep for its clip events.
 */
export function advanceAnimSlots(
  previous: Readonly<Record<string, AnimSlotState>> | undefined,
  requests: readonly AnimSlotRequest[] | undefined,
  dtMs: number,
): { slots: Readonly<Record<string, AnimSlotState>>; events: readonly AnimSlotEvent[]; sweeps: readonly AnimSlotSweep[] } {
  // Most graphs never play a slot: with nothing playing and nothing asked, a tick allocates nothing.
  if ((requests === undefined || requests.length === 0) && !hasSlots(previous)) return NO_SLOT_TICK;
  const events: AnimSlotEvent[] = [];
  const slots: Record<string, AnimSlotState> = {};
  for (const [name, state] of Object.entries(previous ?? {})) slots[name] = { ...state };
  const fresh = new Set<number>();
  for (const request of requests ?? []) {
    const name = request.slot.trim() || ANIM_DEFAULT_SLOT;
    const state = slots[name] ?? {};
    if (request.kind === "stop") {
      if (state.active) slots[name] = { ...state, active: beginBlendOut(state.active, seconds(request.blendOutSeconds, 0), true, events) };
      continue;
    }
    const blendInMs = seconds(request.blendInSeconds, 0);
    // The play it replaces blends out under it; one already blending out under an earlier play ends now.
    if (state.outgoing) interrupt(state.outgoing, events);
    const outgoing = state.active
      ? (() => {
          const replaced = beginBlendOut(state.active, blendInMs, true, events);
          return { ...replaced, blendOut: { ...replaced.blendOut!, stopped: true, durationMs: Math.min(replaced.blendOut!.durationMs, blendInMs) } };
        })()
      : undefined;
    const durationMs = Math.max(1, request.clip.durationMs);
    const loopCount = Math.max(0, Math.round(Number.isFinite(request.loopCount) ? request.loopCount : 1));
    const total = loopCount > 0 ? loopCount * durationMs : Infinity;
    const active: AnimSlotPlayback = {
      id: request.id,
      clip: request.clip,
      playRate: Number.isFinite(request.playRate) ? request.playRate : 1,
      loopCount,
      blendInMs,
      blendOutMs: seconds(request.blendOutSeconds, 0),
      elapsedMs: 0,
      playedMs: Math.min(total, seconds(request.startSeconds, 0)),
      weight: 0,
    };
    fresh.add(active.id);
    slots[name] = { active, ...(outgoing ? { outgoing } : {}) };
  }
  const sweeps: AnimSlotSweep[] = [];
  for (const name of Object.keys(slots)) {
    const state = slots[name]!;
    const step = (playback: AnimSlotPlayback | undefined) => {
      if (!playback) return undefined;
      const before = slotClock(playback);
      const next = advance(playback, dtMs, events);
      if (next) sweeps.push({ slot: name, playback: next, previous: before, next: slotClock(next), fresh: fresh.has(next.id) });
      return next ?? undefined;
    };
    const active = step(state.active);
    const outgoing = step(state.outgoing);
    if (active || outgoing) slots[name] = { ...(active ? { active } : {}), ...(outgoing ? { outgoing } : {}) };
    else delete slots[name];
  }
  return { slots, events, sweeps };
}
