import type { LineTraceOptions } from "./types";

/** Whether a query can hit trigger geometry at all: `onlyTriggers` includes it whatever `includeTriggers` says. */
export function queryHitsTriggers(options?: LineTraceOptions): boolean {
  return options?.onlyTriggers === true || options?.includeTriggers !== false;
}

/** Whether a query may hit a shape of this kind: triggers only, solids only, or either. */
export function queryAdmitsShape(isTrigger: boolean, options?: LineTraceOptions): boolean {
  return options?.onlyTriggers === true ? isTrigger : !isTrigger || options?.includeTriggers !== false;
}

/** Whether the options leave trigger and solid shapes alike to the query. */
export function queryAdmitsEveryShape(options?: LineTraceOptions): boolean {
  return options?.onlyTriggers !== true && options?.includeTriggers !== false;
}

/**
 * Whether a query ignores an actor: one of its `ignoreActorIds` (passed as `own`, a set the backend built once per
 * query, or null when there are none) or of its `ignoreActorSet`.
 */
export function queryIgnoresActor(own: ReadonlySet<string> | null, options: LineTraceOptions | undefined, actorId: string): boolean {
  return own?.has(actorId) === true || options?.ignoreActorSet?.has(actorId) === true;
}

/** The query's own `ignoreActorIds` as a set, or null when there are none. */
export function ownIgnoredActors(options?: LineTraceOptions): ReadonlySet<string> | null {
  return options?.ignoreActorIds?.length ? new Set(options.ignoreActorIds) : null;
}
