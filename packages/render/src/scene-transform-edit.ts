import type { SerializedActor, SerializedScene } from "@babylonslate/core";

/** Pose changes retain asset references and rendering topology. Parent edits
 * and component properties still take the structural reconciliation path. */
export function isTransformOnlySceneEdit(previous: SerializedScene | null, next: SerializedScene): boolean {
  if (!previous) return false;
  if (previous === next) return false;
  const topology = (scene: SerializedScene) => ({
    ...scene,
    actors: scene.actors.map((actor) => ({
      ...actor, transform: undefined,
      components: actor.components.map((component) => ({ ...component, transform: undefined })),
    })),
  });
  if (JSON.stringify(topology(previous)) !== JSON.stringify(topology(next))) return false;
  const poses = (scene: SerializedScene) => scene.actors.map((actor) =>
    [actor.transform, actor.components.map((component) => component.transform)]);
  return JSON.stringify(poses(previous)) !== JSON.stringify(poses(next));
}

/**
 * True when two scenes differ at most in the properties of `classId`
 * components. Immutable scene edits keep untouched actors' identity, so only
 * replaced actors and the scene's own fields are serialized and compared.
 */
export function isComponentPropertyOnlySceneEdit(previous: SerializedScene | null, next: SerializedScene, classId: string): boolean {
  if (!previous || previous === next || previous.actors.length !== next.actors.length) return false;
  const otherState = (actor: SerializedActor) => JSON.stringify({
    ...actor,
    components: actor.components.map((component) => component.classId === classId ? { ...component, properties: {} } : component),
  });
  for (let index = 0; index < next.actors.length; index++) {
    const before = previous.actors[index]!;
    const after = next.actors[index]!;
    if (before !== after && otherState(before) !== otherState(after)) return false;
  }
  return JSON.stringify({ ...previous, actors: undefined }) === JSON.stringify({ ...next, actors: undefined });
}
