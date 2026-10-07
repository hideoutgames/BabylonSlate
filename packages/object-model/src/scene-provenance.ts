import type { Actor, ActorComponent } from "./objects";

const actors = new WeakMap<Actor, string>();
const components = new WeakMap<ActorComponent, string>();

/** Identity metadata only: never retain the serialized document or native resources. */
export function recordSceneActorProvenance(actor: Actor, serializedId: string): void { actors.set(actor, serializedId); }
export function recordSceneComponentProvenance(component: ActorComponent, serializedId: string): void { components.set(component, serializedId); }
export function sceneActorProvenance(actor: Actor): string | undefined { return actors.get(actor); }
export function sceneComponentProvenance(component: ActorComponent): string | undefined { return components.get(component); }
