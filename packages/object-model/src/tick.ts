export const TICK_PHASES = [
  "gameInstance",
  "actors",
  "components",
  "physics",
  "postPhysics",
] as const;

export type TickPhase = (typeof TICK_PHASES)[number];

export type PhaseHook = (phase: TickPhase, dt: number, tickIndex: number) => void;

export interface TickSchedulerOptions {
  dt: number;
  /** Optional per-phase hooks. */
  onPhase?: PhaseHook;
}

export class TickClock {
  tickIndex = 0;
  dt: number;

  constructor(dt: number) {
    this.dt = dt;
  }

  advance(): number {
    const index = this.tickIndex;
    this.tickIndex += 1;
    return index;
  }
}
