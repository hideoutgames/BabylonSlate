import type { CommandMessage } from "@babylonslate/bridge";

interface SimulationBlocksHost {
  stopped(): boolean;
  emit(command: CommandMessage): void;
  /** A hold has settled and its count is already released. */
  settled(): void;
}

/**
 * The simulation holds of blocking loads (a Scene stream load or unload, an
 * asset load): gameplay ticks, physics, timers and tweens stop while loading
 * and rendering preparation continue. Holds nest, share one count and one
 * `simulationBlocking` command pair, and are separate from manual Pause: a
 * latent continuation waits for every hold and Pause to clear.
 */
export class SimulationBlocks {
  private count = 0;
  private readonly host: SimulationBlocksHost;

  constructor(host: SimulationBlocksHost) { this.host = host; }

  /** At least one blocking load is in progress; the simulation waits. */
  get active(): boolean {
    return this.count > 0;
  }

  /** Hold the simulation until `operation` settles; the result follows `operation`. */
  hold<T>(operation: Promise<T>): Promise<T> {
    this.count++;
    if (this.count === 1) this.host.emit({ type: "simulationBlocking", blocking: true });
    return operation.finally(() => {
      this.count--;
      if (this.count === 0 && !this.host.stopped()) this.host.emit({ type: "simulationBlocking", blocking: false });
      this.host.settled();
    });
  }
}
