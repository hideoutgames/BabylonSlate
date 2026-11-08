import type { EngineObject } from "@haptic/object-model";
import type { OwnerAdmission } from "./owner-admission";
import type { RuntimeSubsystem } from "./runtime-subsystems";

type DelayWaiter = {
  /** Seconds left; unused by a one-tick wait. */
  remaining: number;
  /** A one-tick wait resumes in the first advance of a later tick than this one. */
  afterTick?: number;
  resolve: () => void;
  owner?: EngineObject | null;
  /** A Retriggerable Delay's key (owner and node): a new call with it ends this wait. */
  key?: string;
  cancel?: () => void;
};

/**
 * Script `Delay`, `Delay One Tick` and `Retriggerable Delay` timers, counted in
 * simulation time while their owner may run. Each Delay and Delay One Tick call
 * waits on its own; a Retriggerable Delay call replaces its node's earlier wait.
 */
export class LatentDelays implements RuntimeSubsystem {
  private readonly waiters: DelayWaiter[] = [];
  private readonly retriggerable = new Map<string, DelayWaiter>();
  /** This tick's due waiters, in waiter order; emptied once they resumed. */
  private readonly due: DelayWaiter[] = [];
  /** An owner's time runs while its actions may run (a SceneSubsystem's with its Scene). */
  private readonly admission: Pick<OwnerAdmission, "canRunActions">;
  /** The World's tick index, which steps once per tick before scripts run. */
  private readonly tickIndex: () => number;

  constructor(admission: Pick<OwnerAdmission, "canRunActions">, tickIndex: () => number) {
    this.admission = admission;
    this.tickIndex = tickIndex;
  }

  add(seconds: unknown, resolve: () => void, owner?: EngineObject | null): void {
    this.waiters.push({ remaining: waitSeconds(seconds), resolve, owner });
  }

  /** Resumes in the next tick's advance, so a call from a tick's scripts continues in the following tick. */
  addOneTick(resolve: () => void, owner?: EngineObject | null): void {
    this.waiters.push({ remaining: 0, afterTick: this.tickIndex(), resolve, owner });
  }

  /**
   * Starts `key`'s wait for `owner` over from `seconds`. The earlier wait of the
   * same key and owner is cancelled, so only the latest call continues.
   */
  retrigger(key: string, seconds: unknown, resolve: () => void, cancel: () => void, owner?: EngineObject | null): void {
    const id = `${owner?.guid ?? ""}\0${key}`;
    const previous = this.retriggerable.get(id);
    if (previous) {
      this.waiters.splice(this.waiters.indexOf(previous), 1);
      previous.cancel?.();
    }
    const waiter: DelayWaiter = { remaining: waitSeconds(seconds), resolve, owner, key: id, cancel };
    this.retriggerable.set(id, waiter);
    this.waiters.push(waiter);
  }

  /**
   * Count one tick for every waiter whose owner may run, then resume the due
   * ones in order. A destroyed owner's waiter resumes at once, so its
   * continuation ends (an owner cancellation) rather than staying pending.
   */
  /** `canAdvance`, while the game is paused: whether a waiter's owner ticks on pause; the rest hold. */
  advance(dt: number, canAdvance?: (owner: EngineObject | null | undefined) => boolean): void {
    const waiters = this.waiters;
    if (waiters.length === 0) return;
    const tick = this.tickIndex();
    const due = this.due;
    // Waiters that stay move down over the due ones, keeping their order.
    let kept = 0;
    for (const waiter of waiters) {
      if (waiter.owner?.destroyed) {
        due.push(waiter);
        continue;
      }
      if (waiter.owner && !this.admission.canRunActions(waiter.owner)) {
        waiters[kept++] = waiter;
        continue;
      }
      if (canAdvance && !canAdvance(waiter.owner)) {
        waiters[kept++] = waiter;
        continue;
      }
      if (waiter.afterTick !== undefined) {
        if (tick > waiter.afterTick) due.push(waiter);
        else waiters[kept++] = waiter;
        continue;
      }
      waiter.remaining -= dt;
      if (waiter.remaining <= 0) due.push(waiter);
      else waiters[kept++] = waiter;
    }
    waiters.length = kept;
    try {
      for (const waiter of due) if (waiter.key) this.retriggerable.delete(waiter.key);
      for (const waiter of due) waiter.resolve();
    } finally {
      due.length = 0;
    }
  }

  /** Stop resumes every pending wait; its continuation then observes the stopped session. */
  cancelPending(): void {
    this.retriggerable.clear();
    for (const waiter of this.waiters.splice(0)) waiter.resolve();
  }
}

function waitSeconds(value: unknown): number {
  return Math.max(0, Number(value) || 0);
}
