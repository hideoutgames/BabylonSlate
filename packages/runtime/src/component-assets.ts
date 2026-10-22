import type { Actor, ActorComponent } from "@haptic/object-model";

type AssetComponent = {
  assetGuid: string | null;
  getVariable(name: string): unknown;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The tree asset a BehaviourTreeComponent runs: its `treeGuid`, else the asset it was added from. */
export function behaviourTreeGuidOf(component: AssetComponent): string | null {
  return nonEmptyString(component.getVariable("treeGuid")) ?? component.assetGuid;
}

/** The graph asset an AnimationGraphComponent runs: its `graphGuid`, else the asset it was added from. */
export function animGraphGuidOf(component: AssetComponent): string | null {
  return nonEmptyString(component.getVariable("graphGuid")) ?? component.assetGuid;
}

/**
 * The one BehaviourTreeComponent whose tree an actor evaluates: its first live one. An actor's
 * other Behaviour Tree components never run.
 */
export function evaluatedBehaviourTreeComponent(actor: Actor): ActorComponent | undefined {
  return actor.components.find((component) => component.classId === "BehaviourTreeComponent" && !component.destroyed);
}
