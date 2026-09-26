import type { SerializedScene } from "@babylonslate/core";
import { sceneActorDisplayNames } from "./scene-actor-names";

/** Authorable body candidates; runtime diagnostics report missing or invalid collision. */
export function physicsConstraintTargets(scene: SerializedScene, ownerId: string) {
  const names = sceneActorDisplayNames(scene);
  return scene.actors.filter((actor) => actor.id !== ownerId && actor.components.some((component) =>
    component.classId === "RigidBodyComponent" ||
    component.classId === "BlockingVolumeComponent" ||
    component.classId === "TilemapComponent" ||
    (scene.settings.physicsWorld === "3d" && (
      (component.classId === "MeshComponent" && component.properties.collisionMode !== "none") ||
      (component.classId === "LandscapeComponent" && component.properties.collisionsEnabled === true) ||
      component.classId === "WaterBuoyancyComponent"
    )),
  )).map((actor) => ({
    id: actor.id,
    label: names.get(actor.id)!,
    description: actor.classId,
    group: "Physics Actors",
  }));
}
