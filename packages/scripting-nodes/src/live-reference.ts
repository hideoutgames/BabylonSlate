import type { CodegenContext } from "@haptic/scripting";
import { hoistedCall } from "./hoisted-helper";

/**
 * Is Valid as every node means it: a reference that is not empty and does not
 * hold a destroyed object. The value is evaluated once.
 */
export function liveReferenceCall(ctx: Pick<CodegenContext, "hoist">, value: string): string {
  return hoistedCall(ctx, "__haptic_isLive", "v", "v != null && v.destroyed !== true", [value]);
}
