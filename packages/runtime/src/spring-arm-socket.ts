import { SPRING_ARM_COMPONENT_CLASS_ID, springArmChildOffset } from "@haptic/core";
import type { ActorComponent } from "@haptic/object-model";

/** Socket lengths the Camera Probe shortened this tick, by spring arm component. */
const probedLengths = new WeakMap<ActorComponent, number>();

/** The Camera Probe's current length for `arm`, or null when its probe is off. */
export function setProbedSpringArmLength(arm: ActorComponent, length: number | null): void {
  if (length === null) probedLengths.delete(arm);
  else probedLengths.set(arm, length);
}

/**
 * Where a component's children attach relative to it: a spring arm's socket
 * (shortened by its Camera Probe while one is on), or null for any other
 * component. Worker-side poses (script world transforms, capture lenses,
 * cable ends) use it so they agree with what Play draws.
 */
export function springArmSocketOffset(parent: ActorComponent): [number, number, number] | null {
  if (parent.classId !== SPRING_ARM_COMPONENT_CLASS_ID) return null;
  const probed = probedLengths.get(parent);
  if (probed !== undefined) return [0, 0, -probed];
  return springArmChildOffset({ classId: parent.classId, properties: { armLength: parent.getVariable("armLength") } });
}
