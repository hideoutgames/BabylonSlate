import type { BObject } from "@babylonslate/object-model";
import type { LatentDelays } from "./latent-delays";
import type { ScriptHostServices } from "./script-host";
import type { TweenRuntime } from "./tween-runtime";

interface TimingHostDeps {
  tweens: Pick<TweenRuntime, "start">;
  delays: Pick<LatentDelays, "add">;
  stopped(): boolean;
  /** Pending while a session boundary holds the owner's continuation. */
  continueSimulation(owner: BObject | null): Promise<void> | undefined;
}

/** Script latent timing: tweens and Delay. Both resume through the session boundary. */
export function createTimingHostBindings(deps: TimingHostDeps): Pick<ScriptHostServices,
  "tween" | "isTweenSessionActive" | "delay"> {
  return {
    tween: (request) => deps.tweens.start(request).then(async completed => {
      if (!completed) return false;
      { const pending = deps.continueSimulation(request.owner ?? null); if (pending) await pending; }
      return true;
    }),
    isTweenSessionActive: () => !deps.stopped(),
    delay: (seconds, owner) =>
      new Promise<void>((resolve) => {
        if (deps.stopped()) { resolve(); return; }
        deps.delays.add(seconds, resolve, owner);
        // A boundary requested after the timer fired still holds the continuation.
      }).then(() => deps.continueSimulation(owner ?? null)),
  };
}
