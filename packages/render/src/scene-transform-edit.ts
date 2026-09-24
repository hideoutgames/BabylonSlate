import type { SerializedScene } from "@babylonslate/core";

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
