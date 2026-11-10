import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";

const predicates = new WeakMap<Scene, (mesh: AbstractMesh) => boolean>();

/**
 * Tells a Scene which of its meshes belong to actors that never move (core's `reflectionProbeStaticActors`: the rule a
 * Reflection Probe captures by). The host knows actors, the renderer only meshes: the editor answers by its `editorActor:`
 * nodes, Play by its slots. Null forgets the answer.
 */
export function setSceneStaticMeshes(scene: Scene, predicate: ((mesh: AbstractMesh) => boolean) | null): void {
  if (predicate) predicates.set(scene, predicate);
  else predicates.delete(scene);
}

/** Whether `mesh` belongs to an actor that never moves; false while no host has told the Scene (every mesh may move). */
export function isSceneStaticMesh(scene: Scene, mesh: AbstractMesh): boolean {
  return predicates.get(scene)?.(mesh) ?? false;
}
