import type { RuntimeAssetPreloadOptions, RuntimeAssetPreloadResult } from "@babylonslate/core";
import type { BObject, World } from "@babylonslate/object-model";
import type { RuntimeAssetPreloads } from "./asset-preloads";
import type { OwnerAdmission } from "./owner-admission";
import type { SceneStreams } from "./scene-streams";
import type { SessionBoundaries } from "./session-boundaries";

/** A latent continuation whose session stopped, or whose owner went away, while it waited. */
export class RuntimeContinuationCancelled extends Error {
  constructor() { super("Scene realization was cancelled."); this.name = "AbortError"; }
}

interface SimulationWaitsHost {
  world(): World;
  stopped(): boolean;
  paused(): boolean;
  /** A pause change requested during a tick that holds the simulation when the tick ends. */
  pauseChangePending(): boolean;
  streams(): Pick<SceneStreams, "blocking" | "ownerReady">;
  boundaries(): Pick<SessionBoundaries, "pausePending">;
  assetPreloads(): Pick<RuntimeAssetPreloads, "acquire" | "release">;
}

/**
 * Script continuations that wait for the simulation: while a blocking scene
 * stream, Pause, a pending boundary pause or a mid-tick pause request holds
 * it, a latent node's continuation parks until the driver resumes waiters
 * (pause release, a settled blocking stream) or Stop releases them all; a
 * stopped session, a destroyed owner or an unready stream owner then cancels
 * it. Gameplay asset preloads resume through the same wait and deliver only
 * their latest progress value through `OwnerAdmission`. The driver keeps the
 * pause state it reads. It is not a registered subsystem: Stop releases
 * waiters explicitly, before the subsystems' `cancelPending`.
 */
export class SimulationWaits {
  private readonly admission: OwnerAdmission;
  private readonly waiters = new Set<() => void>();
  private readonly host: SimulationWaitsHost;

  constructor(admission: OwnerAdmission, host: SimulationWaitsHost) {
    this.admission = admission;
    this.host = host;
  }

  private blocked(owner: BObject | null): boolean {
    return (this.host.streams().blocking || this.host.paused() || this.host.boundaries().pausePending ||
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
    if (this.host.stopped() || owner?.destroyed || !this.host.streams().ownerReady(owner))
      throw new RuntimeContinuationCancelled();
  }

  /** Resume continuations waiting on the simulation, unless a blocking scene stream still holds it. */
  resumeWaiters(): void {
    if (this.host.streams().blocking) return;
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const resume of waiters) resume();
  }

  /** Stop: resume every waiter; each one then finds the session stopped. */
  releaseAll(): void {
    for (const resume of this.waiters) resume();
    this.waiters.clear();
  }

  async preloadForGameplay(assets: readonly string[], owner: BObject | null, options: RuntimeAssetPreloadOptions = {}): Promise<RuntimeAssetPreloadResult> {
    const callbackOwner = owner ?? this.host.world().gameInstance;
    let queued = false, active = true, latest = 0;
    const onProgress = options.onProgress ? (value: number) => {
      latest = value;
      if (queued || !active) return;
      queued = true;
      // Only the latest progress value waits during Pause; no callback flood or
      // gameplay continuation is delivered by an I/O completion while frozen.
      const deliver = () => {
        queued = false;
        if (active) this.admission.guard(() => options.onProgress!(latest));
      };
      if (callbackOwner) this.admission.run(callbackOwner, deliver);
      else deliver();
    } : undefined;
    let result: RuntimeAssetPreloadResult | undefined;
    try {
      result = await this.host.assetPreloads().acquire(assets, owner?.guid ?? this.host.world().currentScene?.guid ?? "session", { ...options, onProgress });
      { const pending = this.continueSimulation(owner); if (pending) await pending; }
      return result;
    } catch (error) {
      if (result?.preloadId) this.host.assetPreloads().release(result.preloadId);
      throw error;
    } finally { active = false; }
  }
}
