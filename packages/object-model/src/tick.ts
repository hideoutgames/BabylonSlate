/**
 * Fixed tick order. `gameInstance` ticks the Game Instance then GameSubsystems
 * and keeps running while the scene prepares; `sceneSubsystems` and later
 * phases are gated by scene readiness.
 */
export const TICK_PHASES = [
  "gameInstance",
  "sceneSubsystems",
  "actors",
  "components",
  "physics",
  "postPhysics",
] as const;

export type TickPhase = (typeof TICK_PHASES)[number];

export type PhaseHook = (phase: TickPhase, dt: number, tickIndex: number) => void;

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
