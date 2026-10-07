import type { Effect } from "@babylonjs/core";

/**
 * First shader compile failure of an owned pass chain. Babylon reports the
 * error once its fallbacks are exhausted; recording it lets readiness waits
 * fail with the shader error instead of polling a never-ready effect until
 * their timeout.
 */
export class EffectCompileFailure {
  private failure: string | undefined;
  get message(): string | undefined {
    return this.failure;
  }
  /** An Effect/EffectWrapper `onError` callback labelled with the pass name. */
  for(name: string): (effect: Effect, errors: string) => void {
    return (_effect, errors) => {
      this.failure ??= `${name} failed to compile: ${errors}`;
    };
  }
}
