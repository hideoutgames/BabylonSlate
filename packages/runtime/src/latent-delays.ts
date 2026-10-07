import type { BObject } from "@babylonslate/object-model";
import type { OwnerAdmission } from "./owner-admission";
import type { RuntimeSubsystem } from "./runtime-subsystems";

type DelayWaiter = { remaining: number; resolve: () => void; owner?: BObject | null };

/** Script `Delay` timers, counted in simulation time while their owner may run. */
export class LatentDelays implements RuntimeSubsystem {
  private readonly waiters: DelayWaiter[] = [];
  /** An owner's time runs while its actions may run (a SceneSubsystem's with its Scene). */
  private readonly admission: Pick<OwnerAdmission, "canRunActions">;

  constructor(admission: Pick<OwnerAdmission, "canRunActions">) { this.admission = admission; }

  add(seconds: unknown, resolve: () => void, owner?: BObject | null): void {
    this.waiters.push({ remaining: Math.max(0, Number(seconds) || 0), resolve, owner });
  }

  /** Count one tick for every waiter whose owner may run, then resume the due ones in order. */
  advance(dt: number): void {
    if (this.waiters.length === 0) return;
    const remaining: DelayWaiter[] = [];
    const due: Array<() => void> = [];
    for (const waiter of this.waiters) {
      if (waiter.owner?.destroyed) continue;
      if (waiter.owner && !this.admission.canRunActions(waiter.owner)) {
        remaining.push(waiter);
        continue;
      }
      waiter.remaining -= dt;
      if (waiter.remaining <= 0) due.push(waiter.resolve);
      else remaining.push(waiter);
    }
    this.waiters.length = 0;
    this.waiters.push(...remaining);
    for (const resolve of due) resolve();
  }

  /** Stop resumes every pending Delay; its continuation then observes the stopped session. */
  cancelPending(): void {
    for (const waiter of this.waiters.splice(0)) waiter.resolve();
  }
}
