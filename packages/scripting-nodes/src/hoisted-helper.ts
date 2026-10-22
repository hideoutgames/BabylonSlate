import type { CodegenContext } from "@haptic/scripting";

/**
 * Declares an arithmetic helper once at module scope and returns the call
 * expression, so evaluating a node costs one call instead of a closure
 * allocation plus a call. Arguments are still evaluated once, left to right.
 *
 * `ctx.hoist` dedupes by exact source, so `name` must encode everything that
 * changes `body` (operation, axes): equal names mean equal bodies. The helper
 * uses no `this` or closure state, and `var` keeps repeated or concatenated
 * declarations valid.
 */
export function hoistedCall(
  ctx: Pick<CodegenContext, "hoist">,
  name: string,
  params: string,
  body: string,
  args: readonly string[],
): string {
  ctx.hoist(`var ${name} = (${params}) => ${body};`);
  return `${name}(${args.join(", ")})`;
}
