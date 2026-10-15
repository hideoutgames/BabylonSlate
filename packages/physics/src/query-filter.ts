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
