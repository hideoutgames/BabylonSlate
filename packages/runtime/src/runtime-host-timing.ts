import type { EngineObject } from "@haptic/object-model";
import type { LatentDelays } from "./latent-delays";
import type { ScriptTimers } from "./script-timers";
import type { ScriptHostServices } from "./script-host";
import { RuntimeContinuationCancelled } from "./simulation-waits";
import { TickWait } from "./tick-wait";
import type { TweenRuntime } from "./tween-runtime";

interface TimingHostDeps {
  tweens: Pick<TweenRuntime, "start">;
  delays: Pick<LatentDelays, "add" | "addOneTick" | "retrigger">;
  timers: ScriptTimerService;
  stopped(): boolean;
  /** Pending while a session boundary holds the owner's continuation. */
  continueSimulation(owner: EngineObject | null): Promise<void> | undefined;
}

/** What the Timer nodes reach of the session's `ScriptTimers`. */
export type ScriptTimerService = Pick<ScriptTimers, "set" | "clear" | "setPaused" | "exists" | "isActive" | "isPaused" | "remaining" | "elapsed">;

/** Script latent timing: tweens, the Delay nodes and timers. Delays and tweens resume through the session boundary. */
export function createTimingHostBindings(deps: TimingHostDeps): Pick<ScriptHostServices,
  "tween" | "isTweenSessionActive" | "delay" | "delayOneTick" | "retriggerableDelay" | "timers"> {
  // A boundary requested after the timer fired still holds the continuation;
  // a destroyed owner's continuation is cancelled there.
  // The delay and tween systems settle these inside a tick, and a `TickWait` resumes its graph
  // there and then: a continuation runs in the tick its wait ended in, not after the frame's ticks.
  const wait = (owner: EngineObject | null | undefined, start: (resolve: () => void, reject: (error: unknown) => void) => void) =>
    TickWait.start<void>((resolve, reject) => {
      if (deps.stopped()) { resolve(); return; }
      start(resolve, reject);
    }).then(() => deps.continueSimulation(owner ?? null));
  return {
    tween: (request) => deps.tweens.start(request).then((completed): boolean | PromiseLike<boolean> => {
      if (!completed) return false;
      const pending = deps.continueSimulation(request.owner ?? null);
      return pending ? pending.then(() => true) : true;
    }),
    isTweenSessionActive: () => !deps.stopped(),
    delay: (seconds, owner) => wait(owner, (resolve) => deps.delays.add(seconds, resolve, owner)),
    delayOneTick: (owner) => wait(owner, (resolve) => deps.delays.addOneTick(resolve, owner)),
    // A later call of the same node ends this one's continuation quietly.
    retriggerableDelay: (key, seconds, owner) => wait(owner, (resolve, reject) =>
      deps.delays.retrigger(key, seconds, resolve, () => reject(new RuntimeContinuationCancelled("retriggered")), owner)),
    timers: deps.timers,
  };
}
