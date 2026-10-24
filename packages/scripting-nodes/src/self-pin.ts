import { objectRef, pin, type GraphPin, type PinType } from "@haptic/scripting";

/**
 * Marks an object or Actor input as the node's subject: the object it reads,
 * writes, calls or moves. A null value skips the node and logs an error. Leave
 * it off inputs where null is a legitimate value (a Set Variable value, Is
 * Valid, Cast, a Spawn owner, a pin documented to accept None).
 */
export function subject(input: GraphPin): GraphPin {
  return { ...input, subject: true };
}

/**
 * An optional reference input that reads the object running the graph while it
 * is unwired, and the node's subject once wired. The graph labels it "(Self)".
 */
export function selfPin(id: string, name: string, type: PinType): GraphPin {
  return { ...subject(pin(id, name, "in", type, "data", true)), selfWhenUnwired: true };
}

/** {@link selfPin} for an Actor input. */
export function selfActorPin(id: string, name: string = id): GraphPin {
  return selfPin(id, name, objectRef("Actor"));
}
