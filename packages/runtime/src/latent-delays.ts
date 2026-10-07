import type { BObject } from "@babylonslate/object-model";
import type { RuntimeSubsystem } from "./runtime-subsystems";

type DelayWaiter = { remaining: number; resolve: () => void; owner?: BObject | null };

interface LatentDelaysHost {
  /** Whether the owner's time runs now (a SceneSubsystem's runs with its Scene). */
  canRun(owner: BObject): boolean;
}

/** Script `Delay` timers, counted in simulation time while their owner may run. */
export class LatentDelays implements RuntimeSubsystem {
  private readonly waiters: DelayWaiter[] = [];
  private readonly host: LatentDelaysHost;

  constructor(host: LatentDelaysHost) { this.host = host; }

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
      if (waiter.owner && !this.host.canRun(waiter.owner)) {
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
