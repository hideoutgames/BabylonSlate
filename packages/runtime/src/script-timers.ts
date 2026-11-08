import type { EngineObject } from "@haptic/object-model";
import type { OwnerAdmission } from "./owner-admission";
import type { RuntimeSubsystem } from "./runtime-subsystems";
import type { EventDelegate } from "./script-dispatchers";

type Timer = {
  readonly id: number;
  /** The object whose script set the timer: its time runs while it may run, and it ends with it. */
  readonly owner: EngineObject | null;
  readonly delegate: EventDelegate;
  readonly rate: number;
  readonly looping: boolean;
  /** Length of the interval running now: the rate plus any start delay, then the rate. */
  interval: number;
  /** Seconds until the interval ends. */
  remaining: number;
  paused: boolean;
};

/** A looping timer shorter than a step fires at most this often in one step, so a tiny rate cannot stall it. */
export const TIMER_MAX_FIRES_PER_STEP = 64;

/**
 * Set Timer By Event timers, counted in simulation time (so they follow time dilation) while their
 * owner may run; during a game pause only owners that tick on pause count. A timer fires its event
 * when its interval ends; a looping one then starts the next. Timers end with their owner or the
 * delegate's object, and when Play stops. Handles are ids from 1; 0 is no timer.
 */
export class ScriptTimers implements RuntimeSubsystem {
  private readonly timers = new Map<number, Timer>();
  private nextId = 1;
  private readonly admission: Pick<OwnerAdmission, "canRunActions">;
  private readonly fire: (delegate: EventDelegate, owner: EngineObject | null) => void;

  constructor(
    admission: Pick<OwnerAdmission, "canRunActions">,
    fire: (delegate: EventDelegate, owner: EngineObject | null) => void,
  ) {
    this.admission = admission;
    this.fire = fire;
  }

  /**
   * Starts a timer, returning its id, or 0 when `time` is not above 0. A `startDelay` above 0 lengthens
   * only the first interval, as Unreal's Initial Start Delay does.
   */
  set(owner: EngineObject | null, delegate: EventDelegate, time: unknown, looping: unknown, startDelay?: unknown): number {
    const rate = Number(time);
    if (!Number.isFinite(rate) || rate <= 0) return 0;
    const delay = Number(startDelay);
    const interval = rate + (Number.isFinite(delay) && delay > 0 ? delay : 0);
    const id = this.nextId++;
    this.timers.set(id, { id, owner, delegate, rate, looping: looping === true, interval, remaining: interval, paused: false });
    return id;
  }

  clear(id: number): void {
    this.timers.delete(id);
  }

  setPaused(id: number, paused: boolean): void {
    const timer = this.live(id);
    if (timer) timer.paused = paused;
  }

  exists(id: number): boolean {
    return this.live(id) !== undefined;
  }

  isActive(id: number): boolean {
    const timer = this.live(id);
    return timer !== undefined && !timer.paused;
  }

  isPaused(id: number): boolean {
    return this.live(id)?.paused === true;
  }

  /** Seconds until the timer next fires, or -1 for no timer. */
  remaining(id: number): number {
    const timer = this.live(id);
    return timer ? Math.max(0, timer.remaining) : -1;
  }

  /** Seconds since the running interval began, or -1 for no timer. */
  elapsed(id: number): number {
    const timer = this.live(id);
    return timer ? Math.min(timer.interval, timer.interval - timer.remaining) : -1;
  }

  /**
   * Count one step for every timer whose owner may run, then fire the due ones in the order they were
   * set. `canAdvance`, while the game is paused: whether an owner ticks on pause.
   */
  advance(dt: number, canAdvance?: (owner: EngineObject | null | undefined) => boolean): void {
    if (this.timers.size === 0) return;
    for (const timer of [...this.timers.values()]) {
      if (!this.live(timer.id) || timer.paused) continue;
      if (timer.owner && !this.admission.canRunActions(timer.owner)) continue;
      if (canAdvance && !canAdvance(timer.owner)) continue;
      timer.remaining -= dt;
      for (let fires = 0; timer.remaining <= 0 && fires < TIMER_MAX_FIRES_PER_STEP; fires++) {
        if (timer.looping) {
          timer.interval = timer.rate;
          timer.remaining += timer.rate;
        } else {
          // A finished timer is gone before its event runs, so the event can read and reuse its handle.
          this.timers.delete(timer.id);
        }
        this.fire(timer.delegate, timer.owner);
        if (!timer.looping || this.timers.get(timer.id) !== timer || timer.paused) break;
      }
      if (timer.looping && timer.remaining <= 0) timer.remaining = timer.rate;
    }
  }

  cancelPending(): void {
    this.timers.clear();
  }

  /** The timer, after dropping it when its owner or event object has gone. */
  private live(id: number): Timer | undefined {
    const timer = this.timers.get(id);
    if (!timer) return undefined;
    if (timer.owner?.destroyed || timer.delegate.object.destroyed) {
      this.timers.delete(id);
      return undefined;
    }
    return timer;
  }
}
