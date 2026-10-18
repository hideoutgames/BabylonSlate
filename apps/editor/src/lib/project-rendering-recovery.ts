import type { GameSessionOwner, GameSessionStopResult } from "../services/game-session-owner";
import type { ProjectEngineController, ProjectEngineRequest } from "./project-engine";

/**
 * How long Retry waits for a stopping game before reporting it. Play's own
 * bounded steps (trace stop, worker stop) take a few seconds; the wait only
 * reports, it never forces a release the game has not confirmed.
 */
const RETRY_RELEASE_WAIT_MS = 15_000;

/** Why Retry could not replace the Engine; `retryable` is false when only a reload helps. */
export class RenderingRetryError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "RenderingRetryError";
    this.retryable = retryable;
  }
}

/**
 * Stop Play or Simulate as soon as the project Engine's device is lost: the game
 * cannot draw again, and it holds the lost Engine until it releases. Preview
 * Build renders on its own Engine and keeps running. Simulate's Keep Changes
 * captures the final Scene from the lost Engine, which cannot succeed, so its
 * changes are discarded first instead of leaving Stop waiting on a capture.
 */
export function stopGameOnDeviceLoss<Result extends GameSessionStopResult>(
  projectEngine: Pick<ProjectEngineController, "getSnapshot" | "subscribe">,
  sessionOwner: GameSessionOwner<Result>,
  options: {
    simulation?: () => { readonly keepChanges: boolean; discardChanges(reason?: string | null): void } | null;
    log?: (line: string) => void;
  } = {},
): () => void {
  let handled: unknown = null;
  return projectEngine.subscribe(() => {
    const state = projectEngine.getSnapshot();
    if (!state.deviceLost || state === handled) return;
    handled = state;
    const { mode } = sessionOwner.getSnapshot();
    if (mode !== "play" && mode !== "simulate") return;
    const simulation = mode === "simulate" ? options.simulation?.() : null;
    if (simulation?.keepChanges) {
      simulation.discardChanges("The graphics device was lost, so the final Scene could not be captured.");
      options.log?.("Simulation changes were discarded because the graphics device was lost.");
    }
    void sessionOwner.stop();
  });
}

/** Resolves true once the session has left `stopping`, or false after `ms`. */
function stopSettled<Result extends GameSessionStopResult>(owner: GameSessionOwner<Result>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const finish = (settled: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(settled);
    };
    const timer = setTimeout(() => finish(false), ms);
    const check = () => { if (owner.getSnapshot().lifecycle !== "stopping") finish(true); };
    unsubscribe = owner.subscribe(check);
    check();
  });
}

/**
 * Retry replaces the project Engine. A game still on the old one stops and must
 * confirm its release first; when it cannot, throws a `RenderingRetryError`
 * the caller shows instead of starting a new Engine.
 */
export async function retryProjectRendering<Result extends GameSessionStopResult>(options: {
  projectEngine: Pick<ProjectEngineController, "sync">;
  sessionOwner: GameSessionOwner<Result>;
  request: ProjectEngineRequest | null;
  releaseWaitMs?: number;
}): Promise<void> {
  const { sessionOwner } = options;
  if (!sessionOwner.canStart()) {
    // Preview Build runs on its own Engine; stopping it is the user's choice.
    if (sessionOwner.getSnapshot().mode === "preview")
      throw new RenderingRetryError("Rendering could not restart while Preview Build is running. Stop Preview Build, then choose Retry.", true);
    void sessionOwner.stop();
    if (!await stopSettled(sessionOwner, options.releaseWaitMs ?? RETRY_RELEASE_WAIT_MS))
      throw new RenderingRetryError("Rendering could not restart because the game is still releasing the graphics device. Retry again in a moment; if this keeps happening, save your work and reload the editor.", true);
    if (sessionOwner.getSnapshot().quarantined)
      throw new RenderingRetryError("Rendering could not restart because the game did not release the graphics device. Save your work and reload the editor.", false);
    if (!sessionOwner.canStart())
      throw new RenderingRetryError("Rendering could not restart because the game is still running. Stop it, then choose Retry.", true);
  }
  await options.projectEngine.sync(options.request, true);
}
