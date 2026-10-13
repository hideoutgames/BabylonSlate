import type { SerializedActor, SerializedComponent, SerializedScene } from "@babylonslate/core";

/** Pose changes retain asset references and rendering topology. Parent edits
 * and component properties still take the structural reconciliation path.
 * Immutable scene edits keep untouched actors' identity, so only replaced
 * actors are serialized; the scene's own fields are always compared in full. */
export function isTransformOnlySceneEdit(previous: SerializedScene | null, next: SerializedScene): boolean {
  if (!previous) return false;
  if (previous === next) return false;
  if (previous.actors.length !== next.actors.length) return false;
  const topology = (actor: SerializedActor) => JSON.stringify({
    ...actor, transform: undefined,
    components: actor.components.map((component) => ({ ...component, transform: undefined })),
  });
  const pose = (actor: SerializedActor) => JSON.stringify(
    [actor.transform, actor.components.map((component) => component.transform)]);
  let posed = false;
  for (let index = 0; index < next.actors.length; index++) {
    const before = previous.actors[index]!;
    const after = next.actors[index]!;
    if (before === after) continue;
    if (topology(before) !== topology(after)) return false;
    posed ||= pose(before) !== pose(after);
  }
  // The placeholder keeps the actors key in place.
  const otherState = (scene: SerializedScene) => JSON.stringify({ ...scene, actors: null });
  return posed && otherState(previous) === otherState(next);
}

/**
 * True when two scenes differ at most in the properties of `classId`
 * components. Immutable scene edits keep untouched actors' identity, so only
 * replaced actors and the scene's own fields are serialized and compared.
 */
export function isComponentPropertyOnlySceneEdit(previous: SerializedScene | null, next: SerializedScene, classId: string): boolean {
  return isComponentValueOnlySceneEdit(previous, next, new Map([[classId, null]]));
}

/**
 * True when two scenes differ at most in the named property values of the
 * listed component classes (`null` names every property of the class). The
 * actors, their components, transforms and every other property must match.
 */
export function isComponentValueOnlySceneEdit(
  previous: SerializedScene | null,
  next: SerializedScene,
  values: ReadonlyMap<string, readonly string[] | null>,
): boolean {
  if (!previous || previous === next || previous.actors.length !== next.actors.length) return false;
  const withoutValues = (component: SerializedComponent): SerializedComponent => {
    const names = values.get(component.classId);
    if (names === undefined) return component;
    if (names === null) return { ...component, properties: {} };
    const properties = { ...component.properties };
    for (const name of names) delete properties[name];
    return { ...component, properties };
  };
  const otherState = (actor: SerializedActor) => JSON.stringify({ ...actor, components: actor.components.map(withoutValues) });
  for (let index = 0; index < next.actors.length; index++) {
    const before = previous.actors[index]!;
    const after = next.actors[index]!;
    if (before !== after && otherState(before) !== otherState(after)) return false;
  }
  return JSON.stringify({ ...previous, actors: undefined }) === JSON.stringify({ ...next, actors: undefined });
}
