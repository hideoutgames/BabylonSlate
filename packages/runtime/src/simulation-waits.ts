import type { BObject } from "@babylonslate/object-model";
import type { SceneStreams } from "./scene-streams";
import type { SessionBoundaries } from "./session-boundaries";
import type { SimulationBlocks } from "./simulation-blocks";

/** Why a latent continuation cannot resume. */
type RuntimeContinuationCancelReason = "sessionStopped" | "ownerDestroyed" | "streamNotLoaded";

const CONTINUATION_CANCELLED: Record<RuntimeContinuationCancelReason, string> = {
  sessionStopped: "Script continuation cancelled: the runtime session ended.",
  ownerDestroyed: "Script continuation cancelled: its owner was destroyed.",
  streamNotLoaded: "Script continuation cancelled: its owner's streamed Scene is not loaded.",
};

/** A latent continuation whose session stopped, or whose owner went away, while it waited. */
export class RuntimeContinuationCancelled extends Error {
  constructor(reason: RuntimeContinuationCancelReason) { super(CONTINUATION_CANCELLED[reason]); this.name = "AbortError"; }
}

interface SimulationWaitsHost {
  stopped(): boolean;
  paused(): boolean;
  /** A pause change requested during a tick that holds the simulation when the tick ends. */
  pauseChangePending(): boolean;
  streams(): Pick<SceneStreams, "ownerReady">;
  blocks(): Pick<SimulationBlocks, "active">;
  boundaries(): Pick<SessionBoundaries, "pausePending">;
}

/**
 * Script continuations that wait for the simulation: while a blocking load
 * (Scene stream or asset), Pause, a pending boundary pause or a mid-tick
 * pause request holds it, a latent node's continuation parks until the driver
 * resumes waiters (pause release, a settled blocking load) or Stop releases
 * them all; a stopped session, a destroyed owner or an unready stream owner
 * then cancels it. Asset load waits continue through the same wait. The
 * driver keeps the pause state it reads. It is not a registered subsystem:
 * Stop releases waiters explicitly, before the subsystems' `cancelPending`.
 */
export class SimulationWaits {
  private readonly waiters = new Set<() => void>();
  private readonly host: SimulationWaitsHost;

  constructor(host: SimulationWaitsHost) { this.host = host; }

  private blocked(owner: BObject | null): boolean {
    return (this.host.blocks().active || this.host.paused() || this.host.boundaries().pausePending ||
      this.host.pauseChangePending()) && !this.host.stopped() && !owner?.destroyed;
  }

  private async wait(owner: BObject | null): Promise<void> {
    while (this.blocked(owner))
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    this.assertContinuable(owner);
  }

  /** Like waiting, but an unblocked continuation resumes without extra microtask hops. */
  continueSimulation(owner: BObject | null): Promise<void> | undefined {
    if (this.blocked(owner)) return this.wait(owner);
    this.assertContinuable(owner);
    return undefined;
  }

  private assertContinuable(owner: BObject | null): void {
    if (this.host.stopped()) throw new RuntimeContinuationCancelled("sessionStopped");
    if (owner?.destroyed) throw new RuntimeContinuationCancelled("ownerDestroyed");
    if (!this.host.streams().ownerReady(owner)) throw new RuntimeContinuationCancelled("streamNotLoaded");
  }

  /** Resume continuations waiting on the simulation, unless a blocking load still holds it. */
  resumeWaiters(): void {
    if (this.host.blocks().active) return;
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const resume of waiters) resume();
  }

  /** Stop: resume every waiter; each one then finds the session stopped. */
  releaseAll(): void {
    for (const resume of this.waiters) resume();
    this.waiters.clear();
  }
}
