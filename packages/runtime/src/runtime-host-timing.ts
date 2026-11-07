import type { EngineObject } from "@haptic/object-model";
import type { LatentDelays } from "./latent-delays";
import type { ScriptHostServices } from "./script-host";
import { RuntimeContinuationCancelled } from "./simulation-waits";
import type { TweenRuntime } from "./tween-runtime";

interface TimingHostDeps {
  tweens: Pick<TweenRuntime, "start">;
  delays: Pick<LatentDelays, "add" | "addOneTick" | "retrigger">;
  stopped(): boolean;
  /** Pending while a session boundary holds the owner's continuation. */
  continueSimulation(owner: EngineObject | null): Promise<void> | undefined;
}

/** Script latent timing: tweens and the Delay nodes. All resume through the session boundary. */
export function createTimingHostBindings(deps: TimingHostDeps): Pick<ScriptHostServices,
  "tween" | "isTweenSessionActive" | "delay" | "delayOneTick" | "retriggerableDelay"> {
  // A boundary requested after the timer fired still holds the continuation;
  // a destroyed owner's continuation is cancelled there.
  const wait = (owner: EngineObject | null | undefined, start: (resolve: () => void, reject: (error: unknown) => void) => void) =>
    new Promise<void>((resolve, reject) => {
      if (deps.stopped()) { resolve(); return; }
      start(resolve, reject);
    }).then(() => deps.continueSimulation(owner ?? null));
  return {
    tween: (request) => deps.tweens.start(request).then(async completed => {
      if (!completed) return false;
      { const pending = deps.continueSimulation(request.owner ?? null); if (pending) await pending; }
      return true;
    }),
    isTweenSessionActive: () => !deps.stopped(),
    delay: (seconds, owner) => wait(owner, (resolve) => deps.delays.add(seconds, resolve, owner)),
    delayOneTick: (owner) => wait(owner, (resolve) => deps.delays.addOneTick(resolve, owner)),
    // A later call of the same node ends this one's continuation quietly.
    retriggerableDelay: (key, seconds, owner) => wait(owner, (resolve, reject) =>
      deps.delays.retrigger(key, seconds, resolve, () => reject(new RuntimeContinuationCancelled("retriggered")), owner)),
  };
}
