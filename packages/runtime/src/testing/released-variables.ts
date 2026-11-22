import type { EngineObject } from "@haptic/object-model";

/**
 * The variables `object` held when its destruction finished, for a test that checks what its destruction hooks
 * wrote: a destroyed object releases its variables, so reading them afterwards answers nothing. Empty until then.
 */
export function variablesAtRelease(object: EngineObject): ReadonlyMap<string, unknown> {
  const kept = new Map<string, unknown>();
  const release = object.releaseState.bind(object);
  object.releaseState = () => {
    for (const [name, value] of object.variables) kept.set(name, value);
    release();
  };
  return kept;
}
