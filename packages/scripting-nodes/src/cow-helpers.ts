import type { CodegenContext } from "@haptic/scripting";

/**
 * Shared runtime ownership set for Copy-On-Write (COW) Array and Map mutators.
 *
 * Stored on `globalThis` via `Symbol.for` so every compiled module in a session
 * (and standalone unit tests) observes the exact same ownership table, without
 * attaching any enumerable or non-enumerable properties to Arrays or Maps.
 *
 * - `__cowOwn(c)`: marks a freshly constructed container as uniquely owned.
 * - `__cowShare(c)`: marks a container whose reference escaped as shared so
 *   future linear self-updates clone once before mutating.
 */
export const COW_HELPERS =
  'var __cowUnique=(globalThis[Symbol.for("haptic.cow.unique")]??=new WeakSet()),' +
  '__cowOwn=(c)=>{if(c!==null&&typeof c==="object")__cowUnique.add(c);return c;},' +
  '__cowShare=(c)=>{if(c!==null&&typeof c==="object")__cowUnique.delete(c);return c;};';

export function hoistCowHelpers(ctx: Pick<CodegenContext, "hoist">): void {
  ctx.hoist(COW_HELPERS);
}
