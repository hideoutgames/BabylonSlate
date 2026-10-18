import { actorRef, pin, type CodegenContext, type GraphPin } from "@babylonslate/scripting";

/**
 * An optional Actor input that reads the actor running the graph while it is
 * unwired; the node pairs it with `actorOrSelf`. The graph shows it as Self.
 */
export function selfActorPin(id: string, name: string = id): GraphPin {
  return { ...pin(id, name, "in", actorRef("Actor"), "data", true), selfWhenUnwired: true };
}

/**
 * An optional Actor pin left unwired reads the actor running the graph. A wired
 * reference is passed through as is, so one that is null at runtime stays null
 * and the node does nothing instead of acting on Self.
 */
export function actorOrSelf(
  ctx: Pick<CodegenContext, "input" | "isWired">,
  pinId: string,
): string {
  return ctx.isWired(pinId) ? ctx.input(pinId) : "ctx.self";
}
